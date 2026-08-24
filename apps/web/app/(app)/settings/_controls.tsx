"use client"

/**
 * The interactive half of settings.
 *
 * Every mutation is a Server Action reached through a plain `<form>`, so the
 * page works before hydration and the pending state comes from
 * `useFormStatus` rather than from state we have to keep in sync ourselves.
 * Controls that are not native inputs (switch, stepper, chip select) carry a
 * hidden input so the same FormData shape arrives either way.
 */

import * as React from "react"
import { useFormStatus } from "react-dom"
import * as SwitchPrimitive from "@radix-ui/react-switch"
import * as Dialog from "@radix-ui/react-dialog"
import { motion, useReducedMotion } from "motion/react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Segmented, type SegmentedOption } from "@/components/ui/segmented"
import { cn } from "@/lib/utils"

import type { ActionResult } from "./_types"

/* ---------------------------------------------------------------------------
 * Forms
 * ------------------------------------------------------------------------ */

export type FormAction = (
  previous: ActionResult | null,
  formData: FormData,
) => Promise<ActionResult>

export function ActionForm({
  action,
  children,
  className,
  id,
}: {
  action: FormAction
  children: React.ReactNode
  className?: string
  id?: string
}) {
  const [state, dispatch] = React.useActionState<ActionResult | null, FormData>(action, null)

  // `state` is a fresh object per submission, so re-submitting with the same
  // outcome still fires the toast — silence after a click reads as a dead button.
  React.useEffect(() => {
    if (!state) return
    if (state.ok) toast.success(state.message)
    else toast.error(state.error)
  }, [state])

  return (
    <form id={id} action={dispatch} className={className}>
      {children}
    </form>
  )
}

export function SubmitButton({
  children = "Save changes",
  variant = "primary",
  size = "md",
  pendingLabel = "Saving…",
  className,
}: {
  children?: React.ReactNode
  variant?: "primary" | "secondary" | "ghost" | "danger"
  size?: "sm" | "md" | "lg"
  pendingLabel?: string
  className?: string
}) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant={variant} size={size} disabled={pending} className={className}>
      {pending ? pendingLabel : children}
    </Button>
  )
}

/** Hidden field carrying context an action needs but a user never edits. */
export function HiddenValue({ name, value }: { name: string; value: string }) {
  return <input type="hidden" name={name} value={value} />
}

/* ---------------------------------------------------------------------------
 * Switch
 * ------------------------------------------------------------------------ */

export function Toggle({
  name,
  defaultChecked = false,
  label,
  description,
  onCheckedChange,
  disabled,
}: {
  name: string
  defaultChecked?: boolean
  label: string
  description?: React.ReactNode
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
}) {
  const id = React.useId()
  const [checked, setChecked] = React.useState(defaultChecked)

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-label block text-[var(--fg-primary)]">
          {label}
        </label>
        {description ? (
          <p className="text-body-sm mt-0.5 max-w-[60ch] text-[var(--fg-tertiary)]">{description}</p>
        ) : null}
      </div>
      <SwitchPrimitive.Root
        id={id}
        name={name}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => {
          setChecked(next)
          onCheckedChange?.(next)
        }}
        className={cn(
          "relative inline-flex h-[20px] w-[34px] shrink-0 items-center rounded-[6px] border",
          "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
          "border-[var(--border-default)] bg-[var(--bg-raised)]",
          "data-[state=checked]:border-[var(--accent-border)] data-[state=checked]:bg-[var(--accent-wash)]",
          "disabled:cursor-not-allowed disabled:opacity-45",
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
    </div>
  )
}

/* ---------------------------------------------------------------------------
 * Stepper
 * ------------------------------------------------------------------------ */

export function Stepper({
  name,
  defaultValue,
  min = 1,
  max = 4000,
  step = 1,
  suffix,
  "aria-label": ariaLabel,
}: {
  name: string
  defaultValue: number
  min?: number
  max?: number
  step?: number
  suffix?: string
  "aria-label": string
}) {
  const [value, setValue] = React.useState(defaultValue)
  const clamp = (next: number) => Math.max(min, Math.min(max, next))

  return (
    <div className="inline-flex h-8 items-stretch overflow-hidden rounded-[6px] border border-[var(--border-default)] bg-[var(--bg-raised)]">
      <StepButton label={`Decrease ${ariaLabel}`} onClick={() => setValue((v) => clamp(v - step))}>
        −
      </StepButton>
      <input
        name={name}
        type="number"
        aria-label={ariaLabel}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const parsed = Number(event.target.value)
          setValue(Number.isFinite(parsed) ? parsed : min)
        }}
        onBlur={() => setValue((v) => clamp(v))}
        data-numeric=""
        className={cn(
          "mono w-14 border-x border-[var(--border-hairline)] bg-transparent text-center",
          "text-[13px] text-[var(--fg-primary)]",
          // The native spinners duplicate the buttons either side of them.
          "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none",
          "[&::-webkit-outer-spin-button]:appearance-none",
        )}
      />
      <StepButton label={`Increase ${ariaLabel}`} onClick={() => setValue((v) => clamp(v + step))}>
        +
      </StepButton>
      {suffix ? (
        <span className="text-caption flex items-center px-2 text-[var(--fg-tertiary)]">
          {suffix}
        </span>
      ) : null}
    </div>
  )
}

function StepButton({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "mono w-7 shrink-0 text-[13px] leading-none text-[var(--fg-tertiary)]",
        "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
        "hover:bg-[var(--bg-overlay)] hover:text-[var(--fg-primary)]",
      )}
    >
      {children}
    </button>
  )
}

/* ---------------------------------------------------------------------------
 * Chip multi-select
 * ------------------------------------------------------------------------ */

export function ChipMultiSelect({
  name,
  options,
  defaultValue,
  emptyLabel,
}: {
  name: string
  options: readonly { id: string; label: string }[]
  defaultValue: readonly string[]
  /** What no selection means. Never leave the reader to guess. */
  emptyLabel: string
}) {
  const [selected, setSelected] = React.useState<string[]>([...defaultValue])

  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    )

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const active = selected.includes(option.id)
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={active}
              onClick={() => toggle(option.id)}
              className={cn(
                "mono h-[26px] rounded-[6px] border px-2 text-[11.5px] leading-none",
                "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
                active
                  ? "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent-400)]"
                  : "border-[var(--border-default)] bg-[var(--bg-raised)] text-[var(--fg-tertiary)] hover:text-[var(--fg-secondary)]",
              )}
              title={option.label}
            >
              {option.id}
            </button>
          )
        })}
      </div>
      {selected.length === 0 ? (
        <p className="text-caption text-[var(--fg-tertiary)]">{emptyLabel}</p>
      ) : null}
      {selected.map((value) => (
        <input key={value} type="hidden" name={name} value={value} />
      ))}
    </div>
  )
}

/* ---------------------------------------------------------------------------
 * Segmented field
 * ------------------------------------------------------------------------ */

export function SegmentedField<T extends string>({
  name,
  defaultValue,
  options,
  "aria-label": ariaLabel,
}: {
  name: string
  defaultValue: T
  options: readonly SegmentedOption<T>[]
  "aria-label": string
}) {
  const [value, setValue] = React.useState<T>(defaultValue)
  return (
    <>
      <Segmented value={value} onValueChange={setValue} options={options} aria-label={ariaLabel} />
      <input type="hidden" name={name} value={value} />
    </>
  )
}

/* ---------------------------------------------------------------------------
 * Drawer
 * ------------------------------------------------------------------------ */

/**
 * A right-hand drawer for per-probe parameters.
 *
 * A modal dialog rather than an inline expander: probe parameters are a
 * different level of detail from the on/off decision, and expanding one inline
 * pushes every row below it, which loses the reader's place in the list.
 */
export function Drawer({
  trigger,
  title,
  description,
  children,
  footer,
}: {
  trigger: React.ReactNode
  title: string
  description?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  const reducedMotion = useReducedMotion()
  const enter = reducedMotion
    ? { duration: 0 }
    : { duration: 0.22, ease: [0.16, 1, 0.3, 1] as const }

  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay asChild>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={enter}
            className="fixed inset-0 z-40 bg-[rgb(7_7_11_/_0.72)]"
          />
        </Dialog.Overlay>
        <Dialog.Content asChild>
          <motion.div
            initial={{ x: 24, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={enter}
            className={cn(
              "fixed inset-y-0 right-0 z-50 flex w-full max-w-[440px] flex-col",
              "border-l border-[var(--border-default)] bg-[var(--bg-overlay)] shadow-[var(--elev-3)]",
            )}
          >
            <div className="border-b border-[var(--border-hairline)] px-5 py-4">
              <Dialog.Title className="text-h4 text-[var(--fg-primary)]">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="text-body-sm mt-1 text-[var(--fg-tertiary)]">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
            {footer ? (
              <div className="flex items-center justify-end gap-2 border-t border-[var(--border-hairline)] px-5 py-3">
                <Dialog.Close asChild>
                  <Button variant="ghost" size="md">
                    Cancel
                  </Button>
                </Dialog.Close>
                {footer}
              </div>
            ) : null}
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/* ---------------------------------------------------------------------------
 * Redirect-to-Stripe buttons
 * ------------------------------------------------------------------------ */

/**
 * Posts to a billing route and follows the URL it returns.
 *
 * A top-level navigation, not a fetch-and-render: Stripe-hosted Checkout and
 * the Customer Portal both refuse to be framed.
 */
export function StripeRedirectButton({
  endpoint,
  body,
  children,
  variant = "primary",
  size = "md",
  disabled,
  className,
}: {
  endpoint: "/api/billing/checkout" | "/api/billing/portal"
  body?: Record<string, string>
  children: React.ReactNode
  variant?: "primary" | "secondary" | "ghost" | "danger"
  size?: "sm" | "md" | "lg"
  disabled?: boolean
  className?: string
}) {
  const [pending, setPending] = React.useState(false)

  async function go() {
    setPending(true)
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      })
      const payload: unknown = await response.json()
      const url =
        payload && typeof payload === "object" ? (payload as { url?: unknown }).url : undefined

      if (response.ok && typeof url === "string") {
        window.location.href = url
        return
      }

      const error =
        payload && typeof payload === "object" ? (payload as { error?: unknown }).error : undefined
      toast.error(typeof error === "string" ? error : "Stripe did not return a redirect URL.")
    } catch {
      toast.error("Could not reach Stripe. Check your connection and try again.")
    } finally {
      setPending(false)
    }
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={disabled || pending}
      onClick={go}
      className={className}
    >
      {pending ? "Opening Stripe…" : children}
    </Button>
  )
}
