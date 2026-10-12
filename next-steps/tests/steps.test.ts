import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { buildPrompt, MAX_STEP_CHARS, parseSteps, shouldSuggest } from '../hooks/lib/steps'

describe('parsing the reply', () => {
  test('a JSON array, even with prose around it', () => {
    expect(parseSteps('Sure:\n["Run the tests", "Commit the fix"]')).toEqual(['Run the tests', 'Commit the fix'])
  })

  test('a bulleted or numbered list when there is no JSON', () => {
    expect(parseSteps('- Run the tests\n2. Commit the fix\nnoise')).toEqual(['Run the tests', 'Commit the fix'])
  })

  test('at most three, no repeats, long ones cut', () => {
    const long = 'x'.repeat(200)
    const steps = parseSteps(JSON.stringify(['a', 'a', 'b', long, 'c']))
    expect(steps.slice(0, 2)).toEqual(['a', 'b'])
    expect(steps.length).toBe(3)
    expect(steps[2]?.length).toBe(MAX_STEP_CHARS)
  })

  test('an empty array or junk gives nothing', () => {
    expect(parseSteps('[]')).toEqual([])
    expect(parseSteps('no idea')).toEqual([])
  })
})

describe('the prompt sent for suggestions', () => {
  test('personal data in the answer is redacted before it leaves', () => {
    const prompt = buildPrompt({ answer: 'Updated lead 8001015009087, cell 082 123 4567.', files: ['a.ts'], project: 'demo' })
    expect(prompt).not.toContain('8001015009087')
    expect(prompt).not.toContain('082 123 4567')
    expect(prompt).toContain('[SA_ID:')
    expect(prompt).toContain('Files touched this turn: a.ts')
  })

  test('file names, the project, and a number at the cut are redacted', () => {
    const answer = `8001015009087 ${'x'.repeat(3_990)}`
    const prompt = buildPrompt({ answer, files: ['client-8001015009087.csv'], project: 'lead 0821234567' })
    expect(prompt).not.toContain('8001015009087')
    expect(prompt).not.toContain('0821234567')
    expect(prompt).not.toMatch(/\d{6,}/)
  })

  test('short chat answers are skipped unless the turn did real work', () => {
    expect(shouldSuggest({ answer: 'Yes.', toolCalls: 0, minAnswerChars: 300 })).toBe(false)
    expect(shouldSuggest({ answer: 'Yes.', toolCalls: 3, minAnswerChars: 300 })).toBe(true)
    expect(shouldSuggest({ answer: 'x'.repeat(300), toolCalls: 0, minAnswerChars: 300 })).toBe(true)
  })
})

type TestOn = On

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never

const world = (on: TestOn, reply: string, isPanePlaced = false) => {
  const clock = mock.clock(on)
  const seen = { prompts: [] as string[], filled: [] as string[], opened: 0, closed: 0 }
  on('ui.open', () => {
    seen.opened += 1
    return { value: { isPlaced: isPanePlaced } } as never
  })
  on('ui.close', () => {
    seen.closed += 1
    return { value: undefined } as never
  })
  on('session.root', () => ({ value: 'C:/work/demo' }))
  on('model.complete', ($, e) => {
    seen.prompts.push(e.prompt)
    return { value: { isAnswered: true, text: reply, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } as never
  })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }) as never)
  on('prompt.fill', ($, e) => {
    seen.filled.push(e.text)
    return { isFilled: true } as never
  })
  on('turn.complete', () => ({ text: '' }))
  return { clock, seen }
}

const longTurn = { answer: 'I fixed the dialler retry bug in retry.ts and updated the tests. '.repeat(6), durationMs: 5_000, isAborted: false, turnId: 't1', reason: 'answer' as const }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`after a real turn the band offers the steps, several tick, and insert fills the prompt (${surface})`, async ($, on) => {
    const { clock, seen } = world(on, '["Run the retry tests", "Commit the fix"]')
    await $.turn.complete(longTurn)
    await clock.settle()
    expect(seen.prompts.length).toBe(1)

    const ui = await $.ui.mount({ plugin: 'next-steps', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect((await ui.find({ key: 'step-0' }))?.text).toContain('Run the retry tests')
    // Ticking is not inserting: nothing reaches the prompt until insert is pressed.
    // Insert is always on show so the pane reads as multi-select; with nothing ticked it does nothing.
    expect((await ui.find({ key: 'insert' }))?.text).toContain('Tick steps')
    await ui.press({ key: 'insert' })
    expect(seen.filled).toEqual([])
    await ui.press({ key: 'step-1' })
    expect((await ui.find({ key: 'step-1' }))?.text).toContain('[x]')
    expect((await ui.find({ key: 'step-0' }))?.text).toContain('[ ]')
    expect(seen.filled).toEqual([])
    await ui.press({ key: 'step-0' })
    expect((await ui.find({ key: 'insert' }))?.text).toContain('2 steps')
    await ui.press({ key: 'insert' })
    // Pick order, not list order.
    expect(seen.filled).toEqual(['Commit the fix\n\nRun the retry tests'])
    await ui.unmount()
  })
}

test('a short answer with no tool calls asks nothing', async ($, on) => {
  const { clock, seen } = world(on, '["x"]')
  await $.turn.complete({ ...longTurn, answer: 'Done.' })
  await clock.settle()
  expect(seen.prompts.length).toBe(0)
})

test('a subagent turn asks nothing', async ($, on) => {
  const { clock, seen } = world(on, '["x"]')
  await $.turn.complete({ ...longTurn, agentId: 'agent-1' })
  await clock.settle()
  expect(seen.prompts.length).toBe(0)
})

test('with a pane placed the suggestions draw there, never in the band with the ledger bar', async ($, on) => {
  const { clock, seen } = world(on, '["Run the retry tests", "Commit the fix"]', true)
  await $.turn.complete(longTurn)
  await clock.settle()
  expect(seen.opened).toBe(1)

  const pane = await $.ui.mount({
    plugin: 'next-steps',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'next-steps',
    props: { bodyColumns: 100 } as never,
  })
  await pane.press({ key: 'step-0' })
  await pane.press({ key: 'step-1' })
  expect((await pane.find({ key: 'insert' }))?.text).toContain('2 steps')
  await pane.press({ key: 'insert' })
  expect(seen.filled).toEqual(['Run the retry tests\n\nCommit the fix'])
  // Inserted: the suggestions fold away and the pane closes.
  expect(seen.closed).toBeGreaterThan(0)
  await pane.unmount()
})

test('select all ticks every step and clear unticks them', async ($, on) => {
  const { clock, seen } = world(on, '["Run the retry tests", "Commit the fix", "Push the branch"]', true)
  await $.turn.complete(longTurn)
  await clock.settle()
  const pane = await $.ui.mount({
    plugin: 'next-steps',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'next-steps',
    props: { bodyColumns: 100 } as never,
  })
  await pane.press({ key: 'all' })
  expect((await pane.find({ key: 'insert' }))?.text).toContain('3 steps')
  await pane.press({ key: 'clear' })
  expect((await pane.find({ key: 'insert' }))?.text).toContain('Tick steps')
  await pane.press({ key: 'all' })
  await pane.press({ key: 'insert' })
  expect(seen.filled).toEqual(['Run the retry tests\n\nCommit the fix\n\nPush the branch'])
  await pane.unmount()
})
