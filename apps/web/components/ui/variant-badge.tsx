import * as React from "react"

import { cn } from "@/lib/utils"

/** Mirrors Variant in services/control-plane/sandman/models.py. */
export type VariantKey = "baseline" | "initial" | "hotfix"

/**
 * The order is part of the encoding, not a default. Every surface that shows
 * more than one variant iterates this constant so B → I → H never varies.
 */
export const VARIANT_ORDER = ["baseline", "initial", "hotfix"] as const satisfies readonly VariantKey[]

export interface VariantMeta {
  glyph: string
  label: string
  description: string
  color: string
  wash: string
  border: string
}

export const VARIANT_META: Record<VariantKey, VariantMeta> = {
  baseline: {
    glyph: "B",
    label: "Baseline",
    description: "Previous LKG",
    color: "var(--variant-baseline)",
    wash: "var(--variant-baseline-wash)",
    border: "var(--variant-baseline-border)",
  },
  initial: {
    glyph: "I",
    label: "Initial",
    description: "Current LKG",
    color: "var(--variant-initial)",
    wash: "var(--variant-initial-wash)",
    border: "var(--variant-initial-border)",
  },
  hotfix: {
    glyph: "H",
    label: "Hotfix",
    description: "Current LKG + patch",
    color: "var(--variant-hotfix)",
    wash: "var(--variant-hotfix-wash)",
    border: "var(--variant-hotfix-border)",
  },
}

export interface VariantBadgeProps extends Omit<React.ComponentProps<"span">, "children"> {
  variant: VariantKey
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

const OUTCOME_TOKENS: Record<"pass" | "fail" | "absent", { mark: string; fg: string; bg: string; border: string; word: string }> = {
  pass: {
    mark: "✓",
    fg: "var(--status-pass)",
    bg: "var(--status-pass-wash)",
    border: "rgb(63 214 140 / 0.28)",
    word: "pass",
  },
  fail: {
    mark: "✕",
    fg: "var(--status-fail)",
    bg: "var(--status-fail-wash)",
    border: "rgb(255 95 109 / 0.28)",
    word: "fail",
  },
  absent: {
    mark: "–",
    fg: "var(--fg-quaternary)",
    bg: "transparent",
    border: "var(--border-hairline)",
    word: "not run",
  },
}

function outcomeKey(outcome: VariantOutcome): "pass" | "fail" | "absent" {
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
 * (in the triad colour) with the outcome mark (in the status colour), so both
 * axes survive without colour: glyph identifies the lane, mark shape identifies
 * the result, and position is always B → I → H.
 */
export function VariantTriple({
  baseline,
  initial,
  hotfix,
  className,
  ...props
}: VariantTripleProps) {
  const outcomes: Record<VariantKey, VariantOutcome> = { baseline, initial, hotfix }
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
            style={{ backgroundColor: token.bg, borderColor: token.border }}
          >
            <span className="mono text-[9.5px] font-medium leading-none" style={{ color: meta.color }}>
              {meta.glyph}
            </span>
            <span className="mono text-[10px] font-medium leading-none" style={{ color: token.fg }}>
              {token.mark}
            </span>
          </span>
        )
      })}
    </span>
  )
}
