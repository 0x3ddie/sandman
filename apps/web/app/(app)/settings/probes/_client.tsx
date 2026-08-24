"use client"

import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"
import { SlidersHorizontal } from "phosphor-react"

import { Button } from "@/components/ui/button"
import type { ProbeSpec, PresetDescription } from "@/lib/control-plane"
import { cn } from "@/lib/utils"

import { saveCustomProbePaths, saveProbe, toggleProbe } from "../_actions"
import { ActionForm, Drawer, HiddenValue, SubmitButton } from "../_controls"
import {
  Chip,
  Field,
  NumberInput,
  Panel,
  PanelBody,
  PanelFooter,
  PanelHeader,
  TextArea,
} from "../_ui"

/* ---------------------------------------------------------------------------
 * Preset row
 * ------------------------------------------------------------------------ */

export function PresetRow({
  projectId,
  preset,
  probe,
  first,
}: {
  projectId: string
  preset: PresetDescription
  probe: ProbeSpec | null
  first: boolean
}) {
  const probeId = probe?.id ?? preset.id
  const enabled = probe?.enabled ?? false

  return (
    <div
      className={cn(
        "flex items-start gap-4 px-5 py-4",
        !first && "border-t border-[var(--border-hairline)]",
      )}
    >
      <ProbeSwitch projectId={projectId} probeId={probeId} preset={preset.id} enabled={enabled} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mono text-[12.5px] text-[var(--fg-primary)]">{preset.id}</span>
          {probe && probe.id !== preset.id ? <Chip>id: {probe.id}</Chip> : null}
          {probe ? (
            <Chip color={enabled ? "var(--status-pass)" : undefined}>
              ×{probe.fanout} fan-out
            </Chip>
          ) : null}
        </div>
        <p className="text-body-sm mt-1 max-w-[62ch] text-[var(--fg-tertiary)]">
          {preset.description}
        </p>
      </div>

      <ProbeConfigDrawer projectId={projectId} preset={preset} probe={probe} probeId={probeId} />
    </div>
  )
}

/**
 * A switch that submits on change.
 *
 * The hidden input is ours rather than Radix's bubbled one: `requestSubmit`
 * fires immediately after the state update, and the effect guarantees React has
 * already committed the new value to the DOM before the form is read.
 */
function ProbeSwitch({
  projectId,
  probeId,
  preset,
  enabled,
}: {
  projectId: string
  probeId: string
  preset: string
  enabled: boolean
}) {
  const formRef = React.useRef<HTMLFormElement>(null)
  const [checked, setChecked] = React.useState(enabled)
  const dirty = React.useRef(false)

  React.useEffect(() => {
    if (!dirty.current) return
    formRef.current?.requestSubmit()
  }, [checked])

  return (
    <ActionForm action={toggleProbe} className="shrink-0 pt-0.5">
      <HiddenValue name="projectId" value={projectId} />
      <HiddenValue name="probeId" value={probeId} />
      <HiddenValue name="preset" value={preset} />
      <input type="hidden" name="enabled" value={checked ? "true" : "false"} />
      <FormRefAnchor formRef={formRef} />
      <SwitchPrimitive.Root
        checked={checked}
        onCheckedChange={(next) => {
          dirty.current = true
          setChecked(next)
        }}
        aria-label={`Enable ${preset}`}
        className={cn(
          "relative inline-flex h-[20px] w-[34px] shrink-0 items-center rounded-[6px] border",
          "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
          "border-[var(--border-default)] bg-[var(--bg-raised)]",
          "data-[state=checked]:border-[var(--accent-border)] data-[state=checked]:bg-[var(--accent-wash)]",
        )}
      >
        <SwitchPrimitive.Thumb
          className={cn(
            "block h-[14px] w-[14px] translate-x-[2px] rounded-[4px] bg-[var(--fg-tertiary)]",
            "transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)]",
            "data-[state=checked]:translate-x-[16px] data-[state=checked]:bg-[var(--accent-400)]",
          )}
        />
      </SwitchPrimitive.Root>
    </ActionForm>
  )
}

/** Hands the enclosing <form> element back up, since ActionForm owns it. */
function FormRefAnchor({ formRef }: { formRef: React.RefObject<HTMLFormElement | null> }) {
  const anchor = React.useRef<HTMLSpanElement>(null)
  React.useEffect(() => {
    formRef.current = anchor.current?.closest("form") ?? null
  }, [formRef])
  return <span ref={anchor} hidden />
}

/* ---------------------------------------------------------------------------
 * Parameter drawer
 * ------------------------------------------------------------------------ */

function joinParams(params: Record<string, unknown>): string {
  return Object.entries(params)
    .filter(([key]) => key !== "endpoints")
    .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join("\n")
}

function joinEndpoints(params: Record<string, unknown>): string {
  const endpoints = params.endpoints
  return Array.isArray(endpoints) ? endpoints.map(String).join("\n") : ""
}

function ProbeConfigDrawer({
  projectId,
  preset,
  probe,
  probeId,
}: {
  projectId: string
  preset: PresetDescription
  probe: ProbeSpec | null
  probeId: string
}) {
  return (
    <Drawer
      trigger={
        <Button variant="secondary" size="sm" className="shrink-0">
          <SlidersHorizontal size={16} weight="regular" aria-hidden />
          Configure
        </Button>
      }
      title={preset.id}
      description={preset.description}
    >
      <ActionForm action={saveProbe} className="flex flex-col gap-4">
        <HiddenValue name="projectId" value={projectId} />
        <HiddenValue name="preset" value={preset.id} />
        <HiddenValue name="probeId" value={probeId} />
        <HiddenValue name="enabled" value={probe?.enabled === false ? "false" : "true"} />

        <div className="flex items-center gap-2">
          <span className="text-caption text-[var(--fg-tertiary)]">Probe id</span>
          <span className="mono text-[12.5px] text-[var(--fg-primary)]">{probeId}</span>
        </div>

        <Field
          label="Endpoints"
          htmlFor={`${probeId}-endpoints`}
          hint="One path per line. Left empty, the preset falls back to the health check alone."
        >
          <TextArea
            id={`${probeId}-endpoints`}
            name="endpoints"
            rows={4}
            defaultValue={probe ? joinEndpoints(probe.params) : ""}
            placeholder={"/api/catalog/search\n/api/catalog/facets"}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Fan-out"
            htmlFor={`${probeId}-fanout`}
            hint="Sub-sandboxes per variant."
          >
            <NumberInput
              id={`${probeId}-fanout`}
              name="fanout"
              defaultValue={probe?.fanout ?? 2}
              min={1}
              max={4000}
            />
          </Field>
          <Field label="Timeout" htmlFor={`${probeId}-timeout`} hint="Seconds.">
            <NumberInput
              id={`${probeId}-timeout`}
              name="timeoutSeconds"
              defaultValue={probe?.timeout_seconds ?? 120}
              min={1}
              max={86400}
              step={10}
            />
          </Field>
        </div>

        <Field
          label="Parameters"
          htmlFor={`${probeId}-params`}
          hint={PARAM_HINTS[preset.id] ?? "key=value, one per line. Numbers and booleans are coerced."}
        >
          <TextArea
            id={`${probeId}-params`}
            name="params"
            rows={5}
            defaultValue={probe ? joinParams(probe.params) : ""}
            placeholder={PARAM_PLACEHOLDERS[preset.id] ?? "param=q"}
          />
        </Field>

        <div className="flex items-center justify-end gap-2 pt-1">
          <SubmitButton size="md">Save probe</SubmitButton>
        </div>
      </ActionForm>
    </Drawer>
  )
}

/** Named so the drawer explains what each preset actually reads. */
const PARAM_HINTS: Record<string, string> = {
  "api-fuzz-differential": "param (query parameter to fuzz), pagination (true/false).",
  "load-chaos-fanout": "burst, concurrency, tolerated_error_rate, health_path.",
  "security-probe-suite": "param (query parameter to attack).",
  "latency-slo-guard": "samples, concurrency, p95_ms, min_success_rate.",
}

const PARAM_PLACEHOLDERS: Record<string, string> = {
  "api-fuzz-differential": "param=q\npagination=true",
  "load-chaos-fanout": "burst=20\nconcurrency=10",
  "security-probe-suite": "param=q",
  "latency-slo-guard": "samples=20\np95_ms=750\nmin_success_rate=0.99",
}

/* ---------------------------------------------------------------------------
 * Custom probes
 * ------------------------------------------------------------------------ */

const SDK_EXAMPLE = `from sandman_sdk import Target, expect, probe

@probe(id="search-last-page", fanout=10, tags=["pagination"])
async def search_last_page(t: Target) -> None:
    r = await t.get("/api/catalog/search", params={"limit": 20, "offset": 230})
    expect(r).status(200)
    expect(r).json_contains({"has_more": False})`

export function CustomProbes({ projectId, paths }: { projectId: string; paths: string[] }) {
  return (
    <ActionForm action={saveCustomProbePaths}>
      <HiddenValue name="projectId" value={projectId} />
      <Panel>
        <PanelHeader
          title={<span className="text-h4 text-[var(--fg-primary)]">Custom probes</span>}
          description="Anything the presets cannot express is a decorated async function in your own repository. sandman imports these modules so their decorators register."
        />
        <PanelBody>
          <Field
            label="Discovery paths"
            htmlFor="customProbePaths"
            hint="Module names or repository-relative paths, one per line. Files beginning with an underscore are skipped."
          >
            <TextArea
              id="customProbePaths"
              name="customProbePaths"
              rows={3}
              defaultValue={paths.join("\n")}
              placeholder="sandman_probes"
            />
          </Field>

          <div className="flex flex-col gap-2">
            <span className="text-label text-[var(--fg-secondary)]">What one looks like</span>
            <pre className="no-grain overflow-x-auto rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-inset)] p-3.5 text-[12.5px] leading-[1.55] text-[var(--fg-secondary)]">
              <code>{SDK_EXAMPLE}</code>
            </pre>
            <p className="text-caption text-[var(--fg-tertiary)]">
              Three rules the harness enforces: probes are idempotent, probes carry no credentials,
              and a failed assertion is recorded as a FAIL rather than crashing the run.
            </p>
          </div>
        </PanelBody>
        <PanelFooter>
          <span className="text-caption text-[var(--fg-tertiary)]">
            Discovery runs at the start of every run, inside the sandbox.
          </span>
          <SubmitButton size="sm">Save paths</SubmitButton>
        </PanelFooter>
      </Panel>
    </ActionForm>
  )
}
