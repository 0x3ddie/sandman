/**
 * The server-side half of the GitHub App.
 *
 * The same App that signs users in (see lib/auth.ts) is the one that holds
 * repository permissions. Authentication here is therefore App-level, not
 * user-level: we sign a short-lived RS256 assertion with the App's private key,
 * exchange it for an *installation access token*, and use that token for
 * repository reads. An installation token is scoped to the repositories the
 * customer actually granted and expires after an hour, which is exactly the
 * blast radius we want if one ever escapes.
 *
 * Two rules this module keeps:
 *
 * A token never appears in a URL. URLs land in access logs, `Referer` headers,
 * browser history and error reporters; `Authorization` headers do not. Requests
 * are refused outright if a caller tries to smuggle one into the query string.
 *
 * A token is never used inside its last 60 seconds. Minting is cheap; a request
 * that starts on a valid token and finishes on an expired one produces a 401
 * that looks like a permissions bug.
 *
 * JWT signing uses node:crypto directly. An RS256 assertion is a base64url
 * header, a base64url payload, and an RSA-SHA256 signature over the two — not
 * worth a dependency, and one fewer package with access to the App key.
 */

import { createSign } from "node:crypto"

const API_BASE = "https://api.github.com"
const API_VERSION = "2022-11-28"

/** GitHub rejects an assertion older than 10 minutes; 9 leaves clock slack. */
const JWT_TTL_SECONDS = 9 * 60
/** Backdated so a fast local clock does not produce an assertion "from the future". */
const JWT_BACKDATE_SECONDS = 60
/** Refresh this far ahead of hard expiry. */
const TOKEN_SKEW_MS = 60_000

/* ---------------------------------------------------------------------------
 * Errors
 * ------------------------------------------------------------------------ */

export class GitHubError extends Error {
  readonly status: number
  readonly path: string

  constructor(message: string, options: { status?: number; path: string }) {
    super(message)
    this.name = "GitHubError"
    this.status = options.status ?? 0
    this.path = options.path
  }

  /** The App is installed but has no access to what was asked for. */
  get isForbidden(): boolean {
    return this.status === 403 || this.status === 404
  }
}

export class GitHubNotConfiguredError extends Error {
  readonly missing: readonly string[]

  constructor(missing: readonly string[]) {
    super(
      `The GitHub App is not configured; missing: ${missing.join(", ")}. ` +
        "Set these from the App's settings page before connecting a repository.",
    )
    this.name = "GitHubNotConfiguredError"
    this.missing = missing
  }
}

/* ---------------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------------ */

/**
 * The App private key, accepting both storage forms operators actually use: a
 * genuine multi-line PEM (Docker secrets, files) and a single-line value with
 * escaped newlines (almost every hosted environment variable UI).
 */
function privateKeyPem(): string | null {
  const raw = process.env.GITHUB_APP_PRIVATE_KEY
  if (!raw) return null
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw
}

/** Environment variables that block GitHub access, by name and never by value. */
export function githubMissingEnv(): string[] {
  const missing: string[] = []
  if (!process.env.GITHUB_APP_ID) missing.push("GITHUB_APP_ID")
  if (!privateKeyPem()) missing.push("GITHUB_APP_PRIVATE_KEY")
  return missing
}

export function githubConfigured(): boolean {
  return githubMissingEnv().length === 0
}

/**
 * Where to send someone to install the App.
 *
 * The App slug is public (it is in the App's own URL), so it is safe in a link.
 * `state` round-trips the organisation id so the setup callback knows which
 * workspace the installation belongs to.
 */
export function appInstallUrl(state?: string): string {
  const slug = process.env.GITHUB_APP_SLUG ?? "sandman"
  const url = new URL(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`)
  if (state) url.searchParams.set("state", state)
  return url.toString()
}

/* ---------------------------------------------------------------------------
 * App JWT
 * ------------------------------------------------------------------------ */

function base64url(input: Buffer | string): string {
  return (typeof input === "string" ? Buffer.from(input, "utf8") : input).toString("base64url")
}

/**
 * A short-lived RS256 assertion identifying the App itself.
 *
 * Not cached: signing is sub-millisecond, and a cached assertion is one more
 * place a credential sits in memory for no benefit.
 */
export function appJwt(): string {
  const missing = githubMissingEnv()
  if (missing.length > 0) throw new GitHubNotConfiguredError(missing)

  const appId = process.env.GITHUB_APP_ID as string
  const pem = privateKeyPem() as string

  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const payload = base64url(
    JSON.stringify({
      iat: now - JWT_BACKDATE_SECONDS,
      exp: now + JWT_TTL_SECONDS,
      iss: appId,
    }),
  )
  const signingInput = `${header}.${payload}`

  try {
    const signer = createSign("RSA-SHA256")
    signer.update(signingInput)
    signer.end()
    return `${signingInput}.${base64url(signer.sign(pem))}`
  } catch {
    // Deliberately not the caught message: node's key parser quotes the malformed
    // PEM back at you, and that PEM is the App's private key.
    throw new GitHubNotConfiguredError(["GITHUB_APP_PRIVATE_KEY"])
  }
}

/* ---------------------------------------------------------------------------
 * Installation tokens
 * ------------------------------------------------------------------------ */

interface CachedToken {
  token: string
  /** Epoch ms of hard expiry, as reported by GitHub. */
  expiresAt: number
}

/**
 * Parked on globalThis so Next's dev-server module reloads do not orphan the
 * cache and re-mint a token on every edit — GitHub rate-limits App endpoints
 * separately and far more tightly than installation endpoints.
 */
const globalForTokens = globalThis as unknown as { __sandmanGithubTokens?: Map<number, CachedToken> }
const tokenCache: Map<number, CachedToken> = (globalForTokens.__sandmanGithubTokens ??= new Map())

/** In-flight mints, so a burst of parallel requests produces one token, not ten. */
const inflight = new Map<number, Promise<string>>()

export async function installationToken(installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId)
  if (cached && cached.expiresAt - TOKEN_SKEW_MS > Date.now()) return cached.token

  const pending = inflight.get(installationId)
  if (pending) return pending

  const mint = (async () => {
    const path = `/app/installations/${installationId}/access_tokens`
    const payload = await githubRequest<{ token?: unknown; expires_at?: unknown }>(path, {
      method: "POST",
      authorization: `Bearer ${appJwt()}`,
    })

    const token = payload.token
    const expiresAt = payload.expires_at
    if (typeof token !== "string" || !token || typeof expiresAt !== "string") {
      throw new GitHubError(`installation ${installationId} returned a malformed token response`, {
        path,
      })
    }

    const parsed = Date.parse(expiresAt)
    tokenCache.set(installationId, {
      token,
      // A response without a parseable expiry is treated as already stale
      // rather than trusted for an hour.
      expiresAt: Number.isNaN(parsed) ? Date.now() : parsed,
    })
    return token
  })().finally(() => {
    inflight.delete(installationId)
  })

  inflight.set(installationId, mint)
  return mint
}

/** Drops a cached token, e.g. after the App is uninstalled or suspended. */
export function forgetInstallationToken(installationId: number): void {
  tokenCache.delete(installationId)
}

/* ---------------------------------------------------------------------------
 * Transport
 * ------------------------------------------------------------------------ */

interface RequestOptions {
  method?: "GET" | "POST"
  authorization: string
  searchParams?: Record<string, string>
  timeoutMs?: number
}

/** Rejects any attempt to carry a credential in the query string. */
function assertNoCredentialInPath(path: string): void {
  if (/[?&](access_token|token|client_secret)=/i.test(path)) {
    throw new Error("refusing to send a credential in a URL; use the Authorization header")
  }
}

async function githubRequest<T>(path: string, options: RequestOptions): Promise<T> {
  assertNoCredentialInPath(path)

  const url = new URL(`${API_BASE}${path}`)
  for (const [key, value] of Object.entries(options.searchParams ?? {})) {
    url.searchParams.set(key, value)
  }

  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": API_VERSION,
      "user-agent": "sandman",
      authorization: options.authorization,
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    cache: "no-store",
  })

  if (!response.ok) {
    throw new GitHubError(await describeFailure(response, path), {
      status: response.status,
      path,
    })
  }

  return (await response.json()) as T
}

/** GitHub's `{message}` body, with rate-limit exhaustion called out by name. */
async function describeFailure(response: Response, path: string): Promise<string> {
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = response.headers.get("x-ratelimit-reset")
    const at = reset ? new Date(Number(reset) * 1000).toISOString() : "shortly"
    return `GitHub rate limit exhausted for ${path}; resets at ${at}`
  }
  try {
    const body: unknown = await response.json()
    const message =
      body && typeof body === "object" ? (body as { message?: unknown }).message : undefined
    if (typeof message === "string") return `GitHub returned ${response.status} for ${path}: ${message}`
  } catch {
    /* a non-JSON error body carries nothing worth surfacing */
  }
  return `GitHub returned ${response.status} for ${path}`
}

/* ---------------------------------------------------------------------------
 * Repositories and branches
 * ------------------------------------------------------------------------ */

export interface GitHubRepository {
  id: number
  /** `owner/name`. Rendered in mono everywhere it appears. */
  fullName: string
  name: string
  owner: string
  defaultBranch: string
  private: boolean
  htmlUrl: string
  cloneUrl: string
}

export interface GitHubBranch {
  name: string
  sha: string
  protected: boolean
}

export interface GitHubInstallationSummary {
  id: number
  accountLogin: string
  accountType: string
  repositorySelection: string
  suspended: boolean
}

interface RepositoryPayload {
  id: number
  name: string
  full_name: string
  private: boolean
  html_url: string
  clone_url: string
  default_branch: string
  owner: { login: string } | null
}

function toRepository(raw: RepositoryPayload): GitHubRepository {
  return {
    id: raw.id,
    fullName: raw.full_name,
    name: raw.name,
    owner: raw.owner?.login ?? raw.full_name.split("/")[0] ?? "",
    defaultBranch: raw.default_branch,
    private: raw.private,
    htmlUrl: raw.html_url,
    cloneUrl: raw.clone_url,
  }
}

/** Every installation of this App. App-JWT authenticated, not installation. */
export async function listAppInstallations(): Promise<GitHubInstallationSummary[]> {
  const payload = await githubRequest<
    Array<{
      id: number
      account: { login?: string; type?: string } | null
      repository_selection?: string
      suspended_at?: string | null
    }>
  >("/app/installations", {
    authorization: `Bearer ${appJwt()}`,
    searchParams: { per_page: "100" },
  })

  return payload.map((entry) => ({
    id: entry.id,
    accountLogin: entry.account?.login ?? "",
    accountType: entry.account?.type ?? "User",
    repositorySelection: entry.repository_selection ?? "selected",
    suspended: Boolean(entry.suspended_at),
  }))
}

/**
 * Repositories the customer granted this installation.
 *
 * Paginated by hand rather than by following `Link`: the installation endpoint
 * returns a wrapped object with `total_count`, so the page count is known up
 * front and the loop has a provable bound.
 */
export async function listInstallationRepositories(
  installationId: number,
): Promise<GitHubRepository[]> {
  const perPage = 100
  const token = await installationToken(installationId)
  const repositories: GitHubRepository[] = []

  for (let page = 1; ; page += 1) {
    const payload = await githubRequest<{
      total_count: number
      repositories: RepositoryPayload[]
    }>("/installation/repositories", {
      authorization: `Bearer ${token}`,
      searchParams: { per_page: String(perPage), page: String(page) },
    })

    repositories.push(...payload.repositories.map(toRepository))
    if (repositories.length >= payload.total_count || payload.repositories.length < perPage) break
  }

  // Stable ordering: a select whose options reshuffle between renders is a
  // select people mis-click.
  return repositories.sort((a, b) => a.fullName.localeCompare(b.fullName))
}

/**
 * A repository's branches.
 *
 * Capped at 500. The LKG branch and the hotfix prefix are both chosen from
 * this list, and a repository with thousands of branches needs a search box,
 * not a longer fetch.
 */
export async function listBranches(
  installationId: number,
  owner: string,
  repo: string,
): Promise<GitHubBranch[]> {
  const perPage = 100
  const maxPages = 5
  const token = await installationToken(installationId)
  const branches: GitHubBranch[] = []

  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await githubRequest<
      Array<{ name: string; commit: { sha: string }; protected?: boolean }>
    >(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`, {
      authorization: `Bearer ${token}`,
      searchParams: { per_page: String(perPage), page: String(page) },
    })

    for (const entry of payload) {
      branches.push({
        name: entry.name,
        sha: entry.commit.sha,
        protected: Boolean(entry.protected),
      })
    }
    if (payload.length < perPage) break
  }

  return branches
}

/** A single repository, for confirming a connection is still live. */
export async function getRepository(
  installationId: number,
  owner: string,
  repo: string,
): Promise<GitHubRepository> {
  const token = await installationToken(installationId)
  const payload = await githubRequest<RepositoryPayload>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    { authorization: `Bearer ${token}` },
  )
  return toRepository(payload)
}
