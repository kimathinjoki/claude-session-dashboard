export type AgentRow = {
  id: string
  description: string
  type: string
  model: string
  status: string
  steps: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  startedAt: number
  lastStepAt: number | null
  endedAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'agent-progress': { agents: AgentRow[]; sessionUsd: number | null; tick: number }
  }
}
