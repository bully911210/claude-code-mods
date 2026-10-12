export type LedgerUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** A turn that rewrote the prompt cache after the session sat idle. */
export type LedgerMiss = {
  at: number
  gapMinutes: number
  /** "5m" when the gap passed the 5-minute cache, "1h" past the 1-hour one. */
  ttl: '5m' | '1h'
  tokensRewritten: number
  costUsd: number
}

export type LedgerTurn = {
  at: number
  costUsd: number
  usage: LedgerUsage
  durationMs: number
}

export type LedgerDay = {
  costUsd: number
  turns: number
  usage: LedgerUsage
  misses: number
  missCostUsd: number
  /** The part of costUsd that subagents spent. */
  agentUsd: number
}

export type LedgerSession = {
  costUsd: number
  turns: number
  usage: LedgerUsage
}

/** One subagent as the ledger tracks it. */
export type LedgerAgent = {
  id: string
  type: string
  description: string
  model: string
  status: string
  parentId?: string
  calls: number
  usage: LedgerUsage
  /** Price-table estimate not yet matched against the engine's cost. */
  pendingUsd: number
  /** Cost so far, scaled so all sources add up to the engine's total. */
  costUsd: number
  tool: string
  startedAt: number
  endedAt?: number
  isAlerted: boolean
}

/** The 5-hour limit's percentage used at a moment, for the burn rate. */
export type LedgerSample = {
  at: number
  percent: number
}

declare module 'claude-code' {
  interface PluginState {
    'token-ledger': {
      agents: LedgerAgent[]
      /** The main loop's estimate not yet matched against the engine's cost. */
      mainPendingUsd: number
      /** The 5-hour limit's percentage used over time, newest last. */
      samples: LedgerSample[]
      /** The weekly limit's percentage used, -1 with no reading. */
      weekPercent: number
      /** When the 5-hour window resets (ISO), '' with no reading. */
      fiveHourResetsAt: string
      /** The 5-hour percentage when the session started, for points used since. */
      startPercent: number
      /** The effort the main loop's last model call asked for, '' when none was reported. */
      effort: string
      /** The Haiku insight launcher: its state and the questions it last produced. */
      insights: {
        status: 'idle' | 'loading' | 'ready' | 'empty' | 'error'
        items: { title: string; question: string }[]
        error: string
        insertError: string
      }
      session: LedgerSession
      recent: LedgerTurn[]
      misses: LedgerMiss[]
      today: LedgerDay
      week: LedgerDay
      /** When the last main-loop turn ended, for the idle-gap check. */
      lastEndAt: number
      /** The engine's session cost at the last turn, to price each turn. */
      lastCostUsd: number
      /** The context fill and the 5-hour window, as of the last turn. */
      contextPercent: number
      fiveHourPercent: number
    }
  }
}
