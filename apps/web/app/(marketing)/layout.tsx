import * as React from "react"
import Link from "next/link"

import { MarketingNav } from "@/components/marketing/marketing-nav"

interface FooterLink {
  href: string
  label: string
  external?: boolean
}

interface FooterColumn {
  heading: string
  links: readonly FooterLink[]
}

const FOOTER: readonly FooterColumn[] = [
  {
    heading: "Product",
    links: [
      { href: "/#how-it-works", label: "How it works" },
      { href: "/#verdicts", label: "The eight verdicts" },
      { href: "/#presets", label: "Probe presets" },
      { href: "/pricing", label: "Pricing" },
    ],
  },
  {
    heading: "Docs",
    links: [
      { href: "/docs", label: "Quickstart" },
      { href: "/docs/config", label: "sandman.toml reference" },
      { href: "/docs/sdk", label: "Probe SDK" },
      { href: "/docs/api", label: "Control plane API" },
    ],
  },
  {
    heading: "Built on",
    links: [
      { href: "https://modal.com", label: "Modal", external: true },
      { href: "https://openai.com", label: "OpenAI", external: true },
      { href: "https://greptile.com", label: "Greptile", external: true },
      { href: "https://stripe.com", label: "Stripe", external: true },
    ],
  },
  {
    heading: "Account",
    links: [
      { href: "/sign-up", label: "Start a probe" },
      { href: "/sign-in", label: "Sign in" },
      { href: "/dashboard", label: "Dashboard" },
      { href: "/docs/security", label: "Security" },
    ],
  },
]

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    // Relative, because the nav's scroll sentinel is absolutely positioned
    // against the top of the document.
    <div className="relative flex min-h-dvh flex-col">
      <MarketingNav />

      <main className="flex-1">{children}</main>

      <footer className="border-t border-[var(--border-subtle)] bg-[var(--bg-void)]">
        <div className="mx-auto w-full max-w-[1200px] px-6 py-14">
          <div className="grid grid-cols-2 gap-x-8 gap-y-10 md:grid-cols-4">
            {FOOTER.map((column) => (
              <div key={column.heading}>
                <h2 className="mono text-[11px] font-medium uppercase leading-none tracking-[0.14em] text-[var(--fg-quaternary)]">
                  {column.heading}
                </h2>
                <ul className="mt-4 flex flex-col gap-2.5">
                  {column.links.map((link) => (
                    <li key={link.href}>
                      {link.external ? (
                        <a
                          href={link.href}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-[13.5px] leading-[1.5] text-[var(--fg-tertiary)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:text-[var(--fg-primary)]"
                        >
                          {link.label}
                        </a>
                      ) : (
                        <Link
                          href={link.href}
                          className="text-[13.5px] leading-[1.5] text-[var(--fg-tertiary)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:text-[var(--fg-primary)]"
                        >
                          {link.label}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="mt-14 flex flex-col gap-3 border-t border-[var(--border-hairline)] pt-6 sm:flex-row sm:items-center">
            <Link
              href="/"
              className="text-[14px] font-semibold leading-none tracking-[-0.02em] text-[var(--fg-secondary)]"
            >
              sandman
            </Link>
            <p className="text-caption text-[var(--fg-quaternary)] sm:ml-auto">
              Free in beta. Bring your own Modal and OpenAI keys.
            </p>
          </div>
        </div>
      </footer>
    </div>
  )
}
