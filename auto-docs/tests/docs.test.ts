import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { applyEdits, changedDocs, isCommitCommand, parseDocList, parseEdits, skipReason, trimDiff } from '../hooks/lib/docs'

describe('spotting a commit', () => {
  test('plain, chained and configured commits', () => {
    expect(isCommitCommand('git commit -m "feat: x"')).toBe(true)
    expect(isCommitCommand('git add -A && git commit -m "x"')).toBe(true)
    expect(isCommitCommand('git -c user.name=F commit -m x')).toBe(true)
  })

  test('not commits', () => {
    expect(isCommitCommand('git status')).toBe(false)
    expect(isCommitCommand('git commit --dry-run')).toBe(false)
    expect(isCommitCommand('echo "git commit"x')).toBe(false)
    expect(isCommitCommand('git log --grep commit')).toBe(false)
  })
})

describe('when to leave a commit alone', () => {
  const docs = ['README.md']
  test('skip markers, docs commits and docs-only changes', () => {
    expect(skipReason({ message: 'feat: x [skip docs]', changed: ['a.ts'], docs })).toContain('skip docs')
    expect(skipReason({ message: 'docs: sync with abc', changed: ['README.md'], docs })).toContain('docs commit')
    expect(skipReason({ message: 'chore: notes', changed: ['NOTES.md', 'README.md'], docs })).toContain('only changed documentation')
  })

  test('code changes go ahead', () => {
    expect(skipReason({ message: 'feat: add /export command', changed: ['src/export.ts', 'README.md'], docs })).toBeNull()
  })
})

describe('applying edits safely', () => {
  const readme = { path: 'README.md', text: '# App\n\nRun `npm start`.\n\n## Commands\n\n- `/import`\n' }

  test('an edit whose text appears once is applied; inputs stay unchanged', () => {
    const r = applyEdits([readme], [{ file: 'README.md', find: '- `/import`\n', replace: '- `/import`\n- `/export`\n' }])
    expect(r.applied).toBe(1)
    expect(r.files[0]?.text).toContain('- `/export`')
    expect(readme.text).not.toContain('/export')
    expect(changedDocs([readme], r.files).map(d => d.path)).toEqual(['README.md'])
  })

  test('missing, repeated or foreign text is refused, never guessed', () => {
    const r = applyEdits(
      [{ path: 'README.md', text: 'a a b' }],
      [
        { file: 'README.md', find: 'zzz', replace: 'y' },
        { file: 'README.md', find: 'a', replace: 'y' },
        { file: 'src/app.ts', find: 'b', replace: 'y' },
      ],
    )
    expect(r.applied).toBe(0)
    expect(r.rejected.map(x => x.reason)).toEqual(['text not found', 'text not unique', 'not one of the documentation files'])
  })

  test('$ signs in replacements are taken literally', () => {
    const r = applyEdits([{ path: 'README.md', text: 'cost: X' }], [{ file: 'README.md', find: 'X', replace: '$& and $1' }])
    expect(r.files[0]?.text).toBe('cost: $& and $1')
  })

  test('replies are parsed strictly', () => {
    expect(parseEdits('Sure: {"edits":[{"file":"README.md","find":"a","replace":"b"}]}')).toEqual([{ file: 'README.md', find: 'a', replace: 'b' }])
    expect(parseEdits('{"edits":[{"file":"README.md","find":"","replace":"b"}]}')).toEqual([])
    expect(parseEdits('no json here')).toEqual([])
    expect(parseEdits('{"edits": "nope"}')).toEqual([])
  })

  test('big diffs are cut by whole files', () => {
    const one = 'diff --git a/x b/x\n' + 'x'.repeat(100) + '\n'
    const cut = trimDiff(one.repeat(5), 250)
    expect(cut.split('diff --git').length - 1).toBe(2)
    expect(cut).toContain('3 more file diff(s) left out')
  })

  test('the doc list stays inside the repository', () => {
    expect(parseDocList('README.md, docs\\setup.md, ../secret.md, C:/x.md, /etc/passwd')).toEqual(['README.md', 'docs/setup.md'])
  })
})

const README = '# App\n\n## Commands\n\n- `/import`: load leads\n'

/** A repository with one code commit, a model that suggests one edit, and files in memory. */
const world = (on: On, opts: { message: string; changed: string[]; reply: string }) => {
  const clock = mock.clock(on)
  mock.store(on)
  const files: Record<string, string> = { 'C:/repo/README.md': README }
  const seen = { gitCalls: [] as string[][], toasts: [] as string[], prompts: 0 }
  let head = 'abc1234def'
  on('process.run', ($, e) => {
    const args = e.argv.slice(1)
    seen.gitCalls.push(args)
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return out('C:/repo\n')
    if (args[0] === 'rev-parse') return out(`${head}\n`)
    if (args[0] === 'log') return out(opts.message)
    if (args[0] === 'show' && args[1] === '--name-only') return out(opts.changed.join('\n'))
    if (args[0] === 'show' && args[1] === '--stat') return out(' src/export.ts | 40 ++++\n')
    if (args[0] === 'show') return out('diff --git a/src/export.ts b/src/export.ts\n+export command\n')
    if (args[0] === 'commit') head = 'fff9999000'
    return out('')
  })
  // The engine hands paths over in the platform's own form, and off Windows it
  // resolves the C:/repo root against the working directory: key the fake files
  // by their path from C:/repo on.
  const key = (p: string): string => p.replace(/\\/g, '/').replace(/^.*?(?=C:\/repo\/)/, '')
  on('fs.read', ($, e) => (key(e.path) in files ? { value: files[key(e.path)] } : { deny: 'ENOENT' }) as never)
  on('fs.write', ($, e) => {
    files[key(e.path)] = e.text
    return { value: undefined }
  })
  on('model.complete', () => {
    seen.prompts += 1
    return { value: { isAnswered: true, text: opts.reply, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } as never
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(String(e.text))
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', () => ({ cwd: 'C:/repo' }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
  return { files, seen, clock }
}

const EDIT = JSON.stringify({ edits: [{ file: 'README.md', find: '- `/import`: load leads\n', replace: '- `/import`: load leads\n- `/export`: download leads as CSV\n' }] })

test('a code commit updates the README in a follow-up docs commit', async ($, on) => {
  const { files, seen } = world(on, { message: 'feat: add /export', changed: ['src/export.ts'], reply: EDIT })
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'docs', args: '', origin: { kind: 'composer' }, presentation: {} } as never)
  expect(files['C:/repo/README.md']).toContain('- `/export`: download leads as CSV')
  expect(seen.gitCalls.some(a => a[0] === 'add' && a.includes('README.md'))).toBe(true)
  expect(seen.gitCalls.some(a => a[0] === 'commit' && a[2] === 'docs: sync with abc1234')).toBe(true)
  expect(String(r.text)).toContain('updated README.md for abc1234 in commit fff9999')
})

test('stage mode leaves the change staged, with no commit', { options: { mode: 'stage' } }, async ($, on) => {
  const { seen } = world(on, { message: 'feat: add /export', changed: ['src/export.ts'], reply: EDIT })
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'docs', args: '', origin: { kind: 'composer' }, presentation: {} } as never)
  expect(seen.gitCalls.some(a => a[0] === 'commit')).toBe(false)
  expect(String(r.text)).toContain('staged it for you to review')
})

test('a docs-only commit is skipped without asking the model', async ($, on) => {
  const { seen } = world(on, { message: 'docs: tidy', changed: ['README.md'], reply: EDIT })
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'docs', args: '', origin: { kind: 'composer' }, presentation: {} } as never)
  expect(seen.prompts).toBe(0)
  expect(String(r.text)).toContain('skipped abc1234')
})

test('a bad edit changes nothing and says so', async ($, on) => {
  const bad = JSON.stringify({ edits: [{ file: 'README.md', find: 'not in the file', replace: 'x' }] })
  const { files, seen } = world(on, { message: 'feat: x', changed: ['src/x.ts'], reply: bad })
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'docs', args: '', origin: { kind: 'composer' }, presentation: {} } as never)
  expect(files['C:/repo/README.md']).toBe(README)
  expect(seen.gitCalls.some(a => a[0] === 'commit')).toBe(false)
  expect(String(r.text)).toContain('needs no documentation changes (1 edit(s) skipped')
})

test('a git commit through the Bash tool triggers the update on its own, after the commit', async ($, on) => {
  const { files, seen, clock } = world(on, { message: 'feat: add /export', changed: ['src/export.ts'], reply: EDIT })
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git add -A && git commit -m "feat: add /export"' } as never)
  expect(seen.prompts).toBe(0) // the commit returns before any docs work starts
  await clock.settle()
  expect(files['C:/repo/README.md']).toContain('/export')
  expect(seen.toasts.at(-1)).toContain('updated README.md for abc1234')
})

test('other shell commands do nothing', async ($, on) => {
  const { seen, clock } = world(on, { message: 'feat: x', changed: ['src/x.ts'], reply: EDIT })
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await clock.settle()
  expect(seen.gitCalls.length).toBe(0)
})
