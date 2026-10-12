import type { EngineInterface, Register } from 'claude-code'

import {
  applyEdits,
  buildPrompt,
  changedDocs,
  isCommitCommand,
  parseDocList,
  parseEdits,
  skipReason,
  SYSTEM,
  trimDiff,
} from './lib/docs'
import type { DocFile } from './lib/docs'

/** Lock files and generated bundles say nothing the docs need. */
const NOISE = [':(exclude)*.lock', ':(exclude)package-lock.json', ':(exclude)pnpm-lock.yaml', ':(exclude)*.min.js', ':(exclude)dist/**']

type Config = {
  readonly docs: readonly string[]
  readonly mode: 'commit' | 'stage'
  readonly model: string
  readonly maxDiffChars: number
}

const configOf = (options: Readonly<Record<string, unknown>>): Config => {
  const docs = parseDocList(typeof options.docs === 'string' ? options.docs : 'README.md')
  return {
    docs: docs.length ? docs : ['README.md'],
    mode: options.mode === 'stage' ? 'stage' : 'commit',
    model: typeof options.model === 'string' && options.model !== '' ? options.model : 'sonnet',
    maxDiffChars: typeof options.maxDiffChars === 'number' && options.maxDiffChars > 1000 ? options.maxDiffChars : 60_000,
  }
}

/** Runs git and returns its output, or throws with git's own message. */
async function git($: EngineInterface, args: readonly string[], cwd?: string): Promise<string> {
  const r = await $.process.run(['git', ...args], { ...(cwd ? { cwd } : {}), timeoutMs: 60_000 })
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} failed`)
  return r.stdout
}

async function readDocs($: EngineInterface, root: string, paths: readonly string[]): Promise<DocFile[]> {
  const found = await Promise.all(
    paths.map(async path => {
      const text = await $.fs.read(`${root}/${path}`).catch(() => null)
      return typeof text === 'string' ? { path, text } : null
    }),
  )
  return found.filter((d): d is DocFile => d !== null)
}

/** Brings the docs in line with one commit. Resolves a one-line summary of what it did. */
async function syncDocs($: EngineInterface, cfg: Config, rev: string): Promise<string> {
  const root = (await git($, ['rev-parse', '--show-toplevel']).catch(() => '')).trim()
  if (root === '') return 'auto-docs: not inside a git repository.'
  const sha = (await git($, ['rev-parse', rev], root)).trim()
  const short = sha.slice(0, 7)
  const doneKey = `done:${root.toLowerCase()}`
  if ((await $.store.get(doneKey)) === sha) return `auto-docs: ${short} is already documented.`

  const message = await git($, ['log', '-1', '--format=%B', sha], root)
  const changed = (await git($, ['show', '--name-only', '--format=', sha], root)).split('\n').map(s => s.trim()).filter(Boolean)
  const skip = skipReason({ message, changed, docs: cfg.docs })
  if (skip) return `auto-docs: skipped ${short} because ${skip}.`

  const docs = await readDocs($, root, cfg.docs)
  if (docs.length === 0) return `auto-docs: none of ${cfg.docs.join(', ')} exist in this repository.`

  const stat = await git($, ['show', '--stat', '--format=', sha], root)
  const diff = trimDiff(await git($, ['show', '--format=', '--unified=3', '--no-color', sha, '--', '.', ...NOISE], root), cfg.maxDiffChars)
  $.ui.status(`auto-docs: reading ${short}…`)
  const reply = await $.model.complete({
    model: cfg.model,
    system: SYSTEM,
    prompt: buildPrompt({ sha: short, message, stat, diff, docs }),
    maxTokens: 8_000,
    timeoutMs: 180_000,
  })
  if (!reply.isAnswered) return `auto-docs: the model gave no answer for ${short} (${reply.reason}).`

  const result = applyEdits(docs, parseEdits(reply.text))
  const touched = changedDocs(docs, result.files)
  const rejectedNote = result.rejected.length ? ` (${result.rejected.length} edit(s) skipped: text not found exactly once)` : ''
  await $.store.set(doneKey, sha)
  if (touched.length === 0) return `auto-docs: ${short} needs no documentation changes${rejectedNote}.`

  for (const doc of touched) await $.fs.write(`${root}/${doc.path}`, doc.text)
  const names = touched.map(d => d.path)
  await git($, ['add', '--', ...names], root)
  if (cfg.mode === 'stage') return `auto-docs: updated ${names.join(', ')} for ${short} and staged it for you to review${rejectedNote}.`

  await git($, ['commit', '-m', `docs: sync with ${short}`, '-m', `Updated by auto-docs from commit ${sha}.`, '--', ...names], root)
  const docSha = (await git($, ['rev-parse', 'HEAD'], root)).trim()
  await $.store.set(doneKey, docSha)
  return `auto-docs: updated ${names.join(', ')} for ${short} in commit ${docSha.slice(0, 7)}${rejectedNote}.`
}

/** Runs one sync with the status line and a toast around it; never throws. */
async function runAndReport($: EngineInterface, cfg: Config, rev: string): Promise<string> {
  try {
    const summary = await syncDocs($, cfg, rev)
    $.ui.toast(summary, { timeoutMs: 8_000 })
    return summary
  } catch (err) {
    const summary = `auto-docs: could not update the docs: ${err instanceof Error ? err.message : String(err)}`
    $.ui.toast(summary, { timeoutMs: 10_000 })
    return summary
  } finally {
    $.ui.status(undefined)
  }
}

export const register: Register = (on, options) => {
  const cfg = configOf(options)
  // One sync at a time; a commit made while one runs is picked up after.
  let isRunning = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'docs',
      description: 'auto-docs: update the README for the last commit (or a given one)',
      argumentHint: '[commit]',
    })
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const isCommit = ran.deny === undefined && ran.isError !== true && isCommitCommand(e.command)
    if (isCommit && !isRunning) {
      isRunning = true
      // After the commit, off the tool call's path: the commit is never slowed down.
      $.clock.after(0, () => {
        void runAndReport($, cfg, 'HEAD').finally(() => {
          isRunning = false
        })
      })
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'docs' }, async ($, e) => {
    if (isRunning) return { text: 'auto-docs: a sync is already running.' }
    isRunning = true
    try {
      return { text: await runAndReport($, cfg, e.args.trim() || 'HEAD') }
    } finally {
      isRunning = false
    }
  })
}
