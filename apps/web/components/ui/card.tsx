import { cn } from "@/lib/utils"

/**
 * Depth comes from the surface ladder plus a hairline and the --elev-1 inset
 * highlight. Drop shadows are reserved for things that genuinely float
 * (popovers, modals), so a card never gets one.
 */
export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "rounded-[8px] border border-[var(--border-subtle)] bg-[var(--bg-surface)]",
        "shadow-[var(--elev-1)]",
        className,
      )}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn("flex flex-col gap-1 px-5 pb-3 pt-4", className)}
      {...props}
    />
  )
}

export function CardTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return (
    <h3
      data-slot="card-title"
      className={cn("text-h4 text-[var(--fg-primary)]", className)}
      {...props}
    />
  )
}

export function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="card-description"
      className={cn("text-body-sm text-[var(--fg-tertiary)]", className)}
      {...props}
    />
  )
}

export function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-5 pb-5", className)} {...props} />
}

export function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center gap-2 border-t border-[var(--border-hairline)] px-5 py-3",
        className,
      )}
      {...props}
    />
  )
}
