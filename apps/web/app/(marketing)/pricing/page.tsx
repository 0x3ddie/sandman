import type { Metadata } from "next"
import Link from "next/link"

import { CostCalculator } from "@/components/marketing/cost-calculator"
import { PricingCards } from "@/components/marketing/pricing-cards"
import { Button } from "@/components/ui/button"
import { PLANS, PLAN_ORDER, limitsFor } from "@/lib/plans"

export const metadata: Metadata = {
  title: "Pricing — sandman",
  description:
    "Every tier gets the three-way diff. Sandbox minutes are metered; project your monthly cost against each plan’s included allowance.",
}

/** Plans that bill overage rather than hard-stopping, cheapest tier first. */
const METERED = PLAN_ORDER.map((id) => PLANS[id]).filter(
  (plan) => plan.overageUsdPerSandboxMinute !== null,
)

export default function PricingPage() {
  return (
    <>
      <section className="relative isolate overflow-hidden">
        <div aria-hidden className="sodium-glow" />
        <div className="relative mx-auto w-full max-w-[1200px] px-6 pb-16 pt-28 text-center">
          <p className="text-eyebrow text-[var(--accent-400)]">Pricing</p>
          <h1 className="text-display-2 mx-auto mt-5 max-w-[660px] text-balance text-[var(--fg-primary)]">
            Pay for sandbox minutes. Not for seats.
          </h1>
          <p className="text-body-lg mx-auto mt-5 max-w-[56ch] text-[var(--fg-secondary)]">
            A run costs what its sandboxes cost. Every plan includes the full three-way diff; the
            higher tiers buy fan-out width, agent-authored hotfixes, and the promotion gate.
          </p>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1200px] px-6 pb-24">
        <PricingCards showLimits />
      </section>

      {/* Usage meter explainer ------------------------------------------- */}
      <section className="border-t border-[var(--border-hairline)]">
        <div className="mx-auto w-full max-w-[1200px] px-6 py-24">
          <div className="flex flex-col gap-8 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-8 shadow-[var(--elev-1)] lg:flex-row lg:items-center">
            <div className="lg:max-w-[46ch]">
              <p className="text-eyebrow text-[var(--fg-tertiary)]">Metered usage</p>
              <h2 className="text-h2 mt-4 text-[var(--fg-primary)]">
                Then{" "}
                <span data-numeric className="text-[var(--accent-400)]">
                  ${METERED[0]?.overageUsdPerSandboxMinute?.toFixed(3)}
                </span>{" "}
                per sandbox-minute
              </h2>
              <p className="text-body-lg mt-4 text-[var(--fg-secondary)]">
                A sandbox-minute is one replica held up for one minute — the same unit Modal bills
                us. Overage is charged only past a plan’s included allowance, and only on plans that
                meter.
              </p>
            </div>

            <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-6 border-t border-[var(--border-hairline)] pt-8 sm:grid-cols-4 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
              {METERED.map((plan) => (
                <div key={plan.id}>
                  <dt className="mono text-[11px] font-medium uppercase leading-none tracking-[0.14em] text-[var(--fg-quaternary)]">
                    {plan.displayName} rate
                  </dt>
                  <dd
                    data-numeric
                    className="mt-2.5 text-[20px] font-medium leading-none tracking-[-0.02em] text-[var(--fg-primary)]"
                  >
                    ${plan.overageUsdPerSandboxMinute?.toFixed(3)}
                  </dd>
                  <dd className="text-caption mt-2 text-[var(--fg-tertiary)]">
                    after {plan.includedSandboxMinutes.toLocaleString("en-US")} min
                  </dd>
                </div>
              ))}
              <div>
                <dt className="mono text-[11px] font-medium uppercase leading-none tracking-[0.14em] text-[var(--fg-quaternary)]">
                  Free tier
                </dt>
                <dd className="mt-2.5 text-[20px] font-medium leading-none tracking-[-0.02em] text-[var(--fg-primary)]">
                  hard stop
                </dd>
                <dd className="text-caption mt-2 text-[var(--fg-tertiary)]">
                  at {limitsFor(PLANS.free).includedSandboxMinutes.toLocaleString("en-US")} min
                </dd>
              </div>
              <div>
                <dt className="mono text-[11px] font-medium uppercase leading-none tracking-[0.14em] text-[var(--fg-quaternary)]">
                  Per-run cap
                </dt>
                <dd data-numeric className="mt-2.5 text-[20px] font-medium leading-none tracking-[-0.02em] text-[var(--fg-primary)]">
                  ${limitsFor(PLANS.team).maxUsdPerRun}
                </dd>
                <dd className="text-caption mt-2 text-[var(--fg-tertiary)]">
                  enforced, not advisory
                </dd>
              </div>
            </dl>
          </div>

          <div className="mt-12">
            <h3 className="text-h3 text-[var(--fg-primary)]">Project a month</h3>
            <p className="text-body-lg mt-3 max-w-[60ch] text-[var(--fg-secondary)]">
              Set the fan-out width one run uses and how often you ship. The estimate below runs the
              same allowance and overage arithmetic the billing period does.
            </p>
            <div className="mt-8">
              <CostCalculator />
            </div>
          </div>
        </div>
      </section>

      {/* Final CTA -------------------------------------------------------- */}
      <section className="relative isolate overflow-hidden bg-[var(--bg-void)]">
        <div aria-hidden className="sodium-glow" />
        <div className="relative mx-auto w-full max-w-[1200px] px-6 py-28 text-center">
          <h2 className="text-display-2 mx-auto max-w-[620px] text-balance text-[var(--fg-primary)]">
            Start on Free. Move up when the fan-out does.
          </h2>
          <div className="mt-9 flex flex-wrap justify-center gap-3">
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
    </>
  )
}
