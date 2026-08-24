/**
 * Hotfix attempts.
 *
 * Three different systems touch a patch before it can reach LKG and the UI is
 * explicit about which is which: Codex authors, Greptile reviews, GitHub
 * merges. Collapsing them into a single "AI fixed it" badge would hide the only
 * question an operator actually has when a patch is stuck, which is *who* is
 * holding it.
 *
 * A Server Component: nothing here is interactive, and the diff can be large
 * enough that shipping it through a client boundary would be wasteful.
 */

import * as React from "react"

import { cn, shortSha } from "@/lib/utils"
import type { HotfixDetail } from "@/lib/control-plane"
import { CLASSIFICATION_META, isClassification } from "@/lib/variants"

/* ---------------------------------------------------------------------------
 * Promotion gate
 * ------------------------------------------------------------------------ */

export interface PromotionBlocker {
  /** The policy condition, phrased as the requirement, not the failure. */
  condition: string
  detail: string
}

/* ---------------------------------------------------------------------------
 * Hotfix state
 * ------------------------------------------------------------------------ */

interface StateMeta {
  label: string
  color: string
}

const HOTFIX_STATE_META: Record<string, StateMeta> = {
  authoring: { label: "Authoring", color: "var(--status-running)" },
  authored: { label: "Authored", color: "var(--status-running)" },
  in_review: { label: "In review", color: "var(--status-provisioning)" },
  blocked: { label: "Blocked", color: "var(--status-fail)" },
  merged: { label: "Merged", color: "var(--status-pass)" },
  verification_failed: { label: "Verification failed", color: "var(--status-fail)" },
  awaiting_promotion: { label: "Awaiting promotion", color: "var(--accent-400)" },
  promoted: { label: "Promoted", color: "var(--status-pass)" },
  rejected: { label: "Rejected", color: "var(--status-fail)" },
}

function stateMeta(state: string): StateMeta {
  return HOTFIX_STATE_META[state] ?? { label: state.replace(/_/g, " "), color: "var(--fg-tertiary)" }
}

function StatePill({ state }: { state: string }) {
  const meta = stateMeta(state)
  return (
    <span
      className="mono inline-flex h-[22px] shrink-0 items-center rounded-[6px] border px-2 text-[11px] font-medium uppercase leading-none tracking-[0.14em]"
      style={{
        color: meta.color,
        backgroundColor: `color-mix(in srgb, ${meta.color} 10%, transparent)`,
        borderColor: `color-mix(in srgb, ${meta.color} 28%, transparent)`,
      }}
    >
      {meta.label}
    </span>
  )
}

/* ---------------------------------------------------------------------------
 * Ownership chain
 * ------------------------------------------------------------------------ */

type StepState = "done" | "active" | "blocked" | "pending"

const STEP_COLOR: Record<StepState, string> = {
  done: "var(--status-pass)",
  active: "var(--accent-400)",
  blocked: "var(--status-fail)",
  pending: "var(--fg-quaternary)",
}

function ownershipSteps(hotfix: HotfixDetail): { owner: string; action: string; state: StepState }[] {
  const authored: StepState = hotfix.rootCause || hotfix.fixSummary ? "done" : "active"
  const reviewed: StepState =
    hotfix.reviewApproved === true
      ? "done"
      : hotfix.reviewApproved === false
        ? "blocked"
        : hotfix.prNumber !== null
          ? "active"
          : "pending"
  const merged: StepState =
    hotfix.mergedSha !== null
      ? "done"
      : hotfix.state === "verification_failed" || hotfix.state === "blocked"
        ? "blocked"
        : "pending"

  return [
    { owner: "Codex", action: "authored", state: authored },
    { owner: "Greptile", action: "reviewed", state: reviewed },
    { owner: "GitHub", action: "merged", state: merged },
  ]
}

function OwnershipChain({ hotfix }: { hotfix: HotfixDetail }) {
  const steps = ownershipSteps(hotfix)
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {steps.map((step, index) => (
        <li key={step.owner} className="flex items-center gap-2">
          {index > 0 ? (
            <span aria-hidden className="text-[var(--fg-quaternary)]">
              →
            </span>
          ) : null}
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: STEP_COLOR[step.state] }}
            />
            <span className="text-[12.5px] font-medium text-[var(--fg-primary)]">{step.owner}</span>
            <span className="text-caption text-[var(--fg-tertiary)]">{step.action}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}

/* ---------------------------------------------------------------------------
 * Diff
 * ------------------------------------------------------------------------ */

type DiffKind = "add" | "remove" | "hunk" | "meta" | "context"

function diffKind(line: string): DiffKind {
  if (line.startsWith("@@")) return "hunk"
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")) return "meta"
  if (line.startsWith("+")) return "add"
  if (line.startsWith("-")) return "remove"
  return "context"
}

const DIFF_STYLE: Record<DiffKind, string> = {
  add: "bg-[var(--status-pass-wash)] text-[var(--status-pass)]",
  remove: "bg-[var(--status-fail-wash)] text-[var(--status-fail)]",
  hunk: "text-[var(--accent-300)]",
  meta: "text-[var(--fg-quaternary)]",
  context: "text-[var(--fg-secondary)]",
}

function DiffWell({ diff }: { diff: string }) {
  const lines = diff.replace(/\n$/, "").split("\n")
  return (
    <div className="no-grain max-h-[360px] overflow-auto rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-inset)]">
      <pre className="w-max min-w-full py-1">
        {lines.map((line, index) => (
          <code
            key={`${index}-${line.slice(0, 16)}`}
            className={cn(
              "block whitespace-pre px-3 text-[12.5px] leading-[1.55]",
              DIFF_STYLE[diffKind(line)],
            )}
          >
            {line === "" ? " " : line}
          </code>
        ))}
      </pre>
    </div>
  )
}

/* ---------------------------------------------------------------------------
 * Panel
 * ------------------------------------------------------------------------ */

export interface HotfixPanelProps {
  hotfixes: HotfixDetail[]
  /** Empty when the gate is open. Computed once on the server. */
  blockers: PromotionBlocker[]
  safeToPromote: boolean
}

export function HotfixPanel({ hotfixes, blockers, safeToPromote }: HotfixPanelProps) {
  if (hotfixes.length === 0) {
    return (
      <section className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4 py-10 text-center shadow-[var(--elev-1)]">
        <p className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--fg-primary)]">
          No patch was authored
        </p>
        <p className="text-body-sm mx-auto mt-1 max-w-[56ch] text-[var(--fg-tertiary)]">
          Remediation only runs against failures this rollout introduced. Pre-existing failures are
          reported and never auto-patched, so a run can finish clean here and still have findings.
        </p>
      </section>
    )
  }

  return (
    <section className="flex flex-col gap-3">
      {hotfixes.map((hotfix) => {
        const classification = isClassification(hotfix.classification)
          ? CLASSIFICATION_META[hotfix.classification]
          : null

        return (
          <article
            key={hotfix.id}
            className="overflow-hidden rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[var(--elev-1)]"
          >
            <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--border-hairline)] px-4 py-3">
              <StatePill state={hotfix.state} />
              <span className="mono text-[12.5px] text-[var(--fg-primary)]">{hotfix.probeId}</span>
              {classification ? (
                <span className="text-caption text-[var(--fg-tertiary)]">
                  targets a {classification.label.toLowerCase()}
                </span>
              ) : null}
              <div className="ml-auto flex items-center gap-3">
                {hotfix.confidence !== null ? (
                  <span className="text-caption text-[var(--fg-tertiary)]">
                    confidence{" "}
                    <span className="mono text-[var(--fg-primary)]" data-numeric>
                      {Math.round(hotfix.confidence * 100)}%
                    </span>
                  </span>
                ) : null}
                {hotfix.branch ? (
                  <span className="mono text-[11.5px] text-[var(--fg-quaternary)]">
                    {hotfix.branch}
                    {hotfix.commitSha ? `@${shortSha(hotfix.commitSha)}` : ""}
                  </span>
                ) : null}
              </div>
            </header>

            <div className="border-b border-[var(--border-hairline)] px-4 py-3">
              <OwnershipChain hotfix={hotfix} />
            </div>

            <div className="grid gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="min-w-0">
                <p className="text-eyebrow text-[var(--fg-tertiary)]">Root cause</p>
                <p className="text-body-sm mt-1.5 text-[var(--fg-secondary)]">
                  {hotfix.rootCause ?? "Codex has not reported a root cause for this attempt yet."}
                </p>

                <p className="text-eyebrow mt-4 text-[var(--fg-tertiary)]">Fix</p>
                <p className="text-body-sm mt-1.5 text-[var(--fg-secondary)]">
                  {hotfix.fixSummary ?? "No summary was produced."}
                </p>

                {hotfix.filesChanged.length > 0 ? (
                  <>
                    <p className="text-eyebrow mt-4 text-[var(--fg-tertiary)]">
                      Files changed · {hotfix.filesChanged.length}
                    </p>
                    <ul className="mt-1.5 flex flex-col gap-1">
                      {hotfix.filesChanged.map((file) => (
                        <li
                          key={file}
                          className="mono truncate text-[12.5px] text-[var(--fg-secondary)]"
                        >
                          {file}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}

                {hotfix.priorFixes.length > 0 ? (
                  <p className="text-caption mt-4 text-[var(--fg-quaternary)]">
                    Builds on {hotfix.priorFixes.length} earlier attempt
                    {hotfix.priorFixes.length === 1 ? "" : "s"} in this run.
                  </p>
                ) : null}
              </div>

              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <p className="text-eyebrow text-[var(--fg-tertiary)]">Patch</p>
                  {hotfix.testsPassed !== null ? (
                    <span
                      className="text-caption"
                      style={{
                        color: hotfix.testsPassed ? "var(--status-pass)" : "var(--status-fail)",
                      }}
                    >
                      in-sandbox tests {hotfix.testsPassed ? "passed" : "failed"}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1.5">
                  {hotfix.diff.trim() === "" ? (
                    <p className="text-body-sm rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-inset)] px-3 py-4 text-[var(--fg-tertiary)]">
                      No diff was produced.
                    </p>
                  ) : (
                    <DiffWell diff={hotfix.diff} />
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[var(--border-hairline)] px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-eyebrow text-[var(--fg-tertiary)]">Review</span>
                {hotfix.reviewApproved === null ? (
                  <span className="text-body-sm text-[var(--fg-tertiary)]">
                    not reviewed{hotfix.prNumber === null ? " — no pull request yet" : " — pending"}
                  </span>
                ) : (
                  <span
                    className="text-body-sm"
                    style={{
                      color: hotfix.reviewApproved ? "var(--status-pass)" : "var(--status-fail)",
                    }}
                  >
                    {hotfix.reviewApproved ? "approved" : "not approved"}
                  </span>
                )}
                {hotfix.reviewScore !== null ? (
                  <span className="mono text-[12px] text-[var(--fg-secondary)]" data-numeric>
                    score {hotfix.reviewScore.toFixed(2)}
                  </span>
                ) : null}
              </div>

              {hotfix.prUrl ? (
                <a
                  href={hotfix.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(
                    "mono text-[12.5px] text-[var(--accent-300)]",
                    "transition-colors duration-[var(--dur-fast)] hover:text-[var(--accent-200)]",
                  )}
                >
                  #{hotfix.prNumber} ↗
                </a>
              ) : null}

              {hotfix.mergedSha ? (
                <span className="mono text-[12px] text-[var(--fg-tertiary)]">
                  merged {shortSha(hotfix.mergedSha)}
                </span>
              ) : null}
            </div>

            {hotfix.rejectionReason ? (
              <p
                className="text-body-sm border-t px-4 py-2.5"
                style={{
                  borderColor: "rgb(255 95 109 / 0.24)",
                  backgroundColor: "var(--status-fail-wash)",
                  color: "var(--status-fail)",
                }}
              >
                {hotfix.rejectionReason}
              </p>
            ) : null}

            <footer className="border-t border-[var(--border-hairline)] bg-[var(--bg-raised)] px-4 py-3">
              <p className="text-eyebrow text-[var(--fg-tertiary)]">Promotion gate</p>
              {blockers.length === 0 && safeToPromote ? (
                <p className="text-body-sm mt-1.5 text-[var(--status-pass)]">
                  Every condition is met. Promotion to LKG is available.
                </p>
              ) : (
                <ul className="mt-1.5 flex flex-col gap-1.5">
                  {blockers.map((blocker) => (
                    <li key={blocker.condition} className="flex items-start gap-2">
                      <span
                        aria-hidden
                        className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--status-fail)]"
                      />
                      <p className="text-body-sm text-[var(--fg-secondary)]">
                        <span className="font-medium text-[var(--fg-primary)]">
                          {blocker.condition}
                        </span>{" "}
                        — {blocker.detail}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </footer>
          </article>
        )
      })}
    </section>
  )
}
