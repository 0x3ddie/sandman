/**
 * Probe settings.
 *
 * Preset descriptions come from the control plane rather than being duplicated
 * here. The presets are Python builders — what one actually asserts is a
 * property of that code, and a second copy of the prose in TypeScript would
 * start drifting the first time someone tightened a check.
 */

import { ControlPlaneError, getPresets, type PresetDescription } from "@/lib/control-plane"

import { Callout, PageHeader, Panel, PanelBody, PanelHeader } from "../_ui"
import { projectContext } from "../_data"
import { CustomProbes, PresetRow } from "./_client"

export const dynamic = "force-dynamic"

async function loadPresets(): Promise<{ presets: PresetDescription[]; error: string | null }> {
  try {
    const response = await getPresets()
    return { presets: response.presets, error: null }
  } catch (cause) {
    if (cause instanceof ControlPlaneError) {
      return {
        presets: [],
        error: cause.isUnreachable
          ? "The control plane is not reachable, so preset descriptions could not be loaded. Start it with `uv run sandman serve`."
          : cause.message,
      }
    }
    throw cause
  }
}

export default async function ProbeSettingsPage() {
  const { project, config } = await projectContext()
  const { presets, error } = await loadPresets()

  return (
    <div className="flex max-w-[880px] flex-col gap-5">
      <PageHeader
        title="Probes"
        description="What each sandbox is asked to do. Every probe runs against all three variants and across every replica, so its result is only meaningful if it is read-only and idempotent."
      />

      {error ? (
        <Callout tone="caution" title="Preset descriptions unavailable">
          {error}
        </Callout>
      ) : null}

      <Panel>
        <PanelHeader
          title={<span className="text-h4 text-[var(--fg-primary)]">Built-in presets</span>}
          description="A preset is a builder, not a fixed probe: it reads your parameters and produces concrete probes for the endpoints you actually have."
        />
        <PanelBody className="gap-0 px-0 py-0">
          {presets.length === 0 ? (
            <p className="text-body-sm px-5 py-6 text-[var(--fg-tertiary)]">
              No presets to show.
            </p>
          ) : (
            presets.map((preset, index) => {
              // Matched on `preset`, not on id: a project may name its probe
              // anything (sandman.toml calls one "catalog-fuzz"), and matching
              // on id alone would silently orphan that configuration.
              const configured = config.probes.find((probe) => probe.preset === preset.id) ?? null
              return (
                <PresetRow
                  key={preset.id}
                  projectId={project.id}
                  preset={preset}
                  probe={configured}
                  first={index === 0}
                />
              )
            })
          )}
        </PanelBody>
      </Panel>

      <CustomProbes projectId={project.id} paths={config.custom_probe_paths} />
    </div>
  )
}
