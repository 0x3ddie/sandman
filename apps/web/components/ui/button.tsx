import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * No focus classes here. globals.css installs one `*:focus-visible` rule for the
 * whole app; adding ring-* on top of it produces a double ring.
 */
const buttonVariants = cva(
  [
    "inline-flex shrink-0 select-none items-center justify-center gap-1.5",
    "whitespace-nowrap rounded-[6px] font-medium tracking-[-0.01em]",
    "transition-[background-color,border-color,color,opacity]",
    "duration-[var(--dur-fast)] ease-[var(--ease-out)]",
    "disabled:pointer-events-none disabled:opacity-40",
    "[&_svg]:size-4 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        /* Black-on-amber is AAA, so the label is the canvas colour, never white.
           The inset highlight replaces the drop shadow the ladder forbids. */
        primary: [
          "bg-[var(--accent-400)] text-[var(--bg-base)]",
          "shadow-[inset_0_1px_0_rgb(255_255_255_/_0.08)]",
          "hover:bg-[var(--accent-300)] active:bg-[var(--accent-500)]",
        ],
        secondary: [
          "border border-[var(--border-default)] bg-transparent text-[var(--fg-primary)]",
          "hover:border-[var(--border-strong)] hover:bg-[var(--bg-raised)]",
          "active:bg-[var(--bg-overlay)]",
        ],
        ghost: [
          "bg-transparent text-[var(--fg-secondary)]",
          "hover:bg-[var(--bg-raised)] hover:text-[var(--fg-primary)]",
        ],
        danger: [
          "border border-[rgb(255_95_109_/_0.32)] bg-[var(--status-fail-wash)]",
          "text-[var(--status-fail)]",
          "hover:border-[rgb(255_95_109_/_0.50)] hover:bg-[rgb(255_95_109_/_0.16)]",
        ],
      },
      size: {
        sm: "h-7 px-2.5 text-[12.5px]",
        md: "h-8 px-3 text-[13px]",
        lg: "h-11 px-5 text-[14px]",
        icon: "h-8 w-8 p-0",
        iconSm: "h-7 w-7 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
)

export interface ButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { buttonVariants }
