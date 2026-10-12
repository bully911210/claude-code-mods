import { mock, test } from 'claude-code/testing'

const FIVE = JSON.stringify({
  questions: [
    { title: 'Retry ceiling', question: 'What happens to queued jobs when the retry limit is hit mid-deploy in src/worker.ts?' },
    { title: 'Missing tests', question: 'Which failure paths in the new retry logic have no test yet, and can you write them?' },
    { title: 'Config drift', question: 'Do staging and production read the same RETRY_MAX, or can they drift apart?' },
    { title: 'Idempotency', question: 'Is the payment step safe to run twice if a retry fires after a timeout?' },
    { title: 'Observability', question: 'How would we notice in the logs that retries are silently masking a real outage?' },
  ],
})
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 150 } as never
const PANE = { bodyColumns: 96 } as never
const out = (name: string, tree: unknown, extra: Record<string, unknown> = {}) => console.log(`CAPTURE ${JSON.stringify({ name, tree, ...extra })}`)

test('capture', async ($, on) => {
  const now = new Date(2026, 9, 12, 14, 12).getTime()
  const clock = mock.clock(on, { now })
  mock.store(on)
  const fills: string[] = []
  let call = 0
  on('session.usage', () => {
    call += 1
    return {
      value: {
        startedAt: 0,
        context: { tokens: 1, window: 200_000, percent: 41 },
        rateLimits: [
          { kind: 'five_hour', percentUsed: call > 1 ? 34 : 31, resetsAt: new Date(2026, 9, 12, 16, 30).toISOString() },
          { kind: 'seven_day', percentUsed: 58 },
        ],
        cost: { usd: 0 },
      },
    }
  }) as never
  on('session.root', () => ({ value: 'C:/work/my-app' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', ($, e) =>
    ((e as { as?: string }).as === 'api'
      ? { value: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] }
      : { value: [{ role: 'user', text: 'Add retries to the worker', toolUses: [] }, { role: 'assistant', text: 'Done.', toolUses: [] }] }) as never,
  )
  on('fs.ancestors', () => ({ value: [] }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('model.complete', () => ({ value: { isAnswered: true, text: FIVE, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) as never)
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }) as never)
  on('prompt.fill', ($, e) => {
    fills.push(e.text)
    return { isFilled: true } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', () => ({ cwd: 'C:/work/my-app' }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* ($, e) {
    return { turnId: (e as { turnId: string }).turnId, index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 400, output_tokens: 900, cache_read_input_tokens: 96_000, cache_creation_input_tokens: 4_000, model: 'claude-opus-5-5' } } as never
  })

  await $.session.start({ cwd: 'C:/work/my-app', surface: 'terminal', isInteractive: true })
  for (const id of ['t1', 't2']) {
    const s = $.turn.step({ turnId: id, index: 0, model: 'claude-opus-5-5', messageCount: 1, effort: 'high' } as never)
    for await (const _ of s) {
      // drain
    }
    await clock.advance(60_000)
    await $.turn.complete({ answer: 'ok', durationMs: 3000, isAborted: false, turnId: id, reason: 'answer', usage: { input_tokens: 400, output_tokens: 900, cache_read_input_tokens: 96_000, cache_creation_input_tokens: 4_000, model: 'claude-opus-5-5' } } as never)
  }
  const band = await $.ui.mount({ plugin: 'token-ledger', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  out('band', await band.drawn())
  await band.press({ key: 'ask' })
  await clock.settle()
  out('band-after', await band.drawn())
  const pane = await $.ui.mount({ plugin: 'token-ledger', surface: 'terminal', component: 'Pane', requestId: 'insights', props: PANE })
  out('pane-0', await pane.drawn())
  await pane.press({ key: 'q-1' })
  out('pane-1', await pane.drawn())
  await pane.press({ key: 'q-3' })
  out('pane-2', await pane.drawn())
  await pane.press({ key: 'all' })
  out('pane-all', await pane.drawn())
  await pane.press({ key: 'clear' })
  await pane.press({ key: 'q-1' })
  await pane.press({ key: 'q-3' })
  await pane.press({ key: 'insert' })
  out('filled', null, { fills })
  const ledger = await $.ui.mount({ plugin: 'token-ledger', surface: 'terminal', component: 'Pane', requestId: 'ledger', props: PANE })
  out('ledger', await ledger.drawn())
})
