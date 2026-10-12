import { describe, expect, test } from 'claude-code/testing'

import { buildGroups, clockTime, fitGroups, prettyEffort, prettyModel, remaining } from '../hooks/telemetry'

const now = new Date(2026, 9, 9, 6, 45).getTime()
const full = {
  fivePercent: 25,
  ratePerMin: 0.3,
  resetsAt: new Date(2026, 9, 9, 9, 0).toISOString(),
  now,
  weekPercent: 58,
  contextPercent: 73,
  cacheHit: 100,
  model: 'claude-opus-5-5',
  effort: 'medium',
}

describe('the nine groups', () => {
  test('in the specified order with real values', () => {
    const g = buildGroups(full)
    expect(g.map(x => x.key)).toEqual(['five', 'rate', 'reset', 'left', 'week', 'ctx', 'cache', 'model', 'effort'])
    expect(g.map(x => x.value)).toEqual(['25%', '+0.3/min', '09:00 AM', '2h 15m', '58%', '73%', '100%', 'Opus 5.5', 'Medium'])
    expect(g[0]?.label).toBe('5h limit')
    expect(g[0]?.valueColor).toBe('warning')
  })

  test('a metric with no reading is left out, never faked', () => {
    const g = buildGroups({ ...full, fivePercent: -1, resetsAt: '', weekPercent: -1, cacheHit: null, effort: '' })
    expect(g.map(x => x.key)).toEqual(['ctx', 'model'])
  })
})

describe('formatting', () => {
  test('model, effort, times', () => {
    expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(prettyModel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5')
    expect(prettyModel('Opus 5.5')).toBe('Opus 5.5')
    expect(prettyEffort('xhigh')).toBe('Xhigh')
    expect(remaining(135)).toBe('2h 15m')
    expect(remaining(45)).toBe('45m')
    expect(clockTime(new Date(2026, 9, 9, 21, 5).toISOString())).toBe('09:05 PM')
  })
})

describe('one line at any width', () => {
  test('everything fits at desktop width', () => {
    const r = fitGroups(buildGroups(full), 140)
    expect(r.groups.length).toBe(9)
  })

  test('narrow: dividers tighten, then secondary metrics drop, order kept', () => {
    const r = fitGroups(buildGroups(full), 60)
    const keys = r.groups.map(g => g.key)
    expect(keys[0]).toBe('five')
    expect(keys).not.toContain('effort')
    expect(keys).toContain('left')
    const order = ['five', 'rate', 'reset', 'left', 'week', 'ctx', 'cache', 'model', 'effort']
    expect([...keys].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(keys)
  })

  test('very narrow keeps the 5-hour figure', () => {
    expect(fitGroups(buildGroups(full), 10).groups.map(g => g.key)).toEqual(['five'])
  })
})
