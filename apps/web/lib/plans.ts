/**
 * The three plans, and the numbers behind them.
 *
 * Stripe Entitlements answer exactly one question — does this customer have
 * feature X — and carry no numbers at all. So the ceilings live here, keyed by
 * the same feature lookup keys Stripe hands back, and the subscription row
 * caches only the key list. Billing stays Stripe's job; deciding what 3,000
 * included sandbox minutes means stays ours.
 *
 * Everything a run enforces (`maxConcurrentSandboxes`, `maxFanoutWidth`,
 * `maxUsdPerRun`) maps onto `BudgetCaps` in the control plane, which is where
 * the ceiling is actually applied.
 */

export type PlanId = "free" | "pro" | "team"

/**
 * Stripe feature lookup keys. One per capability, stable forever — renaming one
 * silently downgrades every customer who has it.
 */
export const FEATURE = {
  THREE_WAY_DIFF: "three_way_diff",
  PROBE_PRESETS: "probe_presets",
  CUSTOM_PROBES: "custom_probes",
  HOTFIX_AUTHORING: "hotfix_authoring",
  GREPTILE_REVIEW: "greptile_review",
  AUTO_PROMOTION: "auto_promotion",
  PERSISTENT_MEMORY: "persistent_memory",
  GITHUB_CHECKS: "github_checks",
  SCHEDULED_RUNS: "scheduled_runs",
  MULTI_REGION_FANOUT: "multi_region_fanout",
  ENCRYPTED_SECRETS: "encrypted_secrets",
  AUDIT_LOG: "audit_log",
  SSO: "sso",
  PRIORITY_SUPPORT: "priority_support",
} as const

export type FeatureKey = (typeof FEATURE)[keyof typeof FEATURE]

/** The entitlement key that identifies the tier itself. */
export const PLAN_ENTITLEMENT: Record<PlanId, string> = {
  free: "plan_free",
  pro: "plan_pro",
  team: "plan_team",
}

export interface PlanLimits {
  /** Sandbox minutes included in the monthly price. */
  includedSandboxMinutes: number
  /** Agent tokens included — hotfix authoring and breadth analysis both draw. */
  includedAgentTokens: number
  /**
   * Per-minute price beyond the included allowance. `null` means the plan hard
   * stops at its ceiling rather than billing overage — that is the free tier's
   * behaviour and it is not a discount.
   */
  overageUsdPerSandboxMinute: number | null
  /** Modal container ceiling for one run. */
  maxConcurrentSandboxes: number
  /** Largest `replicas × fanout` a single run may request. */
  maxFanoutWidth: number
  /** Hard spend ceiling for one run, enforced by the control plane's budget. */
  maxUsdPerRun: number
}

export interface Plan extends PlanLimits {
  id: PlanId
  displayName: string
  priceUsd: number
  /** Higher wins when several tier entitlements are present at once. */
  rank: number
  tagline: string
  /** Human-readable, in pricing-table order. */
  features: string[]
  entitlementKeys: string[]
}

const FREE_FEATURES: string[] = [
  PLAN_ENTITLEMENT.free,
  FEATURE.THREE_WAY_DIFF,
  FEATURE.PROBE_PRESETS,
  FEATURE.PERSISTENT_MEMORY,
]

const PRO_FEATURES: string[] = [
  PLAN_ENTITLEMENT.pro,
  FEATURE.THREE_WAY_DIFF,
  FEATURE.PROBE_PRESETS,
  FEATURE.CUSTOM_PROBES,
  FEATURE.HOTFIX_AUTHORING,
  FEATURE.GREPTILE_REVIEW,
  FEATURE.PERSISTENT_MEMORY,
  FEATURE.GITHUB_CHECKS,
  FEATURE.ENCRYPTED_SECRETS,
  FEATURE.SCHEDULED_RUNS,
]

const TEAM_FEATURES: string[] = [
  PLAN_ENTITLEMENT.team,
  ...PRO_FEATURES.filter((key) => key !== PLAN_ENTITLEMENT.pro),
  FEATURE.AUTO_PROMOTION,
  FEATURE.MULTI_REGION_FANOUT,
  FEATURE.AUDIT_LOG,
  FEATURE.SSO,
  FEATURE.PRIORITY_SUPPORT,
]

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    displayName: "Free",
    priceUsd: 0,
    rank: 0,
    tagline: "Diff a rollout against the last one and see what it broke.",
    includedSandboxMinutes: 500,
    includedAgentTokens: 250_000,
    overageUsdPerSandboxMinute: null,
    maxConcurrentSandboxes: 5,
    maxFanoutWidth: 20,
    maxUsdPerRun: 1,
    features: [
      "Baseline / initial three-way probing",
      "All built-in probe presets",
      "500 sandbox minutes each month",
      "5 concurrent sandboxes, 20-wide fan-out",
      "Persistent memory across runs",
    ],
    entitlementKeys: FREE_FEATURES,
  },
  pro: {
    id: "pro",
    displayName: "Pro",
    priceUsd: 49,
    rank: 1,
    tagline: "Agent-authored hotfixes, reviewed and re-probed before they ship.",
    includedSandboxMinutes: 3_000,
    includedAgentTokens: 5_000_000,
    overageUsdPerSandboxMinute: 0.015,
    maxConcurrentSandboxes: 25,
    maxFanoutWidth: 400,
    maxUsdPerRun: 5,
    features: [
      "Everything in Free",
      "Agent-authored hotfix branches and pull requests",
      "Greptile review gating on every patch",
      "Custom probes through the SDK",
      "GitHub checks on rollout branches",
      "Encrypted project secrets",
      "3,000 sandbox minutes, then $0.015 per minute",
      "25 concurrent sandboxes, 400-wide fan-out",
    ],
    entitlementKeys: PRO_FEATURES,
  },
  team: {
    id: "team",
    displayName: "Team",
    priceUsd: 199,
    rank: 2,
    tagline: "Fan-out at production width, with the promotion gate under policy.",
    includedSandboxMinutes: 15_000,
    includedAgentTokens: 30_000_000,
    overageUsdPerSandboxMinute: 0.012,
    maxConcurrentSandboxes: 100,
    maxFanoutWidth: 4_000,
    maxUsdPerRun: 25,
    features: [
      "Everything in Pro",
      "Policy-gated automatic promotion to LKG",
      "Multi-region fan-out",
      "15,000 sandbox minutes, then $0.012 per minute",
      "100 concurrent sandboxes, 4,000-wide fan-out",
      "Audit log and SSO",
      "Priority support",
    ],
    entitlementKeys: TEAM_FEATURES,
  },
}

/** Cheapest first — pricing-table order. */
export const PLAN_ORDER: readonly PlanId[] = ["free", "pro", "team"] as const

export function isPlanId(value: string): value is PlanId {
  return value === "free" || value === "pro" || value === "team"
}

/**
 * The plan a customer's cached entitlements describe.
 *
 * Highest rank wins: during an upgrade Stripe can briefly report both tiers, and
 * resolving that downward would throttle a customer who has already paid.
 */
export function planFor(entitlements: string[]): Plan {
  const granted = new Set(entitlements)
  let resolved = PLANS.free
  for (const id of PLAN_ORDER) {
    if (granted.has(PLAN_ENTITLEMENT[id]) && PLANS[id].rank > resolved.rank) {
      resolved = PLANS[id]
    }
  }
  return resolved
}

/** The numeric ceilings only — what a run's budget is built from. */
export function limitsFor(plan: Plan | PlanId): PlanLimits {
  const resolved = typeof plan === "string" ? PLANS[plan] : plan
  return {
    includedSandboxMinutes: resolved.includedSandboxMinutes,
    includedAgentTokens: resolved.includedAgentTokens,
    overageUsdPerSandboxMinute: resolved.overageUsdPerSandboxMinute,
    maxConcurrentSandboxes: resolved.maxConcurrentSandboxes,
    maxFanoutWidth: resolved.maxFanoutWidth,
    maxUsdPerRun: resolved.maxUsdPerRun,
  }
}

/**
 * Whether a capability is available.
 *
 * Checked against the entitlement list rather than the plan, so a customer with
 * a one-off feature grant keeps it without being moved to another tier.
 */
export function hasFeature(entitlements: string[], feature: FeatureKey): boolean {
  return entitlements.includes(feature)
}

/** Overage owed for a period, in USD. Zero when the plan hard stops instead. */
export function overageUsd(plan: Plan | PlanId, sandboxMinutesUsed: number): number {
  const limits = limitsFor(plan)
  if (limits.overageUsdPerSandboxMinute === null) return 0
  const excess = Math.max(0, sandboxMinutesUsed - limits.includedSandboxMinutes)
  return excess * limits.overageUsdPerSandboxMinute
}
