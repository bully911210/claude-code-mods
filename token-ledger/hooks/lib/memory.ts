// Pure logic for the persistent memory behind the ? button: a per-project brief,
// a global profile of the user, and a log of the user's feedback. Storage, the
// Haiku call and the UI live elsewhere; nothing here touches the engine.

import { redact } from './redact'

export const BRIEF_MAX_CHARS = 1_500
export const PROFILE_MAX_CHARS = 1_200
export const SIGNALS_MAX = 40
export const SIGNAL_TEXT_MAX = 240
/** Skipped suggestions are noise next to the user's own words, so each kind has its own room. */
export const SIGNAL_QUOTA: Readonly<Record<'correction' | 'frustration' | 'accepted' | 'ignored', number>> = Object.freeze({
  correction: 12,
  frustration: 8,
  accepted: 10,
  ignored: 8,
})

export type SignalKind = 'correction' | 'frustration' | 'accepted' | 'ignored'
export type Signal = { readonly kind: SignalKind; readonly text: string; readonly at: number }
export type ProjectMemory = {
  readonly brief: string
  readonly signals: readonly Signal[]
  readonly updatedAt: number
  readonly folds: number
}
export type ProfileMemory = { readonly profile: string; readonly updatedAt: number }

export const EMPTY_PROJECT: ProjectMemory = Object.freeze({ brief: '', signals: Object.freeze([]), updatedAt: 0, folds: 0 })
export const EMPTY_PROFILE: ProfileMemory = Object.freeze({ profile: '', updatedAt: 0 })

const SIGNAL_KINDS: readonly SignalKind[] = ['correction', 'frustration', 'accepted', 'ignored']

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193
const HASH_HEX_LENGTH = 8
const UNKNOWN_NAME = 'unknown'
const UNKNOWN_KEY = `${UNKNOWN_NAME}-${'0'.repeat(HASH_HEX_LENGTH)}`
const KEY_NAME_MAX = 40

/** A cut is only moved back to a word boundary when that costs less than this share. */
const MIN_WORD_CUT_SHARE = 0.5

const MIN_SHOUT_LETTERS = 12
const SHOUT_SHARE = 0.6
const SHOUT_MARKS = /[?!]{3,}/
const DEFAULT_MIN_ASSISTANT_CHARS = 200
const DEFAULT_SIGNAL_LIMIT = 12
/** In the ? prompt, skipped suggestions get at most this many of the lines. */
const IGNORED_SHOWN_MAX = 4
/** Only a short message can be read for mood; a pasted document says nothing about it. */
const CLASSIFY_MAX_CHARS = 500
const FOLD_USER_MAX = 2_000
const FOLD_ASSISTANT_MAX = 3_000
const MAX_REPLY_CHARS = 20_000
const REDACT_SALT = 'memory'
const NOTHING_RECORDED = 'Nothing recorded yet.'

/** Whole-word phrases that mean "that is not what I meant"; matched anywhere in a short message. */
const CORRECTION_ANYWHERE =
  /\b(?:i am not|i'm not|not a developer|i said|that'?s not|thats not|that is not|wrong|why did you|i didn'?t ask|i did not ask|rather than)\b/
/** Phrases that only count as a correction when the message opens with them. */
const CORRECTION_OPENING = /^\s*(?:no\b[,.!:;]|stop\b|please\s+(?:don'?t|stop)\b|don'?t(?!\s+forget)\b|do not\b)/

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === 'object' && v !== null && !Array.isArray(v)

const isSignalKind = (v: unknown): v is SignalKind => SIGNAL_KINDS.includes(v as SignalKind)

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Removes a lone high surrogate a cut may have left, so no emoji is split in half. */
const dropSplitPair = (s: string): string => (/[\ud800-\udbff]$/.test(s) ? s.slice(0, -1) : s)

/** Trims, then cuts to `max` characters, at a word boundary when one is near. */
const cutAtWord = (text: string, max: number): string => {
  const t = text.trim()
  if (t.length <= max) return t
  const hard = dropSplitPair(t.slice(0, max))
  if (/\s/.test(t.charAt(max))) return hard.trimEnd()
  const lastGap = hard.search(/\s\S*$/)
  return (lastGap >= max * MIN_WORD_CUT_SHARE ? hard.slice(0, lastGap) : hard).trimEnd()
}

/** Trims, then cuts to `max` characters in total, ending with an ellipsis when cut. */
const cutWithEllipsis = (text: string, max: number): string => {
  const t = text.trim()
  return t.length <= max ? t : `${dropSplitPair(t.slice(0, max - 1)).trimEnd()}…`
}

const fnv1a = (input: string): string => {
  let hash = FNV_OFFSET
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash.toString(16).padStart(HASH_HEX_LENGTH, '0')
}

/** Windows paths ignore case and mix slash styles; POSIX paths are case-sensitive, so /work/Acme and /work/acme differ. */
const isWindowsPath = (raw: string): boolean => raw.includes('\\') || /^[a-z]:[\\/]/i.test(raw) || raw.startsWith('//')

/** One stable key per folder, however a Windows path is spelled; a POSIX path keeps its case. */
export function projectKey(root: string): string {
  const raw = typeof root === 'string' ? root.trim() : ''
  const slashed = raw.replace(/\\/g, '/').replace(/\/+$/, '')
  const path = isWindowsPath(raw) ? slashed.toLowerCase() : slashed
  if (path === '') return UNKNOWN_KEY
  const folder = (path.split('/').pop() ?? '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, KEY_NAME_MAX)
  return `${folder || UNKNOWN_NAME}-${fnv1a(path)}`
}

const readSignal = (raw: unknown): readonly Signal[] => {
  if (!isRecord(raw) || !isSignalKind(raw.kind) || typeof raw.text !== 'string' || !isFiniteNumber(raw.at)) return []
  const text = cutWithEllipsis(raw.text, SIGNAL_TEXT_MAX)
  return text === '' ? [] : [{ kind: raw.kind, text, at: raw.at }]
}

const readCount = (v: unknown): number => (isFiniteNumber(v) && v >= 0 ? v : 0)

/** Reads a project memory back from JSON storage; anything malformed becomes empty. */
export function asProjectMemory(raw: unknown): ProjectMemory {
  if (!isRecord(raw)) return EMPTY_PROJECT
  const signals = Array.isArray(raw.signals) ? raw.signals.flatMap(readSignal).slice(-SIGNALS_MAX) : []
  return {
    brief: typeof raw.brief === 'string' ? cutAtWord(raw.brief, BRIEF_MAX_CHARS) : '',
    signals,
    updatedAt: readCount(raw.updatedAt),
    folds: isFiniteNumber(raw.folds) && Number.isInteger(raw.folds) && raw.folds >= 0 ? raw.folds : 0,
  }
}

/** Reads a profile back from JSON storage; anything malformed becomes empty. */
export function asProfileMemory(raw: unknown): ProfileMemory {
  if (!isRecord(raw)) return EMPTY_PROFILE
  return {
    profile: typeof raw.profile === 'string' ? cutAtWord(raw.profile, PROFILE_MAX_CHARS) : '',
    updatedAt: readCount(raw.updatedAt),
  }
}

/** Cheap local read of how the user is reacting; frustration outranks correction. */
export function classifyUserMessage(text: string): 'correction' | 'frustration' | null {
  if (typeof text !== 'string' || text.trim() === '' || text.length > CLASSIFY_MAX_CHARS) return null
  const letters = text.match(/\p{L}/gu) ?? []
  const upper = letters.filter(ch => ch !== ch.toLowerCase()).length
  const isShouting = letters.length >= MIN_SHOUT_LETTERS && upper / letters.length >= SHOUT_SHARE
  if (isShouting || SHOUT_MARKS.test(text)) return 'frustration'
  const lower = text.toLowerCase().replace(/[‘’]/g, "'")
  return CORRECTION_ANYWHERE.test(lower) || CORRECTION_OPENING.test(lower) ? 'correction' : null
}

const scrub = (text: string): string => redact(text, { salt: REDACT_SALT, redactAmounts: false }).text

/** Keeps the newest signals of each kind up to that kind's room, in their original order. */
const withinQuota = (signals: readonly Signal[]): readonly Signal[] => {
  const seen: Record<string, number> = {}
  const keep = new Set<number>()
  for (let i = signals.length - 1; i >= 0; i -= 1) {
    const kind = signals[i]?.kind ?? 'ignored'
    seen[kind] = (seen[kind] ?? 0) + 1
    if (seen[kind] <= SIGNAL_QUOTA[kind]) keep.add(i)
  }
  return signals.filter((_, i) => keep.has(i))
}

const signalKey = (s: Signal): string => `${s.kind}\u0000${s.text.toLowerCase()}`

/** A new list with `signal` last: trimmed, cut, deduplicated and capped to the newest. */
export function addSignal(signals: readonly Signal[], signal: Signal): readonly Signal[] {
  const text = cutWithEllipsis(scrub(typeof signal.text === 'string' ? signal.text : ''), SIGNAL_TEXT_MAX)
  if (text === '') return [...signals]
  const next: Signal = { kind: signal.kind, text, at: signal.at }
  const key = signalKey(next)
  return withinQuota([...signals.filter(s => signalKey(s) !== key), next]).slice(-SIGNALS_MAX)
}

/** What the user's choice of suggestions says: picked are accepted, the rest ignored. */
export function pickSignals(
  items: readonly { readonly title: string; readonly question: string }[],
  pickedIndexes: readonly number[],
  at: number,
): readonly Signal[] {
  const picked = new Set(pickedIndexes.filter(i => Number.isInteger(i) && i >= 0 && i < items.length))
  return items.flatMap((item, i): readonly Signal[] => {
    const text = typeof item.question === 'string' ? item.question.trim() : ''
    return text === '' ? [] : [{ kind: picked.has(i) ? 'accepted' : 'ignored', text, at }]
  })
}

/** Two exchanges as one, oldest first, keeping the newest words if it would not fit the fold's budget. */
export function mergeExchanges(
  a: { readonly user: string; readonly assistant: string },
  b: { readonly user: string; readonly assistant: string },
): { readonly user: string; readonly assistant: string } {
  const tail = (text: string, max: number): string => (text.length > max ? text.slice(-max) : text)
  return {
    user: tail(`${a.user}\n\n${b.user}`, FOLD_USER_MAX),
    assistant: tail(`${a.assistant}\n\n${b.assistant}`, FOLD_ASSISTANT_MAX),
  }
}

export type FoldTurn = { readonly user: string; readonly assistant: string; readonly signals: readonly Signal[] }
export type FoldResult = { readonly brief: string; readonly profile: string }

export const FOLD_SYSTEM: string = [
  'You maintain two short notes about a person and their work.',
  'The user is a business owner and operator, not a developer: do not assume the work is software.',
  `PROJECT BRIEF: what this project is, the goal, the decisions made, and what is still open (at most about ${BRIEF_MAX_CHARS} characters).`,
  `USER PROFILE: who the user is, their business context, their preferences, how they like to be spoken to, and anything they have corrected (at most about ${PROFILE_MAX_CHARS} characters).`,
  'Rewrite both notes compactly by folding in the new exchange. Drop outdated or superseded facts. Keep concrete names, numbers and decisions.',
  'Treat the feedback lines as evidence of what the user likes, dislikes and has corrected.',
  'Never invent facts that the exchange does not show. Never store secrets, ID numbers, or contact details.',
  'If nothing changed for a note, return its previous text unchanged.',
  'Reply with JSON only: {"brief":"...","profile":"..."}',
].join(' ')

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)} [cut]` : s)

const clean = (s: unknown, max: number): string =>
  cut(redact(typeof s === 'string' ? s.trim() : '', { salt: REDACT_SALT, redactAmounts: false }).text, max)

const orEmpty = (s: string): string => (s.trim() === '' ? '(empty)' : s.trim())

/** The fold request: current notes, then the new exchange (redacted, within budget). */
export function buildFoldPrompt(brief: string, profile: string, turn: FoldTurn): string {
  const feedback = turn.signals.map(s => `- ${s.kind}: ${clean(s.text, SIGNAL_TEXT_MAX)}`)
  return [
    '## Current PROJECT BRIEF',
    orEmpty(clean(brief, BRIEF_MAX_CHARS)),
    '',
    '## Current USER PROFILE',
    orEmpty(clean(profile, PROFILE_MAX_CHARS)),
    '',
    '## New exchange',
    `USER: ${clean(turn.user, FOLD_USER_MAX)}`,
    `CLAUDE: ${clean(turn.assistant, FOLD_ASSISTANT_MAX)}`,
    ...(feedback.length ? ['', '## Feedback the user gave during this exchange', ...feedback] : []),
  ].join('\n')
}

/** Index just past the object that opens at `start`, or -1 when it never closes. */
const objectEnd = (text: string, start: number): number => {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text.charAt(i)
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/** Every balanced {...} slice of the text, in order of where it starts. */
const objectCandidates = (text: string): readonly string[] => {
  const found: string[] = []
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = objectEnd(text, start)
    if (end !== -1) found.push(text.slice(start, end))
  }
  return found
}

const tryParse = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

/** A model asked to "return the previous text" may echo our placeholder; that means no change. */
const PLACEHOLDER = /^\(?\s*(?:empty|none|n\/a|nothing(?:\s+(?:known|recorded))?(?:\s+yet)?)\s*\)?\.?$/i

/** A note as the model wrote it: cut to size, with a placeholder read as blank. */
const note = (text: string, max: number): string => {
  const t = cutAtWord(text, max)
  return PLACEHOLDER.test(t) ? '' : t
}

/** Reads the fold reply strictly: both notes must be strings, or the whole reply is rejected. */
export function parseFold(reply: string): FoldResult | null {
  if (typeof reply !== 'string') return null
  const parsed = objectCandidates(reply.slice(0, MAX_REPLY_CHARS))
    .map(tryParse)
    .find((v): v is Readonly<Record<string, unknown>> => isRecord(v) && typeof v.brief === 'string' && typeof v.profile === 'string')
  if (!parsed) return null
  return { brief: note(String(parsed.brief), BRIEF_MAX_CHARS), profile: note(String(parsed.profile), PROFILE_MAX_CHARS) }
}

/** Only real exchanges are worth a fold: not slash commands, not one-liners. */
export function shouldFold(turn: FoldTurn, minAssistantChars: number = DEFAULT_MIN_ASSISTANT_CHARS): boolean {
  const user = typeof turn.user === 'string' ? turn.user.trim() : ''
  const assistant = typeof turn.assistant === 'string' ? turn.assistant.trim() : ''
  return user !== '' && !user.startsWith('/') && assistant.length >= minAssistantChars
}

/** Folds a result into new memories; an empty note never replaces a known one. */
export function applyFold(
  project: ProjectMemory,
  profile: ProfileMemory,
  result: FoldResult,
  newSignals: readonly Signal[],
  at: number,
): { readonly project: ProjectMemory; readonly profile: ProfileMemory } {
  const brief = note(scrub(result.brief), BRIEF_MAX_CHARS)
  const person = note(scrub(result.profile), PROFILE_MAX_CHARS)
  const isFolded = brief !== '' || person !== ''
  return {
    project: {
      brief: brief === '' ? project.brief : brief,
      signals: newSignals.reduce<readonly Signal[]>(addSignal, project.signals),
      updatedAt: at,
      folds: isFolded ? project.folds + 1 : project.folds,
    },
    profile: { profile: person === '' ? profile.profile : person, updatedAt: at },
  }
}

export type BriefCommand =
  | { readonly action: 'show' }
  | { readonly action: 'set-brief'; readonly text: string }
  | { readonly action: 'set-profile'; readonly text: string }
  | { readonly action: 'forget-signals' }
  | { readonly action: 'reset' }
  | { readonly action: 'invalid'; readonly reason: string }

const VALID_WORDS = 'show, brief <text>, profile <text>, forget, reset'

const invalid = (reason: string): BriefCommand => ({ action: 'invalid', reason })

const needsNoText = (word: string, rest: string, command: BriefCommand): BriefCommand =>
  rest === '' ? command : invalid(`"${word}" takes no extra words. Type just "${word}" to confirm.`)

const withText = (word: 'brief' | 'profile', text: string, max: number): BriefCommand =>
  text === ''
    ? invalid(`"${word}" needs some text after it, for example: ${word} <what you want it to say>.`)
    : word === 'brief'
      ? { action: 'set-brief', text: cutAtWord(scrub(text), max) }
      : { action: 'set-profile', text: cutAtWord(scrub(text), max) }

/** Reads the arguments of the memory command; only the action word ignores case. */
export function parseBriefCommand(args: string): BriefCommand {
  const input = typeof args === 'string' ? args.trim() : ''
  if (input === '') return { action: 'show' }
  const [, first = '', rest = ''] = input.match(/^(\S+)\s*([\s\S]*)$/) ?? []
  switch (first.toLowerCase()) {
    case 'show':
      return { action: 'show' }
    case 'brief':
      return withText('brief', rest, BRIEF_MAX_CHARS)
    case 'profile':
      return withText('profile', rest, PROFILE_MAX_CHARS)
    case 'forget':
      return needsNoText('forget', rest, { action: 'forget-signals' })
    case 'reset':
      return needsNoText('reset', rest, { action: 'reset' })
    default:
      return invalid(`Unknown option "${first}". Use one of: ${VALID_WORDS}.`)
  }
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

const section = (title: string, body: string): string => `## ${title}\n${body}`

/** The newest `limit` signals, with skipped suggestions held to a few so they never crowd out the user's words. */
const forPrompt = (signals: readonly Signal[], limit: number): readonly Signal[] => {
  const skipped = new Set(
    signals
      .map((s, i) => [s, i] as const)
      .filter(([s]) => s.kind === 'ignored')
      .slice(-IGNORED_SHOWN_MAX)
      .map(([, i]) => i),
  )
  return signals.filter((s, i) => s.kind !== 'ignored' || skipped.has(i)).slice(-limit)
}

/** The memory block that opens the ? prompt. */
export function renderMemory(project: ProjectMemory, profile: ProfileMemory, signalLimit: number = DEFAULT_SIGNAL_LIMIT): string {
  const limit = Number.isFinite(signalLimit) ? Math.max(0, Math.floor(signalLimit)) : DEFAULT_SIGNAL_LIMIT
  const recent = limit === 0 ? [] : forPrompt(project.signals, limit)
  const feedback = recent.length ? recent.map(s => `- [${s.kind}] ${oneLine(s.text)}`).join('\n') : 'No feedback recorded yet.'
  return [
    section('About the user', profile.profile.trim() || NOTHING_RECORDED),
    section('The project so far', project.brief.trim() || NOTHING_RECORDED),
    section('What the user has told us and how they react', feedback),
  ].join('\n\n')
}
