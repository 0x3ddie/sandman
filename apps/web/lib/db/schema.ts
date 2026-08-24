/**
 * Database schema.
 *
 * Two things worth knowing before reading:
 *
 * Secrets are never stored in plaintext and never leave the server. Each secret
 * gets its own data key, which is itself wrapped by a key-encryption key held in
 * the environment. A database dump alone is therefore useless, and rotating the
 * KEK means re-wrapping data keys rather than re-encrypting every ciphertext.
 *
 * Usage counters live here rather than being read back from Stripe. Stripe
 * processes meter events asynchronously and exposes no real-time total, so the
 * live usage bar in the dashboard reads these rows; Stripe remains the authority
 * for what actually gets invoiced.
 */

import { relations } from "drizzle-orm"
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"

const id = () => text("id").primaryKey()
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()

/* ---------------------------------------------------------------------------
 * Auth (better-auth owns the shape of these four tables)
 * ------------------------------------------------------------------------ */

export const user = pgTable("user", {
  id: id(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const session = pgTable(
  "session",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    activeOrganizationId: text("active_organization_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
)

export const account = pgTable(
  "account",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    // better-auth >= 1.7 requires `issuer` on the account model; sign-up fails
    // outright without it.
    issuer: text("issuer"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    idToken: text("id_token"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
)

export const verification = pgTable("verification", {
  id: id(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/* ---------------------------------------------------------------------------
 * Organisations and billing
 * ------------------------------------------------------------------------ */

export const organization = pgTable("organization", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  stripeCustomerId: text("stripe_customer_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const member = pgTable(
  "member",
  {
    id: id(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("member_org_user_idx").on(t.organizationId, t.userId)],
)

export const subscription = pgTable(
  "subscription",
  {
    id: id(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    stripeSubscriptionId: text("stripe_subscription_id").unique(),
    plan: text("plan").notNull().default("free"),
    status: text("status").notNull().default("active"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    /**
     * Cached from the entitlements webhook. Stripe entitlements carry feature
     * presence only, never numbers, so the numeric ceiling for each feature
     * lives in application code keyed by these lookup keys.
     */
    entitlements: jsonb("entitlements").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("subscription_org_idx").on(t.organizationId)],
)

/**
 * Usage the dashboard reads for its live meter. Written as runs progress and
 * separately reported to Stripe as meter events.
 */
export const usageCounter = pgTable(
  "usage_counter",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    sandboxSeconds: doublePrecision("sandbox_seconds").notNull().default(0),
    agentTokens: integer("agent_tokens").notNull().default(0),
    probeRuns: integer("probe_runs").notNull().default(0),
    usdSpent: doublePrecision("usd_spent").notNull().default(0),
    reportedThroughMs: timestamp("reported_through", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.periodStart] })],
)

/* ---------------------------------------------------------------------------
 * GitHub + projects
 * ------------------------------------------------------------------------ */

export const githubInstallation = pgTable(
  "github_installation",
  {
    id: id(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    installationId: integer("installation_id").notNull().unique(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull().default("User"),
    repositorySelection: text("repository_selection").notNull().default("selected"),
    suspended: boolean("suspended").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("installation_org_idx").on(t.organizationId)],
)

export const project = pgTable(
  "project",
  {
    id: id(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    repositoryUrl: text("repository_url").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    installationId: integer("installation_id"),
    lkgBranch: text("lkg_branch").notNull().default("main"),
    hotfixBranchPrefix: text("hotfix_branch_prefix").notNull().default("sandman/hotfix"),
    /**
     * How the baseline lane's revision is chosen. "auto" resolves the
     * second-newest merge on the LKG branch; "pinned" uses previousLkgRef.
     */
    previousLkgMode: text("previous_lkg_mode").notNull().default("auto"),
    previousLkgRef: text("previous_lkg_ref"),
    /** The full ProjectConfig, mirroring the Python model. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("project_org_slug_idx").on(t.organizationId, t.slug)],
)

/**
 * Envelope-encrypted credentials. `ciphertext` is sealed with a per-secret data
 * key; `wrappedKey` is that data key sealed with the environment KEK. Nothing
 * here is ever returned to a client — the UI shows only the last four
 * characters and a last-used timestamp.
 */
export const projectSecret = pgTable(
  "project_secret",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    wrappedKey: text("wrapped_key").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    lastFour: text("last_four").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("secret_project_name_idx").on(t.projectId, t.name)],
)

/* ---------------------------------------------------------------------------
 * Runs
 * ------------------------------------------------------------------------ */

export const run = pgTable(
  "run",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("queued"),
    trigger: text("trigger").notNull().default("manual"),
    triggeredBy: text("triggered_by").references(() => user.id, { onDelete: "set null" }),
    /** Each stored as REF@SHA so evidence cannot drift mid-run. */
    baselineRevision: text("baseline_revision"),
    initialRevision: text("initial_revision"),
    hotfixRevision: text("hotfix_revision"),
    probeCount: integer("probe_count").notNull().default(0),
    sandboxCount: integer("sandbox_count").notNull().default(0),
    passedCount: integer("passed_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    flakyCount: integer("flaky_count").notNull().default(0),
    usdSpent: doublePrecision("usd_spent").notNull().default(0),
    sandboxSeconds: doublePrecision("sandbox_seconds").notNull().default(0),
    agentTokens: integer("agent_tokens").notNull().default(0),
    /** Counts keyed by classification, e.g. {"regression": 1, "stable": 37}. */
    verdictCounts: jsonb("verdict_counts").$type<Record<string, number>>().notNull().default({}),
    safeToPromote: boolean("safe_to_promote").notNull().default(false),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("run_project_idx").on(t.projectId, t.createdAt),
    index("run_state_idx").on(t.state),
  ],
)

/** One row per fan-out unit, for the sandbox grid and the waterfall. */
export const fanoutUnit = pgTable(
  "fanout_unit",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    variant: text("variant").notNull(),
    unitIndex: integer("unit_index").notNull().default(0),
    region: text("region"),
    sandboxId: text("sandbox_id"),
    state: text("state").notNull().default("queued"),
    exitCode: integer("exit_code"),
    provisionMs: doublePrecision("provision_ms"),
    durationMs: doublePrecision("duration_ms"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("unit_run_idx").on(t.runId, t.variant)],
)

export const probeResult = pgTable(
  "probe_result",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    probeId: text("probe_id").notNull(),
    variant: text("variant").notNull(),
    unitIndex: integer("unit_index").notNull().default(0),
    region: text("region"),
    outcome: text("outcome").notNull(),
    /** Normalized fingerprint. Comparison happens on this, never on raw bodies. */
    signatureDigest: text("signature_digest").notNull(),
    signature: jsonb("signature").$type<Record<string, unknown>>().notNull().default({}),
    latencyMs: doublePrecision("latency_ms"),
    message: text("message"),
    createdAt: createdAt(),
  },
  (t) => [index("result_run_probe_idx").on(t.runId, t.probeId, t.variant)],
)

export const verdict = pgTable(
  "verdict",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    probeId: text("probe_id").notNull(),
    classification: text("classification").notNull(),
    baselinePassed: boolean("baseline_passed").notNull(),
    initialPassed: boolean("initial_passed").notNull(),
    hotfixPassed: boolean("hotfix_passed"),
    behaviourChanged: boolean("behaviour_changed").notNull().default(false),
    flakeSuspected: boolean("flake_suspected").notNull().default(false),
    sampleSize: jsonb("sample_size").$type<Record<string, number>>().notNull().default({}),
    signatures: jsonb("signatures").$type<Record<string, unknown>>().notNull().default({}),
    detail: text("detail"),
  },
  (t) => [uniqueIndex("verdict_run_probe_idx").on(t.runId, t.probeId)],
)

export const finding = pgTable(
  "finding",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    probeId: text("probe_id").notNull(),
    classification: text("classification").notNull(),
    severity: text("severity").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    reproduction: text("reproduction"),
    variantEvidence: jsonb("variant_evidence").$type<Record<string, string>>().notNull().default({}),
    /** True when memory recall shows earlier runs already surfaced this. */
    previouslyIgnored: boolean("previously_ignored").notNull().default(false),
    firstSeenRunId: text("first_seen_run_id"),
    memoryObservationId: text("memory_observation_id"),
    createdAt: createdAt(),
  },
  (t) => [index("finding_run_idx").on(t.runId, t.severity)],
)

/* ---------------------------------------------------------------------------
 * Remediation
 * ------------------------------------------------------------------------ */

export const hotfix = pgTable(
  "hotfix",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    findingId: text("finding_id").references(() => finding.id, { onDelete: "set null" }),
    state: text("state").notNull().default("authoring"),
    branch: text("branch"),
    baseSha: text("base_sha"),
    commitSha: text("commit_sha"),
    rootCause: text("root_cause"),
    fixSummary: text("fix_summary"),
    diff: text("diff"),
    filesChanged: jsonb("files_changed").$type<string[]>().notNull().default([]),
    testsPassed: boolean("tests_passed"),
    confidence: doublePrecision("confidence"),
    rejectionReason: text("rejection_reason"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    /** Greptile reviews and gates; it never creates, writes, or merges. */
    reviewApproved: boolean("review_approved"),
    reviewScore: integer("review_score"),
    reviewSummary: text("review_summary"),
    reviewComments: jsonb("review_comments").$type<unknown[]>().notNull().default([]),
    mergedSha: text("merged_sha"),
    verificationRunId: text("verification_run_id"),
    promotedToLkg: boolean("promoted_to_lkg").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("hotfix_run_idx").on(t.runId)],
)

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    actorId: text("actor_id"),
    actorType: text("actor_type").notNull().default("user"),
    action: text("action").notNull(),
    subject: text("subject"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_org_idx").on(t.organizationId, t.createdAt)],
)

/* ---------------------------------------------------------------------------
 * Relations
 * ------------------------------------------------------------------------ */

export const organizationRelations = relations(organization, ({ many, one }) => ({
  members: many(member),
  projects: many(project),
  installations: many(githubInstallation),
  subscription: one(subscription),
}))

export const projectRelations = relations(project, ({ many, one }) => ({
  organization: one(organization, {
    fields: [project.organizationId],
    references: [organization.id],
  }),
  runs: many(run),
  secrets: many(projectSecret),
}))

export const runRelations = relations(run, ({ many, one }) => ({
  project: one(project, { fields: [run.projectId], references: [project.id] }),
  units: many(fanoutUnit),
  results: many(probeResult),
  verdicts: many(verdict),
  findings: many(finding),
  hotfixes: many(hotfix),
}))

export const findingRelations = relations(finding, ({ one }) => ({
  run: one(run, { fields: [finding.runId], references: [run.id] }),
}))

export const hotfixRelations = relations(hotfix, ({ one }) => ({
  run: one(run, { fields: [hotfix.runId], references: [run.id] }),
  finding: one(finding, { fields: [hotfix.findingId], references: [finding.id] }),
}))

export type User = typeof user.$inferSelect
export type Organization = typeof organization.$inferSelect
export type Project = typeof project.$inferSelect
export type Run = typeof run.$inferSelect
export type FanoutUnit = typeof fanoutUnit.$inferSelect
export type Verdict = typeof verdict.$inferSelect
export type Finding = typeof finding.$inferSelect
export type Hotfix = typeof hotfix.$inferSelect
export type Subscription = typeof subscription.$inferSelect
export type UsageCounter = typeof usageCounter.$inferSelect
