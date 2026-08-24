"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { CaretDown, DotsThree, GitBranch, ListChecks, MagnifyingGlass } from "phosphor-react"
import { toast } from "sonner"

import { runStreamUrl } from "@/lib/control-plane"
import {
  RUN_FILTER_INPUT_ID,
  RUN_RANGE_FILTERS,
  RUN_RANGE_LABELS,
  RUN_STATUS_FILTERS,
  isRunRangeFilter,
  isRunStatusFilter,
  type RunRangeFilter,
  type RunStatusFilter,
} from "@/lib/run-filters"
import {
  absoluteTime,
  cn,
  formatDuration,
  formatRelativeTime,
  formatUsd,
  isoTime,
  revisionRef,
  shortSha,
} from "@/lib/utils"
import {
  RUN_STATE_META,
  VARIANT_META,
  VARIANT_ORDER,
  type RunState,
  type SandboxStatus,
  type Variant,
} from "@/lib/variants"
import { EmptyState } from "@/components/ui/empty-state"
import { Segmented } from "@/components/ui/segmented"
import { StatusPill } from "@/components/ui/status-pill"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

/* ---------------------------------------------------------------------------
 * Row shape
 *
 * Everything here is JSON-serialisable: the pages that own the Postgres and
 * control-plane reads are Server Components, and only this table needs to be a
 * client one. Timestamps cross the boundary as ISO strings.
 * ------------------------------------------------------------------------ */

export interface RunRow {
  id: string
  state: RunState
  /** Drives the terminal pill: a completed run is "Clear" or "Blocked". */
  safeToPromote: boolean
  /** `manual`, `push`, `pull_request`, `schedule`, … */
  trigger: string
  /** `REF@SHA` for the lane under test; null until revisions resolve. */
  revision: string | null
  /** Which of the three lanes actually ran. A skipped lane dims to 30%. */
  lanes: Record<Variant, boolean>
  passed: number
  failed: number
  flaky: number
  probeCount: number
  /** Null while the run is still in flight; elapsed time is derived instead. */
  durationMs: number | null
  usdSpent: number
  startedAt: string | null
  /** The control plane still holds this run in memory. */
  live: boolean
}

/* ---------------------------------------------------------------------------
 * Status mapping
 * ------------------------------------------------------------------------ */

interface RunPill {
  status: SandboxStatus
  label: string
}

/**
 * Run states outnumber sandbox statuses, so the pill carries its own label.
 *
 * `completed` splits on the promotion gate rather than sharing one word: a run
 * that finished and a run that finished *clean* are different answers, and
 * separating them by colour alone would fail the same colour-safety rule the
 * variant triad follows.
 */
function runPill(row: RunRow): RunPill {
  switch (row.state) {
    case "queued":
      return { status: "queued", label: "Queued" }
    case "provisioning":
      return { status: "provisioning", label: "Provisioning" }
    case "completed":
      return row.safeToPromote
        ? { status: "passed", label: "Clear" }
        : { status: "failed", label: "Blocked" }
    case "failed":
      return { status: "error", label: "Errored" }
    case "aborted":
      return { status: "skipped", label: "Aborted" }
    default:
      return { status: "running", label: RUN_STATE_META[row.state].label }
  }
}

const TRIGGER_LABELS: Record<string, string> = {
  manual: "Manual",
  push: "Push",
  pull_request: "Pull request",
  schedule: "Scheduled",
  api: "API",
  webhook: "Webhook",
}

function triggerLabel(trigger: string): string {
  return TRIGGER_LABELS[trigger] ?? trigger.replace(/_/g, " ")
}

/* ---------------------------------------------------------------------------
 * Live clock
 * ------------------------------------------------------------------------ */

/**
 * A clock seeded from the server's render time.
 *
 * Seeding matters: relative timestamps are rendered during SSR too, and reading
 * `Date.now()` on the first client render would hydrate a different string.
 * After mount it ticks so "4m ago" and an in-flight run's elapsed time stay
 * honest without a refetch.
 */
function useNow(seed: number): number {
  const [now, setNow] = React.useState(seed)
  React.useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/* ---------------------------------------------------------------------------
 * Cells
 * ------------------------------------------------------------------------ */

/** Three 4×20 bars, always B → I → H, dimmed where the lane was skipped. */
function LaneBars({ lanes }: { lanes: Record<Variant, boolean> }) {
  const description = VARIANT_ORDER.map(
    (variant) => `${VARIANT_META[variant].label} ${lanes[variant] ? "ran" : "skipped"}`,
  ).join(", ")

  return (
    <span role="img" aria-label={description} className="inline-flex items-center gap-[3px]">
      {VARIANT_ORDER.map((variant) => (
        <span
          key={variant}
          aria-hidden
          data-variant={variant}
          className="block h-5 w-1 rounded-[1px]"
          style={{
            backgroundColor: VARIANT_META[variant].color,
            opacity: lanes[variant] ? 1 : 0.3,
          }}
        />
      ))}
    </span>
  )
}

function PassRateBar({ row }: { row: RunRow }) {
  const observed = row.passed + row.failed + row.flaky
  const total = Math.max(row.probeCount, observed)
  const pending = Math.max(0, total - observed)

  const segments: readonly { key: string; value: number; color: string; label: string }[] = [
    { key: "pass", value: row.passed, color: "var(--status-pass)", label: "passed" },
    { key: "fail", value: row.failed, color: "var(--status-fail)", label: "failed" },
    { key: "flaky", value: row.flaky, color: "var(--status-flaky)", label: "flaky" },
    { key: "pending", value: pending, color: "var(--bg-raised)", label: "not yet reported" },
  ]

  return (
    <span className="flex items-center gap-2.5">
      <span
        role="img"
        aria-label={
          total === 0
            ? "No probes reported"
            : segments
                .filter((segment) => segment.value > 0)
                .map((segment) => `${segment.value} ${segment.label}`)
                .join(", ")
        }
        className="flex h-1.5 w-16 shrink-0 gap-px overflow-hidden rounded-[2px] bg-[var(--bg-inset)]"
      >
        {segments
          .filter((segment) => segment.value > 0)
          .map((segment) => (
            <span
              key={segment.key}
              style={{
                flexGrow: segment.value,
                flexShrink: 1,
                flexBasis: 0,
                minWidth: "2px",
                backgroundColor: segment.color,
              }}
            />
          ))}
      </span>
      <span className="mono text-[12.5px] text-[var(--fg-secondary)]" data-numeric>
        {row.passed}
        <span className="text-[var(--fg-quaternary)]">/</span>
        {total}
      </span>
    </span>
  )
}

const MENU_ITEM_CLASS = cn(
  "flex h-8 cursor-default select-none items-center gap-2 rounded-[4px] px-2",
  "text-[13px] tracking-[-0.005em] text-[var(--fg-secondary)] outline-none",
  "data-[highlighted]:bg-[var(--bg-raised)] data-[highlighted]:text-[var(--fg-primary)]",
  "data-[disabled]:pointer-events-none data-[disabled]:text-[var(--fg-quaternary)]",
)

function RowMenu({ row }: { row: RunRow }) {
  const copy = React.useCallback((value: string, what: string) => {
    // The Clipboard API is absent outside a secure context, which a self-hosted
    // dashboard served over plain http will hit.
    if (!navigator.clipboard) {
      toast.error("Clipboard is unavailable outside a secure context")
      return
    }
    void navigator.clipboard.writeText(value).then(
      () => toast.success(`${what} copied`),
      () => toast.error(`Could not copy ${what.toLowerCase()}`),
    )
  }, [])

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label={`Actions for ${row.id}`}
        className={cn(
          "inline-flex h-7 w-7 items-center justify-center rounded-[6px]",
          "text-[var(--fg-tertiary)] transition-colors duration-[var(--dur-fast)]",
          "ease-[var(--ease-out)] hover:bg-[var(--bg-overlay)] hover:text-[var(--fg-primary)]",
          "data-[state=open]:bg-[var(--bg-overlay)] data-[state=open]:text-[var(--fg-primary)]",
        )}
      >
        <DotsThree size={16} weight="regular" color="currentColor" aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className={cn(
            "z-50 min-w-[196px] rounded-[8px] border border-[var(--border-default)]",
            "bg-[var(--bg-overlay)] p-1 shadow-[var(--elev-2)]",
          )}
        >
          <DropdownMenu.Item asChild className={MENU_ITEM_CLASS}>
            <Link href={`/runs/${row.id}`}>Open run</Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={MENU_ITEM_CLASS}
            onSelect={() => copy(row.id, "Run id")}
          >
            Copy run id
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={MENU_ITEM_CLASS}
            disabled={row.revision === null}
            onSelect={() => {
              if (row.revision) copy(shortSha(row.revision), "Commit sha")
            }}
          >
            Copy commit sha
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-hairline)]" />
          <DropdownMenu.Item
            className={MENU_ITEM_CLASS}
            onSelect={() =>
              copy(`${window.location.origin}${runStreamUrl(row.id)}`, "Stream URL")
            }
          >
            Copy event stream URL
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] px-1",
        "border border-[var(--border-hairline)] bg-[var(--bg-raised)]",
        "text-[10.5px] font-medium leading-none text-[var(--fg-tertiary)]",
      )}
    >
      {children}
    </kbd>
  )
}

/* ---------------------------------------------------------------------------
 * Table
 * ------------------------------------------------------------------------ */

export interface RunTableProps {
  rows: readonly RunRow[]
  /** The server's render time, ISO. Seeds the relative-time clock. */
  now: string
  /**
   * Id of the filter input `/` should focus. Omitted where no filter bar is on
   * screen, which also removes `/` from the shortcut hint.
   */
  filterInputId?: string
  emptyTitle?: string
  emptyDescription?: string
  className?: string
}

export function RunTable({
  rows,
  now,
  filterInputId,
  emptyTitle = "No runs yet",
  emptyDescription = "Start an investigation and its three sandbox lanes will show up here.",
  className,
}: RunTableProps) {
  const router = useRouter()
  const clock = useNow(new Date(now).getTime())

  const [selected, setSelected] = React.useState(-1)
  const rowRefs = React.useRef<(HTMLTableRowElement | null)[]>([])

  // Held in a ref so the key handler can stay bound across renders without
  // re-subscribing on every selection change.
  const selectedRef = React.useRef(selected)
  React.useEffect(() => {
    selectedRef.current = selected
  }, [selected])

  const ids = React.useMemo(() => rows.map((row) => row.id), [rows])
  const idsKey = ids.join("\u0000")

  // A filter can shrink the list out from under the cursor.
  React.useEffect(() => {
    setSelected((current) => (current >= ids.length ? ids.length - 1 : current))
  }, [ids.length])

  const open = React.useCallback(
    (index: number) => {
      const id = ids[index]
      if (id) router.push(`/runs/${id}`)
    },
    [ids, router],
  )

  React.useEffect(() => {
    function isTyping(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false
      if (target.isContentEditable) return true
      return (
        target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT"
      )
    }

    function move(delta: number) {
      setSelected((current) => {
        if (ids.length === 0) return -1
        const next = current < 0 ? (delta > 0 ? 0 : ids.length - 1) : current + delta
        return Math.min(ids.length - 1, Math.max(0, next))
      })
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return

      if (event.key === "/" && !isTyping(event.target)) {
        if (!filterInputId) return
        const input = document.getElementById(filterInputId)
        if (input instanceof HTMLInputElement) {
          event.preventDefault()
          input.focus()
          input.select()
        }
        return
      }

      if (isTyping(event.target)) return

      switch (event.key) {
        case "j":
        case "ArrowDown":
          event.preventDefault()
          move(1)
          break
        case "k":
        case "ArrowUp":
          event.preventDefault()
          move(-1)
          break
        case "Enter":
          if (selectedRef.current >= 0) {
            event.preventDefault()
            open(selectedRef.current)
          }
          break
        case "Escape":
          setSelected(-1)
          break
        default:
          break
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [ids.length, filterInputId, open])

  // `block: "nearest"` and no smooth behaviour: the sticky header already keeps
  // context, and an animated scroll on every j-press feels laggy.
  React.useEffect(() => {
    if (selected < 0) return
    rowRefs.current[selected]?.scrollIntoView({ block: "nearest" })
  }, [selected, idsKey])

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={ListChecks}
        title={emptyTitle}
        description={emptyDescription}
        className={className}
      />
    )
  }

  return (
    <div className={className}>
      <Table surface="surface">
        <colgroup>
          <col style={{ width: "96px" }} />
          <col style={{ width: "116px" }} />
          <col />
          <col style={{ width: "60px" }} />
          <col style={{ width: "136px" }} />
          <col style={{ width: "88px" }} />
          <col style={{ width: "92px" }} />
          <col style={{ width: "104px" }} />
          <col style={{ width: "48px" }} />
        </colgroup>
        <TableHeader>
          {/* The head cells draw their own separator; the row border would double it. */}
          <TableRow className="h-8 border-b-0 hover:bg-transparent">
            <TableHead>Status</TableHead>
            <TableHead>Run</TableHead>
            <TableHead>Trigger</TableHead>
            <TableHead>B I H</TableHead>
            <TableHead>Probes</TableHead>
            <TableHead numeric>Duration</TableHead>
            <TableHead numeric>Cost</TableHead>
            <TableHead numeric>Started</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => {
            const pill = runPill(row)
            const started = row.startedAt
            const elapsed =
              row.durationMs ??
              (started && !RUN_STATE_META[row.state].terminal
                ? clock - new Date(started).getTime()
                : null)
            const isSelected = index === selected

            return (
              <TableRow
                key={row.id}
                ref={(node) => {
                  rowRefs.current[index] = node
                }}
                data-state={isSelected ? "selected" : undefined}
                aria-selected={isSelected}
                onClick={() => {
                  setSelected(index)
                  open(index)
                }}
                onMouseDown={() => setSelected(index)}
                className={cn(
                  "cursor-pointer",
                  isSelected &&
                    "[&>td:first-child]:shadow-[inset_2px_0_0_0_var(--accent-400)]",
                )}
              >
                <TableCell>
                  <StatusPill status={pill.status} label={pill.label} />
                </TableCell>

                <TableCell>
                  <Link
                    href={`/runs/${row.id}`}
                    onClick={(event) => event.stopPropagation()}
                    className={cn(
                      "mono text-[12.5px] text-[var(--fg-secondary)]",
                      "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
                      "hover:text-[var(--fg-primary)]",
                    )}
                  >
                    {row.id}
                  </Link>
                  {row.live ? (
                    <span
                      aria-label="Live in the control plane"
                      title="Live in the control plane"
                      className="pulse-dot ml-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
                      style={{ backgroundColor: "var(--status-running)" }}
                    />
                  ) : null}
                </TableCell>

                <TableCell>
                  <span
                    className="flex min-w-0 items-center gap-2"
                    title={`${triggerLabel(row.trigger)}${row.revision ? ` · ${row.revision}` : ""}`}
                  >
                    <span className="mono shrink-0 text-[12.5px] text-[var(--fg-primary)]">
                      {row.revision ? shortSha(row.revision) : "———————"}
                    </span>
                    {row.revision ? (
                      <span
                        className={cn(
                          "inline-flex h-[22px] min-w-0 shrink items-center gap-1 rounded-[6px] pl-1.5 pr-2",
                          "border border-[var(--border-hairline)] bg-[var(--bg-raised)]",
                        )}
                      >
                        <GitBranch
                          size={16}
                          weight="regular"
                          color="var(--fg-quaternary)"
                          aria-hidden
                          className="shrink-0"
                        />
                        <span className="mono truncate text-[11px] leading-none text-[var(--fg-tertiary)]">
                          {revisionRef(row.revision)}
                        </span>
                      </span>
                    ) : (
                      <span className="text-[12px] text-[var(--fg-quaternary)]">
                        {triggerLabel(row.trigger)}
                      </span>
                    )}
                  </span>
                </TableCell>

                <TableCell>
                  <LaneBars lanes={row.lanes} />
                </TableCell>

                <TableCell>
                  <PassRateBar row={row} />
                </TableCell>

                <TableCell numeric className="mono">
                  {elapsed === null ? "—" : formatDuration(elapsed)}
                </TableCell>

                <TableCell numeric className="mono">
                  {formatUsd(row.usdSpent)}
                </TableCell>

                <TableCell numeric>
                  {started ? (
                    <time
                      dateTime={isoTime(started)}
                      title={absoluteTime(started)}
                      suppressHydrationWarning
                      className="mono text-[12.5px] text-[var(--fg-tertiary)]"
                    >
                      {formatRelativeTime(started, clock)}
                    </time>
                  ) : (
                    <span className="text-[var(--fg-quaternary)]">—</span>
                  )}
                </TableCell>

                <TableCell
                  className="text-right"
                  onClick={(event) => event.stopPropagation()}
                >
                  <RowMenu row={row} />
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>

      {rows.length > 1 ? (
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-[var(--border-hairline)]",
            "px-4 py-2.5 text-[12px] text-[var(--fg-quaternary)]",
          )}
        >
          <span className="flex items-center gap-1.5">
            <Kbd>j</Kbd>
            <Kbd>k</Kbd>
            move
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd>
            open
          </span>
          {filterInputId ? (
            <span className="flex items-center gap-1.5">
              <Kbd>/</Kbd>
              filter
            </span>
          ) : null}
          <span className="flex items-center gap-1.5">
            <Kbd>esc</Kbd>
            clear
          </span>
        </div>
      ) : null}
    </div>
  )
}

/* ---------------------------------------------------------------------------
 * Filter bar
 * ------------------------------------------------------------------------ */

const RANGE_LABELS = RUN_RANGE_LABELS

const CONTROL_CLASS = cn(
  "h-8 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-raised)]",
  "text-[12.5px] font-medium tracking-[-0.005em] text-[var(--fg-secondary)]",
  "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
  "hover:border-[var(--border-subtle)] hover:text-[var(--fg-primary)]",
)

function FilterSelect({
  label,
  value,
  onChange,
  children,
  className,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("relative shrink-0", className)}>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          CONTROL_CLASS,
          "w-full appearance-none pl-2.5 pr-7 [&>option]:bg-[var(--bg-overlay)]",
        )}
      >
        {children}
      </select>
      <CaretDown
        size={16}
        weight="regular"
        color="var(--fg-tertiary)"
        aria-hidden
        className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2"
      />
    </div>
  )
}

export interface RunFilterBarProps {
  /** Branch refs seen across this organisation's runs. */
  branches: readonly string[]
  className?: string
}

/**
 * Filter state lives in the URL, not in React.
 *
 * Filtering happens in Postgres — a team's run history is far too long to ship
 * to the browser — so the controls write search params and the Server Component
 * re-queries. `useTransition` keeps the current rows on screen while that round
 * trip is in flight instead of flashing a skeleton.
 */
export function RunFilterBar({ branches, className }: RunFilterBarProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = React.useTransition()

  const statusParam = searchParams.get("status") ?? "all"
  const status: RunStatusFilter = isRunStatusFilter(statusParam) ? statusParam : "all"
  const rangeParam = searchParams.get("range") ?? "30d"
  const range: RunRangeFilter = isRunRangeFilter(rangeParam) ? rangeParam : "30d"
  const branch = searchParams.get("branch") ?? ""
  const query = searchParams.get("q") ?? ""

  const [draft, setDraft] = React.useState(query)

  const commit = React.useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams.toString())
      if (value === null || value === "") next.delete(key)
      else next.set(key, value)
      const suffix = next.toString()
      startTransition(() => {
        router.replace(suffix ? `${pathname}?${suffix}` : pathname, { scroll: false })
      })
    },
    [pathname, router, searchParams],
  )

  // Back/forward and cleared params have to win over the local draft.
  React.useEffect(() => {
    setDraft(query)
  }, [query])

  React.useEffect(() => {
    if (draft === query) return
    const timer = window.setTimeout(() => commit("q", draft.trim() || null), 250)
    return () => window.clearTimeout(timer)
  }, [draft, query, commit])

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <div className="relative min-w-[200px] flex-1 sm:max-w-[280px]">
        <MagnifyingGlass
          size={16}
          weight="regular"
          color="var(--fg-quaternary)"
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
        />
        <input
          id={RUN_FILTER_INPUT_ID}
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") event.currentTarget.blur()
          }}
          placeholder="Filter by run id or sha"
          aria-label="Filter runs by run id or commit sha"
          className={cn(
            CONTROL_CLASS,
            "mono w-full pl-8 pr-8 text-[12.5px] placeholder:font-sans",
            "placeholder:text-[13px] placeholder:tracking-[-0.005em]",
            "placeholder:text-[var(--fg-quaternary)] [&::-webkit-search-cancel-button]:appearance-none",
          )}
        />
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2",
            "mono text-[10.5px] leading-none text-[var(--fg-quaternary)]",
            draft ? "opacity-0" : "opacity-100",
          )}
        >
          /
        </span>
      </div>

      <Segmented
        aria-label="Filter runs by status"
        value={status}
        onValueChange={(value: RunStatusFilter) => commit("status", value === "all" ? null : value)}
        options={[
          { value: "all", label: "All" },
          { value: "running", label: "Running" },
          { value: "failed", label: "Failed" },
          { value: "mine", label: "Mine" },
        ]}
      />

      <FilterSelect
        label="Filter runs by branch"
        value={branch}
        onChange={(value) => commit("branch", value || null)}
        className="max-w-[200px]"
      >
        <option value="">All branches</option>
        {branches.map((ref) => (
          <option key={ref} value={ref}>
            {ref}
          </option>
        ))}
      </FilterSelect>

      <FilterSelect
        label="Filter runs by date range"
        value={range}
        onChange={(value) => commit("range", value === "30d" ? null : value)}
      >
        {RUN_RANGE_FILTERS.map((value) => (
          <option key={value} value={value}>
            {RANGE_LABELS[value]}
          </option>
        ))}
      </FilterSelect>

      <span
        aria-hidden
        className={cn(
          "pulse-dot h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent-400)]",
          "transition-opacity duration-[var(--dur-fast)] ease-[var(--ease-out)]",
          pending ? "opacity-100" : "opacity-0",
        )}
      />
      <span className="sr-only" role="status">
        {pending ? "Applying filters" : ""}
      </span>
    </div>
  )
}
