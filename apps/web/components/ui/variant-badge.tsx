import * as React from "react"

import { cn } from "@/lib/utils"
import { STATUS_META, VARIANT_META, VARIANT_ORDER, type Variant } from "@/lib/variants"

export type { Variant }

export interface VariantBadgeProps extends Omit<React.ComponentProps<"span">, "children"> {
  variant: Variant
  showLabel?: boolean
}

/**
 * One variant, carrying all three redundant channels: the triad colour, the
 * fixed mono glyph, and — via VARIANT_ORDER at the call site — a fixed position.
 * Colour alone is never sufficient; a deuteranope reads the glyph.
 */
export function VariantBadge({
  variant,
  showLabel = true,
  className,
  ...props
}: VariantBadgeProps) {
  const meta = VARIANT_META[variant]
  return (
    <span
      data-slot="variant-badge"
      data-variant={variant}
      className={cn("inline-flex shrink-0 items-center gap-2", className)}
      {...props}
    >
      <span
        aria-hidden
        className="mono grid h-5 w-5 place-items-center rounded-[4px] border text-[11px] font-medium leading-none"
        style={{ color: meta.color, backgroundColor: meta.wash, borderColor: meta.border }}
      >
        {meta.glyph}
      </span>
      {showLabel ? (
        <span className="text-[12.5px] font-medium tracking-[-0.005em] text-[var(--fg-secondary)]">
          {meta.label}
        </span>
      ) : (
        <span className="sr-only">{meta.label}</span>
      )}
    </span>
  )
}

/** `null` means the lane did not run — a hotfix that was never authored. */
export type VariantOutcome = boolean | null

type OutcomeKey = "pass" | "fail" | "absent"

const OUTCOME_TOKENS: Record<OutcomeKey, { mark: string; color: string; wash: string; word: string }> = {
  pass: {
    mark: "✓",
    color: STATUS_META.passed.color,
    wash: STATUS_META.passed.wash,
    word: "pass",
  },
  fail: {
    mark: "✕",
    color: STATUS_META.failed.color,
    wash: STATUS_META.failed.wash,
    word: "fail",
  },
  absent: {
    mark: "–",
    color: "var(--fg-quaternary)",
    wash: "transparent",
    word: "not run",
  },
}

function outcomeKey(outcome: VariantOutcome): OutcomeKey {
  if (outcome === null) return "absent"
  return outcome ? "pass" : "fail"
}

export interface VariantTripleProps extends Omit<React.ComponentProps<"span">, "children"> {
  baseline: VariantOutcome
  initial: VariantOutcome
  hotfix: VariantOutcome
}

/**
 * The mini-matrix behind every classification. Each cell pairs the variant glyph
 * (in the triad colour) with the outcome mark (in the status colour), so neither
 * axis depends on colour: the glyph names the lane, the mark's shape names the
 * result, and the position is always B → I → H.
 */
export function VariantTriple({
  baseline,
  initial,
  hotfix,
  className,
  ...props
}: VariantTripleProps) {
  const outcomes: Record<Variant, VariantOutcome> = { baseline, initial, hotfix }
  const description = VARIANT_ORDER.map(
    (key) => `${VARIANT_META[key].label} ${OUTCOME_TOKENS[outcomeKey(outcomes[key])].word}`,
  ).join(", ")

  return (
    <span
      data-slot="variant-triple"
      role="img"
      aria-label={description}
      className={cn("inline-flex shrink-0 items-center gap-[3px]", className)}
      {...props}
    >
      {VARIANT_ORDER.map((key) => {
        const meta = VARIANT_META[key]
        const token = OUTCOME_TOKENS[outcomeKey(outcomes[key])]
        return (
          <span
            key={key}
            aria-hidden
            data-variant={key}
            className="flex h-5 w-[26px] items-center justify-center gap-[3px] rounded-[4px] border"
            style={{
              backgroundColor: token.wash,
              borderColor: `color-mix(in srgb, ${token.color} 28%, transparent)`,
            }}
          >
            <span
              className="mono text-[9.5px] font-medium leading-none"
              style={{ color: meta.color }}
            >
              {meta.glyph}
            </span>
            <span className="mono text-[10px] font-medium leading-none" style={{ color: token.color }}>
              {token.mark}
            </span>
          </span>
        )
      })}
    </span>
  )
}
