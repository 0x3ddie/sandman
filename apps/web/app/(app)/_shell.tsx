"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { createPortal } from "react-dom"
import {
  CaretDown,
  CaretLeft,
  CaretRight,
  CreditCard,
  Gauge,
  GitBranch,
  GithubLogo,
  type IconProps,
  Key,
  ListChecks,
  SquaresFour,
  Stack,
  Target,
} from "phosphor-react"

import { cn } from "@/lib/utils"

/* ---------------------------------------------------------------------------
 * Navigation
 * ------------------------------------------------------------------------ */

interface NavItem {
  href: string
  label: string
  icon: React.ComponentType<IconProps>
}

interface NavGroup {
  /** Null renders the group without an eyebrow header. */
  label: string | null
  items: readonly NavItem[]
}

const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: null,
    items: [{ href: "/dashboard", label: "Overview", icon: SquaresFour }],
  },
  {
    label: "Runs",
    items: [
      { href: "/runs", label: "Runs", icon: ListChecks },
      { href: "/runs/queue", label: "Queue", icon: Stack },
    ],
  },
  {
    label: "Config",
    items: [
      { href: "/settings/variants", label: "Variants", icon: GitBranch },
      { href: "/settings/probes", label: "Probes", icon: Target },
      { href: "/settings/budgets", label: "Budgets", icon: Gauge },
      { href: "/settings/secrets", label: "Secrets", icon: Key },
    ],
  },
  {
    label: "Settings",
    items: [
      { href: "/settings/repo", label: "Repo", icon: GithubLogo },
      { href: "/settings/billing", label: "Billing", icon: CreditCard },
    ],
  },
]

const ROUTE_TITLES: Record<string, string> = {
  "/dashboard": "Overview",
  "/runs": "Runs",
  "/runs/queue": "Queue",
  "/settings/variants": "Variants",
  "/settings/probes": "Probes",
  "/settings/budgets": "Budgets",
  "/settings/secrets": "Secrets",
  "/settings/repo": "Repository",
  "/settings/billing": "Billing",
}

/** Longest matching href wins, so /runs/queue does not also light up /runs. */
function activeHrefFor(pathname: string): string {
  let best = ""
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      const matches = pathname === item.href || pathname.startsWith(`${item.href}/`)
      if (matches && item.href.length > best.length) best = item.href
    }
  }
  return best
}

interface Breadcrumb {
  trail: readonly string[]
  title: string
  /** A run id or other opaque identifier, rendered in mono beside the title. */
  ref?: string
}

function breadcrumbFor(pathname: string): Breadcrumb {
  const segments = pathname.split("/").filter(Boolean)
  const exact = ROUTE_TITLES[pathname]
  if (exact) return { trail: segments.slice(0, -1), title: exact }

  if (segments[0] === "runs" && segments.length >= 2) {
    return { trail: ["runs"], title: "Run", ref: segments[1] }
  }

  const last = segments.at(-1)
  if (!last) return { trail: [], title: "Overview" }
  return {
    trail: segments.slice(0, -1),
    title: last.charAt(0).toUpperCase() + last.slice(1).replace(/-/g, " "),
  }
}

/* ---------------------------------------------------------------------------
 * Page actions slot
 * ------------------------------------------------------------------------ */

export const PAGE_ACTIONS_SLOT_ID = "sandman-page-actions"

/**
 * Portals a page's primary actions into the breadcrumb strip. Pages own their
 * actions but the strip owns the layout, and a portal is the only way to keep
 * both without threading a render prop through every route.
 */
export function PageActions({ children }: { children: React.ReactNode }) {
  const [host, setHost] = React.useState<HTMLElement | null>(null)
  React.useEffect(() => {
    setHost(document.getElementById(PAGE_ACTIONS_SLOT_ID))
  }, [])
  return host ? createPortal(children, host) : null
}

/* ---------------------------------------------------------------------------
 * Shell
 * ------------------------------------------------------------------------ */

const COLLAPSE_KEY = "sandman.sidebar.collapsed"

export interface AppShellProps {
  children: React.ReactNode
  /** `owner/name`, once a project is selected. */
  repo?: string
  branch?: string
}

export function AppShell({ children, repo, branch }: AppShellProps) {
  const pathname = usePathname()
  const activeHref = React.useMemo(() => activeHrefFor(pathname), [pathname])
  const crumb = React.useMemo(() => breadcrumbFor(pathname), [pathname])

  // Read after mount rather than in the initializer: localStorage is not
  // available during the server render and a mismatch would hydrate wrong.
  const [collapsed, setCollapsed] = React.useState(false)
  React.useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1")
    } catch {
      /* storage blocked; the expanded default is correct */
    }
  }, [])

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((previous) => {
      const next = !previous
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0")
      } catch {
        /* storage blocked; the choice simply does not persist */
      }
      return next
    })
  }, [])

  // Below 1280px the rail is forced by media query; `collapsed` only decides
  // whether the wide layout is available at all.
  const railOnly = (railClasses: string, wideClasses: string) =>
    collapsed ? railClasses : cn(railClasses, wideClasses)

  return (
    <div className="min-h-dvh">
      <aside
        data-collapsed={collapsed ? "" : undefined}
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex flex-col",
          "border-r border-[var(--border-subtle)] bg-[var(--bg-surface)]",
          "transition-[width] duration-[var(--dur-normal)] ease-[var(--ease-out)]",
          collapsed ? "w-14" : "w-14 xl:w-[244px]",
        )}
      >
        <div className="p-2">
          <button
            type="button"
            className={cn(
              "flex h-9 items-center gap-2 rounded-[6px] bg-[var(--bg-raised)]",
              "text-[13px] font-medium tracking-[-0.005em] text-[var(--fg-primary)]",
              "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
              "hover:bg-[var(--bg-overlay)]",
              railOnly("mx-auto w-9 justify-center px-0", "xl:w-full xl:justify-start xl:px-2"),
            )}
            title={repo ?? "Select project"}
          >
            <span
              aria-hidden
              className="mono grid h-5 w-5 shrink-0 place-items-center rounded-[4px] border border-[var(--accent-border)] bg-[var(--accent-wash)] text-[11px] font-medium leading-none text-[var(--accent-400)]"
            >
              s
            </span>
            <span className={cn("min-w-0 flex-1 truncate text-left", railOnly("hidden", "xl:block"))}>
              {repo ?? "Select project"}
            </span>
            <CaretDown
              size={16}
              weight="regular"
              color="var(--fg-tertiary)"
              aria-hidden
              className={cn("shrink-0", railOnly("hidden", "xl:block"))}
            />
            <span className={cn(railOnly("sr-only", "xl:hidden"))}>
              {repo ?? "Select project"}
            </span>
          </button>
        </div>

        <nav aria-label="Primary" className="flex-1 overflow-y-auto px-2 pb-2">
          {NAV_GROUPS.map((group, groupIndex) => (
            <div key={group.label ?? "root"} className={groupIndex === 0 ? undefined : "mt-4"}>
              {group.label ? (
                <>
                  <div
                    aria-hidden
                    className={cn(
                      "mx-1 mb-2 h-px bg-[var(--border-hairline)]",
                      railOnly("block", "xl:hidden"),
                    )}
                  />
                  <p
                    className={cn(
                      "text-eyebrow px-2.5 pb-1.5 text-[var(--fg-tertiary)]",
                      railOnly("hidden", "xl:block"),
                    )}
                  >
                    {group.label}
                  </p>
                </>
              ) : null}

              <ul className="flex flex-col gap-0.5">
                {group.items.map((item) => {
                  const active = item.href === activeHref
                  const Icon = item.icon
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        title={item.label}
                        className={cn(
                          "relative flex h-8 items-center gap-2 rounded-[6px] text-[13px] font-medium tracking-[-0.005em]",
                          "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
                          railOnly("justify-center px-0", "xl:justify-start xl:px-2.5"),
                          active
                            ? [
                                "bg-[var(--accent-wash)] text-[var(--fg-primary)]",
                                "before:absolute before:inset-y-1 before:left-0 before:w-[2px]",
                                "before:rounded-r-[2px] before:bg-[var(--accent-400)]",
                              ]
                            : "text-[var(--fg-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--fg-primary)]",
                        )}
                      >
                        <Icon
                          size={16}
                          weight="regular"
                          color={active ? "var(--accent-400)" : "var(--fg-tertiary)"}
                          aria-hidden
                          className="shrink-0"
                        />
                        <span className={cn("truncate", railOnly("sr-only", "xl:not-sr-only"))}>
                          {item.label}
                        </span>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="hidden border-t border-[var(--border-hairline)] p-2 xl:block">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-pressed={collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              "flex h-7 items-center gap-2 rounded-[6px] px-2 text-[12.5px] font-medium",
              "text-[var(--fg-tertiary)] transition-colors duration-[var(--dur-fast)]",
              "ease-[var(--ease-out)] hover:bg-[var(--bg-raised)] hover:text-[var(--fg-secondary)]",
              collapsed ? "mx-auto w-7 justify-center px-0" : "w-full",
            )}
          >
            {collapsed ? (
              <CaretRight size={16} weight="regular" color="currentColor" aria-hidden />
            ) : (
              <>
                <CaretLeft size={16} weight="regular" color="currentColor" aria-hidden />
                <span>Collapse</span>
              </>
            )}
          </button>
        </div>
      </aside>

      <div
        className={cn(
          "flex min-h-dvh min-w-0 flex-col",
          "transition-[padding] duration-[var(--dur-normal)] ease-[var(--ease-out)]",
          collapsed ? "pl-14" : "pl-14 xl:pl-[244px]",
        )}
      >
        <header
          className={cn(
            "sticky top-0 z-20 flex h-13 shrink-0 items-center gap-3",
            "border-b border-[var(--border-hairline)] bg-[var(--bg-base)]",
            "px-5 xl:px-8",
          )}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {repo ? (
              <>
                <span className="mono truncate text-[12.5px] text-[var(--fg-tertiary)]">{repo}</span>
                {branch ? (
                  <span className="mono shrink-0 text-[12.5px] text-[var(--fg-quaternary)]">
                    @{branch}
                  </span>
                ) : null}
                <span aria-hidden className="shrink-0 text-[12.5px] text-[var(--fg-quaternary)]">
                  /
                </span>
              </>
            ) : null}

            {crumb.trail.map((segment) => (
              <React.Fragment key={segment}>
                <span className="mono shrink-0 text-[12.5px] text-[var(--fg-tertiary)]">
                  {segment}
                </span>
                <span aria-hidden className="shrink-0 text-[12.5px] text-[var(--fg-quaternary)]">
                  /
                </span>
              </React.Fragment>
            ))}

            <h1 className="shrink-0 text-[13px] font-semibold tracking-[-0.01em] text-[var(--fg-primary)]">
              {crumb.title}
            </h1>

            {crumb.ref ? (
              <span className="mono truncate text-[12.5px] text-[var(--fg-secondary)]">
                {crumb.ref}
              </span>
            ) : null}
          </div>

          <div id={PAGE_ACTIONS_SLOT_ID} className="flex shrink-0 items-center gap-2" />
        </header>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  )
}
