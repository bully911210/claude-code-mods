import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LedgerAgent, LedgerDay, LedgerMiss, LedgerSample, LedgerSession, LedgerTurn } from '../types'
import { addStep, agentPoints, crossedAlert, isDone, laneAgents, liveCost, mergeListed, reconcile, setTool } from './lib/agents'
import { burnRate, heatOf, minutesToLimit, SAMPLES_KEEP, stageOf } from './lib/furnace'
import type { FurnaceProps, FurnaceSource } from './lib/furnace'
import {
  addToDay,
  addUsage,
  asDay,
  cacheHitPercent,
  compact,
  detectMiss,
  EMPTY_DAY,
  EMPTY_SESSION,
  fromApi,
  keysOfDay,
  lastDayKeys,
  pct,
  sessionDayKey,
  sumDays,
} from './lib/ledger'
import { estimateUsd } from './lib/prices'
import { askButton, insightsPane } from './insightsView'
import { buildPrompt, fillPlan, INSIGHT_MODEL, parseInsights, SYSTEM as INSIGHT_SYSTEM } from './lib/insights'
import type { InsightContext } from './lib/insights'
import { telemetryTree } from './telemetry'
import { pickSignals } from './lib/memory'
import type { Signal } from './lib/memory'
import { foldAfterTurn, memoryBlock, memoryHandlers, MEMORY_PANE, noteUserPrompt, recordSignals, refreshMemoryView, runBriefCommand } from './memoryEngine'
import { memoryPane } from './memoryView'
import { paneTree } from './views'

const PANE = 'ledger'
const INSIGHTS_PANE = 'insights'
const RECENT_KEEP = 30
const MISSES_KEEP = 50
const LANES_MAX = 4
/** While a subagent runs, its status is refreshed this often; with none running, nothing polls. */
const AGENT_POLL_MS = 3_000

const sessionAtom = atom({ plugin: 'token-ledger', key: 'session' } as const, EMPTY_SESSION as LedgerSession)
const recentAtom = atom({ plugin: 'token-ledger', key: 'recent' } as const, [] as LedgerTurn[])
const missesAtom = atom({ plugin: 'token-ledger', key: 'misses' } as const, [] as LedgerMiss[])
const todayAtom = atom({ plugin: 'token-ledger', key: 'today' } as const, EMPTY_DAY as LedgerDay)
const weekAtom = atom({ plugin: 'token-ledger', key: 'week' } as const, EMPTY_DAY as LedgerDay)
const lastEndAtom = atom({ plugin: 'token-ledger', key: 'lastEndAt' } as const, 0)
const lastCostAtom = atom({ plugin: 'token-ledger', key: 'lastCostUsd' } as const, -1)
const contextAtom = atom({ plugin: 'token-ledger', key: 'contextPercent' } as const, 0)
const fiveHourAtom = atom({ plugin: 'token-ledger', key: 'fiveHourPercent' } as const, -1)
const weekPercentAtom = atom({ plugin: 'token-ledger', key: 'weekPercent' } as const, -1)
const resetsAtAtom = atom({ plugin: 'token-ledger', key: 'fiveHourResetsAt' } as const, '')
const startPercentAtom = atom({ plugin: 'token-ledger', key: 'startPercent' } as const, -1)
const agentsAtom = atom({ plugin: 'token-ledger', key: 'agents' } as const, [] as LedgerAgent[])
const mainPendingAtom = atom({ plugin: 'token-ledger', key: 'mainPendingUsd' } as const, 0)
const samplesAtom = atom({ plugin: 'token-ledger', key: 'samples' } as const, [] as LedgerSample[])
const effortAtom = atom({ plugin: 'token-ledger', key: 'effort' } as const, '')
const memoryAtom = atom(
  { plugin: 'token-ledger', key: 'memory' } as const,
  { projectName: '', brief: '', profile: '', signals: [] as Signal[], folds: 0, updatedAt: 0 },
)
const insightsAtom = atom({ plugin: 'token-ledger', key: 'insights' } as const, {
  status: 'idle' as 'idle' | 'loading' | 'ready' | 'empty' | 'error',
  items: [] as { title: string; question: string }[],
  /** Indexes ticked for insertion, in the order they were ticked. */
  picked: [] as number[],
  /** True when the pane could not be placed and the questions fall back into the band. */
  inBand: false,
  error: '',
  insertError: '',
})

type Config = {
  readonly alertPoints: number
  readonly isMissToastOn: boolean
}

const configOf = (options: Readonly<Record<string, unknown>>): Config => ({
  alertPoints: typeof options.agentAlertPercent === 'number' && options.agentAlertPercent >= 0 ? options.agentAlertPercent : 10,
  isMissToastOn: options.toastOnCacheMiss !== false,
})

type Figures = { costUsd: number; context: number; five: number; week: number; resetsAt: string }

async function readEngineFigures($: EngineInterface): Promise<Figures> {
  const usage = await $.session.usage()
  const five = usage.rateLimits.find(r => r.kind === 'five_hour')
  const week = usage.rateLimits.find(r => r.kind === 'seven_day')
  return {
    costUsd: usage.cost?.usd ?? 0,
    context: usage.context.percent ?? 0,
    five: five ? five.percentUsed : -1,
    week: week ? week.percentUsed : -1,
    resetsAt: five?.resetsAt ?? '',
  }
}

/** Keeps the limit readings, and a sample for the burn rate. A drop in the 5-hour figure is a reset. */
async function recordLimits($: EngineInterface, f: Figures, now: number): Promise<void> {
  await update($, contextAtom, () => f.context)
  await update($, weekPercentAtom, () => f.week)
  await update($, resetsAtAtom, () => f.resetsAt)
  if (f.five < 0) return
  const before = await read($, fiveHourAtom)
  await update($, fiveHourAtom, () => f.five)
  const start = await read($, startPercentAtom)
  if (start < 0 || f.five < start) await update($, startPercentAtom, () => f.five)
  if (before >= 0 && f.five < before) await update($, samplesAtom, () => [])
  await update($, samplesAtom, list => [...list, { at: now, percent: f.five }].slice(-SAMPLES_KEEP))
}

async function refreshRollups($: EngineInterface, now: number): Promise<void> {
  const all = await $.store.keys()
  const days = await Promise.all(
    lastDayKeys(now, 7).map(async dk => sumDays(await Promise.all(keysOfDay(all, dk).map(async k => asDay(await $.store.get(k)))))),
  )
  await update($, todayAtom, () => days[0] ?? EMPTY_DAY)
  await update($, weekAtom, () => sumDays(days))
}

type Furnace = {
  readonly props: FurnaceProps
  readonly five: number
  readonly week: number
  readonly resetsAt: string
  readonly rate: number
  readonly toLimit: number | null
  readonly running: number
  readonly agentShare: number
  readonly agents: readonly LedgerAgent[]
  readonly sessionTotal: number
}

/** Everything the strip, the band and the alerts read: the 5-hour limit as fire, agents in blue. */
async function furnaceNow($: EngineInterface, cfg: Config, now: number): Promise<Furnace> {
  const five = await read($, fiveHourAtom)
  const resetsAt = await read($, resetsAtAtom)
  const agents = await read($, agentsAtom)
  const rate = burnRate(await read($, samplesAtom), now)
  const heat = heatOf(rate)
  const minutesToReset = resetsAt ? Math.max(0, (Date.parse(resetsAt) - now) / 60_000) : null
  const sessionTotal =
    (await read($, sessionAtom)).costUsd + (await read($, mainPendingAtom)) + agents.reduce((s, a) => s + a.pendingUsd, 0)
  const total = Math.max(0.000001, sessionTotal)
  const agentShare = Math.min(1, agents.reduce((s, a) => s + liveCost(a), 0) / total)
  const lanes = laneAgents(agents, now, LANES_MAX)
  const sources: FurnaceSource[] = [
    { key: 'main', kind: 'main', share: 1 - agentShare, heat },
    ...lanes.map(a => ({ key: a.id, kind: 'agent' as const, share: liveCost(a) / total, heat: isDone(a.status) ? 0 : heat })),
  ]
  const fill = five < 0 ? 0 : five / 100
  return {
    props: { fill, stage: stageOf(fill), sources, animate: false },
    five,
    week: await read($, weekPercentAtom),
    resetsAt,
    rate,
    toLimit: five < 0 ? null : minutesToLimit(five, rate, minutesToReset),
    running: agents.filter(a => !isDone(a.status)).length,
    agentShare,
    agents,
    sessionTotal: total,
  }
}

// The last status text sent, so an unchanged line is never re-sent.
let lastStatus = ''

// The agent-list poll, alive only while some subagent is running.
let agentPoll: { cancel: () => void } | undefined

/** Starts polling the agent list if it isn't already; the poll stops itself once no agent runs. */
function ensureAgentPolling($: EngineInterface, cfg: Config): void {
  if (agentPoll) return
  agentPoll = $.clock.every(AGENT_POLL_MS, () => {
    void (async () => {
      await syncAgents($, cfg)
      const agents = await read($, agentsAtom)
      if (!agents.some(a => !isDone(a.status))) {
        agentPoll?.cancel()
        agentPoll = undefined
      }
    })().catch(() => undefined)
  })
}

async function showStatus($: EngineInterface, cfg: Config): Promise<void> {
  // The row above the prompt carries every figure, so the status bar shows nothing.
  if (lastStatus === 'cleared') return
  lastStatus = 'cleared'
  $.ui.status(undefined)
}

/** Runs git in the project and returns its output, or '' when git or the repo isn't there. */
async function gitOut($: EngineInterface, root: string, args: readonly string[]): Promise<string> {
  const r = await $.process.run(['git', ...args], { cwd: root, timeoutMs: 10_000 }).catch(() => null)
  return r && r.exitCode === 0 ? r.stdout.trim() : ''
}

/** Everything Haiku may read: the project, Claude's visible reasoning, and the chat so far. */
async function gatherInsightContext($: EngineInterface): Promise<InsightContext> {
  const root = await $.session.root()
  const name = root.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? root
  const [branch, gitStatus, recentCommits] = await Promise.all([
    gitOut($, root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitOut($, root, ['status', '--short']),
    gitOut($, root, ['log', '--oneline', '-8']),
  ])
  const ancestors = await $.fs.ancestors({ names: ['CLAUDE.md'] }).catch(() => [])
  const rows = await $.session.messages()
  const api = await $.session.messages({ as: 'api' })
  const messages = 'deny' in rows ? [] : rows.map(m => ({ role: m.role, text: m.text, tools: m.toolUses.map(t => t.tool) }))
  const thinking =
    'deny' in api
      ? []
      : api.flatMap(m => m.content.filter(b => b.type === 'thinking' && typeof b.thinking === 'string').map(b => String(b.thinking)))
  const memory = await memoryBlock($).catch(() => ({ text: '', hasBrief: false }))
  return {
    project: { name, branch, gitStatus, recentCommits, docs: ancestors.slice(-2).map(a => ({ path: `${a.dir}/${a.name}`, text: a.content })) },
    messages,
    thinking,
    memory: memory.text,
    memoryHasBrief: memory.hasBrief,
  }
}

// Claimed synchronously before any await, so two quick clicks can't both start a request.
let isInsightRunning = false
// Each request and each close takes a new number; a reply only lands if its number is still current.
let insightTicket = 0

/** One Haiku request for five questions; a second press while it runs does nothing. */
async function runInsights($: EngineInterface): Promise<void> {
  if (isInsightRunning) return
  isInsightRunning = true
  try {
    await generateInsights($)
  } catch {
    // The state write itself failed; nothing more to show.
  } finally {
    isInsightRunning = false
  }
}

async function generateInsights($: EngineInterface): Promise<void> {
  insightTicket += 1
  const ticket = insightTicket
  const land = (next: (s: Awaited<ReturnType<typeof readInsights>>) => Awaited<ReturnType<typeof readInsights>>) =>
    ticket === insightTicket ? update($, insightsAtom, next) : Promise.resolve()
  // The questions live in their own pane, so the telemetry bar above the prompt
  // never moves or scrolls with them. A terminal too narrow for a pane is the one
  // case they fall back into the band.
  const opened = await $.ui.open({ id: INSIGHTS_PANE, title: 'Questions worth asking' }).catch(() => ({ isPlaced: false }))
  await update($, insightsAtom, () => ({
    status: 'loading' as const,
    items: [],
    picked: [],
    inBand: !opened.isPlaced,
    error: '',
    insertError: '',
  }))
  try {
    const context = await gatherInsightContext($)
    const reply = await $.model.complete({
      model: INSIGHT_MODEL,
      system: INSIGHT_SYSTEM,
      prompt: buildPrompt(context),
      maxTokens: 2_000,
      effort: 'medium',
      timeoutMs: 90_000,
    })
    if (!reply.isAnswered) {
      const why = reply.reason === 'api-error' ? 'the API returned an error' : reply.reason.replace('-', ' ')
      await land(s => ({ ...s, status: 'error' as const, error: why }))
      return
    }
    const items = parseInsights(reply.text)
    await land(s => ({ ...s, status: items.length ? ('ready' as const) : ('empty' as const), items, picked: [] }))
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    await land(s => ({ ...s, status: 'error' as const, error: why }))
  }
}

const readInsights = ($: EngineInterface) => read($, insightsAtom)

/** Folds the questions away; a reply still on its way is dropped. The bar is untouched: it never held them. */
async function closeInsights($: EngineInterface): Promise<void> {
  insightTicket += 1
  await update($, insightsAtom, () => ({ status: 'idle' as const, items: [], picked: [], inBand: false, error: '', insertError: '' }))
  await $.ui.close({ id: INSIGHTS_PANE }).catch(() => undefined)
}

/** Ticks a question on or off. Any number may be ticked before they go in together. */
async function toggleInsight($: EngineInterface, index: number): Promise<void> {
  await update($, insightsAtom, s => ({
    ...s,
    insertError: '',
    picked: s.picked.includes(index) ? s.picked.filter(i => i !== index) : [...s.picked, index],
  }))
}

/** Ticks every question (or unticks all when every one is ticked), keeping the order of any already ticked first. */
async function pickAllInsights($: EngineInterface, isOn: boolean): Promise<void> {
  await update($, insightsAtom, s => ({
    ...s,
    insertError: '',
    picked: isOn ? [...s.picked, ...s.items.map((_, i) => i).filter(i => !s.picked.includes(i))] : [],
  }))
}

/** The pane's handlers, shared by the pane and the narrow-terminal band fallback. */
const insightHandlers = ($: EngineInterface) => ({
  toggle: (i: number) => {
    void toggleInsight($, i)
  },
  all: (isOn: boolean) => {
    void pickAllInsights($, isOn)
  },
  insert: () => {
    void insertInsights($)
  },
  retry: () => {
    void runInsights($)
  },
  close: () => {
    void dismissInsights($)
  },
})

/** Puts every ticked question in the prompt box without sending it, keeping any text already there. */
async function insertInsights($: EngineInterface): Promise<void> {
  const state = await read($, insightsAtom)
  const questions = state.picked.map(i => state.items[i]?.question ?? '').filter(q => q !== '')
  if (questions.length === 0) return
  let filled: Awaited<ReturnType<typeof $.prompt.fill>>
  try {
    const box = await $.prompt.read()
    const plan = fillPlan(box.text, questions)
    filled = await $.prompt.fill({ text: plan.text, mode: plan.mode })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    await update($, insightsAtom, s => ({ ...s, insertError: `Not inserted: ${why}.` }))
    return
  }
  if (!filled.isFilled) {
    const why = filled.refusal === 'dialog' ? 'a dialog is holding the prompt; close it and pick again' : 'the prompt box could not take the text'
    await update($, insightsAtom, s => ({ ...s, insertError: `Not inserted: ${why}.` }))
    return
  }
  // Which suggestions the user took and which they left is the best feedback there is.
  await recordSignals($, pickSignals(state.items, state.picked, await $.clock.now())).catch(() => undefined)
  await closeInsights($)
}

/** The Close button: questions left unused count as skipped. */
async function dismissInsights($: EngineInterface): Promise<void> {
  const state = await read($, insightsAtom)
  if (state.status === 'ready' && state.items.length > 0) {
    await recordSignals($, pickSignals(state.items, [], await $.clock.now())).catch(() => undefined)
  }
  await closeInsights($)
}

/** Folds in the engine's agent list, and toasts once for any agent past the alert line. */
async function syncAgents($: EngineInterface, cfg: Config): Promise<void> {
  const now = await $.clock.now()
  const listed = await $.agent.list()
  await update($, agentsAtom, agents => mergeListed(agents, listed, now))
  const f = await furnaceNow($, cfg, now)
  const pointsUsed = Math.max(0, f.five - (await read($, startPercentAtom)))
  const crossed = crossedAlert(f.agents, f.sessionTotal, pointsUsed, cfg.alertPoints)
  if (crossed.length === 0) return
  const ids = new Set(crossed.map(a => a.id))
  await update($, agentsAtom, agents => agents.map(a => (ids.has(a.id) ? { ...a, isAlerted: true } : a)))
  for (const a of crossed) {
    const points = Math.round(agentPoints(a, f.sessionTotal, pointsUsed))
    $.ui.toast(`Subagent "${a.description || a.type}" has used about ${points}% of your 5-hour limit.`, { timeoutMs: 8000 })
  }
}

export const register: Register = (on, options) => {
  const cfg = configOf(options)

  on('session.start', async ($, e, next) => {
    // Each step stands alone: one failing (a command name taken, a store hiccup) never stops the rest or the session.
    const step = (work: () => Promise<unknown>) => work().catch(() => undefined)
    await step(() => $.command.register({ name: 'ledger', description: 'Token ledger: limits, subagents, cache hits and cache rewrites' }))
    await step(() => $.command.register({ name: 'brief', description: 'See and correct what the mod knows about you and this project' }))
    await step(() => refreshMemoryView($))
    await step(() => $.command.register({ name: 'ask', description: 'Ask Haiku for five questions worth asking this conversation next' }))
    // A request cut off by a reload or restart must not leave the "?" stuck on "…".
    await step(async () => {
      if ((await read($, insightsAtom)).status === 'loading') await closeInsights($)
    })
    await step(async () => {
      const figures = await readEngineFigures($)
      // A resumed session already used something; count turns from here on.
      if ((await read($, lastCostAtom)) < 0) await update($, lastCostAtom, () => figures.costUsd)
      // A resumed session's first turn is the classic cache rewrite: keep the gap.
      if ((await read($, lastEndAtom)) === 0) {
        const stored = await $.store.get(`lastEnd:${await $.session.id()}`)
        if (typeof stored === 'number') await update($, lastEndAtom, () => stored)
      }
      await recordLimits($, figures, await $.clock.now())
    })
    await step(async () => refreshRollups($, await $.clock.now()))
    await step(() => showStatus($, cfg))
    // No timer here: the agent list is polled only while a subagent runs.
    return next(e)
  })

  // /clear starts a new conversation without a new session.start: forget the old one's figures and questions.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await Promise.all([
        closeInsights($),
        update($, sessionAtom, () => EMPTY_SESSION as LedgerSession),
        update($, recentAtom, () => [] as LedgerTurn[]),
        update($, missesAtom, () => [] as LedgerMiss[]),
        update($, agentsAtom, () => [] as LedgerAgent[]),
        update($, mainPendingAtom, () => 0),
        update($, lastCostAtom, () => -1),
        update($, lastEndAtom, () => 0),
      ]).catch(() => undefined)
    }
    return next(e)
  })

  // Every model call, main loop and subagents alike, as its response completes.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (result.usage !== null) {
      const usage = fromApi(result.usage)
      const estUsd = estimateUsd(usage, result.usage.model)
      const now = await $.clock.now()
      if (e.agentId === undefined) {
        await update($, mainPendingAtom, p => p + estUsd)
        const effort = e.effort === undefined ? '' : String(e.effort)
        await update($, effortAtom, () => effort)
      } else {
        const id = e.agentId
        await update($, agentsAtom, agents => addStep(agents, { id, model: result.usage?.model ?? e.model, usage, estUsd, at: now }))
        ensureAgentPolling($, cfg)
      }
      await recordLimits($, await readEngineFigures($), now)
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const id = e.agentId
      const now = await $.clock.now()
      await update($, agentsAtom, agents => setTool(agents, id, String(e.tool), now))
    }
    const ran = await next(e)
    if (String(e.tool) === 'Agent') await syncAgents($, cfg).catch(() => undefined)
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.usage === undefined) return result
    const usage = fromApi(e.usage)
    const now = await $.clock.now()

    // A subagent's tokens count toward the session; its share is settled
    // against the engine's session cost when the main loop's turn ends.
    if (e.agentId !== undefined) {
      await update($, sessionAtom, s => ({ ...s, usage: addUsage(s.usage, usage) }))
      await syncAgents($, cfg).catch(() => undefined)
      return result
    }

    await syncAgents($, cfg).catch(() => undefined)
    // Memory folds in the background so the turn is never held up by it.
    if (e.reason === 'answer') void foldAfterTurn($, e.answer)
    const figures = await readEngineFigures($)
    const lastCost = await read($, lastCostAtom)
    const realUsd = Math.max(0, figures.costUsd - (lastCost < 0 ? figures.costUsd : lastCost))
    const settled = reconcile(await read($, agentsAtom), await read($, mainPendingAtom), realUsd)
    const lastEndAt = await read($, lastEndAtom)
    const gapMs = lastEndAt > 0 ? now - e.durationMs - lastEndAt : 0
    const miss = detectMiss({ gapMs, usage, costUsd: settled.mainUsd, at: now })
    const sessionId = await $.session.id()

    await update($, agentsAtom, () => settled.agents)
    await update($, mainPendingAtom, () => 0)
    await update($, lastCostAtom, () => figures.costUsd)
    await update($, lastEndAtom, () => now)
    await update($, sessionAtom, s => ({ costUsd: s.costUsd + realUsd, turns: s.turns + 1, usage: addUsage(s.usage, usage) }))
    await update($, recentAtom, list => [...list, { at: now, costUsd: realUsd, usage, durationMs: e.durationMs }].slice(-RECENT_KEEP))
    if (miss) await update($, missesAtom, list => [...list, miss].slice(-MISSES_KEEP))
    await recordLimits($, figures, now)

    const key = sessionDayKey(now, sessionId)
    await $.store.set(key, addToDay(asDay(await $.store.get(key)), { costUsd: realUsd, usage, miss, agentUsd: settled.agentUsd }))
    await $.store.set(`lastEnd:${sessionId}`, now)
    await refreshRollups($, now)
    await showStatus($, cfg)

    if (miss && cfg.isMissToastOn) {
      $.ui.toast(`Cache expired after ${miss.gapMinutes} min idle: ${compact(miss.tokensRewritten)} tokens rewritten.`, { timeoutMs: 8000 })
    }
    return result
  })

  on('command.run', { command: 'ledger' }, async ($, e) => {
    const opened = await $.ui.open({ id: PANE, title: 'Token ledger' })
    const five = await read($, fiveHourAtom)
    const summary = five < 0 ? 'No limit reading yet.' : `5-hour limit ${pct(five)}% used.`
    return { text: opened.isPlaced ? summary : `${summary} Widen the terminal to see the ledger pane.` }
  })

  // What the person typed is what memory learns from: not notifications, schedules or peers.
  on('prompt.submit', async ($, e, next) => {
    noteUserPrompt({ text: e.text, origin: e.origin, isMeta: e.isMeta, command: e.command })
    return next(e)
  })

  // The telemetry row above the prompt and the "?" launcher at its right.
  // Nothing else is ever drawn here: the bar is static and never scrolls with
  // the questions, which live in their own pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await $.clock.now()
    if (e.props.hasSurvey) return next(e)
    const f = await furnaceNow($, cfg, now)
    const session = await read($, sessionAtom)
    const hasContext = session.turns > 0 || f.five >= 0
    const els = $.ui.resolve(e)
    const insights = await read($, insightsAtom)
    const row = telemetryTree(
      els,
      {
        fivePercent: f.five,
        ratePerMin: f.rate,
        resetsAt: f.resetsAt,
        now,
        weekPercent: f.week,
        contextPercent: hasContext ? await read($, contextAtom) : null,
        cacheHit: cacheHitPercent(session.usage),
        model: await $.session.model(),
        effort: await read($, effortAtom),
      },
      Math.max(20, (e.props.bodyColumns ?? 80) - 6),
    )
    const ask = askButton(els, insights.status, () => {
      void runInsights($)
    })
    const { Box } = els
    const bar = (
      <Box key="bar" flexDirection="row" alignItems="center" justifyContent="space-between">
        {row}
        {ask}
      </Box>
    )
    const questions =
      insights.inBand && insights.status !== 'idle'
        ? insightsPane(els, insights, e.props.bodyColumns ?? 80, insightHandlers($))
        : undefined
    if (questions === undefined) return bar
    return (
      <Box flexDirection="column">
        {questions}
        {bar}
      </Box>
    )
  })

  // The questions, in a pane of their own: they scroll there, the bar does not.
  on('ui.render', { component: 'Pane', requestId: INSIGHTS_PANE }, async ($, e) => {
    const insights = await read($, insightsAtom)
    const width = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    return insightsPane($.ui.resolve(e), insights, width, insightHandlers($))
  })

  on('command.run', { command: 'brief' }, async ($, e) => ({ text: await runBriefCommand($, e.args).catch(() => 'Could not read or update the memory.') }))

  on('ui.render', { component: 'Pane', requestId: MEMORY_PANE }, async ($, e) => memoryPane($.ui.resolve(e), await read($, memoryAtom), memoryHandlers($)))

  on('command.run', { command: 'ask' }, async $ => {
    void runInsights($)
    return { text: 'Asking Haiku for five questions to ask next.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const resetsAt = await read($, resetsAtAtom)
    return paneTree($.ui.resolve(e), {
      session: await read($, sessionAtom),
      week: await read($, weekAtom),
      misses: await read($, missesAtom),
      recent: await read($, recentAtom),
      agents: await read($, agentsAtom),
      ctx: await read($, contextAtom),
      five: await read($, fiveHourAtom),
      weekPercent: await read($, weekPercentAtom),
      resetsLabel: resetsAt ? new Date(resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
      rows: e.viewport?.rows ?? 30,
      now: await $.clock.now(),
    })
  })
}
