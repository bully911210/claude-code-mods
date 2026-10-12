// Pure ledger arithmetic: no engine calls, every function returns new values.

import type { LedgerDay, LedgerMiss, LedgerSession, LedgerUsage } from '../../types'

export const FIVE_MIN = 5 * 60_000
export const ONE_HOUR = 60 * 60_000
/** Below this many rewritten tokens a cache miss is noise, not a cost. */
export const MISS_MIN_TOKENS = 10_000

export const EMPTY_USAGE: LedgerUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
export const EMPTY_DAY: LedgerDay = { costUsd: 0, turns: 0, usage: EMPTY_USAGE, misses: 0, missCostUsd: 0, agentUsd: 0 }
export const EMPTY_SESSION: LedgerSession = { costUsd: 0, turns: 0, usage: EMPTY_USAGE }

type ApiUsage = {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens: number
  readonly cache_creation_input_tokens: number
}

export const fromApi = (u: ApiUsage): LedgerUsage => ({
  input: u.input_tokens,
  output: u.output_tokens,
  cacheRead: u.cache_read_input_tokens,
  cacheWrite: u.cache_creation_input_tokens,
})

export const addUsage = (a: LedgerUsage, b: LedgerUsage): LedgerUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

/** Share of input tokens the cache served, 0-100; null with no input yet. */
export const cacheHitPercent = (u: LedgerUsage): number | null => {
  const totalIn = u.input + u.cacheRead + u.cacheWrite
  return totalIn === 0 ? null : Math.round((u.cacheRead / totalIn) * 100)
}

/**
 * A turn after an idle gap that wrote far more cache than it read: the
 * prefix expired and was billed again at the cache-write price.
 */
export const detectMiss = (args: {
  readonly gapMs: number
  readonly usage: LedgerUsage
  readonly costUsd: number
  readonly at: number
}): LedgerMiss | null => {
  const { gapMs, usage, costUsd, at } = args
  const isIdle = gapMs >= FIVE_MIN
  const isRewrite = usage.cacheWrite >= MISS_MIN_TOKENS && usage.cacheWrite > usage.cacheRead * 2
  if (!isIdle || !isRewrite) return null
  return {
    at,
    gapMinutes: Math.round(gapMs / 60_000),
    ttl: gapMs >= ONE_HOUR ? '1h' : '5m',
    tokensRewritten: usage.cacheWrite,
    costUsd,
  }
}

export const addToDay = (
  day: LedgerDay,
  turn: { readonly costUsd: number; readonly usage: LedgerUsage; readonly miss: LedgerMiss | null; readonly agentUsd?: number },
): LedgerDay => ({
  costUsd: day.costUsd + turn.costUsd,
  turns: day.turns + 1,
  usage: addUsage(day.usage, turn.usage),
  misses: day.misses + (turn.miss ? 1 : 0),
  missCostUsd: day.missCostUsd + (turn.miss?.costUsd ?? 0),
  agentUsd: day.agentUsd + (turn.agentUsd ?? 0),
})

export const sumDays = (days: readonly LedgerDay[]): LedgerDay =>
  days.reduce<LedgerDay>(
    (acc, d) => ({
      costUsd: acc.costUsd + d.costUsd,
      turns: acc.turns + d.turns,
      usage: addUsage(acc.usage, d.usage),
      misses: acc.misses + d.misses,
      missCostUsd: acc.missCostUsd + d.missCostUsd,
      agentUsd: acc.agentUsd + d.agentUsd,
    }),
    EMPTY_DAY,
  )

const pad = (n: number): string => String(n).padStart(2, '0')

/** The machine's local date, `YYYY-MM-DD`. */
export const dayKey = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Store keys of the last `n` days, today first. */
export const lastDayKeys = (ms: number, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `day:${dayKey(ms - i * 24 * ONE_HOUR)}`)

/**
 * This session's own key for a day. Each session writes only its own, so
 * parallel sessions never overwrite each other; readers sum every key of the day.
 */
export const sessionDayKey = (ms: number, sessionId: string): string => `day:${dayKey(ms)}:${sessionId}`

/** Every stored key belonging to the day `dayStoreKey` names (`day:YYYY-MM-DD`). */
export const keysOfDay = (allKeys: readonly string[], dayStoreKey: string): string[] =>
  allKeys.filter(k => k === dayStoreKey || k.startsWith(`${dayStoreKey}:`))

/** A stored value read back as a day, whatever shape an older version left. */
export const asDay = (value: unknown): LedgerDay => {
  if (typeof value !== 'object' || value === null) return EMPTY_DAY
  const v = value as Partial<LedgerDay>
  const u = (v.usage ?? {}) as Partial<LedgerUsage>
  const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  return {
    costUsd: num(v.costUsd),
    turns: num(v.turns),
    usage: { input: num(u.input), output: num(u.output), cacheRead: num(u.cacheRead), cacheWrite: num(u.cacheWrite) },
    misses: num(v.misses),
    missCostUsd: num(v.missCostUsd),
    agentUsd: num(v.agentUsd),
  }
}

export const money = (usd: number, zarPerUsd: number): string =>
  zarPerUsd > 0 ? `R${(usd * zarPerUsd).toFixed(2)}` : `$${usd.toFixed(2)}`

export const compact = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** `45m`, `2h05`. */
export const duration = (minutes: number): string =>
  minutes < 60 ? `${Math.max(0, Math.round(minutes))}m` : `${Math.floor(minutes / 60)}h${String(Math.round(minutes % 60)).padStart(2, '0')}`

/** A whole percentage, or one decimal under 10 so small moves still show. */
export const pct = (n: number): string => (n < 10 && n % 1 !== 0 ? n.toFixed(1) : String(Math.round(n)))

/** The status-bar entry: the ember strip, then limits, agents, context and cache. */
export const statusLine = (args: {
  readonly strip: string
  readonly fivePercent: number
  readonly weekPercent: number
  readonly toLimitMinutes: number | null
  readonly running: number
  readonly agentShare: number
  readonly contextPercent: number
  readonly cacheHit: number | null
}): string => {
  const a = args
  const limit = a.fivePercent < 0 ? 'no limit reading' : `5h ${pct(a.fivePercent)}%`
  return [
    `${a.strip} ${limit}`,
    a.toLimitMinutes === null ? null : `limit in ~${duration(a.toLimitMinutes)}`,
    a.weekPercent < 0 ? null : `week ${pct(a.weekPercent)}%`,
    a.running > 0 ? `${a.running} agent${a.running === 1 ? '' : 's'} ${Math.round(a.agentShare * 100)}%` : null,
    `ctx ${a.contextPercent}%`,
    a.cacheHit === null ? null : `cache ${a.cacheHit}%`,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The status-bar entry: only what needs attention, '' when nothing does. */
export const alertLine = (args: {
  readonly toLimitMinutes: number | null
  readonly running: number
  readonly agentShare: number
}): string =>
  [
    args.toLimitMinutes === null ? null : `5h limit in ~${duration(args.toLimitMinutes)}`,
    args.running > 0 ? `${args.running} agent${args.running === 1 ? '' : 's'} running · ${Math.round(args.agentShare * 100)}%` : null,
  ]
    .filter(Boolean)
    .join(' · ')
