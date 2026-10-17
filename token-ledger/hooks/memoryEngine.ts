// The engine side of the memory: where it is kept, when it is folded, and the
// /brief command. The pure rules (what a signal is, how a fold is read) live in
// lib/memory.ts and are tested there.
//
// Nothing here touches the engine's `$`: the engine only follows `$` inside
// register.tsx, so register.tsx hands this file a small set of ports, each a
// closure that spells its engine call out in full.

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
  mergeExchanges,
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

/** Everything the memory needs from the engine, built in register.tsx. */
export type MemoryPorts = {
  readonly storeGet: (key: string) => Promise<unknown>
  readonly storeSet: (key: string, value: unknown) => Promise<void>
  readonly root: () => Promise<string>
  readonly now: () => Promise<number>
  readonly complete: (request: Parameters<EngineInterface['model']['complete']>[0]) => ReturnType<EngineInterface['model']['complete']>
  /** Puts the view in the value the /brief pane draws. */
  readonly show: (view: MemoryView) => Promise<void>
  /** Opens the /brief pane; true when a surface placed it. */
  readonly openPane: () => Promise<boolean>
  readonly closePane: () => Promise<void>
}

type Loaded = {
  readonly storeKey: string
  readonly name: string
  readonly project: ProjectMemory
  readonly profile: ProfileMemory
}

const folderName = (root: string): string => root.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? root

async function load(io: MemoryPorts): Promise<Loaded> {
  const root = await io.root()
  const storeKey = `mem:project:${projectKey(root)}`
  const [project, profile] = await Promise.all([io.storeGet(storeKey), io.storeGet(PROFILE_STORE_KEY)])
  return { storeKey, name: folderName(root), project: asProjectMemory(project), profile: asProfileMemory(profile) }
}

/** Writes both notes, then redraws the /brief pane from what was written. */
async function save(io: MemoryPorts, loaded: Loaded, project: ProjectMemory, profile: ProfileMemory): Promise<void> {
  await io.storeSet(loaded.storeKey, project)
  await io.storeSet(PROFILE_STORE_KEY, profile)
  await show(io, { ...loaded, project, profile })
}

async function show(io: MemoryPorts, l: Loaded): Promise<void> {
  await io.show({
    projectName: l.name,
    brief: l.project.brief,
    profile: l.profile.profile,
    signals: [...l.project.signals],
    folds: l.project.folds,
    updatedAt: Math.max(l.project.updatedAt, l.profile.updatedAt),
  })
}

/** Loads the current project's memory into the pane's value. */
export async function refreshMemoryView(io: MemoryPorts): Promise<void> {
  await show(io, await load(io))
}

/**
 * The block `?` reads. `text` is '' when nothing is known yet. `hasBrief` is false
 * while only feedback exists, so `?` keeps the chat history until a brief stands in for it.
 */
export async function memoryBlock(io: MemoryPorts): Promise<{ readonly text: string; readonly hasBrief: boolean }> {
  const { project, profile } = await load(io)
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
export async function recordSignals(io: MemoryPorts, signals: readonly Signal[]): Promise<void> {
  if (signals.length === 0) return
  await serial(async () => {
    const l = await load(io)
    const merged = signals.reduce<readonly Signal[]>((all, s) => addSignal(all, s), l.project.signals)
    await save(io, l, { ...l.project, signals: merged }, l.profile)
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
async function foldOne(io: MemoryPorts, turn: Exchange): Promise<void> {
  const before = await load(io)
  const reply = await io.complete({
    model: INSIGHT_MODEL,
    system: FOLD_SYSTEM,
    prompt: buildFoldPrompt(before.project.brief, before.profile.profile, { ...turn, signals: [] }),
    maxTokens: FOLD_MAX_TOKENS,
    effort: 'low',
    timeoutMs: FOLD_TIMEOUT_MS,
  })
  const result: FoldResult | null = reply.isAnswered ? parseFold(reply.text) : null
  if (result === null || (result.brief === '' && result.profile === '')) return
  const at = await io.now()
  await serial(async () => {
    const fresh = await load(io)
    const next = applyFold(fresh.project, fresh.profile, result, [], at)
    await save(io, fresh, next.project, next.profile)
  })
}

/**
 * After a real turn: remember the person's feedback at once, then let Haiku fold
 * the exchange into the brief and profile in the background. Any failure leaves
 * the old memory exactly as it was.
 */
export async function foldAfterTurn(io: MemoryPorts, answer: string): Promise<void> {
  const user = takePrompt()
  if (user === '') return
  try {
    const kind = classifyUserMessage(user)
    if (kind !== null) await recordSignals(io, [{ kind, text: user, at: await io.now() }])
    const turn: Exchange = { user, assistant: answer }
    if (!shouldFold({ ...turn, signals: [] })) return
    if (isFolding) {
      // Past the limit, a turn joins the newest one waiting instead of being dropped.
      const last = waiting.at(-1)
      if (waiting.length < WAITING_MAX || last === undefined) waiting.push(turn)
      else waiting[waiting.length - 1] = mergeExchanges(last, turn)
      return
    }
    isFolding = true
    try {
      for (let next: Exchange | undefined = turn; next !== undefined; next = waiting.shift()) {
        await foldOne(io, next).catch(() => undefined)
      }
    } finally {
      isFolding = false
    }
  } catch {
    // Memory is a help, never a risk to the turn: keep what was there.
  }
}

/** Runs one /brief command and answers in a line; `show` also opens the pane. */
export async function runBriefCommand(io: MemoryPorts, args: string): Promise<string> {
  const cmd = parseBriefCommand(args)
  if (cmd.action === 'invalid') return cmd.reason
  if (cmd.action === 'show') {
    await show(io, await load(io))
    const isPlaced = await io.openPane()
    return isPlaced ? 'Showing what the mod knows about you and this project.' : 'Widen the terminal to see the memory pane.'
  }
  const now = await io.now()
  return serial(async () => {
    const l = await load(io)
    switch (cmd.action) {
      case 'set-brief':
        await save(io, l, { ...l.project, brief: cmd.text, updatedAt: now }, l.profile)
        return 'Project brief replaced.'
      case 'set-profile':
        await save(io, l, l.project, { profile: cmd.text, updatedAt: now })
        return 'Your profile replaced.'
      case 'forget-signals':
        await save(io, l, { ...l.project, signals: [], updatedAt: now }, l.profile)
        return 'Feedback log cleared for this project.'
      case 'reset':
        await save(io, l, EMPTY_PROJECT, l.profile)
        return "This project's brief and feedback cleared. Your profile is kept (replace it with /brief profile <text>)."
    }
  })
}

/** The pane's own buttons. */
export function memoryHandlers(io: MemoryPorts): { readonly forget: () => void; readonly close: () => void } {
  return {
    forget: () => {
      void runBriefCommand(io, 'forget').catch(() => undefined)
    },
    close: () => {
      void io.closePane().catch(() => undefined)
    },
  }
}
