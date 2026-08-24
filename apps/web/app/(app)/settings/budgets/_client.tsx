"use client"

import * as React from "react"

import type { BudgetCaps } from "@/lib/control-plane"
import { formatUsd } from "@/lib/utils"

import { saveBudget } from "../_actions"
import { ActionForm, HiddenValue, SegmentedField, SubmitButton } from "../_controls"
import {
  Field,
  NumberInput,
  Panel,
  PanelBody,
  PanelFooter,
  PanelHeader,
} from "../_ui"

const ON_EXCEED_OPTIONS = [
  { value: "warn" as const, label: "Warn" },
  { value: "hard_stop" as const, label: "Hard-stop" },
]

export function BudgetForm({
  projectId,
  budget,
  planName,
  maxUsdPerRun,
  maxConcurrentSandboxes,
}: {
  projectId: string
  budget: BudgetCaps
  planName: string
  maxUsdPerRun: number
  maxConcurrentSandboxes: number
}) {
  const [onExceed, setOnExceed] = React.useState<"warn" | "hard_stop">(budget.on_exceed)

  return (
    <ActionForm action={saveBudget}>
      <HiddenValue name="projectId" value={projectId} />

      <Panel>
        <PanelHeader
          title={<span className="text-h4 text-[var(--fg-primary)]">Caps</span>}
          description="Applied per run. A run that trips a ceiling records why on its summary rather than failing silently."
        />
        <PanelBody>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Max $ per run"
              htmlFor="maxUsdPerRun"
              hint={`${planName} allows up to ${formatUsd(maxUsdPerRun)}.`}
            >
              <NumberInput
                id="maxUsdPerRun"
                name="maxUsdPerRun"
                defaultValue={budget.max_usd_per_run}
                min={0.01}
                max={maxUsdPerRun}
                step={0.25}
              />
            </Field>

            <Field
              label="Max wall clock"
              htmlFor="maxWallClockSeconds"
              hint="Seconds from queue to verdict, across every phase."
            >
              <NumberInput
                id="maxWallClockSeconds"
                name="maxWallClockSeconds"
                defaultValue={budget.max_wall_clock_seconds}
                min={60}
                max={86400}
                step={60}
              />
            </Field>

            <Field
              label="Max concurrent sandboxes"
              htmlFor="maxConcurrentSandboxes"
              hint={`Modal's container quota. ${planName} allows ${maxConcurrentSandboxes}.`}
            >
              <NumberInput
                id="maxConcurrentSandboxes"
                name="maxConcurrentSandboxes"
                defaultValue={budget.max_concurrent_sandboxes}
                min={1}
                max={maxConcurrentSandboxes}
              />
            </Field>

            <Field
              label="Max concurrent LLM calls"
              htmlFor="maxConcurrentLlm"
              hint="Every sandbox shares one org-level rate bucket, so this is a global ceiling and not a per-sandbox one."
            >
              <NumberInput
                id="maxConcurrentLlm"
                name="maxConcurrentLlm"
                defaultValue={budget.max_concurrent_llm}
                min={1}
                max={256}
              />
            </Field>
          </div>

          <Field
            label="On exceed"
            hint={
              onExceed === "hard_stop"
                ? "The run aborts the moment a ceiling is crossed. Nothing further is spent, and no verdict is produced."
                : "The run records a budget warning and keeps going. Use this only when an incomplete verdict would be worse than the overspend."
            }
          >
            <SegmentedField
              name="onExceed"
              defaultValue={budget.on_exceed}
              options={ON_EXCEED_OPTIONS}
              onValueChange={setOnExceed}
              aria-label="Behaviour when a budget ceiling is exceeded"
            />
          </Field>
        </PanelBody>
        <PanelFooter>
          <span className="text-caption text-[var(--fg-tertiary)]">
            Caps above the plan ceiling are rejected on save.
          </span>
          <SubmitButton />
        </PanelFooter>
      </Panel>
    </ActionForm>
  )
}
