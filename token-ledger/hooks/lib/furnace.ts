// Pure maths for the furnace: burn rate, how the bar is split between the main
// loop and each agent, and each frame's flame heights. The Client module only
// draws what these return, so tests cover the behaviour without a surface.

import type { LedgerSample } from '../../types'

export const BURN_WINDOW_MS = 5 * 60_000
export const SAMPLES_KEEP = 120
/** Burn rate at which the flames reach full height: one point of the 5-hour limit a minute. */
export const FULL_HEAT_POINTS_PER_MIN = 1

export type Stage = 'calm' | 'warm' | 'hot' | 'over'

export type FurnaceSource = {
  readonly key: string
  readonly kind: 'main' | 'agent'
  /** This source's share of today's spend, 0-1. */
  readonly share: number
  /** How hard it burns now, 0-1. */
  readonly heat: number
}

export type FurnaceProps = {
  readonly fill: number
  readonly stage: Stage
  readonly sources: readonly FurnaceSource[]
  readonly animate: boolean
}

/** Points of the 5-hour limit a minute over the window: newest reading less the oldest inside it. */
export const burnRate = (samples: readonly LedgerSample[], now: number, windowMs = BURN_WINDOW_MS): number => {
  const inside = samples.filter(s => now - s.at <= windowMs)
  const first = inside[0]
  const last = inside.at(-1)
  if (!first || !last || last === first) return 0
  const minutes = Math.max(1, (now - first.at) / 60_000)
  return Math.max(0, (last.percent - first.percent) / minutes)
}

export const heatOf = (pointsPerMin: number): number => Math.max(0, Math.min(1, pointsPerMin / FULL_HEAT_POINTS_PER_MIN))

/** Minutes until the limit at this rate, or null when it resets first or nothing burns. */
export const minutesToLimit = (percent: number, pointsPerMin: number, minutesToReset: number | null): number | null => {
  if (pointsPerMin <= 0 || percent >= 100) return percent >= 100 ? 0 : null
  const minutes = (100 - percent) / pointsPerMin
  return minutesToReset !== null && minutes >= minutesToReset ? null : Math.round(minutes)
}

/** The ember strip as status-bar text: one eighth-block glyph per column, dots where unlit. */
const GLYPHS = ['·', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
export const emberText = (heights: readonly number[]): string =>
  heights.map(h => GLYPHS[Math.max(0, Math.min(8, Math.round(h)))] ?? '·').join('')

export const stageOf = (fill: number): Stage => (fill > 1 ? 'over' : fill >= 0.9 ? 'hot' : fill >= 0.6 ? 'warm' : 'calm')

/** How many of `columns` each source gets, in order; the rest of the bar stays unlit. */
export const splitColumns = (columns: number, fill: number, sources: readonly FurnaceSource[]): number[] => {
  const lit = Math.round(columns * Math.min(1, Math.max(0, fill)))
  const total = sources.reduce((s, x) => s + x.share, 0)
  if (lit === 0 || total <= 0) return sources.map(() => 0)
  const raw = sources.map(s => (s.share / total) * lit)
  const floors = raw.map(Math.floor)
  const left = lit - floors.reduce((a, b) => a + b, 0)
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0])
  return floors.map((f, i) => f + (order.slice(0, left).some(([, j]) => j === i) ? 1 : 0))
}

/** Heights are measured in eighths of a row, so flame tips can be drawn smoothly. */
export const SUB = 8

/**
 * The flame silhouette across the bar: two slow waves, stable from frame to
 * frame, so the bar reads as tongues of fire rather than random bars.
 */
const shapeAt = (column: number): number =>
  Math.min(1, Math.max(0.3, 0.62 + 0.24 * Math.sin(column * 0.55) + 0.14 * Math.sin(column * 1.7 + 1)))

/** Each lit column's target height in eighths of a row; 0 for unlit columns. Idle still shows low flames. */
export const targetHeights = (columns: number, rows: number, props: FurnaceProps): number[] => {
  const spans = splitColumns(columns, props.fill, props.sources)
  const heights: number[] = []
  props.sources.forEach((source, i) => {
    const span = spans[i] ?? 0
    for (let c = 0; c < span; c += 1) {
      const base = 0.45 + source.heat * 0.55
      heights.push(Math.max(3, Math.round(rows * SUB * base * shapeAt(heights.length))))
    }
  })
  return [...heights, ...Array.from({ length: Math.max(0, columns - heights.length) }, () => 0)]
}

/** Frames between drift beats: at 200 ms a frame, one beat a second. */
export const DRIFT_EVERY = 5
/** On a beat, one column in this many lifts slightly. */
export const DRIFT_SPREAD = 12
/** How far a column moves per frame, and how far a drift lifts it, in eighths. */
const EASE = 2
const LIFT = 3

/**
 * The next frame, gently: each column eases two eighths toward its target.
 * While burning, once a second one column in twelve lifts three eighths.
 * Low flicker by design.
 */
export const stepHeights = (current: readonly number[], target: readonly number[], tick: number, isBurning: boolean): number[] => {
  const isBeat = tick % DRIFT_EVERY === 0
  const beat = Math.floor(tick / DRIFT_EVERY)
  return target.map((t, i) => {
    const drifts = isBurning && isBeat && t > SUB && (i * 5 + beat) % DRIFT_SPREAD === 0
    const goal = drifts ? t + LIFT : t
    const now = current[i] ?? 0
    return now < goal ? Math.min(goal, now + EASE) : now > goal ? Math.max(goal, now - EASE) : now
  })
}

/** Which source owns each column, for colour. */
export const ownerOf = (columns: number, props: FurnaceProps): ('main' | 'agent' | 'none')[] => {
  const spans = splitColumns(columns, props.fill, props.sources)
  const owners = props.sources.flatMap((s, i) => Array.from({ length: spans[i] ?? 0 }, () => s.kind))
  return [...owners, ...Array.from({ length: Math.max(0, columns - owners.length) }, () => 'none' as const)]
}
