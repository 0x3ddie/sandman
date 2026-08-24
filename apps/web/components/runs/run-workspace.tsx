"use client"

/**
 * The live half of the run page.
 *
 * The server renders this component's first paint with everything it already
 * knows, then one EventSource takes over. It is the only client boundary on the
 * page: a single stream feeds the header, all four panes, and the cross-pane
 * wiring (clicking a sandbox anywhere opens its log; the waterfall playhead
 * scrolls the log viewer), which is exactly the coupling that would need
 * context or prop-drilling if the panes each owned their own connection.
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Prohibit, SealCheck } from "phosphor-react"
import * as Tooltip from "@radix-ui/react-tooltip"

import { cn, formatDuration, formatUsd, revisionRef, shortSha } from "@/lib/utils"
import type {
  BudgetSnapshot,
  FindingDto,
  HotfixSummary,
  ProbeVerdictDto,
  VariantKey,
} from "@/lib/control-plane"
import { RUN_STATE_META, VARIANT_META, VARIANT_ORDER, type RunState } from "@/lib/variants"
import { Segmented } from "@/components/ui/segmented"
import { Button } from "@/components/ui/button"
import { FanoutGrid } from "./fanout-grid"
import { LogViewer } from "./log-viewer"
import { VerdictStrip } from "./verdict-strip"
import { Waterfall } from "./waterfall"
import type { PromotionBlocker } from "./hotfix-panel"
import { useRunStream } from "./use-run-stream"

type Pane = "fanout" | "diff" | "timeline" | "logs"

const PANE_OPTIONS = [
  { value: "fanout" as const, label: "Fan-out" },
  { value: "diff" as const, label: "Diff" },
  { value: "timeline" as const, label: "Timeline" },
  { value: "logs" as const, label: "Logs" },
]

/* ---------------------------------------------------------------------------
 * Header pieces
 * ------------------------------------------------------------------------ */

function RunStatePill({ state, connected }: { state: RunState; connected: boolean }) {
  const meta = RUN_STATE_META[state]
  const live = !meta.terminal
  return (
    <span
      className="inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-[6px] border pl-1.5 pr-2"
      style={{
        color: meta.color,
        backgroundColor: `color-mix(in srgb, ${meta.color} 10%, transparent)`,
        borderColor: `color-mix(in srgb, ${meta.color} 28%, transparent)`,
      }}
      title={live && !connected ? "Reconnecting to the control plane" : undefined}
    >
      <span
        aria-hidden
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full bg-current",
          live && connected && "pulse-dot",
        )}
        style={live && !connected ? { opacity: 0.35 } : undefined}
      />
      <span className="mono -mr-[2px] text-[11px] font-medium uppercase leading-none tracking-[0.14em]">
        {meta.label}
      </span>
    </span>
  )
}

function RevisionRow({ variant, revision }: { variant: VariantKey; revision: string | undefined }) {
  const meta = VARIANT_META[variant]
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className="mono grid h-5 w-5 shrink-0 place-items-center rounded-[4px] border text-[11px] font-medium leading-none"
        style={{ color: meta.color, backgroundColor: meta.wash, borderColor: meta.border }}
      >
        {meta.glyph}
      </span>
      <span className="w-[58px] shrink-0 text-[12.5px] font-medium text-[var(--fg-secondary)]">
        {meta.label}
      </span>
      {revision ? (
        <span className="mono min-w-0 truncate text-[12.5px] text-[var(--fg-tertiary)]">
          <span className="text-[var(--fg-secondary)]">{revisionRef(revision)}</span>
          <span className="text-[var(--fg-quaternary)]">@</span>
          {shortSha(revision)}
        </span>
      ) : (
        <span className="mono text-[12.5px] text-[var(--fg-quaternary)]">not resolved</span>
      )}
    </div>
  )
}

function Metric({
  label,
  value,
  detail,
  meter,
  tone,
}: {
  label: string
  value: string
  detail?: string
  meter?: number
  tone?: string
}) {
  return (
    <div className="min-w-[132px]">
      <p className="text-eyebrow text-[var(--fg-tertiary)]">{label}</p>
      <p
        className="mono mt-1 text-[19px] leading-none tracking-[-0.01em]"
        style={{ color: tone ?? "var(--fg-primary)" }}
        data-numeric
      >
        {value}
      </p>
      {detail ? (
        <p className="mono mt-1 text-[11.5px] text-[var(--fg-quaternary)]" data-numeric>
          {detail}
        </p>
      ) : null}
      {meter !== undefined ? (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-[2px] bg-[var(--bg-raised)]">
          <div
            className="h-full rounded-[2px]"
            style={{
              width: `${Math.min(100, Math.max(0, meter * 100))}%`,
              backgroundColor: tone ?? "var(--accent-400)",
            }}
          />
        </div>
      ) : null}
    </div>
  )
}

/* ---------------------------------------------------------------------------
 * Workspace
 * ------------------------------------------------------------------------ */

export interface RunWorkspaceProps {
  runId: string
  initialState: RunState
  initialRevisions: Partial<Record<VariantKey, string>>
  initialHotfixes: HotfixSummary[]
  initialBudget: BudgetSnapshot | null
  initialCounts: Record<string, number>
  verdicts: ProbeVerdictDto[]
  findings: FindingDto[]
  blockers: PromotionBlocker[]
  safeToPromote: boolean
  /** The hotfix panel is a Server Component, so it arrives as a slot. */
  hotfixSlot: React.ReactNode
}

export function RunWorkspace({
  runId,
  initialState,
  initialRevisions,
  initialHotfixes,
  initialBudget,
  initialCounts,
  verdicts,
  findings,
  blockers,
  safeToPromote,
  hotfixSlot,
}: RunWorkspaceProps) {
  const router = useRouter()
  const stream = useRunStream(runId, {
    initialState,
    initialRevisions,
    initialHotfixes,
    initialBudget,
    initialCounts,
  })

  const [pane, setPane] = React.useState<Pane>("fanout")
  const [selectedUnitId, setSelectedUnitId] = React.useState<string | null>(null)
  const [playheadMs, setPlayheadMs] = React.useState<number | null>(null)
  const [aborting, setAborting] = React.useState(false)
  const [promoting, setPromoting] = React.useState(false)

  const terminal = RUN_STATE_META[stream.runState].terminal

  // One clock for the whole page: open-ended waterfall bars and the elapsed
  // metric both need "now", and two intervals would tick out of step.
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (terminal) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [terminal])

  // Verdicts, findings and hotfix diffs are server-fetched; the stream only says
  // that they changed. Refetch on that signal rather than duplicating the API.
  const revision = stream.serverDataRevision
  React.useEffect(() => {
    if (revision === 0) return
    const timer = window.setTimeout(() => router.refresh(), 1200)
    return () => window.clearTimeout(timer)
  }, [revision, router])

  const openUnitLog = React.useCallback((unitId: string) => {
    setSelectedUnitId(unitId)
    setPane("logs")
  }, [])

  const abort = async () => {
    setAborting(true)
    try {
      const response = await fetch(`/cp/api/runs/${encodeURIComponent(runId)}/abort`, {
        method: "POST",
      })
      if (!response.ok) throw new Error(`control plane returned ${response.status}`)
      toast("Abort requested", { description: "Sandboxes are being torn down." })
    } catch (cause) {
      toast.error("Could not abort the run", {
        description: cause instanceof Error ? cause.message : "The control plane did not respond.",
      })
    } finally {
      setAborting(false)
    }
  }

  const promote = async () => {
    setPromoting(true)
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/promote`, {
        method: "POST",
      })
      if (!response.ok) throw new Error(`promotion returned ${response.status}`)
      toast.success("Promoted to LKG")
      router.refresh()
    } catch (cause) {
      toast.error("Could not promote this run", {
        description: cause instanceof Error ? cause.message : "The promotion request failed.",
      })
    } finally {
      setPromoting(false)
    }
  }

  const elapsedMs =
    stream.budget && stream.budget.elapsed_seconds > 0
      ? stream.budget.elapsed_seconds * 1000
      : stream.timeline.startedAt === null
        ? 0
        : (stream.timeline.endedAt ?? now) - stream.timeline.startedAt

  const spent = stream.budget?.usd_spent ?? 0
  const cap = stream.budget?.usd_cap ?? 0
  const utilisation = cap > 0 ? spent / cap : 0
  const overBudget = utilisation >= 1

  const promotionBlocked = blockers.length > 0 || !safeToPromote
  const blockReason =
    blockers[0]?.condition ??
    (safeToPromote ? "" : "The three-way verification has not come back clean.")

  return (
    <Tooltip.Provider delayDuration={120}>
      <div className="flex flex-col gap-4">
        <header className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[var(--elev-1)]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--border-hairline)] px-4 py-3">
            <h2 className="mono text-[15px] text-[var(--fg-primary)]">{runId}</h2>
            <RunStatePill state={stream.runState} connected={stream.connected} />
            {!terminal && !stream.connected ? (
              <span className="text-caption text-[var(--fg-tertiary)]">reconnecting…</span>
            ) : null}
            {stream.error ? (
              <span className="text-caption truncate text-[var(--status-fail)]">
                {stream.error.detail}
              </span>
            ) : null}

            <div className="ml-auto flex items-center gap-2">
              {!terminal ? (
                <Button variant="danger" size="md" onClick={abort} disabled={aborting}>
                  <Prohibit size={16} weight="regular" color="currentColor" aria-hidden />
                  {aborting ? "Aborting…" : "Abort"}
                </Button>
              ) : null}

              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  {/* A disabled button swallows pointer events, so the tooltip
                      needs a wrapper to hang off. */}
                  <span className="inline-flex">
                    <Button
                      variant="primary"
                      size="md"
                      onClick={promote}
                      disabled={promotionBlocked || promoting}
                    >
                      <SealCheck size={16} weight="regular" color="currentColor" aria-hidden />
                      {promoting ? "Promoting…" : "Promote to LKG"}
                    </Button>
                  </span>
                </Tooltip.Trigger>
                {promotionBlocked ? (
                  <Tooltip.Portal>
                    <Tooltip.Content
                      side="bottom"
                      align="end"
                      sideOffset={6}
                      className="z-50 max-w-[320px] rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-overlay)] px-3 py-2 shadow-[var(--elev-2)]"
                    >
                      <p className="text-caption text-[var(--fg-primary)]">{blockReason}</p>
                      {blockers[0]?.detail ? (
                        <p className="text-caption mt-1 text-[var(--fg-tertiary)]">
                          {blockers[0].detail}
                        </p>
                      ) : null}
                      {blockers.length > 1 ? (
                        <p className="text-caption mt-1 text-[var(--fg-quaternary)]">
                          {blockers.length - 1} further condition
                          {blockers.length - 1 === 1 ? "" : "s"} unmet — see the promotion gate under
                          Diff.
                        </p>
                      ) : null}
                    </Tooltip.Content>
                  </Tooltip.Portal>
                ) : null}
              </Tooltip.Root>
            </div>
          </div>

          <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4 px-4 py-3">
            <div className="flex min-w-0 flex-col gap-1.5">
              {VARIANT_ORDER.map((variant) => (
                <RevisionRow
                  key={variant}
                  variant={variant}
                  revision={stream.revisions[variant]}
                />
              ))}
            </div>

            <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
              <Metric label="Elapsed" value={formatDuration(elapsedMs)} />
              <Metric
                label="Spend"
                value={formatUsd(spent)}
                detail={cap > 0 ? `cap ${formatUsd(cap)}` : "no cap set"}
                meter={cap > 0 ? utilisation : undefined}
                tone={overBudget ? "var(--status-fail)" : undefined}
              />
              <Metric
                label="Sandboxes"
                value={String(stream.summary.total)}
                detail={`${stream.summary.passed} passed · ${stream.summary.failed} failed`}
              />
            </div>
          </div>
        </header>

        <Segmented
          aria-label="Run view"
          value={pane}
          onValueChange={setPane}
          options={PANE_OPTIONS}
          className="self-start"
        />

        {pane === "fanout" ? (
          <FanoutGrid
            sandboxes={stream.sandboxes}
            summary={stream.summary}
            logTails={stream.logTails}
            latencyP95={stream.latencyP95}
            selectedUnitId={selectedUnitId}
            onSelectUnit={openUnitLog}
          />
        ) : null}

        {pane === "diff" ? (
          <div className="flex flex-col gap-4">
            <VerdictStrip verdicts={verdicts} findings={findings} counts={stream.verdictCounts} />
            {hotfixSlot}
          </div>
        ) : null}

        {pane === "timeline" ? (
          <Waterfall
            sandboxes={stream.sandboxes}
            timeline={stream.timeline}
            runState={stream.runState}
            now={now}
            playheadMs={playheadMs}
            onPlayheadChange={setPlayheadMs}
            selectedUnitId={selectedUnitId}
            onSelectUnit={openUnitLog}
          />
        ) : null}

        {pane === "logs" ? (
          <LogViewer
            lines={stream.logs}
            unitFilter={selectedUnitId}
            onUnitFilterChange={setSelectedUnitId}
            seekTo={playheadMs}
            onSeek={setPlayheadMs}
            running={!terminal}
          />
        ) : null}
      </div>
    </Tooltip.Provider>
  )
}
