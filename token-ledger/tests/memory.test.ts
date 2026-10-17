import { describe, expect, test } from 'claude-code/testing'

import {
  addSignal,
  applyFold,
  asProfileMemory,
  asProjectMemory,
  buildFoldPrompt,
  BRIEF_MAX_CHARS,
  classifyUserMessage,
  EMPTY_PROFILE,
  EMPTY_PROJECT,
  FOLD_SYSTEM,
  parseBriefCommand,
  parseFold,
  pickSignals,
  PROFILE_MAX_CHARS,
  projectKey,
  renderMemory,
  shouldFold,
  SIGNAL_QUOTA,
  SIGNAL_TEXT_MAX,
  SIGNALS_MAX,
} from '../hooks/lib/memory'
import type { FoldTurn, Signal } from '../hooks/lib/memory'

const sig = (kind: Signal['kind'], text: string, at = 1): Signal => ({ kind, text, at })

const freezeSignals = (list: readonly Signal[]): readonly Signal[] => Object.freeze(list.map(s => Object.freeze({ ...s })))

describe('projectKey', () => {
  test('slash style, case and trailing slash do not matter', () => {
    expect(projectKey('C:\\Users\\X\\Proj')).toBe(projectKey('c:/users/x/proj/'))
  })

  test('shape is folder name, dash, 8 hex chars', () => {
    expect(projectKey('C:\\Users\\X\\Proj')).toMatch(/^proj-[0-9a-f]{8}$/)
  })

  test('same folder name in different places gives different keys', () => {
    expect(projectKey('C:/work/site')).not.toBe(projectKey('D:/clients/site'))
  })

  test('is stable across calls', () => {
    expect(projectKey('C:/work/site')).toBe(projectKey('C:/work/site'))
  })

  test('empty, whitespace and non-string input give the stable unknown key, never throw', () => {
    expect(projectKey('')).toBe('unknown-00000000')
    expect(projectKey('   ')).toBe('unknown-00000000')
    expect(projectKey(undefined as never)).toBe('unknown-00000000')
    expect(projectKey(null as never)).toBe('unknown-00000000')
  })

  test('folder names with spaces or odd characters give a key safe to store', () => {
    expect(projectKey('C:/OneDrive - Acme Marketing/My Site?')).toMatch(/^[\p{L}\p{N}._-]+-[0-9a-f]{8}$/u)
  })
})

describe('asProjectMemory and asProfileMemory', () => {
  test('garbage falls back to the empty values', () => {
    for (const raw of [undefined, null, 5, 'x', [], true]) {
      expect(asProjectMemory(raw)).toEqual(EMPTY_PROJECT)
      expect(asProfileMemory(raw)).toEqual(EMPTY_PROFILE)
    }
  })

  test('a good project value comes back unchanged', () => {
    const good = { brief: 'Lead gen for a roofing firm.', signals: [sig('correction', 'Not a developer', 5)], updatedAt: 9, folds: 3 }
    expect(asProjectMemory(good)).toEqual(good)
  })

  test('bad fields are repaired one by one', () => {
    const out = asProjectMemory({ brief: 7, signals: 'nope', updatedAt: 'x', folds: -2 })
    expect(out).toEqual(EMPTY_PROJECT)
    expect(asProjectMemory({ brief: 'ok', updatedAt: Number.NaN, folds: 1.5 })).toEqual({ ...EMPTY_PROJECT, brief: 'ok' })
  })

  test('signals with a bad kind, text or time are dropped', () => {
    const out = asProjectMemory({
      brief: '',
      updatedAt: 1,
      folds: 1,
      signals: [
        { kind: 'correction', text: 'keep me', at: 1 },
        { kind: 'angry', text: 'bad kind', at: 1 },
        { kind: 'accepted', text: '   ', at: 1 },
        { kind: 'accepted', text: 42, at: 1 },
        { kind: 'ignored', text: 'no time' },
        { kind: 'ignored', text: 'nan time', at: Number.NaN },
        null,
        'x',
      ],
    })
    expect(out.signals).toEqual([sig('correction', 'keep me', 1)])
  })

  test('lengths are clamped and signals keep only the newest', () => {
    const many = Array.from({ length: SIGNALS_MAX + 10 }, (_, i) => ({ kind: 'ignored', text: `q${i}`, at: i }))
    const out = asProjectMemory({ brief: 'b '.repeat(BRIEF_MAX_CHARS), signals: many, updatedAt: 1, folds: 1 })
    expect(out.brief.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS)
    expect(out.signals.length).toBe(SIGNALS_MAX)
    expect(out.signals[SIGNALS_MAX - 1]?.text).toBe(`q${SIGNALS_MAX + 9}`)
    expect(out.signals[0]?.text).toBe('q10')
    const longText = asProjectMemory({ signals: [{ kind: 'ignored', text: 'x'.repeat(1_000), at: 1 }] })
    expect(longText.signals[0]?.text.length).toBeLessThanOrEqual(SIGNAL_TEXT_MAX)
  })

  test('profile is read and clamped', () => {
    expect(asProfileMemory({ profile: 'Runs a marketing agency in Cape Town.', updatedAt: 4 })).toEqual({
      profile: 'Runs a marketing agency in Cape Town.',
      updatedAt: 4,
    })
    expect(asProfileMemory({ profile: 'p '.repeat(PROFILE_MAX_CHARS) }).profile.length).toBeLessThanOrEqual(PROFILE_MAX_CHARS)
    expect(asProfileMemory({ profile: 3, updatedAt: -1 })).toEqual(EMPTY_PROFILE)
  })

  test('frozen input is read without throwing and left unchanged', () => {
    const raw = Object.freeze({ brief: 'b', signals: freezeSignals([sig('accepted', 'q')]), updatedAt: 1, folds: 1 })
    const before = JSON.stringify(raw)
    expect(() => asProjectMemory(raw)).not.toThrow()
    expect(JSON.stringify(raw)).toBe(before)
  })

  test('Afrikaans text passes through', () => {
    expect(asProfileMemory({ profile: 'Dankie, dis reg', updatedAt: 1 }).profile).toBe('Dankie, dis reg')
  })
})

describe('classifyUserMessage', () => {
  test('shouting with question marks is frustration', () => {
    expect(classifyUserMessage('BUT I AM NOT A DEVELOPER???? I WANT EXPERT INSIGHTS')).toBe('frustration')
  })

  test('frustration is checked before correction', () => {
    expect(classifyUserMessage("that's not what i said!!!")).toBe('frustration')
  })

  test('three marks in a row are frustration, two are not', () => {
    expect(classifyUserMessage('why is this still broken???')).toBe('frustration')
    expect(classifyUserMessage('can you fix it!!!')).toBe('frustration')
    expect(classifyUserMessage('can you fix it??')).toBeNull()
  })

  test('mostly capitals needs 12 letters before it counts', () => {
    expect(classifyUserMessage('WHY NOT')).toBeNull()
    expect(classifyUserMessage('PLEASE FIX THIS NOW')).toBe('frustration')
    expect(classifyUserMessage('Please fix this now')).toBeNull()
  })

  test('corrections are spotted in any case and with curly apostrophes', () => {
    expect(classifyUserMessage("I'm not a developer, I run a marketing agency")).toBe('correction')
    expect(classifyUserMessage('I’m not a developer')).toBe('correction')
    expect(classifyUserMessage('Thats not what I asked')).toBe('correction')
    expect(classifyUserMessage('No, use the other list')).toBe('correction')
    expect(classifyUserMessage('Why did you change the ad copy')).toBe('correction')
    expect(classifyUserMessage('I want a weekly report instead')).toBeNull()
  })

  test('ordinary instructions are not feedback', () => {
    expect(classifyUserMessage('Run the tests please')).toBeNull()
    expect(classifyUserMessage('Draft a follow up email for the new leads')).toBeNull()
  })

  test('empty, whitespace and non-string input give null', () => {
    expect(classifyUserMessage('')).toBeNull()
    expect(classifyUserMessage('   \n ')).toBeNull()
    expect(classifyUserMessage(undefined as never)).toBeNull()
  })

  test('emoji and Afrikaans do not trip it', () => {
    expect(classifyUserMessage('Dankie, dis reg 👍')).toBeNull()
    expect(classifyUserMessage('😡😡😡😡😡😡😡😡😡😡😡😡😡😡')).toBeNull()
  })
})

describe('addSignal', () => {
  test('appends to a new array, newest last, leaving the input alone', () => {
    const before = freezeSignals([sig('correction', 'a')])
    const out = addSignal(before, sig('accepted', 'b', 2))
    expect(out).toEqual([sig('correction', 'a'), sig('accepted', 'b', 2)])
    expect(out).not.toBe(before)
    expect(before.length).toBe(1)
  })

  test('text is trimmed and cut with an ellipsis within the cap', () => {
    const [only] = addSignal([], sig('ignored', `  ${'word '.repeat(200)}  `))
    expect(only?.text.length).toBeLessThanOrEqual(SIGNAL_TEXT_MAX)
    expect(only?.text.endsWith('…')).toBe(true)
    expect(addSignal([], sig('ignored', '  short  '))[0]?.text).toBe('short')
  })

  test('text that fits has no ellipsis', () => {
    expect(addSignal([], sig('ignored', 'x'.repeat(SIGNAL_TEXT_MAX)))[0]?.text).toBe('x'.repeat(SIGNAL_TEXT_MAX))
  })

  test('empty and whitespace text is ignored', () => {
    const start = freezeSignals([sig('correction', 'a')])
    expect(addSignal(start, sig('ignored', '   '))).toEqual(start)
    expect(addSignal(start, sig('ignored', ''))).not.toBe(start)
  })

  test('an exact duplicate moves to newest instead of repeating', () => {
    const start = freezeSignals([sig('ignored', 'Same Question?', 1), sig('accepted', 'other', 2)])
    const out = addSignal(start, sig('ignored', 'same question?', 9))
    expect(out.map(s => s.text)).toEqual(['other', 'same question?'])
    expect(out[1]?.at).toBe(9)
  })

  test('same text with a different kind is kept as well', () => {
    const out = addSignal([sig('ignored', 'q', 1)], sig('accepted', 'q', 2))
    expect(out.length).toBe(2)
  })

  test('each kind keeps only its newest signals, up to its own quota', () => {
    const full = Array.from({ length: SIGNAL_QUOTA.correction }, (_, i) => sig('correction', `q${i}`, i))
    const out = addSignal(freezeSignals(full), sig('correction', 'fresh', 99))
    expect(out.length).toBe(SIGNAL_QUOTA.correction)
    expect(out[0]?.text).toBe('q1')
    expect(out.at(-1)?.text).toBe('fresh')
    expect(out.length).toBeLessThanOrEqual(SIGNALS_MAX)
  })

  test('Afrikaans passes through untouched', () => {
    expect(addSignal([], sig('accepted', 'Dankie, dis reg'))[0]?.text).toBe('Dankie, dis reg')
  })

  test('a cut never leaves half an emoji', () => {
    const text = `${'a'.repeat(SIGNAL_TEXT_MAX - 2)}😀😀`
    const out = addSignal([], sig('ignored', text))[0]?.text ?? ''
    expect(out).not.toMatch(/[\ud800-\udbff]…$/)
    expect(out.length).toBeLessThanOrEqual(SIGNAL_TEXT_MAX)
  })
})

describe('pickSignals', () => {
  const items = Object.freeze([
    { title: 'A', question: 'Question A?' },
    { title: 'B', question: 'Question B?' },
    { title: 'C', question: 'Question C?' },
  ])

  test('picked are accepted and the rest ignored', () => {
    expect(pickSignals(items, [1], 7)).toEqual([
      sig('ignored', 'Question A?', 7),
      sig('accepted', 'Question B?', 7),
      sig('ignored', 'Question C?', 7),
    ])
  })

  test('out of range, negative, fractional and duplicate indexes are ignored', () => {
    const out = pickSignals(items, [0, 0, 9, -1, 1.5, Number.NaN], 1)
    expect(out.filter(s => s.kind === 'accepted').map(s => s.text)).toEqual(['Question A?'])
    expect(out.length).toBe(3)
  })

  test('nothing picked means everything ignored; no items means no signals', () => {
    expect(pickSignals(items, [], 1).every(s => s.kind === 'ignored')).toBe(true)
    expect(pickSignals([], [0], 1)).toEqual([])
  })

  test('a blank question is skipped', () => {
    expect(pickSignals([{ title: 't', question: '  ' }], [0], 1)).toEqual([])
  })
})

describe('shouldFold', () => {
  const turn = (user: string, assistant: string): FoldTurn => ({ user, assistant, signals: [] })

  test('a real exchange folds', () => {
    expect(shouldFold(turn('Plan the launch', 'x'.repeat(300)))).toBe(true)
  })

  test('short answers, empty questions and slash commands do not', () => {
    expect(shouldFold(turn('Plan the launch', 'Done.'))).toBe(false)
    expect(shouldFold(turn('   ', 'x'.repeat(300)))).toBe(false)
    expect(shouldFold(turn('/clear', 'x'.repeat(300)))).toBe(false)
    expect(shouldFold(turn('  /model opus', 'x'.repeat(300)))).toBe(false)
  })

  test('the length threshold is adjustable and inclusive', () => {
    expect(shouldFold(turn('hi', 'x'.repeat(50)), 50)).toBe(true)
    expect(shouldFold(turn('hi', 'x'.repeat(49)), 50)).toBe(false)
    expect(shouldFold(turn('hi', 'x'.repeat(199)))).toBe(false)
    expect(shouldFold(turn('hi', 'x'.repeat(200)))).toBe(true)
  })

  test('missing text never throws', () => {
    expect(shouldFold({ user: undefined, assistant: undefined, signals: [] } as never)).toBe(false)
  })
})

describe('FOLD_SYSTEM', () => {
  test('carries the rules the fold call depends on', () => {
    expect(FOLD_SYSTEM).toContain('not a developer')
    expect(FOLD_SYSTEM).toContain('PROJECT BRIEF')
    expect(FOLD_SYSTEM).toContain('USER PROFILE')
    expect(FOLD_SYSTEM).toContain(String(BRIEF_MAX_CHARS))
    expect(FOLD_SYSTEM).toContain(String(PROFILE_MAX_CHARS))
    expect(FOLD_SYSTEM).toContain('Never invent')
    expect(FOLD_SYSTEM).toContain('secrets')
    expect(FOLD_SYSTEM).toContain('{"brief":"...","profile":"..."}')
    expect(FOLD_SYSTEM).toContain('unchanged')
  })
})

describe('buildFoldPrompt', () => {
  const turn: FoldTurn = Object.freeze({
    user: 'Write the follow up',
    assistant: 'Here is the draft.',
    signals: Object.freeze([sig('correction', 'Not a developer')]),
  })

  test('holds the brief, profile, exchange and signals', () => {
    const p = buildFoldPrompt('Roofing leads.', 'Runs an agency.', turn)
    expect(p).toContain('Roofing leads.')
    expect(p).toContain('Runs an agency.')
    expect(p).toContain('Write the follow up')
    expect(p).toContain('Here is the draft.')
    expect(p).toContain('correction: Not a developer')
  })

  test('blank notes read (empty) and no signals leaves no signal list', () => {
    const p = buildFoldPrompt('  ', '', { user: 'u', assistant: 'a', signals: [] })
    expect(p.match(/\(empty\)/g)?.length).toBe(2)
    expect(p).not.toContain('Feedback')
  })

  test('personal details are redacted', () => {
    const p = buildFoldPrompt(
      '',
      '',
      {
        user: 'My ID is 8001015009087, email me at sam@example.co.za or call 082 123 4567',
        assistant: 'Sure, I will email sam@example.co.za.',
        signals: [],
      },
    )
    expect(p).not.toContain('8001015009087')
    expect(p).not.toContain('sam@example.co.za')
    expect(p).not.toContain('082 123 4567')
    expect(p).toMatch(/\[EMAIL:[a-p]{8}\]/)
    expect(p).toMatch(/\[SA_ID:[a-p]{8}\]/)
    expect(p).toMatch(/\[PHONE:[a-p]{8}\]/)
  })

  test('amounts are kept because they are useful facts', () => {
    expect(buildFoldPrompt('', '', { user: 'Budget is R15 000 a month', assistant: 'ok', signals: [] })).toContain('R15 000')
  })

  test('long text is cut to budget', () => {
    const p = buildFoldPrompt('', '', { user: 'u'.repeat(5_000), assistant: 'a'.repeat(8_000), signals: [] })
    expect(p).toContain(`${'u'.repeat(2_000)} [cut]`)
    expect(p).not.toContain('u'.repeat(2_001))
    expect(p).toContain(`${'a'.repeat(3_000)} [cut]`)
    expect(p).not.toContain('a'.repeat(3_001))
  })

  test('Afrikaans passes through', () => {
    expect(buildFoldPrompt('', '', { user: 'Dankie, dis reg', assistant: 'Plesier', signals: [] })).toContain('Dankie, dis reg')
  })
})

describe('parseFold', () => {
  test('reads plain JSON', () => {
    expect(parseFold('{"brief":"B","profile":"P"}')).toEqual({ brief: 'B', profile: 'P' })
  })

  test('tolerates prose and code fences around it', () => {
    expect(parseFold('Here you go:\n```json\n{"brief":" B ","profile":" P "}\n```\nDone.')).toEqual({ brief: 'B', profile: 'P' })
  })

  test('either note may be empty', () => {
    expect(parseFold('{"brief":"","profile":"P"}')).toEqual({ brief: '', profile: 'P' })
    expect(parseFold('{"brief":"B","profile":""}')).toEqual({ brief: 'B', profile: '' })
  })

  test('malformed replies give null', () => {
    for (const bad of ['', 'no json here', '{"brief":"B"', '{not json}', '[]', 'null', '{"brief":"B"}', '{"profile":"P"}']) {
      expect(parseFold(bad)).toBeNull()
    }
  })

  test('non-string values give null', () => {
    expect(parseFold('{"brief":1,"profile":"P"}')).toBeNull()
    expect(parseFold('{"brief":"B","profile":null}')).toBeNull()
    expect(parseFold('{"brief":["B"],"profile":{"a":1}}')).toBeNull()
  })

  test('over-long notes are cut at a word boundary within the cap', () => {
    const long = 'alpha beta '.repeat(500)
    const out = parseFold(JSON.stringify({ brief: long, profile: long }))
    expect(out).not.toBeNull()
    expect(out?.brief.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS)
    expect(out?.profile.length).toBeLessThanOrEqual(PROFILE_MAX_CHARS)
    expect(out?.brief.endsWith('alpha') || out?.brief.endsWith('beta')).toBe(true)
  })

  test('an unbroken over-long note is hard cut', () => {
    const out = parseFold(JSON.stringify({ brief: 'x'.repeat(BRIEF_MAX_CHARS + 50), profile: '' }))
    expect(out?.brief.length).toBe(BRIEF_MAX_CHARS)
  })

  test('Afrikaans and emoji pass through', () => {
    expect(parseFold('{"brief":"Dankie, dis reg","profile":"Hou van 👍"}')).toEqual({ brief: 'Dankie, dis reg', profile: 'Hou van 👍' })
  })
})

describe('applyFold', () => {
  const project = Object.freeze({ brief: 'old brief', signals: freezeSignals([sig('ignored', 'old q', 1)]), updatedAt: 1, folds: 2 })
  const profile = Object.freeze({ profile: 'old profile', updatedAt: 1 })

  test('returns new objects with the notes replaced and the count up', () => {
    const out = applyFold(project, profile, { brief: 'new brief', profile: 'new profile' }, [sig('accepted', 'new q', 5)], 50)
    expect(out.project.brief).toBe('new brief')
    expect(out.project.folds).toBe(3)
    expect(out.project.updatedAt).toBe(50)
    expect(out.project.signals.map(s => s.text)).toEqual(['old q', 'new q'])
    expect(out.profile).toEqual({ profile: 'new profile', updatedAt: 50 })
    expect(out.project).not.toBe(project)
    expect(out.profile).not.toBe(profile)
  })

  test('inputs are left untouched', () => {
    applyFold(project, profile, { brief: 'x', profile: 'y' }, [sig('accepted', 'z')], 9)
    expect(project.brief).toBe('old brief')
    expect(project.signals.length).toBe(1)
    expect(project.folds).toBe(2)
    expect(profile.profile).toBe('old profile')
  })

  test('an empty reply never wipes what we know', () => {
    const out = applyFold(project, profile, { brief: '', profile: '' }, [], 9)
    expect(out.project.brief).toBe('old brief')
    expect(out.profile.profile).toBe('old profile')
    expect(out.project.folds).toBe(2)
  })

  test('new signals go through the duplicate and cap rules', () => {
    const out = applyFold(project, profile, { brief: 'b', profile: 'p' }, [sig('ignored', 'OLD Q', 8), sig('ignored', '  ', 8)], 9)
    expect(out.project.signals).toEqual([sig('ignored', 'OLD Q', 8)])
  })
})

describe('parseBriefCommand', () => {
  test('nothing or show shows', () => {
    expect(parseBriefCommand('')).toEqual({ action: 'show' })
    expect(parseBriefCommand('   ')).toEqual({ action: 'show' })
    expect(parseBriefCommand('SHOW')).toEqual({ action: 'show' })
  })

  test('brief and profile take the rest as text', () => {
    expect(parseBriefCommand('brief  A roofing lead gen project. ')).toEqual({ action: 'set-brief', text: 'A roofing lead gen project.' })
    expect(parseBriefCommand('Profile I run an agency\nin Cape Town')).toEqual({ action: 'set-profile', text: 'I run an agency\nin Cape Town' })
  })

  test('only the action word is case-insensitive', () => {
    expect(parseBriefCommand('BRIEF Keep My CASE')).toEqual({ action: 'set-brief', text: 'Keep My CASE' })
  })

  test('long text is cut to the cap', () => {
    const cmd = parseBriefCommand(`brief ${'x'.repeat(BRIEF_MAX_CHARS + 100)}`)
    expect(cmd.action === 'set-brief' && cmd.text.length).toBe(BRIEF_MAX_CHARS)
    const p = parseBriefCommand(`profile ${'x'.repeat(PROFILE_MAX_CHARS + 100)}`)
    expect(p.action === 'set-profile' && p.text.length).toBe(PROFILE_MAX_CHARS)
  })

  test('forget and reset', () => {
    expect(parseBriefCommand('forget')).toEqual({ action: 'forget-signals' })
    expect(parseBriefCommand(' Reset ')).toEqual({ action: 'reset' })
  })

  test('brief or profile without text is invalid and says why', () => {
    for (const args of ['brief', 'profile  ']) {
      const cmd = parseBriefCommand(args)
      expect(cmd.action).toBe('invalid')
      expect(cmd.action === 'invalid' && cmd.reason).toContain('text')
    }
  })

  test('unknown words are invalid and list the valid ones', () => {
    const cmd = parseBriefCommand('banana split')
    expect(cmd.action).toBe('invalid')
    if (cmd.action === 'invalid') for (const w of ['show', 'brief', 'profile', 'forget', 'reset']) expect(cmd.reason).toContain(w)
  })

  test('forget and reset do not take extra words, so a typo cannot wipe memory', () => {
    expect(parseBriefCommand('reset everything').action).toBe('invalid')
    expect(parseBriefCommand('forget it').action).toBe('invalid')
  })

  test('non-string input is treated as nothing', () => {
    expect(parseBriefCommand(undefined as never)).toEqual({ action: 'show' })
  })
})

describe('renderMemory', () => {
  test('empty memory says so in each section', () => {
    const t = renderMemory(EMPTY_PROJECT, EMPTY_PROFILE)
    expect(t).toContain('## About the user\nNothing recorded yet.')
    expect(t).toContain('## The project so far\nNothing recorded yet.')
    expect(t).toContain('## What the user has told us and how they react\nNo feedback recorded yet.')
  })

  test('sections come in order with the notes and signals', () => {
    const t = renderMemory(
      { brief: 'Roofing leads.', signals: [sig('correction', 'Not a developer'), sig('accepted', 'What is the CPL?')], updatedAt: 1, folds: 1 },
      { profile: 'Agency owner, Cape Town.', updatedAt: 1 },
    )
    expect(t.indexOf('## About the user')).toBeLessThan(t.indexOf('## The project so far'))
    expect(t.indexOf('## The project so far')).toBeLessThan(t.indexOf('## What the user has told us'))
    expect(t).toContain('Agency owner, Cape Town.')
    expect(t).toContain('Roofing leads.')
    expect(t).toContain('- [correction] Not a developer')
    expect(t).toContain('- [accepted] What is the CPL?')
  })

  test('only the newest signals show, 12 by default, and the limit is adjustable', () => {
    const signals = Array.from({ length: 20 }, (_, i) => sig('accepted', `q${i}`, i))
    const project = { brief: '', signals, updatedAt: 1, folds: 1 }
    const t = renderMemory(project, EMPTY_PROFILE)
    expect(t.match(/^- \[/gm)?.length).toBe(12)
    expect(t).toContain('q19')
    expect(t).toContain('q8')
    expect(t).not.toContain('q7\n')
    expect(renderMemory(project, EMPTY_PROFILE, 3).match(/^- \[/gm)?.length).toBe(3)
    expect(renderMemory(project, EMPTY_PROFILE, 0)).toContain('No feedback recorded yet.')
  })

  test('frozen inputs are fine and Afrikaans passes through', () => {
    const project = Object.freeze({ brief: 'Dankie, dis reg', signals: freezeSignals([sig('accepted', 'Dankie, dis reg')]), updatedAt: 1, folds: 1 })
    const t = renderMemory(project, Object.freeze({ profile: 'Praat Afrikaans', updatedAt: 1 }))
    expect(t).toContain('Dankie, dis reg')
    expect(t).toContain('Praat Afrikaans')
  })
})
