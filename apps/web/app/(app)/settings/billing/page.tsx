/**
 * Billing.
 *
 * The usage figures come from our own `usage_counter` rows, never from Stripe.
 * Stripe processes meter events asynchronously and exposes no running total, so
 * a bar sourced from Stripe would lag by minutes and read as broken. Stripe is
 * still the authority on what gets invoiced; this page says so in a footnote
 * rather than pretending the two are the same number.
 */

import { PLANS } from "@/lib/plans"
import { overageUsd } from "@/lib/plans"
import { stripeMissingEnv } from "@/lib/stripe"
import { absoluteTime, formatRelativeTime, formatUsd } from "@/lib/utils"

import {
  Callout,
  Chip,
  DetailRow,
  Meter,
  PageHeader,
  Panel,
  PanelBody,
  PanelFooter,
  PanelHeader,
} from "../_ui"
import { currentUsage, organizationContext } from "../_data"
import { PlanCards, PortalButton } from "./_client"

export const dynamic = "force-dynamic"

const COMPACT_NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })

export default async function BillingSettingsPage() {
  const context = await organizationContext()
  const { organization, plan, subscriptionStatus, stripeSubscriptionId } = context
  const usage = await currentUsage(organization.id, context.currentPeriodStart)
  const missing = stripeMissingEnv()

  const sandboxMinutes = (usage?.sandboxSeconds ?? 0) / 60
  const agentTokens = usage?.agentTokens ?? 0
  const overage = overageUsd(plan, sandboxMinutes)

  return (
    <div className="flex max-w-[1100px] flex-col gap-5">
      <PageHeader
        title="Billing"
        description="What this workspace is on, what it has used this period, and what changing plan would cost."
      />

      {missing.length > 0 ? (
        <Callout tone="caution" title="Billing is not configured on this deployment">
          Checkout, the customer portal, and usage reporting are inactive until{" "}
          {missing.map((name, index) => (
            <span key={name}>
              {index > 0 ? ", " : ""}
              <code className="mono text-[12px] text-[var(--fg-primary)]">{name}</code>
            </span>
          ))}{" "}
          {missing.length === 1 ? "is" : "are"} set. Everything below still reflects this
          workspace&rsquo;s real plan and real usage — nothing here is a placeholder.
        </Callout>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel>
          <PanelHeader
            title={<span className="text-h4 text-[var(--fg-primary)]">Current plan</span>}
            description={plan.tagline}
            aside={
              <Chip
                color={
                  subscriptionStatus === "active" || subscriptionStatus === "trialing"
                    ? "var(--status-pass)"
                    : subscriptionStatus === "past_due" || subscriptionStatus === "unpaid"
                      ? "var(--status-fail)"
                      : undefined
                }
              >
                {subscriptionStatus.replace(/_/g, " ")}
              </Chip>
            }
          />
          <PanelBody>
            <div className="flex items-baseline gap-2">
              <span className="text-metric text-[var(--fg-primary)]">
                {formatUsd(plan.priceUsd)}
              </span>
              <span className="text-body-sm text-[var(--fg-tertiary)]">
                {plan.priceUsd === 0 ? "forever" : "per month"}
              </span>
            </div>

            <div className="border-t border-[var(--border-hairline)] pt-1">
              <DetailRow label="Plan">{plan.displayName}</DetailRow>
              {context.currentPeriodEnd ? (
                <DetailRow label={context.cancelAtPeriodEnd ? "Ends" : "Renews"}>
                  <span title={absoluteTime(context.currentPeriodEnd)}>
                    {formatRelativeTime(context.currentPeriodEnd)}
                  </span>
                </DetailRow>
              ) : null}
              <DetailRow label="Concurrency ceiling">
                <span className="mono" data-numeric="">
                  {plan.maxConcurrentSandboxes}
                </span>{" "}
                sandboxes · {" "}
                <span className="mono" data-numeric="">
                  {COMPACT_NUMBER.format(plan.maxFanoutWidth)}
                </span>{" "}
                wide
              </DetailRow>
              <DetailRow label="Per-run ceiling">{formatUsd(plan.maxUsdPerRun)}</DetailRow>
              {overage > 0 ? (
                <DetailRow label="Overage this period">{formatUsd(overage)}</DetailRow>
              ) : null}
            </div>

            {context.cancelAtPeriodEnd ? (
              <Callout tone="caution" title="Cancellation scheduled">
                This subscription ends at the close of the current period and the workspace drops to
                Free. Reactivating from the portal before then keeps everything as it is.
              </Callout>
            ) : null}
          </PanelBody>
          <PanelFooter>
            <span className="text-caption text-[var(--fg-tertiary)]">
              Invoices, receipts, and payment methods.
            </span>
            <PortalButton disabled={missing.length > 0 || !organization.stripeCustomerId} />
          </PanelFooter>
        </Panel>

        <Panel>
          <PanelHeader
            title={<span className="text-h4 text-[var(--fg-primary)]">Usage this period</span>}
            description={
              context.currentPeriodStart
                ? `Since ${absoluteTime(context.currentPeriodStart)}.`
                : "Since this workspace was created."
            }
          />
          <PanelBody>
            <Meter
              label="Sandbox minutes"
              value={sandboxMinutes}
              limit={plan.includedSandboxMinutes}
              readout={`${COMPACT_NUMBER.format(sandboxMinutes)} / ${COMPACT_NUMBER.format(plan.includedSandboxMinutes)}`}
            />
            <Meter
              label="Agent tokens"
              value={agentTokens}
              limit={plan.includedAgentTokens}
              readout={`${COMPACT_NUMBER.format(agentTokens)} / ${COMPACT_NUMBER.format(plan.includedAgentTokens)}`}
            />

            <div className="border-t border-[var(--border-hairline)] pt-1">
              <DetailRow label="Probe runs">
                <span className="mono" data-numeric="">
                  {COMPACT_NUMBER.format(usage?.probeRuns ?? 0)}
                </span>
              </DetailRow>
              <DetailRow label="Spend recorded">{formatUsd(usage?.usdSpent ?? 0)}</DetailRow>
              <DetailRow label="Beyond the allowance">
                {plan.overageUsdPerSandboxMinute === null
                  ? "Runs are refused rather than billed"
                  : `${formatUsd(plan.overageUsdPerSandboxMinute)} per sandbox minute`}
              </DetailRow>
            </div>

            <p className="text-caption border-t border-[var(--border-hairline)] pt-3 text-[var(--fg-tertiary)]">
              Read from sandman&rsquo;s own counters, updated as runs finish. Stripe processes meter
              events asynchronously and publishes no real-time total, so your invoice is reconciled
              by Stripe and can differ from the figure above until the period closes.
            </p>
          </PanelBody>
        </Panel>
      </div>

      <PlanCards
        plans={[PLANS.free, PLANS.pro, PLANS.team]}
        currentPlanId={plan.id}
        hasSubscription={Boolean(stripeSubscriptionId)}
        disabled={missing.length > 0}
      />
    </div>
  )
}
