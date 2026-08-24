import * as React from "react"
import Link from "next/link"
import { and, desc, eq, gte, ilike, isNotNull, like, notInArray, or, sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"

import { ControlPlaneError, listRuns, type RunListEntry } from "@/lib/control-plane"
import { db, organization, run, session, type Run } from "@/lib/db"
import { cn, revisionRef } from "@/lib/utils"
import { RUN_STATE_META, isRunState, type RunState } from "@/lib/variants"
import { Card } from "@/components/ui/card"
import {
  RUN_FILTER_INPUT_ID,
  RunFilterBar,
  RunTable,
  isRunRangeFilter,
  isRunStatusFilter,
  type RunRangeFilter,
  type RunRow,
  type RunStatusFilter,
} from "@/components/runs/run-table"

/** Filters are read from the URL on every request; nothing here is cacheable. */
export const dynamic = "force-dynamic"

/** Deep history belongs on a dedicated report, not on a list a human scans. */
const ROW_LIMIT = 200

const CONTROL_PLANE_URL = process.env.SANDMAN_CONTROL_PLANE_URL ?? "http://127.0.0.1:8000"

const RANGE_DAYS: Record<RunRangeFilter, number | null> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
}

/** Everything outside this set means the run is still doing work. */
const TERMINAL_STATES: string[] = ["completed", "failed", "aborted"]

/* ---------------------------------------------------------------------------
 * Loading
 * ------------------------------------------------------------------------ */

/**
 * See the note on the same helper in the dashboard: `lib/auth` is not wired up
 * yet, so the active workspace comes from the newest unexpired session row. The
 * user id it returns is what the "Mine" filter matches on.
 */
async function resolveWorkspace(): Promise<{ organizationId: string; userId: string | null } | null> {
  const [live] = await db
    .select({ userId: session.userId, organizationId: session.activeOrganizationId })
    .from(session)
    .where(gte(session.expiresAt, new Date()))
    .orderBy(desc(session.updatedAt))
    .limit(1)

  if (live?.organizationId) {
    return { organizationId: live.organizationId, userId: live.userId }
  }

  const [org] = await db
    .select({ id: organization.id })
    .from(organization)
    .orderBy(organization.createdAt)
    .limit(1)

  return org ? { organizationId: org.id, userId: live?.userId ?? null } : null
}

async function loadLiveRuns(): Promise<{
  byId: Map<string, RunListEntry>
  error: ControlPlaneError | null
}> {
  try {
    const response = await listRuns()
    return { byId: new Map(response.runs.map((entry) => [entry.runId, entry])), error: null }
  } catch (cause) {
    if (cause instanceof ControlPlaneError) return { byId: new Map(), error: cause }
    throw cause
  }
}

/** `%` and `_` are LIKE wildcards and both are legal in a git ref. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

function toRunRow(row: Run, live: RunListEntry | undefined): RunRow {
  const liveState = live && isRunState(live.state) ? live.state : null
  const state: RunState = liveState ?? (isRunState(row.state) ? row.state : "queued")
  const started = row.startedAt ?? (row.state === "queued" ? null : row.createdAt)
  const terminal = RUN_STATE_META[state].terminal

  return {
    id: row.id,
    state,
    safeToPromote: row.safeToPromote,
    trigger: row.trigger,
    revision: row.initialRevision,
    lanes: {
      baseline: row.baselineRevision !== null,
      initial: row.initialRevision !== null,
      hotfix: row.hotfixRevision !== null,
    },
    passed: row.passedCount,
    failed: row.failedCount,
    flaky: row.flakyCount,
    probeCount: row.probeCount,
    durationMs: row.finishedAt && started ? row.finishedAt.getTime() - started.getTime() : null,
    usdSpent: live && !terminal ? live.usdSpent : row.usdSpent,
    startedAt: started ? started.toISOString() : null,
    live: live !== undefined,
  }
}

/* ---------------------------------------------------------------------------
 * Notices
 * ------------------------------------------------------------------------ */

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-[4px] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[12.5px] text-[var(--fg-secondary)]">
      {children}
    </code>
  )
}

function Notice({
  tone = "neutral",
  title,
  children,
}: {
  tone?: "neutral" | "fail"
  title: string
  children: React.ReactNode
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col gap-1 rounded-[8px] border px-4 py-3",
        tone === "fail"
          ? "border-[rgb(255_95_109_/_0.28)] bg-[var(--status-fail-wash)]"
          : "border-[var(--border-subtle)] bg-[var(--bg-surface)]",
      )}
    >
      <p
        className={cn(
          "text-label",
          tone === "fail" ? "text-[var(--status-fail)]" : "text-[var(--fg-primary)]",
        )}
      >
        {title}
      </p>
      <p className="text-body-sm text-[var(--fg-tertiary)]">{children}</p>
    </div>
  )
}

function ControlPlaneNotice({ error }: { error: ControlPlaneError }) {
  if (error.isUnreachable) {
    return (
      <Notice title="Control plane unreachable">
        Nothing answered at <Code>{CONTROL_PLANE_URL}</Code>, so in-flight runs are shown from the
        last state written to Postgres. Start it with <Code>uv run sandman serve</Code>.
      </Notice>
    )
  }
  return (
    <Notice tone="fail" title="Control plane returned an error">
      <Code>{CONTROL_PLANE_URL}</Code> answered {error.status} for <Code>{error.path}</Code>
      {error.detail ? ` — ${error.detail}` : ""}.
    </Notice>
  )
}

/* ---------------------------------------------------------------------------
 * Page
 * ------------------------------------------------------------------------ */

type SearchParams = Promise<Record<string, string | string[] | undefined>>

function readParam(params: Record<string, string | string[] | undefined>, key: string): string {
  const value = params[key]
  if (Array.isArray(value)) return value[0] ?? ""
  return value ?? ""
}

const EMPTY_COPY: Record<RunStatusFilter, { title: string; description: string }> = {
  all: {
    title: "No runs match",
    description: "Widen the date range or clear the branch filter to see more history.",
  },
  running: {
    title: "Nothing in flight",
    description: "No run is currently provisioning, probing, remediating, or verifying.",
  },
  failed: {
    title: "No failed runs",
    description:
      "Nothing in this window errored out or finished blocked by the promotion gate.",
  },
  mine: {
    title: "No runs of yours here",
    description: "Runs you triggered will appear here once one lands in this window.",
  },
}

export default async function RunsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const renderedAt = new Date().toISOString()

  const statusParam = readParam(params, "status")
  const status: RunStatusFilter = isRunStatusFilter(statusParam) ? statusParam : "all"
  const rangeParam = readParam(params, "range")
  const range: RunRangeFilter = isRunRangeFilter(rangeParam) ? rangeParam : "30d"
  const branch = readParam(params, "branch")
  const query = readParam(params, "q").trim()

  const [workspaceResult, liveRuns] = await Promise.all([
    resolveWorkspace().then(
      (workspace) => ({ ok: true as const, workspace }),
      (cause: unknown) => ({
        ok: false as const,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    ),
    loadLiveRuns(),
  ])

  if (!workspaceResult.ok) {
    return (
      <div className="flex flex-col gap-4">
        <Notice tone="fail" title="Cannot read the run history">
          {workspaceResult.message}
        </Notice>
        {liveRuns.error ? <ControlPlaneNotice error={liveRuns.error} /> : null}
      </div>
    )
  }

  const workspace = workspaceResult.workspace
  if (!workspace) {
    return (
      <div className="flex flex-col gap-4">
        <Notice title="No organisation yet">
          Connect a GitHub repository from{" "}
          <Link href="/settings/repo" className="text-[var(--accent-400)]">
            Settings → Repo
          </Link>{" "}
          to start recording runs.
        </Notice>
        {liveRuns.error ? <ControlPlaneNotice error={liveRuns.error} /> : null}
      </div>
    )
  }

  const conditions: SQL[] = [eq(run.organizationId, workspace.organizationId)]

  const rangeDays = RANGE_DAYS[range]
  if (rangeDays !== null) {
    conditions.push(gte(run.createdAt, new Date(Date.now() - rangeDays * 86_400_000)))
  }

  if (status === "running") {
    conditions.push(notInArray(run.state, TERMINAL_STATES))
  } else if (status === "failed") {
    // "Failed" covers both halves of a bad outcome: the run itself erroring, and
    // a run that completed but is blocked from promotion.
    const failed = or(
      eq(run.state, "failed"),
      and(eq(run.state, "completed"), eq(run.safeToPromote, false)),
    )
    if (failed) conditions.push(failed)
  } else if (status === "mine") {
    conditions.push(
      workspace.userId ? eq(run.triggeredBy, workspace.userId) : sql`false`,
    )
  }

  if (branch) {
    conditions.push(like(run.initialRevision, `${escapeLike(branch)}@%`))
  }

  if (query) {
    const pattern = `%${escapeLike(query)}%`
    const matches = or(ilike(run.id, pattern), ilike(run.initialRevision, pattern))
    if (matches) conditions.push(matches)
  }

  const [rows, branchRows] = await Promise.all([
    db
      .select()
      .from(run)
      .where(and(...conditions))
      .orderBy(desc(run.createdAt))
      .limit(ROW_LIMIT),

    db
      .selectDistinct({ revision: run.initialRevision })
      .from(run)
      .where(and(eq(run.organizationId, workspace.organizationId), isNotNull(run.initialRevision))),
  ])

  const branches = [
    ...new Set(
      branchRows
        .map((row) => (row.revision === null ? null : revisionRef(row.revision)))
        .filter((ref): ref is string => ref !== null && ref !== ""),
    ),
  ].sort((a, b) => a.localeCompare(b))

  const runRows = rows.map((row) => toRunRow(row, liveRuns.byId.get(row.id)))
  const filtered = status !== "all" || branch !== "" || query !== "" || range !== "30d"
  const empty = filtered
    ? EMPTY_COPY[status]
    : {
        title: "No runs yet",
        description:
          "Start an investigation and every probe across the three sandbox lanes lands here.",
      }

  return (
    <div className="flex flex-col gap-4">
      {liveRuns.error ? <ControlPlaneNotice error={liveRuns.error} /> : null}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <React.Suspense fallback={<div className="h-8" />}>
          <RunFilterBar branches={branches} />
        </React.Suspense>

        <p className="text-caption shrink-0 text-[var(--fg-tertiary)]">
          <span className="mono text-[var(--fg-secondary)]" data-numeric>
            {runRows.length}
          </span>
          {runRows.length === ROW_LIMIT ? ` of the most recent ${ROW_LIMIT} runs` : " runs"}
        </p>
      </div>

      <Card className="overflow-hidden">
        <RunTable
          rows={runRows}
          now={renderedAt}
          filterInputId={RUN_FILTER_INPUT_ID}
          emptyTitle={empty.title}
          emptyDescription={empty.description}
        />
      </Card>
    </div>
  )
}
