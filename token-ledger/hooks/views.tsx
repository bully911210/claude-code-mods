// Pure drawings for the /ledger pane: element tables and data in, a tree
// out. No engine calls here; the hooks module gathers the data. Everything
// is shown as limit percentages and tokens, never money.

import type { Elements } from 'claude-code'

import type { LedgerAgent, LedgerDay, LedgerMiss, LedgerSession, LedgerTurn } from '../types'
import { isDone, liveCost } from './lib/agents'
import { cacheHitPercent, compact, pct } from './lib/ledger'
import { shortModel } from './lib/prices'

type Table = Elements['terminal']


export type PaneData = {
  readonly session: LedgerSession
  readonly week: LedgerDay
  readonly misses: readonly LedgerMiss[]
  readonly recent: readonly LedgerTurn[]
  readonly agents: readonly LedgerAgent[]
  readonly ctx: number
  readonly five: number
  readonly weekPercent: number
  readonly resetsLabel: string
  readonly rows: number
  readonly now: number
}

const ago = (now: number, at: number): string => {
  const m = Math.round((now - at) / 60_000)
  return m < 1 ? 'now' : `${m}m`
}

const tokensOf = (u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number =>
  u.input + u.output + u.cacheRead + u.cacheWrite

export const paneTree = (els: Pick<Table, 'Box' | 'Text'>, d: PaneData) => {
  const { Box, Text } = els
  const s = d.session
  const hit = cacheHitPercent(s.usage)
  const agentTotal = d.agents.reduce((sum, a) => sum + liveCost(a), 0)
  const sessionTotal = Math.max(0.000001, s.costUsd + d.agents.reduce((sum, a) => sum + a.pendingUsd, 0))
  const shareOf = (a: LedgerAgent): string => `${Math.round((liveCost(a) / sessionTotal) * 100)}%`
  const room = Math.max(3, d.rows - 24)
  return (
    <Box flexDirection="column">
      <Text bold>Limits</Text>
      <Text>
        5-hour {d.five < 0 ? 'no reading' : `${pct(d.five)}%`}
        {d.resetsLabel ? ` · resets ${d.resetsLabel}` : ''} · week {d.weekPercent < 0 ? 'no reading' : `${pct(d.weekPercent)}%`} · context {d.ctx}%
      </Text>
      <Text> </Text>
      <Text bold>This session</Text>
      <Text>
        {s.turns} turns · {compact(tokensOf(s.usage))} tokens · cache hit {hit === null ? 'n/a' : `${hit}%`}
      </Text>
      <Text dimColor>
        in {compact(s.usage.input)} · out {compact(s.usage.output)} · cache read {compact(s.usage.cacheRead)} · cache write{' '}
        {compact(s.usage.cacheWrite)}
      </Text>
      <Text> </Text>
      <Text bold>Subagents</Text>
      <Text>
        {d.agents.length} this session · about {Math.round((agentTotal / sessionTotal) * 100)}% of the session's usage
      </Text>
      {[...d.agents]
        .sort((x, y) => liveCost(y) - liveCost(x))
        .slice(0, 5)
        .map(a => (
          <Text key={`agent-${a.id}`} {...(isDone(a.status) ? { dimColor: true } : { color: '#378ADD' })}>
            {isDone(a.status) ? '✓' : '▶'} {a.type} · {a.description || a.id.slice(0, 8)} · {shortModel(a.model)} · {a.calls} calls ·{' '}
            {compact(tokensOf(a.usage))} tokens · {shareOf(a)} · {isDone(a.status) ? `done ${ago(d.now, a.endedAt ?? d.now)}` : a.tool || 'thinking'}
          </Text>
        ))}
      <Text> </Text>
      <Text bold>Last 7 days</Text>
      <Text>
        {d.week.turns} turns · {compact(tokensOf(d.week.usage))} tokens
      </Text>
      <Text> </Text>
      <Text bold>Cache rewrites after idle</Text>
      <Text>
        {d.misses.length} this session · {d.week.misses} in 7 days
      </Text>
      {d.misses.slice(-3).map(x => (
        <Text key={`miss-${x.at}`} dimColor>
          {new Date(x.at).toLocaleTimeString()} · idle {x.gapMinutes} min ({x.ttl}) · {compact(x.tokensRewritten)} tokens rewritten
        </Text>
      ))}
      <Text> </Text>
      <Text bold>Recent turns</Text>
      {d.recent.length === 0 && <Text dimColor>No turns yet.</Text>}
      {d.recent.slice(-room).map(t => (
        <Text key={`turn-${t.at}`} dimColor>
          {new Date(t.at).toLocaleTimeString()} · in {compact(t.usage.input + t.usage.cacheRead + t.usage.cacheWrite)} · out{' '}
          {compact(t.usage.output)} · {Math.round(t.durationMs / 1000)}s
        </Text>
      ))}
    </Box>
  )
}
