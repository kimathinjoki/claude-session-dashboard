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
}

declare module 'claude-code' {
  interface PluginState {
    'cache-tax': { reading: CacheReading; tick: number }
  }
}
