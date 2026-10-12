// Pure drawings for the Haiku insight launcher: the "?" button in the
// telemetry row and the suggestions pane. Handlers come in from the hooks module.

import type { Elements } from 'claude-code'

import type { Insight } from './lib/insights'

type Table = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

export type InsightStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

export type InsightsState = {
  readonly status: InsightStatus
  readonly items: readonly Insight[]
  /** Indexes ticked for insertion, in the order they were ticked. */
  readonly picked: readonly number[]
  readonly error: string
  readonly insertError: string
}

export const TOOLTIP = 'Generate insightful questions with Haiku'

/** The hover card that names the launcher. */
const tooltip = (els: Table, isBusy: boolean) => {
  const { Box, Text } = els
  return (
    <Box position="absolute" bottom={1} right={0} display="none" hover={{ display: 'flex' }} paddingX={1} borderStyle="round" borderDimColor>
      <Text dimColor wrap="truncate">
        {isBusy ? 'Haiku is thinking…' : TOOLTIP}
      </Text>
    </Box>
  )
}

/** The "?" launcher at the row's far right: "…" and inert while Haiku works; a hover card names it. */
export const askButton = (els: Table, status: InsightStatus, onPress: () => void) => {
  const { Box, Button } = els
  const isBusy = status === 'loading'
  return (
    <Box key="ask-scope" flexDirection="row" alignItems="center" position="relative" marginLeft={2}>
      <Button key="ask" plain dimColor={isBusy} label={isBusy ? '…' : '?'} onPress={onPress} />
      {tooltip(els, isBusy)}
    </Box>
  )
}

const HOTKEYS = ['1', '2', '3', '4', '5']

/** The label of the insert action: it names how many questions are going in. */
export const insertLabel = (count: number): string =>
  count === 0 ? 'Tick questions to insert' : count === 1 ? 'Insert 1 question' : `Insert ${count} questions`

export const insightsPane = (
  els: Table,
  s: InsightsState,
  width: number,
  on: {
    readonly toggle: (i: number) => void
    readonly all: (isOn: boolean) => void
    readonly insert: () => void
    readonly retry: () => void
    readonly close: () => void
  },
) => {
  const { Box, Text, Button } = els
  const room = Math.max(20, width - 8)
  const clip = (t: string): string => (t.length > room ? `${t.slice(0, room - 1)}…` : t)
  const isPicked = (i: number): boolean => s.picked.includes(i)
  const count = s.picked.length
  const isAllPicked = s.items.length > 0 && count === s.items.length
  return (
    <Box flexDirection="column">
      {s.status === 'loading' && <Text dimColor>Haiku is reading the conversation and project…</Text>}
      {s.status === 'empty' && <Text>Haiku returned no usable questions. Try again.</Text>}
      {s.status === 'error' && <Text color="error">Couldn't generate questions: {s.error}</Text>}
      {s.status === 'ready' && (
        <Text dimColor>Tick any number (click or {s.items.length === 1 ? 'press 1' : `1-${s.items.length}`}), then insert them together.</Text>
      )}
      {s.status === 'ready' &&
        s.items.map((item, i) => (
          <Box key={`row-${i}`} flexDirection="column" marginBottom={i < s.items.length - 1 ? 1 : 0}>
            <Button
              key={`q-${i}`}
              hotkey={HOTKEYS[i]}
              dimColor={!isPicked(i)}
              label={`${isPicked(i) ? '[x]' : '[ ]'} ${clip(item.title)}`}
              onPress={() => on.toggle(i)}
            />
            <Text dimColor wrap="wrap">
              {item.question}
            </Text>
          </Box>
        ))}
      {s.insertError !== '' && <Text color="warning">{s.insertError}</Text>}
      <Box key="actions" flexDirection="row" marginTop={1} gap={2}>
        {s.status === 'ready' && (
          <Button key="insert" hotkey="i" variant="primary" dimColor={count === 0} label={insertLabel(count)} onPress={on.insert} />
        )}
        {s.status === 'ready' &&
          (isAllPicked ? (
            <Button key="clear" hotkey="c" dimColor label="Clear" onPress={() => on.all(false)} />
          ) : (
            <Button key="all" hotkey="a" dimColor label="Select all" onPress={() => on.all(true)} />
          ))}
        {(s.status === 'error' || s.status === 'empty' || s.status === 'ready') && (
          <Button key="retry" plain dimColor label={s.status === 'ready' ? 'Regenerate' : 'Try again'} onPress={on.retry} />
        )}
        <Button key="close" plain dimColor role="dismiss" label="Close" onPress={on.close} />
      </Box>
    </Box>
  )
}
