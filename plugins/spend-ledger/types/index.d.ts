export type SpendEntry = {
  id: string
  kind: 'prompt' | 'agent' | 'helpers'
  label: string
  model: string
  usd: number
  steps: number
  startedAt: number
}

export type SpendSample = { at: number; usd: number }

export type Ledger = {
  entries: SpendEntry[]
  totalUsd: number
  samples: SpendSample[]
  budgetUsd: number | null
  warned: number[]
}

declare module 'claude-code' {
  interface PluginState {
    'spend-ledger': { ledger: Ledger }
  }
}
