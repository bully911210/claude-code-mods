// Pure logic for auto-docs: spotting a commit, deciding whether to act,
// building the prompt, and applying the model's edits safely. No engine calls.

export type DocFile = { readonly path: string; readonly text: string }
export type Edit = { readonly file: string; readonly find: string; readonly replace: string }
export type Applied = {
  readonly files: readonly DocFile[]
  readonly applied: number
  readonly rejected: readonly { readonly edit: Edit; readonly reason: string }[]
}

/** A shell command that makes a commit: `git commit`, also inside `git add -A && git commit -m ...`. */
export const isCommitCommand = (command: string): boolean =>
  /(^|[;&|(]\s*|\s)git(\s+-[cC]\s+\S+)*\s+commit\b/.test(command) && !/\s--dry-run\b/.test(command)

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()

/** Why to leave a commit alone, or null to go ahead. */
export const skipReason = (args: {
  readonly message: string
  readonly changed: readonly string[]
  readonly docs: readonly string[]
}): string | null => {
  if (/\[skip docs\]/i.test(args.message)) return 'the commit says [skip docs]'
  if (/^docs(\(.*\))?:/i.test(args.message.trim())) return 'it is a docs commit'
  if (args.changed.length === 0) return 'it changed no files'
  const docs = new Set(args.docs.map(norm))
  const isDocOnly = args.changed.every(f => docs.has(norm(f)) || /\.(md|mdx|txt|rst)$/i.test(f))
  return isDocOnly ? 'it only changed documentation' : null
}

/** Keeps the diff within budget, cutting whole file sections and saying what was left out. */
export const trimDiff = (diff: string, maxChars: number): string => {
  if (diff.length <= maxChars) return diff
  const sections = diff.split(/(?=^diff --git )/m)
  const kept: string[] = []
  let size = 0
  for (const section of sections) {
    if (size + section.length > maxChars) break
    kept.push(section)
    size += section.length
  }
  const dropped = sections.length - kept.length
  return `${kept.join('')}\n[auto-docs: ${dropped} more file diff(s) left out to stay within budget]\n`
}

export const SYSTEM = [
  'You keep a software project\'s documentation in step with its code.',
  'You are given one commit (message, file list and diff) and the current text of the documentation files.',
  'Propose the smallest edits that make the documentation true again: fix statements the commit made wrong,',
  'and add a short mention of new commands, options, endpoints or behaviour users need to know about.',
  'Do not restyle, reorder or rewrite text the commit did not affect. Match the existing tone and format.',
  'Never invent features that are not in the diff. If nothing needs to change, return no edits.',
  'Reply with JSON only: {"edits":[{"file":"README.md","find":"exact text currently in the file","replace":"new text"}]}.',
  '"find" must be copied exactly from the file and appear in it exactly once; keep it short but unique.',
  'To add a new section, use the last line of the section it should follow as "find" and repeat that line at the start of "replace".',
].join(' ')

export const buildPrompt = (args: {
  readonly sha: string
  readonly message: string
  readonly stat: string
  readonly diff: string
  readonly docs: readonly DocFile[]
}): string =>
  [
    `Commit ${args.sha}: ${args.message.trim()}`,
    '',
    'Files changed:',
    args.stat.trim(),
    '',
    'Diff:',
    args.diff,
    '',
    ...args.docs.flatMap(d => [`=== ${d.path} (current) ===`, d.text, `=== end of ${d.path} ===`, '']),
  ].join('\n')

/** Reads the model's reply as edits; anything malformed is dropped, never guessed at. */
export const parseEdits = (reply: string): Edit[] => {
  const match = reply.match(/\{[\s\S]*\}/)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[0]) as { edits?: unknown }
    if (!Array.isArray(parsed.edits)) return []
    return parsed.edits.filter(
      (x): x is Edit =>
        typeof x === 'object' &&
        x !== null &&
        typeof (x as Edit).file === 'string' &&
        typeof (x as Edit).find === 'string' &&
        typeof (x as Edit).replace === 'string' &&
        (x as Edit).find.length > 0,
    )
  } catch {
    return []
  }
}

const countOf = (text: string, part: string): number => text.split(part).length - 1

/**
 * Applies edits in order, each only when its `find` text appears exactly once
 * in the file as it stands. Returns new file texts; the inputs are untouched.
 */
export const applyEdits = (docs: readonly DocFile[], edits: readonly Edit[]): Applied =>
  edits.reduce<Applied>(
    (acc, edit) => {
      const doc = acc.files.find(d => norm(d.path) === norm(edit.file))
      if (!doc) return { ...acc, rejected: [...acc.rejected, { edit, reason: 'not one of the documentation files' }] }
      const n = countOf(doc.text, edit.find)
      if (n !== 1) return { ...acc, rejected: [...acc.rejected, { edit, reason: n === 0 ? 'text not found' : 'text not unique' }] }
      if (edit.find === edit.replace) return acc
      const text = doc.text.replace(edit.find, () => edit.replace)
      return {
        files: acc.files.map(d => (d === doc ? { ...d, text } : d)),
        applied: acc.applied + 1,
        rejected: acc.rejected,
      }
    },
    { files: [...docs], applied: 0, rejected: [] },
  )

/** The files whose text changed. */
export const changedDocs = (before: readonly DocFile[], after: readonly DocFile[]): DocFile[] =>
  after.filter(d => before.find(b => b.path === d.path)?.text !== d.text)

export const parseDocList = (value: string): string[] =>
  value
    .split(',')
    .map(s => s.trim().replace(/\\/g, '/'))
    .filter(s => s.length > 0 && !s.includes('..') && !/^([A-Za-z]:|\/)/.test(s))
