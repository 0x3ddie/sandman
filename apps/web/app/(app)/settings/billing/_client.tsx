"use client"

import * as React from "react"
import { Check } from "phosphor-react"

import { Button } from "@/components/ui/button"
import type { Plan, PlanId } from "@/lib/plans"
import { cn, formatUsdCompact } from "@/lib/utils"

import { switchPlan } from "../_actions"
import { ActionForm, HiddenValue, StripeRedirectButton, SubmitButton } from "../_controls"
import { Chip, Panel, PanelBody, PanelHeader } from "../_ui"

export function PortalButton({ disabled }: { disabled: boolean }) {
  return (
    <StripeRedirectButton endpoint="/api/billing/portal" variant="secondary" disabled={disabled}>
      Open customer portal
    </StripeRedirectButton>
  )
}

/**
 * The pricing cards, doubling as the plan switcher.
 *
 * A workspace with no Stripe subscription goes through Checkout; one that
 * already has a subscription goes through `subscriptions.update`, because the
 * Customer Portal refuses to modify a subscription containing a usage-based
 * price and would hand the customer a button that errors.
 */
export function PlanCards({
  plans,
  currentPlanId,
  hasSubscription,
  disabled,
}: {
  plans: readonly Plan[]
  currentPlanId: PlanId
  hasSubscription: boolean
  disabled: boolean
}) {
  const current = plans.find((plan) => plan.id === currentPlanId)

  return (
    <Panel>
      <PanelHeader
        title={<span className="text-h4 text-[var(--fg-primary)]">Plans</span>}
        description="Every plan runs the same three-way comparison. What changes is how wide the fan-out goes and how much of the remediation loop is available."
      />
      <PanelBody>
        <div className="grid gap-4 lg:grid-cols-3">
          {plans.map((plan) => {
            const isCurrent = plan.id === currentPlanId
            const isUpgrade = current ? plan.rank > current.rank : plan.rank > 0

            return (
              <div
                key={plan.id}
                className={cn(
                  "flex flex-col rounded-[8px] border p-4",
                  isCurrent
                    ? "border-[var(--accent-border)] bg-[var(--accent-wash)]"
                    : "border-[var(--border-subtle)] bg-[var(--bg-raised)]",
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h4 className="text-h4 text-[var(--fg-primary)]">{plan.displayName}</h4>
                  {isCurrent ? <Chip color="var(--accent-400)">current</Chip> : null}
                </div>

                <div className="mt-2 flex items-baseline gap-1.5">
                  <span className="text-metric text-[var(--fg-primary)]">
                    {formatUsdCompact(plan.priceUsd)}
                  </span>
                  <span className="text-caption text-[var(--fg-tertiary)]">
                    {plan.priceUsd === 0 ? "forever" : "/ month"}
                  </span>
                </div>

                <p className="text-body-sm mt-2 min-h-[3rem] text-[var(--fg-tertiary)]">
                  {plan.tagline}
                </p>

                <ul className="mt-3 flex flex-1 flex-col gap-1.5">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2">
                      <Check
                        size={16}
                        weight="regular"
                        color={isCurrent ? "var(--accent-400)" : "var(--fg-quaternary)"}
                        aria-hidden
                        className="mt-[2px] shrink-0"
                      />
                      <span className="text-body-sm text-[var(--fg-secondary)]">{feature}</span>
                    </li>
                  ))}
                </ul>

                <div className="mt-4">
                  <PlanAction
                    plan={plan}
                    isCurrent={isCurrent}
                    isUpgrade={isUpgrade}
                    hasSubscription={hasSubscription}
                    disabled={disabled}
                  />
                </div>
              </div>
            )
          })}
        </div>

        <p className="text-caption border-t border-[var(--border-hairline)] pt-3 text-[var(--fg-tertiary)]">
          Moving between paid plans is prorated on the next invoice and takes effect immediately.
          Returning to Free is a cancellation: it takes effect at the end of the current period, from
          the customer portal.
        </p>
      </PanelBody>
    </Panel>
  )
}

function PlanAction({
  plan,
  isCurrent,
  isUpgrade,
  hasSubscription,
  disabled,
}: {
  plan: Plan
  isCurrent: boolean
  isUpgrade: boolean
  hasSubscription: boolean
  disabled: boolean
}) {
  if (isCurrent) {
    return (
      <Button variant="secondary" size="md" disabled className="w-full">
        Current plan
      </Button>
    )
  }

  if (plan.id === "free") {
    return (
      <StripeRedirectButton
        endpoint="/api/billing/portal"
        variant="ghost"
        disabled={disabled || !hasSubscription}
        className="w-full"
      >
        Cancel from the portal
      </StripeRedirectButton>
    )
  }

  if (!hasSubscription) {
    return (
      <StripeRedirectButton
        endpoint="/api/billing/checkout"
        body={{ plan: plan.id }}
        variant={isUpgrade ? "primary" : "secondary"}
        disabled={disabled}
        className="w-full"
      >
        Choose {plan.displayName}
      </StripeRedirectButton>
    )
  }

  return (
    <ActionForm action={switchPlan}>
      <HiddenValue name="plan" value={plan.id} />
      <SubmitButton
        variant={isUpgrade ? "primary" : "secondary"}
        pendingLabel="Updating…"
        className="w-full"
      >
        {isUpgrade ? `Upgrade to ${plan.displayName}` : `Move to ${plan.displayName}`}
      </SubmitButton>
    </ActionForm>
  )
}
