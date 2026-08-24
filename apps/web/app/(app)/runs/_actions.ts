"use server"

import { revalidatePath } from "next/cache"
import { eq } from "drizzle-orm"

import { activeOrganization, requireUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { project as projectTable, run as runTable } from "@/lib/db/schema"
import { startRun, validateConfig, type ProjectConfig } from "@/lib/control-plane"

export type StartProbeResult = { ok: true; runId: string } | { ok: false; error: string }

/**
 * Queue a probe run for a project.
 *
 * The control plane owns the run: it returns a run id immediately and streams
 * progress over SSE, because a fan-out outlives any request deadline. This
 * action records the run locally so the list has a row to render before the
 * first event arrives.
 */
export async function startProbeRun(projectId: string): Promise<StartProbeResult> {
  const session = await requireUser()
  const organization = await activeOrganization()
  const organizationId = organization.id

  const [project] = await db
    .select()
    .from(projectTable)
    .where(eq(projectTable.id, projectId))
    .limit(1)

  if (!project) return { ok: false, error: "Project not found." }
  if (project.organizationId !== organizationId) {
    return { ok: false, error: "Project not found." }
  }

  const config = project.config as unknown as ProjectConfig
  if (!config || typeof config !== "object" || !("repository_url" in config)) {
    return { ok: false, error: "This project has no probe configuration yet." }
  }

  try {
    // Refuse a run whose worst case cannot fit the budget before provisioning
    // anything, rather than discovering the ceiling halfway through and paying
    // for sandboxes whose results are thrown away.
    const preflight = await validateConfig(config)
    if (!preflight.withinBudget) {
      return {
        ok: false,
        error:
          `Projected worst case $${preflight.projectedWorstCaseUsd.toFixed(2)} exceeds the ` +
          `$${preflight.budgetUsd.toFixed(2)} cap. Lower the replica count or raise the cap in Budgets.`,
      }
    }

    const started = await startRun(config)

    await db.insert(runTable).values({
      id: started.run_id,
      projectId: project.id,
      organizationId,
      state: started.state,
      trigger: "manual",
      triggeredBy: session.user.id,
      probeCount: preflight.probeCount,
    })

    revalidatePath("/runs")
    revalidatePath("/dashboard")
    return { ok: true, runId: started.run_id }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "The control plane did not respond."
    return {
      ok: false,
      error: `${message} Is it running? Start it with \`uv run sandman serve\`.`,
    }
  }
}
