import * as React from "react"

import { cn } from "@/lib/utils"
import {
  CLASSIFICATION_META,
  CLASSIFICATION_ORDER,
  isClassification,
  type Classification,
} from "@/lib/variants"

/**
 * Per-classification fill.
 *
 * Tone alone is not enough for a stacked bar: three classifications share the
 * "fail" tone and painting them identically would hide *which kind* of failure a
 * run produced. Each tone is therefore stepped by severity — the worst news gets
 * the full-strength hue and the milder cases are mixed back toward the surface —
 * and the legend always carries the name, so the bar is never read by colour
 * alone. `stable` is deliberately the quietest thing on screen: it is usually
 * most of the width and it is the one segment nobody needs to act on.
 */
export const CLASSIFICATION_COLOR: Record<Classification, string> = {
  regression: "var(--status-fail)",
  hotfix_induced: "color-mix(in srgb, var(--status-fail) 68%, var(--bg-surface))",
  still_broken: "color-mix(in srgb, var(--status-fail) 42%, var(--bg-surface))",
  pre_existing: "var(--fg-tertiary)",
  self_healed: "var(--status-flaky)",
  restored: "var(--status-pass)",
  fixed: "color-mix(in srgb, var(--status-pass) 60%, var(--bg-surface))",
  stable: "color-mix(in srgb, var(--status-pass) 24%, var(--bg-surface))",
}

export interface ClassificationCount {
  classification: Classification
  count: number
}

/**
 * Normalises an arbitrary counts map — the control plane's `RunSummary.counts`
 * or the `verdict_counts` column — into severity order, worst first. Keys the
 * shared vocabulary does not know are dropped rather than guessed at.
 */
export function orderedClassificationCounts(
  counts: Readonly<Record<string, number>>,
): ClassificationCount[] {
  const result: ClassificationCount[] = []
  for (const classification of CLASSIFICATION_ORDER) {
    const value = counts[classification]
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      result.push({ classification, count: value })
    }
  }
  return result
}

/** Total across the keys the vocabulary recognises. */
export function classificationTotal(counts: Readonly<Record<string, number>>): number {
  let total = 0
  for (const [key, value] of Object.entries(counts)) {
    if (isClassification(key) && Number.isFinite(value)) total += value
  }
  return total
}

const TRACK_HEIGHT = { sm: "h-1", md: "h-1.5", lg: "h-2" } as const

export interface ClassificationBarProps extends Omit<React.ComponentProps<"div">, "children"> {
  /** Counts keyed by classification. Unknown keys are ignored. */
  counts: Readonly<Record<string, number>>
  size?: keyof typeof TRACK_HEIGHT
  /** The legend is what makes the bar readable without colour. Drop it only
   *  where the same legend is already on screen. */
  legend?: boolean
  /** Copy for the zero state, e.g. "No verdicts yet". */
  emptyLabel?: string
}

/**
 * The verdict distribution for one run (or one window of runs), worst-first.
 *
 * Every non-zero segment keeps a 3px floor: a single regression among four
 * hundred stable probes is the whole point of the product and must not round
 * away to nothing.
 */
export function ClassificationBar({
  counts,
  size = "md",
  legend = true,
  emptyLabel = "No verdicts yet",
  className,
  ...props
}: ClassificationBarProps) {
  const segments = orderedClassificationCounts(counts)
  const total = segments.reduce((sum, segment) => sum + segment.count, 0)

  const summary = segments
    .map(({ classification, count }) => `${count} ${CLASSIFICATION_META[classification].label}`)
    .join(", ")

  return (
    <div data-slot="classification-bar" className={cn("flex flex-col gap-2", className)} {...props}>
      <div
        role="img"
        aria-label={total === 0 ? emptyLabel : `${total} probes: ${summary}`}
        className={cn(
          "flex w-full gap-px overflow-hidden rounded-[2px] bg-[var(--bg-inset)]",
          TRACK_HEIGHT[size],
        )}
      >
        {segments.map(({ classification, count }) => {
          const meta = CLASSIFICATION_META[classification]
          return (
            <span
              key={classification}
              title={`${count} ${meta.label} — ${meta.blurb}`}
              style={{
                flexGrow: count,
                flexShrink: 1,
                flexBasis: 0,
                minWidth: "3px",
                backgroundColor: CLASSIFICATION_COLOR[classification],
              }}
            />
          )
        })}
      </div>

      {legend ? (
        total === 0 ? (
          <p className="text-caption text-[var(--fg-quaternary)]">{emptyLabel}</p>
        ) : (
          <ul className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
            {segments.map(({ classification, count }) => {
              const meta = CLASSIFICATION_META[classification]
              return (
                <li
                  key={classification}
                  title={meta.blurb}
                  className="flex items-center gap-1.5 whitespace-nowrap"
                >
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: CLASSIFICATION_COLOR[classification] }}
                  />
                  <span
                    className="mono text-[12px] font-medium leading-none text-[var(--fg-primary)]"
                    data-numeric
                  >
                    {count}
                  </span>
                  <span
                    className={cn(
                      "text-[12px] leading-none",
                      classification === "stable"
                        ? "text-[var(--fg-quaternary)]"
                        : "text-[var(--fg-secondary)]",
                    )}
                  >
                    {meta.label}
                  </span>
                </li>
              )
            })}
          </ul>
        )
      ) : null}
    </div>
  )
}
