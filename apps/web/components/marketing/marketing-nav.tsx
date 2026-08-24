"use client"

import * as React from "react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const LINKS: readonly { href: string; label: string }[] = [
  { href: "/docs", label: "Docs" },
  { href: "/pricing", label: "Pricing" },
  { href: "/sign-in", label: "Sign in" },
]

/**
 * The only interactive part of the marketing chrome.
 *
 * The bottom hairline is driven by an 8px sentinel at the top of the document
 * rather than a scroll listener: an IntersectionObserver fires twice per page,
 * on the way past and on the way back, instead of on every frame of every
 * scroll.
 */
export function MarketingNav() {
  const sentinel = React.useRef<HTMLDivElement>(null)
  const [scrolled, setScrolled] = React.useState(false)

  React.useEffect(() => {
    const node = sentinel.current
    if (!node) return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry) setScrolled(!entry.isIntersecting)
      },
      // threshold 0 against an 8px-tall sentinel: it stops intersecting the
      // moment the last of those 8 pixels leaves the viewport.
      { threshold: 0 },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return (
    <>
      <div
        ref={sentinel}
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 h-2 w-full"
      />

      <header
        data-scrolled={scrolled ? "" : undefined}
        className={cn(
          "sticky top-0 z-50 h-14 w-full border-b",
          "transition-[border-color,background-color] duration-[var(--dur-normal)]",
          "ease-[var(--ease-out)]",
        )}
        style={{
          backgroundColor: "color-mix(in srgb, var(--bg-void) 72%, transparent)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          borderBottomColor: scrolled ? "var(--border-subtle)" : "transparent",
        }}
      >
        <nav
          aria-label="Primary"
          className="mx-auto flex h-full w-full max-w-[1200px] items-center gap-6 px-6"
        >
          <Link
            href="/"
            className="mr-auto text-[16px] font-semibold leading-none tracking-[-0.02em] text-[var(--fg-primary)]"
          >
            sandman
          </Link>

          <ul className="hidden items-center gap-1 sm:flex">
            {LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className={cn(
                    "flex h-8 items-center rounded-[6px] px-2.5 text-[13px] font-medium",
                    "tracking-[-0.005em] text-[var(--fg-secondary)]",
                    "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
                    "hover:bg-[var(--bg-raised)] hover:text-[var(--fg-primary)]",
                  )}
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>

          <Button asChild variant="primary" size="md">
            <Link href="/sign-up">Start a probe</Link>
          </Button>
        </nav>
      </header>
    </>
  )
}
