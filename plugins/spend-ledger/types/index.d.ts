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

export type PlanWindow = { kind: string; percentUsed: number; resetsAt?: string }

export type Ledger = {
  entries: SpendEntry[]
  // Filled on a Claude subscription: the plan's usage windows, as the API last reported them.
  limits: PlanWindow[]
  // A plan budget: warn when the five-hour window passes this share (0 to 100).
  planBudgetPercent: number | null
  limitSamples: SpendSample[]
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
