import * as React from "react"
import type { IconProps } from "phosphor-react"

import { cn } from "@/lib/utils"

export interface EmptyStateProps extends Omit<React.ComponentProps<"div">, "children" | "title"> {
  /**
   * A phosphor icon component. phosphor-react reads its defaults through React
   * context, so an EmptyState only renders inside a client boundary.
   */
  icon: React.ComponentType<IconProps>
  title: string
  description: string
  action?: React.ReactNode
  size?: "sm" | "md"
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  size = "md",
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center px-6 text-center",
        size === "md" ? "py-16" : "py-10",
        className,
      )}
      {...props}
    >
      <Icon size={24} weight="regular" color="var(--fg-quaternary)" aria-hidden />
      <p
        className={cn(
          "mt-3 font-semibold tracking-[-0.01em] text-[var(--fg-primary)]",
          size === "md" ? "text-[17px] leading-[1.35]" : "text-[14px] leading-[1.4]",
        )}
      >
        {title}
      </p>
      <p className="text-body-sm mt-1 max-w-[46ch] text-[var(--fg-tertiary)]">{description}</p>
      {action ? <div className="mt-4 flex items-center gap-2">{action}</div> : null}
    </div>
  )
}
