// Pure drawing of the /brief pane: what the mod believes about the project and
// the user, so it can be read and corrected. Handlers come in from the hooks module.

import type { Elements } from 'claude-code'

import type { Signal } from './lib/memory'

type Table = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

export type MemoryView = {
  readonly projectName: string
  readonly brief: string
  readonly profile: string
  readonly signals: readonly Signal[]
  readonly folds: number
  readonly updatedAt: number
}

const SIGNALS_SHOWN = 10
const NOTHING = 'Nothing recorded yet. It builds up as you work.'

const KIND_LABEL: Readonly<Record<Signal['kind'], string>> = {
  correction: 'you corrected',
  frustration: 'you were frustrated',
  accepted: 'you used',
  ignored: 'you skipped',
}

const when = (at: number): string =>
  at > 0 ? new Date(at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never'

export const memoryPane = (
  els: Table,
  m: MemoryView,
  on: { readonly forget: () => void; readonly close: () => void },
) => {
  const { Box, Text, Button } = els
  const recent = m.signals.slice(-SIGNALS_SHOWN).reverse()
  return (
    <Box flexDirection="column">
      <Text bold>About you</Text>
      <Text wrap="wrap">{m.profile === '' ? NOTHING : m.profile}</Text>
      <Box key="project" flexDirection="column" marginTop={1}>
        <Text bold>{m.projectName === '' ? 'This project' : m.projectName}</Text>
        <Text wrap="wrap">{m.brief === '' ? NOTHING : m.brief}</Text>
      </Box>
      <Box key="signals" flexDirection="column" marginTop={1}>
        <Text bold>What you've told it</Text>
        {recent.length === 0 && <Text dimColor>No feedback recorded yet.</Text>}
        {recent.map((s, i) => (
          <Text key={`sig-${i}`} dimColor wrap="wrap">
            {KIND_LABEL[s.kind]}: {s.text}
          </Text>
        ))}
      </Box>
      <Box key="foot" flexDirection="column" marginTop={1}>
        <Text dimColor>
          Updated {when(m.updatedAt)} · {m.folds} turn{m.folds === 1 ? '' : 's'} folded in
        </Text>
        <Text dimColor wrap="wrap">
          Fix it: /brief brief &lt;text&gt; · /brief profile &lt;text&gt; · /brief forget · /brief reset
        </Text>
      </Box>
      <Box key="actions" flexDirection="row" marginTop={1} gap={2}>
        <Button key="forget" hotkey="f" plain dimColor label="Forget feedback" onPress={on.forget} />
        <Button key="close" plain dimColor role="dismiss" label="Close" onPress={on.close} />
      </Box>
    </Box>
  )
}
