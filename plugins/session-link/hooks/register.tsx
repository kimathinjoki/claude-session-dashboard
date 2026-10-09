import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LinkView } from '../types'
import {
  ACK_WINDOW_MS,
  type Beacon,
  type Peer,
  ago,
  assignBadges,
  cleanLabel,
  editDeny,
  freshClaims,
  gitDeny,
  gitDirOf,
  holderOf,
  keepNotes,
  overlaps,
  parseRegistry,
  riskyGit,
  senderOf,
  sharersOf,
  shortPath,
  timeline,
} from './link'

const view = atom({ plugin: 'session-link', key: 'view' } as const, null as LinkView | null)

const PANE = 'session-link'
const REFRESH_MS = 15_000
const PROTOCOL = {
  id: 'session-link:protocol',
  scope: 'session' as const,
  text:
    'Other Claude Code sessions may be working on this machine, in the same repositories. Session Link refuses an edit to a file ' +
    'another live session edited recently, and a broad git command (add -A, commit -a, reset --hard, checkout, switch, stash, ' +
    'rebase, merge, pull) in a repository another session is working in, and its refusal names the session. When that happens, ' +
    'message that session with SendMessage before going on, commit only your own files with `git commit -- <paths>`, and never ' +
    'switch branches in a shared working tree. Repeating the same call after agreeing, or on the user\'s say-so, is allowed. ' +
    'Early in your first turn, and again if your task changes, call the set_session_label tool (Session Link) with a short label ' +
    'naming what this session is doing, under 40 characters, with the letter or name the user gave the session if any ' +
    '(for example "A: finish UA sub-project 1"), so the other sessions and the user can tell the sessions apart.',
}

// Module state: rebuilt on reload from this session's own beacon file.
let home = ''
let me: Beacon | null = null
let peers: Array<Peer & { repo: string | null }> = []
let refreshedAt = 0
const repoCache = new Map<string, string | null>()
const acks = new Map<string, number>()

const linkDir = () => `${home}/.claude/session-link`
const beaconPath = (id: string) => `${linkDir()}/${id}.json`

async function repoOf($: EngineInterface, dir: string) {
  if (repoCache.has(dir)) return repoCache.get(dir)!
  const out = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 }).catch(() => null)
  const repo = out && out.exitCode === 0 ? out.stdout.trim() : null
  repoCache.set(dir, repo)
  return repo
}

async function branchOf($: EngineInterface, dir: string) {
  const out = await $.process.run(['git', '-C', dir, 'branch', '--show-current'], { timeoutMs: 5000 }).catch(() => null)
  return out && out.exitCode === 0 ? out.stdout.trim() || null : null
}

async function saveBeacon($: EngineInterface) {
  if (!me) return
  me.updatedAt = await $.clock.now()
  me.claims = freshClaims(me.claims, me.updatedAt)
  await $.fs.write(beaconPath(me.sessionId), JSON.stringify(me)).catch(() => undefined)
}

async function readJson($: EngineInterface, path: string) {
  try {
    return JSON.parse(String(await $.fs.read(path)))
  } catch {
    return null
  }
}

// Reads the registry, keeps the sessions whose process is alive, and joins each to its beacon.
async function refresh($: EngineInterface) {
  const now = await $.clock.now()
  const registryDir = `${home}/.claude/sessions`
  const entries = await $.fs.list(registryDir).catch(() => [])
  const rows = (
    await Promise.all(
      entries
        .filter(entry => entry.name.endsWith('.json'))
        .map(async entry => parseRegistry(String(await $.fs.read(`${registryDir}/${entry.name}`).catch(() => ''))))
    )
  ).filter((row): row is NonNullable<ReturnType<typeof parseRegistry>> => row !== null)

  const alive = new Set<number>()
  if (rows.length > 0) {
    const out = await $.process
      .run(['sh', '-c', 'for p in "$@"; do kill -0 "$p" 2>/dev/null && echo "$p"; done', 'sh', ...rows.map(row => String(row.pid))], { timeoutMs: 5000 })
      .catch(() => null)
    for (const line of out?.stdout.split('\n') ?? []) if (line.trim()) alive.add(Number(line.trim()))
  }

  const live = rows.filter(row => alive.has(row.pid))
  const myId = await $.session.id()
  const self = live.find(row => row.sessionId === myId)
  if (me && self) me.name = self.name
  if (me) me.branch = await branchOf($, me.cwd)
  await saveBeacon($)

  peers = await Promise.all(
    live.map(async row => {
      const beacon: Beacon | null = row.sessionId === myId ? me : await readJson($, beaconPath(row.sessionId))
      return {
        sessionId: row.sessionId,
        name: row.name,
        label: beacon?.label ?? null,
        cwd: row.cwd,
        branch: beacon?.branch ?? null,
        status: row.status,
        isSelf: row.sessionId === myId,
        claims: freshClaims(beacon?.claims ?? {}, now),
        sent: beacon?.sent ?? [],
        repo: await repoOf($, row.cwd),
      }
    })
  )
  refreshedAt = now
  const badges = assignBadges(peers.map(peer => peer.sessionId))
  const badgeOfName = new Map(peers.map(peer => [peer.name, badges.get(peer.sessionId)!]))
  const labelOfName = new Map(peers.map(peer => [peer.name, peer.label]))

  const next: LinkView = {
    updatedAt: now,
    sessions: peers
      .map(peer => ({
        name: peer.name,
        label: peer.label,
        glyph: badges.get(peer.sessionId)!.glyph,
        hue: badges.get(peer.sessionId)!.hue,
        status: peer.status,
        isSelf: peer.isSelf,
        cwd: shortPath(peer.cwd, home),
        branch: peer.branch,
        files: Object.keys(peer.claims).length,
        recent: Object.entries(peer.claims)
          .sort((a, b) => b[1].at - a[1].at)
          .slice(0, 3)
          .map(([path]) => shortPath(path, home)),
      }))
      .sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.name.localeCompare(b.name)),
    overlaps: overlaps(peers, now).map(hit => ({ path: shortPath(hit.path, home), names: hit.names })),
    messages: timeline(peers, now)
      .slice(-12)
      .map(m => ({
        ...m,
        fromLabel: labelOfName.get(m.from) ?? null,
        toLabel: labelOfName.get(m.to) ?? null,
        fromGlyph: badgeOfName.get(m.from)?.glyph ?? '▐▛█▜▌',
        fromHue: badgeOfName.get(m.from)?.hue ?? '#94a3b8',
        toGlyph: badgeOfName.get(m.to)?.glyph ?? '▐▛█▜▌',
        toHue: badgeOfName.get(m.to)?.hue ?? '#94a3b8',
      })),
  }
  await update($, view, () => next)
}

async function freshPeers($: EngineInterface) {
  if ((await $.clock.now()) - refreshedAt > REFRESH_MS) await refresh($)
  return peers
}

// The first refusal stands; the same call again inside the window is the model saying it agreed.
function acknowledged(key: string, now: number) {
  const first = acks.get(key)
  if (first !== undefined && now - first <= ACK_WINDOW_MS) {
    acks.delete(key)
    return true
  }
  acks.set(key, now)
  return false
}

async function onEdit($: EngineInterface, e: any, next: (e: any) => Promise<any>) {
  const raw = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
  if (!me || typeof raw !== 'string' || !raw) return next(e)
  const path = raw.startsWith('/') ? raw : `${me.cwd.replace(/\/$/, '')}/${raw}`
  const now = await $.clock.now()
  const holder = holderOf(path, await freshPeers($), now)
  if (holder && !acknowledged(`edit:${path}`, now)) {
    void $.ui.toast(`Session Link: ${holder.peer.name} edited this file ${ago(now - holder.claim.at)} ago`)
    return { deny: editDeny(path, holder, now, home) }
  }
  const result = await next(e)
  if (!result?.deny && !result?.isError) {
    me.claims[path] = { at: await $.clock.now(), tool: e.tool }
    await saveBeacon($)
    void refresh($)
  }
  return result
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    home = (await $.env.get('HOME')) ?? ''
    const id = await $.session.id()
    const cwd = await $.session.cwd()
    const saved: Beacon | null = await readJson($, beaconPath(id))
    me = {
      sessionId: id,
      name: saved?.name ?? id.slice(0, 8),
      label: saved?.label ?? null,
      cwd,
      branch: null,
      updatedAt: 0,
      claims: saved?.claims ?? {},
      sent: saved?.sent ?? [],
      received: saved?.received ?? [],
    }
    await $.command.register({ name: 'link', description: 'Open Session Link: live sessions, their messages and overlaps. /link name <label> labels this session; /link release clears your file claims' })
    await $.tool.register({
      name: 'set_session_label',
      description:
        'Labels this Claude session in Session Link, the panel that shows every live session on this machine. Call it early in your ' +
        'first turn with a short label for what this session is doing (under 40 characters), and again if the task changes.',
      inputSchema: {
        type: 'object',
        properties: { label: { type: 'string', description: 'Short label, for example "A: finish UA sub-project 1"' } },
        required: ['label'],
      },
      isDeferred: false,
    })
    await refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    void $.ui.open({ id: PANE, title: 'Link' })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__session-link__set_session_label' }, async ($, e) => {
    const label = cleanLabel(String((e as any).label ?? ''))
    if (!me) return { result: 'Session Link is still starting; try again in a moment.' }
    if (!label) return { result: 'Give a label of a few words, for example "A: finish UA sub-project 1".' }
    me.label = label
    await saveBeacon($)
    await refresh($)
    return { result: `This session is now labelled "${label}" in Session Link.` }
  })

  // Until the model labels itself, the first thing the user asked stands in, so no session is nameless.
  on('prompt.submit', async ($, e, next) => {
    if (me && !me.label && (!(e as any).origin || (e as any).origin.kind === 'composer')) {
      const words = String((e as any).text ?? '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ')
      const label = cleanLabel(words)
      if (label && !label.startsWith('/')) {
        me.label = label
        void saveBeacon($).then(() => refresh($))
      }
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    return { sections: [...out.sections.filter(section => section.id !== PROTOCOL.id), PROTOCOL] }
  })

  on('tool.call', { tool: 'Edit' }, onEdit)
  on('tool.call', { tool: 'Write' }, onEdit)
  on('tool.call', { tool: 'NotebookEdit' }, onEdit)

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String((e as any).command ?? '')
    if (!me || !riskyGit(command)) return next(e)
    const repo = await repoOf($, gitDirOf(command, me.cwd))
    if (!repo) return next(e)
    const now = await $.clock.now()
    const list = await freshPeers($)
    const sharers = sharersOf(repo, list, now, cwd => list.find(peer => peer.cwd === cwd)?.repo ?? null)
    if (sharers.length > 0 && !acknowledged(`git:${repo}:${command}`, now)) {
      void $.ui.toast(`Session Link: ${sharers[0]!.name} shares this repository`)
      return { deny: gitDeny(command, repo, sharers, home) }
    }
    return next(e)
  })

  // Record what this session sends to another session (not to its own sub-agents).
  on('session.send', async ($, e, next) => {
    const result = await next(e)
    const target = peers.find(peer => !peer.isSelf && (peer.name === e.to || peer.sessionId === e.to))
    if (me && result.isDelivered && target) {
      me.sent = keepNotes(me.sent, { at: await $.clock.now(), peer: target.name, text: e.text.slice(0, 160) })
      await saveBeacon($)
      void refresh($)
    }
    return result
  })

  on('session.receive', async ($, e, next) => {
    const from = senderOf(e.text)
    if (me && peers.some(peer => !peer.isSelf && peer.name === from)) {
      const body = e.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      me.received = keepNotes(me.received, { at: await $.clock.now(), peer: from, text: body.slice(0, 160) })
      void saveBeacon($)
    }
    return next(e)
  })

  on('command.run', { command: 'link' }, async ($, e) => {
    const args = String(e.args ?? '').trim()
    const named = args.match(/^name\s+(.+)$/i)
    if (named || /^name$/i.test(args)) {
      if (me) me.label = named ? cleanLabel(named[1]!) : null
      await saveBeacon($)
      await refresh($)
      return { text: me?.label ? `Session Link: this session is now labelled "${me.label}".` : 'Session Link: label cleared.' }
    }
    if (args === 'release') {
      if (me) me.claims = {}
      await saveBeacon($)
      await refresh($)
      return { text: 'Session Link: your file claims are cleared; other sessions can edit those files without a warning.' }
    }
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Link', focus: true })
    return { text: 'Session Link open.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(26, (e.props.bodyColumns ?? 44) - 2)
    const data = await read($, view)
    const now = await $.clock.now()
    const sessions = data?.sessions ?? []
    const others = sessions.filter(s => !s.isSelf)
    const Rule = ({ title, hue, right }: { title: string; hue: string; right?: string }) => (
      <Box flexDirection="column" marginTop={1}>
        <Box justifyContent="space-between">
          <Text bold color={hue}>{title}</Text>
          {right ? <Text dimColor>{right}</Text> : null}
        </Box>
        <Text color={hue} dimColor>{'━'.repeat(width)}</Text>
      </Box>
    )
    const hueOf = (status: string) => (status === 'busy' ? '#4ade80' : status === 'idle' ? '#94a3b8' : '#f97316')

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text bold color="#e2e8f0">⇄ SESSION LINK</Text>
          <Text>
            <Text color="#22d3ee" bold>{sessions.length}</Text>
            <Text dimColor> live  </Text>
            <Text color={(data?.overlaps.length ?? 0) > 0 ? '#f97316' : '#22c55e'} bold>{data?.overlaps.length ?? 0}</Text>
            <Text dimColor> overlap</Text>
          </Text>
        </Box>

        <Rule title="◎ SESSIONS" hue="#22d3ee" right={data ? `checked ${ago(now - data.updatedAt)} ago` : 'checking'} />
        {sessions.length === 0 && <Text dimColor>Looking for sessions on this machine.</Text>}
        {sessions.map(s => (
          <Box key={s.name} flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={s.hue} bold>{s.glyph} </Text>
              <Text bold color={s.hue}>{s.label ?? s.name}</Text>
              {s.label ? <Text dimColor> {s.name}</Text> : null}
              <Text dimColor>{s.isSelf ? ' (this one)' : ''} </Text>
              <Text color={hueOf(s.status)}>● {s.status}</Text>
            </Text>
            <Text wrap="truncate-end" dimColor>
              {'  '}{s.cwd}{s.branch ? `  ⎇ ${s.branch}` : ''}{s.files ? `  ${s.files} file${s.files === 1 ? '' : 's'}` : ''}
            </Text>
            {s.recent.map(path => (
              <Text key={path} wrap="truncate-start" color="#a78bfa">{'  ✎ '}{path}</Text>
            ))}
          </Box>
        ))}
        {others.length === 0 && sessions.length > 0 && <Text dimColor>No other session is running. Nothing to coordinate.</Text>}
        {sessions.some(s => s.isSelf && !s.label) && <Text dimColor>This session labels itself on its first prompt; /link name changes it.</Text>}

        <Rule title="⚠ OVERLAPS" hue="#f97316" right="files two sessions both edited" />
        {(data?.overlaps ?? []).length === 0 && <Text color="#22c55e">✓ No file edited by two sessions.</Text>}
        {(data?.overlaps ?? []).map(hit => (
          <Text key={hit.path} wrap="truncate-start">
            <Text color="#f97316">⚠ </Text>
            <Text>{hit.path}</Text>
            <Text dimColor>  {hit.names.join(' + ')}</Text>
          </Text>
        ))}

        <Rule title="✉ MESSAGES" hue="#f472b6" right="between sessions" />
        {(data?.messages ?? []).length === 0 && <Text dimColor>No messages between sessions yet.</Text>}
        {(data?.messages ?? []).map(m => (
          <Box key={`${m.from}-${m.at}`} flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={m.fromHue} bold>{m.fromGlyph} {m.fromLabel ?? m.from}</Text>
              <Text dimColor> → </Text>
              <Text color={m.toHue} bold>{m.toGlyph} {m.toLabel ?? m.to}</Text>
              <Text dimColor>  {ago(now - m.at)} ago</Text>
            </Text>
            <Text wrap="truncate-end">{'  '}{m.text}</Text>
          </Box>
        ))}

        <Rule title="▸ CONTROLS" hue="#e2e8f0" />
        <Box gap={1} flexWrap="wrap">
          <Button key="refresh" hotkey="r" label="Refresh" onPress={() => void refresh($)} />
          <Button key="release" hotkey="x" label="Release my files" onPress={() => void $.command.run({ command: 'link', args: 'release' })} />
          <Button key="mission" hotkey="m" label="Mission" onPress={() => void $.command.run({ command: 'mission' })} />
        </Box>
      </Box>
    )
  })
}
