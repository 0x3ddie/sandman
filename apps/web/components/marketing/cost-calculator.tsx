"use client"

import * as React from "react"

import { PLANS, PLAN_ORDER, limitsFor, overageUsd, type PlanId } from "@/lib/plans"
import { cn, formatUsd } from "@/lib/utils"
import { VARIANT_ORDER } from "@/lib/variants"

/**
 * Sandbox time attributable to one fan-out unit.
 *
 * A unit is one probe execution against one replica; the replica is billed for
 * the wall time it is up, and fifteen seconds is the median across the bundled
 * presets. Stated in the UI rather than hidden, because every number below is
 * derived from it.
 */
const MINUTES_PER_UNIT = 0.25

const MAX_FANOUT = 4_000
const MAX_RUNS = 2_000

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function CostCalculator() {
  const [fanout, setFanout] = React.useState(120)
  const [runs, setRuns] = React.useState(40)

  // Three lanes, always — the lane count is the product, not a setting.
  const minutes = VARIANT_ORDER.length * fanout * MINUTES_PER_UNIT * runs

  return (
    <div className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[var(--elev-1)]">
      <div className="grid gap-6 border-b border-[var(--border-hairline)] p-6 sm:grid-cols-3 sm:items-end">
        <NumberField
          id="fanout-width"
          label="Fan-out width"
          hint="units per lane"
          value={fanout}
          min={1}
          max={MAX_FANOUT}
          step={10}
          onChange={(next) => setFanout(clamp(next, 1, MAX_FANOUT))}
        />
        <NumberField
          id="run-count"
          label="Runs per month"
          hint="one per rollout"
          value={runs}
          min={1}
          max={MAX_RUNS}
          step={5}
          onChange={(next) => setRuns(clamp(next, 1, MAX_RUNS))}
        />
        <div>
          <p className="mono text-[11px] font-medium uppercase leading-none tracking-[0.14em] text-[var(--fg-quaternary)]">
            Projected usage
          </p>
          <p data-numeric className="text-metric mt-2.5 text-[var(--fg-primary)]">
            {Math.round(minutes).toLocaleString("en-US")}
          </p>
          <p className="text-caption mt-2 text-[var(--fg-tertiary)]">sandbox-minutes / month</p>
        </div>
      </div>

      <ul className="flex flex-col">
        {PLAN_ORDER.map((id) => (
          <PlanRow key={id} id={id} minutes={minutes} fanout={fanout} />
        ))}
      </ul>

      <p className="text-caption border-t border-[var(--border-hairline)] px-6 py-4 text-[var(--fg-tertiary)]">
        Estimated as {VARIANT_ORDER.length} lanes × fan-out width ×{" "}
        <span data-numeric>{MINUTES_PER_UNIT}</span> sandbox-minutes per unit × runs. Real runs vary
        with probe duration and Modal cold starts; the budget in sandman.toml is the ceiling that
        actually binds.
      </p>
    </div>
  )
}

function PlanRow({ id, minutes, fanout }: { id: PlanId; minutes: number; fanout: number }) {
  const plan = PLANS[id]
  const limits = limitsFor(plan)

  const overage = overageUsd(plan, minutes)
  const total = plan.priceUsd + overage
  const exceedsAllowance = minutes > limits.includedSandboxMinutes
  const hardStops = exceedsAllowance && limits.overageUsdPerSandboxMinute === null
  const exceedsFanout = fanout > limits.maxFanoutWidth

  const used = Math.min(1, minutes / limits.includedSandboxMinutes)
  const meterColor = hardStops
    ? "var(--status-fail)"
    : exceedsAllowance
      ? "var(--variant-initial)"
      : "var(--status-pass)"

  const note = exceedsFanout
    ? `Above this plan’s ${limits.maxFanoutWidth.toLocaleString("en-US")}-wide fan-out ceiling`
    : hardStops
      ? `Hard stops at ${limits.includedSandboxMinutes.toLocaleString("en-US")} minutes — no overage billing`
      : exceedsAllowance
        ? `${Math.round(minutes - limits.includedSandboxMinutes).toLocaleString("en-US")} minutes over, billed at $${(limits.overageUsdPerSandboxMinute ?? 0).toFixed(3)}`
        : `Inside the ${limits.includedSandboxMinutes.toLocaleString("en-US")} included minutes`

  return (
    <li className="grid gap-4 border-b border-[var(--border-hairline)] px-6 py-5 last:border-b-0 sm:grid-cols-[140px_1fr_auto] sm:items-center">
      <div>
        <p className="text-h4 text-[var(--fg-primary)]">{plan.displayName}</p>
        <p className="text-caption mt-1 text-[var(--fg-quaternary)]">
          {formatUsd(plan.priceUsd)} base
        </p>
      </div>

      <div className="min-w-0">
        <div
          aria-hidden
          className="h-[6px] w-full overflow-hidden rounded-full bg-[var(--bg-raised)]"
        >
          <div
            className="h-full rounded-full transition-[width] duration-[var(--dur-normal)] ease-[var(--ease-out)]"
            style={{ width: `${used * 100}%`, backgroundColor: meterColor }}
          />
        </div>
        <p
          className={cn(
            "text-caption mt-2",
            exceedsFanout || hardStops ? "text-[var(--status-fail)]" : "text-[var(--fg-tertiary)]",
          )}
        >
          {note}
        </p>
      </div>

      <div className="sm:text-right">
        <p data-numeric className="text-[22px] font-medium leading-none tracking-[-0.02em] text-[var(--fg-primary)]">
          {formatUsd(total)}
        </p>
        <p className="text-caption mt-2 text-[var(--fg-quaternary)]">per month</p>
      </div>
    </li>
  )
}

interface NumberFieldProps {
  id: string
  label: string
  hint: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}

function NumberField({ id, label, hint, value, min, max, step, onChange }: NumberFieldProps) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mono block text-[11px] font-medium uppercase leading-none tracking-[0.14em] text-[var(--fg-quaternary)]"
      >
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(event.target.valueAsNumber)}
        className={cn(
          "mono mt-2.5 h-10 w-full rounded-[6px] border border-[var(--border-default)]",
          "bg-[var(--bg-raised)] px-3 text-[15px] text-[var(--fg-primary)]",
          "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
          "hover:border-[var(--border-strong)]",
        )}
      />
      <p className="text-caption mt-2 text-[var(--fg-tertiary)]">{hint}</p>
    </div>
  )
}
