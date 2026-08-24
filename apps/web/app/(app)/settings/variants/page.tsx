/**
 * Variant settings.
 *
 * The three cards are always BASELINE / INITIAL / HOTFIX, left to right. That
 * order is part of the encoding, not a layout preference, so this page does not
 * reflow them on narrow screens — it stacks them in the same sequence.
 *
 * Every field that differs from INITIAL is marked, and the card header counts
 * the deviations. This is the run page's diff metaphor turned back on the
 * configuration itself: the whole comparison is only sound while the three
 * sandboxes are built identically, so a difference here is something the reader
 * should have to acknowledge rather than discover afterwards.
 */

import { VARIANT_META, VARIANT_ORDER } from "@/lib/variants"

import { PageHeader } from "../_ui"
import { MODAL_REGIONS, overridesAgainstInitial, projectContext, resourceClassFor } from "../_data"
import { VariantCard } from "./_client"

export const dynamic = "force-dynamic"

export default async function VariantSettingsPage() {
  const { project, config } = await projectContext()
  const initial = config.variants.initial

  return (
    <div className="flex max-w-[1180px] flex-col gap-5">
      <PageHeader
        title="Variants"
        description="How each of the three sandboxes is built. They should differ only in revision — anything else is a confound, because a behavioural difference it produces cannot be attributed to the code."
      />

      <div className="grid gap-5 xl:grid-cols-3">
        {VARIANT_ORDER.map((variant) => {
          const settings = config.variants[variant]
          const overrides = variant === "initial" ? [] : overridesAgainstInitial(settings, initial)
          return (
            <VariantCard
              key={variant}
              projectId={project.id}
              variant={variant}
              glyph={VARIANT_META[variant].glyph}
              label={VARIANT_META[variant].label}
              color={VARIANT_META[variant].color}
              description={VARIANT_META[variant].description}
              settings={settings}
              overrides={overrides}
              resourceClass={resourceClassFor(settings.cpu, settings.memory_mb)}
              regions={MODAL_REGIONS}
            />
          )
        })}
      </div>
    </div>
  )
}
