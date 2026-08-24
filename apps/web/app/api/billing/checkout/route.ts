/**
 * Starts a Stripe Checkout session and hands back the redirect URL.
 *
 * A route rather than a Server Action because the client redirects the top-level
 * window to Stripe; an action would have to return the URL anyway, and this way
 * the "billing not configured" case is a status code the caller can branch on.
 */

import { NextResponse } from "next/server"
import { z } from "zod"

import { activeOrganization, getSession } from "@/lib/auth"
import { StripeNotConfiguredError, createCheckoutSession } from "@/lib/stripe"

export const dynamic = "force-dynamic"

const bodySchema = z.object({
  // Free has no Stripe subscription, so it is not a checkout destination.
  plan: z.enum(["pro", "team"]),
})

export async function POST(request: Request): Promise<Response> {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 })
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(payload)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Expected { plan: \"pro\" | \"team\" }." },
      { status: 400 },
    )
  }

  try {
    const organization = await activeOrganization()
    const checkout = await createCheckoutSession(organization, parsed.data.plan)
    return NextResponse.json({ url: checkout.url })
  } catch (cause) {
    if (cause instanceof StripeNotConfiguredError) {
      // 503, not 500: nothing is broken, the deployment simply has no keys yet.
      return NextResponse.json({ error: cause.message, missing: cause.missing }, { status: 503 })
    }
    throw cause
  }
}
