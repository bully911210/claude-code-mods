import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import { buildPrompt, fileNameOf, fillPlan, parseSteps, shouldSuggest, SYSTEM } from './lib/steps'

const stepsAtom = atom({ plugin: 'next-steps', key: 'steps' } as const, [] as string[])
const mutedAtom = atom({ plugin: 'next-steps', key: 'isMuted' } as const, false)
/** Indexes ticked for insertion, in the order they were ticked. */
const pickedAtom = atom({ plugin: 'next-steps', key: 'picked' } as const, [] as number[])
/** True when the pane could not be placed and the suggestions fall back into the band. */
const inBandAtom = atom({ plugin: 'next-steps', key: 'inBand' } as const, false)

const PANE = 'next-steps'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const HOTKEYS = ['1', '2', '3']

type Ask = { readonly answer: string; readonly files: readonly string[]; readonly model: string }

/** One small completion; a failure leaves the band empty, never an error. */
async function suggest($: EngineInterface, ask: Ask): Promise<void> {
  if (await read($, mutedAtom)) return
  const project = fileNameOf(await $.session.root())
  const reply = await $.model.complete({
    model: ask.model,
    system: SYSTEM,
    prompt: buildPrompt({ answer: ask.answer, files: ask.files, project }),
    maxTokens: 300,
    effort: 'low',
    timeoutMs: 20_000,
  })
  if (!reply.isAnswered) return
  const steps = parseSteps(reply.text)
  await update($, stepsAtom, () => steps)
  await update($, pickedAtom, () => [])
  if (steps.length === 0) return
  const opened = await $.ui.open({ id: PANE, title: 'Next steps' }).catch(() => ({ isPlaced: false }))
  await update($, inBandAtom, () => !opened.isPlaced)
}

async function lastAnswer($: EngineInterface): Promise<string> {
  const messages = await $.session.messages()
  if ('deny' in messages) return ''
  return [...messages].reverse().find(m => m.role === 'assistant' && m.text.trim() !== '')?.text ?? ''
}

type Table = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

/** Clears the suggestions and closes their pane. */
async function clearSteps($: EngineInterface): Promise<void> {
  await update($, stepsAtom, () => [])
  await update($, pickedAtom, () => [])
  await update($, inBandAtom, () => false)
  await $.ui.close({ id: PANE }).catch(() => undefined)
}

/** Ticks a step on or off. Any number may be ticked before they go in together. */
async function toggleStep($: EngineInterface, index: number): Promise<void> {
  await update($, pickedAtom, list => (list.includes(index) ? list.filter(i => i !== index) : [...list, index]))
}

/** Ticks every step, keeping the order of any already ticked first. */
async function pickAll($: EngineInterface): Promise<void> {
  const steps = await read($, stepsAtom)
  await update($, pickedAtom, list => [...list, ...steps.map((_, i) => i).filter(i => !list.includes(i))])
}

/** Puts every ticked step in the prompt box without sending it, keeping any text already there. */
async function insertSteps($: EngineInterface): Promise<void> {
  const steps = await read($, stepsAtom)
  const picked = await read($, pickedAtom)
  const text = picked
    .map(i => steps[i] ?? '')
    .filter(t => t !== '')
    .join('\n\n')
  if (text === '') return
  const box = await $.prompt.read().catch(() => ({ text: '' }))
  const plan = fillPlan(box.text, text)
  const filled = await $.prompt.fill({ text: plan.text, mode: plan.mode }).catch(() => ({ isFilled: false }))
  if (filled.isFilled) await clearSteps($)
}

/** The label of the insert action: it names how many steps are going in. */
export const insertLabel = (count: number): string =>
  count === 0 ? 'Tick steps to insert' : count === 1 ? 'Insert 1 step' : `Insert ${count} steps`

/**
 * The suggestions as a checklist: tick as many as you want, then insert them together.
 * Ticked rows draw bright and unticked rows dim, and Insert is always on show,
 * so the pane reads as multi-select before anything is pressed.
 */
function stepsTree($: EngineInterface, els: Table, steps: readonly string[], picked: readonly number[], columns: number) {
  const { Box, Button, Text } = els
  const width = Math.max(20, columns - 12)
  const isClipped = (t: string): boolean => t.length > width
  const clip = (t: string): string => (isClipped(t) ? `${t.slice(0, width - 1)}…` : t)
  const count = picked.length
  const isAllPicked = count === steps.length
  return (
    <Box key="steps" flexDirection="column">
      <Text dimColor>Tick any number (click or 1-{steps.length}), then insert them together.</Text>
      {steps.map((step, i) => {
        const isPicked = picked.includes(i)
        return (
          <Box key={`row-${i}`} flexDirection="column" marginTop={1}>
            <Button
              key={`step-${i}`}
              hotkey={HOTKEYS[i]}
              plain
              dimColor={!isPicked}
              label={`${isPicked ? '[x]' : '[ ]'} ${clip(step)}`}
              onPress={() => {
                void toggleStep($, i)
              }}
            />
            {isClipped(step) && (
              <Text dimColor wrap="wrap">
                {step}
              </Text>
            )}
          </Box>
        )
      })}
      <Box key="actions" flexDirection="row" gap={2} marginTop={1}>
        <Button
          key="insert"
          hotkey="i"
          variant="primary"
          dimColor={count === 0}
          label={insertLabel(count)}
          onPress={() => {
            void insertSteps($)
          }}
        />
        {isAllPicked ? (
          <Button
            key="clear"
            hotkey="c"
            dimColor
            label="Clear"
            onPress={() => {
              void update($, pickedAtom, () => [])
            }}
          />
        ) : (
          <Button
            key="all"
            hotkey="a"
            dimColor
            label="Select all"
            onPress={() => {
              void pickAll($)
            }}
          />
        )}
        <Button
          key="dismiss"
          role="dismiss"
          plain
          dimColor
          label="Dismiss"
          onPress={() => {
            void clearSteps($)
          }}
        />
      </Box>
    </Box>
  )
}

export const register: Register = (on, options) => {
  const model = typeof options.model === 'string' && options.model !== '' ? options.model : 'haiku'
  const minAnswerChars = typeof options.minAnswerChars === 'number' ? options.minAnswerChars : 300

  // What this turn did, for the suggestion prompt. Reset on each prompt.
  let toolCalls = 0
  let files: string[] = []

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'next',
      description: 'Next steps: refresh the suggestions, or turn them on or off',
      argumentHint: '[on|off]',
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    toolCalls = 0
    files = []
    await clearSteps($)
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    if (e.agentId === undefined) {
      toolCalls += 1
      const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : ''
      if (EDIT_TOOLS.has(String(e.tool)) && path !== '' && !files.includes(path)) files = [...files, path]
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const isMainAnswer = e.agentId === undefined && e.reason === 'answer' && !e.isAborted
    if (isMainAnswer && shouldSuggest({ answer: e.answer, toolCalls, minAnswerChars })) {
      const ask: Ask = { answer: e.answer, files: files.map(fileNameOf), model }
      // Off the turn's path: the turn ends now, the band fills a moment later.
      $.clock.after(0, () => {
        void suggest($, ask).catch(() => undefined)
      })
    }
    return result
  })

  on('command.run', { command: 'next' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      await update($, mutedAtom, () => true)
      await clearSteps($)
      return { text: 'Next-step suggestions are off for this session.' }
    }
    await update($, mutedAtom, () => false)
    if (arg === 'on') return { text: 'Next-step suggestions are on.' }
    const answer = await lastAnswer($)
    if (answer === '') return { text: 'No answer yet to suggest from.' }
    await suggest($, { answer, files: files.map(fileNameOf), model })
    const steps = await read($, stepsAtom)
    return { text: steps.length ? `Suggested:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : 'Nothing to suggest.' }
  })

  // The suggestions get a pane of their own, so the band above the prompt — the
  // token-ledger bar — is never replaced and never scrolls with them. Only a
  // terminal too narrow for a pane falls back to the band.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const width = e.viewport?.columns ?? 80
    return stepsTree($, $.ui.resolve(e), await read($, stepsAtom), await read($, pickedAtom), width)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const steps = await read($, stepsAtom)
    const isInBand = await read($, inBandAtom)
    if (e.props.hasSurvey || steps.length === 0 || !isInBand || (await read($, mutedAtom))) return next(e)
    return stepsTree($, $.ui.resolve(e), steps, await read($, pickedAtom), e.props.bodyColumns ?? 80)
  })
}
