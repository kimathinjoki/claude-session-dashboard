export type CacheReading = {
  lastRequestAt: number | null
  cachedTokens: number
  ttlMinutes: number
  keepWarm: boolean
  pings: number
  lastPingAt: number | null
  // Share of each main-thread request's input served from cache, newest last.
  history: number[]
  readTokens: number
  writtenTokens: number
  coldStarts: number
  // Tokens re-written by cold starts: paid at the write price instead of the read price.
  rewrittenTokens: number
  // Tokens the keep-warm pings read back.
  pingReadTokens: number
  // Every request's tokens, weighted by price ratio and model, for pricing a token from /cost.
  weightedAll: number
  sessionUsd: number | null
  // The session cost when weighting began: a token is priced from the cost added since, over
  // the requests weighed since, so both cover the same stretch of the session.
  usdBaseline: number | null
  mainModel: string
}

declare module 'claude-code' {
  interface PluginState {
    'cache-tax': { reading: CacheReading; tick: number }
  }
}
