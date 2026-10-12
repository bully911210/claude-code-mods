// Pure detection and tokenising of South African personal information.
// No engine calls here, so the tests cover it directly.

export type Kind = 'EMAIL' | 'SA_ID' | 'CARD' | 'PHONE' | 'BANK_ACC' | 'PASSPORT' | 'AMOUNT' | 'MEDIA'

export type RedactOptions = {
  readonly salt: string
  readonly redactAmounts: boolean
}

export type RedactResult = {
  readonly text: string
  readonly counts: Readonly<Partial<Record<Kind, number>>>
}

/** Tokens hold letters only, so no later digit pattern can match inside one. */
export const TOKEN_PATTERN = /\[(?:EMAIL|SA_ID|CARD|PHONE|BANK_ACC|PASSPORT|AMOUNT):[a-p]{8}\]/

export const luhnValid = (digits: string): boolean => {
  if (!/^\d+$/.test(digits)) return false
  let sum = 0
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** 13 digits: YYMMDD, 4-digit sequence, citizenship 0/1/2, race digit, Luhn check. */
export const isSaId = (digits: string): boolean => {
  if (!/^\d{13}$/.test(digits)) return false
  const month = Number(digits.slice(2, 4))
  const day = Number(digits.slice(4, 6))
  if (month < 1 || month > 12) return false
  if (day < 1 || day > (DAYS_IN_MONTH[month - 1] ?? 0)) return false
  if (!'012'.includes(digits[10] ?? '')) return false
  return luhnValid(digits)
}

/** FNV-1a over salt + value, spelled in the letters a-p: stable per session, no digits. */
export const tokenFor = (kind: Kind, value: string, salt: string): string => {
  let hash = 0x811c9dc5
  const input = `${salt}\u0000${kind}\u0000${value}`
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const letters = hash
    .toString(16)
    .padStart(8, '0')
    .replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)))
  return `[${kind}:${letters}]`
}

type Rule = {
  readonly kind: Kind
  readonly pattern: RegExp
  /** Which capture group holds the sensitive part; 0 for the whole match. */
  readonly group: number
  readonly accept: (value: string) => boolean
}

const digitsOf = (s: string): string => s.replace(/\D/g, '')

/** `logo@2x.png`, `pkg@1.2.3.tgz`: file names and package specs, not addresses. */
const FILE_LIKE = /\.(?:png|jpe?g|gif|svg|webp|ico|tgz|zip|gz|js|mjs|cjs|ts|tsx|jsx|json|css|scss|map|lock|md|html?|py|rb|go|rs|java|php|vue|txt|log|csv|xml|ya?ml)$/i

/** The same person spelled two ways ("082 123 4567", "+27821234567") gets one token. */
const normalise = (kind: Kind, value: string): string => {
  if (kind === 'EMAIL' || kind === 'PASSPORT') return value.toLowerCase()
  const digits = digitsOf(value)
  if (kind === 'PHONE') return digits.replace(/^(?:0027|27|0)/, '')
  return digits
}

const RULES: readonly Rule[] = [
  {
    kind: 'EMAIL',
    pattern: /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w:@-])/g,
    group: 0,
    accept: v => !FILE_LIKE.test(v) && !/^git@/i.test(v),
  },
  {
    kind: 'SA_ID',
    pattern: /(?<!\d)(?<!\d\.)\d{6}[ -]?\d{4}[ -]?\d{3}(?!\d)(?!\.\d)/g,
    group: 0,
    accept: v => isSaId(digitsOf(v)),
  },
  {
    kind: 'CARD',
    pattern: /(?<!\d)(?<!\d\.)\d(?:[ -]?\d){12,18}(?!\d)(?!\.\d)/g,
    group: 0,
    accept: v => {
      const d = digitsOf(v)
      return d.length >= 13 && d.length <= 19 && /^[2-6]/.test(d) && luhnValid(d)
    },
  },
  {
    kind: 'PHONE',
    pattern: /(?<![\w+])(?:\+27[ -]?(?:\(0\))?|0027|0)[ -.]?\(?[1-8]\d\)?(?:[ -.]?\d){7}(?!\w)(?!\.\d)/g,
    group: 0,
    accept: () => true,
  },
  {
    kind: 'BANK_ACC',
    pattern:
      /\b(?:acc(?:ount)?|acct|rekening(?:nommer)?)(?:\s*(?:no|nr|number|num|#))?\.?\s*[:#]?\s*(\d(?:[ -]?\d){5,15})(?!\d)/gi,
    group: 1,
    accept: () => true,
  },
  {
    kind: 'PASSPORT',
    pattern: /\bpas(?:s)?(?:port|poort)(?:\s*(?:no|nr|number|#))?\.?\s*[:#]?\s*([A-Z]{0,2}\d{7,9})\b/gi,
    group: 1,
    accept: () => true,
  },
]

const AMOUNT_RULE: Rule = {
  kind: 'AMOUNT',
  pattern: /(?<![A-Za-z])R\s?\d{1,3}(?:[ ,]\d{3})*(?:[.,]\d{2})?(?![\d])/g,
  group: 0,
  accept: () => true,
}

const applyRule = (
  text: string,
  rule: Rule,
  salt: string,
): { readonly text: string; readonly count: number } => {
  let count = 0
  const out = text.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
    const part = rule.group === 0 ? match : rest[rule.group - 1]
    if (typeof part !== 'string' || !rule.accept(part)) return match
    count += 1
    const token = tokenFor(rule.kind, normalise(rule.kind, part), salt)
    return rule.group === 0 ? token : match.replace(part, token)
  })
  return { text: out, count }
}

/** Returns a new string with every detected item swapped for its token. */
export const redact = (text: string, options: RedactOptions): RedactResult => {
  const rules = options.redactAmounts ? [...RULES, AMOUNT_RULE] : RULES
  return rules.reduce<RedactResult>(
    (acc, rule) => {
      const step = applyRule(acc.text, rule, options.salt)
      if (step.count === 0) return acc
      return {
        text: step.text,
        counts: { ...acc.counts, [rule.kind]: (acc.counts[rule.kind] ?? 0) + step.count },
      }
    },
    { text, counts: {} },
  )
}

export const totalOf = (counts: Readonly<Partial<Record<Kind, number>>>): number =>
  Object.values(counts).reduce<number>((a, b) => a + (b ?? 0), 0)

export const mergeCounts = (
  a: Readonly<Partial<Record<Kind, number>>>,
  b: Readonly<Partial<Record<Kind, number>>>,
): Partial<Record<Kind, number>> => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<Kind>
  return Object.fromEntries([...keys].map(k => [k, (a[k] ?? 0) + (b[k] ?? 0)]))
}
