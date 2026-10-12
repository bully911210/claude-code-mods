/** A next prompt the band offers. */
export type NextStep = string

declare module 'claude-code' {
  interface PluginState {
    'next-steps': {
      /** The suggestions on offer; empty hides them. */
      steps: NextStep[]
      /** Indexes ticked for insertion, in the order they were ticked. */
      picked: number[]
      /** True when the pane could not be placed and the suggestions fall back into the band. */
      inBand: boolean
      /** Turned off for this session with `/next off`. */
      isMuted: boolean
    }
  }
}

