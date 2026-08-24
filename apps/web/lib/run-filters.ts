/**
 * Run-list filter vocabulary.
 *
 * These live outside the filter bar component because the run list page is a
 * Server Component that reads the filters off the URL, and a `"use client"`
 * module cannot export a plain function to the server -- React turns it into a
 * reference, and calling it throws. Types and pure guards belong on the shared
 * side of that boundary; only the interactive bar itself is client code.
 */

export const RUN_STATUS_FILTERS = ["all", "running", "failed", "mine"] as const
export type RunStatusFilter = (typeof RUN_STATUS_FILTERS)[number]

export const RUN_RANGE_FILTERS = ["24h", "7d", "30d", "90d", "all"] as const
export type RunRangeFilter = (typeof RUN_RANGE_FILTERS)[number]

/** Single filter bar per page, so the `/` shortcut target can be a constant. */
export const RUN_FILTER_INPUT_ID = "sandman-run-filter"

export const RUN_RANGE_LABELS: Record<RunRangeFilter, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
}

export function isRunStatusFilter(value: string): value is RunStatusFilter {
  return (RUN_STATUS_FILTERS as readonly string[]).includes(value)
}

export function isRunRangeFilter(value: string): value is RunRangeFilter {
  return (RUN_RANGE_FILTERS as readonly string[]).includes(value)
}
