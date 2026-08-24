import * as React from "react"
import type { Metadata } from "next"
import Link from "next/link"

import { PricingCards } from "@/components/marketing/pricing-cards"
import { ThreeLaneHero } from "@/components/marketing/three-lane-hero"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { VariantBadge } from "@/components/ui/variant-badge"
import { PLANS, limitsFor } from "@/lib/plans"
import { cn } from "@/lib/utils"
import {
  CLASSIFICATION_META,
  CLASSIFICATION_ORDER,
  VARIANT_META,
  VARIANT_ORDER,
  isActionable,
  type Tone,
  type Variant,
} from "@/lib/variants"

export const metadata: Metadata = {
  title: "sandman — prove the fix worked",
  description:
    "sandman pen-tests a rollout before it ships: three sandboxed variants, the same probes, one three-way diff, and an agent-authored hotfix that is re-probed before the gate opens.",
}

/* ---------------------------------------------------------------------------
 * Section chrome
 * ------------------------------------------------------------------------ */

interface SectionProps {
  id?: string
  eyebrow: string
  title: string
  lede?: string
  children: React.ReactNode
}

function Section({ id, eyebrow, title, lede, children }: SectionProps) {
  return (
    <section id={id} className="scroll-mt-20 border-t border-[var(--border-hairline)]">
      <div className="mx-auto w-full max-w-[1200px] px-6 py-24">
        <p className="text-eyebrow text-[var(--fg-tertiary)]">{eyebrow}</p>
        <h2 className="text-h2 mt-4 max-w-[640px] text-balance text-[var(--fg-primary)]">{title}</h2>
        {lede ? (
          <p className="text-body-lg mt-4 max-w-[62ch] text-[var(--fg-secondary)]">{lede}</p>
        ) : null}
        <div className="mt-12">{children}</div>
      </div>
    </section>
  )
}

/* ---------------------------------------------------------------------------
 * (d) How it works
 * ------------------------------------------------------------------------ */

const STEPS: readonly { numeral: string; title: string; body: string }[] = [
  {
    numeral: "01",
    title: "Mirror",
    body: "Three sandboxes are built from one sandman.toml — the previous LKG, the cut you are shipping, and a working copy for the patch. Same image, same command; only the revision differs.",
  },
  {
    numeral: "02",
    title: "Fan out",
    body: "Every probe runs in all three lanes, replicated across the fan-out width on Modal, with bounded concurrency so no single probe can saturate a replica and skew another’s latency.",
  },
  {
    numeral: "03",
    title: "Diff",
    body: "Each probe’s three outcomes collapse into one of eight verdicts. Regressions sort to the top. Failures that predate this cut are named pre-existing, not blamed on you.",
  },
  {
    numeral: "04",
    title: "Hotfix & re-verify",
    body: "An agent patches only what this rollout broke, Greptile reviews the diff, and the entire suite is re-probed against the patched lane before the promotion gate opens.",
  },
]

/* ---------------------------------------------------------------------------
 * (e) Bento
 * ------------------------------------------------------------------------ */

const TEAM_LIMITS = limitsFor(PLANS.team)

/* ---------------------------------------------------------------------------
 * (f) The eight verdicts
 * ------------------------------------------------------------------------ */

const TONE_COLOR: Record<Tone, string> = {
  pass: "var(--status-pass)",
  fail: "var(--status-fail)",
  flaky: "var(--status-flaky)",
  neutral: "var(--fg-tertiary)",
}

/**
 * One lane's outcome. The glyph names the lane, the mark's shape names the
 * result, and the column position is fixed B → I → H — three channels, so the
 * cell survives greyscale and every form of colour-vision deficiency.
 */
function PatternCell({ variant, passed }: { variant: Variant; passed: boolean }) {
  const meta = VARIANT_META[variant]
  const color = passed ? "var(--status-pass)" : "var(--status-fail)"
  return (
    <span
      className="flex h-6 w-[34px] items-center justify-center gap-1 rounded-[4px] border"
      style={{
        backgroundColor: passed ? "var(--status-pass-wash)" : "var(--status-fail-wash)",
        borderColor: `color-mix(in srgb, ${color} 28%, transparent)`,
      }}
    >
      <span aria-hidden className="mono text-[10px] font-medium leading-none" style={{ color: meta.color }}>
        {meta.glyph}
      </span>
      <span aria-hidden className="mono text-[11px] font-medium leading-none" style={{ color }}>
        {passed ? "✓" : "✕"}
      </span>
      <span className="sr-only">
        {meta.label} {passed ? "pass" : "fail"}
      </span>
    </span>
  )
}

/* ---------------------------------------------------------------------------
 * (g) Presets
 * ------------------------------------------------------------------------ */

const PRESETS: readonly {
  id: string
  description: string
  fanout: number
  timeoutSeconds: number
}[] = [
  {
    id: "api-fuzz-differential",
    description:
      "Throws malformed, boundary, and type-confused inputs at each endpoint and asserts the service answers with a client error rather than falling over. Differences in the normalized response across variants surface as behaviour changes.",
    fanout: 4,
    timeoutSeconds: 120,
  },
  {
    id: "load-chaos-fanout",
    description:
      "Fires concurrent bursts at each endpoint and asserts correctness holds under contention, catching defects that only appear when requests overlap.",
    fanout: 2,
    timeoutSeconds: 180,
  },
  {
    id: "security-probe-suite",
    description:
      "Injection, path traversal, oversized payload, and secret-leak checks. Asserts the service neither executes nor echoes hostile input.",
    fanout: 2,
    timeoutSeconds: 120,
  },
  {
    id: "latency-slo-guard",
    description:
      "Measures p95 latency against a declared budget so a rollout that is correct but materially slower is still caught.",
    fanout: 2,
    timeoutSeconds: 180,
  },
]

/* ---------------------------------------------------------------------------
 * (h) SDK sample
 * ------------------------------------------------------------------------ */

const KW = "var(--accent-400)"
const STR = "var(--accent-200)"
const LIT = "var(--variant-initial)"
const FN = "var(--fg-primary)"
const ID = "var(--fg-secondary)"
const PUNC = "var(--fg-tertiary)"
const DOC = "var(--fg-tertiary)"

type Token = readonly [text: string, color: string]

/** Verified against packages/sdk/sandman_sdk/__init__.py: `probe` takes only
 *  keyword arguments, `Target.get` forwards **kw to `request`, and every
 *  `Expectation` method returns `self` so the assertions chain. */
const SDK_SAMPLE: readonly (readonly Token[])[] = [
  [
    ["from ", KW],
    ["sandman_sdk", ID],
    [" import ", KW],
    ["Target, expect, probe", ID],
  ],
  [],
  [],
  [
    ["@probe", KW],
    ["(", PUNC],
  ],
  [
    ["    id", ID],
    ["=", PUNC],
    ['"catalog-search-last-page"', STR],
    [",", PUNC],
  ],
  [
    ["    fanout", ID],
    ["=", PUNC],
    ["8", LIT],
    [",", PUNC],
  ],
  [
    ["    tags", ID],
    ["=", PUNC],
    ["[", PUNC],
    ['"catalog"', STR],
    [", ", PUNC],
    ['"pagination"', STR],
    ["]", PUNC],
    [",", PUNC],
  ],
  [[")", PUNC]],
  [
    ["async def ", KW],
    ["catalog_search_last_page", FN],
    ["(", PUNC],
    ["t", ID],
    [": ", PUNC],
    ["Target", LIT],
    [") -> ", PUNC],
    ["None", KW],
    [":", PUNC],
  ],
  [['    """The last page must answer 200 with has_more=false, not a 500."""', DOC]],
  [
    ["    r", ID],
    [" = ", PUNC],
    ["await ", KW],
    ["t", ID],
    [".", PUNC],
    ["get", FN],
    ["(", PUNC],
  ],
  [
    ['        "/api/catalog/search"', STR],
    [",", PUNC],
  ],
  [
    ["        params", ID],
    ["=", PUNC],
    ["{", PUNC],
    ['"q"', STR],
    [": ", PUNC],
    ['"lamp"', STR],
    [", ", PUNC],
    ['"limit"', STR],
    [": ", PUNC],
    ["20", LIT],
    [", ", PUNC],
    ['"offset"', STR],
    [": ", PUNC],
    ["220", LIT],
    ["}", PUNC],
    [",", PUNC],
  ],
  [["    )", PUNC]],
  [
    ["    expect", FN],
    ["(", PUNC],
    ["r", ID],
    [").", PUNC],
    ["status", FN],
    ["(", PUNC],
    ["200", LIT],
    [").", PUNC],
    ["json_contains", FN],
    ["(", PUNC],
    ["{", PUNC],
    ['"has_more"', STR],
    [": ", PUNC],
    ["False", LIT],
    ["}", PUNC],
    [")", PUNC],
  ],
]

/* ---------------------------------------------------------------------------
 * Page
 * ------------------------------------------------------------------------ */

export default function MarketingHomePage() {
  return (
    <>
      {/* (a) Hero ------------------------------------------------------- */}
      <section className="relative isolate overflow-hidden">
        <div aria-hidden className="sodium-glow" />
        <div aria-hidden className="instrument-grid absolute inset-0 -z-10" />

        <div className="relative mx-auto w-full max-w-[1200px] px-6 pb-24 pt-32 text-center">
          <p className="text-eyebrow text-[var(--accent-400)]">
            Pen-tests your rollout before it ships
          </p>

          <h1 className="text-display-1 mx-auto mt-6 max-w-[900px] text-[var(--fg-primary)]">
            Prove the fix worked.
            <span className="block">Before it hits prod.</span>
          </h1>

          <p className="text-body-lg mx-auto mt-6 max-w-[54ch] text-[var(--fg-secondary)]">
            Three sandboxed variants, the same probes, one diff — so you learn whether the patch
            held <span className="font-serif-italic">before production learns it for you</span>.
          </p>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Button asChild variant="primary" size="lg">
              <Link href="/sign-up">Start a probe</Link>
            </Button>
            <Button asChild variant="secondary" size="lg">
              <Link href="/docs">Read the docs</Link>
            </Button>
          </div>

          <p className="text-caption mt-5 text-[var(--fg-tertiary)]">
            Free in beta · No card · Bring your own Modal + OpenAI keys
          </p>
        </div>
      </section>

      {/* (b) The three-lane demo ---------------------------------------- */}
      <section className="mx-auto w-full max-w-[1200px] px-6">
        {/* 16:9 from sm up. Below that the frame sizes to its content instead:
            a 16:9 box at phone width is 180px tall and would clip the lanes. */}
        <div
          className="no-grain w-full overflow-hidden rounded-[14px] border border-[var(--border-subtle)] bg-[var(--bg-inset)] sm:aspect-video"
          style={{ boxShadow: "var(--elev-3)" }}
        >
          <ThreeLaneHero />
        </div>
      </section>

      {/* (c) Built on ---------------------------------------------------- */}
      <section className="mx-auto w-full max-w-[1200px] px-6 py-16">
        <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
          <span className="mono text-[11px] font-medium uppercase leading-none tracking-[0.14em] text-[var(--fg-quaternary)]">
            Built on
          </span>
          {["Modal", "OpenAI", "Codex", "Greptile", "Stripe"].map((name) => (
            <span
              key={name}
              className="text-[15px] font-medium tracking-[-0.01em] text-[var(--fg-tertiary)]"
            >
              {name}
            </span>
          ))}
        </div>
      </section>

      {/* (d) How it works ------------------------------------------------ */}
      <Section
        id="how-it-works"
        eyebrow="How it works"
        title="A rollout is a hypothesis. This is the experiment."
        lede="One command builds three sandboxes from the same config, runs the same probes in each, and hands back a diff instead of a wall of logs."
      >
        <div className="relative">
          <div aria-hidden className="absolute inset-x-0 top-0 h-px bg-[var(--border-subtle)]" />
          <ol className="grid grid-cols-1 gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step) => (
              <li key={step.numeral} className="relative pt-7">
                <span
                  aria-hidden
                  className="absolute left-0 top-0 h-[9px] w-px bg-[var(--accent-400)]"
                />
                <p className="mono text-[11px] font-medium leading-none tracking-[0.14em] text-[var(--accent-400)]">
                  {step.numeral}
                </p>
                <h3 className="text-h4 mt-3 text-[var(--fg-primary)]">{step.title}</h3>
                <p className="text-body-sm mt-2 text-[var(--fg-tertiary)]">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </Section>

      {/* (e) Bento -------------------------------------------------------- */}
      <Section
        eyebrow="What you get"
        title="Everything a three-way diff needs, and nothing that fakes one."
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          <BentoCell className="lg:col-span-2">
            <h3 className="text-h4 text-[var(--fg-primary)]">Three lanes, one diff</h3>
            <p className="text-body-sm mt-2 text-[var(--fg-tertiary)]">
              Every probe runs against all three revisions from the same image and the same startup
              command, so any behavioural difference is attributable to the code and not to how the
              sandbox was built.
            </p>
            <ul className="mt-5 flex flex-col gap-3 border-t border-[var(--border-hairline)] pt-5">
              {VARIANT_ORDER.map((variant) => (
                <li key={variant} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <VariantBadge variant={variant} className="translate-y-[3px]" />
                  <span className="text-body-sm min-w-0 flex-1 text-[var(--fg-tertiary)]">
                    {VARIANT_META[variant].description}
                  </span>
                </li>
              ))}
            </ul>
          </BentoCell>

          <BentoCell>
            <h3 className="text-h4 text-[var(--fg-primary)]">Four presets, no setup</h3>
            <p className="text-body-sm mt-2 text-[var(--fg-tertiary)]">
              Presets are builders, not fixed probes: they read your endpoints out of sandman.toml
              and emit concrete probes for the routes you actually have.
            </p>
          </BentoCell>

          <BentoCell>
            <h3 className="text-h4 text-[var(--fg-primary)]">A real SDK, not a YAML dialect</h3>
            <p className="text-body-sm mt-2 text-[var(--fg-tertiary)]">
              Custom probes are async Python with fluent assertions. A failed expectation is
              recorded as evidence; an unexpected exception explicitly is not.
            </p>
          </BentoCell>

          <BentoCell className="lg:col-span-2">
            <h3 className="text-h4 text-[var(--fg-primary)]">Fan out until the flake shows itself</h3>
            <p className="text-body-sm mt-2 text-[var(--fg-tertiary)]">
              One request proves nothing. Each probe is replayed across the fan-out width in every
              lane, so contention bugs surface in a disposable sandbox rather than in your incident
              channel.
            </p>
            <dl className="mt-5 grid grid-cols-3 gap-4 border-t border-[var(--border-hairline)] pt-5">
              <Metric
                value={TEAM_LIMITS.maxFanoutWidth.toLocaleString("en-US")}
                label="units per lane"
              />
              <Metric
                value={TEAM_LIMITS.maxConcurrentSandboxes.toLocaleString("en-US")}
                label="concurrent sandboxes"
              />
              <Metric value={String(VARIANT_ORDER.length)} label="lanes, always" />
            </dl>
          </BentoCell>

          <BentoCell>
            <h3 className="text-h4 text-[var(--fg-primary)]">Budgets that hard-stop</h3>
            <p className="text-body-sm mt-2 text-[var(--fg-tertiary)]">
              Two independent ceilings — Modal’s container quota and a spend cap. Reach either and
              the run stops, rather than quietly costing more than the bug.
            </p>
          </BentoCell>

          <BentoCell>
            <h3 className="text-h4 text-[var(--fg-primary)]">Memory across runs</h3>
            <p className="text-body-sm mt-2 text-[var(--fg-tertiary)]">
              Verdicts, findings, and patches persist, so the next run already knows which failures
              were yours and which the previous cut brought with it.
            </p>
          </BentoCell>
        </div>
      </Section>

      {/* (f) The eight verdicts ------------------------------------------ */}
      <Section
        id="verdicts"
        eyebrow="The thesis"
        title="Two lanes tell you something broke. Three tell you whose fault it is."
        lede="Every probe produces a pass or a fail in each lane. Eight combinations, eight names — and only three of them are allowed to block a promotion."
      >
        <div className="overflow-hidden rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[var(--elev-1)]">
          <Table surface="surface">
            <TableHeader>
              <TableRow className="hover:bg-transparent hover:[&>td:first-child]:shadow-none">
                <TableHead>Verdict</TableHead>
                {VARIANT_ORDER.map((variant) => (
                  <TableHead key={variant} className="w-[52px]">
                    <span style={{ color: VARIANT_META[variant].color }}>
                      {VARIANT_META[variant].glyph}
                    </span>
                    <span className="sr-only"> {VARIANT_META[variant].label}</span>
                  </TableHead>
                ))}
                <TableHead>What it means</TableHead>
                <TableHead className="hidden md:table-cell">Gate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {CLASSIFICATION_ORDER.map((classification) => {
                const meta = CLASSIFICATION_META[classification]
                const [baseline, initial, hotfix] = meta.pattern
                const outcomes: Record<Variant, boolean> = { baseline, initial, hotfix }
                const blocks = isActionable(classification)

                return (
                  <TableRow key={classification}>
                    <TableCell className="whitespace-nowrap">
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: TONE_COLOR[meta.tone] }}
                        />
                        <span className="font-medium text-[var(--fg-primary)]">{meta.label}</span>
                      </span>
                    </TableCell>

                    {VARIANT_ORDER.map((variant) => (
                      <TableCell key={variant}>
                        <PatternCell variant={variant} passed={outcomes[variant]} />
                      </TableCell>
                    ))}

                    <TableCell className="min-w-[26ch]">{meta.blurb}</TableCell>

                    <TableCell className="hidden whitespace-nowrap md:table-cell">
                      <span
                        className="mono text-[11px] font-medium uppercase tracking-[0.14em]"
                        style={{
                          color: blocks
                            ? "var(--status-fail)"
                            : classification === "pre_existing"
                              ? "var(--variant-baseline)"
                              : "var(--fg-quaternary)",
                        }}
                      >
                        {blocks
                          ? "blocks promotion"
                          : classification === "pre_existing"
                            ? "reported only"
                            : "clear"}
                      </span>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>

        <p className="text-caption mt-4 text-[var(--fg-tertiary)]">
          B baseline · I initial · H hotfix — always in that order. Pre-existing is deliberately
          neutral rather than red: it is a real failure, but not this rollout’s, and colouring it
          like a regression is exactly the mistake the baseline lane exists to prevent.
        </p>
      </Section>

      {/* (g) Presets ------------------------------------------------------ */}
      <Section
        id="presets"
        eyebrow="Presets"
        title="Four suites ship with it. All read-only, all idempotent."
        lede="A probe runs many times against many replicas. One with side effects produces results that cannot be compared across variants, so nothing bundled has any."
      >
        <div className="grid gap-4 md:grid-cols-2">
          {PRESETS.map((preset) => (
            <div
              key={preset.id}
              className="flex flex-col rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 shadow-[var(--elev-1)]"
            >
              <p className="mono text-[13px] font-medium text-[var(--accent-400)]">{preset.id}</p>
              <p className="text-body-sm mt-3 flex-1 text-[var(--fg-secondary)]">
                {preset.description}
              </p>
              <p className="mono mt-5 border-t border-[var(--border-hairline)] pt-4 text-[12.5px] text-[var(--fg-quaternary)]">
                fanout {preset.fanout} · timeout {preset.timeoutSeconds}s
              </p>
            </div>
          ))}
        </div>
      </Section>

      {/* (h) SDK ---------------------------------------------------------- */}
      <Section
        id="sdk"
        eyebrow="Custom probes"
        title="When a preset cannot express it, write the probe."
        lede="A probe is an async function that exercises one behaviour and asserts what it expects. sandman runs the identical function in all three lanes — it never learns which one it is talking to, because a probe that could branch on the variant would stop being a fair comparison."
      >
        <div className="no-grain overflow-hidden rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-inset)]">
          <div className="flex items-center gap-2 border-b border-[var(--border-hairline)] px-4 py-2.5">
            <span className="mono text-[12.5px] text-[var(--fg-tertiary)]">probes/catalog.py</span>
            <span className="mono ml-auto text-[11px] uppercase tracking-[0.14em] text-[var(--fg-quaternary)]">
              python
            </span>
          </div>
          <div className="overflow-x-auto">
            <pre className="px-5 py-5">
              <code className="mono block text-[13px] leading-[1.7]">
                {SDK_SAMPLE.map((line, index) => (
                  <span key={index} className="block whitespace-pre">
                    {line.length === 0
                      ? " "
                      : line.map(([text, color], tokenIndex) => (
                          <span key={tokenIndex} style={{ color }}>
                            {text}
                          </span>
                        ))}
                  </span>
                ))}
              </code>
            </pre>
          </div>
        </div>

        <p className="text-caption mt-4 text-[var(--fg-tertiary)]">
          Point{" "}
          <span className="mono text-[12.5px] text-[var(--fg-secondary)]">custom_probe_paths</span>{" "}
          at the file and the decorator registers it. Target rejects auth headers and cookies
          outright — probes run against disposable replicas, never production.
        </p>
      </Section>

      {/* (i) Pricing ------------------------------------------------------ */}
      <Section
        id="pricing"
        eyebrow="Pricing"
        title="Priced on sandbox minutes, because that is what a run actually costs."
        lede="Every tier gets the three-way diff. The higher ones buy width, agent-authored hotfixes, and the policy gate."
      >
        <PricingCards />
        <p className="text-caption mt-6 text-[var(--fg-tertiary)]">
          Need the arithmetic?{" "}
          <Link href="/pricing" className="text-[var(--accent-400)] underline-offset-2 hover:underline">
            Project your monthly cost
          </Link>{" "}
          against each plan’s included allowance.
        </p>
      </Section>

      {/* (j) Final CTA ---------------------------------------------------- */}
      <section className="relative isolate overflow-hidden bg-[var(--bg-void)]">
        <div aria-hidden className="sodium-glow" />
        <div className="relative mx-auto w-full max-w-[1200px] px-6 py-28 text-center">
          <h2 className="text-display-2 mx-auto max-w-[620px] text-balance text-[var(--fg-primary)]">
            Ship the cut you can defend.
          </h2>
          <p className="text-body-lg mx-auto mt-5 max-w-[52ch] text-[var(--fg-secondary)]">
            Point sandman at a repository, name the previous LKG, and watch the diff decide.
          </p>
          <div className="mt-9 flex justify-center">
            <Button asChild variant="primary" size="lg">
              <Link href="/sign-up">Start a probe</Link>
            </Button>
          </div>
          <p className="text-caption mt-5 text-[var(--fg-tertiary)]">
            Free in beta · No card · Bring your own Modal + OpenAI keys
          </p>
        </div>
      </section>
    </>
  )
}

/* ---------------------------------------------------------------------------
 * Bento primitives
 * ------------------------------------------------------------------------ */

function BentoCell({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6",
        "shadow-[var(--elev-1)]",
        className,
      )}
    >
      {children}
    </div>
  )
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <dt className="sr-only">{label}</dt>
      <dd>
        <span data-numeric className="text-metric block text-[var(--fg-primary)]">
          {value}
        </span>
        <span className="text-caption mt-2 block text-[var(--fg-quaternary)]">{label}</span>
      </dd>
    </div>
  )
}
