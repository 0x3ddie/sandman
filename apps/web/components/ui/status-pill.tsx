import * as React from "react"

import { cn } from "@/lib/utils"
import { STATUS_META, type SandboxStatus } from "@/lib/variants"

export type { SandboxStatus }

export interface StatusPillProps extends Omit<React.ComponentProps<"span">, "children"> {
  status: SandboxStatus
  label?: string
}

/**
 * 6px corners, not a capsule: a fully rounded pill reads consumer, and this is
 * an instrument.
 *
 * Colour comes from lib/variants so there is one status vocabulary; the border
 * is mixed from that same colour rather than hard-coded, which keeps a token
 * change from needing an edit here.
 */
export function StatusPill({ status, label, className, ...props }: StatusPillProps) {
  const meta = STATUS_META[status]
  // Only the two states that mean "waiting on infrastructure" animate.
  const pulse = status === "running" || status === "provisioning"

  return (
    <span
      data-slot="status-pill"
      data-status={status}
      className={cn(
        "inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-[6px] border pl-1.5 pr-2",
        className,
      )}
      style={{
        color: meta.color,
        backgroundColor: meta.wash,
        borderColor: `color-mix(in srgb, ${meta.color} 28%, transparent)`,
      }}
      {...props}
    >
      <span
        aria-hidden
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full bg-current", pulse && "pulse-dot")}
      />
      {/* Uppercase tracking leaves a trailing sidebearing; pull it back so the
          optical padding matches the 8px on the left. */}
      <span className="mono -mr-[2px] text-[11px] font-medium uppercase leading-none tracking-[0.14em]">
        {label ?? meta.label}
      </span>
    </span>
  )
}
