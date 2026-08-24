/**
 * Stripe.
 *
 * Three facts about usage-based billing shape everything in this file, and each
 * one is a trap the obvious implementation falls into.
 *
 * 1. A metered line item must OMIT `quantity` in Checkout. Sending `quantity: 1`
 *    on a metered price fails the session outright — the quantity comes from
 *    meter events, not from the customer's cart.
 *
 * 2. The Customer Portal cannot update a usage-based subscription. It can show
 *    invoices and it can cancel, and that is all. Plan switches therefore go
 *    through `subscriptions.update` from our own UI ({@link changePlan}); the
 *    portal link is for invoices and payment methods only.
 *
 * 3. Meter events are processed asynchronously and Stripe exposes no real-time
 *    total. Anything the dashboard shows as "used this period" comes from our
 *    own `usage_counter` rows. Stripe stays the authority on what is invoiced;
 *    we stay the authority on what the meter reads right now.
 *
 * When STRIPE_SECRET_KEY is absent every function throws an error naming the
 * variable. The code is complete and simply inactive until keys exist — that is
 * a configuration state, not a broken build.
 */

import { randomUUID } from "node:crypto"

import Stripe from "stripe"
import { eq } from "drizzle-orm"

import { db, schema, type Organization } from "@/lib/db"
import { PLAN_ORDER, PLANS, type PlanId } from "@/lib/plans"

/** Pinned. An unpinned client silently changes response shapes on Stripe's schedule. */
const API_VERSION = "2025-08-27.basil"

/** Paid plans only — Free has no Stripe subscription at all. */
export type PaidPlanId = Exclude<PlanId, "free">

/**
 * Meter event names. These are configured on the Stripe meter and are part of
 * the billing contract: renaming one stops usage being counted, silently.
 */
export const METER = {
  SANDBOX_MINUTES: "sandman_sandbox_minutes",
  AGENT_TOKENS: "sandman_agent_tokens",
} as const

export type MeterName = (typeof METER)[keyof typeof METER]

/* ---------------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------------ */

export class StripeNotConfiguredError extends Error {
  readonly missing: readonly string[]

  constructor(missing: readonly string[]) {
    super(
      `Billing is not configured; missing: ${missing.join(", ")}. ` +
        "Set these from the Stripe dashboard (Developers → API keys, and Product catalog " +
        "for the price ids) to enable checkout, the portal, and usage reporting.",
    )
    this.name = "StripeNotConfiguredError"
    this.missing = missing
  }
}

function priceEnvNames(plan: PaidPlanId): { base: string; metered: string } {
  return plan === "pro"
    ? { base: "STRIPE_PRICE_PRO", metered: "STRIPE_PRICE_PRO_SANDBOX_MINUTES" }
    : { base: "STRIPE_PRICE_TEAM", metered: "STRIPE_PRICE_TEAM_SANDBOX_MINUTES" }
}

/** Names only, never values — this list is rendered in the billing UI. */
export function stripeMissingEnv(): string[] {
  const missing: string[] = []
  if (!process.env.STRIPE_SECRET_KEY) missing.push("STRIPE_SECRET_KEY")
  for (const plan of PLAN_ORDER) {
    if (plan === "free") continue
    const names = priceEnvNames(plan)
    if (!process.env[names.base]) missing.push(names.base)
    if (!process.env[names.metered]) missing.push(names.metered)
  }
  return missing
}

/** True when checkout can actually run. The webhook secret is checked separately. */
export function stripeConfigured(): boolean {
  return stripeMissingEnv().length === 0
}

/** The secret key alone — enough for the portal and for usage reporting. */
function requireSecretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new StripeNotConfiguredError(["STRIPE_SECRET_KEY"])
  return key
}

/**
 * Instantiated lazily and parked on globalThis: constructing a client per HMR
 * reload leaks sockets in dev, and constructing one at import time would make a
 * missing key a build failure instead of a runtime state.
 */
const globalForStripe = globalThis as unknown as { __sandmanStripe?: Stripe }

export function stripeClient(): Stripe {
  const existing = globalForStripe.__sandmanStripe
  if (existing) return existing
  const created = new Stripe(requireSecretKey(), {
    apiVersion: API_VERSION,
    appInfo: { name: "sandman", url: "https://github.com/0x3ddie/sandman" },
    maxNetworkRetries: 2,
    timeout: 20_000,
  })
  globalForStripe.__sandmanStripe = created
  return created
}

function pricesFor(plan: PaidPlanId): { base: string; metered: string } {
  const names = priceEnvNames(plan)
  const base = process.env[names.base]
  const metered = process.env[names.metered]
  const missing = [!base && names.base, !metered && names.metered].filter(
    (name): name is string => typeof name === "string",
  )
  if (missing.length > 0) throw new StripeNotConfiguredError(missing)
  return { base: base as string, metered: metered as string }
}

function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "")
}

/* ---------------------------------------------------------------------------
 * Customers
 * ------------------------------------------------------------------------ */

/**
 * The Stripe customer for an organisation, created on first need.
 *
 * A stored id is verified rather than trusted: a customer deleted in the Stripe
 * dashboard (routine while testing) would otherwise poison every subsequent
 * call with a 404 that reads like a code bug.
 */
export async function ensureCustomer(org: Organization): Promise<string> {
  const stripe = stripeClient()

  if (org.stripeCustomerId) {
    const existing = await stripe.customers.retrieve(org.stripeCustomerId)
    if (!existing.deleted) return existing.id
  }

  const created = await stripe.customers.create({
    name: org.name,
    metadata: { organizationId: org.id, organizationSlug: org.slug },
  })

  await db
    .update(schema.organization)
    .set({ stripeCustomerId: created.id, updatedAt: new Date() })
    .where(eq(schema.organization.id, org.id))

  return created.id
}

/* ---------------------------------------------------------------------------
 * Checkout
 * ------------------------------------------------------------------------ */

export interface CheckoutResult {
  id: string
  url: string
}

/**
 * A Checkout session for a paid plan.
 *
 * Two line items: the flat platform fee, and the metered sandbox-minute price.
 * The metered item carries NO `quantity` — Stripe rejects the session if it
 * does, because a metered price is priced from meter events rather than from
 * anything the customer chooses at checkout.
 */
export async function createCheckoutSession(
  org: Organization,
  plan: PaidPlanId,
): Promise<CheckoutResult> {
  const stripe = stripeClient()
  const prices = pricesFor(plan)
  const customer = await ensureCustomer(org)

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [
      { price: prices.base, quantity: 1 },
      { price: prices.metered },
    ],
    // Both ends of the round trip land back on the billing page; the session id
    // lets it tell "you just subscribed" from "you opened this page".
    success_url: `${appUrl()}/settings/billing?checkout=complete&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl()}/settings/billing?checkout=cancelled`,
    client_reference_id: org.id,
    // Mirrored onto the subscription as well as the session: the
    // `customer.subscription.*` webhooks never carry the session's metadata.
    metadata: { organizationId: org.id, plan },
    subscription_data: { metadata: { organizationId: org.id, plan } },
    allow_promotion_codes: true,
    billing_address_collection: "auto",
    automatic_tax: { enabled: false },
  })

  if (!session.url) {
    throw new Error(`Stripe created checkout session ${session.id} without a redirect URL`)
  }
  return { id: session.id, url: session.url }
}

/* ---------------------------------------------------------------------------
 * Customer Portal
 * ------------------------------------------------------------------------ */

/**
 * A Customer Portal session — invoices, receipts, payment methods, cancellation.
 *
 * Deliberately NOT the place plans change. The portal refuses to update a
 * subscription that contains a usage-based price, so exposing "change plan"
 * there would hand the customer a button that errors. {@link changePlan} does
 * that work through the API instead.
 */
export async function createPortalSession(org: Organization): Promise<string> {
  const stripe = stripeClient()
  const customer = await ensureCustomer(org)

  const session = await stripe.billingPortal.sessions.create({
    customer,
    return_url: `${appUrl()}/settings/billing`,
    ...(process.env.STRIPE_PORTAL_CONFIGURATION_ID
      ? { configuration: process.env.STRIPE_PORTAL_CONFIGURATION_ID }
      : {}),
  })
  return session.url
}

/* ---------------------------------------------------------------------------
 * Plan changes
 * ------------------------------------------------------------------------ */

/**
 * Move an existing subscription onto another paid plan.
 *
 * Both line items are swapped in one update so the flat fee and the metered
 * price never disagree about the tier. Removing the old metered item does not
 * discard usage: with the Meters API, usage is recorded against the meter and
 * the customer, not against the subscription item.
 *
 * `proration_behavior: "create_prorations"` is correct in both directions —
 * upgrades bill the difference immediately, downgrades credit it.
 */
export async function changePlan(org: Organization, plan: PaidPlanId): Promise<void> {
  const stripe = stripeClient()
  const prices = pricesFor(plan)
  const subscriptionId = await activeSubscriptionId(org)

  if (!subscriptionId) {
    throw new Error(
      `${org.name} has no active Stripe subscription to move onto ${PLANS[plan].displayName}; ` +
        "run checkout instead.",
    )
  }

  const current = await stripe.subscriptions.retrieve(subscriptionId)
  const items: Stripe.SubscriptionUpdateParams.Item[] = current.items.data.map((item) => ({
    id: item.id,
    deleted: true,
  }))
  items.push({ price: prices.base, quantity: 1 }, { price: prices.metered })

  await stripe.subscriptions.update(subscriptionId, {
    items,
    proration_behavior: "create_prorations",
    // Fail loudly rather than leaving a subscription in `incomplete` that the
    // UI would then render as if the upgrade had worked.
    payment_behavior: "error_if_incomplete",
    cancel_at_period_end: false,
    metadata: { organizationId: org.id, plan },
  })
}

/** Cancels at period end. Immediate cancellation would void paid-for time. */
export async function cancelPlan(org: Organization): Promise<void> {
  const subscriptionId = await activeSubscriptionId(org)
  if (!subscriptionId) return
  await stripeClient().subscriptions.update(subscriptionId, { cancel_at_period_end: true })
}

async function activeSubscriptionId(org: Organization): Promise<string | null> {
  const [row] = await db
    .select({ id: schema.subscription.stripeSubscriptionId })
    .from(schema.subscription)
    .where(eq(schema.subscription.organizationId, org.id))
    .limit(1)
  return row?.id ?? null
}

/* ---------------------------------------------------------------------------
 * Usage
 * ------------------------------------------------------------------------ */

/**
 * Record usage against a Stripe meter.
 *
 * Fire-and-forget by design: the meter event is what gets *invoiced*, but the
 * number the dashboard displays comes from `usage_counter`, because Stripe
 * processes these asynchronously and offers no way to read a running total.
 *
 * `identifier` is Stripe's idempotency key for meter events. Passing a
 * deterministic one — a run id, say — makes a retried report safe; the random
 * default is only correct for genuinely new usage.
 */
export async function reportUsage(
  org: Organization,
  meter: MeterName,
  value: number,
  options: { identifier?: string; at?: Date } = {},
): Promise<void> {
  if (!Number.isFinite(value) || value <= 0) return

  const stripe = stripeClient()
  const customer = await ensureCustomer(org)

  await stripe.billing.meterEvents.create({
    event_name: meter,
    // Every payload value must be a string; Stripe rejects numbers here.
    payload: { stripe_customer_id: customer, value: String(Math.round(value)) },
    identifier: options.identifier ?? randomUUID(),
    ...(options.at ? { timestamp: Math.floor(options.at.getTime() / 1000) } : {}),
  })
}

/* ---------------------------------------------------------------------------
 * Entitlements
 * ------------------------------------------------------------------------ */

/**
 * The customer's active entitlement lookup keys.
 *
 * Entitlements carry feature *presence* and nothing numeric, which is why the
 * ceilings live in lib/plans.ts keyed by these same strings. Read on demand
 * only as a repair path — the steady state is the cache written by the
 * `entitlements.active_entitlement_summary.updated` webhook.
 */
export async function fetchEntitlements(customerId: string): Promise<string[]> {
  const stripe = stripeClient()
  const keys: string[] = []
  for await (const entitlement of stripe.entitlements.activeEntitlements.list({
    customer: customerId,
    limit: 100,
  })) {
    keys.push(entitlement.lookup_key)
  }
  return keys
}

/** The plan a subscription's prices describe, for reconciling a webhook. */
export function planForPriceId(priceId: string | null | undefined): PaidPlanId | null {
  if (!priceId) return null
  for (const plan of PLAN_ORDER) {
    if (plan === "free") continue
    const names = priceEnvNames(plan)
    if (process.env[names.base] === priceId || process.env[names.metered] === priceId) return plan
  }
  return null
}
