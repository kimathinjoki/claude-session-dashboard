// Pure helpers for Session Link: no `$`, so the tests can run them directly.

export type Claim = { at: number; tool: string }
export type Note = { at: number; peer: string; text: string }

// What each session writes about itself, one file per session so no two ever write the same file.
export type Beacon = {
  sessionId: string
  name: string
  label: string | null
  cwd: string
  branch: string | null
  updatedAt: number
  claims: Record<string, Claim>
  sent: Note[]
  received: Note[]
}

// One live session as the pane shows it: the registry's facts plus the session's own beacon.
export type Peer = {
  sessionId: string
  name: string
  label: string | null
  cwd: string
  branch: string | null
  status: string
  isSelf: boolean
  claims: Record<string, Claim>
  sent: Note[]
}

export const CLAIM_TTL_MS = 6 * 60 * 60_000
export const ACK_WINDOW_MS = 10 * 60_000
export const NOTE_LIMIT = 30

export const shortPath = (path: string, home: string) => (home && path.startsWith(home) ? `~${path.slice(home.length)}` : path)

export const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

// The registry line `~/.claude/sessions/<pid>.json` writes for every Claude Code session.
export const parseRegistry = (text: string) => {
  try {
    const row = JSON.parse(text)
    if (!row?.sessionId || !row?.pid) return null
    return {
      pid: Number(row.pid),
      sessionId: String(row.sessionId),
      name: String(row.name ?? row.sessionId.slice(0, 8)),
      cwd: String(row.cwd ?? ''),
      status: String(row.status ?? 'unknown'),
    }
  } catch {
    return null
  }
}

export const freshClaims = (claims: Record<string, Claim>, now: number) =>
  Object.fromEntries(Object.entries(claims ?? {}).filter(([, claim]) => now - claim.at <= CLAIM_TTL_MS))

// Another live session that has edited this exact file recently, newest first.
export const holderOf = (path: string, peers: Peer[], now: number) =>
  peers
    .filter(peer => !peer.isSelf)
    .map(peer => ({ peer, claim: freshClaims(peer.claims, now)[path] }))
    .filter((hit): hit is { peer: Peer; claim: Claim } => Boolean(hit.claim))
    .sort((a, b) => b.claim.at - a.claim.at)[0] ?? null

// Git commands that can sweep up, discard or move another session's uncommitted work when two
// sessions share one working tree. Committing named paths (`git commit -- a b`) is not on it.
const RISKY: RegExp[] = [
  /\bgit\b[^|;&\n]*\badd\s+(-A|--all|-u|--update|\.)(\s|$)/,
  /\bgit\b[^|;&\n]*\bcommit\b[^|;&\n]*\s-(?!-)[a-zA-Z]*a[a-zA-Z]*(\s|$)/,
  /\bgit\b[^|;&\n]*\bcommit\b[^|;&\n]*\s--all\b/,
  /\bgit\b[^|;&\n]*\breset\b[^|;&\n]*--hard\b/,
  /\bgit\b[^|;&\n]*\b(checkout|switch|restore)\b/,
  /\bgit\b[^|;&\n]*\bclean\s+-[a-zA-Z]*f/,
  /\bgit\b[^|;&\n]*\bstash\b(?!\s+(list|show))/,
  /\bgit\b[^|;&\n]*\b(rebase|merge|pull|cherry-pick|revert)\b/,
]

export const riskyGit = (command: string) => RISKY.some(rule => rule.test(command))

// The directory a git command acts on: `git -C dir`, else the last `cd dir` before it, else the
// session's own directory.
export const gitDirOf = (command: string, cwd: string) => {
  const flag = command.match(/\bgit\s+-C\s+("([^"]+)"|'([^']+)'|(\S+))/)
  const cds = [...command.matchAll(/\bcd\s+("([^"]+)"|'([^']+)'|([^\s;&|]+))/g)]
  const pick = (m: RegExpMatchArray | undefined | null) => (m ? m[2] ?? m[3] ?? m[4] ?? null : null)
  const dir = pick(flag) ?? pick(cds.at(-1)) ?? cwd
  return dir.startsWith('/') ? dir : `${cwd.replace(/\/$/, '')}/${dir}`
}

export const within = (path: string, root: string) => path === root || path.startsWith(`${root.replace(/\/$/, '')}/`)

// The live sessions also working in this git repository: their directory is in it, or they have
// edited a file in it recently.
export const sharersOf = (repo: string, peers: Peer[], now: number, repoOfCwd: (cwd: string) => string | null) =>
  peers.filter(peer => {
    if (peer.isSelf) return false
    if (repoOfCwd(peer.cwd) === repo) return true
    return Object.keys(freshClaims(peer.claims, now)).some(path => within(path, repo))
  })

export const editDeny = (path: string, holder: { peer: Peer; claim: Claim }, now: number, home: string) =>
  `Session Link: ${titleOf(holder.peer)}, another Claude session on this machine (${shortPath(holder.peer.cwd, home)}` +
  `${holder.peer.branch ? `, branch ${holder.peer.branch}` : ''}), edited ${shortPath(path, home)} ${ago(now - holder.claim.at)} ago. ` +
  `To avoid overwriting its work, message it first with SendMessage (to: "${holder.peer.name}") and agree who edits this file, ` +
  'or ask the user. If you have agreed, or the user told you to go ahead, make the same edit again and it will be allowed.'

export const gitDeny = (command: string, repo: string, sharers: Peer[], home: string) =>
  `Session Link: ${sharers.map(peer => `${titleOf(peer)}${peer.branch ? ` (branch ${peer.branch})` : ''}`).join(', ')} ` +
  `${sharers.length > 1 ? 'are' : 'is'} also working in the git repository ${shortPath(repo, home)}. ` +
  `\`${command.trim().slice(0, 80)}\` can sweep up, discard or move that session's uncommitted work. ` +
  'Stage only your own files and commit them with `git commit -- <paths>`, and do not switch branches in a shared working tree. ' +
  `Message ${sharers[0]!.name} with SendMessage first if you need to. If the user told you to run this exact command, run it again and it will be allowed.`

// A received message's sender, from the envelope the engine wraps it in.
export const senderOf = (text: string) => text.match(/from="([^"]+)"/)?.[1] ?? 'another session'

export const keepNotes = (notes: Note[], note: Note) => [...notes, note].slice(-NOTE_LIMIT)

// Every message between the live sessions, oldest first: each session reports only what it sent,
// so nothing is counted twice.
export const timeline = (peers: Peer[], now: number, windowMs = 6 * 60 * 60_000) =>
  peers
    .flatMap(peer => peer.sent.map(note => ({ from: peer.name, to: note.peer, text: note.text, at: note.at })))
    .filter(row => now - row.at <= windowMs)
    .sort((a, b) => a.at - b.at)

// Files two or more live sessions have both edited recently: where an overwrite is likeliest.
export const overlaps = (peers: Peer[], now: number) => {
  const byPath = new Map<string, string[]>()
  for (const peer of peers) {
    for (const path of Object.keys(freshClaims(peer.claims, now))) byPath.set(path, [...(byPath.get(path) ?? []), peer.name])
  }
  return [...byPath.entries()].filter(([, names]) => names.length > 1).map(([path, names]) => ({ path, names }))
}

// A badge per session: a crab and a hue, picked from its id so a session keeps its badge, and
// never shared by two live sessions (a clash moves the later one to the next free badge).
// Little Claude crabs (Clawd, as the Claude Code banner draws him), each pose with its own colour.
export const BADGES = [
  { glyph: '▐▛█▜▌', hue: '#f97316' },
  { glyph: '▐▙█▟▌', hue: '#22d3ee' },
  { glyph: '▝▜█▛▘', hue: '#f472b6' },
  { glyph: '▗▟█▙▖', hue: '#a78bfa' },
  { glyph: '▐▀█▀▌', hue: '#34d399' },
  { glyph: '▐▄█▄▌', hue: '#38bdf8' },
  { glyph: '▛▜█▛▜', hue: '#e879f9' },
  { glyph: '▙▟█▙▟', hue: '#f87171' },
  { glyph: '▝▛█▜▘', hue: '#4ade80' },
  { glyph: '▗▙█▟▖', hue: '#fb7185' },
  { glyph: '▐▛▀▜▌', hue: '#818cf8' },
  { glyph: '▐▙▄▟▌', hue: '#2dd4bf' },
] as const

const hash = (text: string) => [...text].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7)

export const assignBadges = (ids: string[]) => {
  const taken = new Set<number>()
  const out = new Map<string, (typeof BADGES)[number]>()
  for (const id of [...ids].sort()) {
    let at = hash(id) % BADGES.length
    for (let tries = 0; taken.has(at) && tries < BADGES.length; tries++) at = (at + 1) % BADGES.length
    taken.add(at)
    out.set(id, BADGES[at]!)
  }
  return out
}

// What a session is called on screen and in a refusal: its label, with the name to message.
export const titleOf = (peer: { name: string; label: string | null }) => (peer.label ? `${peer.label} (${peer.name})` : peer.name)

export const cleanLabel = (text: string) => text.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 40) || null
