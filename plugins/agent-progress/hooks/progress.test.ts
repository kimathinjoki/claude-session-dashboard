import { expect, test } from 'claude-code/testing'

import { bar, cacheShare, elapsed, roleFor, tokens } from './register'

test('figures read short', async () => {
  expect(tokens(950)).toBe('950')
  expect(tokens(182_400)).toBe('182k')
  expect(tokens(2_300_000)).toBe('2.3M')
  expect(elapsed(42_000)).toBe('42s')
  expect(elapsed(192_000)).toBe('3m12s')
  expect(elapsed(3_900_000)).toBe('1h05m')
})

test('each kind of worker gets its own avatar', async () => {
  expect(roleFor({ description: 'Implement Task 17: payer block', type: 'general-purpose' }).name).toBe('BUILDER')
  expect(roleFor({ description: 'Re-review Task 3 fix round 1', type: 'general-purpose' }).name).toBe('INSPECTOR')
  expect(roleFor({ description: 'Map consumers of UA step 2 data', type: 'Explore' }).name).toBe('SCOUT')
  expect(roleFor({ description: 'Find 1-hour prompt cache setting', type: 'claude-code-guide' }).name).toBe('LIBRARIAN')
  expect(roleFor({ description: 'something else', type: 'general-purpose' }).name).toBe('WORKER')
})

test('the cache bar fills by the share served from cache', async () => {
  expect(bar(0.5, 10)).toBe('█████░░░░░')
  expect(cacheShare({ inputTokens: 1000, cacheReadTokens: 960 })).toBe(0.96)
  expect(cacheShare({ inputTokens: 0, cacheReadTokens: 0 })).toBe(0)
})

test('every worker is a Claude crab dressed for its job', async () => {
  expect(roleFor({ description: 'Implement Task 17', type: 'general-purpose' }).glyph).toBe('⚒▐▛█▜▌')
  expect(roleFor({ description: 'Review Task 3', type: 'general-purpose' }).glyph).toBe('◎▐▛█▜▌')
  expect(roleFor({ description: 'Map consumers', type: 'Explore' }).glyph).toBe('⌖▐▛█▜▌')
  expect(roleFor({ description: 'something else', type: 'general-purpose' }).glyph).toBe('·▐▛█▜▌')
})
