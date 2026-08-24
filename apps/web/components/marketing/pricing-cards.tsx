import Link from "next/link"

import { Button } from "@/components/ui/button"
import {
  FEATURE,
  PLANS,
  PLAN_ORDER,
  hasFeature,
  limitsFor,
  type FeatureKey,
  type Plan,
} from "@/lib/plans"
import { cn, formatUsdCompact } from "@/lib/utils"

/**
 * The capabilities worth showing as *absent* on a cheaper card. Derived from the
 * entitlement lists rather than typed out per plan, so adding a feature to a
 * tier in lib/plans updates both halves of every card at once.
 */
const HEADLINE_CAPABILITIES: readonly { key: FeatureKey; label: string }[] = [
  { key: FEATURE.CUSTOM_PROBES, label: "Custom probes through the SDK" },
  { key: FEATURE.HOTFIX_AUTHORING, label: "Agent-authored hotfix branches" },
  { key: FEATURE.GREPTILE_REVIEW, label: "Greptile review gating" },
  { key: FEATURE.GITHUB_CHECKS, label: "GitHub checks on rollout branches" },
  { key: FEATURE.AUTO_PROMOTION, label: "Policy-gated promotion to LKG" },
  { key: FEATURE.MULTI_REGION_FANOUT, label: "Multi-region fan-out" },
  { key: FEATURE.AUDIT_LOG, label: "Audit log and SSO" },
]

function missingFor(plan: Plan): readonly string[] {
  return HEADLINE_CAPABILITIES.filter(
    (capability) => !hasFeature(plan.entitlementKeys, capability.key),
  ).map((capability) => capability.label)
}

/**
 * phosphor-react resolves its defaults through React context, so it cannot be
 * imported into a Server Component. A 14px inline check matching phosphor's
 * regular weight keeps this card on the server.
 */
function Check() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className="mt-[4px] shrink-0"
    >
      <path
        d="M3.25 8.5 6.4 11.6 12.75 4.9"
        stroke="var(--status-pass)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export interface PricingCardsProps {
  /** Renders each card's hard ceilings under the feature list. */
  showLimits?: boolean
  className?: string
}

export function PricingCards({ showLimits = false, className }: PricingCardsProps) {
  return (
    <div className={cn("grid gap-4 md:grid-cols-3", className)}>
      {PLAN_ORDER.map((id, index) => {
        const plan = PLANS[id]
        const limits = limitsFor(plan)
        // The middle card carries the emphasis; the mid tier is the one most
        // teams land on, and a highlighted end card reads as an upsell.
        const featured = index === 1
        const missing = missingFor(plan)

        return (
          <div
            key={id}
            className={cn(
              "relative flex flex-col rounded-[10px] border p-6",
              featured
                ? "border-[var(--accent-border)]"
                : "border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[var(--elev-1)]",
            )}
            style={
              featured
                ? {
                    backgroundColor: "color-mix(in srgb, var(--accent-400) 4%, var(--bg-surface))",
                    boxShadow: "var(--glow-accent)",
                  }
                : undefined
            }
          >
            {featured ? (
              <span className="mono absolute -top-[11px] left-1/2 flex h-[22px] -translate-x-1/2 items-center rounded-[6px] bg-[var(--accent-400)] px-2.5 text-[11px] font-medium uppercase leading-none tracking-[0.14em] text-[var(--bg-base)]">
                Most popular
              </span>
            ) : null}

            <h3 className="text-h4 text-[var(--fg-primary)]">{plan.displayName}</h3>
            <p className="text-body-sm mt-1 min-h-[40px] text-[var(--fg-tertiary)]">
              {plan.tagline}
            </p>

            <div className="mt-6 flex items-baseline gap-2">
              <span
                data-numeric
                className="text-[44px] font-medium leading-none tracking-[-0.03em] text-[var(--fg-primary)]"
              >
                {formatUsdCompact(plan.priceUsd)}
              </span>
              <span className="text-caption text-[var(--fg-tertiary)]">
                {plan.priceUsd === 0 ? "always free" : "/ month"}
              </span>
            </div>

            <div className="mt-6">
              <Button
                asChild
                variant={featured ? "primary" : "secondary"}
                size="lg"
                className="w-full"
              >
                <Link href={`/sign-up?plan=${plan.id}`}>
                  {plan.priceUsd === 0 ? "Start free" : `Start on ${plan.displayName}`}
                </Link>
              </Button>
            </div>

            <ul className="mt-6 flex flex-col gap-2.5">
              {plan.features.map((feature) => (
                <li key={feature} className="flex gap-2.5">
                  <Check />
                  <span className="text-[13.5px] leading-[1.5] text-[var(--fg-secondary)]">
                    {feature}
                  </span>
                </li>
              ))}

              {/* No red cross: a rose ✗ next to a feature reads as a failing
                  probe, which is the one thing this product's palette means. */}
              {missing.map((label) => (
                <li key={label} className="flex gap-2.5">
                  <span aria-hidden className="w-[14px] shrink-0" />
                  <span className="text-[13.5px] leading-[1.5] text-[var(--fg-quaternary)]">
                    {label}
                  </span>
                </li>
              ))}
            </ul>

            {showLimits ? (
              <dl className="mt-6 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-[var(--border-hairline)] pt-5">
                <Limit label="Included minutes" value={limits.includedSandboxMinutes.toLocaleString("en-US")} />
                <Limit
                  label="Overage / min"
                  value={
                    limits.overageUsdPerSandboxMinute === null
                      ? "hard stop"
                      : `$${limits.overageUsdPerSandboxMinute.toFixed(3)}`
                  }
                />
                <Limit label="Max fan-out" value={limits.maxFanoutWidth.toLocaleString("en-US")} />
                <Limit label="Cap per run" value={formatUsdCompact(limits.maxUsdPerRun)} />
              </dl>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function Limit({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="mono text-[11px] font-medium uppercase leading-none tracking-[0.14em] text-[var(--fg-quaternary)]">
        {label}
      </dt>
      <dd data-numeric className="mt-1.5 text-[13px] text-[var(--fg-secondary)]">
        {value}
      </dd>
    </div>
  )
}
