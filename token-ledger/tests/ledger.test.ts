import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentStatus, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import {
  addToDay,
  asDay,
  cacheHitPercent,
  dayKey,
  detectMiss,
  EMPTY_DAY,
  FIVE_MIN,
  lastDayKeys,
  duration,
  pct,
  ONE_HOUR,
  statusLine,
  sumDays,
} from '../hooks/lib/ledger'

const usage = (input: number, cacheRead: number, cacheWrite: number, output = 100) => ({ input, output, cacheRead, cacheWrite })

describe('cache maths', () => {
  test('hit percent is cache reads over all input', () => {
    expect(cacheHitPercent(usage(100, 900, 0))).toBe(90)
    expect(cacheHitPercent(usage(0, 0, 0))).toBeNull()
  })

  test('an idle gap followed by a big cache write is a miss', () => {
    const miss = detectMiss({ gapMs: 12 * 60_000, usage: usage(50, 1_000, 150_000), costUsd: 0.6, at: 1 })
    expect(miss).toEqual({ at: 1, gapMinutes: 12, ttl: '5m', tokensRewritten: 150_000, costUsd: 0.6 })
  })

  test('past an hour the miss is filed under the 1-hour cache', () => {
    expect(detectMiss({ gapMs: ONE_HOUR + 1, usage: usage(0, 0, 80_000), costUsd: 1, at: 1 })?.ttl).toBe('1h')
  })

  test('no miss without idle, or when the cache mostly read', () => {
    expect(detectMiss({ gapMs: FIVE_MIN - 1, usage: usage(0, 0, 150_000), costUsd: 1, at: 1 })).toBeNull()
    expect(detectMiss({ gapMs: ONE_HOUR, usage: usage(0, 150_000, 20_000), costUsd: 1, at: 1 })).toBeNull()
    expect(detectMiss({ gapMs: ONE_HOUR, usage: usage(0, 0, 2_000), costUsd: 1, at: 1 })).toBeNull()
  })
})

describe('daily rollups', () => {
  test('adding turns returns a new day and leaves the old one', () => {
    const before = EMPTY_DAY
    const miss = detectMiss({ gapMs: ONE_HOUR, usage: usage(0, 0, 50_000), costUsd: 0.3, at: 1 })
    const day = addToDay(addToDay(before, { costUsd: 0.1, usage: usage(10, 0, 0), miss: null }), { costUsd: 0.3, usage: usage(0, 0, 50_000), miss })
    expect(before).toEqual(EMPTY_DAY)
    expect(day.turns).toBe(2)
    expect(Math.round(day.costUsd * 100)).toBe(40)
    expect(day.misses).toBe(1)
    expect(Math.round(day.missCostUsd * 100)).toBe(30)
  })

  test('a week sums its days', () => {
    const d = addToDay(EMPTY_DAY, { costUsd: 1, usage: usage(1, 1, 1), miss: null })
    expect(sumDays([d, d, EMPTY_DAY]).costUsd).toBe(2)
  })

  test('stored junk reads back as an empty day', () => {
    expect(asDay(undefined)).toEqual(EMPTY_DAY)
    expect(asDay({ costUsd: 'x', usage: null })).toEqual(EMPTY_DAY)
  })

  test('day keys are local dates, today first', () => {
    const now = new Date(2026, 9, 9, 10).getTime()
    expect(dayKey(now)).toBe('2026-10-09')
    expect(lastDayKeys(now, 3)).toEqual(['day:2026-10-09', 'day:2026-10-08', 'day:2026-10-07'])
  })
})

describe('formatting', () => {
  test('durations and percentages', () => {
    expect(duration(45)).toBe('45m')
    expect(duration(125)).toBe('2h05')
    expect(pct(54.4)).toBe('54')
    expect(pct(2.5)).toBe('2.5')
  })

  test('status line: strip, limits, agents, context, cache', () => {
    const line = statusLine({
      strip: '▃▅',
      fivePercent: 54,
      weekPercent: 23,
      toLimitMinutes: 40,
      running: 2,
      agentShare: 0.31,
      contextPercent: 38,
      cacheHit: 90,
    })
    expect(line).toBe('▃▅ 5h 54% · limit in ~40m · week 23% · 2 agents 31% · ctx 38% · cache 90%')
  })

  test('status line with no limit reading', () => {
    const line = statusLine({ strip: '·', fivePercent: -1, weekPercent: -1, toLimitMinutes: null, running: 0, agentShare: 0, contextPercent: 1, cacheHit: null })
    expect(line).toBe('· no limit reading · ctx 1%')
  })
})

type TestOn = On

/** Mocked clock and store, a session cost that climbs as the test says, UI captured. */
type Listed = { id: string; type: string; description: string; status: AgentStatus }
let listed: Listed[] = []
let listCalls = 0

const world = (on: TestOn, costs: number[], fives: number[] = [0]) => {
  listed = []
  listCalls = 0
  const clock = mock.clock(on, { now: new Date(2026, 9, 9, 9).getTime() })
  mock.store(on)
  const seen = { status: [] as string[], toasts: [] as string[] }
  let call = 0
  on('session.usage', () => {
    const i = call++
    return {
      value: {
        startedAt: 0,
        context: { tokens: 1_000, window: 200_000, percent: 1 },
        rateLimits: [{ kind: 'five_hour', percentUsed: fives[Math.min(i, fives.length - 1)] ?? 0 }],
        cost: { usd: costs[Math.min(i, costs.length - 1)] ?? 0 },
      },
    }
  })
  on('ui.status', ($, e) => {
    seen.status.push(String(e.text))
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(String(e.text))
    return { value: undefined }
  })
  on('turn.complete', () => ({ text: '' }))
  on('session.start', () => ({ cwd: 'C:/work/demo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('agent.list', () => {
    listCalls += 1
    return { value: listed }
  })
  return { clock, seen }
}

const turn = (id: string, durationMs: number, u: { input: number; read: number; write: number }, agentId?: string) => ({
  answer: '',
  durationMs,
  isAborted: false,
  turnId: id,
  reason: 'answer' as const,
  ...(agentId ? { agentId } : {}),
  usage: {
    input_tokens: u.input,
    output_tokens: 50,
    cache_read_input_tokens: u.read,
    cache_creation_input_tokens: u.write,
    model: 'claude-opus-5-5',
  },
})

test('the status shows the 5-hour limit, and an idle rewrite toasts in tokens', async ($, on) => {
  // Baseline 0 at session start, then 0.10 after turn one and 0.80 after turn two.
  const { clock, seen } = world(on, [0, 0.1, 0.8], [10, 12, 30])
  await $.session.start({ cwd: 'C:/work/demo', surface: 'terminal', isInteractive: true })
  await $.turn.complete(turn('t1', 2_000, { input: 100, read: 900, write: 0 }))
  // 10% -> 12% inside a minute: 2 points a minute, 88 left, about 44 minutes.
  // The status bar is cleared: every figure lives in the row above the prompt.
  expect(seen.status.every(t => t === 'undefined')).toBe(true)
  await clock.advance(20 * 60_000)
  await $.turn.complete(turn('t2', 3_000, { input: 50, read: 0, write: 120_000 }))
  expect(seen.status.at(-1)).not.toMatch(/R\d|\$/)
  expect(seen.toasts.length).toBe(1)
  expect(seen.toasts[0]).toContain('idle: 120k tokens rewritten.')
})

test('a subagent turn neither prices nor toasts', async ($, on) => {
  const { seen } = world(on, [5])
  await $.turn.complete(turn('t3', 1_000, { input: 10, read: 0, write: 200_000 }, 'agent-1'))
  expect(seen.status.length).toBe(0)
  expect(seen.toasts.length).toBe(0)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the ledger pane draws after a turn (${surface})`, async ($, on) => {
    const { seen } = world(on, [0, 0.25])
    await $.session.start({ cwd: 'C:/work/demo', surface, isInteractive: true })
    await $.turn.complete(turn('t1', 4_000, { input: 100, read: 900, write: 0 }))
    const ui = await $.ui.mount({
      plugin: 'token-ledger',
      surface,
      component: 'Pane',
      requestId: 'ledger',
      props: { bodyColumns: 100 } as never,
    })
    expect(await ui.find({ type: 'Text', text: /1 turns/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5-hour/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Recent turns/ })).toBeDefined()
    await ui.unmount()
  })
}

const step = async ($: Engine, agentId: string | undefined, model: string, out: number) => {
  const stream = $.turn.step({ turnId: 't', index: 0, model, messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _ of stream) {
    // drain
  }
  return stream.result
}

const stepResult = (model: string, out: number) => ({
  turnId: 't',
  index: 0,
  answer: '',
  toolUses: [],
  stopReason: 'end_turn',
  usage: { input_tokens: 0, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model },
})

test('subagent spend is tracked per agent, settled to the engine total, and drawn in lanes', async ($, on) => {
  // Engine cost: 0 at start, 3.00 after the turn (main + agent together).
  const { seen } = world(on, [0, 3])
  on('turn.step', async function* ($, e) {
    return stepResult(e.agentId ? 'claude-haiku-5-5' : 'claude-opus-5-5', e.agentId ? 1_000_000 : 100_000) as never
  })
  await $.session.start({ cwd: 'C:/work/demo', surface: 'terminal', isInteractive: true })
  await step($, undefined, 'claude-opus-5-5', 100_000) // est $2.00
  await step($, 'agent-1', 'claude-haiku-5-5', 1_000_000) // est $0.50
  listed = [{ id: 'agent-1', type: 'Explore', description: 'find auth handlers', status: 'running' }]
  await $.turn.complete(turn('t1', 2_000, { input: 100, read: 900, write: 0 }))

  // Estimates 2 : 0.5 -> the agent is 20% of the session.
  expect(seen.status.every(t => t === 'undefined')).toBe(true)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'token-ledger',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never,
    })
    // Every surface draws the row as text.
    expect(await ui.find({ type: 'Text', text: /5h limit/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
    await ui.advance(2_000)
    await ui.unmount()
  }
})

test('one agent past the alert line toasts once', async ($, on) => {
  const { seen } = world(on, [0, 0], [0, 40])
  on('tool.call', { tool: 'Agent' }, () => ({ result: {} }) as never)
  on('turn.step', async function* () {
    return stepResult('claude-fable-5-1', 1_000_000) as never // est $50 = R900
  })
  await $.session.start({ cwd: 'C:/work/demo', surface: 'terminal', isInteractive: true })
  await step($, 'agent-9', 'claude-fable-5-1', 1_000_000)
  listed = [{ id: 'agent-9', type: 'general', description: 'big refactor', status: 'running' }]
  await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' } as never).catch(() => undefined)
  await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' } as never).catch(() => undefined)
  expect(seen.toasts.filter(t => t.includes('big refactor')).length).toBe(1)
})

test('the agent list is polled only while a subagent runs, then the poll stops', async ($, on) => {
  const { clock } = world(on, [0, 0])
  on('turn.step', async function* () {
    return stepResult('claude-haiku-5-5', 1_000) as never
  })
  await $.session.start({ cwd: 'C:/work/demo', surface: 'terminal', isInteractive: true })
  await clock.advance(60_000)
  expect(listCalls).toBe(0) // no agent, no polling at all

  listed = [{ id: 'agent-1', type: 'Explore', description: 'scan', status: 'running' }]
  await step($, 'agent-1', 'claude-haiku-5-5', 1_000)
  await clock.advance(9_000)
  const whileRunning = listCalls
  expect(whileRunning).toBeGreaterThan(0)

  listed = [{ id: 'agent-1', type: 'Explore', description: 'scan', status: 'completed' }]
  await clock.advance(3_000) // one more poll sees it finished and stops
  const afterStop = listCalls
  await clock.advance(60_000)
  expect(listCalls).toBe(afterStop)
})

test('the desktop and the terminal draw the same row', async ($, on) => {
  const { clock } = world(on, [0, 0.1], [10, 25])
  on('turn.step', async function* ($, e) {
    return { ...stepResult('claude-opus-5-5', 1_000), effort: undefined } as never
  })
  await $.session.start({ cwd: 'C:/work/demo', surface: 'desktop', isInteractive: true })
  await $.turn.complete(turn('t1', 2_000, { input: 100, read: 900, write: 0 }))
  await clock.settle()
  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200 } as never
  const desk = await $.ui.mount({ plugin: 'token-ledger', surface: 'desktop', component: 'AbovePrompt', props })
  const term = await $.ui.mount({ plugin: 'token-ledger', surface: 'terminal', component: 'AbovePrompt', props })
  const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<{ text: string }[]> }) => (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
  expect(await desk.find({ type: 'Svg' })).toBeUndefined()
  expect(await texts(desk)).toContain('5h limit')
  expect(await texts(desk)).toBe(await texts(term))
  await desk.unmount()
  await term.unmount()
})
