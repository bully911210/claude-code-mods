// The engine side of the memory: where it is kept, when it is folded, and the
// /brief command. The pure rules (what a signal is, how a fold is read) live in
// lib/memory.ts and are tested there.

import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { INSIGHT_MODEL } from './lib/insights'
import {
  addSignal,
  applyFold,
  asProfileMemory,
  asProjectMemory,
  buildFoldPrompt,
  classifyUserMessage,
  EMPTY_PROJECT,
  FOLD_SYSTEM,
  parseBriefCommand,
  parseFold,
  projectKey,
  renderMemory,
  shouldFold,
} from './lib/memory'
import type { FoldResult, ProfileMemory, ProjectMemory, Signal } from './lib/memory'
import type { MemoryView } from './memoryView'

export const MEMORY_PANE = 'brief'

const PROFILE_STORE_KEY = 'mem:profile'
const FOLD_MAX_TOKENS = 2_000
const FOLD_TIMEOUT_MS = 60_000

// The pane's drawing reads the same value from register.tsx, where it is declared again: the state scan wants the atom in the file that reads it.
const memoryAtom = atom(
  { plugin: 'token-ledger', key: 'memory' } as const,
  { projectName: '', brief: '', profile: '', signals: [] as Signal[], folds: 0, updatedAt: 0 } as MemoryView & { signals: Signal[] },
)

type Loaded = {
  readonly storeKey: string
  readonly name: string
  readonly project: ProjectMemory
  readonly profile: ProfileMemory
}

const folderName = (root: string): string => root.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? root

async function load($: EngineInterface): Promise<Loaded> {
  const root = await $.session.root()
  const storeKey = `mem:project:${projectKey(root)}`
  const [project, profile] = await Promise.all([$.store.get(storeKey), $.store.get(PROFILE_STORE_KEY)])
  return { storeKey, name: folderName(root), project: asProjectMemory(project), profile: asProfileMemory(profile) }
}

/** Writes both notes, then redraws the /brief pane from what was written. */
async function save($: EngineInterface, loaded: Loaded, project: ProjectMemory, profile: ProfileMemory): Promise<void> {
  await $.store.set(loaded.storeKey, project)
  await $.store.set(PROFILE_STORE_KEY, profile)
  await show($, { ...loaded, project, profile })
}

async function show($: EngineInterface, l: Loaded): Promise<void> {
  await update($, memoryAtom, () => ({
    projectName: l.name,
    brief: l.project.brief,
    profile: l.profile.profile,
    signals: [...l.project.signals],
    folds: l.project.folds,
    updatedAt: Math.max(l.project.updatedAt, l.profile.updatedAt),
  }))
}

/** Loads the current project's memory into the pane's value. */
export async function refreshMemoryView($: EngineInterface): Promise<void> {
  await show($, await load($))
}

/**
 * The block `?` reads. `text` is '' when nothing is known yet. `hasBrief` is false
 * while only feedback exists, so `?` keeps the chat history until a brief stands in for it.
 */
export async function memoryBlock($: EngineInterface): Promise<{ readonly text: string; readonly hasBrief: boolean }> {
  const { project, profile } = await load($)
  const hasBrief = project.brief !== ''
  if (!hasBrief && profile.profile === '' && project.signals.length === 0) return { text: '', hasBrief }
  return { text: renderMemory(project, profile), hasBrief }
}

// Every read-modify-write of the stored notes runs through this one line, so a
// slow fold, a dismissed suggestion list and a /brief edit can never overwrite each other.
let writeLine: Promise<unknown> = Promise.resolve()

function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = writeLine.then(job, job)
  writeLine = run.catch(() => undefined)
  return run
}

/** Adds feedback signals (picked or skipped suggestions) to this project's log. */
export async function recordSignals($: EngineInterface, signals: readonly Signal[]): Promise<void> {
  if (signals.length === 0) return
  await serial(async () => {
    const l = await load($)
    const merged = signals.reduce<readonly Signal[]>((all, s) => addSignal(all, s), l.project.signals)
    await save($, l, { ...l.project, signals: merged }, l.profile)
  })
}

/** Humans type prompts in the composer or through the remote bridge; notifications, schedules and peers are not them. */
const HUMAN_ORIGINS: readonly string[] = ['composer', 'bridge']

// The last prompt the person typed, waiting for its turn to end. Taken once, so a
// continuation turn with no new prompt cannot learn from the old one again.
let typedPrompt = ''

type PromptSeen = {
  readonly text: string
  readonly origin?: { readonly kind?: string }
  readonly isMeta?: boolean
  readonly command?: unknown
}

/** Remembers a prompt only when a person typed it and it is not a slash command. */
export function noteUserPrompt(p: PromptSeen): void {
  const isHuman = HUMAN_ORIGINS.includes(p.origin?.kind ?? '')
  const text = p.text.trim()
  if (!isHuman || p.isMeta === true || p.command !== undefined || text === '' || text.startsWith('/')) return
  typedPrompt = p.text
}

const takePrompt = (): string => {
  const text = typedPrompt
  typedPrompt = ''
  return text
}

type Exchange = { readonly user: string; readonly assistant: string }

// One fold at a time. A turn that ends meanwhile waits here, so none is dropped.
let isFolding = false
const waiting: Exchange[] = []
const WAITING_MAX = 3

/** Haiku folds one exchange into fresh copies of the notes; the model call itself holds no lock. */
async function foldOne($: EngineInterface, turn: Exchange): Promise<void> {
  const before = await load($)
  const reply = await $.model.complete({
    model: INSIGHT_MODEL,
    system: FOLD_SYSTEM,
    prompt: buildFoldPrompt(before.project.brief, before.profile.profile, { ...turn, signals: [] }),
    maxTokens: FOLD_MAX_TOKENS,
    effort: 'low',
    timeoutMs: FOLD_TIMEOUT_MS,
  })
  const result: FoldResult | null = reply.isAnswered ? parseFold(reply.text) : null
  if (result === null || (result.brief === '' && result.profile === '')) return
  const at = await $.clock.now()
  await serial(async () => {
    const fresh = await load($)
    const next = applyFold(fresh.project, fresh.profile, result, [], at)
    await save($, fresh, next.project, next.profile)
  })
}

/**
 * After a real turn: remember the person's feedback at once, then let Haiku fold
 * the exchange into the brief and profile in the background. Any failure leaves
 * the old memory exactly as it was.
 */
export async function foldAfterTurn($: EngineInterface, answer: string): Promise<void> {
  const user = takePrompt()
  if (user === '') return
  try {
    const kind = classifyUserMessage(user)
    if (kind !== null) await recordSignals($, [{ kind, text: user, at: await $.clock.now() }])
    const turn: Exchange = { user, assistant: answer }
    if (!shouldFold({ ...turn, signals: [] })) return
    if (isFolding) {
      if (waiting.length < WAITING_MAX) waiting.push(turn)
      return
    }
    isFolding = true
    try {
      for (let next: Exchange | undefined = turn; next !== undefined; next = waiting.shift()) {
        await foldOne($, next).catch(() => undefined)
      }
    } finally {
      isFolding = false
    }
  } catch {
    // Memory is a help, never a risk to the turn: keep what was there.
  }
}

/** Runs one /brief command and answers in a line; `show` also opens the pane. */
export async function runBriefCommand($: EngineInterface, args: string): Promise<string> {
  const cmd = parseBriefCommand(args)
  if (cmd.action === 'invalid') return cmd.reason
  if (cmd.action === 'show') {
    await show($, await load($))
    const opened = await $.ui.open({ id: MEMORY_PANE, title: 'What I know about you and this project' })
    return opened.isPlaced ? 'Showing what the mod knows about you and this project.' : 'Widen the terminal to see the memory pane.'
  }
  const now = await $.clock.now()
  return serial(async () => {
    const l = await load($)
    switch (cmd.action) {
      case 'set-brief':
        await save($, l, { ...l.project, brief: cmd.text, updatedAt: now }, l.profile)
        return 'Project brief replaced.'
      case 'set-profile':
        await save($, l, l.project, { profile: cmd.text, updatedAt: now })
        return 'Your profile replaced.'
      case 'forget-signals':
        await save($, l, { ...l.project, signals: [], updatedAt: now }, l.profile)
        return 'Feedback log cleared for this project.'
      case 'reset':
        await save($, l, EMPTY_PROJECT, l.profile)
        return "This project's brief and feedback cleared. Your profile is kept (replace it with /brief profile <text>)."
    }
  })
}

/** The pane's own buttons. */
export function memoryHandlers($: EngineInterface): { readonly forget: () => void; readonly close: () => void } {
  return {
    forget: () => {
      void runBriefCommand($, 'forget').catch(() => undefined)
    },
    close: () => {
      void $.ui.close({ id: MEMORY_PANE }).catch(() => undefined)
    },
  }
}
