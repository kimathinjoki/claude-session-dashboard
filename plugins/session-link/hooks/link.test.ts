import { expect, test } from 'claude-code/testing'

import {
  BADGES,
  assignBadges,
  cleanLabel,
  editDeny,
  gitDirOf,
  holderOf,
  overlaps,
  parseRegistry,
  riskyGit,
  senderOf,
  sharersOf,
  timeline,
  titleOf,
  type Peer,
} from './link'

const peer = (over: Partial<Peer>): Peer => ({
  sessionId: 's1',
  name: 'prospec360-30',
  label: null,
  cwd: '/home/u/dev/app',
  branch: 'main',
  status: 'busy',
  isSelf: false,
  claims: {},
  sent: [],
  ...over,
})

test('reads a registry line and refuses a broken one', async () => {
  const row = parseRegistry('{"pid":5234,"sessionId":"1d63","cwd":"/x","name":"prospec360-30","status":"busy"}')
  expect(row?.pid).toBe(5234)
  expect(row?.name).toBe('prospec360-30')
  expect(parseRegistry('not json')).toBe(null)
  expect(parseRegistry('{"pid":1}')).toBe(null)
})

test('broad git commands are risky; committing named paths is not', async () => {
  expect(riskyGit('git add -A')).toBe(true)
  expect(riskyGit('cd api && git commit -qam "x"')).toBe(true)
  expect(riskyGit('git commit --all -m x')).toBe(true)
  expect(riskyGit('git reset --hard HEAD~1')).toBe(true)
  expect(riskyGit('git checkout main')).toBe(true)
  expect(riskyGit('git stash')).toBe(true)
  expect(riskyGit('git stash list')).toBe(false)
  expect(riskyGit('git commit -q -m "docs" -- docs/a.md')).toBe(false)
  expect(riskyGit('git add docs/a.md && git commit -m x -- docs/a.md')).toBe(false)
  expect(riskyGit('git status --short')).toBe(false)
  expect(riskyGit('git log --oneline -5')).toBe(false)
})

test('a git command acts on -C, else the last cd, else the session directory', async () => {
  expect(gitDirOf('git -C /repo/api status', '/repo')).toBe('/repo/api')
  expect(gitDirOf('cd prospec360-api && git add -A', '/repo')).toBe('/repo/prospec360-api')
  expect(gitDirOf('git add -A', '/repo')).toBe('/repo')
})

test('an edit is held when another live session edited the same file', async () => {
  const now = 1_000_000_000
  const other = peer({ sessionId: 's2', name: 'prospec360-31', label: 'C: UA 2', claims: { '/a/b.rb': { at: now - 60_000, tool: 'Edit' } } })
  const self = peer({ isSelf: true, claims: { '/a/b.rb': { at: now, tool: 'Edit' } } })
  const hit = holderOf('/a/b.rb', [self, other], now)
  expect(hit?.peer.name).toBe('prospec360-31')
  expect(holderOf('/a/c.rb', [self, other], now)).toBe(null)
  expect(editDeny('/a/b.rb', hit!, now, '/home/u')).toContain('C: UA 2 (prospec360-31)')
  expect(editDeny('/a/b.rb', hit!, now, '/home/u')).toContain('SendMessage (to: "prospec360-31")')
  // Old claims lapse.
  const stale = peer({ sessionId: 's3', claims: { '/a/b.rb': { at: now - 7 * 3_600_000, tool: 'Edit' } } })
  expect(holderOf('/a/b.rb', [stale], now)).toBe(null)
})

test('sessions share a repository by directory or by files they edited', async () => {
  const now = 2_000_000_000
  const repoOf = (cwd: string) => (cwd.startsWith('/repo') ? '/repo' : null)
  const byDir = peer({ sessionId: 's2', cwd: '/repo' })
  const byFile = peer({ sessionId: 's3', cwd: '/elsewhere', claims: { '/repo/x.md': { at: now, tool: 'Write' } } })
  const unrelated = peer({ sessionId: 's4', cwd: '/elsewhere' })
  const names = sharersOf('/repo', [peer({ isSelf: true, cwd: '/repo' }), byDir, byFile, unrelated], now, repoOf).map(p => p.sessionId)
  expect(names).toEqual(['s2', 's3'])
})

test('messages are listed once each, oldest first, and overlaps are found', async () => {
  const now = 3_000_000_000
  const a = peer({ sessionId: 'a', name: 'A', sent: [{ at: now - 20, peer: 'B', text: 'hi' }], claims: { '/f': { at: now, tool: 'Edit' } } })
  const b = peer({ sessionId: 'b', name: 'B', sent: [{ at: now - 10, peer: 'A', text: 'ok' }], claims: { '/f': { at: now, tool: 'Edit' } } })
  expect(timeline([a, b], now).map(m => `${m.from}>${m.to}`)).toEqual(['A>B', 'B>A'])
  expect(overlaps([a, b], now)).toEqual([{ path: '/f', names: ['A', 'B'] }])
  expect(senderOf('<cross-session-message from="prospec360-31">x</cross-session-message>')).toBe('prospec360-31')
})

test('every live session gets its own badge, and keeps it', async () => {
  const ids = ['1d635c8f', '9e21aa00', '44bb11cc', 'f00dbeef']
  const first = assignBadges(ids)
  const glyphs = new Set([...first.values()].map(b => b.glyph))
  expect(glyphs.size).toBe(ids.length)
  expect(assignBadges([...ids].reverse()).get('1d635c8f')).toEqual(first.get('1d635c8f'))
  expect(assignBadges(Array.from({ length: BADGES.length }, (_, i) => `id-${i}`)).size).toBe(BADGES.length)
})

test('a label is shown with the name to message', async () => {
  expect(titleOf({ name: 'prospec360-31', label: 'C: UA 2' })).toBe('C: UA 2 (prospec360-31)')
  expect(titleOf({ name: 'prospec360-31', label: null })).toBe('prospec360-31')
  expect(cleanLabel('  A: finish\nUA 1 ')).toBe('A: finish UA 1')
  expect(cleanLabel('   ')).toBe(null)
})
