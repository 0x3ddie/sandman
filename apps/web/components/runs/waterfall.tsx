"use client"

/**
 * The run timeline.
 *
 * Wall clock on x, one 28px row per span. The orchestrator's own phases sit on
 * row 0, then the three variant lanes in fixed B → I → H order, each expandable
 * into its sandboxes.
 *
 * PROVISIONING is drawn as a distinct hatched state rather than being folded
 * into RUNNING. Modal cold starts take several seconds, and a timeline that
 * shows nothing at all for the first few seconds of every run reads as hung —
 * which is precisely the moment an operator is most likely to hit abort.
 *
 * Rows are virtualised because a lane can hold several hundred sandboxes, and
 * the playhead is shared with the log viewer so scrubbing here scrolls there.
 */

import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { CaretDown, CaretRight } from "phosphor-react"

import { cn, formatDuration } from "@/lib/utils"
import {
  RUN_STATE_META,
  STATUS_META,
  VARIANT_META,
  VARIANT_ORDER,
  type RunState,
  type Variant,
} from "@/lib/variants"
import type { RunTimeline, SandboxRow } from "./use-run-stream"

const ROW_HEIGHT = 28
const LABEL_WIDTH = 216
const MIN_SPAN_MS = 1_000
/** Below this a bar disappears entirely; a 3px stub still shows the phase ran. */
const MIN_BAR_PERCENT = 0.4

type Row =
  | { kind: "orchestrator"; key: string }
  | { kind: "lane"; key: string; variant: Variant; units: SandboxRow[] }
  | { kind: "unit"; key: string; variant: Variant; unit: SandboxRow }

interface Domain {
  start: number
  end: number
}

interface Segment {
  from: number
  to: number
  phase: "queued" | "provisioning" | "running"
}

/** Every stamp the hook observed for a unit, in order, with open ends closed off. */
function segmentsFor(unit: SandboxRow, domain: Domain): Segment[] {
  const fallbackEnd = unit.endedAt ?? domain.end
  const runFrom = unit.startedAt
  const provisionFrom = unit.provisioningAt
  const queueFrom = unit.queuedAt

  const segments: Segment[] = []
  if (queueFrom !== null) {
    const to = provisionFrom ?? runFrom ?? fallbackEnd
    if (to > queueFrom) segments.push({ from: queueFrom, to, phase: "queued" })
  }
  if (provisionFrom !== null) {
    const to = runFrom ?? fallbackEnd
    if (to > provisionFrom) segments.push({ from: provisionFrom, to, phase: "provisioning" })
  }
  if (runFrom !== null) {
    const to = unit.endedAt ?? domain.end
    if (to > runFrom) segments.push({ from: runFrom, to, phase: "running" })
  }
  return segments
}

function unitStart(unit: SandboxRow): number | null {
  return unit.queuedAt ?? unit.provisioningAt ?? unit.startedAt
}

function percent(value: number, domain: Domain): number {
  const span = Math.max(MIN_SPAN_MS, domain.end - domain.start)
  return ((value - domain.start) / span) * 100
}

function phaseStyle(phase: Segment["phase"], color: string): React.CSSProperties {
  if (phase === "running") return { backgroundColor: color }
  if (phase === "provisioning") {
    return {
      // 35% hatch: legible as "not yet doing work" without reading as failure.
      backgroundImage: `repeating-linear-gradient(135deg, ${color} 0 2px, transparent 2px 5px)`,
      opacity: 0.35,
      borderRadius: 2,
    }
  }
  return { border: `1px solid ${color}`, opacity: 0.55, borderRadius: 2 }
}

/* ---------------------------------------------------------------------------
 * Bars
 * ------------------------------------------------------------------------ */

interface BarProps {
  segments: Segment[]
  domain: Domain
  color: string
  failed: boolean
  height: number
}

function Bar({ segments, domain, color, failed, height }: BarProps) {
  return (
    <>
      {segments.map((segment, index) => {
        const left = percent(segment.from, domain)
        const width = Math.max(MIN_BAR_PERCENT, percent(segment.to, domain) - left)
        return (
          <span
            key={`${segment.phase}-${index}`}
            className="absolute top-1/2 -translate-y-1/2 rounded-[2px]"
            style={{
              left: `${left}%`,
              width: `${width}%`,
              height,
              // A non-zero exit is the one thing that must survive a glance at a
              // wall of bars, so it gets its own edge rather than a hue shift.
              borderTop: failed && segment.phase === "running" ? "2px solid var(--status-fail)" : undefined,
              ...phaseStyle(segment.phase, color),
            }}
          />
        )
      })}
    </>
  )
}

/* ---------------------------------------------------------------------------
 * Component
 * ------------------------------------------------------------------------ */

export interface WaterfallProps {
  sandboxes: SandboxRow[]
  timeline: RunTimeline
  runState: RunState
  /** Ticks while the run is live so open-ended bars keep growing. */
  now: number
  playheadMs: number | null
  onPlayheadChange: (at: number | null) => void
  selectedUnitId: string | null
  onSelectUnit: (unitId: string) => void
}

export function Waterfall({
  sandboxes,
  timeline,
  runState,
  now,
  playheadMs,
  onPlayheadChange,
  selectedUnitId,
  onSelectUnit,
}: WaterfallProps) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const [expanded, setExpanded] = React.useState<ReadonlySet<Variant>>(() => new Set<Variant>())
  const [hovered, setHovered] = React.useState<{ unit: SandboxRow; x: number; y: number } | null>(
    null,
  )

  const domain = React.useMemo<Domain>(() => {
    let start = timeline.startedAt ?? Number.POSITIVE_INFINITY
    for (const unit of sandboxes) {
      const at = unitStart(unit)
      if (at !== null && at < start) start = at
    }
    if (!Number.isFinite(start)) start = now - MIN_SPAN_MS
    const end = timeline.endedAt ?? now
    return { start, end: Math.max(end, start + MIN_SPAN_MS) }
  }, [timeline, sandboxes, now])

  const lanes = React.useMemo(() => {
    const grouped = new Map<Variant, SandboxRow[]>()
    for (const variant of VARIANT_ORDER) grouped.set(variant, [])
    for (const unit of sandboxes) grouped.get(unit.variant)?.push(unit)
    return VARIANT_ORDER.map((variant) => ({ variant, units: grouped.get(variant) ?? [] }))
  }, [sandboxes])

  const rows = React.useMemo<Row[]>(() => {
    const out: Row[] = [{ kind: "orchestrator", key: "orchestrator" }]
    for (const lane of lanes) {
      out.push({ kind: "lane", key: `lane:${lane.variant}`, variant: lane.variant, units: lane.units })
      if (expanded.has(lane.variant)) {
        for (const unit of lane.units) {
          out.push({ kind: "unit", key: unit.unitId, variant: lane.variant, unit })
        }
      }
    }
    return out
  }, [lanes, expanded])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    getItemKey: (index) => rows[index]?.key ?? index,
  })

  const ticks = React.useMemo(() => {
    const span = domain.end - domain.start
    return [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
      fraction,
      label: formatDuration(span * fraction),
    }))
  }, [domain])

  // Measured off the scroll container rather than a row, because row 0 can be
  // virtualised out of view and take its ref with it.
  const scrub = (clientX: number) => {
    const host = scrollRef.current
    if (!host) return
    const rect = host.getBoundingClientRect()
    const width = Math.max(1, rect.width - LABEL_WIDTH - 16)
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left - LABEL_WIDTH) / width))
    onPlayheadChange(domain.start + fraction * (domain.end - domain.start))
  }

  const toggleLane = (variant: Variant) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(variant)) next.delete(variant)
      else next.add(variant)
      return next
    })
  }

  const playheadPercent = playheadMs === null ? null : percent(playheadMs, domain)

  return (
    <section className="overflow-hidden rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[var(--elev-1)]">
      <header className="flex items-center gap-3 border-b border-[var(--border-hairline)] px-4 py-2.5">
        <p className="text-eyebrow text-[var(--fg-tertiary)]">Timeline</p>
        <div className="ml-auto flex items-center gap-3">
          <Legend swatch={<span className="h-2 w-4 rounded-[2px] bg-[var(--fg-tertiary)]" />}>
            running
          </Legend>
          <Legend
            swatch={
              <span
                className="h-2 w-4 rounded-[2px]"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(135deg, var(--fg-tertiary) 0 2px, transparent 2px 5px)",
                  opacity: 0.6,
                }}
              />
            }
          >
            provisioning
          </Legend>
          <Legend
            swatch={
              <span className="h-2 w-4 rounded-[2px] border border-[var(--fg-tertiary)] opacity-60" />
            }
          >
            queued
          </Legend>
          <Legend
            swatch={<span className="h-2 w-4 rounded-[2px] border-t-2 border-[var(--status-fail)]" />}
          >
            non-zero exit
          </Legend>
        </div>
      </header>

      <div className="flex h-7 items-center border-b border-[var(--border-hairline)] pr-4">
        <div style={{ width: LABEL_WIDTH }} className="shrink-0 pl-4">
          <span className="text-eyebrow text-[var(--fg-quaternary)]">Elapsed</span>
        </div>
        <div className="relative h-full flex-1">
          {ticks.map((tick) => (
            <span
              key={tick.fraction}
              className="mono absolute top-1/2 -translate-y-1/2 text-[11px] text-[var(--fg-quaternary)]"
              style={{
                left: `${tick.fraction * 100}%`,
                transform: tick.fraction === 1 ? "translate(-100%, -50%)" : "translate(0, -50%)",
              }}
              data-numeric
            >
              {tick.label}
            </span>
          ))}
        </div>
      </div>

      <div ref={hostRef} className="relative">
      <div
        ref={scrollRef}
        className="max-h-[440px] overflow-y-auto"
        onPointerLeave={() => setHovered(null)}
      >
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]
            if (!row) return null
            return (
              <div
                key={item.key}
                className="absolute left-0 flex w-full items-center border-b border-[var(--border-hairline)]"
                style={{ top: item.start, height: ROW_HEIGHT }}
              >
                {row.kind === "orchestrator" ? (
                  <OrchestratorRow
                    timeline={timeline}
                    runState={runState}
                    domain={domain}
                    onScrub={scrub}
                  />
                ) : row.kind === "lane" ? (
                  <LaneRow
                    variant={row.variant}
                    units={row.units}
                    domain={domain}
                    expanded={expanded.has(row.variant)}
                    onToggle={() => toggleLane(row.variant)}
                    onScrub={scrub}
                  />
                ) : (
                  <UnitRow
                    unit={row.unit}
                    domain={domain}
                    selected={row.unit.unitId === selectedUnitId}
                    hostRef={hostRef}
                    onSelect={() => onSelectUnit(row.unit.unitId)}
                    onScrub={scrub}
                    onHover={setHovered}
                  />
                )}
              </div>
            )
          })}

          {playheadPercent !== null ? (
            <div
              aria-hidden
              className="pointer-events-none absolute top-0 z-10 w-px bg-[var(--accent-400)]"
              style={{
                left: `calc(${LABEL_WIDTH}px + (100% - ${LABEL_WIDTH}px - 16px) * ${
                  playheadPercent / 100
                })`,
                height: virtualizer.getTotalSize(),
              }}
            />
          ) : null}
          </div>
        </div>

        {/* Outside the scroll container so its coordinates never need scrollTop. */}
        {hovered ? (
          <div
            role="status"
            className="pointer-events-none absolute z-20 w-[212px] rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2.5 shadow-[var(--elev-2)]"
            style={{ left: Math.max(8, hovered.x - 106), top: hovered.y + 14 }}
          >
            <p className="mono truncate text-[12.5px] text-[var(--fg-primary)]">
              {hovered.unit.unitId}
            </p>
            <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
              <PopoverRow label="Region">{hovered.unit.region ?? "—"}</PopoverRow>
              <PopoverRow label="State">
                <span style={{ color: STATUS_META[hovered.unit.state].color }}>
                  {STATUS_META[hovered.unit.state].label}
                </span>
              </PopoverRow>
              <PopoverRow label="Duration">
                {hovered.unit.durationMs === null ? "—" : formatDuration(hovered.unit.durationMs)}
              </PopoverRow>
              <PopoverRow label="Exit">
                {hovered.unit.exitCode === null ? "—" : String(hovered.unit.exitCode)}
              </PopoverRow>
            </dl>
          </div>
        ) : null}
      </div>

      <footer className="flex items-center gap-2 border-t border-[var(--border-hairline)] px-4 py-2">
        <p className="text-caption text-[var(--fg-tertiary)]">
          {playheadMs === null ? (
            "Click the timeline to place a playhead; the log viewer follows it."
          ) : (
            <>
              Playhead at{" "}
              <span className="mono text-[var(--accent-300)]" data-numeric>
                +{formatDuration(playheadMs - domain.start)}
              </span>
            </>
          )}
        </p>
        {playheadMs !== null ? (
          <button
            type="button"
            onClick={() => onPlayheadChange(null)}
            className="text-caption ml-auto text-[var(--fg-tertiary)] transition-colors duration-[var(--dur-fast)] hover:text-[var(--fg-primary)]"
          >
            Clear
          </button>
        ) : null}
      </footer>
    </section>
  )
}

/* ---------------------------------------------------------------------------
 * Rows
 * ------------------------------------------------------------------------ */

function Legend({ swatch, children }: { swatch: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="hidden items-center gap-1.5 lg:inline-flex">
      <span aria-hidden className="inline-flex">
        {swatch}
      </span>
      <span className="text-caption text-[var(--fg-quaternary)]">{children}</span>
    </span>
  )
}

function PopoverRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-eyebrow text-[var(--fg-quaternary)]">{label}</dt>
      <dd className="mono truncate text-right text-[var(--fg-secondary)]">{children}</dd>
    </>
  )
}

function ChartArea({
  onScrub,
  children,
}: {
  onScrub: (clientX: number) => void
  children: React.ReactNode
}) {
  return (
    <div
      className="relative h-full flex-1 cursor-col-resize"
      onPointerDown={(event) => onScrub(event.clientX)}
    >
      {children}
    </div>
  )
}

function OrchestratorRow({
  timeline,
  runState,
  domain,
  onScrub,
}: {
  timeline: RunTimeline
  runState: RunState
  domain: Domain
  onScrub: (clientX: number) => void
}) {
  // A run restored from the server has a state but no observed transitions;
  // one span across the domain is truthful, an empty row is not.
  const phases =
    timeline.phases.length > 0 ? timeline.phases : [{ state: runState, at: domain.start }]
  return (
    <>
      <div
        style={{ width: LABEL_WIDTH }}
        className="flex h-full shrink-0 items-center gap-2 pl-4 pr-2"
      >
        <span className="mono text-[11px] text-[var(--fg-quaternary)]">◆</span>
        <span className="text-[12.5px] font-medium text-[var(--fg-primary)]">Orchestrator</span>
        <span className="text-caption ml-auto text-[var(--fg-tertiary)]">
          {RUN_STATE_META[runState].label}
        </span>
      </div>
      <ChartArea onScrub={onScrub}>
        <div className="mr-4 h-full">
          {phases.map((phase, index) => {
            const from = phase.at
            const to = phases[index + 1]?.at ?? (timeline.endedAt ?? domain.end)
            const left = percent(from, domain)
            const width = Math.max(MIN_BAR_PERCENT, percent(to, domain) - left)
            const meta = RUN_STATE_META[phase.state]
            const active = index === phases.length - 1 && !meta.terminal
            return (
              <span
                key={`${phase.state}-${phase.at}`}
                title={`${meta.label} · +${formatDuration(from - domain.start)}`}
                className="absolute top-1/2 flex h-[14px] -translate-y-1/2 items-center overflow-hidden rounded-[2px] px-1"
                style={{
                  left: `${left}%`,
                  width: `${width}%`,
                  backgroundColor: `color-mix(in srgb, ${meta.color} ${active ? 26 : 14}%, transparent)`,
                  boxShadow: `inset 1px 0 0 0 ${meta.color}`,
                }}
              >
                <span
                  className="mono truncate text-[10px] uppercase tracking-[0.1em]"
                  style={{ color: meta.color }}
                >
                  {meta.label}
                </span>
              </span>
            )
          })}
        </div>
      </ChartArea>
    </>
  )
}

function LaneRow({
  variant,
  units,
  domain,
  expanded,
  onToggle,
  onScrub,
}: {
  variant: Variant
  units: SandboxRow[]
  domain: Domain
  expanded: boolean
  onToggle: () => void
  onScrub: (clientX: number) => void
}) {
  const meta = VARIANT_META[variant]

  const aggregate = React.useMemo<Segment[]>(() => {
    if (units.length === 0) return []
    let first = Number.POSITIVE_INFINITY
    let runFrom = Number.POSITIVE_INFINITY
    let last = Number.NEGATIVE_INFINITY
    let open = false
    for (const unit of units) {
      const start = unitStart(unit)
      if (start !== null) first = Math.min(first, start)
      if (unit.startedAt !== null) runFrom = Math.min(runFrom, unit.startedAt)
      if (unit.endedAt !== null) last = Math.max(last, unit.endedAt)
      else open = true
    }
    if (!Number.isFinite(first)) return []
    const end = open ? domain.end : last
    const segments: Segment[] = []
    if (Number.isFinite(runFrom)) {
      if (runFrom > first) segments.push({ from: first, to: runFrom, phase: "provisioning" })
      segments.push({ from: runFrom, to: Math.max(end, runFrom + 1), phase: "running" })
    } else {
      segments.push({ from: first, to: Math.max(end, first + 1), phase: "queued" })
    }
    return segments
  }, [units, domain])

  const failed = units.some((unit) => unit.exitCode !== null && unit.exitCode !== 0)
  const done = units.filter((unit) => unit.endedAt !== null).length

  return (
    <>
      <div style={{ width: LABEL_WIDTH }} className="flex h-full shrink-0 items-center pl-2 pr-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          disabled={units.length === 0}
          className={cn(
            "flex h-full flex-1 items-center gap-1.5 rounded-[4px] px-1.5 text-left",
            "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
            "hover:bg-[var(--bg-raised)] disabled:opacity-40",
          )}
        >
          {expanded ? (
            <CaretDown size={16} weight="regular" color="var(--fg-tertiary)" aria-hidden />
          ) : (
            <CaretRight size={16} weight="regular" color="var(--fg-quaternary)" aria-hidden />
          )}
          <span
            aria-hidden
            className="mono grid h-4 w-4 place-items-center rounded-[3px] border text-[10px] leading-none"
            style={{ color: meta.color, backgroundColor: meta.wash, borderColor: meta.border }}
          >
            {meta.glyph}
          </span>
          <span className="text-[12.5px] font-medium text-[var(--fg-secondary)]">{meta.label}</span>
          <span className="mono ml-auto text-[11px] text-[var(--fg-quaternary)]" data-numeric>
            {done}/{units.length}
          </span>
        </button>
      </div>
      <ChartArea onScrub={onScrub}>
        <div className="mr-4 h-full">
          <Bar segments={aggregate} domain={domain} color={meta.color} failed={failed} height={12} />
        </div>
      </ChartArea>
    </>
  )
}

function UnitRow({
  unit,
  domain,
  selected,
  hostRef,
  onSelect,
  onScrub,
  onHover,
}: {
  unit: SandboxRow
  domain: Domain
  selected: boolean
  hostRef: React.RefObject<HTMLDivElement | null>
  onSelect: () => void
  onScrub: (clientX: number) => void
  onHover: (value: { unit: SandboxRow; x: number; y: number } | null) => void
}) {
  const meta = VARIANT_META[unit.variant]
  const segments = React.useMemo(() => segmentsFor(unit, domain), [unit, domain])
  const failed = unit.exitCode !== null && unit.exitCode !== 0

  return (
    <>
      <div style={{ width: LABEL_WIDTH }} className="flex h-full shrink-0 items-center pl-9 pr-2">
        <button
          type="button"
          onClick={onSelect}
          className={cn(
            "mono h-full min-w-0 flex-1 truncate rounded-[4px] px-1.5 text-left text-[11.5px]",
            "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
            selected
              ? "bg-[var(--accent-wash)] text-[var(--accent-300)]"
              : "text-[var(--fg-tertiary)] hover:bg-[var(--bg-raised)] hover:text-[var(--fg-secondary)]",
          )}
        >
          {unit.unitId}
          {unit.region ? ` · ${unit.region}` : ""}
        </button>
      </div>
      <ChartArea onScrub={onScrub}>
        <div
          className="mr-4 h-full"
          onPointerMove={(event) => {
            const host = hostRef.current
            if (!host) return
            const rect = host.getBoundingClientRect()
            onHover({ unit, x: event.clientX - rect.left, y: event.clientY - rect.top })
          }}
          onPointerLeave={() => onHover(null)}
        >
          <Bar segments={segments} domain={domain} color={meta.color} failed={failed} height={10} />
        </div>
      </ChartArea>
    </>
  )
}
