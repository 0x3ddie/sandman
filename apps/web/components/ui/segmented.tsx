"use client"

import * as React from "react"
import * as ToggleGroup from "@radix-ui/react-toggle-group"
import { motion, useReducedMotion } from "motion/react"

import { cn } from "@/lib/utils"

export interface SegmentedOption<T extends string> {
  value: T
  label: React.ReactNode
  /** Fixed mono marker — the B/I/H switcher relies on it for redundancy. */
  glyph?: string
  /** Colour for the glyph only, so the variant triad keeps its own hues. */
  glyphColor?: string
  disabled?: boolean
}

export interface SegmentedProps<T extends string> {
  value: T
  onValueChange: (value: T) => void
  options: readonly SegmentedOption<T>[]
  size?: "sm" | "md"
  className?: string
  "aria-label": string
}

/**
 * Segmented control. Radix ships a toggle group but no segmented control, and
 * this pattern carries the variant switcher, the diff pane selector and every
 * time range, so it is worth building once.
 */
export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  size = "md",
  className,
  "aria-label": ariaLabel,
}: SegmentedProps<T>) {
  // Scoped per instance: two segmented controls on one screen must not share a
  // thumb and animate across each other.
  const thumbId = React.useId()
  const reducedMotion = useReducedMotion()

  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => {
        // Radix emits "" when the active item is re-pressed; a segmented control
        // has no empty state.
        if (next) onValueChange(next as T)
      }}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex shrink-0 items-center gap-[2px] rounded-[6px] p-[3px]",
        "border border-[var(--border-hairline)] bg-[var(--bg-raised)]",
        size === "md" ? "h-8" : "h-7",
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <ToggleGroup.Item
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            className={cn(
              "relative inline-flex h-full items-center justify-center gap-1.5 rounded-[4px]",
              "px-2.5 text-[12.5px] font-medium tracking-[-0.005em]",
              "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
              "disabled:pointer-events-none disabled:opacity-40",
              selected
                ? "text-[var(--fg-primary)]"
                : "text-[var(--fg-tertiary)] hover:text-[var(--fg-secondary)]",
            )}
          >
            {selected ? (
              <motion.span
                layoutId={thumbId}
                aria-hidden
                className={cn(
                  "absolute inset-0 rounded-[4px] border border-[var(--border-hairline)]",
                  "bg-[var(--bg-overlay)] shadow-[var(--elev-1)]",
                )}
                transition={
                  reducedMotion
                    ? { duration: 0 }
                    : { type: "tween", duration: 0.14, ease: [0.16, 1, 0.3, 1] }
                }
              />
            ) : null}
            {option.glyph ? (
              <span
                aria-hidden
                className="mono relative text-[11px] font-medium leading-none"
                style={option.glyphColor ? { color: option.glyphColor } : undefined}
              >
                {option.glyph}
              </span>
            ) : null}
            <span className="relative leading-none">{option.label}</span>
          </ToggleGroup.Item>
        )
      })}
    </ToggleGroup.Root>
  )
}
