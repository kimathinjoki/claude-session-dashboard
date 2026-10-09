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

import { resetsIn, usageHue, windowLabel } from './register'

test('plan windows read as a share and a reset time', async () => {
  expect(windowLabel('five_hour')).toBe('5-hour window')
  expect(windowLabel('seven_day')).toBe('weekly')
  const now = Date.parse('2026-10-09T12:00:00Z')
  expect(resetsIn('2026-10-09T14:05:00Z', now)).toBe('resets in 2h 05m')
  expect(resetsIn('2026-10-12T12:00:00Z', now)).toBe('resets in 3d 0h')
  expect(usageHue(40)).toBe('#22c55e')
  expect(usageHue(70)).toBe('#f97316')
  expect(usageHue(90)).toBe('#ef4444')
})

import { modelHue, modelName } from './register'

test('models read short and keep their family colour', async () => {
  expect(modelName('claude-opus-5-5')).toBe('opus-5-5')
  expect(modelName('claude-sonnet-5-5-20261001')).toBe('sonnet-5-5')
  expect(modelHue('claude-opus-5-5')).toBe('#c084fc')
  expect(modelHue('claude-haiku-5-5')).toBe('#34d399')
})

import { BUCKET_MS, columns, intoBucket, sparkline } from './register'

test('charts: buckets open in five-minute steps and columns scale to the peak', async () => {
  let buckets = intoBucket([], 0, b => ({ ...b, usd: b.usd + 1 }))
  buckets = intoBucket(buckets, 2 * BUCKET_MS + 10, b => ({ ...b, usd: b.usd + 3 }))
  expect(buckets.map(b => b.usd)).toEqual([1, 0, 3])
  expect(columns([1, 0, 2], 2)).toEqual(['  █', '█ █'])
  expect(sparkline([0, 0.5, 1], 1)).toBe('▁▅█')
})

import { addToDay, dayKey, emptyHistory, heatmap, lineChart, resample, stretch, tilesFor } from './stats'

test('stats: days add up, streaks count and charts draw', async () => {
  const day = 86_400_000
  const now = Date.parse('2026-10-09T12:00:00')
  let h = emptyHistory()
  for (const back of [0, 1, 2, 5]) {
    h = addToDay(h, now - back * day, d => ({ ...d, requests: d.requests + 1, input: d.input + 1000, output: d.output + 10 }))
  }
  const t = tilesFor(h, '7d', now, null)
  expect(t.activeDays).toBe(4)
  expect(t.currentStreak).toBe(3)
  expect(t.longestStreak).toBe(3)
  expect(dayKey(now)).toBe('2026-10-09')
  expect(resample([1, 2, 3, 4], 2)).toEqual([1.5, 3.5])
  // A few points fill the whole width instead of its left part.
  expect(stretch([1, 2], 4)).toEqual([1, 1, 2, 2])
  // One continuous line: flat, a rounded rise, flat again.
  expect(lineChart([0, 0, 1, 1], 4, 2)).toEqual([' ╭──', '─╯  '])
  expect(lineChart([1, 0], 2, 2)).toEqual(['╮ ', '╰─'])
  expect(heatmap(h, now, 4).levels.length).toBe(7)
})
