"use server"

/**
 * Every settings mutation.
 *
 * Rules that hold for all of them:
 *
 * Nothing trusts the form. A Server Action is a public HTTP endpoint with a
 * nicer calling convention, so each one re-derives the session and the
 * organisation server-side and validates the payload with zod before it touches
 * a row. The `projectId` a form submits is never used as an authorisation
 * token — it is compared against the project the session actually owns.
 *
 * Nothing echoes a secret. Secret plaintext is read from FormData, sealed, and
 * dropped; it is never written to a log, an audit record, an error message, or
 * a return value.
 *
 * Failures come back as data. Throwing inside an action produces a generic
 * digest in production, which is exactly the wrong thing to show someone who
 * mistyped a branch name.
 */

import { revalidatePath } from "next/cache"
import { randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { z } from "zod"

import type { ProbeSpec, ProjectConfig, VariantConfig, VariantKey } from "@/lib/control-plane"
import { encryptSecret, secretsConfigured } from "@/lib/crypto"
import { db, schema } from "@/lib/db"
import { PLANS, isPlanId } from "@/lib/plans"
import { StripeNotConfiguredError, changePlan, stripeConfigured } from "@/lib/stripe"

import { materializeConfig, organizationContext, projectContext } from "./_data"
import { failed, succeeded, type ActionResult } from "./_types"

/* ---------------------------------------------------------------------------
 * Shared parsing
 * ------------------------------------------------------------------------ */

/**
 * An unchecked checkbox submits nothing at all, so `undefined` has to mean
 * false. Reading it as "missing, therefore leave unchanged" is how a toggle
 * becomes impossible to switch off.
 */
const checkbox = z.preprocess((value) => value === "on" || value === "true", z.boolean())

const branchName = z
  .string()
  .trim()
  .min(1, "A branch name is required.")
  .max(255)
  .regex(/^[^\s~^:?*[\\]+$/, "A branch name cannot contain spaces or any of ~ ^ : ? * [ \\.")

/** Splits a command line, honouring single and double quotes. */
function splitCommand(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null
  let started = false

  for (const char of input.trim()) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started || current) tokens.push(current)
      current = ""
      started = false
      continue
    }
    current += char
    started = true
  }
  if (started || current) tokens.push(current)
  return tokens.filter((token) => token.length > 0 || token === "")
}

function splitLines(input: string): string[] {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Mirrors the control plane's rule so the failure surfaces here, not mid-run. */
const CREDENTIAL_HINTS = ["secret", "password", "token", "api_key", "apikey"]

function parseEnvBlock(input: string): { env: Record<string, string> } | { error: string } {
  const env: Record<string, string> = {}
  for (const line of splitLines(input)) {
    if (line.startsWith("#")) continue
    const separator = line.indexOf("=")
    if (separator <= 0) {
      return { error: `"${line}" is not a KEY=value pair.` }
    }
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return { error: `"${key}" is not a valid environment variable name.` }
    }
    const lowered = key.toLowerCase()
    if (CREDENTIAL_HINTS.some((hint) => lowered.includes(hint))) {
      return {
        error: `${key} looks like a credential. Attach it through Secrets, which encrypts it, rather than through the variant config, which is stored in plaintext.`,
      }
    }
    env[key] = value
  }
  return { env }
}

/* ---------------------------------------------------------------------------
 * Persistence helpers
 * ------------------------------------------------------------------------ */

async function writeConfig(
  projectId: string,
  mutate: (config: ProjectConfig) => ProjectConfig,
): Promise<void> {
  const [project] = await db
    .select()
    .from(schema.project)
    .where(eq(schema.project.id, projectId))
    .limit(1)
  if (!project) throw new Error(`project ${projectId} disappeared mid-save`)

  const next = mutate(materializeConfig(project))
  await db
    .update(schema.project)
    .set({ config: next as unknown as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(schema.project.id, projectId))
}

async function audit(
  organizationId: string,
  actorId: string,
  action: string,
  subject: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(schema.auditLog).values({
    id: randomUUID(),
    organizationId,
    actorId,
    actorType: "user",
    action,
    subject,
    metadata,
  })
}

type OwnedProject =
  | { ok: false; error: string }
  | { ok: true; context: Awaited<ReturnType<typeof projectContext>> }

/** The project the *session* owns, ignoring whatever the form claimed. */
async function ownedProject(submittedId: string): Promise<OwnedProject> {
  const context = await projectContext()
  if (context.project.id !== submittedId) {
    return { ok: false, error: "That project does not belong to your workspace." }
  }
  return { ok: true, context }
}

/* ---------------------------------------------------------------------------
 * Repository
 * ------------------------------------------------------------------------ */

const connectSchema = z.object({
  installationId: z.coerce.number().int().positive(),
  repositoryFullName: z
    .string()
    .trim()
    .regex(/^[\w.-]+\/[\w.-]+$/, "Expected a repository in owner/name form."),
  defaultBranch: branchName,
})

export async function connectRepository(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = connectSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return failed(parsed.error.issues[0]?.message ?? "That repository selection is not valid.")
  }

  const { organization, session } = await organizationContext()
  const { installationId, repositoryFullName, defaultBranch } = parsed.data
  const [owner, name] = repositoryFullName.split("/")

  const [existing] = await db
    .select()
    .from(schema.project)
    .where(eq(schema.project.organizationId, organization.id))
    .limit(1)

  if (existing) {
    await db
      .update(schema.project)
      .set({
        name,
        repositoryUrl: `https://github.com/${repositoryFullName}`,
        repositoryFullName,
        installationId,
        lkgBranch: defaultBranch,
        updatedAt: new Date(),
      })
      .where(eq(schema.project.id, existing.id))
  } else {
    await db.insert(schema.project).values({
      id: randomUUID(),
      organizationId: organization.id,
      name,
      slug: `${owner}-${name}`.toLowerCase(),
      repositoryUrl: `https://github.com/${repositoryFullName}`,
      repositoryFullName,
      installationId,
      lkgBranch: defaultBranch,
      config: {},
    })
  }

  await audit(organization.id, session.user.id, "repository.connected", repositoryFullName, {
    installationId,
  })
  revalidatePath("/settings/repo")
  return succeeded(`Connected ${repositoryFullName}.`)
}

const repoSettingsSchema = z
  .object({
    projectId: z.string().min(1),
    lkgBranch: branchName,
    previousLkgMode: z.enum(["auto", "pinned"]),
    previousLkgRef: z.string().trim().max(255).optional().default(""),
    hotfixBranchPrefix: z
      .string()
      .trim()
      .min(1, "A hotfix branch prefix is required.")
      .max(120)
      .regex(/^[\w./-]+$/, "A prefix may contain letters, digits, and . _ - / only."),
    greptileAutoApprove: checkbox,
  })
  .superRefine((value, ctx) => {
    if (value.previousLkgMode === "pinned" && value.previousLkgRef.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["previousLkgRef"],
        message: "Pinning the baseline needs a tag, a sha, or a REF@SHA.",
      })
    }
  })

export async function saveRepoSettings(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = repoSettingsSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return failed(issue?.message ?? "Those settings are not valid.", String(issue?.path[0] ?? ""))
  }

  const owned = await ownedProject(parsed.data.projectId)
  if (!owned.ok) return failed(owned.error)
  const { organization, session, project } = owned.context

  const pinned = parsed.data.previousLkgMode === "pinned"

  await db
    .update(schema.project)
    .set({
      lkgBranch: parsed.data.lkgBranch,
      hotfixBranchPrefix: parsed.data.hotfixBranchPrefix,
      previousLkgMode: parsed.data.previousLkgMode,
      // Cleared rather than kept when switching back to auto: a stale pin left
      // in the column would silently reappear the next time someone toggled.
      previousLkgRef: pinned ? parsed.data.previousLkgRef : null,
      updatedAt: new Date(),
    })
    .where(eq(schema.project.id, project.id))

  await writeConfig(project.id, (config) => ({
    ...config,
    lkg_branch: parsed.data.lkgBranch,
    hotfix_branch_prefix: parsed.data.hotfixBranchPrefix,
    previous_lkg: pinned ? parsed.data.previousLkgRef : null,
    promotion: { ...config.promotion, auto_promote: parsed.data.greptileAutoApprove },
  }))

  await audit(organization.id, session.user.id, "repository.settings_saved", project.id, {
    lkgBranch: parsed.data.lkgBranch,
    previousLkgMode: parsed.data.previousLkgMode,
    autoPromote: parsed.data.greptileAutoApprove,
  })
  revalidatePath("/settings/repo")
  return succeeded("Repository settings saved.")
}

/* ---------------------------------------------------------------------------
 * Variants
 * ------------------------------------------------------------------------ */

const variantSchema = z.object({
  projectId: z.string().min(1),
  variant: z.enum(["baseline", "initial", "hotfix"]),
  enabled: checkbox,
  image: z.string().trim().min(1, "A base image is required.").max(255),
  setupCommands: z.string().max(8_000).default(""),
  startupCommand: z.string().trim().max(1_000).default(""),
  env: z.string().max(8_000).default(""),
  port: z.coerce.number().int().min(1).max(65_535),
  healthPath: z.string().trim().min(1).max(255).startsWith("/", "A health path starts with /."),
  regions: z.array(z.string()).default([]),
  replicas: z.coerce.number().int().min(1).max(4_000),
  resourceClass: z.enum(["small", "standard", "large", "xlarge"]),
  timeoutSeconds: z.coerce.number().int().min(30).max(86_400),
})

const RESOURCE_BY_CLASS: Record<string, { cpu: number; memoryMb: number }> = {
  small: { cpu: 0.5, memoryMb: 512 },
  standard: { cpu: 1, memoryMb: 1024 },
  large: { cpu: 2, memoryMb: 4096 },
  xlarge: { cpu: 4, memoryMb: 8192 },
}

export async function saveVariant(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = variantSchema.safeParse({
    ...Object.fromEntries(formData),
    regions: formData.getAll("regions").map(String),
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return failed(issue?.message ?? "That variant configuration is not valid.")
  }

  const owned = await ownedProject(parsed.data.projectId)
  if (!owned.ok) return failed(owned.error)
  const { organization, session, project } = owned.context

  const env = parseEnvBlock(parsed.data.env)
  if ("error" in env) return failed(env.error, "env")

  const resources = RESOURCE_BY_CLASS[parsed.data.resourceClass]
  if (!resources) return failed("Unknown resource class.")

  const variant = parsed.data.variant as VariantKey
  const next: VariantConfig = {
    enabled: parsed.data.enabled,
    image: parsed.data.image,
    setup_commands: splitLines(parsed.data.setupCommands),
    startup_command: splitCommand(parsed.data.startupCommand),
    env: env.env,
    port: parsed.data.port,
    health_path: parsed.data.healthPath,
    regions: parsed.data.regions,
    replicas: parsed.data.replicas,
    cpu: resources.cpu,
    memory_mb: resources.memoryMb,
    timeout_seconds: parsed.data.timeoutSeconds,
  }

  await writeConfig(project.id, (config) => ({
    ...config,
    variants: { ...config.variants, [variant]: next },
  }))

  await audit(organization.id, session.user.id, "variant.saved", `${project.id}:${variant}`, {
    replicas: next.replicas,
    regions: next.regions,
  })
  revalidatePath("/settings/variants")
  return succeeded(`${variant[0].toUpperCase()}${variant.slice(1)} variant saved.`)
}

/* ---------------------------------------------------------------------------
 * Probes
 * ------------------------------------------------------------------------ */

const probeSchema = z.object({
  projectId: z.string().min(1),
  probeId: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "A probe id is lowercase letters, digits, and hyphens."),
  preset: z.string().trim().min(1).max(80),
  enabled: checkbox,
  fanout: z.coerce.number().int().min(1).max(4_000),
  timeoutSeconds: z.coerce.number().int().min(1).max(86_400),
  endpoints: z.string().max(4_000).default(""),
  /** Free-form preset parameters, one `key=value` per line. */
  params: z.string().max(4_000).default(""),
})

/** Coerces a `key=value` line into the type the preset actually reads. */
function coerceParam(raw: string): unknown {
  if (raw === "true" || raw === "false") return raw === "true"
  if (raw !== "" && !Number.isNaN(Number(raw))) return Number(raw)
  return raw
}

export async function saveProbe(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = probeSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return failed(parsed.error.issues[0]?.message ?? "That probe configuration is not valid.")
  }

  const owned = await ownedProject(parsed.data.projectId)
  if (!owned.ok) return failed(owned.error)
  const { organization, session, project } = owned.context

  const params: Record<string, unknown> = {}
  const endpoints = splitLines(parsed.data.endpoints)
  if (endpoints.length > 0) params.endpoints = endpoints

  for (const line of splitLines(parsed.data.params)) {
    const separator = line.indexOf("=")
    if (separator <= 0) return failed(`"${line}" is not a key=value pair.`, "params")
    params[line.slice(0, separator).trim()] = coerceParam(line.slice(separator + 1).trim())
  }

  const spec: ProbeSpec = {
    id: parsed.data.probeId,
    preset: parsed.data.preset,
    module: null,
    enabled: parsed.data.enabled,
    params,
    fanout: parsed.data.fanout,
    regions: [],
    timeout_seconds: parsed.data.timeoutSeconds,
  }

  await writeConfig(project.id, (config) => {
    const probes = config.probes.filter((probe) => probe.id !== spec.id)
    probes.push(spec)
    // Sorted by id so the settings list and the run's probe order agree; an
    // unstable order makes two runs' fan-out grids impossible to compare.
    probes.sort((a, b) => a.id.localeCompare(b.id))
    return { ...config, probes }
  })

  await audit(organization.id, session.user.id, "probe.saved", `${project.id}:${spec.id}`, {
    preset: spec.preset,
    fanout: spec.fanout,
    enabled: spec.enabled,
  })
  revalidatePath("/settings/probes")
  return succeeded(`Probe ${spec.id} saved.`)
}

const probeToggleSchema = z.object({
  projectId: z.string().min(1),
  probeId: z.string().trim().min(1).max(80),
  preset: z.string().trim().min(1).max(80),
  enabled: checkbox,
})

/**
 * Turning a preset on for the first time materialises a probe entry with the
 * preset's own defaults, so the toggle is usable before anyone opens the drawer.
 */
export async function toggleProbe(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = probeToggleSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return failed("That probe is not valid.")

  const owned = await ownedProject(parsed.data.projectId)
  if (!owned.ok) return failed(owned.error)
  const { organization, session, project } = owned.context

  await writeConfig(project.id, (config) => {
    const index = config.probes.findIndex((probe) => probe.id === parsed.data.probeId)
    if (index === -1) {
      const probes = [
        ...config.probes,
        {
          id: parsed.data.probeId,
          preset: parsed.data.preset,
          module: null,
          enabled: parsed.data.enabled,
          params: {},
          fanout: 2,
          regions: [],
          timeout_seconds: 120,
        } satisfies ProbeSpec,
      ]
      probes.sort((a, b) => a.id.localeCompare(b.id))
      return { ...config, probes }
    }
    const probes = config.probes.slice()
    probes[index] = { ...probes[index], enabled: parsed.data.enabled }
    return { ...config, probes }
  })

  await audit(organization.id, session.user.id, "probe.toggled", `${project.id}:${parsed.data.probeId}`, {
    enabled: parsed.data.enabled,
  })
  revalidatePath("/settings/probes")
  return succeeded(
    parsed.data.enabled ? `${parsed.data.probeId} enabled.` : `${parsed.data.probeId} disabled.`,
  )
}

const customPathsSchema = z.object({
  projectId: z.string().min(1),
  customProbePaths: z.string().max(2_000).default(""),
})

export async function saveCustomProbePaths(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = customPathsSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return failed("Those discovery paths are not valid.")

  const owned = await ownedProject(parsed.data.projectId)
  if (!owned.ok) return failed(owned.error)
  const { project } = owned.context

  const paths = splitLines(parsed.data.customProbePaths)
  for (const path of paths) {
    if (path.startsWith("/") || path.includes("..")) {
      return failed(
        `"${path}" must be a module name or a path relative to the repository root.`,
        "customProbePaths",
      )
    }
  }

  await writeConfig(project.id, (config) => ({ ...config, custom_probe_paths: paths }))
  revalidatePath("/settings/probes")
  return succeeded("Custom probe discovery paths saved.")
}

/* ---------------------------------------------------------------------------
 * Budgets
 * ------------------------------------------------------------------------ */

const budgetSchema = z.object({
  projectId: z.string().min(1),
  maxUsdPerRun: z.coerce.number().positive("A run budget must be greater than zero.").max(10_000),
  maxConcurrentSandboxes: z.coerce.number().int().min(1).max(4_000),
  maxConcurrentLlm: z.coerce.number().int().min(1).max(256),
  maxWallClockSeconds: z.coerce.number().int().min(60).max(86_400),
  onExceed: z.enum(["warn", "hard_stop"]),
})

export async function saveBudget(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = budgetSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return failed(parsed.error.issues[0]?.message ?? "Those budget caps are not valid.")
  }

  const owned = await ownedProject(parsed.data.projectId)
  if (!owned.ok) return failed(owned.error)
  const { organization, session, project, plan } = owned.context

  // The plan's ceiling is the real one. Accepting a higher number here would
  // let the form promise a budget the control plane will refuse to honour.
  if (parsed.data.maxUsdPerRun > plan.maxUsdPerRun) {
    return failed(
      `${plan.displayName} caps a single run at $${plan.maxUsdPerRun}. Upgrade to raise it.`,
      "maxUsdPerRun",
    )
  }
  if (parsed.data.maxConcurrentSandboxes > plan.maxConcurrentSandboxes) {
    return failed(
      `${plan.displayName} allows ${plan.maxConcurrentSandboxes} concurrent sandboxes.`,
      "maxConcurrentSandboxes",
    )
  }

  await writeConfig(project.id, (config) => ({
    ...config,
    budget: {
      max_usd_per_run: parsed.data.maxUsdPerRun,
      max_concurrent_sandboxes: parsed.data.maxConcurrentSandboxes,
      max_concurrent_llm: parsed.data.maxConcurrentLlm,
      max_wall_clock_seconds: parsed.data.maxWallClockSeconds,
      on_exceed: parsed.data.onExceed,
    },
  }))

  await audit(organization.id, session.user.id, "budget.saved", project.id, {
    maxUsdPerRun: parsed.data.maxUsdPerRun,
    onExceed: parsed.data.onExceed,
  })
  revalidatePath("/settings/budgets")
  return succeeded("Budget caps saved.")
}

/* ---------------------------------------------------------------------------
 * Secrets
 * ------------------------------------------------------------------------ */

const secretSchema = z.object({
  projectId: z.string().min(1),
  name: z
    .string()
    .trim()
    .min(1, "A secret needs a name.")
    .max(120)
    .regex(/^[A-Z][A-Z0-9_]*$/, "Use SCREAMING_SNAKE_CASE, the form the sandbox reads."),
  value: z.string().min(1, "A secret cannot be empty.").max(16_384),
})

/**
 * Stores a secret, sealed.
 *
 * Write-only by construction: the ciphertext, the iv, the auth tag and the
 * wrapped data key all go to the database and the plaintext goes out of scope.
 * The only fragment that ever reaches a browser again is `lastFour`.
 */
export async function saveSecret(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  if (!secretsConfigured()) {
    return failed(
      "SANDMAN_KEK is not set, so secrets cannot be sealed. Generate one with: openssl rand -base64 32",
    )
  }

  const parsed = secretSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return failed(issue?.message ?? "That secret is not valid.", String(issue?.path[0] ?? ""))
  }

  const owned = await ownedProject(parsed.data.projectId)
  if (!owned.ok) return failed(owned.error)
  const { organization, session, project } = owned.context

  const sealed = encryptSecret(parsed.data.value)

  const [existing] = await db
    .select({ id: schema.projectSecret.id })
    .from(schema.projectSecret)
    .where(
      and(
        eq(schema.projectSecret.projectId, project.id),
        eq(schema.projectSecret.name, parsed.data.name),
      ),
    )
    .limit(1)

  if (existing) {
    await db
      .update(schema.projectSecret)
      .set({
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        authTag: sealed.authTag,
        wrappedKey: sealed.wrappedKey,
        keyVersion: sealed.keyVersion,
        lastFour: sealed.lastFour,
        // Rotation invalidates the previous value, so "last used" restarts.
        lastUsedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.projectSecret.id, existing.id))
  } else {
    await db.insert(schema.projectSecret).values({
      id: randomUUID(),
      projectId: project.id,
      name: parsed.data.name,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      authTag: sealed.authTag,
      wrappedKey: sealed.wrappedKey,
      keyVersion: sealed.keyVersion,
      lastFour: sealed.lastFour,
    })
  }

  // The name is recorded; the value never is.
  await audit(
    organization.id,
    session.user.id,
    existing ? "secret.rotated" : "secret.created",
    `${project.id}:${parsed.data.name}`,
  )
  revalidatePath("/settings/secrets")
  return succeeded(existing ? `${parsed.data.name} rotated.` : `${parsed.data.name} stored.`)
}

const revokeSchema = z.object({
  projectId: z.string().min(1),
  secretId: z.string().min(1),
})

export async function revokeSecret(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = revokeSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return failed("That secret is not valid.")

  const owned = await ownedProject(parsed.data.projectId)
  if (!owned.ok) return failed(owned.error)
  const { organization, session, project } = owned.context

  const [removed] = await db
    .delete(schema.projectSecret)
    .where(
      and(
        eq(schema.projectSecret.id, parsed.data.secretId),
        eq(schema.projectSecret.projectId, project.id),
      ),
    )
    .returning({ name: schema.projectSecret.name })

  if (!removed) return failed("That secret no longer exists.")

  await audit(
    organization.id,
    session.user.id,
    "secret.revoked",
    `${project.id}:${removed.name}`,
  )
  revalidatePath("/settings/secrets")
  return succeeded(`${removed.name} revoked. Any run still holding it will fail on next use.`)
}

/* ---------------------------------------------------------------------------
 * Billing
 * ------------------------------------------------------------------------ */

const planSchema = z.object({ plan: z.string().min(1) })

/**
 * Switches an existing subscription between paid plans.
 *
 * Not the Customer Portal: the portal cannot update a subscription that
 * contains a usage-based price. New subscriptions go through Checkout instead,
 * which is why this refuses when there is nothing to update.
 */
export async function switchPlan(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = planSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success || !isPlanId(parsed.data.plan)) return failed("Unknown plan.")
  if (parsed.data.plan === "free") {
    return failed("Cancel from the billing portal to return to Free at the end of the period.")
  }
  if (!stripeConfigured()) {
    return failed("STRIPE_SECRET_KEY is not set, so plans cannot be changed.")
  }

  const { organization, session, stripeSubscriptionId } = await organizationContext()
  if (!stripeSubscriptionId) {
    return failed("There is no active subscription to move; start a checkout instead.")
  }

  try {
    await changePlan(organization, parsed.data.plan)
  } catch (cause) {
    if (cause instanceof StripeNotConfiguredError) return failed(cause.message)
    return failed(cause instanceof Error ? cause.message : "Stripe rejected the plan change.")
  }

  await audit(organization.id, session.user.id, "billing.plan_changed", organization.id, {
    plan: parsed.data.plan,
  })
  revalidatePath("/settings/billing")
  return succeeded(
    `Moved to ${PLANS[parsed.data.plan].displayName}. The difference is prorated on your next invoice.`,
  )
}
