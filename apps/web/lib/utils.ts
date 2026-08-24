/**
 * Small formatting primitives shared by every surface.
 *
 * Everything that returns a number-bearing string is written to be rendered in
 * a tabular-figures container (`.mono` / `[data-numeric]`); durations and costs
 * tick during a live run and rows visibly jitter otherwise.
 */

import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/* ---------------------------------------------------------------------------
 * Durations
 * ------------------------------------------------------------------------ */

/**
 * Human duration from milliseconds.
 *
 * Widths are held stable within a magnitude (`1m 04s`, not `1m 4s`) so a column
 * of durations does not reflow as a run progresses.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`

  const totalSeconds = ms / 1000
  if (totalSeconds < 60) {
    // One decimal below a minute: sandbox cold starts live in the 2–9s band and
    // rounding them to whole seconds hides real differences between variants.
    return `${totalSeconds.toFixed(1)}s`
  }

  const totalMinutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  if (totalMinutes < 60) return `${totalMinutes}m ${String(seconds).padStart(2, "0")}s`

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}h ${String(minutes).padStart(2, "0")}m`
}

/** Seconds convenience for the control plane, which reports seconds not ms. */
export function formatSeconds(seconds: number): string {
  return formatDuration(seconds * 1000)
}

/* ---------------------------------------------------------------------------
 * Money
 * ------------------------------------------------------------------------ */

/**
 * USD, with enough precision to be honest about sub-cent amounts.
 *
 * A single probe run costs fractions of a cent, so rounding to two decimals
 * below a dollar would render most of the ledger as "$0.00".
 */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "—"
  if (n === 0) return "$0.00"

  const abs = Math.abs(n)
  const fractionDigits = abs < 1 ? 4 : 2
  const formatted = abs.toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })
  return `${n < 0 ? "-" : ""}$${formatted}`
}

/** Whole-dollar price for pricing tables, where cents are noise. */
export function formatUsdCompact(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`
}

/* ---------------------------------------------------------------------------
 * Time
 * ------------------------------------------------------------------------ */

type DateInput = Date | string | number

function toDate(value: DateInput): Date | null {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const RELATIVE_STEPS: readonly [limitSeconds: number, divisor: number, suffix: string][] = [
  [60, 1, "s"],
  [3600, 60, "m"],
  [86_400, 3600, "h"],
  [604_800, 86_400, "d"],
  [2_629_800, 604_800, "w"],
]

/**
 * Compact relative time: "4m ago", "3d ago", "just now".
 *
 * Pair with {@link absoluteTime} on the element's `title` — the compact form is
 * unambiguous only while the reader knows roughly when "now" is.
 */
export function formatRelativeTime(value: DateInput, now: DateInput = Date.now()): string {
  const date = toDate(value)
  const reference = toDate(now)
  if (!date || !reference) return "—"

  const deltaSeconds = (reference.getTime() - date.getTime()) / 1000
  const future = deltaSeconds < 0
  const magnitude = Math.abs(deltaSeconds)

  if (magnitude < 5) return "just now"

  for (const [limit, divisor, suffix] of RELATIVE_STEPS) {
    if (magnitude < limit) {
      const amount = Math.floor(magnitude / divisor)
      return future ? `in ${amount}${suffix}` : `${amount}${suffix} ago`
    }
  }

  const months = Math.floor(magnitude / 2_629_800)
  if (months < 12) return future ? `in ${months}mo` : `${months}mo ago`
  const years = Math.floor(magnitude / 31_557_600)
  return future ? `in ${years}y` : `${years}y ago`
}

/** The absolute rendering that belongs on a `title` next to a relative one. */
export function absoluteTime(value: DateInput): string {
  const date = toDate(value)
  if (!date) return "—"
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  })
}

/** `dateTime` attribute value for a `<time>` element. */
export function isoTime(value: DateInput): string | undefined {
  return toDate(value)?.toISOString()
}

/* ---------------------------------------------------------------------------
 * Git
 * ------------------------------------------------------------------------ */

/**
 * Seven-character commit sha.
 *
 * Accepts either a bare sha or the `REF@SHA` form revisions are stored in, so
 * callers holding a `run.baselineRevision` do not each re-implement the split.
 */
export function shortSha(sha: string): string {
  const candidate = sha.includes("@") ? sha.slice(sha.lastIndexOf("@") + 1) : sha
  return candidate.trim().toLowerCase().slice(0, 7)
}

/** The ref half of a `REF@SHA` revision, or the whole string if unpinned. */
export function revisionRef(revision: string): string {
  const at = revision.lastIndexOf("@")
  return at === -1 ? revision : revision.slice(0, at)
}

/* ---------------------------------------------------------------------------
 * Language
 * ------------------------------------------------------------------------ */

/**
 * The correctly inflected noun for a count — the noun only.
 *
 * The count itself is deliberately not interpolated: counts render inside a
 * tabular-figures span and the word does not, so joining them into one string
 * would drag the noun into mono.
 */
export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`)
}
