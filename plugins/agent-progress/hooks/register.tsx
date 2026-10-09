import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentRow } from '../types'

const agents = atom({ plugin: 'agent-progress', key: 'agents' } as const, [])
const sessionUsd = atom({ plugin: 'agent-progress', key: 'sessionUsd' } as const, null)
const tick = atom({ plugin: 'agent-progress', key: 'tick' } as const, 0)

const PANE = 'crew'
// A finished worker stays on the panel this long, so its last figures can be read.
const LINGER_MS = 5 * 60_000
// A running worker that has made no model request for this long is flagged.
const QUIET_MS = 3 * 60_000
const ACTIVE = ['pending', 'running', 'waiting']
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// The crew: who a worker is, read from what it was asked to do. Every worker is a little Claude
// crab, dressed for the job: a hard hat and hammer, a monocle, a compass, a set square, a book.
export const CRAB = '▐▛█▜▌'
export type Role = { name: string; glyph: string; hue: string }
const ROLES: Array<{ test: RegExp; role: Role }> = [
  { test: /re-?review|review|verify|audit|check/i, role: { name: 'INSPECTOR', glyph: '◎' + CRAB, hue: '#22d3ee' } },
  { test: /implement|build|fix|write|add|create/i, role: { name: 'BUILDER', glyph: '⚒' + CRAB, hue: '#fb923c' } },
  { test: /explore|map|find|search|survey|locate|sweep/i, role: { name: 'SCOUT', glyph: '⌖' + CRAB, hue: '#4ade80' } },
  { test: /plan|design|architect|spec/i, role: { name: 'ARCHITECT', glyph: '△' + CRAB, hue: '#a78bfa' } },
  { test: /guide|docs|setting|how do|research/i, role: { name: 'LIBRARIAN', glyph: '≡' + CRAB, hue: '#f472b6' } },
]
const WORKER: Role = { name: 'WORKER', glyph: '·' + CRAB, hue: '#93c5fd' }

export const roleFor = (row: Pick<AgentRow, 'description' | 'type'>): Role => {
  if (/explore/i.test(row.type)) return ROLES[2]!.role
  if (/plan/i.test(row.type)) return ROLES[3]!.role
  if (/guide/i.test(row.type)) return ROLES[4]!.role
  return ROLES.find(entry => entry.test.test(row.description))?.role ?? WORKER
}

const MODEL_HUES: Array<[RegExp, string]> = [
  [/opus/i, '#c084fc'],
  [/sonnet/i, '#60a5fa'],
  [/haiku/i, '#34d399'],
  [/fable/i, '#f9a8d4'],
]
const modelHue = (model: string) => MODEL_HUES.find(([test]) => test.test(model))?.[1] ?? '#cbd5e1'

export const tokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

export const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

// A bar of `width` cells, filled to `share` (0 to 1).
export const bar = (share: number, width: number) => {
  const cells = Math.max(0, Math.min(width, Math.round(share * width)))
  return '█'.repeat(cells) + '░'.repeat(width - cells)
}

export const cacheShare = (row: Pick<AgentRow, 'inputTokens' | 'cacheReadTokens'>) =>
  row.inputTokens > 0 ? row.cacheReadTokens / row.inputTokens : 0

const shortModel = (model: string) => model.replace(/^claude-/, '').replace(/-\d{8}$/, '')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'crew', description: 'Open the Crew panel: every sub-agent at work' })
    void $.ui.open({ id: PANE, title: 'Crew' })

    // The engine's own list says where each worker stands; a spawn hook only sees the start.
    $.clock.every(2000, async () => {
      const listed = await $.agent.list()
      const now = await $.clock.now()
      await update($, agents, rows =>
        rows
          .map(row => {
            const info = listed.find(one => one.id === row.id)
            if (!info) return row
            const isDone = !ACTIVE.includes(info.status) && info.status !== 'idle'
            return { ...row, status: info.status, endedAt: isDone ? (row.endedAt ?? now) : null }
          })
          .filter(row => row.endedAt === null || now - row.endedAt < LINGER_MS),
      )
      const usage = await $.session.usage()
      await update($, sessionUsd, () => usage.cost?.usd ?? null)
    })
    // The spinner and the clocks.
    $.clock.every(1000, () => void update($, tick, n => n + 1))

    return next(e)
  })

  on('command.run', { command: 'crew' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Crew', focus: true })
    return { text: 'Crew panel open.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny || !started.agentId) return started

    const row: AgentRow = {
      id: started.agentId,
      description: e.description || e.subagentType,
      type: e.subagentType,
      model: started.model,
      status: 'running',
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      startedAt: await $.clock.now(),
      lastStepAt: null,
      endedAt: null,
    }
    await update($, agents, rows => [...rows.filter(one => one.id !== row.id), row])

    return started
  }).catch(($, e, next) => next(e))

  // Every model request a sub-agent makes: count it and add what it cost.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    if (!agentId || !result.usage) return result

    const usage = result.usage
    const now = await $.clock.now()
    await update($, agents, rows =>
      rows.map(row =>
        row.id === agentId
          ? {
              ...row,
              model: usage.model || row.model,
              steps: row.steps + 1,
              lastStepAt: now,
              inputTokens: row.inputTokens + usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
              cacheReadTokens: row.cacheReadTokens + usage.cache_read_input_tokens,
              outputTokens: row.outputTokens + usage.output_tokens,
            }
          : row,
      ),
    )

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const rows = await read($, agents)
    const frame = await read($, tick)
    const usd = await read($, sessionUsd)
    const now = await $.clock.now()
    const width = Math.max(24, (e.props.bodyColumns ?? 40) - 2)
    const barWidth = Math.max(8, Math.min(24, width - 22))

    const running = rows.filter(row => row.endedAt === null)
    const done = rows.filter(row => row.endedAt !== null)
    const ordered = [...running, ...done]
    const totalIn = rows.reduce((sum, row) => sum + row.inputTokens, 0)
    const totalOut = rows.reduce((sum, row) => sum + row.outputTokens, 0)
    const totalCached = rows.reduce((sum, row) => sum + row.cacheReadTokens, 0)

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text bold color="#fb923c">⚑ CREW</Text>
          <Text>
            <Text color="#4ade80" bold>{running.length}</Text>
            <Text dimColor> at work  </Text>
            <Text color="#93c5fd">{done.length}</Text>
            <Text dimColor> done</Text>
          </Text>
        </Box>
        <Text dimColor>{'─'.repeat(width)}</Text>

        {rows.length === 0 && (
          <Box flexDirection="column" paddingY={1}>
            <Text dimColor>The yard is quiet.</Text>
            <Text dimColor>Workers appear here when a sub-agent starts.</Text>
          </Box>
        )}

        {ordered.map(row => {
          const role = roleFor(row)
          const isDone = row.endedAt !== null
          const failed = row.status === 'failed' || row.status === 'killed'
          const quiet = !isDone && now - (row.lastStepAt ?? row.startedAt) > QUIET_MS
          const share = cacheShare(row)
          const spent = (row.endedAt ?? now) - row.startedAt
          const mark = failed ? '✗' : isDone ? '✓' : SPIN[frame % SPIN.length]
          const markHue = failed ? '#ef4444' : isDone ? '#22c55e' : role.hue

          return (
            <Box key={row.id} flexDirection="column" marginTop={1}>
              <Text wrap="truncate-end">
                <Text color={isDone ? '#64748b' : role.hue} bold>{role.glyph} </Text>
                <Text color={role.hue} bold={!isDone} dimColor={isDone}>{role.name} </Text>
                <Text bold={!isDone} dimColor={isDone}>{row.description}</Text>
              </Text>
              <Text>
                <Text color={markHue}>  {mark} </Text>
                <Text color={modelHue(row.model)}>{shortModel(row.model)}</Text>
                <Text dimColor>  ·  {failed ? row.status : isDone ? 'finished' : row.status}  ·  {elapsed(spent)}  ·  {row.steps} steps</Text>
              </Text>
              <Text>
                <Text dimColor>  cache </Text>
                <Text color={share >= 0.8 ? '#22c55e' : share >= 0.5 ? '#f97316' : '#ef4444'}>{bar(share, barWidth)}</Text>
                <Text dimColor> {Math.round(share * 100)}%</Text>
              </Text>
              <Text dimColor>  in {tokens(row.inputTokens)}  ·  out {tokens(row.outputTokens)}</Text>
              {quiet && <Text color="#f97316">  ⚠ no model request for {elapsed(now - (row.lastStepAt ?? row.startedAt))}</Text>}
              {failed && <Text color="#ef4444">  ✗ this worker {row.status === 'killed' ? 'was stopped' : 'failed'}</Text>}
            </Box>
          )
        })}

        {rows.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{'─'.repeat(width)}</Text>
            <Text>
              <Text dimColor>crew total  </Text>
              <Text>{tokens(totalIn)}</Text>
              <Text dimColor> in ({Math.round((totalIn ? totalCached / totalIn : 0) * 100)}% cached)  </Text>
              <Text>{tokens(totalOut)}</Text>
              <Text dimColor> out</Text>
            </Text>
          </Box>
        )}
        {usd !== null && (
          <Text>
            <Text dimColor>session cost  </Text>
            <Text color="#4ade80" bold>${usd.toFixed(2)}</Text>
          </Text>
        )}
        <Box gap={1} marginTop={1} flexWrap="wrap">
          <Button key="mission" hotkey="m" label="Mission Control" onPress={() => void $.command.run({ command: 'mission' })} />
          <Button key="spend" hotkey="s" label="Spend" onPress={() => void $.command.run({ command: 'spend' })} />
          <Button key="cache" hotkey="c" label="Cache" onPress={() => void $.command.run({ command: 'keepwarm', args: 'panel' })} />
        </Box>
      </Box>
    )
  })
}
