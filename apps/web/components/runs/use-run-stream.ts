"use client"

/**
 * The live run feed.
 *
 * A fan-out run is the highest-frequency thing this product does: several
 * hundred sandboxes moving through four states each, plus log lines, arriving
 * over one EventSource. Two decisions keep the main thread free.
 *
 * 1. Nothing is written to React state on arrival. Events land in a fixed ring
 *    buffer and are folded into a mutable model, which is published to React at
 *    roughly 10Hz from a requestAnimationFrame loop. Appending per message
 *    locks the thread at real rates.
 * 2. Sandbox state is never component state. The control plane already
 *    coalesces it into a full array every 250ms, so it is stored flat and keyed
 *    by unitId, and the canvas renderers index into that array directly.
 *
 * Wall-clock spans for the waterfall are derived here rather than shipped by
 * the control plane: rollups carry state, not transition times, so each state
 * change is stamped with the rollup's own timestamp the first time it is seen.
 */

import * as React from "react"

import type { BudgetSnapshot, HotfixSummary, VariantKey } from "@/lib/control-plane"
import { runStreamUrl } from "@/lib/control-plane"
import {
  isRunState,
  isSandboxStatus,
  isVariant,
  RUN_STATE_META,
  variantOrder,
  type RunState,
  type SandboxStatus,
  type Variant,
} from "@/lib/variants"

/* ---------------------------------------------------------------------------
 * Public shapes
 * ------------------------------------------------------------------------ */

export interface SandboxRow {
  unitId: string
  variant: Variant
  region: string | null
  index: number
  state: SandboxStatus
  probeId: string | null
  durationMs: number | null
  exitCode: number | null
  /** Epoch ms, stamped the first time the unit is observed in that state. */
  queuedAt: number | null
  provisioningAt: number | null
  startedAt: number | null
  endedAt: number | null
}

export type LogLevel = "error" | "warn" | "info"

export interface LogLine {
  /** Monotonic, and the virtualiser's key — array indices shift under trimming. */
  seq: number
  unitId: string
  stream: "stdout" | "stderr"
  level: LogLevel
  text: string
  ts: number
}

export interface FanoutSummary {
  total: number
  queued: number
  provisioning: number
  running: number
  passed: number
  failed: number
  flaky: number
  skipped: number
  error: number
  timedOut: number
}

export interface FindingRow {
  id: string
  probeId: string
  classification: string
  severity: string
  title: string
  previouslyIgnored: boolean
}

export interface HotfixRow extends HotfixSummary {
  reviewSummary: string | null
  reviewBlocking: number | null
}

export interface PhaseMark {
  state: RunState
  at: number
}

export interface RunTimeline {
  /** Epoch ms of the first event seen for this run. */
  startedAt: number | null
  endedAt: number | null
  phases: PhaseMark[]
}

export interface RunStreamError {
  reason: string
  detail: string
}

export interface RunStream {
  connected: boolean
  runState: RunState
  sandboxes: SandboxRow[]
  summary: FanoutSummary
  logs: LogLine[]
  /** Last three lines per unit, for the ≤24-unit card tier. */
  logTails: Record<string, string[]>
  findings: FindingRow[]
  hotfixes: HotfixRow[]
  budget: BudgetSnapshot | null
  revisions: Partial<Record<VariantKey, string>>
  verdictCounts: Record<string, number>
  /** p95 probe latency in ms, keyed by unitId, for the beeswarm tier. */
  latencyP95: Record<string, number>
  timeline: RunTimeline
  error: RunStreamError | null
  /** Bumped whenever a verdict, hotfix or promotion lands — server data is stale. */
  serverDataRevision: number
}

export interface UseRunStreamOptions {
  /** Server-fetched seed so the first paint is not empty. */
  initialState?: RunState
  initialRevisions?: Partial<Record<VariantKey, string>>
  initialHotfixes?: HotfixSummary[]
  initialBudget?: BudgetSnapshot | null
  initialCounts?: Record<string, number>
  /** Escape hatch for tests and stories. */
  enabled?: boolean
}

/* ---------------------------------------------------------------------------
 * Tunables
 * ------------------------------------------------------------------------ */

const RING_CAPACITY = 4096
const FLUSH_INTERVAL_MS = 100
const MAX_LOG_LINES = 20_000
const LOG_TRIM_SLACK = 2_048
const LOG_TAIL_LINES = 3
const MAX_LATENCY_SAMPLES = 64
const RECONNECT_BASE_MS = 600
const RECONNECT_MAX_MS = 30_000

const EVENT_TYPES = [
  "run.state",
  "run.progress",
  "sandbox.rollup",
  "sandbox.log",
  "probe.result",
  "verdict",
  "finding",
  "hotfix",
  "review",
  "promotion",
  "budget",
  "error",
  "heartbeat",
] as const

type EventName = (typeof EVENT_TYPES)[number]

/* ---------------------------------------------------------------------------
 * Payload readers — the wire is untyped, so nothing is cast
 * ------------------------------------------------------------------------ */

type Json = Record<string, unknown>

function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function asCountRecord(value: unknown): Record<string, number> {
  const record = asRecord(value)
  if (!record) return {}
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(record)) {
    const n = asNumber(raw)
    if (n !== null) out[key] = n
  }
  return out
}

function asRevisions(value: unknown): Partial<Record<VariantKey, string>> {
  const record = asRecord(value)
  if (!record) return {}
  const out: Partial<Record<VariantKey, string>> = {}
  for (const [key, raw] of Object.entries(record)) {
    const revision = asString(raw)
    if (revision && isVariant(key)) out[key] = revision
  }
  return out
}

/** Timestamps are seconds on the wire (`time.time()`), ms everywhere here. */
function eventTimestamp(data: Json): number {
  const ts = asNumber(data.ts)
  return ts === null ? Date.now() : ts * 1000
}

function classifyLogLevel(text: string, stream: string): LogLevel {
  if (/\b(error|fatal|panic|exception|traceback|assertionerror)\b/i.test(text)) return "error"
  if (/\bwarn(ing)?\b/i.test(text)) return "warn"
  return stream === "stderr" ? "warn" : "info"
}

function readBudget(data: Json): BudgetSnapshot | null {
  const usdSpent = asNumber(data.usd_spent)
  if (usdSpent === null) return null
  return {
    usd_spent: usdSpent,
    usd_cap: asNumber(data.usd_cap) ?? 0,
    utilisation: asNumber(data.utilisation) ?? 0,
    sandbox_seconds: asNumber(data.sandbox_seconds) ?? 0,
    sandboxes_created: asNumber(data.sandboxes_created) ?? 0,
    llm_input_tokens: asNumber(data.llm_input_tokens) ?? 0,
    llm_output_tokens: asNumber(data.llm_output_tokens) ?? 0,
    elapsed_seconds: asNumber(data.elapsed_seconds) ?? 0,
    aborted: asBoolean(data.aborted) ?? false,
    warnings: asStringArray(data.warnings),
  }
}

/** `hotfix` and `promotion` both carry `HotfixAttempt.as_dict()`. */
function readHotfix(data: Json, previous: HotfixRow | undefined): HotfixRow | null {
  const id = asString(data.id)
  if (!id) return null
  return {
    id,
    state: asString(data.state) ?? previous?.state ?? "authoring",
    probeId: asString(data.probeId) ?? previous?.probeId ?? "",
    classification: asString(data.classification) ?? previous?.classification ?? "",
    branch: asString(data.branch),
    commitSha: asString(data.commitSha),
    rootCause: asString(data.rootCause),
    fixSummary: asString(data.fixSummary),
    filesChanged: asStringArray(data.filesChanged),
    testsPassed: asBoolean(data.testsPassed),
    confidence: asNumber(data.confidence),
    rejectionReason: asString(data.rejectionReason),
    prNumber: asNumber(data.prNumber),
    prUrl: asString(data.prUrl),
    reviewApproved: asBoolean(data.reviewApproved),
    reviewScore: asNumber(data.reviewScore),
    mergedSha: asString(data.mergedSha),
    promoted: asBoolean(data.promoted) ?? false,
    reviewSummary: previous?.reviewSummary ?? null,
    reviewBlocking: previous?.reviewBlocking ?? null,
  }
}

function seedHotfix(summary: HotfixSummary): HotfixRow {
  return { ...summary, reviewSummary: null, reviewBlocking: null }
}

function emptySummary(): FanoutSummary {
  return {
    total: 0,
    queued: 0,
    provisioning: 0,
    running: 0,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    error: 0,
    timedOut: 0,
  }
}

function summaryFromCounts(counts: Record<string, number>, fallbackTotal: number): FanoutSummary {
  return {
    total: counts.total ?? fallbackTotal,
    queued: counts.queued ?? 0,
    provisioning: counts.provisioning ?? 0,
    running: counts.running ?? 0,
    passed: counts.passed ?? 0,
    failed: counts.failed ?? 0,
    flaky: counts.flaky ?? 0,
    skipped: counts.skipped ?? 0,
    error: counts.error ?? 0,
    timedOut: counts.timed_out ?? 0,
  }
}

/** Nearest-rank p95 over a bounded sample window. */
function percentile95(samples: number[]): number {
  if (samples.length === 0) return 0
  const sorted = samples.slice().sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)
  return sorted[Math.max(0, rank)] ?? 0
}

/* ---------------------------------------------------------------------------
 * Mutable model
 * ------------------------------------------------------------------------ */

interface RawEvent {
  name: EventName
  data: Json
}

const DIRTY_SANDBOXES = 1 << 0
const DIRTY_LOGS = 1 << 1
const DIRTY_FINDINGS = 1 << 2
const DIRTY_HOTFIXES = 1 << 3
const DIRTY_META = 1 << 4
const DIRTY_LATENCY = 1 << 5
const DIRTY_TAILS = 1 << 6

interface Model {
  runState: RunState
  units: Map<string, SandboxRow>
  summary: FanoutSummary
  logs: LogLine[]
  logSeq: number
  logTails: Map<string, string[]>
  findings: Map<string, FindingRow>
  hotfixes: Map<string, HotfixRow>
  budget: BudgetSnapshot | null
  revisions: Partial<Record<VariantKey, string>>
  verdictCounts: Record<string, number>
  latencySamples: Map<string, number[]>
  latencyDirty: Set<string>
  latencyP95: Record<string, number>
  timeline: RunTimeline
  error: RunStreamError | null
  serverDataRevision: number
  dirty: number
}

function createModel(options: UseRunStreamOptions): Model {
  const hotfixes = new Map<string, HotfixRow>()
  for (const hotfix of options.initialHotfixes ?? []) hotfixes.set(hotfix.id, seedHotfix(hotfix))
  return {
    runState: options.initialState ?? "queued",
    units: new Map(),
    summary: emptySummary(),
    logs: [],
    logSeq: 0,
    logTails: new Map(),
    findings: new Map(),
    hotfixes,
    budget: options.initialBudget ?? null,
    revisions: { ...(options.initialRevisions ?? {}) },
    verdictCounts: { ...(options.initialCounts ?? {}) },
    latencySamples: new Map(),
    latencyDirty: new Set(),
    latencyP95: {},
    timeline: { startedAt: null, endedAt: null, phases: [] },
    error: null,
    serverDataRevision: 0,
    dirty: 0,
  }
}

function publish(model: Model, connected: boolean, previous: RunStream | null): RunStream {
  const sandboxes =
    previous && !(model.dirty & DIRTY_SANDBOXES)
      ? previous.sandboxes
      : Array.from(model.units.values()).sort(compareSandboxes)

  const logs = previous && !(model.dirty & DIRTY_LOGS) ? previous.logs : model.logs.slice()

  const logTails =
    previous && !(model.dirty & DIRTY_TAILS)
      ? previous.logTails
      : Object.fromEntries(model.logTails)

  const findings =
    previous && !(model.dirty & DIRTY_FINDINGS)
      ? previous.findings
      : Array.from(model.findings.values())

  const hotfixes =
    previous && !(model.dirty & DIRTY_HOTFIXES)
      ? previous.hotfixes
      : Array.from(model.hotfixes.values())

  if (model.dirty & DIRTY_LATENCY) {
    const next = { ...model.latencyP95 }
    for (const unitId of model.latencyDirty) {
      next[unitId] = percentile95(model.latencySamples.get(unitId) ?? [])
    }
    model.latencyDirty.clear()
    model.latencyP95 = next
  }

  model.dirty = 0

  return {
    connected,
    runState: model.runState,
    sandboxes,
    summary: model.summary,
    logs,
    logTails,
    findings,
    hotfixes,
    budget: model.budget,
    revisions: model.revisions,
    verdictCounts: model.verdictCounts,
    latencyP95: model.latencyP95,
    timeline: model.timeline,
    error: model.error,
    serverDataRevision: model.serverDataRevision,
  }
}

/** B → I → H, then region, then unit index. The canvas depends on it being stable. */
function compareSandboxes(a: SandboxRow, b: SandboxRow): number {
  const byVariant = variantOrder(a.variant) - variantOrder(b.variant)
  if (byVariant !== 0) return byVariant
  const byRegion = (a.region ?? "").localeCompare(b.region ?? "")
  if (byRegion !== 0) return byRegion
  return a.index - b.index
}

/* ---------------------------------------------------------------------------
 * Event folding
 * ------------------------------------------------------------------------ */

function applyRollup(model: Model, data: Json, at: number): void {
  const rows = Array.isArray(data.sandboxes) ? data.sandboxes : []
  const next = new Map<string, SandboxRow>()

  for (const raw of rows) {
    const item = asRecord(raw)
    if (!item) continue
    const unitId = asString(item.unitId)
    const variant = asString(item.variant)
    const state = asString(item.state)
    if (!unitId || !variant || !state || !isVariant(variant) || !isSandboxStatus(state)) continue

    const previous = model.units.get(unitId)
    const row: SandboxRow = {
      unitId,
      variant,
      region: asString(item.region),
      index: asNumber(item.index) ?? 0,
      state,
      probeId: asString(item.probeId),
      durationMs: asNumber(item.durationMs),
      exitCode: asNumber(item.exitCode),
      queuedAt: previous?.queuedAt ?? null,
      provisioningAt: previous?.provisioningAt ?? null,
      startedAt: previous?.startedAt ?? null,
      endedAt: previous?.endedAt ?? null,
    }

    // Stamp each transition once. A replayed rollup carries states the browser
    // never watched happen, so "first observation" is the only honest clock.
    if (previous?.state !== state) {
      if (state === "queued" && row.queuedAt === null) row.queuedAt = at
      if (state === "provisioning" && row.provisioningAt === null) row.provisioningAt = at
      if (state === "running" && row.startedAt === null) row.startedAt = at
      if (STATUS_IS_TERMINAL.has(state) && row.endedAt === null) row.endedAt = at
    }
    next.set(unitId, row)
  }

  model.units = next
  model.summary = summaryFromCounts(asCountRecord(data.summary), next.size)
  model.dirty |= DIRTY_SANDBOXES
}

const STATUS_IS_TERMINAL = new Set<SandboxStatus>([
  "passed",
  "failed",
  "flaky",
  "skipped",
  "error",
  "timed_out",
])

function applyLog(model: Model, data: Json, at: number): void {
  const text = asString(data.line)
  if (text === null) return
  const unitId = asString(data.unitId) ?? "orchestrator"
  const stream = asString(data.stream) === "stderr" ? "stderr" : "stdout"

  model.logs.push({
    seq: model.logSeq++,
    unitId,
    stream,
    level: classifyLogLevel(text, stream),
    text,
    ts: at,
  })

  // Trimmed in batches: shifting a 20k array once per line is O(n) per line.
  if (model.logs.length > MAX_LOG_LINES + LOG_TRIM_SLACK) {
    model.logs = model.logs.slice(model.logs.length - MAX_LOG_LINES)
  }

  const tail = model.logTails.get(unitId)
  if (tail === undefined) {
    model.logTails.set(unitId, [text])
  } else {
    tail.push(text)
    if (tail.length > LOG_TAIL_LINES) tail.splice(0, tail.length - LOG_TAIL_LINES)
    model.logTails.set(unitId, tail.slice())
  }

  model.dirty |= DIRTY_LOGS | DIRTY_TAILS
}

function applyProbeResult(model: Model, data: Json): void {
  const variant = asString(data.variant)
  const unitIndex = asNumber(data.unitIndex)
  const latency = asNumber(data.latencyMs)
  if (variant === null || unitIndex === null || latency === null) return

  // Unit ids are `${variant}-${index}` on the control plane; probe results carry
  // the two halves separately.
  const unitId = `${variant}-${unitIndex}`
  const samples = model.latencySamples.get(unitId)
  if (samples === undefined) {
    model.latencySamples.set(unitId, [latency])
  } else {
    samples.push(latency)
    if (samples.length > MAX_LATENCY_SAMPLES) samples.splice(0, samples.length - MAX_LATENCY_SAMPLES)
  }
  model.latencyDirty.add(unitId)
  model.dirty |= DIRTY_LATENCY
}

function applyEvent(model: Model, event: RawEvent): void {
  const { name, data } = event
  const at = eventTimestamp(data)
  if (model.timeline.startedAt === null) model.timeline.startedAt = at

  switch (name) {
    case "run.state": {
      const state = asString(data.state)
      if (state !== null && isRunState(state)) {
        if (state !== model.runState) model.timeline.phases.push({ state, at })
        model.runState = state
        if (RUN_STATE_META[state].terminal) model.timeline.endedAt = at
      }
      if (data.revisions !== undefined) model.revisions = asRevisions(data.revisions)
      if (data.counts !== undefined) model.verdictCounts = asCountRecord(data.counts)
      const budget = asRecord(data.budget)
      if (budget) model.budget = readBudget(budget) ?? model.budget
      const error = asString(data.error)
      if (error) model.error = { reason: "run", detail: error }
      model.serverDataRevision += 1
      model.dirty |= DIRTY_META
      break
    }
    case "run.progress": {
      if (data.revisions !== undefined) model.revisions = asRevisions(data.revisions)
      model.dirty |= DIRTY_META
      break
    }
    case "sandbox.rollup":
      applyRollup(model, data, at)
      break
    case "sandbox.log":
      applyLog(model, data, at)
      break
    case "probe.result":
      applyProbeResult(model, data)
      break
    case "verdict": {
      model.verdictCounts = asCountRecord(data.counts)
      model.serverDataRevision += 1
      model.dirty |= DIRTY_META
      break
    }
    case "finding": {
      const id = asString(data.findingId)
      if (!id) break
      model.findings.set(id, {
        id,
        probeId: asString(data.probeId) ?? "",
        classification: asString(data.classification) ?? "",
        severity: asString(data.severity) ?? "info",
        title: asString(data.title) ?? "",
        previouslyIgnored: asBoolean(data.previouslyIgnored) ?? false,
      })
      model.dirty |= DIRTY_FINDINGS
      break
    }
    case "hotfix":
    case "promotion": {
      const id = asString(data.id)
      if (!id) break
      const row = readHotfix(data, model.hotfixes.get(id))
      if (row) model.hotfixes.set(id, row)
      model.serverDataRevision += 1
      model.dirty |= DIRTY_HOTFIXES
      break
    }
    case "review": {
      const id = asString(data.hotfixId)
      const existing = id ? model.hotfixes.get(id) : undefined
      if (!id || !existing) break
      model.hotfixes.set(id, {
        ...existing,
        reviewApproved: asBoolean(data.approved),
        reviewScore: asNumber(data.score),
        reviewSummary: asString(data.summary),
        reviewBlocking: asNumber(data.blocking),
      })
      model.serverDataRevision += 1
      model.dirty |= DIRTY_HOTFIXES
      break
    }
    case "budget": {
      const budget = readBudget(data)
      if (budget) model.budget = budget
      model.dirty |= DIRTY_META
      break
    }
    case "error": {
      model.error = {
        reason: asString(data.reason) ?? "error",
        detail: asString(data.detail) ?? "The control plane reported a failure.",
      }
      model.dirty |= DIRTY_META
      break
    }
    case "heartbeat":
      break
  }
}

/* ---------------------------------------------------------------------------
 * Hook
 * ------------------------------------------------------------------------ */

export function useRunStream(runId: string, options: UseRunStreamOptions = {}): RunStream {
  const {
    initialState,
    initialRevisions,
    initialHotfixes,
    initialBudget,
    initialCounts,
    enabled = true,
  } = options

  // Seeds are read once. Re-seeding from a server refetch mid-run would stomp
  // live state with data that is already older than the stream.
  const seedRef = React.useRef<UseRunStreamOptions>({
    initialState,
    initialRevisions,
    initialHotfixes,
    initialBudget,
    initialCounts,
  })

  const modelRef = React.useRef<Model | null>(null)
  if (modelRef.current === null) modelRef.current = createModel(seedRef.current)

  const [state, setState] = React.useState<RunStream>(() =>
    publish(modelRef.current as Model, false, null),
  )
  const stateRef = React.useRef(state)
  stateRef.current = state

  React.useEffect(() => {
    if (!enabled) return

    const model = modelRef.current as Model
    const ring: (RawEvent | null)[] = new Array<RawEvent | null>(RING_CAPACITY).fill(null)
    let head = 0
    let count = 0

    let connected = false
    let connectedPublished = false
    let source: EventSource | null = null
    let reconnectTimer: number | null = null
    let frame: number | null = null
    let attempt = 0
    let lastFlush = 0
    let disposed = false

    const push = (name: EventName, payload: string): void => {
      let parsed: unknown
      try {
        parsed = JSON.parse(payload)
      } catch {
        return
      }
      const data = asRecord(parsed)
      if (!data) return

      if (count === RING_CAPACITY) {
        // Overflow drops the oldest. Rollups are full-state snapshots, so the
        // next one resynchronises anything a dropped event would have carried.
        ring[head] = { name, data }
        head = (head + 1) % RING_CAPACITY
      } else {
        ring[(head + count) % RING_CAPACITY] = { name, data }
        count += 1
      }
    }

    const drain = (): void => {
      for (let i = 0; i < count; i += 1) {
        const event = ring[(head + i) % RING_CAPACITY]
        ring[(head + i) % RING_CAPACITY] = null
        if (event) applyEvent(model, event)
      }
      head = 0
      count = 0
    }

    const tick = (now: number): void => {
      frame = window.requestAnimationFrame(tick)
      if (now - lastFlush < FLUSH_INTERVAL_MS) return
      lastFlush = now
      if (count === 0 && connected === connectedPublished) return
      drain()
      connectedPublished = connected
      const next = publish(model, connected, stateRef.current)
      stateRef.current = next
      setState(next)
    }

    const close = (): void => {
      if (source) {
        source.close()
        source = null
      }
    }

    const scheduleReconnect = (): void => {
      if (disposed || reconnectTimer !== null) return
      // The bus closes its stream when a run finishes; reconnecting into a
      // retired run would 404 forever.
      if (RUN_STATE_META[model.runState].terminal) return
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt)
      attempt += 1
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        connect()
      }, delay + Math.random() * 250)
    }

    const connect = (): void => {
      if (disposed) return
      close()
      const next = new EventSource(runStreamUrl(runId))
      source = next

      next.onopen = () => {
        attempt = 0
        connected = true
      }
      next.onerror = () => {
        connected = false
        // EventSource retries on its own, but without a ceiling and without
        // giving up on a finished run. Own the lifecycle instead.
        close()
        scheduleReconnect()
      }
      for (const name of EVENT_TYPES) {
        next.addEventListener(name, (event: MessageEvent<string>) => {
          push(name, event.data)
        })
      }
    }

    connect()
    frame = window.requestAnimationFrame(tick)

    return () => {
      disposed = true
      close()
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [runId, enabled])

  return state
}
