import { describe, expect, test } from 'claude-code/testing'

import { addStep, agentPoints, crossedAlert, laneAgents, liveCost, mergeListed, newAgent, reconcile } from '../hooks/lib/agents'
import {
  burnRate,
  DRIFT_EVERY,
  emberText,
  heatOf,
  minutesToLimit,
  SUB,
  ownerOf,
  splitColumns,
  stageOf,
  stepHeights,
  targetHeights,
} from '../hooks/lib/furnace'
import type { FurnaceProps } from '../hooks/lib/furnace'
import { EMPTY_USAGE } from '../hooks/lib/ledger'
import { estimateUsd, shortModel } from '../hooks/lib/prices'

const u = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite })

describe('prices', () => {
  test('a million output tokens on each model', () => {
    expect(estimateUsd(u(0, 1_000_000), 'claude-opus-5-5')).toBe(20)
    expect(estimateUsd(u(0, 1_000_000), 'claude-sonnet-5-5')).toBe(10)
    expect(estimateUsd(u(0, 1_000_000), 'claude-haiku-5-5')).toBe(0.5)
    expect(estimateUsd(u(0, 1_000_000), 'claude-fable-5-1')).toBe(50)
  })

  test('cache writes cost 1.25x input, reads a fraction', () => {
    expect(estimateUsd(u(0, 0, 0, 1_000_000), 'claude-opus-5-5')).toBe(5)
    expect(estimateUsd(u(0, 0, 1_000_000, 0), 'claude-opus-5-5')).toBe(0.2)
  })

  test('short names for the lanes', () => {
    expect(shortModel('claude-sonnet-5-5')).toBe('sonnet')
    expect(shortModel('')).toBe('?')
  })
})

describe('agents', () => {
  test('steps add up per agent without touching the old list', () => {
    const before = [newAgent('a1', 0)]
    const after = addStep(addStep(before, { id: 'a1', model: 'm', usage: u(10, 5), estUsd: 0.1, at: 1 }), {
      id: 'a2',
      model: 'm',
      usage: u(1, 1),
      estUsd: 0.05,
      at: 2,
    })
    expect(before[0]?.calls).toBe(0)
    expect(after.map(a => [a.id, a.calls])).toEqual([
      ['a1', 1],
      ['a2', 1],
    ])
    expect(after[0]?.pendingUsd).toBe(0.1)
  })

  test('reconciling splits the real cost by estimate and adds up exactly', () => {
    const agents = [{ ...newAgent('a', 0), pendingUsd: 3 }, { ...newAgent('b', 0), pendingUsd: 1 }]
    const r = reconcile(agents, 4, 4) // estimated 8, really 4: everything halves
    expect(r.agents.map(a => a.costUsd)).toEqual([1.5, 0.5])
    expect(r.agents.every(a => a.pendingUsd === 0)).toBe(true)
    expect(r.mainUsd + r.agentUsd).toBe(4)
    expect(r.mainUsd).toBe(2)
  })

  test('with no estimate the main loop takes the whole cost', () => {
    expect(reconcile([], 0, 1.25)).toEqual({ agents: [], mainUsd: 1.25, agentUsd: 0 })
  })

  test('the engine list names agents and stamps when they finished', () => {
    const merged = mergeListed([newAgent('a', 0)], [{ id: 'a', type: 'Explore', description: 'find auth', status: 'completed' }], 50)
    expect(merged[0]).toMatchObject({ type: 'Explore', description: 'find auth', status: 'completed', endedAt: 50 })
  })

  test('lanes: running first, then the most expensive; old finished ones drop off', () => {
    const now = 60 * 60_000
    const agents = [
      { ...newAgent('done-old', 0), status: 'completed', endedAt: 0, costUsd: 9 },
      { ...newAgent('done-new', 0), status: 'completed', endedAt: now - 60_000, costUsd: 5 },
      { ...newAgent('cheap', 0), costUsd: 1 },
      { ...newAgent('dear', 0), costUsd: 3 },
    ]
    expect(laneAgents(agents, now, 4).map(a => a.id)).toEqual(['dear', 'cheap', 'done-new'])
  })

  test('the alert fires once per agent', () => {
    const agents = [{ ...newAgent('a', 0), costUsd: 2 }, { ...newAgent('b', 0), costUsd: 2, isAlerted: true }]
    // Each agent is half the session; the session used 30 points: about 15 each.
    expect(agentPoints(agents[0]!, 4, 30)).toBe(15)
    expect(crossedAlert(agents, 4, 30, 10).map(a => a.id)).toEqual(['a'])
    expect(crossedAlert(agents, 4, 30, 20)).toEqual([])
    expect(crossedAlert(agents, 4, 30, 0)).toEqual([])
    expect(liveCost({ ...newAgent('c', 0), costUsd: 1, pendingUsd: 0.5 })).toBe(1.5)
  })
})

describe('the furnace', () => {
  const props = (over: Partial<FurnaceProps> = {}): FurnaceProps => ({
    fill: 0.5,
    stage: 'calm',
    animate: true,
    sources: [
      { key: 'main', kind: 'main', share: 0.75, heat: 1 },
      { key: 'a', kind: 'agent', share: 0.25, heat: 1 },
    ],
    ...over,
  })

  test('burn rate over the last five minutes', () => {
    const samples = [
      { at: 0, percent: 0 },
      { at: 60_000, percent: 1 },
      { at: 120_000, percent: 2 },
    ]
    expect(burnRate(samples, 120_000)).toBe(1)
    expect(burnRate(samples, 60 * 60_000)).toBe(0)
    expect(heatOf(0.5)).toBe(0.5)
    expect(heatOf(5)).toBe(1)
  })

  test('minutes to the limit, unless it resets first', () => {
    expect(minutesToLimit(60, 1, 120)).toBe(40)
    expect(minutesToLimit(60, 1, 30)).toBeNull()
    expect(minutesToLimit(60, 0, 120)).toBeNull()
    expect(minutesToLimit(100, 1, 120)).toBe(0)
  })

  test('the status strip as text', () => {
    expect(emberText([0, 3, 8, 12])).toBe('·▃██')
  })

  test('budget stages', () => {
    expect([0.2, 0.7, 0.95, 1.2].map(stageOf)).toEqual(['calm', 'warm', 'hot', 'over'])
  })

  test('the lit part of the bar is split by share, the rest unlit', () => {
    const spans = splitColumns(40, 0.5, props().sources)
    expect(spans).toEqual([15, 5])
    const owners = ownerOf(40, props())
    expect(owners.filter(o => o === 'agent').length).toBe(5)
    expect(owners.filter(o => o === 'none').length).toBe(20)
  })

  test('past the budget the whole bar is lit', () => {
    expect(splitColumns(40, 1.4, props().sources).reduce((a, b) => a + b, 0)).toBe(40)
  })

  test('hotter burns stand taller; unlit columns stay at zero', () => {
    const hot = targetHeights(40, 3, props())
    const cold = targetHeights(40, 3, props({ sources: props().sources.map(s => ({ ...s, heat: 0 })) }))
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
    expect(sum(hot)).toBeGreaterThan(sum(cold))
    expect(hot.slice(20).every(h => h === 0)).toBe(true)
  })

  test('flames ease at most two eighths of a row a frame', () => {
    const next = stepHeights([0, 7, 20], [16, 8, 4], 1, true)
    expect(next).toEqual([2, 8, 18])
  })

  test('idle still shows low flames; every lit column is at least three eighths tall', () => {
    const idle = targetHeights(40, 3, props({ sources: props().sources.map(s => ({ ...s, heat: 0 })) }))
    expect(idle.slice(0, 20).every(h => h >= 3 && h <= 3 * SUB)).toBe(true)
    expect(Math.max(...idle)).toBeGreaterThan(SUB)
  })

  test('low flicker: at its target, few columns move, and only on a beat', () => {
    const target = targetHeights(60, 3, props({ fill: 1 }))
    let current = target
    let changes = 0
    let offBeatChanges = 0
    for (let tick = 1; tick <= 50; tick += 1) {
      const next = stepHeights(current, target, tick, true)
      const moved = next.filter((h, i) => h !== current[i]).length
      changes += moved
      if (tick % DRIFT_EVERY !== 0 && tick % DRIFT_EVERY !== 1) offBeatChanges += moved
      current = next
    }
    // 50 frames = 10 seconds: about 5 columns drift up and back each second.
    expect(changes).toBeLessThan(120)
    expect(offBeatChanges).toBe(0)
  })

  test('not burning, nothing moves once at target', () => {
    const target = targetHeights(60, 3, props())
    expect(stepHeights(target, target, DRIFT_EVERY, false)).toEqual(target)
  })

  test('an empty source list leaves the bar unlit', () => {
    expect(targetHeights(10, 4, props({ sources: [] })).every(h => h === 0)).toBe(true)
    expect(EMPTY_USAGE.input).toBe(0)
  })
})
