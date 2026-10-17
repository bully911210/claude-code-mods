import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { INSIGHT_MODEL } from '../hooks/lib/insights'
import { FOLD_SYSTEM } from '../hooks/lib/memory'

// The whole loop through the real hooks: a turn is folded into memory, and the
// "?" button then reads that memory instead of the raw chat.

const FIVE = JSON.stringify({
  questions: [1, 2, 3, 4, 5].map(n => ({ title: `Angle ${n}`, question: `Question number ${n} about the Acme campaign?` })),
})

const FOLD = JSON.stringify({
  brief: 'Acme Outdoors lead-gen campaign: Meta ads feeding a WhatsApp follow-up; cost per lead is the number that matters.',
  profile: 'Sam runs marketing for several South African brands. Not a developer; wants expert, project-specific answers.',
})

const LONG_ANSWER = 'Here is how the campaign performed and what I suggest we change next. '.repeat(6)

type Opts = { foldReply?: string; foldAnswered?: boolean; userText?: string; earlier?: number }

const world = (on: On, o: Opts = {}) => {
  const clock = mock.clock(on)
  mock.store(on)
  const seen = { fold: 0, ask: [] as string[], fills: 0, pickedClosed: 0, foldPrompts: [] as string[] }
  const gate = { hold: false, release: () => {}, wait: Promise.resolve() }
  const userText = o.userText ?? "I'm not a developer, I run marketing for Acme Outdoors. Give me expert advice on the Acme campaign."
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1, window: 200_000, percent: 4 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('session.root', () => ({ value: 'C:/Clients/Acme Campaign' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', ($, e) =>
    ((e as { as?: string }).as === 'api'
      ? { value: [] }
      : {
          value: [
            ...Array.from({ length: o.earlier ?? 0 }, (_, i) => ({ role: 'user', text: `earlier message ${i}`, toolUses: [] })),
            { role: 'user', text: userText, toolUses: [] },
            { role: 'assistant', text: LONG_ANSWER, toolUses: [] },
          ],
        }) as never,
  )
  on('fs.ancestors', () => ({ value: [] }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('prompt.submit', () => ({ text: '' }) as never)
  on('model.complete', async ($, e) => {
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    if (e.system === FOLD_SYSTEM) {
      seen.fold += 1
      seen.foldPrompts.push(e.prompt)
      if (gate.hold) await gate.wait
      return { value: o.foldAnswered === false ? { isAnswered: false, reason: 'api-error', status: 529, usage } : { isAnswered: true, text: o.foldReply ?? FOLD, usage } } as never
    }
    expect(e.model).toBe(INSIGHT_MODEL)
    seen.ask.push(e.prompt)
    return { value: { isAnswered: true, text: FIVE, usage } } as never
  })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }) as never)
  on('prompt.fill', () => {
    seen.fills += 1
    return { isFilled: true } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', () => ({ cwd: 'C:/Clients/Acme Campaign' }))
  /** From now on a fold waits until release() is called, so the test can act while it is in flight. */
  const hold = () => {
    gate.hold = true
    gate.wait = new Promise<void>(resolve => {
      gate.release = () => {
        gate.hold = false
        resolve()
      }
    })
  }
  return { clock, seen, userText, hold, release: () => gate.release() }
}

/** A prompt typed by the person, as the engine stamps it. */
const say = ($: { prompt: { submit: (i: never) => Promise<unknown> } }, text: string, kind = 'composer') =>
  $.prompt.submit({ text, origin: { kind } } as never)

const endTurn = ($: { turn: { complete: (i: never) => Promise<unknown> } }, answer = LONG_ANSWER) =>
  $.turn.complete({
    answer,
    durationMs: 2_000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' },
  } as never)

const run = ($: { command: { run: (i: never) => Promise<unknown> } }, command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: {} } as never) as Promise<{ text?: string }>

test('a real turn is folded into memory, and ? reads it', async ($, on) => {
  const { clock, seen, userText } = world(on)
  await $.session.start({ cwd: 'C:/Clients/Acme Campaign', surface: 'terminal', isInteractive: true })
  await say($ as never, userText)
  await endTurn($ as never)
  await clock.settle()
  expect(seen.fold).toBe(1)
  await run($ as never, 'ask')
  await clock.settle()
  const prompt = seen.ask[0] ?? ''
  expect(prompt.startsWith('## About the user')).toBe(true)
  expect(prompt).toContain('Sam runs marketing for several South African brands')
  expect(prompt).toContain('cost per lead is the number that matters')
  expect(prompt).toContain("[correction] I'm not a developer")
})

test('a fresh project has no memory, so ? still gets the whole chat as before', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start({ cwd: 'C:/Clients/Acme Campaign', surface: 'terminal', isInteractive: true })
  await run($ as never, 'ask')
  await clock.settle()
  expect(seen.ask[0]).not.toContain('## About the user')
  expect(seen.ask[0]).toContain('## Conversation (oldest first)')
})

test('a short answer is not folded, but the correction is still remembered', async ($, on) => {
  const { clock, seen, userText } = world(on)
  await $.session.start({ cwd: 'C:/Clients/Acme Campaign', surface: 'terminal', isInteractive: true })
  await say($ as never, userText)
  await endTurn($ as never, 'Done.')
  await clock.settle()
  expect(seen.fold).toBe(0)
  await run($ as never, 'ask')
  await clock.settle()
  expect(seen.ask[0]).toContain("[correction] I'm not a developer")
})

test('a failed or garbled fold keeps memory exactly as it was and never throws', async ($, on) => {
  const { clock, seen, userText } = world(on, { foldAnswered: false, userText: 'Run the report please' })
  await $.session.start({ cwd: 'C:/Clients/Acme Campaign', surface: 'terminal', isInteractive: true })
  await say($ as never, userText)
  await endTurn($ as never)
  await clock.settle()
  expect(seen.fold).toBe(1)
  await run($ as never, 'ask')
  await clock.settle()
  expect(seen.ask[0]).not.toContain('## About the user')
})

test('frustration is remembered as frustration', async ($, on) => {
  const { clock, seen, userText } = world(on, { foldAnswered: false, userText: 'WHY DOES IT KEEP CALLING ME A DEVELOPER????' })
  await $.session.start({ cwd: 'C:/Clients/Acme Campaign', surface: 'terminal', isInteractive: true })
  await say($ as never, userText)
  await endTurn($ as never)
  await clock.settle()
  await run($ as never, 'ask')
  await clock.settle()
  expect(seen.ask[0]).toContain('[frustration] WHY DOES IT KEEP CALLING ME A DEVELOPER????')
})

test('/brief edits the notes, shows them, and resets the project', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start({ cwd: 'C:/Clients/Acme Campaign', surface: 'terminal', isInteractive: true })
  expect((await run($ as never, 'brief', 'brief The Acme campaign targets licensed boat owners in Western Cape.')).text).toContain('brief replaced')
  expect((await run($ as never, 'brief', 'profile Sam is the owner of Acme Marketing.')).text).toContain('profile replaced')
  expect((await run($ as never, 'brief')).text).toContain('what the mod knows')
  await run($ as never, 'ask')
  await clock.settle()
  expect(seen.ask[0]).toContain('licensed boat owners in Western Cape')
  expect(seen.ask[0]).toContain('owner of Acme Marketing')

  expect((await run($ as never, 'brief', 'reset')).text).toContain('cleared')
  await run($ as never, 'ask')
  await clock.settle()
  expect(seen.ask[1]).not.toContain('licensed boat owners in Western Cape')
  // The profile belongs to the user, not the project, so a reset keeps it.
  expect(seen.ask[1]).toContain('owner of Acme Marketing')
})

test('a bad /brief command explains itself and changes nothing', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start({ cwd: 'C:/Clients/Acme Campaign', surface: 'terminal', isInteractive: true })
  expect((await run($ as never, 'brief', 'banana')).text).toMatch(/show|brief|profile|forget|reset/)
  expect((await run($ as never, 'brief', 'reset everything')).text).not.toContain('cleared')
  await run($ as never, 'ask')
  await clock.settle()
  expect(seen.ask[0]).not.toContain('## About the user')
})

test('suggestions the user took or skipped become feedback for the next ?', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start({ cwd: 'C:/Clients/Acme Campaign', surface: 'terminal', isInteractive: true })
  await run($ as never, 'ask')
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'token-ledger', surface: 'terminal', component: 'Pane', requestId: 'insights', props: { bodyColumns: 100 } as never })
  await pane.press({ key: 'q-1' })
  await pane.press({ key: 'insert' })
  await pane.unmount()
  await clock.settle()
  expect(seen.fills).toBe(1)
  await run($ as never, 'ask')
  await clock.settle()
  const second = seen.ask[1] ?? ''
  expect(second).toContain('[accepted] Question number 2 about the Acme campaign?')
  expect(second).toContain('[ignored] Question number 1 about the Acme campaign?')
})

test('a fold in flight cannot undo feedback recorded or cleared meanwhile', async ($, on) => {
  const { clock, seen, userText, hold, release } = world(on)
  await $.session.start({ cwd: 'C:/Clients/Acme Campaign', surface: 'terminal', isInteractive: true })
  await run($ as never, 'ask')
  await clock.settle()
  hold()
  await say($ as never, userText)
  await endTurn($ as never)
  // The fold is now waiting on Haiku. The person dismisses the questions meanwhile.
  const pane = await $.ui.mount({ plugin: 'token-ledger', surface: 'terminal', component: 'Pane', requestId: 'insights', props: { bodyColumns: 100 } as never })
  await pane.press({ key: 'close' })
  await pane.unmount()
  release()
  await clock.settle()
  await run($ as never, 'ask')
  await clock.settle()
  // Five were skipped; the prompt shows the newest few so they never crowd out the person's own words.
  expect(seen.ask.at(-1)).toContain('[ignored] Question number 5 about the Acme campaign?')
  expect(seen.ask.at(-1)).toContain('cost per lead is the number that matters')
})

test('/brief forget during a fold stays forgotten', async ($, on) => {
  const { clock, seen, userText, hold, release } = world(on)
  await $.session.start({ cwd: 'C:/Clients/Acme Campaign', surface: 'terminal', isInteractive: true })
  hold()
  await say($ as never, userText)
  await endTurn($ as never)
  await run($ as never, 'brief', 'forget')
  release()
  await clock.settle()
  await run($ as never, 'ask')
  await clock.settle()
  expect(seen.ask[0]).not.toContain('[correction]')
})

test('a turn that ends while a fold runs is not lost: its feedback is kept and it is folded next', async ($, on) => {
  const { clock, seen, hold, release } = world(on)
  await $.session.start({ cwd: 'C:/Clients/Acme Campaign', surface: 'terminal', isInteractive: true })
  hold()
  await say($ as never, 'First question about the Acme ads')
  await endTurn($ as never)
  await say($ as never, "No, that's wrong. Use the Western Cape list")
  await endTurn($ as never)
  release()
  await clock.settle()
  expect(seen.fold).toBe(2)
  await run($ as never, 'ask')
  await clock.settle()
  expect(seen.ask[0]).toContain("[correction] No, that's wrong. Use the Western Cape list")
})

test('only a prompt the person typed is learned from', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start({ cwd: 'C:/Clients/Acme Campaign', surface: 'terminal', isInteractive: true })
  await say($ as never, "Build finished: that's wrong, don't use this", 'task-notification')
  await endTurn($ as never)
  await say($ as never, 'Nightly check', 'scheduled-trigger')
  await endTurn($ as never)
  await clock.settle()
  expect(seen.fold).toBe(0)
  await run($ as never, 'ask')
  await clock.settle()
  expect(seen.ask[0]).not.toContain('## About the user')
})

test('a continuation with no new prompt does not fold the old prompt again', async ($, on) => {
  const { clock, seen, userText } = world(on)
  await $.session.start({ cwd: 'C:/Clients/Acme Campaign', surface: 'terminal', isInteractive: true })
  await say($ as never, userText)
  await endTurn($ as never)
  await endTurn($ as never)
  await clock.settle()
  expect(seen.fold).toBe(1)
})

test('feedback alone, with no brief yet, does not cost ? the chat history', async ($, on) => {
  const { clock, seen } = world(on, { foldAnswered: false, userText: "No, that's wrong", earlier: 20 })
  await $.session.start({ cwd: 'C:/Clients/Acme Campaign', surface: 'terminal', isInteractive: true })
  await say($ as never, "No, that's wrong")
  await endTurn($ as never)
  await clock.settle()
  await run($ as never, 'ask')
  await clock.settle()
  expect(seen.ask[0]).toContain("[correction] No, that's wrong")
  expect(seen.ask[0]).toContain('earlier message 0')
})

test('personal details in what was said are redacted before the fold call', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start({ cwd: 'C:/Clients/Acme Campaign', surface: 'terminal', isInteractive: true })
  await say($ as never, 'Email jane@example.com about ID 8001015009087 on the Acme campaign')
  await endTurn($ as never)
  await clock.settle()
  expect(seen.foldPrompts[0]).not.toContain('jane@example.com')
  expect(seen.foldPrompts[0]).not.toContain('8001015009087')
})

test('when a fold is slow and many turns pile up, none of them is lost', async ($, on) => {
  const { clock, seen, hold, release } = world(on)
  await $.session.start({ cwd: 'C:/Clients/Acme Campaign', surface: 'terminal', isInteractive: true })
  hold()
  for (let i = 1; i <= 6; i += 1) {
    await say($ as never, `Question number ${i} about the Acme ads`)
    await endTurn($ as never)
  }
  release()
  await clock.settle()
  const all = seen.foldPrompts.join('\n')
  for (let i = 1; i <= 6; i += 1) expect(all).toContain(`Question number ${i} about the Acme ads`)
})
