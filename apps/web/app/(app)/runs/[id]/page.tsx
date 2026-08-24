import * as React from "react"
import type { Metadata } from "next"
import { notFound } from "next/navigation"

import {
  ControlPlaneError,
  getHotfixes,
  getRun,
  getVerdicts,
  type BudgetSnapshot,
  type HotfixDetail,
  type ProbeVerdictDto,
  type RunSummary,
  type VerdictsResponse,
} from "@/lib/control-plane"
import { isActionable, isClassification, isRunState, RUN_STATE_META } from "@/lib/variants"
import { HotfixPanel, type PromotionBlocker } from "@/components/runs/hotfix-panel"
import { RunWorkspace } from "@/components/runs/run-workspace"

/**
 * The run detail page.
 *
 * Everything the first paint needs is fetched here, on the server, and handed
 * to one client boundary that then follows the SSE stream. Verdicts and hotfix
 * diffs stay server-owned — they are large, they change a handful of times per
 * run, and the stream already says when to refetch them.
 */

// A run's state changes second to second; a cached render would show a fan-out
// grid that never corrects itself.
export const dynamic = "force-dynamic"

interface RunPageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: RunPageProps): Promise<Metadata> {
  const { id } = await params
  return { title: `${id} · sandman` }
}

const EMPTY_VERDICTS: VerdictsResponse = { counts: {}, verdicts: [], findings: [] }

/**
 * Exactly which promotion conditions are unmet.
 *
 * Phrased as requirements rather than errors, because this list is what the
 * disabled Promote button explains, and "Greptile must approve the patch" tells
 * an operator what to do next in a way that "review failed" does not.
 */
function promotionBlockers(
  summary: RunSummary,
  verdicts: ProbeVerdictDto[],
  hotfixes: HotfixDetail[],
): PromotionBlocker[] {
  const blockers: PromotionBlocker[] = []
  const state = isRunState(summary.state) ? summary.state : "queued"
  const meta = RUN_STATE_META[state]

  if (!meta.terminal) {
    blockers.push({
      condition: "The run must finish",
      detail: `It is still ${meta.label.toLowerCase()}.`,
    })
  } else if (state !== "completed") {
    blockers.push({
      condition: "The run must finish cleanly",
      detail: summary.error ?? `This run ${meta.label.toLowerCase()}.`,
    })
  }

  const blocking = verdicts.filter(
    (verdict) => isClassification(verdict.classification) && isActionable(verdict.classification),
  )
  if (blocking.length > 0) {
    blockers.push({
      condition: "No probe may be left broken",
      detail: `${blocking.length} of ${verdicts.length} probes are still failing in the hotfix lane: ${blocking
        .slice(0, 3)
        .map((verdict) => verdict.probeId)
        .join(", ")}${blocking.length > 3 ? "…" : ""}.`,
    })
  }

  if (hotfixes.length === 0) {
    blockers.push({
      condition: "There must be a patch to promote",
      detail:
        "This run authored no hotfix. Pre-existing failures are reported, never auto-patched.",
    })
  } else {
    const rejected = hotfixes.filter((hotfix) => hotfix.reviewApproved === false)
    if (rejected.length > 0) {
      blockers.push({
        condition: "Greptile must approve the patch",
        detail: rejected[0]?.rejectionReason ?? "The review did not approve the pull request.",
      })
    }
    if (!hotfixes.some((hotfix) => hotfix.mergedSha !== null)) {
      blockers.push({
        condition: "The patch must be merged",
        detail: "No hotfix branch has been squash-merged yet.",
      })
    }
  }

  if (blockers.length === 0 && !summary.safeToPromote) {
    blockers.push({
      condition: "The three-way re-probe must come back clean",
      detail: "Verification has not published a safe verdict for the merged branch.",
    })
  }

  return blockers
}

/** `RunOutcome.budget` is `{}` until the first snapshot is taken. */
function isBudget(value: BudgetSnapshot | Record<string, never>): value is BudgetSnapshot {
  return typeof value.usd_spent === "number"
}

function budgetOf(summary: RunSummary): BudgetSnapshot | null {
  return isBudget(summary.budget) ? summary.budget : null
}

function Unreachable({ runId, detail }: { runId: string; detail: string }) {
  return (
    <section className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-6 py-16 text-center shadow-[var(--elev-1)]">
      <p className="text-h4 text-[var(--fg-primary)]">The control plane is not answering</p>
      <p className="text-body-sm mx-auto mt-2 max-w-[58ch] text-[var(--fg-tertiary)]">
        {detail} Run history lives in the control-plane process, so{" "}
        <span className="mono text-[var(--fg-secondary)]">{runId}</span> cannot be rendered until it
        is reachable again.
      </p>
      <p className="text-caption mx-auto mt-4 max-w-[58ch] text-[var(--fg-quaternary)]">
        Start it with{" "}
        <span className="mono text-[var(--fg-tertiary)]">uv run sandman serve</span>, or point{" "}
        <span className="mono text-[var(--fg-tertiary)]">SANDMAN_CONTROL_PLANE_URL</span> at the
        host running it.
      </p>
    </section>
  )
}

export default async function RunPage({ params }: RunPageProps) {
  const { id } = await params

  let summary: RunSummary
  try {
    summary = await getRun(id)
  } catch (cause) {
    if (cause instanceof ControlPlaneError && cause.isNotFound) notFound()
    const detail =
      cause instanceof ControlPlaneError ? cause.message : "The request failed before it was sent."
    return <Unreachable runId={id} detail={detail} />
  }

  // A run can exist without a verdict or a patch; neither is worth failing the
  // page over, so both degrade to empty rather than throwing.
  const [verdicts, hotfixes] = await Promise.all([
    getVerdicts(id).catch(() => EMPTY_VERDICTS),
    getHotfixes(id).then(
      (response) => response.hotfixes,
      () => [] as HotfixDetail[],
    ),
  ])

  const blockers = promotionBlockers(summary, verdicts.verdicts, hotfixes)
  const safeToPromote = verdicts.safeToPromote ?? summary.safeToPromote
  const runState = isRunState(summary.state) ? summary.state : "queued"

  return (
    <RunWorkspace
      runId={summary.runId}
      initialState={runState}
      initialRevisions={summary.revisions}
      initialHotfixes={summary.hotfixes}
      initialBudget={budgetOf(summary)}
      initialCounts={
        Object.keys(verdicts.counts).length > 0 ? verdicts.counts : summary.counts
      }
      verdicts={verdicts.verdicts}
      findings={verdicts.findings}
      blockers={blockers}
      safeToPromote={safeToPromote}
      hotfixSlot={
        <HotfixPanel hotfixes={hotfixes} blockers={blockers} safeToPromote={safeToPromote} />
      }
    />
  )
}
