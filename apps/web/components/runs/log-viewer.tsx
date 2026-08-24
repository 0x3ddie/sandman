"use client"

/**
 * The log well.
 *
 * A run emits tens of thousands of lines, so rows are virtualised and the
 * container is the only thing that scrolls. Everything else here exists to keep
 * small mono text readable: grain is switched off (it eats 12.5px glyphs), the
 * gutter is right-aligned tabular figures that do not shift as line numbers
 * gain digits, and level is carried by a 2px edge rather than by tinting the
 * text, which would fight the search highlight.
 */

import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ArrowDown, CaretDown, CaretUp, MagnifyingGlass, X } from "phosphor-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import type { LogLevel, LogLine } from "./use-run-stream"

const LINE_HEIGHT = 20
const GUTTER_WIDTH = 56
const TIME_WIDTH = 88
const BOTTOM_EPSILON = 24

const LEVEL_EDGE: Record<LogLevel, string> = {
  error: "var(--status-fail)",
  warn: "var(--status-flaky)",
  info: "transparent",
}

const LEVEL_TEXT: Record<LogLevel, string> = {
  error: "var(--fg-primary)",
  warn: "var(--fg-secondary)",
  info: "var(--fg-secondary)",
}

function clockTime(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number, size = 2) => String(value).padStart(size, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3,
  )}`
}

/** Case-insensitive split that keeps the matched slices for highlighting. */
function highlight(text: string, query: string): React.ReactNode {
  if (query === "") return text
  const needle = query.toLowerCase()
  const haystack = text.toLowerCase()
  const parts: React.ReactNode[] = []
  let cursor = 0
  let found = haystack.indexOf(needle)
  while (found !== -1) {
    if (found > cursor) parts.push(text.slice(cursor, found))
    parts.push(
      <mark
        key={`${found}-${parts.length}`}
        className="rounded-[2px] bg-[var(--accent-wash)] text-[var(--accent-300)]"
      >
        {text.slice(found, found + query.length)}
      </mark>,
    )
    cursor = found + query.length
    found = haystack.indexOf(needle, cursor)
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}

export interface LogViewerProps {
  lines: LogLine[]
  unitFilter: string | null
  onUnitFilterChange: (unitId: string | null) => void
  /** Wall clock from the waterfall playhead; scrolls to the first line at or after it. */
  seekTo: number | null
  onSeek?: (ts: number) => void
  running: boolean
}

export function LogViewer({
  lines,
  unitFilter,
  onUnitFilterChange,
  seekTo,
  onSeek,
  running,
}: LogViewerProps) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const [follow, setFollow] = React.useState(true)
  const [query, setQuery] = React.useState("")
  const [matchCursor, setMatchCursor] = React.useState(0)
  const [showTimestamps, setShowTimestamps] = React.useState(true)

  const visible = React.useMemo(
    () => (unitFilter === null ? lines : lines.filter((line) => line.unitId === unitFilter)),
    [lines, unitFilter],
  )

  const matches = React.useMemo(() => {
    if (query.trim() === "") return []
    const needle = query.toLowerCase()
    const out: number[] = []
    for (let index = 0; index < visible.length; index += 1) {
      const line = visible[index]
      if (line && line.text.toLowerCase().includes(needle)) out.push(index)
    }
    return out
  }, [visible, query])

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 24,
    getItemKey: (index) => visible[index]?.seq ?? index,
  })

  // Follow mode pins the viewport to the tail. It is armed and disarmed by the
  // scroll position, never by a timer, so a manual scroll-up always wins.
  React.useEffect(() => {
    if (!follow || visible.length === 0) return
    virtualizer.scrollToIndex(visible.length - 1, { align: "end" })
  }, [follow, visible.length, virtualizer])

  const handleScroll = React.useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_EPSILON
    setFollow(atBottom)
  }, [])

  const jumpTo = React.useCallback(
    (index: number) => {
      setFollow(false)
      virtualizer.scrollToIndex(index, { align: "center" })
    },
    [virtualizer],
  )

  const activeMatch = matches.length === 0 ? null : (matches[matchCursor % matches.length] ?? null)

  React.useEffect(() => {
    setMatchCursor(0)
  }, [query])

  React.useEffect(() => {
    if (activeMatch === null) return
    jumpTo(activeMatch)
  }, [activeMatch, jumpTo])

  // Deliberately keyed on the playhead alone: `visible` gets a new identity on
  // every flush, and depending on it would re-seek ten times a second and fight
  // whoever is reading.
  const visibleRef = React.useRef(visible)
  visibleRef.current = visible

  React.useEffect(() => {
    const rows = visibleRef.current
    if (seekTo === null || rows.length === 0) return
    const found = rows.findIndex((line) => line.ts >= seekTo)
    setFollow(false)
    virtualizer.scrollToIndex(found === -1 ? rows.length - 1 : found, { align: "start" })
  }, [seekTo, virtualizer])

  const step = (delta: number) => {
    if (matches.length === 0) return
    setMatchCursor((cursor) => (cursor + delta + matches.length) % matches.length)
  }

  return (
    <section className="overflow-hidden rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[var(--elev-1)]">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border-hairline)] px-3 py-2">
        <div className="relative flex h-7 min-w-[220px] flex-1 items-center rounded-[6px] border border-[var(--border-subtle)] bg-[var(--bg-raised)] pl-2 pr-1">
          <MagnifyingGlass size={16} weight="regular" color="var(--fg-tertiary)" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              event.preventDefault()
              step(event.shiftKey ? -1 : 1)
            }}
            placeholder="Search logs"
            aria-label="Search logs"
            className="mono h-full min-w-0 flex-1 bg-transparent px-2 text-[12.5px] text-[var(--fg-primary)] placeholder:text-[var(--fg-quaternary)]"
          />
          {query === "" ? null : (
            <>
              <span className="mono px-1 text-[11.5px] text-[var(--fg-tertiary)]" data-numeric>
                {matches.length === 0 ? "0" : `${matchCursor % matches.length + 1}/${matches.length}`}
              </span>
              <Button
                variant="ghost"
                size="iconSm"
                aria-label="Previous match"
                onClick={() => step(-1)}
                disabled={matches.length === 0}
              >
                <CaretUp size={16} weight="regular" color="currentColor" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="iconSm"
                aria-label="Next match"
                onClick={() => step(1)}
                disabled={matches.length === 0}
              >
                <CaretDown size={16} weight="regular" color="currentColor" aria-hidden />
              </Button>
            </>
          )}
        </div>

        {unitFilter ? (
          <button
            type="button"
            onClick={() => onUnitFilterChange(null)}
            className={cn(
              "mono inline-flex h-7 items-center gap-1.5 rounded-[6px] border px-2 text-[11.5px]",
              "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent-300)]",
              "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
              "hover:bg-[rgb(255_180_84_/_0.16)]",
            )}
          >
            {unitFilter}
            <X size={16} weight="regular" color="currentColor" aria-hidden />
          </button>
        ) : null}

        <Button
          variant="ghost"
          size="sm"
          aria-pressed={showTimestamps}
          onClick={() => setShowTimestamps((value) => !value)}
        >
          {showTimestamps ? "Hide time" : "Show time"}
        </Button>

        <span className="mono text-[11.5px] text-[var(--fg-quaternary)]" data-numeric>
          {visible.length} lines
        </span>
      </header>

      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="no-grain h-[520px] overflow-auto rounded-b-[8px] bg-[var(--bg-inset)]"
        >
          {visible.length === 0 ? (
            <p className="text-body-sm px-4 py-16 text-center text-[var(--fg-tertiary)]">
              {unitFilter
                ? `No output from ${unitFilter} yet.`
                : running
                  ? "Waiting for the first sandbox to say something."
                  : "This run produced no log output."}
            </p>
          ) : (
            <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const line = visible[item.index]
                if (!line) return null
                const isMatch = item.index === activeMatch
                return (
                  <div
                    key={item.key}
                    className={cn(
                      "absolute left-0 flex w-max min-w-full items-start",
                      isMatch && "bg-[var(--accent-wash)]",
                    )}
                    style={{ top: item.start, height: LINE_HEIGHT }}
                    onDoubleClick={() => onSeek?.(line.ts)}
                  >
                    <span
                      aria-hidden
                      className="sticky left-0 h-full w-[2px] shrink-0"
                      style={{ backgroundColor: LEVEL_EDGE[line.level] }}
                    />
                    <span
                      aria-hidden
                      className="mono sticky left-[2px] shrink-0 select-none bg-[var(--bg-inset)] pr-3 text-right text-[12.5px] leading-[1.55] text-[var(--fg-quaternary)]"
                      style={{ width: GUTTER_WIDTH }}
                      data-numeric
                    >
                      {line.seq + 1}
                    </span>
                    {showTimestamps ? (
                      <span
                        className="mono shrink-0 select-none pr-3 text-[12.5px] leading-[1.55] text-[var(--fg-quaternary)]"
                        style={{ width: TIME_WIDTH }}
                        data-numeric
                      >
                        {clockTime(line.ts)}
                      </span>
                    ) : null}
                    <span
                      className="mono whitespace-pre pr-4 text-[12.5px] leading-[1.55]"
                      style={{ color: LEVEL_TEXT[line.level] }}
                    >
                      {highlight(line.text, query)}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="pointer-events-none absolute bottom-3 right-4 flex items-center gap-2">
          <Button
            variant={follow ? "primary" : "secondary"}
            size="sm"
            aria-pressed={follow}
            onClick={() => setFollow(true)}
            className="pointer-events-auto"
          >
            <ArrowDown size={16} weight="regular" color="currentColor" aria-hidden />
            {follow ? "Following" : "Follow"}
          </Button>
        </div>
      </div>
    </section>
  )
}
