import { mock, test } from 'claude-code/testing'

const STEPS = JSON.stringify([
  'Run the worker tests and fix any retry failures',
  'Add a test for the payment step running twice after a timeout',
  'Commit the retry changes with a conventional commit message',
])
const out = (name: string, tree: unknown, extra: Record<string, unknown> = {}) => console.log(`CAPTURE ${JSON.stringify({ name, tree, ...extra })}`)

test('capture', async ($, on) => {
  const clock = mock.clock(on)
  const fills: string[] = []
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('session.root', () => ({ value: 'C:/work/my-app' }))
  on('model.complete', () => ({ value: { isAnswered: true, text: STEPS, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) as never)
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }) as never)
  on('prompt.fill', ($, e) => {
    fills.push(e.text)
    return { isFilled: true } as never
  })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer: 'I added exponential backoff to src/worker.ts and wired RETRY_MAX through the config. '.repeat(5), durationMs: 5000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'next-steps', surface: 'terminal', component: 'Pane', requestId: 'next-steps', props: { bodyColumns: 96 } as never })
  out('steps-0', await pane.drawn())
  await pane.press({ key: 'step-0' })
  out('steps-1', await pane.drawn())
  await pane.press({ key: 'step-2' })
  out('steps-2', await pane.drawn())
  await pane.press({ key: 'all' })
  out('steps-all', await pane.drawn())
  await pane.press({ key: 'clear' })
  await pane.press({ key: 'step-0' })
  await pane.press({ key: 'step-2' })
  await pane.press({ key: 'insert' })
  out('steps-filled', null, { fills })
})
