import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { Ledger, SpendEntry } from '../types'

const initial: Ledger = { entries: [], totalUsd: 0, samples: [], budgetUsd: null, warned: [] }
const ledger = atom({ plugin: 'spend-ledger', key: 'ledger' } as const, initial)

const PANE = 'spend'
const POLL_MS = 2000
const BURN_WINDOW_MS = 15 * 60_000
const SHOWN = 8
const HELPERS = 'helpers'

// The session's cost is exact (it is /cost); how it splits between prompts and workers is
// estimated. Each poll's increase is shared out over the requests made since the last poll,
// weighted by their tokens at the published price ratios (output 5x input, cache write 1.25x,
// cache read 0.1x) and by the model's relative price. So the rows always add up to /cost.
const MODEL_FACTOR: Array<[RegExp, number]> = [[/opus/i, 5], [/sonnet/i, 3], [/haiku/i, 1], [/fable/i, 5]]
export const modelFactor = (model: string) => MODEL_FACTOR.find(([test]) => test.test(model))?.[1] ?? 3

export const weight = (u: ModelUsage, model: string) =>
  (u.input_tokens + 1.25 * u.cache_creation_input_tokens + 0.1 * u.cache_read_input_tokens + 5 * u.output_tokens) *
  modelFactor(model)

// Share `delta` across pending weights; nothing pending goes to the helpers row.
export const apportion = (delta: number, pending: Record<string, number>) => {
  const total = Object.values(pending).reduce((sum, w) => sum + w, 0)
  if (total <= 0) return { [HELPERS]: delta }
  return Object.fromEntries(Object.entries(pending).map(([id, w]) => [id, (delta * w) / total]))
}

export const usd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `${Math.round(n * 100)}¢`)

export const burnPerHour = (samples: Array<{ at: number; usd: number }>, now: number) => {
  const recent = samples.filter(s => now - s.at <= BURN_WINDOW_MS)
  if (recent.length < 2) return 0
  const first = recent[0]!
  const last = recent[recent.length - 1]!
  const hours = (last.at - first.at) / 3_600_000
  return hours > 0 ? (last.usd - first.usd) / hours : 0
}

const ROLES: Array<[RegExp, string, string]> = [
  [/re-?review|review|verify|audit/i, 'inspecting', '#22d3ee'],
  [/implement|build|fix|write|add|create/i, 'building', '#fb923c'],
  [/explore|map|find|search|survey/i, 'scouting', '#4ade80'],
  [/plan|design|architect|spec/i, 'planning', '#a78bfa'],
]
export const activityOf = (entry: Pick<SpendEntry, 'kind' | 'label'>): [string, string] => {
  if (entry.kind === 'prompt') return ['conversation', '#93c5fd']
  if (entry.kind === 'helpers') return ['helpers', '#64748b']
  const hit = ROLES.find(([test]) => test.test(entry.label))
  return hit ? [hit[1], hit[2]] : ['other work', '#cbd5e1']
}

const bar = (share: number, width: number) => {
  const cells = Math.max(0, Math.min(width, Math.round(share * width)))
  return '█'.repeat(cells) + '░'.repeat(width - cells)
}

// Request weights since the last poll, by entry id. Module state: a reload starts it over.
let pending: Record<string, number> = {}
const promptText = new Map<string, string>()

async function ensureEntry($: EngineInterface, entry: SpendEntry) {
  await update($, ledger, l => (l.entries.some(one => one.id === entry.id) ? l : { ...l, entries: [...l.entries, entry] }))
}

async function warnOnBudget($: EngineInterface) {
  const l = await read($, ledger)
  if (!l.budgetUsd) return
  const share = l.totalUsd / l.budgetUsd
  for (const level of [0.8, 1]) {
    if (share >= level && !l.warned.includes(level)) {
      $.ui.toast(level === 1
        ? `Budget reached: ${usd(l.totalUsd)} of ${usd(l.budgetUsd)} spent this session.`
        : `80% of the budget spent: ${usd(l.totalUsd)} of ${usd(l.budgetUsd)}.`, { timeoutMs: 10_000 })
      await update($, ledger, current => ({ ...current, warned: [...current.warned, level] }))
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const budget = await $.store.get('budgetUsd')
    if (typeof budget === 'number') await update($, ledger, l => ({ ...l, budgetUsd: budget }))
    await $.command.register({ name: 'spend', description: 'Spend panel: /spend opens it, /spend budget 50 sets a session budget, /spend budget off clears it' })
    void $.ui.open({ id: PANE, title: 'Spend' })

    $.clock.every(POLL_MS, async () => {
      const usage = await $.session.usage()
      const total = usage.cost?.usd
      if (total === undefined) return
      const now = await $.clock.now()
      const l = await read($, ledger)
      const delta = total - l.totalUsd
      const shares = delta > 0.000001 ? apportion(delta, pending) : {}
      pending = {}

      if (shares[HELPERS] !== undefined) {
        await ensureEntry($, { id: HELPERS, kind: 'helpers', label: 'Engine helpers (titles, compaction, forks)', model: '', usd: 0, steps: 0, startedAt: now })
      }
      await update($, ledger, current => ({
        ...current,
        totalUsd: total,
        entries: current.entries.map(entry => (shares[entry.id] ? { ...entry, usd: entry.usd + shares[entry.id]! } : entry)),
        samples: [...current.samples, { at: now, usd: total }].filter(s => now - s.at <= BURN_WINDOW_MS + POLL_MS),
      }))
      await warnOnBudget($)
    })

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    promptText.set(e.turnId, e.text)
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny || !started.agentId) return started
    await ensureEntry($, { id: started.agentId, kind: 'agent', label: e.description || e.subagentType, model: started.model, usd: 0, steps: 0, startedAt: await $.clock.now() })
    return started
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (!result.usage) return result

    const model = result.usage.model || e.model
    const id = e.agentId ?? `prompt:${e.turnId}`
    if (!e.agentId) {
      const text = (promptText.get(e.turnId) ?? '').replace(/\s+/g, ' ').trim()
      await ensureEntry($, { id, kind: 'prompt', label: text ? text.slice(0, 60) : 'Follow-up (agent results, wake-ups)', model, usd: 0, steps: 0, startedAt: await $.clock.now() })
    }
    pending[id] = (pending[id] ?? 0) + weight(result.usage, model)
    await update($, ledger, l => ({ ...l, entries: l.entries.map(entry => (entry.id === id ? { ...entry, steps: entry.steps + 1, model } : entry)) }))
    return result
  })

  on('command.run', { command: 'spend' }, async ($, e) => {
    const [word, value] = e.args.trim().split(/\s+/)
    if (word === 'budget') {
      if (value === 'off') {
        await $.store.delete('budgetUsd')
        await update($, ledger, l => ({ ...l, budgetUsd: null, warned: [] }))
        return { text: 'Session budget cleared.' }
      }
      const amount = Number(value)
      if (!(amount > 0)) return { text: 'Give the budget in dollars: /spend budget 50' }
      await $.store.set('budgetUsd', amount)
      await update($, ledger, l => ({ ...l, budgetUsd: amount, warned: [] }))
      return { text: `Session budget set to ${usd(amount)}. You will be told at 80% and at 100%.` }
    }
    await $.ui.open({ id: PANE, title: 'Spend', focus: true })
    return { text: 'Spend panel open.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const l = await read($, ledger)
    const now = await $.clock.now()
    const width = Math.max(24, (e.props.bodyColumns ?? 40) - 2)
    const barWidth = Math.max(6, Math.min(16, width - 30))
    const burn = burnPerHour(l.samples, now)
    const spentTracked = l.entries.reduce((sum, entry) => sum + entry.usd, 0)
    const ranked = [...l.entries].sort((a, b) => b.usd - a.usd)
    const top = ranked.slice(0, SHOWN)
    const biggest = ranked[0]?.usd ?? 0

    const byActivity = new Map<string, { usd: number; hue: string }>()
    for (const entry of l.entries) {
      const [name, hue] = activityOf(entry)
      byActivity.set(name, { usd: (byActivity.get(name)?.usd ?? 0) + entry.usd, hue })
    }
    const activities = [...byActivity.entries()].sort((a, b) => b[1].usd - a[1].usd)

    const byModel = new Map<string, number>()
    for (const entry of l.entries) {
      if (!entry.model) continue
      const name = entry.model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
      byModel.set(name, (byModel.get(name) ?? 0) + entry.usd)
    }
    const models = [...byModel.entries()].sort((a, b) => b[1] - a[1])

    const average = l.samples.length > 1 && l.totalUsd > 0 ? burn : 0
    const budgetShare = l.budgetUsd ? l.totalUsd / l.budgetUsd : 0
    const budgetHue = budgetShare >= 1 ? '#ef4444' : budgetShare >= 0.8 ? '#f97316' : '#22c55e'
    const insights: Array<[string, string]> = []
    if (activities[0] && spentTracked > 0) insights.push([`${activities[0][0]} is ${Math.round((activities[0][1].usd / spentTracked) * 100)}% of the spend`, activities[0][1].hue])
    if (models[0] && spentTracked > 0 && models.length > 1) insights.push([`${models[0][0]} runs ${Math.round((models[0][1] / spentTracked) * 100)}% of it`, '#c084fc'])
    if (ranked[0] && ranked[0].usd > 0) insights.push([`priciest: ${ranked[0].label.slice(0, 34)} (${usd(ranked[0].usd)})`, '#fb923c'])
    if (l.budgetUsd && burn > 0 && l.totalUsd < l.budgetUsd) {
      const hours = (l.budgetUsd - l.totalUsd) / burn
      insights.push([`at this rate the budget lasts ${hours >= 1 ? `${hours.toFixed(1)}h` : `${Math.round(hours * 60)}m`}`, hours < 0.5 ? '#f97316' : '#93c5fd'])
    }

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text bold color="#4ade80">$ SPEND</Text>
          <Text>
            <Text bold color="#4ade80">{usd(l.totalUsd)}</Text>
            <Text dimColor>  ·  </Text>
            <Text bold color={burn > 0 ? '#fb923c' : '#64748b'}>{usd(burn)}/h</Text>
          </Text>
        </Box>
        <Text dimColor>{'─'.repeat(width)}</Text>

        {l.budgetUsd !== null && (
          <Box flexDirection="column" marginBottom={1}>
            <Text>
              <Text dimColor>budget  </Text>
              <Text color={budgetHue}>{bar(Math.min(1, budgetShare), Math.max(10, width - 24))}</Text>
              <Text bold color={budgetHue}> {Math.round(budgetShare * 100)}%</Text>
              <Text dimColor> of {usd(l.budgetUsd)}</Text>
            </Text>
            {budgetShare >= 1 && <Text color="#ef4444">✗ over budget by {usd(l.totalUsd - l.budgetUsd)}</Text>}
            {budgetShare >= 0.8 && budgetShare < 1 && <Text color="#f97316">⚠ {usd(l.budgetUsd - l.totalUsd)} left</Text>}
          </Box>
        )}

        {l.entries.length === 0 ? (
          <Text dimColor>Costs appear here as the session makes requests.</Text>
        ) : (
          <Box flexDirection="column">
            <Text bold dimColor>WHERE IT WENT</Text>
            {top.map(entry => {
              const [, hue] = activityOf(entry)
              const glyph = entry.kind === 'prompt' ? '❯' : entry.kind === 'helpers' ? '⚙' : '◆'
              return (
                <Text key={entry.id} wrap="truncate-end">
                  <Text color={hue}>{glyph} </Text>
                  <Text color={hue}>{bar(biggest > 0 ? entry.usd / biggest : 0, barWidth)}</Text>
                  <Text bold> {usd(entry.usd).padStart(6)}</Text>
                  <Text dimColor>  {entry.label}</Text>
                </Text>
              )
            })}
            {ranked.length > SHOWN && (
              <Text dimColor>  + {ranked.length - SHOWN} more, {usd(ranked.slice(SHOWN).reduce((s, x) => s + x.usd, 0))}</Text>
            )}

            <Box flexDirection="column" marginTop={1}>
              <Text bold dimColor>BY ACTIVITY</Text>
              <Text wrap="truncate-end">
                {activities.map(([name, info]) => (
                  <Text key={name}>
                    <Text color={info.hue}>■ </Text>
                    <Text>{name} </Text>
                    <Text bold>{usd(info.usd)}  </Text>
                  </Text>
                ))}
              </Text>
            </Box>

            {insights.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold dimColor>INSIGHTS</Text>
                {insights.map(([text, hue]) => (
                  <Text key={text} wrap="truncate-end"><Text color={hue}>› </Text>{text}</Text>
                ))}
                {average > 0 && burn > 0 && l.samples.length > 10 && burn > 3 * (l.totalUsd / Math.max(1, (now - (l.samples[0]?.at ?? now)) / 3_600_000)) && (
                  <Text color="#f97316">⚠ spending faster than earlier in the session</Text>
                )}
              </Box>
            )}
            <Text dimColor>split estimated by tokens; the total is /cost</Text>
          </Box>
        )}
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>BUDGET</Text>
          <Box gap={1} flexWrap="wrap">
            <Button key="b25" hotkey="1" label="$25" onPress={() => void $.command.run({ command: 'spend', args: 'budget 25' })} />
            <Button key="b50" hotkey="2" label="$50" onPress={() => void $.command.run({ command: 'spend', args: 'budget 50' })} />
            <Button key="b100" hotkey="3" label="$100" onPress={() => void $.command.run({ command: 'spend', args: 'budget 100' })} />
            <Button key="b250" hotkey="4" label="$250" onPress={() => void $.command.run({ command: 'spend', args: 'budget 250' })} />
            {l.budgetUsd !== null && <Button key="boff" hotkey="0" label="Clear" onPress={() => void $.command.run({ command: 'spend', args: 'budget off' })} />}
          </Box>
        </Box>
      </Box>
    )
  })
}
