import { expect, test } from 'claude-code/testing'

import { bar, roleOf, usd } from './register'

test('the stacked panel shares the crew avatars and figures', async () => {
  expect(roleOf('Implement Task 6', 'general-purpose').glyph).toBe('⚒')
  expect(roleOf('Re-review Task 16 fix round 1', 'general-purpose').glyph).toBe('◉')
  expect(bar(0.25, 8)).toBe('██░░░░░░')
  expect(usd(3.456)).toBe('$3.46')
})
