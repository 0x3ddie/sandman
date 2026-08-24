/**
 * Typed client for the Python control plane.
 *
 * The control plane is a long-lived local process, not a serverless function: a
 * fan-out investigation runs for minutes, so starting one returns a run id
 * immediately and progress arrives over Server-Sent Events. Everything here is
 * the request/response half of that contract; the stream half is a URL
 * ({@link runStreamUrl}) the browser opens through the Next rewrite.
 *
 * Types below mirror `services/control-plane/sandman/api.py` exactly, including
 * its mixed casing: the hand-built response dictionaries are camelCase, while
 * anything serialised straight from a Pydantic model keeps the model's
 * snake_case field names. Both are reproduced as-is rather than normalised,
 * because a client that silently renames fields is a client that drifts.
 */

/* ---------------------------------------------------------------------------
 * Project config — mirrors sandman.config.ProjectConfig
 * ------------------------------------------------------------------------ */

export type VariantKey = "baseline" | "initial" | "hotfix"

export interface ProbeSpec {
  id: string
  preset?: string | null
  module?: string | null
  enabled: boolean
  params: Record<string, unknown>
  fanout: number
  regions: string[]
  timeout_seconds: number
}

export interface VariantConfig {
  enabled: boolean
  image: string
  setup_commands: string[]
  startup_command: string[]
  env: Record<string, string>
  port: number
  health_path: string
  regions: string[]
  replicas: number
  cpu: number
  memory_mb: number
  timeout_seconds: number
}

export interface BudgetCaps {
  max_concurrent_sandboxes: number
  max_concurrent_llm: number
  max_usd_per_run: number
  max_wall_clock_seconds: number
  on_exceed: "warn" | "hard_stop"
}

export interface PromotionPolicy {
  require_greptile_approval: boolean
  require_reprobe: boolean
  block_on_regression: boolean
  block_on_new_findings: boolean
  auto_promote: boolean
  max_patch_lines: number
  protected_paths: string[]
}

export interface ProjectConfig {
  version: number
  repository_url: string
  lkg_branch: string
  hotfix_branch_prefix: string
  /** `REF@SHA`; null resolves the second-newest merge on the LKG branch. */
  previous_lkg: string | null
  variants: Record<VariantKey, VariantConfig>
  probes: ProbeSpec[]
  budget: BudgetCaps
  promotion: PromotionPolicy
  custom_probe_paths: string[]
}

/* ---------------------------------------------------------------------------
 * Response shapes
 * ------------------------------------------------------------------------ */

export interface HealthResponse {
  status: string
  service: string
}

export interface CapabilityStatus {
  name: string
  configured: boolean
  /** Environment variable names, never their values. */
  missing: string[]
}

export interface ReadinessResponse {
  ok: boolean
  version: string
  capabilities: CapabilityStatus[]
}

export interface PresetDescription {
  id: string
  description: string
}

export interface PresetsResponse {
  presets: PresetDescription[]
}

export interface ValidateConfigResponse {
  valid: boolean
  activeVariants: VariantKey[]
  probeCount: number
  totalFanout: number
  projectedWorstCaseUsd: number
  budgetUsd: number
  withinBudget: boolean
}

/** `StartRunResponse` is a Pydantic model, hence the snake_case. */
export interface StartRunResponse {
  run_id: string
  state: string
  /** Control-plane-relative. Use {@link runStreamUrl} for the browser path. */
  stream_url: string
}

export interface RunListEntry {
  runId: string
  state: string
  findings: number
  hotfixes: number
  usdSpent: number
}

export interface ListRunsResponse {
  runs: RunListEntry[]
}

/** `BudgetTracker.snapshot()`. */
export interface BudgetSnapshot {
  usd_spent: number
  usd_cap: number
  utilisation: number
  sandbox_seconds: number
  sandboxes_created: number
  llm_input_tokens: number
  llm_output_tokens: number
  elapsed_seconds: number
  aborted: boolean
  warnings: string[]
}

export interface HotfixSummary {
  id: string
  state: string
  probeId: string
  classification: string
  branch: string | null
  commitSha: string | null
  rootCause: string | null
  fixSummary: string | null
  filesChanged: string[]
  testsPassed: boolean | null
  confidence: number | null
  rejectionReason: string | null
  prNumber: number | null
  prUrl: string | null
  reviewApproved: boolean | null
  reviewScore: number | null
  mergedSha: string | null
  promoted: boolean
}

/** The hotfixes endpoint adds the patch itself and the chain that preceded it. */
export interface HotfixDetail extends HotfixSummary {
  diff: string
  priorFixes: string[]
}

export interface HotfixesResponse {
  hotfixes: HotfixDetail[]
}

/** `RunOutcome.summary()`. Counts are keyed by classification. */
export interface RunSummary {
  runId: string
  state: string
  /** Keyed by variant, each value a `REF@SHA` string. */
  revisions: Partial<Record<VariantKey, string>>
  counts: Record<string, number>
  findings: number
  blocking: number
  preExisting: number
  hotfixes: HotfixSummary[]
  safeToPromote: boolean
  budget: BudgetSnapshot | Record<string, never>
  error: string | null
}

/** `BehavioralSignature.model_dump()` — snake_case, straight off the model. */
export interface BehavioralSignature {
  status_code: number | null
  body_hash: string | null
  error_class: string | null
  exit_code: number | null
  latency_bucket: string | null
  stderr_fingerprint: string | null
}

export interface ProbeVerdictDto {
  probeId: string
  classification: string
  severity: number
  baselinePassed: boolean
  initialPassed: boolean
  /** null when no hotfix lane ran. */
  hotfixPassed: boolean | null
  /** Signatures differ across variants even though pass/fail agrees. */
  behaviourChanged: boolean
  flakeSuspected: boolean
  sampleSize: Partial<Record<VariantKey, number>>
  signatures: Partial<Record<VariantKey, BehavioralSignature>>
  detail: string | null
}

export interface FindingDto {
  id: string
  probeId: string
  classification: string
  severity: string
  title: string
  description: string
  reproduction: string | null
  /** True when memory recall shows earlier runs already surfaced this. */
  previouslyIgnored: boolean
  evidence: Partial<Record<VariantKey, string>>
}

export interface VerdictsResponse {
  counts: Record<string, number>
  /** Absent before a verdict exists — the endpoint returns empty lists then. */
  safeToPromote?: boolean
  verdicts: ProbeVerdictDto[]
  findings: FindingDto[]
}

export interface AbortRunResponse {
  runId: string
  state: string
}

export interface MemoryStatusResponse {
  enabled: boolean
  available: boolean
  version: string | null
  baseUrl: string
}

/* ---------------------------------------------------------------------------
 * Transport
 * ------------------------------------------------------------------------ */

const DEFAULT_BASE_URL = "http://127.0.0.1:8000"

/** Timeouts in ms. Every call has one; none of these endpoints does real work. */
const TIMEOUT_FAST = 4_000 // health, readiness, memory
const TIMEOUT_NORMAL = 10_000 // reads
const TIMEOUT_SLOW = 30_000 // validate (prices a run), start (spawns a task)

export type ControlPlaneErrorKind = "http" | "network" | "timeout" | "malformed"

export class ControlPlaneError extends Error {
  readonly kind: ControlPlaneErrorKind
  /** HTTP status, or 0 when no response was ever received. */
  readonly status: number
  readonly path: string
  readonly detail: string | null

  constructor(args: {
    kind: ControlPlaneErrorKind
    status: number
    path: string
    detail?: string | null
    message: string
  }) {
    super(args.message)
    this.name = "ControlPlaneError"
    this.kind = args.kind
    this.status = args.status
    this.path = args.path
    this.detail = args.detail ?? null
  }

  /** 404 on a run id is routine — a run the control plane no longer holds. */
  get isNotFound(): boolean {
    return this.status === 404
  }

  /** The control plane is not running, which is a setup problem, not a bug. */
  get isUnreachable(): boolean {
    return this.kind === "network" || this.kind === "timeout"
  }
}

/**
 * Server-side base URL. Read lazily: this module is importable from a client
 * component for {@link runStreamUrl}, and a top-level `process.env` read would
 * be inlined as `undefined` into the browser bundle.
 */
function baseUrl(): string {
  return (process.env.SANDMAN_CONTROL_PLANE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
}

interface RequestOptions {
  method?: "GET" | "POST"
  body?: unknown
  timeoutMs?: number
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, timeoutMs = TIMEOUT_NORMAL } = options

  const headers: Record<string, string> = { accept: "application/json" }
  if (body !== undefined) headers["content-type"] = "application/json"

  let response: Response
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      // Run state changes second to second; a cached read would render a stale
      // fan-out grid that never corrects itself.
      cache: "no-store",
    })
  } catch (cause) {
    const timedOut = cause instanceof DOMException && cause.name === "TimeoutError"
    throw new ControlPlaneError({
      kind: timedOut ? "timeout" : "network",
      status: 0,
      path,
      message: timedOut
        ? `control plane did not respond to ${method} ${path} within ${timeoutMs}ms`
        : `could not reach the control plane at ${baseUrl()} — is it running?`,
    })
  }

  if (!response.ok) {
    throw new ControlPlaneError({
      kind: "http",
      status: response.status,
      path,
      detail: await readErrorDetail(response),
      message: `control plane returned ${response.status} for ${method} ${path}`,
    })
  }

  // 202 responses still carry a body here; a genuinely empty one is a contract
  // break worth naming rather than surfacing as `undefined` three layers up.
  try {
    return (await response.json()) as T
  } catch {
    throw new ControlPlaneError({
      kind: "malformed",
      status: response.status,
      path,
      message: `control plane returned a non-JSON body for ${method} ${path}`,
    })
  }
}

/** FastAPI reports `{detail}`, and the ValueError handler `{error, detail}`. */
async function readErrorDetail(response: Response): Promise<string | null> {
  try {
    const payload: unknown = await response.json()
    if (payload && typeof payload === "object") {
      const detail = (payload as { detail?: unknown }).detail
      if (typeof detail === "string") return detail
      if (detail !== undefined) return JSON.stringify(detail)
      const error = (payload as { error?: unknown }).error
      if (typeof error === "string") return error
    }
    return null
  } catch {
    return null
  }
}

/* ---------------------------------------------------------------------------
 * Endpoints
 * ------------------------------------------------------------------------ */

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/api/health", { timeoutMs: TIMEOUT_FAST })
}

export function getReadiness(): Promise<ReadinessResponse> {
  return request<ReadinessResponse>("/api/readiness", { timeoutMs: TIMEOUT_FAST })
}

export function getPresets(): Promise<PresetsResponse> {
  return request<PresetsResponse>("/api/presets")
}

export function validateConfig(cfg: ProjectConfig): Promise<ValidateConfigResponse> {
  return request<ValidateConfigResponse>("/api/config/validate", {
    method: "POST",
    body: cfg,
    timeoutMs: TIMEOUT_SLOW,
  })
}

/** Queues an investigation. Returns as soon as the background task is spawned. */
export function startRun(cfg: ProjectConfig, runId?: string): Promise<StartRunResponse> {
  return request<StartRunResponse>("/api/runs", {
    method: "POST",
    body: { config: cfg, run_id: runId ?? null },
    timeoutMs: TIMEOUT_SLOW,
  })
}

export function listRuns(): Promise<ListRunsResponse> {
  return request<ListRunsResponse>("/api/runs")
}

export function getRun(id: string): Promise<RunSummary> {
  return request<RunSummary>(`/api/runs/${encodeURIComponent(id)}`)
}

/** The per-probe three-way comparison — the run page's hero data. */
export function getVerdicts(id: string): Promise<VerdictsResponse> {
  return request<VerdictsResponse>(`/api/runs/${encodeURIComponent(id)}/verdicts`)
}

export function getHotfixes(id: string): Promise<HotfixesResponse> {
  return request<HotfixesResponse>(`/api/runs/${encodeURIComponent(id)}/hotfixes`)
}

export function abortRun(id: string): Promise<AbortRunResponse> {
  return request<AbortRunResponse>(`/api/runs/${encodeURIComponent(id)}/abort`, {
    method: "POST",
  })
}

export function getMemoryStatus(): Promise<MemoryStatusResponse> {
  return request<MemoryStatusResponse>("/api/memory/status", { timeoutMs: TIMEOUT_FAST })
}

/**
 * The browser-facing SSE path.
 *
 * Deliberately same-origin and relative: `next.config.ts` rewrites `/cp/*` to
 * the control plane, which keeps EventSource off a cross-origin request and out
 * of CORS entirely.
 */
export function runStreamUrl(id: string): string {
  return `/cp/api/runs/${encodeURIComponent(id)}/stream`
}
