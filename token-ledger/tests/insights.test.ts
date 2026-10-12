import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { buildPrompt, fillPlan, INSIGHT_MODEL, parseInsights } from '../hooks/lib/insights'

const context = {
  project: {
    name: 'my-app',
    branch: 'main',
    gitStatus: ' M src/dedupe.ts',
    recentCommits: 'a1b2c3d feat: hourly top 10',
    docs: [{ path: 'C:/work/CLAUDE.md', text: 'Never write to the production database.' }],
  },
  messages: [
    { role: 'user' as const, text: 'Why do leads duplicate?', tools: [] },
    { role: 'assistant' as const, text: 'The dedupe runs before the phone is normalised.', tools: ['Read', 'Grep', 'Read'] },
  ],
  thinking: [],
}

const FIVE = JSON.stringify({
  questions: [
    { title: 'Normalise first', question: 'What breaks if we normalise phone numbers before the dedupe step in src/dedupe.ts?' },
    { title: 'Prod write risk', question: 'Which code paths could still write to the production database despite the CLAUDE.md rule?' },
    { title: 'Missing tests', question: 'Which duplicate-lead cases have no test today, and can you write them?' },
    { title: 'Hourly job timing', question: 'Could the hourly top 10 run while a dedupe is half done?' },
    { title: 'Unused data', question: 'Is there lead-source data in the payload we are dropping that would explain the duplicates?' },
  ],
})

describe('the context Haiku reads', () => {
  test('project, reasoning and chat all go in, without inventing reasoning', () => {
    const p = buildPrompt(context)
    expect(p).toContain('my-app')
    expect(p).toContain('Git branch: main')
    expect(p).toContain('M src/dedupe.ts')
    expect(p).toContain('Never write to the production database.')
    expect(p).toContain("reasoning is not visible")
    expect(p).toContain('CLAUDE [tools: Read, Grep]: The dedupe runs before the phone is normalised.')
  })

  test('visible reasoning is included when the engine kept it', () => {
    expect(buildPrompt({ ...context, thinking: ['Suspect the regex strips +27.'] })).toContain('Suspect the regex strips +27.')
  })

  test('a long chat keeps the newest messages within budget', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ role: 'user' as const, text: `message ${i} ${'x'.repeat(1_400)}`, tools: [] }))
    const p = buildPrompt({ ...context, messages: many })
    expect(p.length).toBeLessThanOrEqual(62_000)
    expect(p).toContain('message 199')
    expect(p).not.toContain('message 0 ')
  })
})

describe('reading the reply', () => {
  test('five distinct questions, exactly as written', () => {
    const items = parseInsights(`Here you go:\n${FIVE}`)
    expect(items.length).toBe(5)
    expect(items[0]?.question).toBe('What breaks if we normalise phone numbers before the dedupe step in src/dedupe.ts?')
  })

  test('duplicates, blanks and junk are dropped; malformed replies give nothing', () => {
    const messy = JSON.stringify({ questions: [{ title: 'A', question: 'Same?' }, { title: 'B', question: 'same?' }, { title: 'C', question: '' }, 5] })
    expect(parseInsights(messy).map(i => i.title)).toEqual(['A'])
    expect(parseInsights('not json')).toEqual([])
    expect(parseInsights('{"questions": "nope"}')).toEqual([])
  })
})

describe('putting questions in the prompt box', () => {
  test('an empty box takes the question as is', () => {
    expect(fillPlan('', ['Why?'])).toEqual({ text: 'Why?', mode: 'replace' })
  })

  test("the user's own text is kept: the question is appended below it", () => {
    expect(fillPlan('draft idea', ['Why?'])).toEqual({ text: '\n\nWhy?', mode: 'append' })
    expect(fillPlan('draft idea\n', ['Why?'])).toEqual({ text: 'Why?', mode: 'append' })
  })

  test('several ticked questions go in together, one blank line apart, in pick order', () => {
    expect(fillPlan('', ['Why?', 'How?'])).toEqual({ text: 'Why?\n\nHow?', mode: 'replace' })
    expect(fillPlan('draft', ['Why?', 'How?'])).toEqual({ text: '\n\nWhy?\n\nHow?', mode: 'append' })
  })

  test('blanks among the ticked are dropped', () => {
    expect(fillPlan('', ['Why?', '   ', 'How?'])).toEqual({ text: 'Why?\n\nHow?', mode: 'replace' })
  })
})

type Opts = { reply?: string; isAnswered?: boolean; boxText?: string; fillOk?: boolean; isPanePlaced?: boolean }

/** A session with one exchange, a Haiku that answers as told, and a prompt box. */
const world = (on: On, o: Opts = {}) => {
  const clock = mock.clock(on)
  mock.store(on)
  const seen = { models: [] as string[], prompts: [] as string[], fills: [] as { text: string; mode?: string }[], submits: 0, opened: 0, closed: 0 }
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1, window: 200_000, percent: 4 }, rateLimits: [{ kind: 'five_hour', percentUsed: 25 }], cost: { usd: 0 } } }) as never)
  on('session.root', () => ({ value: 'C:/work/my-app' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', ($, e) =>
    ((e as { as?: string }).as === 'api'
      ? { value: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'ok' }] }] }
      : { value: context.messages.map(m => ({ role: m.role, text: m.text, toolUses: m.tools.map(t => ({ tool: t, input: {} })) })) }) as never,
  )
  on('fs.ancestors', () => ({ value: [{ dir: 'C:/work', name: 'CLAUDE.md', content: 'Never write to the production database.', parts: [] }] }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('model.complete', ($, e) => {
    seen.models.push(e.model)
    seen.prompts.push(e.prompt)
    return { value: o.isAnswered === false ? { isAnswered: false, reason: 'api-error', status: 529, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } : { isAnswered: true, text: o.reply ?? FIVE, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } as never
  })
  on('prompt.read', () => ({ value: { text: o.boxText ?? '', cursor: 0 } }) as never)
  on('prompt.fill', ($, e) => {
    seen.fills.push({ text: e.text, mode: e.mode })
    return { isFilled: o.fillOk !== false, ...(o.fillOk === false ? { refusal: 'dialog' } : {}) } as never
  })
  on('prompt.submit', () => {
    seen.submits += 1
    return { text: '' } as never
  })
  on('ui.open', () => {
    seen.opened += 1
    return { value: { isPlaced: o.isPanePlaced !== false } } as never
  })
  on('ui.close', () => {
    seen.closed += 1
    return { value: undefined } as never
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', () => ({ cwd: 'C:/work' }))
  return { clock, seen }
}

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140 } as never

const PANE_PROPS = { bodyColumns: 100 } as never

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the ? button asks Haiku 5.5 once and the questions open in their own pane (${surface})`, async ($, on) => {
    const { clock, seen } = world(on)
    await $.session.start({ cwd: 'C:/work', surface, isInteractive: true })
    const band = await $.ui.mount({ plugin: 'token-ledger', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ key: 'ask' })).toBeDefined()
    // Two clicks at once: the second lands while the first request runs and adds nothing.
    await Promise.all([band.press({ key: 'ask' }), band.press({ key: 'ask' })])
    await clock.settle()
    expect(seen.models).toEqual([INSIGHT_MODEL])
    expect(seen.prompts[0]).toContain('Never write to the production database.')
    // The questions get a pane of their own, so the bar above the prompt never scrolls with them.
    expect(seen.opened).toBe(1)
    expect(await band.find({ key: 'q-0' })).toBeUndefined()
    expect(await band.find({ key: 'bar' })).toBeDefined()
    await band.unmount()

    const pane = await $.ui.mount({ plugin: 'token-ledger', surface, component: 'Pane', requestId: 'insights', props: PANE_PROPS })
    for (let i = 0; i < 5; i += 1) expect(await pane.find({ key: `q-${i}` })).toBeDefined()
    // Nothing ticked yet: Insert is on show (so the pane reads as multi-select) but does nothing.
    expect((await pane.find({ key: 'insert' }))?.text).toContain('Tick questions')
    await pane.press({ key: 'insert' })
    expect(seen.fills).toEqual([])
    // Select all ticks all five; Clear unticks them.
    await pane.press({ key: 'all' })
    expect((await pane.find({ key: 'insert' }))?.text).toContain('5 questions')
    await pane.press({ key: 'clear' })
    expect((await pane.find({ key: 'insert' }))?.text).toContain('Tick questions')
    await pane.press({ key: 'q-1' })
    await pane.press({ key: 'q-3' })
    expect(seen.fills).toEqual([])
    expect((await pane.find({ key: 'insert' }))?.text).toContain('2 questions')
    // Ticked twice means unticked: the count follows.
    await pane.press({ key: 'q-3' })
    expect((await pane.find({ key: 'insert' }))?.text).toContain('1 question')
    await pane.press({ key: 'q-3' })
    await pane.press({ key: 'insert' })
    expect(seen.fills.length).toBe(1)
    expect(seen.fills[0]?.mode).toBe('replace')
    expect(seen.fills[0]?.text).toBe(
      'Which code paths could still write to the production database despite the CLAUDE.md rule?\n\nCould the hourly top 10 run while a dedupe is half done?',
    )
    expect(seen.submits).toBe(0)
    await pane.unmount()

    // Inserted: the questions fold away and their pane closes.
    expect(seen.closed).toBe(1)
    const after = await $.ui.mount({ plugin: 'token-ledger', surface, component: 'Pane', requestId: 'insights', props: PANE_PROPS })
    expect(await after.find({ key: 'q-0' })).toBeUndefined()
    await after.unmount()
  })
}

test('a terminal too narrow for a pane falls back to the band, with the bar still below', async ($, on) => {
  const { clock } = world(on, { isPanePlaced: false })
  await $.command.run({ command: 'ask', args: '', origin: { kind: 'composer' }, presentation: {} } as never)
  await clock.settle()
  const band = await $.ui.mount({ plugin: 'token-ledger', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ key: 'q-0' })).toBeDefined()
  expect(await band.find({ key: 'bar' })).toBeDefined()
})

test('text already in the box is kept: the question is appended', async ($, on) => {
  const { clock, seen } = world(on, { boxText: 'my own draft' })
  await $.command.run({ command: 'ask', args: '', origin: { kind: 'composer' }, presentation: {} } as never)
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'token-ledger', surface: 'terminal', component: 'Pane', requestId: 'insights', props: PANE_PROPS })
  await pane.press({ key: 'q-0' })
  await pane.press({ key: 'insert' })
  expect(seen.fills[0]?.mode).toBe('append')
  expect(seen.fills[0]?.text.startsWith('\n\n')).toBe(true)
})

test('when the box refuses, the suggestions stay and the reason shows', async ($, on) => {
  const { clock, seen } = world(on, { fillOk: false })
  await $.command.run({ command: 'ask', args: '', origin: { kind: 'composer' }, presentation: {} } as never)
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'token-ledger', surface: 'terminal', component: 'Pane', requestId: 'insights', props: PANE_PROPS })
  await pane.press({ key: 'q-0' })
  await pane.press({ key: 'insert' })
  await pane.unmount()
  const still = await $.ui.mount({ plugin: 'token-ledger', surface: 'terminal', component: 'Pane', requestId: 'insights', props: PANE_PROPS })
  expect(await still.find({ key: 'q-0' })).toBeDefined()
  expect(await still.find({ type: 'Text', text: /Not inserted: / })).toBeDefined()
})

test('a failed request shows a recoverable error with Try again', async ($, on) => {
  const { clock } = world(on, { isAnswered: false })
  await $.command.run({ command: 'ask', args: '', origin: { kind: 'composer' }, presentation: {} } as never)
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'token-ledger', surface: 'terminal', component: 'Pane', requestId: 'insights', props: PANE_PROPS })
  expect(await pane.find({ type: 'Text', text: /Couldn't generate questions: the API returned an error/ })).toBeDefined()
  expect(await pane.find({ key: 'retry' })).toBeDefined()
})

test('an empty or malformed reply shows the empty state', async ($, on) => {
  const { clock } = world(on, { reply: 'sorry, no' })
  await $.command.run({ command: 'ask', args: '', origin: { kind: 'composer' }, presentation: {} } as never)
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'token-ledger', surface: 'terminal', component: 'Pane', requestId: 'insights', props: PANE_PROPS })
  expect(await pane.find({ type: 'Text', text: /no usable questions/ })).toBeDefined()
})
