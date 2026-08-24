/**
 * Opens a Stripe Customer Portal session.
 *
 * The portal is for invoices, receipts, payment methods and cancellation. It
 * cannot update a subscription containing a usage-based price, so plan changes
 * go through `changePlan` in our own UI — see lib/stripe.ts.
 */

import { NextResponse } from "next/server"

import { activeOrganization, getSession } from "@/lib/auth"
import { StripeNotConfiguredError, createPortalSession } from "@/lib/stripe"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(): Promise<Response> {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 })
  }

  try {
    const organization = await activeOrganization()
    const url = await createPortalSession(organization)
    return NextResponse.json({ url })
  } catch (cause) {
    if (cause instanceof StripeNotConfiguredError) {
      return NextResponse.json({ error: cause.message, missing: cause.missing }, { status: 503 })
    }
    throw cause
  }
}
