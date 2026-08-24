/**
 * The Stripe webhook.
 *
 * Signature verification runs against the RAW request body. `await req.text()`
 * is not a stylistic choice — re-serialising parsed JSON reorders keys and
 * normalises whitespace, and the resulting bytes will not match the signature
 * Stripe computed. Next's App Router does not consume the body for us, so the
 * raw text is available here.
 *
 * Two behaviours this endpoint owes Stripe. It returns 200 quickly, because a
 * slow endpoint gets retried and eventually disabled. And it never fails on an
 * unrecognised event type: Stripe adds event types continuously, and a webhook
 * that 500s on one it has not seen before generates alerts for nothing.
 *
 * A genuine processing failure DOES return 500, deliberately — that is how a
 * transient database outage gets the delivery retried instead of silently
 * dropped.
 */

import { NextResponse } from "next/server"
import type Stripe from "stripe"
import { eq } from "drizzle-orm"

import { db, schema } from "@/lib/db"
import { PLANS, isPlanId, type PlanId } from "@/lib/plans"
import { planForPriceId, stripeClient } from "@/lib/stripe"

export const dynamic = "force-dynamic"

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    // 503 rather than 500: an unconfigured deployment should not look like a
    // crashing one in Stripe's delivery log.
    return NextResponse.json(
      { error: "STRIPE_WEBHOOK_SECRET is not set, so webhook signatures cannot be verified." },
      { status: 503 },
    )
  }

  const signature = request.headers.get("stripe-signature")
  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header." }, { status: 400 })
  }

  // The raw bytes, before any parsing. See the module comment.
  const payload = await request.text()

  let event: Stripe.Event
  try {
    event = await stripeClient().webhooks.constructEventAsync(payload, signature, secret)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "unknown verification failure"
    return NextResponse.json({ error: `Signature verification failed: ${detail}` }, { status: 400 })
  }

  try {
    await handle(event)
  } catch (cause) {
    console.error(`[stripe-webhook] ${event.type} (${event.id}) failed`, cause)
    return NextResponse.json({ error: "Processing failed; retry." }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}

/* ---------------------------------------------------------------------------
 * Dispatch
 * ------------------------------------------------------------------------ */

async function handle(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
      await onCheckoutCompleted(event.data.object)
      return

    case "customer.subscription.updated":
      await onSubscriptionChanged(event.data.object)
      return

    case "customer.subscription.deleted":
      await onSubscriptionDeleted(event.data.object)
      return

    case "invoice.paid":
      await onInvoicePaid(event.data.object)
      return

    case "entitlements.active_entitlement_summary.updated":
      await onEntitlementsUpdated(event.data.object)
      return

    default:
      // Everything else is acknowledged and ignored on purpose.
      return
  }
}

/* ---------------------------------------------------------------------------
 * Handlers
 * ------------------------------------------------------------------------ */

async function onCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const organizationId =
    session.client_reference_id ??
    metadataOrganizationId(session.metadata) ??
    (await organizationIdForCustomer(idOf(session.customer)))
  if (!organizationId) return

  const customerId = idOf(session.customer)
  if (customerId) {
    await db
      .update(schema.organization)
      .set({ stripeCustomerId: customerId, updatedAt: new Date() })
      .where(eq(schema.organization.id, organizationId))
  }

  const subscriptionId = idOf(session.subscription)
  if (!subscriptionId) return

  // Re-read the subscription rather than trusting the session: the session
  // carries no period boundaries and no price ids.
  const subscription = await stripeClient().subscriptions.retrieve(subscriptionId)
  await writeSubscription(organizationId, subscription)
}

async function onSubscriptionChanged(subscription: Stripe.Subscription): Promise<void> {
  const organizationId =
    metadataOrganizationId(subscription.metadata) ??
    (await organizationIdForCustomer(idOf(subscription.customer)))
  if (!organizationId) return
  await writeSubscription(organizationId, subscription)
}

async function onSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  const organizationId =
    metadataOrganizationId(subscription.metadata) ??
    (await organizationIdForCustomer(idOf(subscription.customer)))
  if (!organizationId) return

  const existing = await existingSubscriptionRow(organizationId)
  if (!existing) return

  await db
    .update(schema.subscription)
    .set({
      plan: "free",
      status: "canceled",
      stripeSubscriptionId: null,
      cancelAtPeriodEnd: false,
      // Dropped back to the Free key set immediately. Waiting for the
      // entitlements webhook would leave a cancelled customer briefly holding
      // paid capabilities.
      entitlements: PLANS.free.entitlementKeys,
      updatedAt: new Date(),
    })
    .where(eq(schema.subscription.id, existing.id))
}

/**
 * A paid invoice rolls the billing period forward.
 *
 * `invoice.subscription` does not exist on this API version — the subscription
 * moved to `invoice.parent.subscription_details.subscription`. Reading the old
 * field would silently no-op on every renewal.
 */
async function onInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  const subscriptionId = idOf(invoice.parent?.subscription_details?.subscription ?? null)
  if (!subscriptionId) return

  const organizationId = await organizationIdForCustomer(idOf(invoice.customer))
  if (!organizationId) return

  const subscription = await stripeClient().subscriptions.retrieve(subscriptionId)
  await writeSubscription(organizationId, subscription)

  // Open the counter row for the new period so the dashboard's usage meter has
  // something to read before the first run of the period writes to it.
  const period = periodOf(subscription)
  if (period.start) {
    await db
      .insert(schema.usageCounter)
      .values({ organizationId, periodStart: period.start })
      .onConflictDoNothing()
  }
}

/**
 * Cache the customer's entitlement lookup keys onto the subscription row.
 *
 * Entitlements answer "does this customer have feature X" and carry no numbers,
 * so the numeric ceiling for each key lives in lib/plans.ts. Caching the keys
 * means every page render resolves the plan from one row we already fetch,
 * instead of a Stripe round trip.
 */
async function onEntitlementsUpdated(
  summary: Stripe.Entitlements.ActiveEntitlementSummary,
): Promise<void> {
  const organizationId = await organizationIdForCustomer(summary.customer)
  if (!organizationId) return

  const keys = summary.entitlements.data.map((entitlement) => entitlement.lookup_key)
  const existing = await existingSubscriptionRow(organizationId)

  if (existing) {
    await db
      .update(schema.subscription)
      .set({ entitlements: keys, updatedAt: new Date() })
      .where(eq(schema.subscription.id, existing.id))
    return
  }

  await db.insert(schema.subscription).values({
    id: crypto.randomUUID(),
    organizationId,
    plan: "free",
    status: "active",
    entitlements: keys,
  })
}

/* ---------------------------------------------------------------------------
 * Persistence
 * ------------------------------------------------------------------------ */

async function writeSubscription(
  organizationId: string,
  subscription: Stripe.Subscription,
): Promise<void> {
  const plan = planOf(subscription)
  const period = periodOf(subscription)
  const existing = await existingSubscriptionRow(organizationId)

  // Entitlements normally arrive on their own webhook. Seeding them from the
  // plan when the row has none keeps a brand-new paid customer from being
  // treated as Free during the gap between the two deliveries.
  const entitlements =
    existing && existing.entitlements.length > 0 ? existing.entitlements : PLANS[plan].entitlementKeys

  const values = {
    organizationId,
    stripeSubscriptionId: subscription.id,
    plan,
    status: subscription.status,
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    entitlements,
    updatedAt: new Date(),
  }

  if (existing) {
    await db.update(schema.subscription).set(values).where(eq(schema.subscription.id, existing.id))
    return
  }
  await db.insert(schema.subscription).values({ id: crypto.randomUUID(), ...values })
}

async function existingSubscriptionRow(
  organizationId: string,
): Promise<{ id: string; entitlements: string[] } | null> {
  const [row] = await db
    .select({ id: schema.subscription.id, entitlements: schema.subscription.entitlements })
    .from(schema.subscription)
    .where(eq(schema.subscription.organizationId, organizationId))
    .limit(1)
  return row ?? null
}

async function organizationIdForCustomer(customerId: string | null): Promise<string | null> {
  if (!customerId) return null
  const [row] = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.stripeCustomerId, customerId))
    .limit(1)
  return row?.id ?? null
}

/* ---------------------------------------------------------------------------
 * Shape helpers
 * ------------------------------------------------------------------------ */

/** Stripe returns either an id or an expanded object for every relation. */
function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null
  return typeof value === "string" ? value : value.id
}

function metadataOrganizationId(metadata: Stripe.Metadata | null): string | null {
  const value = metadata?.organizationId
  return typeof value === "string" && value.length > 0 ? value : null
}

/**
 * The subscription's billing period.
 *
 * `current_period_start` / `current_period_end` live on subscription *items* on
 * this API version, not on the subscription. With one flat item and one metered
 * item the two agree, but taking the widest span is correct regardless.
 */
function periodOf(subscription: Stripe.Subscription): { start: Date | null; end: Date | null } {
  let start: number | null = null
  let end: number | null = null
  for (const item of subscription.items.data) {
    if (start === null || item.current_period_start < start) start = item.current_period_start
    if (end === null || item.current_period_end > end) end = item.current_period_end
  }
  return {
    start: start === null ? null : new Date(start * 1000),
    end: end === null ? null : new Date(end * 1000),
  }
}

/** Price ids first, metadata second — metadata is a snapshot and can be stale. */
function planOf(subscription: Stripe.Subscription): PlanId {
  for (const item of subscription.items.data) {
    const resolved = planForPriceId(item.price.id)
    if (resolved) return resolved
  }
  const fromMetadata = subscription.metadata?.plan
  if (typeof fromMetadata === "string" && isPlanId(fromMetadata)) return fromMetadata
  return "free"
}
