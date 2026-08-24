"use client"

import * as React from "react"

import { VariantBadge } from "@/components/ui/variant-badge"
import type { VariantConfig } from "@/lib/control-plane"
import type { Variant } from "@/lib/variants"
import { pluralize } from "@/lib/utils"

import { saveVariant } from "../_actions"
import { ActionForm, ChipMultiSelect, HiddenValue, Stepper, SubmitButton, Toggle } from "../_controls"
import type { ComparedField } from "../_data"
import {
  Chip,
  Field,
  NumberInput,
  Panel,
  PanelBody,
  PanelFooter,
  PanelHeader,
  Select,
  TextArea,
  TextInput,
} from "../_ui"

/** Re-quotes any token containing whitespace so a round trip is lossless. */
function joinCommand(tokens: string[]): string {
  return tokens.map((token) => (/\s/.test(token) ? JSON.stringify(token) : token)).join(" ")
}

function joinEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
}

const RESOURCE_OPTIONS: readonly { id: string; label: string }[] = [
  { id: "small", label: "Small · 0.5 vCPU, 512 MB — single-endpoint probes" },
  { id: "standard", label: "Standard · 1 vCPU, 1 GB — the default" },
  { id: "large", label: "Large · 2 vCPU, 4 GB — load and chaos fan-out" },
  { id: "xlarge", label: "Extra large · 4 vCPU, 8 GB — heavyweight images" },
]

export function VariantCard({
  projectId,
  variant,
  glyph,
  label,
  color,
  description,
  settings,
  overrides,
  resourceClass,
  regions,
}: {
  projectId: string
  variant: Variant
  glyph: string
  label: string
  color: string
  description: string
  settings: VariantConfig
  overrides: ComparedField[]
  resourceClass: string
  regions: readonly { id: string; label: string }[]
}) {
  const deviates = React.useCallback(
    (field: ComparedField) => (overrides.includes(field) ? { color } : undefined),
    [overrides, color],
  )

  return (
    <ActionForm action={saveVariant}>
      <HiddenValue name="projectId" value={projectId} />
      <HiddenValue name="variant" value={variant} />

      <Panel className="h-full">
        <PanelHeader
          accent={color}
          title={
            <>
              <VariantBadge variant={variant} showLabel={false} />
              <span className="text-h4 text-[var(--fg-primary)]">{label}</span>
              <span aria-hidden className="mono text-[11px] text-[var(--fg-quaternary)]">
                {glyph}
              </span>
            </>
          }
          description={description}
          aside={
            variant === "initial" ? (
              <Chip color="var(--variant-initial)">reference</Chip>
            ) : overrides.length > 0 ? (
              <Chip color={color}>
                · {overrides.length} {pluralize(overrides.length, "override")}
              </Chip>
            ) : (
              <Chip color="var(--status-pass)">matches I</Chip>
            )
          }
        />

        <PanelBody>
          <Toggle
            name="enabled"
            defaultChecked={settings.enabled}
            label="Run this variant"
            description={
              variant === "hotfix"
                ? "Turning this off stops sandman authoring patches; probes still compare B against I."
                : undefined
            }
          />

          <Field label="Base image" htmlFor={`${variant}-image`} override={deviates("image")}>
            <TextInput
              id={`${variant}-image`}
              name="image"
              defaultValue={settings.image}
              spellCheck={false}
              className="mono text-[12.5px]"
            />
          </Field>

          <Field
            label="Setup commands"
            htmlFor={`${variant}-setup`}
            hint="One per line, run in order before the service starts."
            override={deviates("setup_commands")}
          >
            <TextArea
              id={`${variant}-setup`}
              name="setupCommands"
              rows={3}
              defaultValue={settings.setup_commands.join("\n")}
              placeholder="pip install --no-cache-dir -r requirements.txt"
            />
          </Field>

          <Field
            label="Startup command"
            htmlFor={`${variant}-start`}
            hint="Quoting is honoured; everything else splits on whitespace."
            override={deviates("startup_command")}
          >
            <TextInput
              id={`${variant}-start`}
              name="startupCommand"
              defaultValue={joinCommand(settings.startup_command)}
              placeholder="python target-app/main.py"
              spellCheck={false}
              className="mono text-[12.5px]"
            />
          </Field>

          <Field
            label="Environment"
            htmlFor={`${variant}-env`}
            hint="KEY=value, one per line. Stored in plaintext — anything that looks like a credential is rejected; use Secrets instead."
            override={deviates("env")}
          >
            <TextArea
              id={`${variant}-env`}
              name="env"
              rows={3}
              defaultValue={joinEnv(settings.env)}
              placeholder="LOG_LEVEL=info"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Port" htmlFor={`${variant}-port`} override={deviates("port")}>
              <NumberInput
                id={`${variant}-port`}
                name="port"
                defaultValue={settings.port}
                min={1}
                max={65535}
              />
            </Field>
            <Field
              label="Health path"
              htmlFor={`${variant}-health`}
              override={deviates("health_path")}
            >
              <TextInput
                id={`${variant}-health`}
                name="healthPath"
                defaultValue={settings.health_path}
                spellCheck={false}
                className="mono text-[12.5px]"
              />
            </Field>
          </div>

          <Field
            label="Regions"
            hint="Multi-region fan-out surfaces failures that only appear under real network latency."
            override={deviates("regions")}
          >
            <ChipMultiSelect
              name="regions"
              options={regions}
              defaultValue={settings.regions}
              emptyLabel="No region pinned — Modal places sandboxes wherever there is capacity."
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Replicas"
              hint="Fan-out width for this variant."
              override={deviates("replicas")}
            >
              <Stepper
                name="replicas"
                defaultValue={settings.replicas}
                min={1}
                max={4000}
                aria-label={`${label} replicas`}
              />
            </Field>
            <Field
              label="Timeout"
              htmlFor={`${variant}-timeout`}
              hint="Seconds. Always explicit: Modal's own default is 5 minutes."
              override={deviates("timeout_seconds")}
            >
              <NumberInput
                id={`${variant}-timeout`}
                name="timeoutSeconds"
                defaultValue={settings.timeout_seconds}
                min={30}
                max={86400}
                step={30}
              />
            </Field>
          </div>

          <Field
            label="Resource class"
            htmlFor={`${variant}-resources`}
            hint={
              resourceClass === "custom"
                ? `Currently ${settings.cpu} vCPU / ${settings.memory_mb} MB, set outside these presets. Saving will snap it to the chosen class.`
                : undefined
            }
            override={deviates("cpu") ?? deviates("memory_mb")}
          >
            <Select
              id={`${variant}-resources`}
              name="resourceClass"
              defaultValue={resourceClass === "custom" ? "standard" : resourceClass}
            >
              {RESOURCE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        </PanelBody>

        <PanelFooter>
          <span className="text-caption text-[var(--fg-tertiary)]">
            {overrides.length > 0 && variant !== "initial"
              ? `Deviates from INITIAL on ${overrides.join(", ")}.`
              : "Built exactly like INITIAL."}
          </span>
          <SubmitButton size="sm">Save {glyph}</SubmitButton>
        </PanelFooter>
      </Panel>
    </ActionForm>
  )
}
