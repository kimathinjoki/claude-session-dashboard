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

import { addToDay, dayKey, emptyHistory, heatmap, interpolate, lineChart, resample, stretch, tilesFor } from './stats'

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
  // Two points across four columns climb gradually rather than in one step.
  expect(interpolate([0, 3], 4)).toEqual([0, 1, 2, 3])
  expect(lineChart([1, 0], 2, 2)).toEqual(['╮ ', '╰─'])
  // A day with no data is a gap, not a zero.
  expect(lineChart([Number.NaN, Number.NaN, 1, 1], 4, 2)).toEqual(['  ──', '    '])
  expect(heatmap(h, now, 4).levels.length).toBe(7)
})


import { areaChart, barChart, dotChart } from './stats'

test('chart styles: area fills, bars stand apart, dots stand alone', async () => {
  expect(areaChart([0, 1], 3, 1)).toEqual(['▁▄█'])
  expect(barChart([1, 2], 6, 1)).toEqual(['▄▄ ██ '])
  const dots = dotChart([0, 1], 1, 1)
  expect(dots[0]!.length).toBe(1)
  expect(dots[0]).not.toBe(String.fromCharCode(0x2800))
})


import { colourRuns, columnPoints, trendOf } from './stats'

test('columns are coloured by how their point changed', async () => {
  expect(trendOf([1, 2, 2, 1], 1)).toBe('up')
  expect(trendOf([1, 2, 2, 1], 2)).toBe('flat')
  expect(trendOf([1, 2, 2, 1], 3)).toBe('down')
  expect(trendOf([1, Number.NaN, 3], 2)).toBe('up')
  expect(columnPoints('area', 2, 4)).toEqual([0, 0, 1, 1])
  expect(columnPoints('bars', 2, 6)).toEqual([0, 0, 0, 1, 1, 1])
  expect(colourRuns('ab c', ['x', 'x', 'y', 'y'])).toEqual([{ text: 'ab', hue: 'x' }, { text: ' c', hue: 'y' }])
})


import { mergeHistory, parseClaudeStats } from './stats'

test("Claude Code's own history fills the past days, estimated", async () => {
  const file = JSON.stringify({
    lastComputedDate: '2026-10-08', totalSessions: 223, firstSessionDate: '2025-12-26T19:53:15.081Z',
    longestSession: { duration: 276909690 },
    dailyActivity: [{ date: '2026-10-07', messageCount: 1237, sessionCount: 1, toolCallCount: 240 }],
    dailyModelTokens: [{ date: '2026-10-07', tokensByModel: { 'claude-opus-5-5': 1000 } }],
    modelUsage: { 'claude-opus-5-5': { inputTokens: 0, outputTokens: 100, cacheReadInputTokens: 800, cacheCreationInputTokens: 100 } },
    hourCounts: { '9': 4, '14': 7 },
  })
  const claude = parseClaudeStats(file)!
  expect(claude.totalSessions).toBe(223)
  expect(claude.hourCounts[14]).toBe(7)
  const merged = mergeHistory(emptyHistory(), claude)
  const day = merged.days['2026-10-07']!
  expect(day.estimated).toBe(true)
  expect(Math.round(day.output)).toBe(100)
  expect(Math.round(day.cacheRead)).toBe(800)
  expect(day.requests).toBe(1237)
  expect(day.usd).toBeGreaterThan(0)
  expect(merged.sessions).toBe(223)
  expect(claude.recordsCost).toBe(false)
  expect(parseClaudeStats('not json')).toBeNull()
})


import { listCost } from './stats'

test("past days are priced at each model's list price", async () => {
  // Opus 5.5: 1M cache reads at $0.20, 1M output at $20.
  expect(Math.round(listCost('claude-opus-5-5', { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 })! * 100)).toBe(2020)
  expect(listCost('claude-sonnet-5-5', { input: 2_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(4)
  expect(listCost('some-unknown-model', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeNull()
})


import { budgetReached } from './register'

test('the hard stop knows when the budget is used up', async () => {
  expect(budgetReached({ budgetUsd: 50, planBudgetPercent: null, totalUsd: 49.9, limits: [] })).toBeNull()
  expect(budgetReached({ budgetUsd: 50, planBudgetPercent: null, totalUsd: 50.2, limits: [] })).toMatch(/past your \$50.00 budget/)
  expect(budgetReached({ budgetUsd: null, planBudgetPercent: 80, totalUsd: 0, limits: [{ kind: 'five_hour', percentUsed: 81 }] })).toMatch(/past your 80% line/)
  expect(budgetReached({ budgetUsd: null, planBudgetPercent: 80, totalUsd: 0, limits: [{ kind: 'five_hour', percentUsed: 40 }] })).toBeNull()
})
