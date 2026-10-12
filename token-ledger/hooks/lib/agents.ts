// Pure subagent bookkeeping: every function returns new values.

import type { LedgerAgent, LedgerUsage } from '../../types'
import { addUsage, EMPTY_USAGE } from './ledger'

export const AGENTS_KEEP = 40
/** How long a finished agent stays in the lanes. */
export const LANE_LINGER_MS = 10 * 60_000

const DONE = new Set(['completed', 'failed', 'killed'])
export const isDone = (status: string): boolean => DONE.has(status)

export const newAgent = (id: string, at: number): LedgerAgent => ({
  id,
  type: 'agent',
  description: '',
  model: '',
  status: 'running',
  calls: 0,
  usage: EMPTY_USAGE,
  pendingUsd: 0,
  costUsd: 0,
  tool: '',
  startedAt: at,
  isAlerted: false,
})

const upsert = (agents: readonly LedgerAgent[], id: string, at: number, fn: (a: LedgerAgent) => LedgerAgent): LedgerAgent[] => {
  const found = agents.find(a => a.id === id)
  const next = fn(found ?? newAgent(id, at))
  const rest = found ? agents.map(a => (a.id === id ? next : a)) : [...agents, next]
  return rest.slice(-AGENTS_KEEP)
}

/** One model call made inside an agent's loop. */
export const addStep = (
  agents: readonly LedgerAgent[],
  step: { readonly id: string; readonly model: string; readonly usage: LedgerUsage; readonly estUsd: number; readonly at: number },
): LedgerAgent[] =>
  upsert(agents, step.id, step.at, a => ({
    ...a,
    model: step.model,
    calls: a.calls + 1,
    usage: addUsage(a.usage, step.usage),
    pendingUsd: a.pendingUsd + step.estUsd,
    status: isDone(a.status) ? a.status : 'running',
  }))

export const setTool = (agents: readonly LedgerAgent[], id: string, tool: string, at: number): LedgerAgent[] =>
  upsert(agents, id, at, a => ({ ...a, tool }))

type Listed = { readonly id: string; readonly type: string; readonly description: string; readonly status: string; readonly parentId?: string }

/** Folds in the engine's agent list: names, types, statuses, and when each one ended. */
export const mergeListed = (agents: readonly LedgerAgent[], listed: readonly Listed[], at: number): LedgerAgent[] =>
  listed.reduce<LedgerAgent[]>(
    (acc, l) =>
      upsert(acc, l.id, at, a => ({
        ...a,
        type: l.type,
        description: l.description,
        status: l.status,
        ...(l.parentId ? { parentId: l.parentId } : {}),
        ...(isDone(l.status) && a.endedAt === undefined ? { endedAt: at, tool: '' } : {}),
      })),
    [...agents],
  )

/**
 * Splits the engine's real cost for the last stretch across the main loop and
 * each agent, in proportion to their price-table estimates. With no estimate
 * at all, the main loop takes the whole of it.
 */
export const reconcile = (
  agents: readonly LedgerAgent[],
  mainPendingUsd: number,
  realUsd: number,
): { readonly agents: LedgerAgent[]; readonly mainUsd: number; readonly agentUsd: number } => {
  const estimated = mainPendingUsd + agents.reduce((s, a) => s + a.pendingUsd, 0)
  if (estimated <= 0) return { agents: [...agents], mainUsd: realUsd, agentUsd: 0 }
  const factor = realUsd / estimated
  const scaled = agents.map(a => ({ ...a, costUsd: a.costUsd + a.pendingUsd * factor, pendingUsd: 0 }))
  const agentUsd = agents.reduce((s, a) => s + a.pendingUsd * factor, 0)
  return { agents: scaled, mainUsd: realUsd - agentUsd, agentUsd }
}

/** An agent's cost as shown now: settled cost plus its unsettled estimate. */
export const liveCost = (a: LedgerAgent): number => a.costUsd + a.pendingUsd

/** Agents for the lanes: running ones, then recently finished, most expensive first. */
export const laneAgents = (agents: readonly LedgerAgent[], now: number, max: number): LedgerAgent[] =>
  agents
    .filter(a => !isDone(a.status) || now - (a.endedAt ?? now) <= LANE_LINGER_MS)
    .sort((x, y) => Number(isDone(x.status)) - Number(isDone(y.status)) || liveCost(y) - liveCost(x))
    .slice(0, max)

/**
 * Points of the 5-hour limit an agent has used, roughly: its share of the
 * session's usage times the points the session has used since it started.
 */
export const agentPoints = (a: LedgerAgent, sessionTotal: number, pointsUsed: number): number =>
  sessionTotal > 0 ? (liveCost(a) / sessionTotal) * pointsUsed : 0

/** Agents that just crossed the alert line, in points of the 5-hour limit, and have not been alerted. */
export const crossedAlert = (
  agents: readonly LedgerAgent[],
  sessionTotal: number,
  pointsUsed: number,
  alertPoints: number,
): LedgerAgent[] =>
  alertPoints > 0 ? agents.filter(a => !a.isAlerted && agentPoints(a, sessionTotal, pointsUsed) >= alertPoints) : []
