/**
 * The shared vocabulary for the three-way diff.
 *
 * Every component that renders a variant imports from here rather than
 * hard-coding a colour, because a variant is never encoded by colour alone. It
 * carries three redundant channels at once: the colour, a fixed mono glyph
 * (B/I/H), and a fixed left-to-right B → I → H order. Steel / sky / sodium is
 * the triad that survives deuteranopia, protanopia, and tritanopia; the glyph
 * and the order are what survive a greyscale print-out.
 *
 * The classification table mirrors `sandman.models.Classification` in the
 * control plane exactly — same eight names, same severity ordering. If one side
 * changes, both change.
 */

/* ---------------------------------------------------------------------------
 * Variants
 * ------------------------------------------------------------------------ */

export type Variant = "baseline" | "initial" | "hotfix"

/** Never reorder. The order is a load-bearing part of the encoding. */
export const VARIANT_ORDER: readonly Variant[] = ["baseline", "initial", "hotfix"] as const

export interface VariantMeta {
  glyph: "B" | "I" | "H"
  label: string
  /** CSS custom property reference, so the token file stays the one source. */
  color: string
  wash: string
  border: string
  description: string
}

export const VARIANT_META: Record<Variant, VariantMeta> = {
  baseline: {
    glyph: "B",
    label: "Baseline",
    color: "var(--variant-baseline)",
    wash: "var(--variant-baseline-wash)",
    border: "var(--variant-baseline-border)",
    description: "The previous LKG — what was already broken before this cut.",
  },
  initial: {
    glyph: "I",
    label: "Initial",
    color: "var(--variant-initial)",
    wash: "var(--variant-initial-wash)",
    border: "var(--variant-initial-border)",
    description: "The current LKG, unmodified — the code this rollout ships.",
  },
  hotfix: {
    glyph: "H",
    label: "Hotfix",
    color: "var(--variant-hotfix)",
    wash: "var(--variant-hotfix-wash)",
    border: "var(--variant-hotfix-border)",
    description: "The current LKG plus the agent-authored patch.",
  },
}

export function isVariant(value: string): value is Variant {
  return value === "baseline" || value === "initial" || value === "hotfix"
}

/** Sort key for anything keyed by variant, so B → I → H never varies. */
export function variantOrder(variant: Variant): number {
  return VARIANT_ORDER.indexOf(variant)
}

/* ---------------------------------------------------------------------------
 * Classifications
 * ------------------------------------------------------------------------ */

export type Classification =
  | "restored"
  | "fixed"
  | "regression"
  | "hotfix_induced"
  | "still_broken"
  | "pre_existing"
  | "self_healed"
  | "stable"

export type Tone = "pass" | "fail" | "flaky" | "neutral"

export interface ClassificationMeta {
  label: string
  /** Lower sorts first. The worst news is always on top. */
  severity: number
  tone: Tone
  blurb: string
  /** The (baseline, initial, hotfix) pass triple that produces this verdict. */
  pattern: [boolean, boolean, boolean]
}

export const CLASSIFICATION_META: Record<Classification, ClassificationMeta> = {
  regression: {
    label: "Regression",
    severity: 0,
    tone: "fail",
    blurb: "Passed before and after the rollout; the hotfix broke it.",
    pattern: [true, true, false],
  },
  hotfix_induced: {
    label: "Hotfix-induced",
    severity: 1,
    tone: "fail",
    blurb: "The rollout had fixed this. The hotfix brought the old failure back.",
    pattern: [false, true, false],
  },
  still_broken: {
    label: "Still broken",
    severity: 2,
    tone: "fail",
    blurb: "This rollout broke it and the patch did not work.",
    pattern: [true, false, false],
  },
  pre_existing: {
    // Neutral, not fail: this is a real failure but not *this* rollout's fault,
    // and colouring it like a regression is exactly the mistake the baseline
    // lane exists to prevent.
    label: "Pre-existing",
    severity: 3,
    tone: "neutral",
    blurb: "Broken before this cut. Reported, never auto-patched.",
    pattern: [false, false, false],
  },
  self_healed: {
    label: "Self-healed",
    severity: 4,
    tone: "flaky",
    blurb: "Failed on the baseline and passes now with no patch. Suspect a flake.",
    pattern: [false, true, true],
  },
  restored: {
    label: "Restored",
    severity: 5,
    tone: "pass",
    blurb: "The rollout broke it; the hotfix put it back. The happy path.",
    pattern: [true, false, true],
  },
  fixed: {
    label: "Fixed",
    severity: 6,
    tone: "pass",
    blurb: "A long-standing failure the hotfix resolved along the way.",
    pattern: [false, false, true],
  },
  stable: {
    label: "Stable",
    severity: 7,
    tone: "pass",
    blurb: "Passed in all three lanes.",
    pattern: [true, true, true],
  },
}

/** Every classification, worst first. */
export const CLASSIFICATION_ORDER: readonly Classification[] = (
  Object.keys(CLASSIFICATION_META) as Classification[]
)
  .slice()
  .sort((a, b) => CLASSIFICATION_META[a].severity - CLASSIFICATION_META[b].severity)

export function isClassification(value: string): value is Classification {
  return value in CLASSIFICATION_META
}

/** The same matrix the control plane uses, for locally derived rows. */
export function classify(baseline: boolean, initial: boolean, hotfix: boolean): Classification {
  const key = `${Number(baseline)}${Number(initial)}${Number(hotfix)}`
  const matrix: Record<string, Classification> = {
    "101": "restored",
    "001": "fixed",
    "110": "regression",
    "010": "hotfix_induced",
    "100": "still_broken",
    "000": "pre_existing",
    "011": "self_healed",
    "111": "stable",
  }
  return matrix[key] ?? "stable"
}

/** Blocks promotion to LKG. */
export function isActionable(classification: Classification): boolean {
  return (
    classification === "regression" ||
    classification === "hotfix_induced" ||
    classification === "still_broken"
  )
}

/**
 * Whether the current rollout introduced the failure.
 *
 * `pre_existing` is deliberately excluded — that is the entire reason the
 * baseline lane exists.
 */
export function blamesRollout(classification: Classification): boolean {
  return (
    classification === "restored" ||
    classification === "regression" ||
    classification === "still_broken"
  )
}

export function compareBySeverity(a: Classification, b: Classification): number {
  return CLASSIFICATION_META[a].severity - CLASSIFICATION_META[b].severity
}

/* ---------------------------------------------------------------------------
 * Sandbox status
 * ------------------------------------------------------------------------ */

export type SandboxStatus =
  | "queued"
  | "provisioning"
  | "running"
  | "passed"
  | "failed"
  | "flaky"
  | "skipped"
  | "error"
  | "timed_out"

/**
 * `running` and `provisioning` get their own tones: Modal cold starts take
 * several seconds, and collapsing the two makes the opening moments of a run
 * look like a hung UI. `running` owns the brand accent, which is why amber is
 * absent from the failure palette entirely.
 */
export type StatusTone = Tone | "running" | "progress"

export interface StatusMeta {
  label: string
  color: string
  wash: string
  tone: StatusTone
  /** Terminal states stop animating and stop being polled. */
  terminal: boolean
}

export const STATUS_META: Record<SandboxStatus, StatusMeta> = {
  queued: {
    label: "Queued",
    color: "var(--status-queued)",
    wash: "var(--status-queued-wash)",
    tone: "neutral",
    terminal: false,
  },
  provisioning: {
    label: "Provisioning",
    color: "var(--status-provisioning)",
    wash: "var(--status-provisioning-wash)",
    tone: "progress",
    terminal: false,
  },
  running: {
    label: "Running",
    color: "var(--status-running)",
    wash: "var(--status-running-wash)",
    tone: "running",
    terminal: false,
  },
  passed: {
    label: "Passed",
    color: "var(--status-pass)",
    wash: "var(--status-pass-wash)",
    tone: "pass",
    terminal: true,
  },
  failed: {
    label: "Failed",
    color: "var(--status-fail)",
    wash: "var(--status-fail-wash)",
    tone: "fail",
    terminal: true,
  },
  flaky: {
    label: "Flaky",
    color: "var(--status-flaky)",
    wash: "var(--status-flaky-wash)",
    tone: "flaky",
    terminal: true,
  },
  skipped: {
    label: "Skipped",
    color: "var(--status-skipped)",
    wash: "var(--status-queued-wash)",
    tone: "neutral",
    terminal: true,
  },
  error: {
    label: "Error",
    color: "var(--status-fail)",
    wash: "var(--status-fail-wash)",
    tone: "fail",
    terminal: true,
  },
  timed_out: {
    label: "Timed out",
    color: "var(--status-fail)",
    wash: "var(--status-fail-wash)",
    tone: "fail",
    terminal: true,
  },
}

export function isSandboxStatus(value: string): value is SandboxStatus {
  return value in STATUS_META
}

/* ---------------------------------------------------------------------------
 * Run state
 * ------------------------------------------------------------------------ */

export type RunState =
  | "queued"
  | "provisioning"
  | "probing"
  | "comparing"
  | "remediating"
  | "reviewing"
  | "verifying"
  | "completed"
  | "failed"
  | "aborted"

export const RUN_STATE_META: Record<RunState, { label: string; color: string; terminal: boolean }> =
  {
    queued: { label: "Queued", color: "var(--status-queued)", terminal: false },
    provisioning: { label: "Provisioning", color: "var(--status-provisioning)", terminal: false },
    probing: { label: "Probing", color: "var(--status-running)", terminal: false },
    comparing: { label: "Comparing", color: "var(--status-running)", terminal: false },
    remediating: { label: "Remediating", color: "var(--status-running)", terminal: false },
    reviewing: { label: "Reviewing", color: "var(--status-running)", terminal: false },
    verifying: { label: "Verifying", color: "var(--status-running)", terminal: false },
    completed: { label: "Completed", color: "var(--status-pass)", terminal: true },
    failed: { label: "Failed", color: "var(--status-fail)", terminal: true },
    aborted: { label: "Aborted", color: "var(--status-skipped)", terminal: true },
  }

export function isRunState(value: string): value is RunState {
  return value in RUN_STATE_META
}

/** The phase order the waterfall renders, excluding terminal states. */
export const RUN_PHASE_ORDER: readonly RunState[] = [
  "queued",
  "provisioning",
  "probing",
  "comparing",
  "remediating",
  "reviewing",
  "verifying",
] as const
