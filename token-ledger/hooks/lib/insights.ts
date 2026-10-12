// Pure logic for the Haiku insight launcher: what context goes in, how the
// reply is read, and how a picked question joins the prompt box. No engine calls.

export const INSIGHT_MODEL = 'claude-haiku-5-5'
export const QUESTION_COUNT = 5

/** Budgets keep the request small and fast; the newest context matters most. */
const MAX_MESSAGES = 40
const MAX_MESSAGE_CHARS = 1_500
const MAX_THINKING_CHARS = 4_000
const MAX_PROJECT_DOC_CHARS = 6_000
const MAX_TOTAL_CHARS = 60_000

export type Insight = { readonly title: string; readonly question: string }

export type InsightContext = {
  readonly project: {
    readonly name: string
    readonly branch: string
    readonly gitStatus: string
    readonly recentCommits: string
    readonly docs: readonly { readonly path: string; readonly text: string }[]
  }
  readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly text: string; readonly tools: readonly string[] }[]
  readonly thinking: readonly string[]
}

export const SYSTEM = [
  'You help a developer get more out of their current Claude Code conversation.',
  `Write exactly ${QUESTION_COUNT} questions the developer could ask Claude next.`,
  'Each question must uncover something the conversation has not adequately explored:',
  'information or capabilities the system already has but has not surfaced; non-obvious technical opportunities;',
  'critical assumptions nobody has verified; failure modes, edge cases and architectural weaknesses;',
  'or a high-leverage experiment or investigation that would materially improve the outcome.',
  'Tie every question to specifics in the context (files, tools, decisions, errors, names). No generic prompts.',
  'Make the five meaningfully different from one another. Keep each question under 220 characters and actionable.',
  'Use only what the context shows. Do not claim to have seen anything it does not contain.',
  'Reply with JSON only: {"questions":[{"title":"2-5 word label","question":"the full question"}]}',
].join(' ')

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)} [cut]` : s)

/** The context as one prompt, newest conversation last, inside the total budget. */
export const buildPrompt = (c: InsightContext): string => {
  const project = [
    `Project folder: ${c.project.name || 'unknown'}`,
    c.project.branch ? `Git branch: ${c.project.branch}` : 'Not a git repository (or branch unknown).',
    c.project.gitStatus ? `Uncommitted changes:\n${cut(c.project.gitStatus, 2_000)}` : '',
    c.project.recentCommits ? `Recent commits:\n${cut(c.project.recentCommits, 1_500)}` : '',
    ...c.project.docs.map(d => `Project instructions (${d.path}):\n${cut(d.text, MAX_PROJECT_DOC_CHARS)}`),
  ].filter(Boolean)
  const thinking = c.thinking.filter(t => t.trim() !== '')
  const thinkingPart = thinking.length
    ? [`Claude's visible reasoning notes (most recent):\n${cut(thinking.slice(-3).join('\n---\n'), MAX_THINKING_CHARS)}`]
    : ["Claude's reasoning is not visible for this conversation; do not guess at it."]
  const convo = c.messages.slice(-MAX_MESSAGES).map(m => {
    const tools = m.tools.length ? ` [tools: ${[...new Set(m.tools)].join(', ')}]` : ''
    return `${m.role === 'user' ? 'USER' : 'CLAUDE'}${tools}: ${cut(m.text.trim(), MAX_MESSAGE_CHARS)}`
  })
  const head = ['## Project', ...project, '', '## Reasoning', ...thinkingPart, '', '## Conversation (oldest first)'].join('\n')
  // Drop the oldest messages until the whole prompt fits.
  let body = convo
  while (body.length > 1 && head.length + body.join('\n').length > MAX_TOTAL_CHARS) body = body.slice(1)
  return `${head}\n${body.join('\n')}`
}

/** Reads the reply strictly: at most five distinct questions, anything malformed dropped. */
export const parseInsights = (reply: string): Insight[] => {
  const match = reply.match(/\{[\s\S]*\}/)
  if (!match) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return []
  }
  const list = (parsed as { questions?: unknown }).questions
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: Insight[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const question = typeof (item as Insight).question === 'string' ? (item as Insight).question.trim() : ''
    const title = typeof (item as Insight).title === 'string' ? (item as Insight).title.trim() : ''
    const key = question.toLowerCase()
    if (question === '' || seen.has(key)) continue
    seen.add(key)
    out.push({ title: title || question.split(/\s+/).slice(0, 4).join(' '), question })
    if (out.length === QUESTION_COUNT) break
  }
  return out
}

/**
 * How the ticked questions join the prompt box: never over the user's own text.
 * Several go in together, one blank line apart, in the order they were ticked.
 */
export const fillPlan = (
  current: string,
  questions: readonly string[],
): { readonly text: string; readonly mode: 'replace' | 'append' } => {
  const joined = questions
    .map(q => q.trim())
    .filter(q => q !== '')
    .join('\n\n')
  return current.trim() === ''
    ? { text: joined, mode: 'replace' }
    : { text: `${current.endsWith('\n') ? '' : '\n\n'}${joined}`, mode: 'append' }
}
