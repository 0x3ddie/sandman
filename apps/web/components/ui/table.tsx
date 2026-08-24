import * as React from "react"

import { cn } from "@/lib/utils"

type TableSurface = "base" | "surface" | "raised"

const SURFACE_VARS: Record<TableSurface, string> = {
  base: "var(--bg-base)",
  surface: "var(--bg-surface)",
  raised: "var(--bg-raised)",
}

export interface TableProps extends React.ComponentProps<"table"> {
  /**
   * The surface the table sits on. A sticky header paints its own background,
   * so it has to know which rung of the ladder it is standing on or rows will
   * scroll through it.
   */
  surface?: TableSurface
  containerClassName?: string
}

export function Table({ className, surface = "surface", containerClassName, ...props }: TableProps) {
  return (
    <div
      data-slot="table-container"
      className={cn("relative w-full overflow-x-auto", containerClassName)}
      style={{ "--table-surface": SURFACE_VARS[surface] } as React.CSSProperties}
    >
      <table
        data-slot="table"
        className={cn("w-full border-collapse text-left align-middle", className)}
        {...props}
      />
    </div>
  )
}

export function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={className} {...props} />
}

export function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

export function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t border-[var(--border-subtle)] [&_td]:h-11 [&_td]:px-3",
        "[&>tr>*:first-child]:pl-4 [&>tr>*:last-child]:pr-4",
        className,
      )}
      {...props}
    />
  )
}

/**
 * No zebra striping. Density comes from the 44px rhythm and hairlines; stripes
 * fight the row-hover accent bar and make status colour harder to read.
 */
export function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "h-11 border-b border-[var(--border-hairline)]",
        "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
        "hover:bg-[var(--bg-raised)]",
        // border-collapse drops box-shadow on <tr>, so the accent bar is drawn
        // on the first cell instead.
        "hover:[&>td:first-child]:shadow-[inset_2px_0_0_0_var(--accent-400)]",
        "data-[state=selected]:bg-[var(--bg-raised)]",
        "[&>*:first-child]:pl-4 [&>*:last-child]:pr-4",
        className,
      )}
      {...props}
    />
  )
}

export interface TableHeadProps extends React.ComponentProps<"th"> {
  numeric?: boolean
}

export function TableHead({ className, numeric = false, ...props }: TableHeadProps) {
  return (
    <th
      data-slot="table-head"
      scope="col"
      className={cn(
        "text-eyebrow sticky top-0 z-[2] h-8 whitespace-nowrap px-3 text-[var(--fg-tertiary)]",
        "bg-[var(--table-surface)] shadow-[inset_0_-1px_0_0_var(--border-subtle)]",
        numeric && "text-right",
        className,
      )}
      {...props}
    />
  )
}

export interface TableCellProps extends React.ComponentProps<"td"> {
  /** Right-aligns and switches to tabular figures so columns stop jittering. */
  numeric?: boolean
}

export function TableCell({ className, numeric = false, ...props }: TableCellProps) {
  return (
    <td
      data-slot="table-cell"
      data-numeric={numeric ? "" : undefined}
      className={cn(
        "px-3 align-middle text-[13.5px] leading-[1.4] text-[var(--fg-secondary)]",
        numeric && "text-right text-[13px] text-[var(--fg-primary)]",
        className,
      )}
      {...props}
    />
  )
}

export function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("text-caption px-4 py-2 text-left text-[var(--fg-tertiary)]", className)}
      {...props}
    />
  )
}
