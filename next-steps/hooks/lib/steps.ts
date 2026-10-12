// Pure prompt building and reply parsing for next-step suggestions.

import { redact } from './redact'

export const MAX_STEPS = 3
export const MAX_STEP_CHARS = 90
/** How much of the answer's tail goes to the model: the ending says what is left. */
export const ANSWER_TAIL_CHARS = 4_000

export const SYSTEM = [
  'You suggest what the user should ask Claude Code to do next.',
  'Read the end of the assistant answer and the files it touched.',
  'Reply with a JSON array of 1 to 3 strings and nothing else.',
  'Each string is a prompt the user could send next: imperative, specific, under 80 characters.',
  'Prefer verifying or finishing the work just done over new work.',
  'If nothing useful follows, reply [].',
].join(' ')

export const shouldSuggest = (args: {
  readonly answer: string
  readonly toolCalls: number
  readonly minAnswerChars: number
}): boolean => args.answer.trim().length >= args.minAnswerChars || args.toolCalls >= 3

export const buildPrompt = (args: {
  readonly answer: string
  readonly files: readonly string[]
  readonly project: string
}): string => {
  // Personal data never leaves for the suggestion call. Redact the whole
  // answer before cutting it, so no number is split across the cut, and
  // redact file and project names too (`client-8001015009087.csv`).
  const scrub = (text: string): string => redact(text, { salt: 'next-steps', redactAmounts: false }).text
  const safe = scrub(args.answer).slice(-ANSWER_TAIL_CHARS)
  const files = args.files.length ? scrub(args.files.slice(-15).join(', ')) : 'none'
  return `Project: ${scrub(args.project)}\nFiles touched this turn: ${files}\n\nEnd of the assistant answer:\n"""\n${safe}\n"""`
}

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** Reads the model's reply as a JSON array, or failing that as a bulleted list. */
export const parseSteps = (reply: string): string[] => {
  const fromJson = (() => {
    const match = reply.match(/\[[\s\S]*\]/)
    if (!match) return undefined
    try {
      const parsed: unknown = JSON.parse(match[0])
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : undefined
    } catch {
      return undefined
    }
  })()
  const raw =
    fromJson ??
    reply
      .split('\n')
      .map(line => line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/)?.[1])
      .filter((x): x is string => x !== undefined)
  const unique = [...new Set(raw.map(clean).filter(s => s.length > 0))]
  return unique.slice(0, MAX_STEPS).map(s => (s.length > MAX_STEP_CHARS ? `${s.slice(0, MAX_STEP_CHARS - 1)}…` : s))
}

export const fileNameOf = (p: string): string => p.replace(/\\/g, '/').split('/').at(-1) ?? p

/**
 * How the ticked steps join the prompt box: never over the user's own text.
 * `text` is already the ticked steps joined, so one call covers any number.
 */
export const fillPlan = (current: string, text: string): { readonly text: string; readonly mode: 'replace' | 'append' } =>
  current.trim() === '' ? { text, mode: 'replace' } : { text: `${current.endsWith('\n') ? '' : '\n\n'}${text}`, mode: 'append' }
