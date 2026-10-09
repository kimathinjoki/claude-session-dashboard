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

export type DayStat = DayModel & { sessions: number; models: Record<string, DayModel>; estimated?: boolean }

// Kept across sessions in the plugin's store: one row per local calendar day.
export type History = {
  days: Record<string, DayStat>
  sessions: number
  longestSessionMs: number
  firstSeen: number | null
}

// What Claude Code keeps in ~/.claude/stats-cache.json (the file /usage reads), reduced to
// what the charts need. Read only; refreshed every few minutes.
export type ClaudeModelTotals = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type ClaudeStats = {
  days: Record<string, { tokensByModel: Record<string, number>; messages: number; sessions: number; toolCalls: number }>
  models: Record<string, ClaudeModelTotals>
  totalSessions: number
  longestSessionMs: number
  firstSessionDate: string | null
  hourCounts: number[]
  computedOn: string | null
  // False on a subscription, where Claude Code records every model's cost as 0.
  recordsCost: boolean
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
  claudeStats: ClaudeStats | null
  // Session cost and weighted requests since the mod began measuring, to price a past day's tokens.
  usdBaseline: number | null
  weightedSince: number
  totalUsd: number
  samples: SpendSample[]
  budgetUsd: number | null
  // When on, a prompt you type is refused once the budget is reached (the dollar one, or the
  // plan line). Work already running carries on; slash commands always go through.
  hardStop: boolean
  warned: number[]
}

declare module 'claude-code' {
  interface PluginState {
    'spend-ledger': { ledger: Ledger }
  }
}
