/**
 * Envelope encryption for project secrets.
 *
 * Every secret gets its own random 32-byte data key. The secret is sealed under
 * that data key with AES-256-GCM; the data key is then sealed under a
 * key-encryption key held only in the environment. Two consequences follow, and
 * both are the point:
 *
 * * A database dump is useless on its own — the KEK never lands in Postgres.
 * * Rotating the KEK means re-wrapping N small data keys, not re-encrypting N
 *   ciphertexts of unbounded size.
 *
 * Nothing in this module logs, throws, or returns plaintext. Error messages
 * describe the *shape* of the failure only.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto"

const ALGORITHM = "aes-256-gcm"
const KEY_BYTES = 32
const IV_BYTES = 12 // 96-bit nonce: the size GCM is specified for.
const TAG_BYTES = 16

export interface EncryptedSecret {
  ciphertext: string
  iv: string
  authTag: string
  /** iv ‖ authTag ‖ sealed data key, base64. */
  wrappedKey: string
  keyVersion: number
  lastFour: string
}

/** The subset `decryptSecret` needs — matches a `project_secret` row. */
export type EncryptedSecretRecord = Pick<
  EncryptedSecret,
  "ciphertext" | "iv" | "authTag" | "wrappedKey" | "keyVersion"
>

/* ---------------------------------------------------------------------------
 * Key material
 * ------------------------------------------------------------------------ */

function decodeKek(value: string, variable: string): Buffer {
  const key = Buffer.from(value, "base64")
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${variable} must decode to exactly ${KEY_BYTES} bytes for AES-256, got ${key.length}. ` +
        `Generate one with: openssl rand -base64 32`,
    )
  }
  return key
}

function currentKeyVersion(): number {
  const raw = process.env.SANDMAN_KEK_VERSION
  if (!raw) return 1
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`SANDMAN_KEK_VERSION must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return parsed
}

function currentKek(): Buffer {
  const raw = process.env.SANDMAN_KEK
  if (!raw) {
    throw new Error(
      "SANDMAN_KEK is not set, so project secrets cannot be sealed or opened. " +
        "Generate one with: openssl rand -base64 32",
    )
  }
  return decodeKek(raw, "SANDMAN_KEK")
}

/**
 * The KEK that sealed a given version.
 *
 * Rotation is a two-step: set SANDMAN_KEK to the new key and move the old one to
 * SANDMAN_KEK_PREVIOUS, then re-wrap outstanding rows. Until the re-wrap
 * finishes, rows still carrying the previous version stay readable.
 */
function kekForVersion(version: number): Buffer {
  const current = currentKeyVersion()
  if (version === current) return currentKek()

  if (version === current - 1) {
    const previous = process.env.SANDMAN_KEK_PREVIOUS
    if (!previous) {
      throw new Error(
        `secret was sealed with key version ${version} but only version ${current} is loaded; ` +
          "set SANDMAN_KEK_PREVIOUS to the retired key to read it",
      )
    }
    return decodeKek(previous, "SANDMAN_KEK_PREVIOUS")
  }

  throw new Error(
    `secret was sealed with key version ${version}, which is no longer loaded ` +
      `(current version is ${current})`,
  )
}

/* ---------------------------------------------------------------------------
 * Data-key wrapping
 * ------------------------------------------------------------------------ */

function wrapDataKey(dataKey: Buffer, kek: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, kek, iv)
  const sealed = Buffer.concat([cipher.update(dataKey), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64")
}

function unwrapDataKey(wrappedKey: string, kek: Buffer): Buffer {
  const blob = Buffer.from(wrappedKey, "base64")
  if (blob.length !== IV_BYTES + TAG_BYTES + KEY_BYTES) {
    throw new Error(
      `wrapped key is ${blob.length} bytes; expected ${IV_BYTES + TAG_BYTES + KEY_BYTES}`,
    )
  }
  const iv = blob.subarray(0, IV_BYTES)
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const sealed = blob.subarray(IV_BYTES + TAG_BYTES)

  const decipher = createDecipheriv(ALGORITHM, kek, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(sealed), decipher.final()])
  } catch {
    // GCM authentication failed: wrong KEK, or the row was tampered with.
    throw new Error("data key failed authentication — wrong KEK or corrupted wrapped_key")
  }
}

/* ---------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------ */

/**
 * Seal a secret. The returned object maps one-to-one onto `project_secret`.
 */
export function encryptSecret(plaintext: string): EncryptedSecret {
  if (plaintext.length === 0) {
    throw new Error("refusing to store an empty secret")
  }

  const kek = currentKek()
  const dataKey = randomBytes(KEY_BYTES)
  const iv = randomBytes(IV_BYTES)

  const cipher = createCipheriv(ALGORITHM, dataKey, iv)
  const sealed = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()

  const record: EncryptedSecret = {
    ciphertext: sealed.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    wrappedKey: wrapDataKey(dataKey, kek),
    keyVersion: currentKeyVersion(),
    lastFour: lastFourOf(plaintext),
  }

  dataKey.fill(0)
  return record
}

/** Open a sealed secret. The plaintext is returned and never retained. */
export function decryptSecret(record: EncryptedSecretRecord): string {
  const kek = kekForVersion(record.keyVersion)
  const dataKey = unwrapDataKey(record.wrappedKey, kek)

  try {
    const iv = Buffer.from(record.iv, "base64")
    if (iv.length !== IV_BYTES) {
      throw new Error(`iv is ${iv.length} bytes; expected ${IV_BYTES}`)
    }
    const authTag = Buffer.from(record.authTag, "base64")
    if (authTag.length !== TAG_BYTES) {
      throw new Error(`auth tag is ${authTag.length} bytes; expected ${TAG_BYTES}`)
    }

    const decipher = createDecipheriv(ALGORITHM, dataKey, iv)
    decipher.setAuthTag(authTag)
    try {
      return Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8")
    } catch {
      throw new Error("secret failed authentication — ciphertext or auth tag has been altered")
    }
  } finally {
    dataKey.fill(0)
  }
}

/**
 * Re-seal an existing secret's data key under the current KEK.
 *
 * The ciphertext is untouched, which is what makes rotation cheap regardless of
 * how large the stored secrets are.
 */
export function rewrapSecret(
  record: EncryptedSecretRecord,
): Pick<EncryptedSecret, "wrappedKey" | "keyVersion"> {
  const dataKey = unwrapDataKey(record.wrappedKey, kekForVersion(record.keyVersion))
  try {
    return { wrappedKey: wrapDataKey(dataKey, currentKek()), keyVersion: currentKeyVersion() }
  } finally {
    dataKey.fill(0)
  }
}

/**
 * The only fragment of a secret that ever reaches a client.
 *
 * Short secrets get no tail at all: four characters out of eight is a material
 * fraction of the value, and no UI affordance is worth that.
 */
export function lastFourOf(plaintext: string): string {
  return plaintext.length >= 8 ? plaintext.slice(-4) : ""
}

/** Display form for a stored secret: "••••••••1234". */
export function maskSecret(lastFour: string): string {
  return `${"•".repeat(8)}${lastFour}`
}

/** Constant-time comparison, for verifying a webhook signature or a token. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** Whether the environment is configured to store secrets at all. */
export function secretsConfigured(): boolean {
  try {
    currentKek()
    return true
  } catch {
    return false
  }
}
