import { expect, test } from 'claude-code/testing'

import { coldFactor, remainingMs, statusText } from './register'

const base = { lastRequestAt: 0, cachedTokens: 180_000, ttlMinutes: 5, keepWarm: false, pings: 0, lastPingAt: null, history: [], readTokens: 0, writtenTokens: 0, coldStarts: 0, rewrittenTokens: 0, pingReadTokens: 0, weightedAll: 0, sessionUsd: null, mainModel: '' }

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
  const r = { lastRequestAt: 0, cachedTokens: 100_000, ttlMinutes: 60, keepWarm: false, pings: 0, lastPingAt: null, history: [], readTokens: 0, writtenTokens: 0, coldStarts: 0, rewrittenTokens: 0, pingReadTokens: 0, weightedAll: 0, sessionUsd: null, mainModel: '' }
  expect(mood(r, 10 * 60_000)).toBe('warm')
  expect(mood(r, 50 * 60_000)).toBe('fading')
  expect(mood(r, 61 * 60_000)).toBe('cold')
  expect(mood({ ...r, cachedTokens: 0 }, 0)).toBe('empty')
})

test('hit rates draw as a sparkline', async () => {
  expect(sparkline([0, 0.5, 1])).toBe('▁▅█')
})

import { cacheCosts, money, weightOf } from './register'

test('cache costs are priced from the session cost and the multipliers', async () => {
  const r = {
    lastRequestAt: 0, cachedTokens: 100_000, ttlMinutes: 60, keepWarm: true, pings: 2, lastPingAt: 0, history: [],
    readTokens: 1_000_000, writtenTokens: 100_000, coldStarts: 1, rewrittenTokens: 100_000, pingReadTokens: 200_000,
    weightedAll: 1_000_000, sessionUsd: 1, mainModel: 'claude-opus-5-5',
  }
  // $1 over 1M weighted units, Opus factor 5: a base input token is $0.000005.
  const c = cacheCosts(r)!
  expect(money(c.saved)).toBe('$4.50')
  expect(money(c.coldTax)).toBe('95¢')
  expect(money(c.pings)).toBe('10¢')
  expect(money(c.ifColdNow)).toBe('95¢')
  expect(cacheCosts({ ...r, sessionUsd: null })).toBeNull()
  expect(weightOf({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 }, 'claude-sonnet-5-5', 5)).toBe(3)
})
