import { expect, test } from 'claude-code/testing'

import { coldFactor, remainingMs, statusText } from './register'

const base = { lastRequestAt: 0, cachedTokens: 180_000, ttlMinutes: 5, keepWarm: false, pings: 0, lastPingAt: null, history: [], readTokens: 0, writtenTokens: 0, coldStarts: 0 }

test('a warm cache counts down and names its size', async () => {
  expect(remainingMs(base, 60_000)).toBe(240_000)
  expect(statusText(base, 60_000)).toBe('cache warm 4:00 left (180k)')
})

test('a lapsed cache says the next prompt re-writes it', async () => {
  expect(statusText(base, 6 * 60_000)).toBe('cache cold: next prompt re-writes 180k tokens')
})

test('nothing to say before the first response', async () => {
  expect(statusText({ ...base, lastRequestAt: null }, 0)).toBeUndefined()
})

test('a cold prompt costs 12.5x a warm read on the 5 minute cache, 20x on the hour', async () => {
  expect(coldFactor(5)).toBe(12.5)
  expect(coldFactor(60)).toBe(20)
})

import { mood, sparkline } from './register'

test('the panel mood follows the window', async () => {
  const r = { lastRequestAt: 0, cachedTokens: 100_000, ttlMinutes: 60, keepWarm: false, pings: 0, lastPingAt: null, history: [], readTokens: 0, writtenTokens: 0, coldStarts: 0 }
  expect(mood(r, 10 * 60_000)).toBe('warm')
  expect(mood(r, 50 * 60_000)).toBe('fading')
  expect(mood(r, 61 * 60_000)).toBe('cold')
  expect(mood({ ...r, cachedTokens: 0 }, 0)).toBe('empty')
})

test('hit rates draw as a sparkline', async () => {
  expect(sparkline([0, 0.5, 1])).toBe('▁▅█')
})
