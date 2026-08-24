/**
 * What every settings page needs before it can render.
 *
 * The project's configuration is stored twice on purpose, and this module is
 * where the two halves are reconciled. `project.config` holds the whole
 * `ProjectConfig` as JSON — the exact shape the Python control plane validates —
 * while a handful of promoted columns (`lkgBranch`, `previousLkgMode`, …) exist
 * because they are queried, indexed, and shown in list views where parsing a
 * JSON blob per row would be absurd. The COLUMNS win: they are what the rest of
 * the application reads, so a disagreement is resolved in their favour rather
 * than by whichever was written last.
 */

import { cache } from "react"
import { redirect } from "next/navigation"
import { and, asc, desc, eq } from "drizzle-orm"

import { activeOrganization, requireUser, type AppSession } from "@/lib/auth"
import type {
  BudgetCaps,
  ProbeSpec,
  ProjectConfig,
  PromotionPolicy,
  VariantConfig,
  VariantKey,
} from "@/lib/control-plane"
import { db, schema, type Organization, type Project, type UsageCounter } from "@/lib/db"
import { PLANS, planFor, type Plan } from "@/lib/plans"
import { VARIANT_ORDER } from "@/lib/variants"

/* ---------------------------------------------------------------------------
 * Defaults — mirroring sandman.config in the control plane
 * ------------------------------------------------------------------------ */

export const DEFAULT_VARIANT: VariantConfig = {
  enabled: true,
  image: "python:3.12-slim",
  setup_commands: [],
  startup_command: [],
  env: {},
  port: 8000,
  health_path: "/health",
  regions: [],
  replicas: 1,
  cpu: 1,
  memory_mb: 1024,
  // Explicit, always: Modal's default sandbox timeout is five minutes and a
  // longer probe would be killed with no diagnostic.
  timeout_seconds: 600,
}

export const DEFAULT_BUDGET: BudgetCaps = {
  max_concurrent_sandboxes: 25,
  max_concurrent_llm: 8,
  max_usd_per_run: 5,
  max_wall_clock_seconds: 3600,
  on_exceed: "hard_stop",
}

export const DEFAULT_PROMOTION: PromotionPolicy = {
  require_greptile_approval: true,
  require_reprobe: true,
  block_on_regression: true,
  block_on_new_findings: true,
  auto_promote: false,
  max_patch_lines: 400,
  protected_paths: [
    ".github/**",
    ".greptile/**",
    "**/*.pem",
    "**/*.key",
    ".env*",
    "sandman.toml",
    "AGENTS.md",
    "CLAUDE.md",
  ],
}

/**
 * Modal's sandbox regions.
 *
 * Not fetched: the list is a deployment property of the Modal account, changes
 * on Modal's schedule rather than ours, and an empty selection already means
 * "wherever there is capacity" — which is the right default for every variant
 * that is not deliberately testing a regional difference.
 */
export const MODAL_REGIONS: readonly { id: string; label: string }[] = [
  { id: "us-east-1", label: "US East (Ashburn)" },
  { id: "us-west-2", label: "US West (Oregon)" },
  { id: "eu-west-1", label: "EU West (Dublin)" },
  { id: "eu-central-1", label: "EU Central (Frankfurt)" },
  { id: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
  { id: "ap-northeast-1", label: "Asia Pacific (Tokyo)" },
]

/** Named CPU/memory pairs, so nobody has to reason in millicores. */
export const RESOURCE_CLASSES: readonly {
  id: string
  label: string
  cpu: number
  memoryMb: number
  note: string
}[] = [
  { id: "small", label: "Small", cpu: 0.5, memoryMb: 512, note: "single-endpoint probes" },
  { id: "standard", label: "Standard", cpu: 1, memoryMb: 1024, note: "the default" },
  { id: "large", label: "Large", cpu: 2, memoryMb: 4096, note: "load and chaos fan-out" },
  { id: "xlarge", label: "Extra large", cpu: 4, memoryMb: 8192, note: "heavyweight images" },
]

export function resourceClassFor(cpu: number, memoryMb: number): string {
  const match = RESOURCE_CLASSES.find((c) => c.cpu === cpu && c.memoryMb === memoryMb)
  return match?.id ?? "custom"
}

/* ---------------------------------------------------------------------------
 * Config materialisation
 * ------------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function mergeVariant(raw: unknown): VariantConfig {
  if (!isRecord(raw)) return { ...DEFAULT_VARIANT }
  return { ...DEFAULT_VARIANT, ...(raw as Partial<VariantConfig>) }
}

function readProbes(raw: unknown): ProbeSpec[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(isRecord).map((entry) => ({
    id: String(entry.id ?? ""),
    preset: typeof entry.preset === "string" ? entry.preset : null,
    module: typeof entry.module === "string" ? entry.module : null,
    enabled: entry.enabled !== false,
    params: isRecord(entry.params) ? entry.params : {},
    fanout: typeof entry.fanout === "number" ? entry.fanout : 1,
    regions: Array.isArray(entry.regions) ? entry.regions.map(String) : [],
    timeout_seconds: typeof entry.timeout_seconds === "number" ? entry.timeout_seconds : 120,
  }))
}

/**
 * The complete `ProjectConfig` for a project, defaults filled in.
 *
 * Pages never see a partial config: a settings form bound to `undefined` is how
 * a save silently blanks a field the user never touched.
 */
export function materializeConfig(project: Project): ProjectConfig {
  const stored = project.config
  const variants = isRecord(stored.variants) ? stored.variants : {}

  return {
    version: typeof stored.version === "number" ? stored.version : 1,
    repository_url: project.repositoryUrl,
    lkg_branch: project.lkgBranch,
    hotfix_branch_prefix: project.hotfixBranchPrefix,
    previous_lkg: project.previousLkgMode === "pinned" ? project.previousLkgRef : null,
    variants: {
      baseline: mergeVariant(variants.baseline),
      initial: mergeVariant(variants.initial),
      hotfix: mergeVariant(variants.hotfix),
    },
    probes: readProbes(stored.probes),
    budget: { ...DEFAULT_BUDGET, ...(isRecord(stored.budget) ? stored.budget : {}) },
    promotion: { ...DEFAULT_PROMOTION, ...(isRecord(stored.promotion) ? stored.promotion : {}) },
    custom_probe_paths: Array.isArray(stored.custom_probe_paths)
      ? stored.custom_probe_paths.map(String)
      : ["sandman_probes"],
  }
}

/* ---------------------------------------------------------------------------
 * Variant deviation — the diff metaphor, reused inside settings
 * ------------------------------------------------------------------------ */

/** Fields a variant may legitimately differ on. Revision is not one of them. */
export const COMPARED_VARIANT_FIELDS = [
  "image",
  "setup_commands",
  "startup_command",
  "env",
  "port",
  "health_path",
  "regions",
  "replicas",
  "cpu",
  "memory_mb",
  "timeout_seconds",
] as const satisfies readonly (keyof VariantConfig)[]

export type ComparedField = (typeof COMPARED_VARIANT_FIELDS)[number]

/**
 * Which fields deviate from INITIAL.
 *
 * INITIAL is the reference on purpose: it is the code this rollout ships, so a
 * BASELINE or HOTFIX sandbox that is built differently is a confound — any
 * behavioural difference it produces cannot be attributed to the code.
 */
export function overridesAgainstInitial(
  variant: VariantConfig,
  initial: VariantConfig,
): ComparedField[] {
  return COMPARED_VARIANT_FIELDS.filter(
    (field) => JSON.stringify(variant[field]) !== JSON.stringify(initial[field]),
  )
}

/* ---------------------------------------------------------------------------
 * Context
 * ------------------------------------------------------------------------ */

export interface OrganizationContext {
  session: AppSession
  organization: Organization
  plan: Plan
  entitlements: string[]
  subscriptionStatus: string
  stripeSubscriptionId: string | null
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
}

export interface ProjectContext extends OrganizationContext {
  project: Project
  config: ProjectConfig
}

export const organizationContext = cache(async (): Promise<OrganizationContext> => {
  const session = await requireUser()
  const organization = await activeOrganization()

  const [row] = await db
    .select()
    .from(schema.subscription)
    .where(eq(schema.subscription.organizationId, organization.id))
    .limit(1)

  const entitlements = row?.entitlements ?? PLANS.free.entitlementKeys

  return {
    session,
    organization,
    entitlements,
    plan: planFor(entitlements),
    subscriptionStatus: row?.status ?? "active",
    stripeSubscriptionId: row?.stripeSubscriptionId ?? null,
    currentPeriodStart: row?.currentPeriodStart ?? null,
    currentPeriodEnd: row?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
  }
})

/** The organisation's project, or null before a repository is connected. */
export const currentProject = cache(async (): Promise<Project | null> => {
  const { organization } = await organizationContext()
  const [row] = await db
    .select()
    .from(schema.project)
    .where(eq(schema.project.organizationId, organization.id))
    .orderBy(asc(schema.project.createdAt))
    .limit(1)
  return row ?? null
})

/**
 * Context for a page that cannot function without a repository.
 *
 * Sends the user to the repo page rather than rendering an empty form: every
 * other settings page describes how a repository is probed, and there is
 * nothing coherent to show before one exists.
 */
export const projectContext = cache(async (): Promise<ProjectContext> => {
  const base = await organizationContext()
  const project = await currentProject()
  if (!project) redirect("/settings/repo")
  return { ...base, project, config: materializeConfig(project) }
})

/* ---------------------------------------------------------------------------
 * Usage and secrets
 * ------------------------------------------------------------------------ */

/**
 * This period's usage, from OUR counters.
 *
 * Not from Stripe: meter events are processed asynchronously and Stripe exposes
 * no real-time total, so a usage bar sourced from Stripe would lag by minutes
 * and read as broken. Stripe remains the authority for what is invoiced.
 */
export async function currentUsage(
  organizationId: string,
  periodStart: Date | null,
): Promise<UsageCounter | null> {
  const rows = periodStart
    ? await db
        .select()
        .from(schema.usageCounter)
        .where(
          and(
            eq(schema.usageCounter.organizationId, organizationId),
            eq(schema.usageCounter.periodStart, periodStart),
          ),
        )
        .limit(1)
    : await db
        .select()
        .from(schema.usageCounter)
        .where(eq(schema.usageCounter.organizationId, organizationId))
        .orderBy(desc(schema.usageCounter.periodStart))
        .limit(1)
  return rows[0] ?? null
}

/** Exactly the fields a secret may expose. The plaintext is not among them. */
export interface SecretSummary {
  id: string
  name: string
  lastFour: string
  keyVersion: number
  lastUsedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export async function listSecrets(projectId: string): Promise<SecretSummary[]> {
  // Column-by-column rather than `select()`: a `SELECT *` here would pull
  // ciphertext, iv, and the wrapped data key into a React Server Component's
  // props, and from there into the serialised payload sent to the browser.
  return db
    .select({
      id: schema.projectSecret.id,
      name: schema.projectSecret.name,
      lastFour: schema.projectSecret.lastFour,
      keyVersion: schema.projectSecret.keyVersion,
      lastUsedAt: schema.projectSecret.lastUsedAt,
      createdAt: schema.projectSecret.createdAt,
      updatedAt: schema.projectSecret.updatedAt,
    })
    .from(schema.projectSecret)
    .where(eq(schema.projectSecret.projectId, projectId))
    .orderBy(asc(schema.projectSecret.name))
}

/* ---------------------------------------------------------------------------
 * Misc
 * ------------------------------------------------------------------------ */

/** `owner/name` from any GitHub URL form we accept. */
export function repoParts(fullName: string): { owner: string; repo: string } | null {
  const [owner, repo] = fullName.split("/")
  if (!owner || !repo) return null
  return { owner, repo }
}

/** B → I → H, always. Re-exported so pages do not each import lib/variants. */
export { VARIANT_ORDER }
export type { VariantKey }
