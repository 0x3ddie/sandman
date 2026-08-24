import * as React from "react"
import Link from "next/link"
import { and, count, desc, eq, gte, notExists, sql } from "drizzle-orm"

import { ControlPlaneError, listRuns, type RunListEntry } from "@/lib/control-plane"
import {
  db,
  finding,
  hotfix,
  organization,
  project,
  run,
  session,
  subscription,
  usageCounter,
  verdict,
  type Project,
  type Run,
} from "@/lib/db"
import { limitsFor, overageUsd, planFor } from "@/lib/plans"
import { cn, formatUsd, revisionRef, shortSha } from "@/lib/utils"
import { RUN_STATE_META, isRunState, type RunState, type Variant } from "@/lib/variants"
import { Card } from "@/components/ui/card"
import { VariantBadge } from "@/components/ui/variant-badge"
import { ClassificationBar } from "@/components/runs/classification-bar"
import { RunTable, type RunRow } from "@/components/runs/run-table"

/**
 * The overview is an instrument, not a report: run state, spend and the live
 * lane revisions all change second to second, so nothing here is cached.
 */
export const dynamic = "force-dynamic"

const WINDOW_DAYS = 30
const RECENT_RUN_LIMIT = 8

/** Only ever displayed, never used to build a request — the client is the one
 *  place that talks to the control plane. */
const CONTROL_PLANE_URL = process.env.SANDMAN_CONTROL_PLANE_URL ?? "http://127.0.0.1:8000"

/* ---------------------------------------------------------------------------
 * Loading
 * ------------------------------------------------------------------------ */

interface Workspace {
  organizationId: string
  projectRow: Project | null
  userId: string | null
}

/**
 * The organisation whose data this page shows.
 *
 * Session handling (`lib/auth`) is not wired up yet, so the active workspace is
 * read from the newest unexpired better-auth session row rather than from a
 * request cookie. Replace the first query with `auth.api.getSession()` once that
 * lands; everything downstream already takes the ids as arguments.
 */
async function resolveWorkspace(): Promise<Workspace | null> {
  const [live] = await db
    .select({ userId: session.userId, organizationId: session.activeOrganizationId })
    .from(session)
    .where(gte(session.expiresAt, new Date()))
    .orderBy(desc(session.updatedAt))
    .limit(1)

  const organizations = live?.organizationId
    ? await db.select().from(organization).where(eq(organization.id, live.organizationId)).limit(1)
    : await db.select().from(organization).orderBy(organization.createdAt).limit(1)

  const org = organizations[0]
  if (!org) return null

  const projects = await db
    .select()
    .from(project)
    .where(eq(project.organizationId, org.id))
    .orderBy(project.createdAt)
    .limit(1)

  return { organizationId: org.id, projectRow: projects[0] ?? null, userId: live?.userId ?? null }
}

interface DashboardData extends Workspace {
  runBuckets: { state: string; safeToPromote: boolean; total: number }[]
  openFindings: { severity: string; total: number }[]
  verdictCounts: Record<string, number>
  entitlements: string[]
  sandboxSeconds: number
  cycleUsd: number
  cycleStart: Date | null
  recentRuns: Run[]
}

async function loadDashboard(): Promise<DashboardData | null> {
  const workspace = await resolveWorkspace()
  if (!workspace) return null

  const orgId = workspace.organizationId
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000)

  const [runBuckets, openFindings, verdictRows, subscriptions, usageRows, recentRuns] =
    await Promise.all([
      db
        .select({ state: run.state, safeToPromote: run.safeToPromote, total: count() })
        .from(run)
        .where(and(eq(run.organizationId, orgId), gte(run.createdAt, since)))
        .groupBy(run.state, run.safeToPromote),

      // "Open" means no promoted hotfix closed it. There is no resolved flag on
      // a finding; promotion to LKG is the only event that actually retires one.
      db
        .select({ severity: finding.severity, total: count() })
        .from(finding)
        .innerJoin(run, eq(finding.runId, run.id))
        .where(
          and(
            eq(run.organizationId, orgId),
            notExists(
              db
                .select({ one: sql<number>`1` })
                .from(hotfix)
                .where(
                  and(eq(hotfix.findingId, finding.id), eq(hotfix.promotedToLkg, true)),
                ),
            ),
          ),
        )
        .groupBy(finding.severity),

      db
        .select({ classification: verdict.classification, total: count() })
        .from(verdict)
        .innerJoin(run, eq(verdict.runId, run.id))
        .where(and(eq(run.organizationId, orgId), gte(run.createdAt, since)))
        .groupBy(verdict.classification),

      db
        .select({ entitlements: subscription.entitlements })
        .from(subscription)
        .where(eq(subscription.organizationId, orgId))
        .limit(1),

      db
        .select({
          periodStart: usageCounter.periodStart,
          sandboxSeconds: usageCounter.sandboxSeconds,
          usdSpent: usageCounter.usdSpent,
        })
        .from(usageCounter)
        .where(eq(usageCounter.organizationId, orgId))
        .orderBy(desc(usageCounter.periodStart))
        .limit(1),

      db
        .select()
        .from(run)
        .where(eq(run.organizationId, orgId))
        .orderBy(desc(run.createdAt))
        .limit(RECENT_RUN_LIMIT),
    ])

  const verdictCounts: Record<string, number> = {}
  for (const row of verdictRows) verdictCounts[row.classification] = row.total

  const usage = usageRows[0]

  return {
    ...workspace,
    runBuckets,
    openFindings,
    verdictCounts,
    entitlements: subscriptions[0]?.entitlements ?? [],
    sandboxSeconds: usage?.sandboxSeconds ?? 0,
    cycleUsd: usage?.usdSpent ?? 0,
    cycleStart: usage?.periodStart ?? null,
    recentRuns,
  }
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

/* ---------------------------------------------------------------------------
 * Row mapping
 * ------------------------------------------------------------------------ */

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
    durationMs:
      row.finishedAt && started ? row.finishedAt.getTime() - started.getTime() : null,
    // While a run is in flight the control plane's budget tracker is ahead of
    // whatever was last flushed to Postgres.
    usdSpent: live && !terminal ? live.usdSpent : row.usdSpent,
    startedAt: started ? started.toISOString() : null,
    live: live !== undefined,
  }
}

/* ---------------------------------------------------------------------------
 * Stat tiles
 * ------------------------------------------------------------------------ */

interface TileSegment {
  label: string
  value: number
  color: string
}

function StatTile({
  label,
  value,
  caption,
  segments,
}: {
  label: string
  value: string
  caption: string
  segments: readonly TileSegment[]
}) {
  const present = segments.filter((segment) => segment.value > 0)
  const description = present
    .map((segment) => `${Math.round(segment.value)} ${segment.label}`)
    .join(", ")

  return (
    <Card className="relative overflow-hidden">
      <div className="px-4 pb-5 pt-3.5">
        <p className="text-eyebrow text-[var(--fg-tertiary)]">{label}</p>
        <p className="text-metric mt-3 text-[var(--fg-primary)]">{value}</p>
        <p className="text-caption mt-2 text-[var(--fg-tertiary)]">{caption}</p>
      </div>
      <div
        role="img"
        aria-label={description || "No data in this window"}
        className="absolute inset-x-0 bottom-0 flex h-1 gap-px bg-[var(--bg-inset)]"
      >
        {present.map((segment) => (
          <span
            key={segment.label}
            title={`${Math.round(segment.value)} ${segment.label}`}
            style={{
              flexGrow: segment.value,
              flexShrink: 1,
              flexBasis: 0,
              minWidth: "2px",
              backgroundColor: segment.color,
            }}
          />
        ))}
      </div>
    </Card>
  )
}

const SEVERITY_ORDER: readonly string[] = ["critical", "high", "medium", "low", "info"]

const SEVERITY_COLOR: Record<string, string> = {
  critical: "var(--status-fail)",
  high: "color-mix(in srgb, var(--status-fail) 66%, var(--bg-surface))",
  medium: "var(--status-flaky)",
  low: "var(--fg-tertiary)",
  info: "var(--fg-quaternary)",
}

type RunBucket = "clear" | "blocked" | "running" | "errored" | "aborted"

function runBucketOf(state: string, safeToPromote: boolean): RunBucket {
  if (state === "completed") return safeToPromote ? "clear" : "blocked"
  if (state === "failed") return "errored"
  if (state === "aborted") return "aborted"
  return "running"
}

const RUN_BUCKET_COLOR: Record<RunBucket, string> = {
  clear: "var(--status-pass)",
  blocked: "var(--status-fail)",
  running: "var(--accent-400)",
  errored: "color-mix(in srgb, var(--status-fail) 55%, var(--bg-surface))",
  aborted: "var(--fg-quaternary)",
}

/* ---------------------------------------------------------------------------
 * Notices
 * ------------------------------------------------------------------------ */

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

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-[4px] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[12.5px] text-[var(--fg-secondary)]">
      {children}
    </code>
  )
}

function ControlPlaneNotice({ error }: { error: ControlPlaneError }) {
  if (error.isUnreachable) {
    return (
      <Notice title="Control plane unreachable">
        Nothing answered at <Code>{CONTROL_PLANE_URL}</Code>, so live run state and in-flight
        spend are missing below — stored results are still accurate. Start it with{" "}
        <Code>uv run sandman serve</Code>, or point <Code>SANDMAN_CONTROL_PLANE_URL</Code> at the
        host that is running it.
      </Notice>
    )
  }
  return (
    <Notice tone="fail" title="Control plane returned an error">
      <Code>{CONTROL_PLANE_URL}</Code> answered {error.status} for <Code>{error.path}</Code>
      {error.detail ? ` — ${error.detail}` : ""}. Live run state is unavailable until it recovers.
    </Notice>
  )
}

/* ---------------------------------------------------------------------------
 * Current LKG
 * ------------------------------------------------------------------------ */

function RevisionRow({ variant, revision }: { variant: Variant; revision: string | null }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <VariantBadge variant={variant} className="w-[104px] shrink-0" />
      {revision ? (
        <span className="mono flex min-w-0 items-baseline text-[12.5px]">
          <span className="truncate text-[var(--fg-secondary)]">{revisionRef(revision)}</span>
          <span className="text-[var(--fg-quaternary)]">@</span>
          <span className="text-[var(--fg-primary)]">{shortSha(revision)}</span>
        </span>
      ) : (
        <span className="text-[12.5px] text-[var(--fg-quaternary)]">
          resolves on the next run
        </span>
      )}
    </div>
  )
}

function CurrentLkg({
  projectRow,
  latest,
}: {
  projectRow: Project | null
  latest: Run | undefined
}) {
  const repo = projectRow?.repositoryFullName ?? "No repository connected"
  const branch = projectRow?.lkgBranch ?? "main"
  const baseline = latest?.baselineRevision ?? projectRow?.previousLkgRef ?? null
  const initial = latest?.initialRevision ?? null

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-hairline)] px-5 py-3.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <span className="text-eyebrow text-[var(--fg-tertiary)]">Current LKG</span>
          <span className="mono truncate text-[13px] text-[var(--fg-primary)]">{repo}</span>
          <span
            title="Last known good branch"
            className={cn(
              "mono inline-flex h-[22px] shrink-0 items-center rounded-[6px] px-2",
              "border border-[var(--accent-border)] bg-[var(--accent-wash)]",
              "text-[11px] leading-none text-[var(--accent-300)]",
            )}
          >
            {branch}
          </span>
        </div>
        {latest ? (
          <Link
            href={`/runs/${latest.id}`}
            className="mono text-[12.5px] text-[var(--fg-tertiary)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:text-[var(--accent-400)]"
          >
            {latest.id} →
          </Link>
        ) : null}
      </div>

      <div className="grid gap-6 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3">
          <p className="text-caption text-[var(--fg-tertiary)]">Resolved revisions</p>
          <RevisionRow variant="baseline" revision={baseline} />
          <RevisionRow variant="initial" revision={initial} />
          {projectRow && projectRow.previousLkgMode === "auto" && !baseline ? (
            <p className="text-caption text-[var(--fg-quaternary)]">
              Baseline is unpinned: it resolves to the second-newest merge on {branch} when a run
              starts.
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-3">
          <p className="text-caption text-[var(--fg-tertiary)]">
            {latest ? "Last run verdicts" : "Verdicts"}
          </p>
          <ClassificationBar
            counts={latest?.verdictCounts ?? {}}
            emptyLabel="No run has produced a verdict yet"
          />
        </div>
      </div>
    </Card>
  )
}

/* ---------------------------------------------------------------------------
 * Page
 * ------------------------------------------------------------------------ */

export default async function DashboardPage() {
  const renderedAt = new Date().toISOString()

  const [dashboard, liveRuns] = await Promise.all([
    loadDashboard().then(
      (data) => ({ ok: true as const, data }),
      (cause: unknown) => ({
        ok: false as const,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    ),
    loadLiveRuns(),
  ])

  if (!dashboard.ok) {
    return (
      <div className="flex flex-col gap-4">
        <Notice tone="fail" title="Cannot read the dashboard database">
          {dashboard.message}
        </Notice>
        {liveRuns.error ? <ControlPlaneNotice error={liveRuns.error} /> : null}
      </div>
    )
  }

  if (!dashboard.data) {
    return (
      <div className="flex flex-col gap-4">
        <Notice title="No organisation yet">
          Nothing has been provisioned in this database. Connect a GitHub repository from{" "}
          <Link href="/settings/repo" className="text-[var(--accent-400)]">
            Settings → Repo
          </Link>{" "}
          to create an organisation and its first project.
        </Notice>
        {liveRuns.error ? <ControlPlaneNotice error={liveRuns.error} /> : null}
      </div>
    )
  }

  const data = dashboard.data

  /* -- tile 1: runs in the window --------------------------------------- */
  const bucketTotals = new Map<RunBucket, number>()
  for (const row of data.runBuckets) {
    const bucket = runBucketOf(row.state, row.safeToPromote)
    bucketTotals.set(bucket, (bucketTotals.get(bucket) ?? 0) + row.total)
  }
  const runsTotal = [...bucketTotals.values()].reduce((sum, value) => sum + value, 0)
  const runsCaption = [
    `${bucketTotals.get("clear") ?? 0} clear`,
    `${bucketTotals.get("blocked") ?? 0} blocked`,
    ...((bucketTotals.get("running") ?? 0) > 0
      ? [`${bucketTotals.get("running") ?? 0} in flight`]
      : []),
  ].join(" · ")

  /* -- tile 2: open findings -------------------------------------------- */
  const findingsBySeverity = new Map(data.openFindings.map((row) => [row.severity, row.total]))
  const findingsTotal = data.openFindings.reduce((sum, row) => sum + row.total, 0)
  const urgentFindings =
    (findingsBySeverity.get("critical") ?? 0) + (findingsBySeverity.get("high") ?? 0)
  const knownSeverities = data.openFindings.filter((row) => SEVERITY_ORDER.includes(row.severity))
  const otherSeverities = findingsTotal - knownSeverities.reduce((sum, row) => sum + row.total, 0)

  /* -- tiles 3 and 4: verdict mix --------------------------------------- */
  const counts = data.verdictCounts
  const regressions = counts.regression ?? 0
  const hotfixInduced = counts.hotfix_induced ?? 0
  const stillBroken = counts.still_broken ?? 0
  const preExisting = counts.pre_existing ?? 0
  const verdictTotal = Object.values(counts).reduce((sum, value) => sum + value, 0)
  const blockingTotal = regressions + hotfixInduced + stillBroken
  const preExistingShare = verdictTotal === 0 ? 0 : Math.round((preExisting / verdictTotal) * 100)

  /* -- tile 5: spend ----------------------------------------------------- */
  const plan = planFor(data.entitlements)
  const limits = limitsFor(plan)
  const minutesUsed = data.sandboxSeconds / 60
  const included = limits.includedSandboxMinutes
  const overage = overageUsd(plan, minutesUsed)
  const spendCaption = [
    `${Math.round(minutesUsed).toLocaleString("en-US")} of ${included.toLocaleString("en-US")} sandbox min`,
    plan.displayName,
    ...(overage > 0 ? [`${formatUsd(overage)} overage`] : []),
  ].join(" · ")

  const rows = data.recentRuns.map((row) => toRunRow(row, liveRuns.byId.get(row.id)))

  return (
    <div className="flex flex-col gap-4">
      {liveRuns.error ? <ControlPlaneNotice error={liveRuns.error} /> : null}

      <section aria-label={`Last ${WINDOW_DAYS} days`}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <StatTile
            label={`Runs (${WINDOW_DAYS}d)`}
            value={runsTotal.toLocaleString("en-US")}
            caption={runsTotal === 0 ? "No runs in this window" : runsCaption}
            segments={(["blocked", "errored", "running", "clear", "aborted"] as const).map(
              (bucket) => ({
                label: bucket,
                value: bucketTotals.get(bucket) ?? 0,
                color: RUN_BUCKET_COLOR[bucket],
              }),
            )}
          />

          <StatTile
            label="Findings open"
            value={findingsTotal.toLocaleString("en-US")}
            caption={
              findingsTotal === 0
                ? "Nothing outstanding"
                : `${urgentFindings} critical or high · closed by promotion only`
            }
            segments={[
              ...SEVERITY_ORDER.map((severity) => ({
                label: severity,
                value: findingsBySeverity.get(severity) ?? 0,
                color: SEVERITY_COLOR[severity] ?? "var(--fg-quaternary)",
              })),
              { label: "other", value: otherSeverities, color: "var(--fg-quaternary)" },
            ]}
          />

          <StatTile
            label="Regressions blocked"
            value={regressions.toLocaleString("en-US")}
            caption={
              blockingTotal === 0
                ? "No verdict blocked promotion"
                : `${blockingTotal} blocking verdicts in total`
            }
            segments={[
              { label: "regression", value: regressions, color: "var(--status-fail)" },
              {
                label: "hotfix-induced",
                value: hotfixInduced,
                color: "color-mix(in srgb, var(--status-fail) 68%, var(--bg-surface))",
              },
              {
                label: "still broken",
                value: stillBroken,
                color: "color-mix(in srgb, var(--status-fail) 42%, var(--bg-surface))",
              },
            ]}
          />

          <StatTile
            label="Pre-existing carried"
            value={preExisting.toLocaleString("en-US")}
            caption={
              verdictTotal === 0
                ? "No verdicts in this window"
                : `${preExistingShare}% of the probe surface, not this rollout's fault`
            }
            segments={[
              { label: "pre-existing", value: preExisting, color: "var(--fg-tertiary)" },
              {
                label: "everything else",
                value: Math.max(0, verdictTotal - preExisting),
                color: "var(--bg-raised)",
              },
            ]}
          />

          <StatTile
            label="Spend this cycle"
            value={formatUsd(data.cycleUsd)}
            caption={data.cycleStart ? spendCaption : "No usage recorded this cycle"}
            segments={[
              {
                label: "sandbox minutes used",
                value: Math.min(minutesUsed, included),
                color: "var(--accent-400)",
              },
              {
                label: "minutes over the allowance",
                value: Math.max(0, minutesUsed - included),
                color: "var(--status-fail)",
              },
              {
                label: "minutes remaining",
                value: Math.max(0, included - minutesUsed),
                color: "var(--bg-raised)",
              },
            ]}
          />
        </div>
      </section>

      <CurrentLkg projectRow={data.projectRow} latest={data.recentRuns[0]} />

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border-hairline)] px-5 py-3.5">
          <span className="text-eyebrow text-[var(--fg-tertiary)]">Recent runs</span>
          <Link
            href="/runs"
            className="text-[12.5px] font-medium text-[var(--fg-tertiary)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:text-[var(--accent-400)]"
          >
            All runs →
          </Link>
        </div>
        <RunTable
          rows={rows}
          now={renderedAt}
          emptyTitle="No runs yet"
          emptyDescription="Start an investigation from the CLI with `uv run sandman run` and its three sandbox lanes will show up here."
        />
      </Card>
    </div>
  )
}
