/**
 * Budget settings.
 *
 * The projection is priced by the control plane, not re-derived here. It is the
 * same `estimate_run_cost` the budget tracker enforces at run time, so the
 * number on this page and the number that aborts a run cannot disagree.
 */

import {
  ControlPlaneError,
  validateConfig,
  type ValidateConfigResponse,
} from "@/lib/control-plane"
import { formatDuration, formatUsd, pluralize } from "@/lib/utils"
import { VARIANT_META } from "@/lib/variants"

import { Callout, Chip, DetailRow, Meter, PageHeader, Panel, PanelBody, PanelHeader } from "../_ui"
import { projectContext } from "../_data"
import { BudgetForm } from "./_client"

export const dynamic = "force-dynamic"

/** The fraction at which the run emits a soft alert instead of just spending. */
const SOFT_ALERT = 0.8

export default async function BudgetSettingsPage() {
  const { project, config, plan } = await projectContext()

  let projection: ValidateConfigResponse | null = null
  let projectionError: string | null = null
  try {
    projection = await validateConfig(config)
  } catch (cause) {
    projectionError =
      cause instanceof ControlPlaneError
        ? cause.isUnreachable
          ? "The control plane is not reachable, so this configuration could not be priced. Start it with `uv run sandman serve`."
          : cause.detail ?? cause.message
        : "This configuration could not be priced."
  }

  const cap = config.budget.max_usd_per_run
  const projected = projection?.projectedWorstCaseUsd ?? 0
  const ratio = cap > 0 ? projected / cap : 0

  return (
    <div className="flex max-w-[880px] flex-col gap-5">
      <PageHeader
        title="Budgets"
        description="Two independent ceilings bind a run: Modal's container quota and the LLM provider's org-level rate bucket, which every sandbox shares through one key. Both are enforced by the control plane, not by this form."
      />

      <Panel>
        <PanelHeader
          title={<span className="text-h4 text-[var(--fg-primary)]">Projected worst case</span>}
          description="Every enabled variant, at full replica count, running to its timeout."
          aside={
            projection ? (
              <Chip color={projection.withinBudget ? "var(--status-pass)" : "var(--status-fail)"}>
                {projection.withinBudget ? "within budget" : "over budget"}
              </Chip>
            ) : null
          }
        />
        <PanelBody>
          {projectionError ? (
            <Callout tone="caution" title="Not priced">
              {projectionError}
            </Callout>
          ) : projection ? (
            <>
              <Meter
                label="Worst-case run cost against the cap"
                value={projected}
                limit={cap}
                softThreshold={SOFT_ALERT}
                readout={`${formatUsd(projected)} / ${formatUsd(cap)}`}
              />

              {!projection.withinBudget ? (
                <Callout tone="danger" title="This configuration cannot run to completion">
                  At {formatUsd(projected)} the worst case exceeds the {formatUsd(cap)} cap. With
                  <span className="mono"> hard_stop</span> the run aborts partway and produces no
                  verdict; reduce replicas or fan-out, or raise the cap.
                </Callout>
              ) : ratio >= SOFT_ALERT ? (
                <Callout tone="caution" title="Above the soft-alert threshold">
                  The projection is at {Math.round(ratio * 100)}% of the cap. A run crossing{" "}
                  {Math.round(SOFT_ALERT * 100)}% records a budget warning on its summary while
                  continuing.
                </Callout>
              ) : null}

              <div className="mt-1 border-t border-[var(--border-hairline)] pt-1">
                <DetailRow label="Active variants">
                  {projection.activeVariants
                    .map((variant) => VARIANT_META[variant].glyph)
                    .join(" → ") || "none"}
                </DetailRow>
                <DetailRow label="Enabled probes">
                  <span className="mono" data-numeric="">
                    {projection.probeCount}
                  </span>
                </DetailRow>
                <DetailRow label="Total fan-out">
                  <span className="mono" data-numeric="">
                    {projection.totalFanout}
                  </span>{" "}
                  {pluralize(projection.totalFanout, "sandbox", "sandboxes")}
                </DetailRow>
                <DetailRow label="Plan ceiling">
                  {formatUsd(plan.maxUsdPerRun)} per run · {plan.maxConcurrentSandboxes} concurrent
                </DetailRow>
                <DetailRow label="Wall clock cap">
                  {formatDuration(config.budget.max_wall_clock_seconds * 1000)}
                </DetailRow>
              </div>
            </>
          ) : null}
        </PanelBody>
      </Panel>

      <BudgetForm
        projectId={project.id}
        budget={config.budget}
        planName={plan.displayName}
        maxUsdPerRun={plan.maxUsdPerRun}
        maxConcurrentSandboxes={plan.maxConcurrentSandboxes}
      />
    </div>
  )
}
