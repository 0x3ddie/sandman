"use client"

/**
 * The three-way diff.
 *
 * The obvious design — three columns of code side by side — does not survive
 * contact with a real viewport: at 1440px, minus the sidebar and the gutters,
 * three panes are about 38 characters wide each, which is narrower than a
 * single stack frame. So the comparison is inverted. The overview is one row
 * per probe carrying a 3-cell B/I/H matrix and the named classification, and
 * the detailed comparison is a *pairing* of two lanes, chosen by two segmented
 * controls, over the normalized behavioural signature rather than raw output.
 *
 * Sorting is by severity, so REGRESSION is always the first thing on screen and
 * STABLE collapses behind a disclosure. PRE_EXISTING gets a deliberately muted,
 * steel treatment and an explicit sentence disclaiming the rollout: attributing
 * a failure that predates this cut to the code that ships today is the exact
 * mistake the baseline lane exists to prevent.
 */

import * as React from "react"
import { CaretDown, CaretRight, Warning } from "phosphor-react"

import { cn, pluralize } from "@/lib/utils"
import type { BehavioralSignature, FindingDto, ProbeVerdictDto } from "@/lib/control-plane"
import {
  CLASSIFICATION_META,
  isClassification,
  VARIANT_META,
  VARIANT_ORDER,
  type Classification,
  type Tone,
  type Variant,
} from "@/lib/variants"
import { Segmented } from "@/components/ui/segmented"
import { VariantTriple, type VariantOutcome } from "@/components/ui/variant-badge"

/* ---------------------------------------------------------------------------
 * Vocabulary
 * ------------------------------------------------------------------------ */

const TONE_COLOR: Record<Tone, string> = {
  pass: "var(--status-pass)",
  fail: "var(--status-fail)",
  flaky: "var(--status-flaky)",
  neutral: "var(--variant-baseline)",
}

const SIGNATURE_FIELDS: readonly { key: keyof BehavioralSignature; label: string }[] = [
  { key: "status_code", label: "Status code" },
  { key: "body_hash", label: "Body hash" },
  { key: "error_class", label: "Error class" },
  { key: "latency_bucket", label: "Latency bucket" },
  { key: "exit_code", label: "Exit code" },
  { key: "stderr_fingerprint", label: "Stderr" },
]

function classificationOf(verdict: ProbeVerdictDto): Classification | null {
  return isClassification(verdict.classification) ? verdict.classification : null
}

function outcomeFor(verdict: ProbeVerdictDto, variant: Variant): VariantOutcome {
  if (variant === "baseline") return verdict.baselinePassed
  if (variant === "initial") return verdict.initialPassed
  return verdict.hotfixPassed
}

function signatureValue(signature: BehavioralSignature | undefined, key: keyof BehavioralSignature) {
  if (!signature) return null
  const value = signature[key]
  if (value === null || value === undefined) return null
  if (typeof value === "number") return String(value)
  // Hashes are 64 hex characters; the first twelve are enough to tell two apart
  // and short enough not to wrap the pane.
  return key === "body_hash" || key === "stderr_fingerprint" ? value.slice(0, 12) : value
}

/* ---------------------------------------------------------------------------
 * Badges
 * ------------------------------------------------------------------------ */

function ClassificationBadge({
  classification,
  raw,
}: {
  classification: Classification | null
  raw: string
}) {
  const meta = classification ? CLASSIFICATION_META[classification] : null
  const color = meta ? TONE_COLOR[meta.tone] : "var(--fg-tertiary)"
  return (
    <span
      className="mono inline-flex h-[22px] shrink-0 items-center rounded-[6px] border px-2 text-[11px] font-medium uppercase leading-none tracking-[0.14em]"
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`,
        borderColor: `color-mix(in srgb, ${color} 28%, transparent)`,
      }}
      title={meta?.blurb}
    >
      {meta ? meta.label : raw}
    </span>
  )
}

/* ---------------------------------------------------------------------------
 * Rows
 * ------------------------------------------------------------------------ */

interface RowProps {
  verdict: ProbeVerdictDto
  finding: FindingDto | undefined
  selected: boolean
  onSelect: () => void
}

function VerdictRow({ verdict, finding, selected, onSelect }: RowProps) {
  const classification = classificationOf(verdict)
  const preExisting = classification === "pre_existing"

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-expanded={selected}
      className={cn(
        "flex h-11 w-full items-center gap-3 border-b border-[var(--border-hairline)] px-4 text-left",
        "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
        selected
          ? "bg-[var(--bg-raised)] shadow-[inset_2px_0_0_0_var(--accent-400)]"
          : "hover:bg-[var(--bg-raised)]",
      )}
    >
      {selected ? (
        <CaretDown size={16} weight="regular" color="var(--fg-tertiary)" aria-hidden />
      ) : (
        <CaretRight size={16} weight="regular" color="var(--fg-quaternary)" aria-hidden />
      )}

      <span
        className={cn(
          "mono min-w-0 flex-1 truncate text-[12.5px]",
          preExisting ? "text-[var(--fg-tertiary)]" : "text-[var(--fg-primary)]",
        )}
      >
        {verdict.probeId}
      </span>

      {finding ? (
        <span className="text-body-sm hidden min-w-0 max-w-[38ch] truncate text-[var(--fg-tertiary)] lg:block">
          {finding.title}
        </span>
      ) : null}

      {verdict.flakeSuspected ? (
        <span
          className="text-caption shrink-0 text-[var(--status-flaky)]"
          title="The lanes disagreed across samples of the same revision."
        >
          flake?
        </span>
      ) : null}

      {verdict.behaviourChanged ? (
        <span
          className="text-caption shrink-0 text-[var(--fg-tertiary)]"
          title="Pass/fail agrees across lanes, but the behavioural signature does not."
        >
          behaviour drift
        </span>
      ) : null}

      <VariantTriple
        baseline={outcomeFor(verdict, "baseline")}
        initial={outcomeFor(verdict, "initial")}
        hotfix={outcomeFor(verdict, "hotfix")}
        className={preExisting ? "opacity-70" : undefined}
      />

      <ClassificationBadge classification={classification} raw={verdict.classification} />
    </button>
  )
}

/* ---------------------------------------------------------------------------
 * Comparison
 * ------------------------------------------------------------------------ */

const VARIANT_OPTIONS = VARIANT_ORDER.map((variant) => ({
  value: variant,
  label: VARIANT_META[variant].label,
  glyph: VARIANT_META[variant].glyph,
  glyphColor: VARIANT_META[variant].color,
}))

interface PaneProps {
  role: "Reference" | "Subject"
  variant: Variant
  onVariantChange: (variant: Variant) => void
  verdict: ProbeVerdictDto
  differing: ReadonlySet<keyof BehavioralSignature>
}

function ComparisonPane({ role, variant, onVariantChange, verdict, differing }: PaneProps) {
  const meta = VARIANT_META[variant]
  const signature = verdict.signatures[variant]
  const outcome = outcomeFor(verdict, variant)
  const samples = verdict.sampleSize[variant] ?? 0

  return (
    <div className="min-w-0 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      <div className="flex items-center gap-2 border-b border-[var(--border-hairline)] px-3 py-2.5">
        <p className="text-eyebrow flex-1 text-[var(--fg-quaternary)]">{role}</p>
        <Segmented
          size="sm"
          aria-label={`${role} lane`}
          value={variant}
          onValueChange={onVariantChange}
          options={VARIANT_OPTIONS}
        />
      </div>

      <div
        className="flex items-center gap-2 border-b border-[var(--border-hairline)] px-3 py-2"
        style={{ backgroundColor: meta.wash }}
      >
        <span className="mono text-[12.5px]" style={{ color: meta.color }}>
          {meta.glyph}
        </span>
        <span className="text-[12.5px] font-medium text-[var(--fg-secondary)]">{meta.label}</span>
        <span
          className="mono text-[11px] uppercase tracking-[0.14em]"
          style={{
            color:
              outcome === null
                ? "var(--fg-quaternary)"
                : outcome
                  ? "var(--status-pass)"
                  : "var(--status-fail)",
          }}
        >
          {outcome === null ? "not run" : outcome ? "pass" : "fail"}
        </span>
        <span className="mono ml-auto text-[11.5px] text-[var(--fg-quaternary)]" data-numeric>
          n={samples}
        </span>
      </div>

      {signature ? (
        <dl className="flex flex-col">
          {SIGNATURE_FIELDS.map((field) => {
            const value = signatureValue(signature, field.key)
            const differs = differing.has(field.key)
            return (
              <div
                key={field.key}
                className={cn(
                  "flex items-baseline gap-3 border-b border-[var(--border-hairline)] px-3 py-1.5 last:border-0",
                  differs && "bg-[var(--status-fail-wash)]",
                )}
              >
                <dt className="text-caption w-[104px] shrink-0 text-[var(--fg-tertiary)]">
                  {field.label}
                </dt>
                <dd
                  className={cn(
                    "mono min-w-0 flex-1 truncate text-right text-[12.5px]",
                    value === null
                      ? "text-[var(--fg-quaternary)]"
                      : differs
                        ? "text-[var(--status-fail)]"
                        : "text-[var(--fg-secondary)]",
                  )}
                >
                  {value ?? "—"}
                </dd>
              </div>
            )
          })}
        </dl>
      ) : (
        <p className="text-body-sm px-3 py-4 text-[var(--fg-tertiary)]">
          This lane produced no signature for {verdict.probeId} — it did not run.
        </p>
      )}
    </div>
  )
}

interface ComparisonProps {
  verdict: ProbeVerdictDto
  finding: FindingDto | undefined
}

function Comparison({ verdict, finding }: ComparisonProps) {
  const [reference, setReference] = React.useState<Variant>("baseline")
  const [subject, setSubject] = React.useState<Variant>("hotfix")
  const classification = classificationOf(verdict)

  // Whichever pairing is on screen decides what "differs" means, so the
  // highlight follows the two segmented controls rather than a fixed pair.
  const differing = React.useMemo(() => {
    const left = verdict.signatures[reference]
    const right = verdict.signatures[subject]
    const keys = new Set<keyof BehavioralSignature>()
    if (!left || !right) return keys
    for (const field of SIGNATURE_FIELDS) {
      if (signatureValue(left, field.key) !== signatureValue(right, field.key)) keys.add(field.key)
    }
    return keys
  }, [verdict, reference, subject])

  return (
    <div className="border-b border-[var(--border-hairline)] bg-[var(--bg-base)] px-4 py-4">
      {classification === "pre_existing" ? (
        <div
          className="mb-3 flex items-start gap-2 rounded-[8px] border px-3 py-2.5"
          style={{
            borderColor: "var(--variant-baseline-border)",
            backgroundColor: "var(--variant-baseline-wash)",
          }}
        >
          <Warning size={16} weight="regular" color="var(--variant-baseline)" aria-hidden />
          <p className="text-body-sm text-[var(--fg-secondary)]">
            <span className="font-medium text-[var(--fg-primary)]">
              Failing before this cut, and not attributed to this rollout.
            </span>{" "}
            The baseline lane failed too, so the code shipping today did not cause it. It is
            reported and never auto-patched.
            {finding?.previouslyIgnored ? " Earlier runs already surfaced this finding." : ""}
          </p>
        </div>
      ) : null}

      {verdict.detail ? (
        <p className="text-body-sm mb-3 text-[var(--fg-secondary)]">{verdict.detail}</p>
      ) : null}

      {finding ? (
        <div className="mb-3 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2.5">
          <p className="text-[13.5px] font-medium text-[var(--fg-primary)]">{finding.title}</p>
          <p className="text-body-sm mt-1 text-[var(--fg-tertiary)]">{finding.description}</p>
          {finding.reproduction ? (
            <pre className="no-grain mt-2 overflow-x-auto rounded-[6px] bg-[var(--bg-inset)] p-2 text-[12px] leading-[1.55] text-[var(--fg-secondary)]">
              {finding.reproduction}
            </pre>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        <ComparisonPane
          role="Reference"
          variant={reference}
          onVariantChange={setReference}
          verdict={verdict}
          differing={differing}
        />
        <ComparisonPane
          role="Subject"
          variant={subject}
          onVariantChange={setSubject}
          verdict={verdict}
          differing={differing}
        />
      </div>

      <p className="text-caption mt-2 text-[var(--fg-quaternary)]">
        {differing.size === 0
          ? "The two lanes produced an identical behavioural signature."
          : `${differing.size} ${pluralize(differing.size, "field")} differ between ${
              VARIANT_META[reference].label
            } and ${VARIANT_META[subject].label}.`}
      </p>
    </div>
  )
}

/* ---------------------------------------------------------------------------
 * Public component
 * ------------------------------------------------------------------------ */

export interface VerdictStripProps {
  verdicts: ProbeVerdictDto[]
  findings: FindingDto[]
  counts: Record<string, number>
}

export function VerdictStrip({ verdicts, findings, counts }: VerdictStripProps) {
  const [selectedProbe, setSelectedProbe] = React.useState<string | null>(null)
  const [showStable, setShowStable] = React.useState(false)

  const findingByProbe = React.useMemo(() => {
    const map = new Map<string, FindingDto>()
    for (const finding of findings) if (!map.has(finding.probeId)) map.set(finding.probeId, finding)
    return map
  }, [findings])

  const { actionable, stable } = React.useMemo(() => {
    const sorted = verdicts.slice().sort((a, b) => {
      const left = classificationOf(a)
      const right = classificationOf(b)
      const bySeverity =
        (left ? CLASSIFICATION_META[left].severity : a.severity) -
        (right ? CLASSIFICATION_META[right].severity : b.severity)
      if (bySeverity !== 0) return bySeverity
      return a.probeId.localeCompare(b.probeId)
    })
    return {
      actionable: sorted.filter((v) => classificationOf(v) !== "stable"),
      stable: sorted.filter((v) => classificationOf(v) === "stable"),
    }
  }, [verdicts])

  const legend = React.useMemo(
    () =>
      Object.entries(counts)
        .filter(([, value]) => value > 0)
        .filter(([key]) => isClassification(key))
        .sort(
          ([a], [b]) =>
            CLASSIFICATION_META[a as Classification].severity -
            CLASSIFICATION_META[b as Classification].severity,
        ),
    [counts],
  )

  if (verdicts.length === 0) {
    return (
      <section className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4 py-16 text-center shadow-[var(--elev-1)]">
        <p className="text-[17px] font-semibold tracking-[-0.01em] text-[var(--fg-primary)]">
          No verdict yet
        </p>
        <p className="text-body-sm mx-auto mt-1 max-w-[52ch] text-[var(--fg-tertiary)]">
          The three-way comparison is published once the baseline and initial lanes have both
          finished probing. Watch the fan-out tab until then.
        </p>
      </section>
    )
  }

  const renderRow = (verdict: ProbeVerdictDto) => {
    const selected = verdict.probeId === selectedProbe
    return (
      <React.Fragment key={verdict.probeId}>
        <VerdictRow
          verdict={verdict}
          finding={findingByProbe.get(verdict.probeId)}
          selected={selected}
          onSelect={() => setSelectedProbe(selected ? null : verdict.probeId)}
        />
        {selected ? (
          <Comparison verdict={verdict} finding={findingByProbe.get(verdict.probeId)} />
        ) : null}
      </React.Fragment>
    )
  }

  return (
    <section className="overflow-hidden rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[var(--elev-1)]">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--border-hairline)] px-4 py-3">
        <p className="text-eyebrow text-[var(--fg-tertiary)]">Probe · B → I → H · classification</p>
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
          {legend.map(([key, value]) => {
            const meta = CLASSIFICATION_META[key as Classification]
            return (
              <span key={key} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: TONE_COLOR[meta.tone] }}
                />
                <span className="text-caption text-[var(--fg-tertiary)]">{meta.label}</span>
                <span className="mono text-[12px] text-[var(--fg-primary)]" data-numeric>
                  {value}
                </span>
              </span>
            )
          })}
        </div>
      </header>

      {actionable.map(renderRow)}

      {stable.length > 0 ? (
        <>
          <button
            type="button"
            onClick={() => setShowStable((open) => !open)}
            aria-expanded={showStable}
            className={cn(
              "flex h-11 w-full items-center gap-2 px-4 text-left",
              "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
              "hover:bg-[var(--bg-raised)]",
              showStable && "border-b border-[var(--border-hairline)]",
            )}
          >
            {showStable ? (
              <CaretDown size={16} weight="regular" color="var(--fg-tertiary)" aria-hidden />
            ) : (
              <CaretRight size={16} weight="regular" color="var(--fg-quaternary)" aria-hidden />
            )}
            <span className="text-body-sm text-[var(--fg-secondary)]">
              <span className="mono text-[var(--fg-primary)]" data-numeric>
                {stable.length}
              </span>{" "}
              stable
            </span>
            <span className="text-caption text-[var(--fg-quaternary)]">
              passed in all three lanes
            </span>
          </button>
          {showStable ? stable.map(renderRow) : null}
        </>
      ) : null}
    </section>
  )
}
