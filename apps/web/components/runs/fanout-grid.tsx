"use client"

/**
 * The fan-out view.
 *
 * The representation changes with population, because no single encoding is
 * honest across three orders of magnitude:
 *
 *   ≤24    cards, with a live log tail — at this width the interesting thing
 *          about a sandbox is what it is saying, not that it exists.
 *   25–400 a unit grid on one canvas. Four hundred React components each with
 *          their own listener is what makes dashboards like this jank; the grid
 *          is drawn once per flush and hit-tested arithmetically.
 *   >400   a beeswarm over p95 latency, because at that count the question
 *          stops being "which one" and becomes "what do the slow ones share".
 *
 * A treemap and a flame chart were both considered and rejected. A treemap
 * spends its area channel on units that all weigh the same and produces
 * unlabelable slivers; a flame chart encodes nesting depth, and this tree is
 * only run → variant → sandbox.
 */

import * as React from "react"

import { cn, formatDuration } from "@/lib/utils"
import {
  STATUS_META,
  VARIANT_META,
  VARIANT_ORDER,
  type SandboxStatus,
  type Variant,
} from "@/lib/variants"
import { StatusPill } from "@/components/ui/status-pill"
import { VariantBadge } from "@/components/ui/variant-badge"
import type { FanoutSummary, SandboxRow } from "./use-run-stream"

/* ---------------------------------------------------------------------------
 * Geometry
 * ------------------------------------------------------------------------ */

const CELL = 10
const GAP = 4
const PITCH = CELL + GAP
const CELL_RADIUS = 2
const GROUP_HEADER = 22
const GROUP_GAP = 16
const CANVAS_PAD_X = 2
const SWARM_HEIGHT = 260
const SWARM_PAD = { top: 16, right: 16, bottom: 28, left: 44 }
const DOT_RADIUS = 3

const CARD_TIER_MAX = 24
const GRID_TIER_MAX = 400

/* ---------------------------------------------------------------------------
 * Palette — canvas cannot read CSS custom properties
 * ------------------------------------------------------------------------ */

interface Palette {
  status: Record<SandboxStatus, string>
  variant: Record<Variant, string>
  accent: string
  hairline: string
  subtle: string
  fgTertiary: string
  fgQuaternary: string
  inset: string
  monoFont: string
}

const STATUS_KEYS = Object.keys(STATUS_META) as SandboxStatus[]
const VARIANT_KEYS: readonly Variant[] = VARIANT_ORDER

function readVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name).trim()
  return value === "" ? fallback : value
}

/**
 * Resolved once. The app is single-theme by design, so there is no palette
 * change to listen for.
 */
function usePalette(probe: React.RefObject<HTMLElement | null>): Palette | null {
  const [palette, setPalette] = React.useState<Palette | null>(null)

  React.useEffect(() => {
    const root = getComputedStyle(document.documentElement)
    const status = {} as Record<SandboxStatus, string>
    for (const key of STATUS_KEYS) {
      const token = STATUS_META[key].color.replace(/^var\((.*)\)$/, "$1")
      status[key] = readVar(root, token, "#6e7080")
    }
    const variant = {} as Record<Variant, string>
    for (const key of VARIANT_KEYS) {
      const token = VARIANT_META[key].color.replace(/^var\((.*)\)$/, "$1")
      variant[key] = readVar(root, token, "#8a93a8")
    }
    const monoFont = probe.current
      ? getComputedStyle(probe.current).fontFamily
      : "ui-monospace, monospace"

    setPalette({
      status,
      variant,
      accent: readVar(root, "--accent-400", "#ffb454"),
      hairline: "rgb(255 255 255 / 0.06)",
      subtle: "rgb(255 255 255 / 0.10)",
      fgTertiary: readVar(root, "--fg-tertiary", "#71737f"),
      fgQuaternary: readVar(root, "--fg-quaternary", "#4a4c58"),
      inset: readVar(root, "--bg-inset", "#050509"),
      monoFont,
    })
  }, [probe])

  return palette
}

function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = React.useState(0)
  React.useEffect(() => {
    const element = ref.current
    if (!element) return
    setWidth(element.clientWidth)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWidth(Math.floor(entry.contentRect.width))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width
}

function prepareCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext("2d")
  if (!ctx) return null
  const dpr = Math.min(window.devicePixelRatio || 1, 3)
  canvas.width = Math.max(1, Math.floor(width * dpr))
  canvas.height = Math.max(1, Math.floor(height * dpr))
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  return ctx
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r)
  } else {
    ctx.rect(x, y, w, h)
  }
}

/* ---------------------------------------------------------------------------
 * Summary strip
 * ------------------------------------------------------------------------ */

const BAR_SEGMENTS: readonly { key: keyof FanoutSummary; status: SandboxStatus }[] = [
  { key: "passed", status: "passed" },
  { key: "failed", status: "failed" },
  { key: "flaky", status: "flaky" },
  { key: "running", status: "running" },
  { key: "provisioning", status: "provisioning" },
  { key: "queued", status: "queued" },
  { key: "skipped", status: "skipped" },
  { key: "error", status: "error" },
  { key: "timedOut", status: "timed_out" },
]

const TILES: readonly { label: string; key: keyof FanoutSummary; color: string }[] = [
  { label: "Total", key: "total", color: "var(--fg-primary)" },
  { label: "Passed", key: "passed", color: "var(--status-pass)" },
  { label: "Failed", key: "failed", color: "var(--status-fail)" },
  { label: "Flaky", key: "flaky", color: "var(--status-flaky)" },
  { label: "Running", key: "running", color: "var(--status-running)" },
]

function SummaryStrip({ summary }: { summary: FanoutSummary }) {
  const denominator = Math.max(1, summary.total)
  return (
    <div className="border-b border-[var(--border-hairline)]">
      <div className="grid grid-cols-2 gap-px bg-[var(--border-hairline)] sm:grid-cols-5">
        {TILES.map((tile) => (
          <div key={tile.key} className="bg-[var(--bg-surface)] px-4 py-3">
            <p className="text-eyebrow text-[var(--fg-tertiary)]">{tile.label}</p>
            <p className="text-metric mt-1.5" style={{ color: tile.color }}>
              {summary[tile.key]}
            </p>
          </div>
        ))}
      </div>
      <div
        className="flex h-1 w-full overflow-hidden bg-[var(--bg-raised)]"
        role="img"
        aria-label={`${summary.passed} passed, ${summary.failed} failed, ${summary.flaky} flaky, ${summary.running} running of ${summary.total} sandboxes`}
      >
        {BAR_SEGMENTS.map((segment) => {
          const value = summary[segment.key]
          if (value <= 0) return null
          return (
            <span
              key={segment.key}
              style={{
                width: `${(value / denominator) * 100}%`,
                backgroundColor: STATUS_META[segment.status].color,
              }}
            />
          )
        })}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------------------
 * Tier 1 — cards
 * ------------------------------------------------------------------------ */

interface TierProps {
  sandboxes: SandboxRow[]
  selectedUnitId: string | null
  onSelectUnit: (unitId: string) => void
}

interface CardTierProps extends TierProps {
  logTails: Record<string, string[]>
}

function CardTier({ sandboxes, logTails, selectedUnitId, onSelectUnit }: CardTierProps) {
  return (
    <div className="grid gap-2 p-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {sandboxes.map((unit) => {
        const meta = STATUS_META[unit.state]
        const live = unit.state === "running"
        const tail = logTails[unit.unitId] ?? []
        const selected = unit.unitId === selectedUnitId
        return (
          <button
            key={unit.unitId}
            type="button"
            onClick={() => onSelectUnit(unit.unitId)}
            aria-pressed={selected}
            className={cn(
              "relative overflow-hidden rounded-[8px] border bg-[var(--bg-surface)] text-left",
              "shadow-[var(--elev-1)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
              selected
                ? "border-[var(--accent-border)]"
                : "border-[var(--border-subtle)] hover:border-[var(--border-default)]",
              live && "is-running",
            )}
          >
            <div className="flex items-center gap-2 px-3 pb-2 pt-2.5">
              <VariantBadge variant={unit.variant} showLabel={false} />
              <span className="mono flex-1 truncate text-[12.5px] text-[var(--fg-primary)]">
                {unit.unitId}
              </span>
              <StatusPill status={unit.state} />
            </div>

            <div className="flex items-center gap-2 px-3 pb-2.5 text-[11.5px] text-[var(--fg-tertiary)]">
              <span className="mono truncate">{unit.region ?? "—"}</span>
              <span aria-hidden className="text-[var(--fg-quaternary)]">
                ·
              </span>
              <span className="mono" data-numeric>
                {unit.durationMs === null ? "—" : formatDuration(unit.durationMs)}
              </span>
              {unit.exitCode !== null && unit.exitCode !== 0 ? (
                <>
                  <span aria-hidden className="text-[var(--fg-quaternary)]">
                    ·
                  </span>
                  <span className="mono text-[var(--status-fail)]" data-numeric>
                    exit {unit.exitCode}
                  </span>
                </>
              ) : null}
            </div>

            <div className="no-grain border-t border-[var(--border-hairline)] bg-[var(--bg-inset)] px-3 py-2">
              {tail.length === 0 ? (
                <p className="mono text-[11px] leading-[1.55] text-[var(--fg-quaternary)]">
                  {meta.terminal ? "no output" : "waiting for output…"}
                </p>
              ) : (
                tail.map((line, position) => (
                  <p
                    key={`${unit.unitId}-${position}-${line.slice(0, 12)}`}
                    className="mono truncate text-[11px] leading-[1.55] text-[var(--fg-tertiary)] last:text-[var(--fg-secondary)]"
                  >
                    {line}
                  </p>
                ))
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}

/* ---------------------------------------------------------------------------
 * Tier 2 — unit grid on one canvas
 * ------------------------------------------------------------------------ */

interface UnitGroup {
  key: string
  variant: Variant
  region: string | null
  /** Index into the sorted sandbox array. */
  start: number
  count: number
  gridTop: number
  rows: number
}

interface GridLayout {
  groups: UnitGroup[]
  columns: number
  height: number
}

function layoutGroups(sandboxes: SandboxRow[], width: number): GridLayout {
  const columns = Math.max(1, Math.floor((width - CANVAS_PAD_X * 2) / PITCH))
  const groups: UnitGroup[] = []
  let cursor = 0
  let y = 0

  while (cursor < sandboxes.length) {
    const head = sandboxes[cursor]
    if (!head) break
    let end = cursor + 1
    while (end < sandboxes.length) {
      const next = sandboxes[end]
      if (!next || next.variant !== head.variant || next.region !== head.region) break
      end += 1
    }
    const count = end - cursor
    const rows = Math.ceil(count / columns)
    groups.push({
      key: `${head.variant}:${head.region ?? "—"}`,
      variant: head.variant,
      region: head.region,
      start: cursor,
      count,
      gridTop: y + GROUP_HEADER,
      rows,
    })
    y += GROUP_HEADER + rows * PITCH + GROUP_GAP
    cursor = end
  }

  return { groups, columns, height: Math.max(1, y) }
}

/** Arithmetic, not listeners: the whole point of drawing this on one canvas. */
function hitTest(layout: GridLayout, x: number, y: number, total: number): number {
  for (const group of layout.groups) {
    const localY = y - group.gridTop
    if (localY < 0 || localY >= group.rows * PITCH) continue
    const localX = x - CANVAS_PAD_X
    if (localX < 0) return -1
    const column = Math.floor(localX / PITCH)
    const row = Math.floor(localY / PITCH)
    if (column >= layout.columns) return -1
    // Reject the gutter so the popover does not flicker between neighbours.
    if (localX % PITCH > CELL || localY % PITCH > CELL) return -1
    const index = group.start + row * layout.columns + column
    if (index >= group.start + group.count || index >= total) return -1
    return index
  }
  return -1
}

function GridTier({ sandboxes, selectedUnitId, onSelectUnit }: TierProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const probeRef = React.useRef<HTMLSpanElement | null>(null)
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const width = useElementWidth(containerRef)
  const palette = usePalette(probeRef)
  const [hovered, setHovered] = React.useState(-1)

  const layout = React.useMemo(() => layoutGroups(sandboxes, width || 1), [sandboxes, width])

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !palette || width <= 0) return
    const ctx = prepareCanvas(canvas, width, layout.height)
    if (!ctx) return

    ctx.textBaseline = "alphabetic"
    for (const group of layout.groups) {
      const headerY = group.gridTop - GROUP_HEADER
      ctx.font = `500 11px ${palette.monoFont}`
      if ("letterSpacing" in ctx) ctx.letterSpacing = "0.14em"

      // The glyph carries the variant colour; the rest stays tertiary so the
      // header never competes with the cells for attention.
      const glyph = `${VARIANT_META[group.variant].glyph} `
      ctx.fillStyle = palette.variant[group.variant]
      ctx.fillText(glyph, CANVAS_PAD_X, headerY + 12)
      ctx.fillStyle = palette.fgTertiary
      ctx.fillText(
        `${VARIANT_META[group.variant].label.toUpperCase()} · ${(
          group.region ?? "no region"
        ).toUpperCase()} · ${group.count}`,
        CANVAS_PAD_X + ctx.measureText(glyph).width,
        headerY + 12,
      )
      if ("letterSpacing" in ctx) ctx.letterSpacing = "0px"

      ctx.fillStyle = palette.hairline
      ctx.fillRect(CANVAS_PAD_X, headerY + GROUP_HEADER - 5, width - CANVAS_PAD_X * 2, 1)

      for (let offset = 0; offset < group.count; offset += 1) {
        const unit = sandboxes[group.start + offset]
        if (!unit) continue
        const column = offset % layout.columns
        const row = Math.floor(offset / layout.columns)
        const x = CANVAS_PAD_X + column * PITCH
        const y = group.gridTop + row * PITCH

        ctx.fillStyle = palette.status[unit.state]
        roundedRect(ctx, x, y, CELL, CELL, CELL_RADIUS)
        ctx.fill()

        const streaming = unit.state === "running" || unit.state === "provisioning"
        const isHovered = group.start + offset === hovered
        const isSelected = unit.unitId === selectedUnitId
        if (streaming || isHovered || isSelected) {
          ctx.strokeStyle = palette.accent
          ctx.lineWidth = 1
          roundedRect(ctx, x - 1.5, y - 1.5, CELL + 3, CELL + 3, CELL_RADIUS + 1)
          ctx.globalAlpha = isHovered || isSelected ? 1 : 0.55
          ctx.stroke()
          ctx.globalAlpha = 1
        }
      }
    }
  }, [layout, sandboxes, palette, width, hovered, selectedUnitId])

  const positionFor = React.useCallback(
    (index: number): { left: number; top: number } | null => {
      for (const group of layout.groups) {
        if (index < group.start || index >= group.start + group.count) continue
        const offset = index - group.start
        return {
          left: CANVAS_PAD_X + (offset % layout.columns) * PITCH + CELL / 2,
          top: group.gridTop + Math.floor(offset / layout.columns) * PITCH,
        }
      }
      return null
    },
    [layout],
  )

  const handleMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const index = hitTest(layout, event.clientX - rect.left, event.clientY - rect.top, sandboxes.length)
    // Anchored to the cell, not the cursor, so moving within one cell is free.
    if (index !== hovered) setHovered(index)
  }

  const hoveredUnit = hovered >= 0 ? sandboxes[hovered] : undefined
  const anchor = hovered >= 0 ? positionFor(hovered) : null

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const index = hitTest(
      layout,
      event.clientX - rect.left,
      event.clientY - rect.top,
      sandboxes.length,
    )
    const unit = index >= 0 ? sandboxes[index] : undefined
    if (unit) onSelectUnit(unit.unitId)
  }

  return (
    <div className="p-4">
      <span ref={probeRef} className="mono sr-only" aria-hidden>
        0
      </span>
      <div ref={containerRef} className="relative">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`${sandboxes.length} sandboxes grouped by variant and region. Hover a cell for detail, click to open its log.`}
          className="block cursor-pointer"
          onPointerMove={handleMove}
          onPointerLeave={() => setHovered(-1)}
          onClick={handleClick}
        />

        {/* Exactly one popover node exists, repositioned — never one per cell. */}
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "pointer-events-none absolute z-10 w-[212px] rounded-[8px] border",
            "border-[var(--border-default)] bg-[var(--bg-overlay)] p-2.5 shadow-[var(--elev-2)]",
            "transition-opacity duration-[var(--dur-micro)] ease-[var(--ease-out)]",
            hoveredUnit && anchor ? "opacity-100" : "opacity-0",
          )}
          style={
            anchor
              ? {
                  left: Math.min(Math.max(anchor.left - 106, 8), Math.max(8, width - 220)),
                  top: Math.max(4, anchor.top - 96),
                }
              : { left: 8, top: 4 }
          }
        >
          {hoveredUnit ? (
            <>
              <p className="mono truncate text-[12.5px] text-[var(--fg-primary)]">
                {hoveredUnit.unitId}
              </p>
              <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
                <PopoverRow label="Variant">
                  <span style={{ color: VARIANT_META[hoveredUnit.variant].color }}>
                    {VARIANT_META[hoveredUnit.variant].glyph}{" "}
                    {VARIANT_META[hoveredUnit.variant].label}
                  </span>
                </PopoverRow>
                <PopoverRow label="Region">{hoveredUnit.region ?? "—"}</PopoverRow>
                <PopoverRow label="State">
                  <span style={{ color: STATUS_META[hoveredUnit.state].color }}>
                    {STATUS_META[hoveredUnit.state].label}
                  </span>
                </PopoverRow>
                <PopoverRow label="Duration">
                  {hoveredUnit.durationMs === null ? "—" : formatDuration(hoveredUnit.durationMs)}
                </PopoverRow>
                <PopoverRow label="Exit">
                  {hoveredUnit.exitCode === null ? "—" : String(hoveredUnit.exitCode)}
                </PopoverRow>
              </dl>
            </>
          ) : null}
        </div>
      </div>
    </div>
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

/* ---------------------------------------------------------------------------
 * Tier 3 — beeswarm with box selection
 * ------------------------------------------------------------------------ */

interface SwarmPoint {
  unitId: string
  variant: Variant
  region: string
  probeId: string
  state: SandboxStatus
  latency: number
  jitter: number
}

/** Deterministic per unit: a random jitter would make points dance on redraw. */
function hashUnit(unitId: string): number {
  let hash = 2166136261
  for (let i = 0; i < unitId.length; i += 1) {
    hash ^= unitId.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return ((hash >>> 0) % 1000) / 1000
}

interface Selection {
  x0: number
  y0: number
  x1: number
  y1: number
}

interface AttributeRow {
  attribute: string
  value: string
  inside: number
  outside: number
  divergence: number
}

function computeDivergence(points: SwarmPoint[], selected: Set<string>): AttributeRow[] {
  if (selected.size === 0 || selected.size === points.length) return []
  const insideTotal = selected.size
  const outsideTotal = points.length - insideTotal
  const tallies = new Map<string, { attribute: string; value: string; inside: number; outside: number }>()

  for (const point of points) {
    const isInside = selected.has(point.unitId)
    const pairs: readonly [string, string][] = [
      ["region", point.region],
      ["variant", point.variant],
      ["probe", point.probeId],
    ]
    for (const [attribute, value] of pairs) {
      const key = `${attribute}=${value}`
      const entry = tallies.get(key) ?? { attribute, value, inside: 0, outside: 0 }
      if (isInside) entry.inside += 1
      else entry.outside += 1
      tallies.set(key, entry)
    }
  }

  return Array.from(tallies.values())
    .map((entry) => {
      const inside = entry.inside / insideTotal
      const outside = outsideTotal === 0 ? 0 : entry.outside / outsideTotal
      return {
        attribute: entry.attribute,
        value: entry.value,
        inside,
        outside,
        divergence: Math.abs(inside - outside),
      }
    })
    .filter((row) => row.divergence > 0.01)
    .sort((a, b) => b.divergence - a.divergence)
    .slice(0, 5)
}

function SwarmTier({
  sandboxes,
  latencyP95,
  selectedUnitId,
  onSelectUnit,
}: TierProps & { latencyP95: Record<string, number> }) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const probeRef = React.useRef<HTMLSpanElement | null>(null)
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const width = useElementWidth(containerRef)
  const palette = usePalette(probeRef)
  const [drag, setDrag] = React.useState<Selection | null>(null)
  const [selection, setSelection] = React.useState<Selection | null>(null)

  const points = React.useMemo<SwarmPoint[]>(() => {
    const rows: SwarmPoint[] = []
    for (const unit of sandboxes) {
      const latency = latencyP95[unit.unitId] ?? unit.durationMs ?? 0
      if (latency <= 0) continue
      rows.push({
        unitId: unit.unitId,
        variant: unit.variant,
        region: unit.region ?? "unknown",
        probeId: unit.probeId ?? "unknown",
        state: unit.state,
        latency,
        jitter: hashUnit(unit.unitId),
      })
    }
    return rows
  }, [sandboxes, latencyP95])

  const scale = React.useMemo(() => {
    const values = points.map((point) => point.latency)
    const min = Math.max(1, Math.min(...values, 1))
    const max = Math.max(min * 10, ...values)
    const logMin = Math.log10(min)
    const logMax = Math.log10(max)
    const plotWidth = Math.max(1, width - SWARM_PAD.left - SWARM_PAD.right)
    return {
      min,
      max,
      toX: (latency: number) =>
        SWARM_PAD.left +
        ((Math.log10(Math.max(latency, min)) - logMin) / Math.max(0.0001, logMax - logMin)) *
          plotWidth,
    }
  }, [points, width])

  const ticks = React.useMemo(() => {
    const out: number[] = []
    for (let exponent = 0; exponent <= 6; exponent += 1) {
      const value = 10 ** exponent
      if (value >= scale.min / 2 && value <= scale.max * 2) out.push(value)
    }
    return out
  }, [scale])

  const selectedIds = React.useMemo(() => {
    const ids = new Set<string>()
    if (!selection) return ids
    const left = Math.min(selection.x0, selection.x1)
    const right = Math.max(selection.x0, selection.x1)
    const top = Math.min(selection.y0, selection.y1)
    const bottom = Math.max(selection.y0, selection.y1)
    const band = SWARM_HEIGHT - SWARM_PAD.top - SWARM_PAD.bottom
    for (const point of points) {
      const x = scale.toX(point.latency)
      const y = SWARM_PAD.top + point.jitter * band
      if (x >= left && x <= right && y >= top && y <= bottom) ids.add(point.unitId)
    }
    return ids
  }, [selection, points, scale])

  const rows = React.useMemo(() => computeDivergence(points, selectedIds), [points, selectedIds])

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !palette || width <= 0) return
    const ctx = prepareCanvas(canvas, width, SWARM_HEIGHT)
    if (!ctx) return

    const band = SWARM_HEIGHT - SWARM_PAD.top - SWARM_PAD.bottom

    ctx.font = `500 11px ${palette.monoFont}`
    ctx.textBaseline = "top"
    for (const tick of ticks) {
      const x = scale.toX(tick)
      ctx.fillStyle = palette.hairline
      ctx.fillRect(Math.round(x), SWARM_PAD.top - 6, 1, band + 12)
      ctx.fillStyle = palette.fgQuaternary
      ctx.fillText(
        tick >= 1000 ? `${tick / 1000}s` : `${tick}ms`,
        Math.round(x) + 4,
        SWARM_HEIGHT - SWARM_PAD.bottom + 10,
      )
    }

    const active = selectedIds.size > 0
    for (const point of points) {
      const x = scale.toX(point.latency)
      const y = SWARM_PAD.top + point.jitter * band
      const inside = !active || selectedIds.has(point.unitId)
      ctx.globalAlpha = inside ? 0.85 : 0.16
      ctx.fillStyle = palette.status[point.state]
      ctx.beginPath()
      ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1

    const box = drag ?? selection
    if (box) {
      const left = Math.min(box.x0, box.x1)
      const top = Math.min(box.y0, box.y1)
      ctx.strokeStyle = palette.accent
      ctx.lineWidth = 1
      ctx.strokeRect(
        Math.round(left) + 0.5,
        Math.round(top) + 0.5,
        Math.abs(box.x1 - box.x0),
        Math.abs(box.y1 - box.y0),
      )
      ctx.fillStyle = palette.accent
      ctx.globalAlpha = 0.08
      ctx.fillRect(left, top, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0))
      ctx.globalAlpha = 1
    }
  }, [points, palette, width, ticks, scale, drag, selection, selectedIds])

  const localPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  return (
    <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_296px]">
      <div ref={containerRef} className="min-w-0">
        <span ref={probeRef} className="mono sr-only" aria-hidden>
          0
        </span>
        <div className="flex items-baseline justify-between pb-2">
          <p className="text-eyebrow text-[var(--fg-tertiary)]">p95 latency · log scale</p>
          <p className="text-caption text-[var(--fg-quaternary)]">
            {points.length} measured · {sandboxes.length - points.length} pending
          </p>
        </div>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Beeswarm of ${points.length} sandboxes by p95 latency. Drag to select a cluster.`}
          className="block cursor-crosshair touch-none select-none"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            const { x, y } = localPoint(event)
            setDrag({ x0: x, y0: y, x1: x, y1: y })
          }}
          onPointerMove={(event) => {
            if (!drag) return
            const { x, y } = localPoint(event)
            setDrag({ ...drag, x1: x, y1: y })
          }}
          onPointerUp={(event) => {
            if (!drag) return
            const { x, y } = localPoint(event)
            const box = { ...drag, x1: x, y1: y }
            setDrag(null)
            // A click, not a drag: clear rather than select a one-pixel box.
            const isClick = Math.abs(box.x1 - box.x0) < 4 && Math.abs(box.y1 - box.y0) < 4
            setSelection(isClick ? null : box)
          }}
        />
      </div>

      <aside className="min-w-0 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
        <div className="flex items-baseline justify-between">
          <p className="text-eyebrow text-[var(--fg-tertiary)]">Selection</p>
          {selection ? (
            <button
              type="button"
              onClick={() => setSelection(null)}
              className="text-caption text-[var(--fg-tertiary)] transition-colors duration-[var(--dur-fast)] hover:text-[var(--fg-primary)]"
            >
              Clear
            </button>
          ) : null}
        </div>

        {rows.length === 0 ? (
          <p className="text-body-sm mt-2 text-[var(--fg-tertiary)]">
            Drag a box across the swarm. Every attribute is then compared inside the selection
            against outside it, and the widest gaps are listed here.
          </p>
        ) : (
          <>
            <p className="text-caption mt-1 text-[var(--fg-tertiary)]">
              <span className="mono" data-numeric>
                {selectedIds.size}
              </span>{" "}
              of{" "}
              <span className="mono" data-numeric>
                {points.length}
              </span>{" "}
              sandboxes selected
            </p>
            <ul className="mt-3 flex flex-col gap-3">
              {rows.map((row) => (
                <li key={`${row.attribute}=${row.value}`}>
                  <p className="mono truncate text-[12px] text-[var(--fg-primary)]">
                    {row.attribute}={row.value}
                  </p>
                  <p className="text-caption mt-0.5 text-[var(--fg-tertiary)]">
                    <span className="mono text-[var(--accent-400)]" data-numeric>
                      {Math.round(row.inside * 100)}%
                    </span>{" "}
                    inside vs{" "}
                    <span className="mono" data-numeric>
                      {Math.round(row.outside * 100)}%
                    </span>{" "}
                    outside
                  </p>
                  <div className="mt-1.5 flex flex-col gap-1">
                    <div className="h-1.5 w-full rounded-[2px] bg-[var(--bg-raised)]">
                      <div
                        className="h-full rounded-[2px] bg-[var(--accent-400)]"
                        style={{ width: `${row.inside * 100}%` }}
                      />
                    </div>
                    <div className="h-1.5 w-full rounded-[2px] bg-[var(--bg-raised)]">
                      <div
                        className="h-full rounded-[2px] bg-[var(--fg-quaternary)]"
                        style={{ width: `${row.outside * 100}%` }}
                      />
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            <div className="mt-3 border-t border-[var(--border-hairline)] pt-3">
              <p className="text-eyebrow text-[var(--fg-quaternary)]">Open a log</p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {Array.from(selectedIds)
                  .slice(0, 8)
                  .map((unitId) => (
                    <button
                      key={unitId}
                      type="button"
                      onClick={() => onSelectUnit(unitId)}
                      className={cn(
                        "mono rounded-[4px] border px-1.5 py-0.5 text-[11px]",
                        "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
                        unitId === selectedUnitId
                          ? "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent-300)]"
                          : "border-[var(--border-subtle)] text-[var(--fg-secondary)] hover:border-[var(--border-default)]",
                      )}
                    >
                      {unitId}
                    </button>
                  ))}
              </div>
            </div>
          </>
        )}
      </aside>
    </div>
  )
}

/* ---------------------------------------------------------------------------
 * Public component
 * ------------------------------------------------------------------------ */

export interface FanoutGridProps {
  sandboxes: SandboxRow[]
  summary: FanoutSummary
  logTails: Record<string, string[]>
  latencyP95: Record<string, number>
  selectedUnitId: string | null
  onSelectUnit: (unitId: string) => void
}

export function FanoutGrid({
  sandboxes,
  summary,
  logTails,
  latencyP95,
  selectedUnitId,
  onSelectUnit,
}: FanoutGridProps) {
  const tier =
    sandboxes.length <= CARD_TIER_MAX ? "cards" : sandboxes.length <= GRID_TIER_MAX ? "grid" : "swarm"

  return (
    <section className="overflow-hidden rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[var(--elev-1)]">
      <SummaryStrip summary={summary} />

      <div className="relative">
        <div aria-hidden className="instrument-grid pointer-events-none absolute inset-0" />
        <div className="relative">
          {sandboxes.length === 0 ? (
            <p className="text-body-sm px-4 py-16 text-center text-[var(--fg-tertiary)]">
              No sandboxes yet. Units appear here the moment the first variant starts provisioning.
            </p>
          ) : tier === "cards" ? (
            <CardTier
              sandboxes={sandboxes}
              logTails={logTails}
              selectedUnitId={selectedUnitId}
              onSelectUnit={onSelectUnit}
            />
          ) : tier === "grid" ? (
            <GridTier
              sandboxes={sandboxes}
              selectedUnitId={selectedUnitId}
              onSelectUnit={onSelectUnit}
            />
          ) : (
            <SwarmTier
              sandboxes={sandboxes}
              latencyP95={latencyP95}
              selectedUnitId={selectedUnitId}
              onSelectUnit={onSelectUnit}
            />
          )}
        </div>
      </div>
    </section>
  )
}
