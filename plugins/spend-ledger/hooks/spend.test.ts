import { expect, test } from 'claude-code/testing'

import { activityOf, apportion, burnPerHour, modelFactor, usd, weight } from './register'

test('an increase is shared by request weight and always adds up', async () => {
  const shares = apportion(3, { a: 100, b: 200 })
  expect(Math.round(shares.a! * 1000)).toBe(1000)
  expect(Math.round(shares.b! * 1000)).toBe(2000)
  expect(apportion(0.5, {})).toEqual({ helpers: 0.5 })
})

test('output and the dearer model weigh more', async () => {
  const u = { input_tokens: 0, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  expect(weight(u, 'claude-opus-5-5')).toBe(2500)
  expect(weight(u, 'claude-sonnet-5-5')).toBe(1500)
  expect(modelFactor('claude-haiku-5-5')).toBe(1)
})

test('burn rate is per hour over the recent window', async () => {
  expect(Math.round(burnPerHour([{ at: 0, usd: 1 }, { at: 600_000, usd: 3 }], 600_000))).toBe(12)
})

test('money reads short and work is grouped by what it was', async () => {
  expect(usd(0.42)).toBe('42¢')
  expect(usd(12.345)).toBe('$12.35')
  expect(activityOf({ kind: 'agent', label: 'Review Task 16 (spec + quality)' })[0]).toBe('inspecting')
  expect(activityOf({ kind: 'agent', label: 'Implement Task 5: cognitive client' })[0]).toBe('building')
  expect(activityOf({ kind: 'prompt', label: 'keep going' })[0]).toBe('conversation')
})
