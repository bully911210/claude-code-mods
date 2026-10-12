// The telemetry row above the prompt: one line of glyph + value groups, drawn as
// text on every surface (the desktop shows plugin SVG blank, so none is used).
// Pure: data in, tree out. A metric with no real reading is left out, never faked.

import type { Elements } from 'claude-code'

import { pct } from './lib/ledger'

/** Any surface's table: the row needs only Box and Text. */
type Table = Pick<Elements['terminal'], 'Box' | 'Text'>

export type TelemetryData = {
  readonly fivePercent: number
  readonly ratePerMin: number
  readonly resetsAt: string
  readonly now: number
  readonly weekPercent: number
  readonly contextPercent: number | null
  readonly cacheHit: number | null
  readonly model: string
  readonly effort: string
}

type IconKey = 'database' | 'zap' | 'clock' | 'hourglass' | 'chart'

export type Group = {
  readonly key: string
  readonly icon: IconKey
  /** Icon colour: a hex for the desktop's Svg, a theme key for the terminal glyph. */
  readonly iconHex: string
  readonly iconTheme: string
  readonly value: string
  readonly valueColor?: string
  readonly label?: string
  readonly isBold?: boolean
  /** Lower drops first when the line is too narrow. */
  readonly priority: number
}

/** One-cell stand-ins for the terminal, which draws no Svg. */
const GLYPHS: Record<IconKey, string> = { database: '▤', zap: 'ϟ', clock: '◷', hourglass: '⧗', chart: '▥' }

const ORANGE = '#EF9F27'
const MUTED = '#9C9A92'
const BLUE = '#4FA3E0'
const PURPLE = '#9B8CF0'
const GREEN = '#4CB782'

/** `claude-opus-5-5` -> `Opus 5.5`; a name already shown as `/model` shows it stays. */
export const prettyModel = (model: string): string => {
  const m = model.toLowerCase().match(/(fable|mythos|opus|sonnet|haiku)[-\s]?(\d+)(?:[-.](\d+))?/)
  if (!m) return model.replace(/\[.*\]$/, '').trim()
  const family = (m[1] ?? '').charAt(0).toUpperCase() + (m[1] ?? '').slice(1)
  return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`
}

export const prettyEffort = (effort: string): string => (effort ? effort.charAt(0).toUpperCase() + effort.slice(1) : '')

/** `2h 15m`, `45m`. */
export const remaining = (minutes: number): string => {
  const m = Math.max(0, Math.round(minutes))
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

/** `09:00 AM`. */
export const clockTime = (iso: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const h = d.getHours()
  return `${String(h % 12 || 12).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

/** The nine groups in the specified order, each only when its value is real. */
export const buildGroups = (d: TelemetryData): Group[] => {
  const resetMs = d.resetsAt ? Date.parse(d.resetsAt) : NaN
  const groups: (Group | null)[] = [
    d.fivePercent < 0
      ? null
      : { key: 'five', icon: 'database', iconHex: ORANGE, iconTheme: 'warning', value: `${pct(d.fivePercent)}%`, valueColor: 'warning', label: '5h limit', priority: 9 },
    d.fivePercent < 0
      ? null
      : { key: 'rate', icon: 'zap', iconHex: ORANGE, iconTheme: 'warning', value: `+${d.ratePerMin.toFixed(1)}/min`, priority: 4 },
    Number.isNaN(resetMs)
      ? null
      : { key: 'reset', icon: 'clock', iconHex: MUTED, iconTheme: 'subtle', value: clockTime(d.resetsAt), priority: 3 },
    Number.isNaN(resetMs)
      ? null
      : { key: 'left', icon: 'hourglass', iconHex: MUTED, iconTheme: 'subtle', value: remaining((resetMs - d.now) / 60_000), priority: 8 },
    d.weekPercent < 0
      ? null
      : { key: 'week', icon: 'chart', iconHex: BLUE, iconTheme: 'suggestion', value: `${pct(d.weekPercent)}%`, priority: 7 },
    d.contextPercent === null
      ? null
      : { key: 'ctx', icon: 'database', iconHex: PURPLE, iconTheme: 'merged', value: `${d.contextPercent}%`, priority: 6 },
    d.cacheHit === null
      ? null
      : { key: 'cache', icon: 'database', iconHex: GREEN, iconTheme: 'success', value: `${d.cacheHit}%`, priority: 5 },
    d.model ? { key: 'model', icon: 'database', iconHex: '', iconTheme: '', value: prettyModel(d.model), isBold: true, priority: 2 } : null,
    d.effort ? { key: 'effort', icon: 'database', iconHex: '', iconTheme: '', value: prettyEffort(d.effort), priority: 1 } : null,
  ]
  return groups.filter((g): g is Group => g !== null)
}

const hasIcon = (g: Group): boolean => g.iconHex !== ''

/** Cells one group takes: icon and space, value, label. */
const widthOf = (g: Group): number => (hasIcon(g) ? 2 : 0) + g.value.length + (g.label ? g.label.length + 1 : 0)

/** Cells between groups: a space, the divider, a space; tighter when room is short. */
const SEP_WIDE = 5
const SEP_TIGHT = 3

/**
 * Keeps the row on one line: first tightens the dividers, then drops the
 * lowest-priority groups until it fits. Order is kept; nothing scrolls.
 */
export const fitGroups = (groups: readonly Group[], columns: number): { groups: Group[]; sep: number } => {
  const total = (gs: readonly Group[], sep: number): number => gs.reduce((s, g) => s + widthOf(g), 0) + Math.max(0, gs.length - 1) * sep
  if (total(groups, SEP_WIDE) <= columns) return { groups: [...groups], sep: SEP_WIDE }
  let kept = [...groups]
  while (kept.length > 1 && total(kept, SEP_TIGHT) > columns) {
    const lowest = kept.reduce((a, b) => (b.priority < a.priority ? b : a))
    kept = kept.filter(g => g !== lowest)
  }
  return { groups: kept, sep: SEP_TIGHT }
}

export const telemetryTree = (els: Table, d: TelemetryData, columns: number) => {
  const { Box, Text } = els
  const { groups, sep } = fitGroups(buildGroups(d), columns)
  const pad = sep === SEP_WIDE ? 2 : 1
  return (
    <Box flexDirection="row" alignItems="center" flexWrap="nowrap" overflow="hidden">
      {groups.flatMap((g, i) => {
        const parts = [
          <Box key={`g-${g.key}`} flexDirection="row" alignItems="center" flexShrink={0}>
            {hasIcon(g) ? (
              <Text key={`i-${g.key}`} color={g.iconTheme}>
                {GLYPHS[g.icon]}
              </Text>
            ) : null}
            <Text key={`v-${g.key}`} {...(g.valueColor ? { color: g.valueColor } : { color: 'text' })} bold={g.isBold === true}>
              {hasIcon(g) ? ' ' : ''}
              {g.value}
            </Text>
            {g.label ? (
              <Text key={`l-${g.key}`} color="inactive">
                {' '}
                {g.label}
              </Text>
            ) : null}
          </Box>,
        ]
        if (i < groups.length - 1) {
          parts.push(
            <Text key={`s-${g.key}`} color="subtle" dimColor>
              {' '.repeat(pad)}│{' '.repeat(pad)}
            </Text>,
          )
        }
        return parts
      })}
    </Box>
  )
}
