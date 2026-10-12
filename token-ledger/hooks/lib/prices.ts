// List prices per million tokens, from the Claude API reference (cached
// 2026-10-06). Only ratios between sources matter: estimates are scaled to
// the engine's own session cost after every main-loop turn.

import type { LedgerUsage } from '../../types'

type Price = { readonly input: number; readonly output: number; readonly cacheRead: number }

const PRICES: readonly (readonly [RegExp, Price])[] = [
  [/fable|mythos/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/sonnet-4/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/sonnet/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/haiku-4/, { input: 1, output: 5, cacheRead: 0.1 }],
  [/haiku/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
]

/** Unknown models price as the current Opus, the default. */
const FALLBACK: Price = { input: 4, output: 20, cacheRead: 0.2 }

/** A 5-minute cache write costs 1.25x input. */
const CACHE_WRITE_FACTOR = 1.25

export const priceFor = (model: string): Price =>
  PRICES.find(([pattern]) => pattern.test(model.toLowerCase()))?.[1] ?? FALLBACK

export const estimateUsd = (usage: LedgerUsage, model: string): number => {
  const p = priceFor(model)
  return (
    (usage.input * p.input +
      usage.output * p.output +
      usage.cacheRead * p.cacheRead +
      usage.cacheWrite * p.input * CACHE_WRITE_FACTOR) /
    1_000_000
  )
}

/** A short model name for the lanes: `claude-opus-5-5` -> `opus`. */
export const shortModel = (model: string): string =>
  ['fable', 'mythos', 'opus', 'sonnet', 'haiku'].find(m => model.toLowerCase().includes(m)) ?? (model || '?')
