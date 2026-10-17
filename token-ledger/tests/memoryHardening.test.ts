import { describe, expect, test } from 'claude-code/testing'

import { buildPrompt } from '../hooks/lib/insights'
import {
  addSignal,
  applyFold,
  buildFoldPrompt,
  classifyUserMessage,
  EMPTY_PROFILE,
  EMPTY_PROJECT,
  parseBriefCommand,
  parseFold,
  renderMemory,
  SIGNAL_QUOTA,
} from '../hooks/lib/memory'
import type { Signal } from '../hooks/lib/memory'

// Regressions from the independent code review of the memory feature.

const sig = (kind: Signal['kind'], text: string, at = 1): Signal => ({ kind, text, at })

describe('skipped suggestions can never push out the user\'s own words', () => {
  test('a long run of ignored signals keeps the corrections and stays within its quota', () => {
    let all: readonly Signal[] = [sig('correction', "I'm not a developer", 1)]
    for (let i = 0; i < 30; i += 1) all = addSignal(all, sig('ignored', `Skipped question ${i}?`, 10 + i))
    expect(all.some(s => s.kind === 'correction')).toBe(true)
    expect(all.filter(s => s.kind === 'ignored').length).toBe(SIGNAL_QUOTA.ignored)
    // The newest skipped ones are the ones kept.
    expect(all.at(-1)?.text).toBe('Skipped question 29?')
  })

  test('what the ? prompt shows still holds the correction after many dismissals', () => {
    let all: readonly Signal[] = [sig('correction', "I'm not a developer", 1)]
    for (let i = 0; i < 30; i += 1) all = addSignal(all, sig('ignored', `Skipped question ${i}?`, 10 + i))
    const text = renderMemory({ ...EMPTY_PROJECT, signals: all }, EMPTY_PROFILE)
    expect(text).toContain("[correction] I'm not a developer")
    expect(text.match(/\[ignored\]/g)?.length ?? 0).toBeLessThanOrEqual(4)
  })
})

describe('only real corrections count as corrections', () => {
  test('ordinary requests are not corrections', () => {
    for (const text of [
      'I want a Q3 campaign report',
      'I need you to draft the follow-up email',
      'Use Tuesday instead of Monday for the send',
      'You know, casino, betting and gaming ads are restricted',
      'Run the non-stop ad schedule',
      "Don't forget to add the unsubscribe link",
    ]) {
      expect(classifyUserMessage(text)).toBeNull()
    }
  })

  test('real corrections still are', () => {
    for (const text of ['No, use the other list', 'Stop. That is not what I asked', "Don't use that headline", "That's wrong"]) {
      expect(classifyUserMessage(text)).toBe('correction')
    }
  })

  test('a pasted document is never read as the user\'s mood', () => {
    expect(classifyUserMessage(`${'This is a long pasted brief and it says do not do that. '.repeat(30)}wrong`)).toBeNull()
    expect(classifyUserMessage('SELECT NAME FROM LEADS WHERE STATUS = NEW AND SOURCE = META\n'.repeat(20))).toBeNull()
  })
})

describe('nothing personal is stored or sent raw', () => {
  const ID = '8001015009087'
  test('a signal is redacted before it is stored', () => {
    const [s] = addSignal([], sig('correction', `no, her ID is ${ID} and mail jane@example.com`))
    expect(s?.text).not.toContain(ID)
    expect(s?.text).not.toContain('jane@example.com')
  })

  test('/brief text is redacted before it is stored', () => {
    const cmd = parseBriefCommand(`brief Contact jane@example.com about ${ID}`)
    expect(cmd.action).toBe('set-brief')
    const text = cmd.action === 'set-brief' ? cmd.text : ''
    expect(text).not.toContain('jane@example.com')
    expect(text).not.toContain(ID)
  })

  test('the stored brief and profile are redacted again before they go to the fold call', () => {
    const p = buildFoldPrompt('Owner is jane@example.com', `ID ${ID}`, { user: 'x', assistant: 'y', signals: [] })
    expect(p).not.toContain('jane@example.com')
    expect(p).not.toContain(ID)
  })

  test('a fold result with personal data is redacted before it is kept', () => {
    const next = applyFold(EMPTY_PROJECT, EMPTY_PROFILE, { brief: 'Call 0821234567 daily', profile: `ID ${ID}` }, [], 5)
    expect(next.project.brief).not.toContain('0821234567')
    expect(next.profile.profile).not.toContain(ID)
  })
})

describe('a garbled fold reply never damages memory', () => {
  test('a stray object before the real JSON does not hide it', () => {
    const r = parseFold('Sure {note} {} here: {"brief":"B","profile":"P"}')
    expect(r).toEqual({ brief: 'B', profile: 'P' })
  })

  test('echoed placeholders count as "no change", not as content', () => {
    expect(parseFold('{"brief":"(empty)","profile":"Nothing recorded yet."}')).toEqual({ brief: '', profile: '' })
    expect(parseFold('{"brief":"Nothing known yet","profile":"P"}')).toEqual({ brief: '', profile: 'P' })
  })

  test('an empty fold neither counts as a fold nor wipes anything', () => {
    const base = { ...EMPTY_PROJECT, brief: 'Known brief', folds: 3 }
    const next = applyFold(base, EMPTY_PROFILE, { brief: '', profile: '' }, [sig('correction', 'No, other list')], 9)
    expect(next.project.brief).toBe('Known brief')
    expect(next.project.folds).toBe(3)
    expect(next.project.signals.length).toBe(1)
  })
})

describe('the ? prompt only gives up chat history when a real brief stands in for it', () => {
  const messages = Array.from({ length: 20 }, (_, i) => ({ role: 'user' as const, text: `message ${i}`, tools: [] }))
  const base = { project: { name: 'p', branch: '', gitStatus: '', recentCommits: '', docs: [] }, messages, thinking: [] }

  test('with feedback signals but no brief, the whole recent chat still goes in', () => {
    const p = buildPrompt({ ...base, memory: '## About the user\nNothing recorded yet.', memoryHasBrief: false })
    expect(p).toContain('message 0')
  })

  test('with a brief, only the latest messages go in', () => {
    const p = buildPrompt({ ...base, memory: '## About the user\nX', memoryHasBrief: true })
    expect(p).not.toContain('message 0')
    expect(p).toContain('message 19')
  })
})
