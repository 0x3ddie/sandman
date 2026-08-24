/**
 * Secret settings.
 *
 * Write-only, structurally. A stored secret is never re-rendered: the row that
 * selects them names its columns explicitly so the ciphertext, iv and wrapped
 * data key are not even fetched, and the only fragment that reaches the browser
 * is the last four characters — and not even those for a secret short enough
 * that four characters would be a material fraction of it.
 *
 * The masked string and the relative timestamps are computed here rather than
 * in the client component. `maskSecret` lives in a node:crypto module, and a
 * relative time rendered from `Date.now()` on both sides of hydration produces a
 * mismatch every time.
 */

import { absoluteTime, formatRelativeTime, isoTime } from "@/lib/utils"
import { maskSecret, secretsConfigured } from "@/lib/crypto"

import { Callout, PageHeader } from "../_ui"
import { listSecrets, projectContext } from "../_data"
import { AddSecret, SecretList, SecretsDangerZone, type SecretRow } from "./_client"

export const dynamic = "force-dynamic"

export default async function SecretSettingsPage() {
  const { project } = await projectContext()
  const secrets = await listSecrets(project.id)
  const configured = secretsConfigured()

  const rows: SecretRow[] = secrets.map((secret) => ({
    id: secret.id,
    name: secret.name,
    // Short secrets get no tail at all — see lastFourOf in lib/crypto.
    masked: maskSecret(secret.lastFour),
    keyVersion: secret.keyVersion,
    lastUsedRelative: secret.lastUsedAt ? formatRelativeTime(secret.lastUsedAt) : null,
    lastUsedAbsolute: secret.lastUsedAt ? absoluteTime(secret.lastUsedAt) : null,
    lastUsedIso: secret.lastUsedAt ? isoTime(secret.lastUsedAt) ?? null : null,
    updatedRelative: formatRelativeTime(secret.updatedAt),
    updatedAbsolute: absoluteTime(secret.updatedAt),
  }))

  return (
    <div className="flex max-w-[880px] flex-col gap-5">
      <PageHeader
        title="Secrets"
        description="Credentials the target service needs to boot inside a sandbox. Each one is sealed under its own data key, which is itself sealed under a key held only in the environment — a database dump alone is useless."
      />

      {!configured ? (
        <Callout tone="caution" title="Secrets cannot be sealed on this deployment">
          <code className="mono text-[12px] text-[var(--fg-primary)]">SANDMAN_KEK</code> is not set.
          Generate one with{" "}
          <code className="mono text-[12px] text-[var(--fg-primary)]">openssl rand -base64 32</code>{" "}
          and restart. Existing secrets stay sealed and unreadable until it is restored.
        </Callout>
      ) : null}

      <AddSecret projectId={project.id} disabled={!configured} />
      <SecretList projectId={project.id} secrets={rows} disabled={!configured} />
      {rows.length > 0 ? <SecretsDangerZone projectId={project.id} secrets={rows} /> : null}
    </div>
  )
}
