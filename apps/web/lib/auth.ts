/**
 * Authentication, and the organisation a request acts on behalf of.
 *
 * ONE GitHub App does double duty here. It is the login provider *and* the
 * source of repository write access, because the App has "Request user
 * authorization (OAuth) during installation" enabled — so installing it also
 * signs the installer in. A second OAuth app would mean two consent screens,
 * two client secrets, and a user who is signed in but whose repositories we
 * still cannot reach. GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET are the
 * App's own credentials; lib/github.ts uses the same App's private key to mint
 * installation tokens for the server-to-server half.
 *
 * better-auth's session shape is re-narrowed on the way out (see
 * {@link normalizeSession}). The library's own types are generic over the
 * plugin list, and letting that inference leak into every Server Component is
 * how `any` gets into a strict codebase.
 */

import { cache } from "react"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { randomUUID } from "node:crypto"

import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { nextCookies } from "better-auth/next-js"
import { and, asc, eq } from "drizzle-orm"

import { db, schema, type Organization } from "@/lib/db"
import { PLANS } from "@/lib/plans"

/* ---------------------------------------------------------------------------
 * Environment
 * ------------------------------------------------------------------------ */

/**
 * Absolute origin better-auth builds its callback URL from. GitHub redirects
 * back to `${baseURL}/api/auth/callback/github`, so a wrong value here fails at
 * the callback rather than at boot — worth defaulting explicitly.
 */
function baseUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "")
}

/* ---------------------------------------------------------------------------
 * better-auth
 * ------------------------------------------------------------------------ */

export const auth = betterAuth({
  appName: "sandman",
  baseURL: baseUrl(),
  secret: process.env.BETTER_AUTH_SECRET,

  database: drizzleAdapter(db, {
    provider: "pg",
    // Named explicitly rather than handed the whole schema module: the file
    // also exports run/verdict/hotfix tables, and a stray name collision would
    // otherwise silently point an auth model at the wrong table.
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),

  // Everything here is GitHub-backed. There is no password to store, so there
  // is no password to leak.
  //
  // The one exception is local development: signing in requires a GitHub App,
  // and there is no way to look at the dashboard before one exists. Setting
  // SANDMAN_DEV_LOGIN=1 enables a password login so the app is browsable.
  // Guarded on NODE_ENV as well as the flag, so it cannot be switched on in a
  // production build by environment alone.
  emailAndPassword: {
    enabled: process.env.SANDMAN_DEV_LOGIN === "1" && process.env.NODE_ENV !== "production",
  },

  socialProviders: {
    github: {
      clientId: process.env.GITHUB_APP_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_APP_CLIENT_SECRET ?? "",
      // No `scope`: a GitHub *App* derives its user-to-server permissions from
      // the App's declared account permissions, not from OAuth scopes. Reading
      // the primary email requires the App's "Email addresses: read" user
      // permission — asking for `user:email` here would be ignored.
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    additionalFields: {
      // The column already exists on `session`; declaring it keeps better-auth
      // from stripping it on write. `input: false` means a client cannot set
      // its own active organisation by posting one.
      activeOrganizationId: { type: "string", required: false, input: false },
    },
    cookieCache: { enabled: true, maxAge: 60 * 5 },
  },

  // nextCookies must be last: it wraps the response of every preceding plugin
  // to flush Set-Cookie through Next's async cookie store.
  plugins: [nextCookies()],
})

/* ---------------------------------------------------------------------------
 * Session
 * ------------------------------------------------------------------------ */

export interface AppUser {
  id: string
  name: string
  email: string
  image: string | null
}

export interface AppSession {
  user: AppUser
  /** Null until the user has been placed in an organisation. */
  activeOrganizationId: string | null
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

/** Hand-narrowed so no inferred `any` escapes into Server Components. */
function normalizeSession(raw: unknown): AppSession | null {
  if (!raw || typeof raw !== "object") return null
  const envelope = raw as Record<string, unknown>

  const userRaw = envelope.user
  if (!userRaw || typeof userRaw !== "object") return null
  const userRecord = userRaw as Record<string, unknown>

  const id = readString(userRecord, "id")
  const email = readString(userRecord, "email")
  if (!id || !email) return null

  const sessionRaw = envelope.session
  const sessionRecord =
    sessionRaw && typeof sessionRaw === "object" ? (sessionRaw as Record<string, unknown>) : {}

  return {
    user: {
      id,
      email,
      name: readString(userRecord, "name") ?? email,
      image: readString(userRecord, "image"),
    },
    activeOrganizationId: readString(sessionRecord, "activeOrganizationId"),
  }
}

/**
 * The current session, for Server Components.
 *
 * `cache` dedupes within a single request: a layout, a page, and three Server
 * Actions all asking for the session cost one lookup.
 */
export const getSession = cache(async (): Promise<AppSession | null> => {
  const raw = await auth.api.getSession({ headers: await headers() })
  return normalizeSession(raw)
})

/** The session, or a redirect to sign-in. Never returns null. */
export async function requireUser(): Promise<AppSession> {
  const session = await getSession()
  if (!session) redirect("/sign-in")
  return session
}

/* ---------------------------------------------------------------------------
 * Organisation
 * ------------------------------------------------------------------------ */

function newId(): string {
  return randomUUID()
}

/**
 * A slug that is stable for the reader and unique for Postgres.
 *
 * The random tail is not decoration: `organization.slug` is globally unique, so
 * two people named "alex" signing up would otherwise collide on first login.
 */
function slugify(name: string): string {
  const stem =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "workspace"
  return `${stem}-${randomUUID().slice(0, 6)}`
}

/**
 * The organisation this user acts in, provisioning a personal one on first use.
 *
 * Provisioning happens on read rather than in a better-auth database hook so
 * that it also covers users created before this code existed, and so that the
 * free-tier subscription row and the membership row are written in the same
 * transaction as the organisation itself.
 */
export const activeOrganization = cache(async (): Promise<Organization> => {
  const session = await requireUser()

  if (session.activeOrganizationId) {
    const [existing] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, session.activeOrganizationId))
      .limit(1)
    if (existing) return existing
  }

  const [membership] = await db
    .select({ organization: schema.organization })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
    .where(eq(schema.member.userId, session.user.id))
    .orderBy(asc(schema.member.createdAt))
    .limit(1)

  if (membership) {
    await db
      .update(schema.session)
      .set({ activeOrganizationId: membership.organization.id })
      .where(eq(schema.session.userId, session.user.id))
    return membership.organization
  }

  return provisionPersonalOrganization(session.user)
})

async function provisionPersonalOrganization(user: AppUser): Promise<Organization> {
  const organizationId = newId()
  const name = `${user.name.split(" ")[0] ?? user.name}'s workspace`

  const created = await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(schema.organization)
      .values({ id: organizationId, name, slug: slugify(user.name || user.email) })
      .returning()
    if (!org) throw new Error("organisation insert returned no row")

    await tx.insert(schema.member).values({
      id: newId(),
      organizationId: org.id,
      userId: user.id,
      role: "owner",
    })

    // Everyone starts on Free with its entitlement keys already present, so
    // `planFor()` resolves correctly before Stripe has ever been contacted.
    await tx.insert(schema.subscription).values({
      id: newId(),
      organizationId: org.id,
      plan: "free",
      status: "active",
      entitlements: PLANS.free.entitlementKeys,
    })

    return org
  })

  await db
    .update(schema.session)
    .set({ activeOrganizationId: created.id })
    .where(eq(schema.session.userId, user.id))

  return created
}

/** Whether the user may change organisation-level settings. */
export async function isOrganizationOwner(
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(
      and(eq(schema.member.userId, userId), eq(schema.member.organizationId, organizationId)),
    )
    .limit(1)
  return row?.role === "owner" || row?.role === "admin"
}

/** Variables that must be set before sign-in can work at all. Names only. */
export function authMissingEnv(): string[] {
  const missing: string[] = []
  if (!process.env.BETTER_AUTH_SECRET) missing.push("BETTER_AUTH_SECRET")
  if (!process.env.GITHUB_APP_CLIENT_ID) missing.push("GITHUB_APP_CLIENT_ID")
  if (!process.env.GITHUB_APP_CLIENT_SECRET) missing.push("GITHUB_APP_CLIENT_SECRET")
  return missing
}
