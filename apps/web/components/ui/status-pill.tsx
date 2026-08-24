import { cn } from "@/lib/utils"

/** Mirrors SandboxState in services/control-plane/sandman/models.py. */
export type SandboxStatus =
  | "queued"
  | "provisioning"
  | "running"
  | "passed"
  | "failed"
  | "flaky"
  | "skipped"
  | "error"
  | "timed_out"

interface StatusToken {
  fg: string
  bg: string
  border: string
  label: string
  /** Only the two states that mean "waiting on infrastructure" animate. */
  pulse?: boolean
}

/**
 * Amber is the brand accent, so it is absent from the semantic set and belongs
 * to `running` alone. Nothing here may be read as a warning.
 */
const STATUS_TOKENS: Record<SandboxStatus, StatusToken> = {
  queued: {
    fg: "var(--status-queued)",
    bg: "var(--status-queued-wash)",
    border: "rgb(110 112 128 / 0.28)",
    label: "Queued",
  },
  provisioning: {
    fg: "var(--status-provisioning)",
    bg: "var(--status-provisioning-wash)",
    border: "rgb(90 169 245 / 0.28)",
    label: "Provisioning",
    pulse: true,
  },
  running: {
    fg: "var(--status-running)",
    bg: "var(--status-running-wash)",
    border: "rgb(255 180 84 / 0.32)",
    label: "Running",
    pulse: true,
  },
  passed: {
    fg: "var(--status-pass)",
    bg: "var(--status-pass-wash)",
    border: "rgb(63 214 140 / 0.28)",
    label: "Passed",
  },
  failed: {
    fg: "var(--status-fail)",
    bg: "var(--status-fail-wash)",
    border: "rgb(255 95 109 / 0.28)",
    label: "Failed",
  },
  flaky: {
    fg: "var(--status-flaky)",
    bg: "var(--status-flaky-wash)",
    border: "rgb(167 139 250 / 0.28)",
    label: "Flaky",
  },
  skipped: {
    fg: "var(--status-skipped)",
    bg: "rgb(74 76 88 / 0.12)",
    border: "rgb(74 76 88 / 0.30)",
    label: "Skipped",
  },
  error: {
    fg: "var(--status-fail)",
    bg: "var(--status-fail-wash)",
    border: "rgb(255 95 109 / 0.28)",
    label: "Error",
  },
  timed_out: {
    fg: "var(--status-fail)",
    bg: "var(--status-fail-wash)",
    border: "rgb(255 95 109 / 0.28)",
    label: "Timed out",
  },
}

export interface StatusPillProps extends Omit<React.ComponentProps<"span">, "children"> {
  status: SandboxStatus
  label?: string
}

/**
 * 6px corners, not a capsule: a fully rounded pill reads consumer, and this is
 * an instrument.
 */
export function StatusPill({ status, label, className, ...props }: StatusPillProps) {
  const token = STATUS_TOKENS[status]
  return (
    <span
      data-slot="status-pill"
      data-status={status}
      className={cn(
        "inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-[6px] border pl-1.5 pr-2",
        className,
      )}
      style={{ color: token.fg, backgroundColor: token.bg, borderColor: token.border }}
      {...props}
    >
      <span
        aria-hidden
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full bg-current", token.pulse && "pulse-dot")}
      />
      {/* The uppercase tracking leaves a trailing sidebearing; pull it back so
          the optical padding matches the 8px on the left. */}
      <span className="mono -mr-[2px] text-[11px] font-medium uppercase leading-none tracking-[0.14em]">
        {label ?? token.label}
      </span>
    </span>
  )
}

export { STATUS_TOKENS }
