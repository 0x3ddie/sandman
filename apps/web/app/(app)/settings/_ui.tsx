/**
 * Settings primitives.
 *
 * No "use client": every export here is markup and tokens only, so the same
 * component renders inside a Server Component page header and inside the client
 * form beneath it without a second implementation.
 */

import * as React from "react"

import { cn } from "@/lib/utils"

/* ---------------------------------------------------------------------------
 * Page furniture
 * ------------------------------------------------------------------------ */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description: string
  actions?: React.ReactNode
}) {
  return (
    <header className="mb-6 flex items-start justify-between gap-6">
      <div className="min-w-0">
        <h2 className="text-h3 text-[var(--fg-primary)]">{title}</h2>
        <p className="text-body-sm mt-1 max-w-[68ch] text-[var(--fg-tertiary)]">{description}</p>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}

/** The 10px panel radius, one rung up the ladder from the page. */
export function Panel({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-surface)]",
        "shadow-[var(--elev-1)]",
        className,
      )}
      {...props}
    />
  )
}

export function PanelHeader({
  title,
  description,
  aside,
  accent,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  aside?: React.ReactNode
  /** Left rule in a variant colour, for the B / I / H cards. */
  accent?: string
}) {
  return (
    <div
      className="flex items-start justify-between gap-4 border-b border-[var(--border-hairline)] px-5 py-4"
      style={accent ? { boxShadow: `inset 3px 0 0 0 ${accent}` } : undefined}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">{title}</div>
        {description ? (
          <p className="text-body-sm mt-1 max-w-[60ch] text-[var(--fg-tertiary)]">{description}</p>
        ) : null}
      </div>
      {aside ? <div className="flex shrink-0 items-center gap-2">{aside}</div> : null}
    </div>
  )
}

export function PanelBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-4 px-5 py-4", className)} {...props} />
}

export function PanelFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border-t border-[var(--border-hairline)] px-5 py-3",
        className,
      )}
      {...props}
    />
  )
}

/* ---------------------------------------------------------------------------
 * Fields
 * ------------------------------------------------------------------------ */

export interface FieldProps {
  label: string
  htmlFor?: string
  hint?: React.ReactNode
  children: React.ReactNode
  /**
   * Marks the field as deviating from INITIAL. The rule is drawn in the
   * variant's own colour and paired with the word "override", because colour
   * alone never carries meaning in this product.
   */
  override?: { color: string; label?: string }
  className?: string
}

export function Field({ label, htmlFor, hint, children, override, className }: FieldProps) {
  return (
    <div
      data-override={override ? "" : undefined}
      className={cn("flex flex-col gap-1.5", override && "-ml-3 pl-3", className)}
      style={override ? { boxShadow: `inset 2px 0 0 0 ${override.color}` } : undefined}
    >
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor} className="text-label text-[var(--fg-secondary)]">
          {label}
        </label>
        {override ? (
          <span
            className="text-eyebrow shrink-0 text-[10px]"
            style={{ color: override.color }}
          >
            {override.label ?? "override"}
          </span>
        ) : null}
      </div>
      {children}
      {hint ? <p className="text-caption text-[var(--fg-tertiary)]">{hint}</p> : null}
    </div>
  )
}

const CONTROL_BASE = [
  "w-full rounded-[6px] border border-[var(--border-default)] bg-[var(--bg-raised)]",
  "px-2.5 text-[13.5px] leading-[1.4] text-[var(--fg-primary)]",
  "transition-[border-color,background-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]",
  "placeholder:text-[var(--fg-quaternary)]",
  "hover:border-[var(--border-strong)]",
  "disabled:cursor-not-allowed disabled:opacity-45",
]

export function TextInput({ className, ...props }: React.ComponentProps<"input">) {
  return <input className={cn(CONTROL_BASE, "h-8", className)} {...props} />
}

/** Right-aligned tabular figures; a jittering number column is unreadable. */
export function NumberInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type="number"
      inputMode="decimal"
      data-numeric=""
      className={cn(CONTROL_BASE, "mono h-8 text-right text-[13px]", className)}
      {...props}
    />
  )
}

/** Mono by default: everything typed into one of these is a shell command. */
export function TextArea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      spellCheck={false}
      className={cn(
        CONTROL_BASE,
        "mono no-grain min-h-[76px] resize-y bg-[var(--bg-inset)] py-2 text-[12.5px] leading-[1.55]",
        className,
      )}
      {...props}
    />
  )
}

export function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <div className="relative">
      <select
        className={cn(
          CONTROL_BASE,
          "h-8 appearance-none pr-7",
          // The native select paints its own option list on the OS surface; only
          // the closed control is ours to style.
          "[&>option]:bg-[var(--bg-overlay)] [&>option]:text-[var(--fg-primary)]",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <span
        aria-hidden
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-[var(--fg-tertiary)]"
      >
        ▾
      </span>
    </div>
  )
}

/* ---------------------------------------------------------------------------
 * Callouts and chips
 * ------------------------------------------------------------------------ */

export type CalloutTone = "info" | "caution" | "danger" | "positive"

/**
 * Note the absence of amber. Amber is this product's accent and means "running";
 * a warning drawn in amber would be read as a live run by anyone who has used
 * the run page. Cautions borrow the flaky violet instead.
 */
const CALLOUT_TONES: Record<CalloutTone, { color: string; wash: string; glyph: string }> = {
  info: { color: "var(--variant-initial)", wash: "var(--variant-initial-wash)", glyph: "i" },
  caution: { color: "var(--status-flaky)", wash: "var(--status-flaky-wash)", glyph: "!" },
  danger: { color: "var(--status-fail)", wash: "var(--status-fail-wash)", glyph: "!" },
  positive: { color: "var(--status-pass)", wash: "var(--status-pass-wash)", glyph: "✓" },
}

export function Callout({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: CalloutTone
  title?: string
  children: React.ReactNode
  className?: string
}) {
  const token = CALLOUT_TONES[tone]
  return (
    <div
      role="note"
      className={cn("flex gap-2.5 rounded-[8px] border p-3", className)}
      style={{
        borderColor: `color-mix(in srgb, ${token.color} 28%, transparent)`,
        backgroundColor: token.wash,
      }}
    >
      <span
        aria-hidden
        className="mono mt-[1px] grid h-4 w-4 shrink-0 place-items-center rounded-[4px] text-[10px] font-medium leading-none"
        style={{ color: token.color, backgroundColor: `color-mix(in srgb, ${token.color} 18%, transparent)` }}
      >
        {token.glyph}
      </span>
      <div className="min-w-0">
        {title ? (
          <p className="text-label mb-0.5 text-[var(--fg-primary)]">{title}</p>
        ) : null}
        <div className="text-body-sm text-[var(--fg-secondary)]">{children}</div>
      </div>
    </div>
  )
}

export function Chip({
  children,
  color,
  className,
}: {
  children: React.ReactNode
  color?: string
  className?: string
}) {
  const tint = color ?? "var(--fg-tertiary)"
  return (
    <span
      className={cn(
        "text-eyebrow inline-flex h-[20px] shrink-0 items-center rounded-[6px] border px-1.5 text-[10px]",
        className,
      )}
      style={{
        color: tint,
        borderColor: `color-mix(in srgb, ${tint} 26%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${tint} 10%, transparent)`,
      }}
    >
      {children}
    </span>
  )
}

/** Inline monospace for ids, shas, paths, and repository names. */
export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("mono text-[12.5px] text-[var(--fg-primary)]", className)}>{children}</span>
}

export function Divider({ className }: { className?: string }) {
  return <div aria-hidden className={cn("h-px bg-[var(--border-hairline)]", className)} />
}

/** A label/value pair for read-only facts. */
export function DetailRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-caption text-[var(--fg-tertiary)]">{label}</span>
      <span className="min-w-0 text-right text-[13px] text-[var(--fg-secondary)]">{children}</span>
    </div>
  )
}

/* ---------------------------------------------------------------------------
 * Meters
 * ------------------------------------------------------------------------ */

export interface MeterProps {
  value: number
  limit: number
  label: string
  /** Rendered verbatim on the right — already formatted and already mono. */
  readout: React.ReactNode
  /** Fraction at which the bar switches to the caution colour. */
  softThreshold?: number
}

/**
 * A usage bar with a soft-alert threshold.
 *
 * The threshold tick is drawn as a hairline rather than by recolouring the
 * whole bar, so the reader can see *where* the alert sits even while well under
 * it — which is the only way an 80% warning is actionable before it fires.
 */
export function Meter({ value, limit, label, readout, softThreshold = 0.8 }: MeterProps) {
  const ratio = limit > 0 ? value / limit : 0
  const clamped = Math.max(0, Math.min(1, ratio))
  const color =
    ratio >= 1
      ? "var(--status-fail)"
      : ratio >= softThreshold
        ? "var(--status-flaky)"
        : "var(--status-pass)"

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-caption text-[var(--fg-secondary)]">{label}</span>
        <span className="mono text-[12.5px] text-[var(--fg-primary)]" data-numeric="">
          {readout}
        </span>
      </div>
      <div
        role="meter"
        aria-valuenow={Math.round(clamped * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className="relative h-1.5 w-full overflow-hidden rounded-[6px] bg-[var(--bg-inset)]"
      >
        <div
          className="h-full rounded-[6px] transition-[width] duration-[var(--dur-normal)] ease-[var(--ease-out)]"
          style={{ width: `${clamped * 100}%`, backgroundColor: color }}
        />
        {softThreshold > 0 && softThreshold < 1 ? (
          <span
            aria-hidden
            title={`${Math.round(softThreshold * 100)}% alert threshold`}
            className="absolute inset-y-0 w-px bg-[var(--border-strong)]"
            style={{ left: `${softThreshold * 100}%` }}
          />
        ) : null}
      </div>
    </div>
  )
}
