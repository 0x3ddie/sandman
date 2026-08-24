"use client"

import * as React from "react"
import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react"

import { shortSha } from "@/lib/utils"
import { VARIANT_META, VARIANT_ORDER, type Variant } from "@/lib/variants"

/* ---------------------------------------------------------------------------
 * Geometry — viewBox 1200 × 420, three tracks of forty 20px cells
 * ------------------------------------------------------------------------ */

const CELL = 20
const GAP = 6
const PITCH = CELL + GAP
const COUNT = 40
const TRACK_X = 92
const CHIP = 22

const LANE_Y: Record<Variant, number> = { baseline: 110, initial: 210, hotfix: 310 }

/**
 * The scenario the target app actually contains.
 *
 * Unit 14 exercises `/api/catalog/facets`, whose non-deterministic ordering is
 * present in the previous LKG as well — it fails in all three lanes and is
 * therefore PRE-EXISTING, reported but never patched. Unit 31 exercises the
 * last page of `/api/catalog/search`, which only this rollout broke; the hotfix
 * puts it back.
 */
const FAILURES: Record<Variant, readonly number[]> = {
  baseline: [14],
  initial: [14, 31],
  hotfix: [14],
}

const PRE_EXISTING_UNIT = 14
const REGRESSION_UNIT = 31

/** Units that pass in every lane — what "38/40" in the verdict counts. */
const STABLE_UNITS =
  COUNT - new Set(VARIANT_ORDER.flatMap((variant) => FAILURES[variant])).size

const cellX = (index: number): number => TRACK_X + index * PITCH
const centreX = (index: number): number => cellX(index) + CELL / 2

const LKG_REVISION = "demo/prev-lkg@7b2065b0f09f763171ce0665dbcc216f72880ca0"

/* ---------------------------------------------------------------------------
 * Timeline (seconds)
 * ------------------------------------------------------------------------ */

const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1]

const T_LANE_STAGGER = 0.12
const T_FILL_START = 0.4
const T_LANE_SPAN = 1.6
const T_CELL_STAGGER = 0.035
const T_PRE_EXISTING = 5.4
const T_REGRESSION = 5.6
const T_VERDICT = 6.0
const T_ENTER = 0.34
const T_HOLD = 1.5

const CYCLE_MS = (T_VERDICT + T_ENTER + T_HOLD) * 1000

/* ---------------------------------------------------------------------------
 * Variants
 * ------------------------------------------------------------------------ */

const laneVariants = (index: number): Variants => ({
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: T_ENTER, delay: index * T_LANE_STAGGER, ease: EASE_OUT },
  },
})

/** Each lane fills in turn, so the eye reads B, then I, then H. */
const trackVariants = (index: number): Variants => ({
  hidden: {},
  visible: {
    transition: {
      staggerChildren: T_CELL_STAGGER,
      delayChildren: T_FILL_START + index * T_LANE_SPAN,
    },
  },
})

const cellVariants: Variants = {
  hidden: { opacity: 0, scale: 0.6 },
  visible: { opacity: 1, scale: 1, transition: { duration: 0.22, ease: EASE_OUT } },
}

const fadeAt = (delay: number): Variants => ({
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.22, delay, ease: EASE_OUT } },
})

const drawAt = (delay: number): Variants => ({
  hidden: { opacity: 0, scaleY: 0 },
  visible: {
    opacity: 1,
    scaleY: 1,
    transition: { duration: T_ENTER, delay, ease: EASE_OUT },
  },
})

const cardVariants: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: T_ENTER, delay: T_VERDICT, ease: EASE_OUT } },
}

/* ---------------------------------------------------------------------------
 * Component
 * ------------------------------------------------------------------------ */

const DESCRIPTION =
  `Three probe lanes of ${COUNT} fan-out units each. ` +
  `Baseline fails unit ${PRE_EXISTING_UNIT}. Initial fails units ${PRE_EXISTING_UNIT} and ` +
  `${REGRESSION_UNIT}. Hotfix fails only unit ${PRE_EXISTING_UNIT}. Verdict: one regression ` +
  `fixed, one pre-existing failure carried over, ${STABLE_UNITS} of ${COUNT} units stable.`

export function ThreeLaneHero() {
  const reducedMotion = useReducedMotion()
  const [cycle, setCycle] = React.useState(0)

  React.useEffect(() => {
    if (reducedMotion) return
    const timer = window.setTimeout(() => setCycle((n) => n + 1), CYCLE_MS)
    return () => window.clearTimeout(timer)
  }, [cycle, reducedMotion])

  return (
    <div className="flex h-full w-full flex-col gap-4 p-5 sm:gap-5 sm:p-7">
      <div className="flex items-baseline gap-3">
        <span className="text-eyebrow text-[var(--accent-400)]">Three-way probe</span>
        <span className="mono ml-auto truncate text-[11px] text-[var(--fg-quaternary)]">
          0x3ddie/sandman · {shortSha(LKG_REVISION)} → demo/lkg
        </span>
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={cycle}
          className="flex min-h-0 flex-1 flex-col justify-center gap-4 sm:gap-5"
          initial={reducedMotion ? "visible" : "hidden"}
          animate="visible"
          exit={{ opacity: 0, transition: { duration: 0.22, ease: EASE_OUT } }}
        >
          <svg
            viewBox="0 0 1200 420"
            role="img"
            aria-label={DESCRIPTION}
            className="w-full"
            preserveAspectRatio="xMidYMid meet"
          >
            {VARIANT_ORDER.map((variant, laneIndex) => {
              const meta = VARIANT_META[variant]
              const y = LANE_Y[variant]
              const failures = new Set(FAILURES[variant])

              return (
                <motion.g key={variant} variants={laneVariants(laneIndex)}>
                  <rect
                    x={44}
                    y={y - CHIP / 2}
                    width={CHIP}
                    height={CHIP}
                    rx={4}
                    fill={meta.wash}
                    stroke={meta.border}
                    strokeWidth={1}
                  />
                  <text
                    x={44 + CHIP / 2}
                    y={y}
                    className="mono"
                    fontSize={12}
                    fontWeight={500}
                    fill={meta.color}
                    textAnchor="middle"
                    dominantBaseline="central"
                  >
                    {meta.glyph}
                  </text>

                  <motion.g variants={trackVariants(laneIndex)}>
                    {Array.from({ length: COUNT }, (_, index) => {
                      const failed = failures.has(index)
                      return (
                        <motion.rect
                          key={index}
                          variants={cellVariants}
                          x={cellX(index)}
                          y={y - CELL / 2}
                          width={CELL}
                          height={CELL}
                          rx={3}
                          fill={failed ? "var(--status-fail)" : meta.wash}
                          stroke={
                            failed
                              ? "color-mix(in srgb, var(--status-fail) 45%, transparent)"
                              : meta.border
                          }
                          strokeWidth={1}
                          style={{ transformBox: "fill-box", transformOrigin: "center" }}
                        />
                      )
                    })}
                  </motion.g>

                  <text
                    x={1140}
                    y={y}
                    className="mono"
                    fontSize={11}
                    fill="var(--fg-quaternary)"
                    dominantBaseline="central"
                  >
                    {COUNT - failures.size}/{COUNT}
                  </text>
                </motion.g>
              )
            })}

            {/* The pre-existing column: one failure standing in all three lanes.
                Steel, because it belongs to the baseline, not to this rollout. */}
            <motion.rect
              variants={drawAt(T_PRE_EXISTING)}
              x={centreX(PRE_EXISTING_UNIT) - 0.5}
              y={LANE_Y.baseline - CELL / 2 - 10}
              width={1}
              height={LANE_Y.hotfix - LANE_Y.baseline + CELL + 20}
              fill="var(--variant-baseline)"
              style={{ transformBox: "fill-box", transformOrigin: "center top" }}
            />
            <motion.text
              variants={fadeAt(T_PRE_EXISTING + 0.12)}
              x={centreX(PRE_EXISTING_UNIT)}
              y={76}
              className="mono"
              fontSize={11}
              fontWeight={500}
              letterSpacing="0.14em"
              fill="var(--variant-baseline)"
              textAnchor="middle"
            >
              PRE-EXISTING
            </motion.text>

            {/* The regression column: broken by this rollout, put back by the
                patch. The mint square is laid over the rose one and faded in,
                so the "morph" costs an opacity change and nothing else. */}
            <motion.rect
              variants={drawAt(T_REGRESSION)}
              x={centreX(REGRESSION_UNIT) - 0.5}
              y={LANE_Y.initial - CELL / 2}
              width={1}
              height={LANE_Y.hotfix - LANE_Y.initial + CELL / 2 + 20}
              fill="var(--status-pass)"
              style={{ transformBox: "fill-box", transformOrigin: "center top" }}
            />
            <motion.rect
              variants={fadeAt(T_REGRESSION)}
              x={cellX(REGRESSION_UNIT)}
              y={LANE_Y.initial - CELL / 2}
              width={CELL}
              height={CELL}
              rx={3}
              fill="var(--status-pass)"
              stroke="color-mix(in srgb, var(--status-pass) 45%, transparent)"
              strokeWidth={1}
            />
            <motion.text
              variants={fadeAt(T_REGRESSION + 0.12)}
              x={centreX(REGRESSION_UNIT)}
              y={362}
              className="mono"
              fontSize={11}
              fontWeight={500}
              letterSpacing="0.14em"
              fill="var(--status-pass)"
              textAnchor="middle"
            >
              REGRESSION FIXED
            </motion.text>
          </svg>

          <motion.div
            variants={cardVariants}
            className="mx-auto flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--bg-overlay)] px-4 py-2.5 shadow-[var(--elev-3)]"
          >
            <span aria-hidden className="text-[13px] leading-none text-[var(--status-pass)]">
              ✓
            </span>
            <span className="mono text-[11px] font-medium uppercase leading-none tracking-[0.14em] text-[var(--fg-primary)]">
              1 regression fixed
            </span>
            <Separator />
            <span className="mono text-[11px] font-medium uppercase leading-none tracking-[0.14em] text-[var(--variant-baseline)]">
              1 pre-existing carried over
            </span>
            <Separator />
            <span className="mono text-[11px] font-medium uppercase leading-none tracking-[0.14em] text-[var(--fg-tertiary)]">
              {STABLE_UNITS}/{COUNT} pass
            </span>
          </motion.div>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

function Separator() {
  return (
    <span aria-hidden className="text-[11px] leading-none text-[var(--fg-quaternary)]">
      ·
    </span>
  )
}
