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

// Five-minute slices of the session, oldest first, for the charts.
export type SpendBucket = {
  start: number
  usd: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  planPercent: number | null
}

export type ModelSpend = {
  usd: number
  steps: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
}

export type DayModel = { usd: number; requests: number; input: number; output: number; cacheRead: number; cacheWrite: number }

export type DayStat = DayModel & { sessions: number; models: Record<string, DayModel> }

// Kept across sessions in the plugin's store: one row per local calendar day.
export type History = {
  days: Record<string, DayStat>
  sessions: number
  longestSessionMs: number
  firstSeen: number | null
}

export type StatsView = 'overview' | 'tokens' | 'cost' | 'cache' | 'inout'
export type StatsRange = 'session' | '7d' | '30d' | 'all'
export type StatsChart = 'line' | 'area' | 'bars' | 'dots'

export type PlanWindow = { kind: string; percentUsed: number; resetsAt?: string }

export type Ledger = {
  entries: SpendEntry[]
  // Filled on a Claude subscription: the plan's usage windows, as the API last reported them.
  limits: PlanWindow[]
  // A plan budget: warn when the five-hour window passes this share (0 to 100).
  planBudgetPercent: number | null
  limitSamples: SpendSample[]
  // The WHERE IT WENT list shows every row instead of the top ones.
  expanded: boolean
  // By model id: cost (estimated, as the rows are) and what it processed.
  models: Record<string, ModelSpend>
  buckets: SpendBucket[]
  history: History
  statsView: StatsView
  statsRange: StatsRange
  // Charts one model only when set; null charts them all.
  statsModel: string | null
  statsChart: StatsChart
  sessionStartedAt: number | null
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
