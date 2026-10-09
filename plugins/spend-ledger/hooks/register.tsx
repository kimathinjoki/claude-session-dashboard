import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { Ledger, SpendEntry } from '../types'

const initial: Ledger = { entries: [], totalUsd: 0, samples: [], budgetUsd: null, warned: [], limits: [], planBudgetPercent: null, limitSamples: [] }
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

// State saved by an earlier version may lack fields added since; fill them in.
async function readLedger($: EngineInterface): Promise<Ledger> {
  return { ...initial, ...(await read($, ledger)) }
}

export const windowLabel = (kind: string) =>
  kind === 'five_hour' ? '5-hour window' : kind === 'seven_day' ? 'weekly' : kind.replace(/_/g, ' ')

export const resetsIn = (resetsAt: string | undefined, now: number) => {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - now
  if (!(ms > 0)) return 'resetting'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h >= 24 ? `resets in ${Math.floor(h / 24)}d ${h % 24}h` : `resets in ${h}h ${String(m).padStart(2, '0')}m`
}

export const usageHue = (percent: number) => (percent >= 85 ? '#ef4444' : percent >= 60 ? '#f97316' : '#22c55e')

async function ensureEntry($: EngineInterface, entry: SpendEntry) {
  await update($, ledger, l => ((l.entries ?? []).some(one => one.id === entry.id) ? l : { ...l, entries: [...l.entries, entry] }))
}

async function warnOnBudget($: EngineInterface) {
  const l = await readLedger($)
  const fiveHour = l.limits.find(w => w.kind === 'five_hour')
  if (l.planBudgetPercent && fiveHour) {
    const level = fiveHour.percentUsed >= 100 ? 100 : fiveHour.percentUsed >= l.planBudgetPercent ? l.planBudgetPercent : null
    if (level !== null && !l.warned.includes(1000 + level)) {
      $.ui.toast(level === 100
        ? 'The 5-hour plan window is used up.'
        : `${Math.round(fiveHour.percentUsed)}% of the 5-hour plan window used (your line is ${l.planBudgetPercent}%).`, { timeoutMs: 10_000 })
      await update($, ledger, current => ({ ...initial, ...current, warned: [...current.warned, 1000 + level] }))
    }
  }
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
    const planBudget = await $.store.get('planBudgetPercent')
    await update($, ledger, l => ({
      ...initial,
      ...l,
      budgetUsd: typeof budget === 'number' ? budget : l?.budgetUsd ?? null,
      planBudgetPercent: typeof planBudget === 'number' ? planBudget : l?.planBudgetPercent ?? null,
    }))
    await $.command.register({ name: 'spend', description: 'Spend panel: /spend opens it; /spend budget 50 (dollars, API key) or /spend budget 80% (share of the 5-hour plan window); /spend budget off clears it' })
    void $.ui.open({ id: PANE, title: 'Spend' })

    $.clock.every(POLL_MS, async () => {
      const usage = await $.session.usage()
      const now = await $.clock.now()
      const limits = (usage.rateLimits ?? []).map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }))
      const fiveHour = limits.find(w => w.kind === 'five_hour')
      await update($, ledger, current => ({
        ...initial,
        ...current,
        limits,
        limitSamples: fiveHour
          ? [...(current.limitSamples ?? []), { at: now, usd: fiveHour.percentUsed }].filter(s => now - s.at <= BURN_WINDOW_MS + POLL_MS)
          : current.limitSamples ?? [],
      }))
      const total = usage.cost?.usd
      if (total === undefined) {
        await warnOnBudget($)
        return
      }
      const l = await readLedger($)
      const delta = total - l.totalUsd
      const shares = delta > 0.000001 ? apportion(delta, pending) : {}
      pending = {}

      if (shares[HELPERS] !== undefined) {
        await ensureEntry($, { id: HELPERS, kind: 'helpers', label: 'Engine helpers (titles, compaction, forks)', model: '', usd: 0, steps: 0, startedAt: now })
      }
      await update($, ledger, current => ({
        ...initial,
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
    await update($, ledger, l => ({ ...initial, ...l, entries: l.entries.map(entry => (entry.id === id ? { ...entry, steps: entry.steps + 1, model } : entry)) }))
    return result
  })

  on('command.run', { command: 'spend' }, async ($, e) => {
    const [word, value] = e.args.trim().split(/\s+/)
    if (word === 'budget') {
      if (value === 'off') {
        await $.store.delete('budgetUsd')
        await $.store.delete('planBudgetPercent')
        await update($, ledger, l => ({ ...initial, ...l, budgetUsd: null, planBudgetPercent: null, warned: [] }))
        return { text: 'Budget cleared.' }
      }
      if (value?.endsWith('%')) {
        const percent = Number(value.slice(0, -1))
        if (!(percent > 0 && percent <= 100)) return { text: 'Give the plan line as a share of the 5-hour window: /spend budget 80%' }
        await $.store.set('planBudgetPercent', percent)
        await update($, ledger, l => ({ ...initial, ...l, planBudgetPercent: percent, warned: [] }))
        return { text: `You will be told when the 5-hour plan window passes ${percent}%.` }
      }
      const amount = Number(value)
      if (!(amount > 0)) return { text: 'Give the budget in dollars: /spend budget 50' }
      await $.store.set('budgetUsd', amount)
      await update($, ledger, l => ({ ...initial, ...l, budgetUsd: amount, warned: [] }))
      return { text: `Session budget set to ${usd(amount)}. You will be told at 80% and at 100%.` }
    }
    await $.ui.open({ id: PANE, title: 'Spend', focus: true })
    return { text: 'Spend panel open.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const l = await readLedger($)
    const now = await $.clock.now()
    const onPlan = l.limits.length > 0
    const fiveHour = l.limits.find(w => w.kind === 'five_hour')
    const planBurn = burnPerHour(l.limitSamples ?? [], now)
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
          <Text bold color="#4ade80">{onPlan ? '◆ USAGE' : '$ SPEND'}</Text>
          <Text>
            {onPlan && fiveHour ? (
              <Text bold color={usageHue(fiveHour.percentUsed)}>{Math.round(fiveHour.percentUsed)}% of 5h</Text>
            ) : (
              <Text bold color="#4ade80">{usd(l.totalUsd)}</Text>
            )}
            <Text dimColor>  ·  </Text>
            {onPlan ? (
              <Text bold color={planBurn > 0 ? '#fb923c' : '#64748b'}>{planBurn.toFixed(1)}%/h</Text>
            ) : (
              <Text bold color={burn > 0 ? '#fb923c' : '#64748b'}>{usd(burn)}/h</Text>
            )}
          </Text>
        </Box>
        <Text dimColor>{'─'.repeat(width)}</Text>

        {onPlan && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold dimColor>PLAN WINDOWS</Text>
            {l.limits.map(w => (
              <Text key={w.kind} wrap="truncate-end">
                <Text dimColor>{windowLabel(w.kind).padEnd(14)}</Text>
                <Text color={usageHue(w.percentUsed)}>{bar(Math.min(1, w.percentUsed / 100), Math.max(8, width - 34))}</Text>
                <Text bold color={usageHue(w.percentUsed)}> {Math.round(w.percentUsed)}%</Text>
                <Text dimColor>  {resetsIn(w.resetsAt, now)}</Text>
              </Text>
            ))}
            {fiveHour && planBurn > 0 && fiveHour.percentUsed < 100 && (
              <Text color={(100 - fiveHour.percentUsed) / planBurn < 1 ? '#f97316' : '#93c5fd'}>
                › at this pace the 5-hour window lasts {(() => { const h = (100 - fiveHour.percentUsed) / planBurn; return h >= 1 ? `${h.toFixed(1)}h` : `${Math.round(h * 60)}m` })()}
              </Text>
            )}
            {l.planBudgetPercent !== null && fiveHour && fiveHour.percentUsed >= l.planBudgetPercent && (
              <Text color={fiveHour.percentUsed >= 100 ? '#ef4444' : '#f97316'}>⚠ past your {l.planBudgetPercent}% line</Text>
            )}
            <Text dimColor>dollar figures below are the API-price value of this work, not a charge</Text>
          </Box>
        )}

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
            {onPlan ? (
              <>
                <Button key="p50" hotkey="1" label="Warn at 50%" onPress={() => void $.command.run({ command: 'spend', args: 'budget 50%' })} />
                <Button key="p75" hotkey="2" label="75%" onPress={() => void $.command.run({ command: 'spend', args: 'budget 75%' })} />
                <Button key="p90" hotkey="3" label="90%" onPress={() => void $.command.run({ command: 'spend', args: 'budget 90%' })} />
              </>
            ) : (
              <>
                <Button key="b25" hotkey="1" label="$25" onPress={() => void $.command.run({ command: 'spend', args: 'budget 25' })} />
                <Button key="b50" hotkey="2" label="$50" onPress={() => void $.command.run({ command: 'spend', args: 'budget 50' })} />
                <Button key="b100" hotkey="3" label="$100" onPress={() => void $.command.run({ command: 'spend', args: 'budget 100' })} />
                <Button key="b250" hotkey="4" label="$250" onPress={() => void $.command.run({ command: 'spend', args: 'budget 250' })} />
              </>
            )}
            {(l.budgetUsd !== null || l.planBudgetPercent !== null) && <Button key="boff" hotkey="0" label="Clear" onPress={() => void $.command.run({ command: 'spend', args: 'budget off' })} />}
          </Box>
        </Box>
      </Box>
    )
  })
}
