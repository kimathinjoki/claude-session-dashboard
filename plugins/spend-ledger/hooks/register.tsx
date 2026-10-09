import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { Ledger, SpendBucket, SpendEntry, StatsChart, StatsRange, StatsView } from '../types'
import {
  CHARTS, CHART_HUE, CHART_LABEL, LEVEL_HUE, RANGES, RANGE_HUE, RANGE_LABEL, SHADES, TAB_GAP, VIEWS, VIEW_HUE, VIEW_LABEL, addToDay, barChart, mergeHistory, parseClaudeStats, colourRuns, columnPoints, compact, drawChart, trendOf, TREND_HUE, dayKey, durationText,
  emptyHistory, funFact, heatmap, pointsFor, seriesFor, tilesFor,
} from './stats'

const initial: Ledger = { entries: [], totalUsd: 0, samples: [], budgetUsd: null, warned: [], limits: [], planBudgetPercent: null, limitSamples: [], expanded: false, models: {}, buckets: [], history: emptyHistory(), statsView: 'overview', statsRange: 'session', statsModel: null, statsChart: 'line', hardStop: false, sessionStartedAt: null, claudeStats: null, usdBaseline: null, weightedSince: 0 }
const ledger = atom({ plugin: 'spend-ledger', key: 'ledger' } as const, initial)

const PANE = 'spend'
const POLL_MS = 2000
const BURN_WINDOW_MS = 15 * 60_000
const SHOWN = 8
const HISTORY_KEY = 'history'
const SAVE_EVERY_MS = 15_000
let lastSaved = 0
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

export const modelName = (id: string) => id.replace(/^claude-/, '').replace(/-\d{8}$/, '')
const MODEL_HUES: Array<[RegExp, string]> = [[/opus/i, '#c084fc'], [/sonnet/i, '#60a5fa'], [/haiku/i, '#34d399'], [/fable/i, '#f9a8d4']]
export const modelHue = (id: string) => MODEL_HUES.find(([test]) => test.test(id))?.[1] ?? '#cbd5e1'
const shortTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)

export const BUCKET_MS = 5 * 60_000
const MAX_BUCKETS = 288
const EIGHTHS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

// Add to the bucket `now` falls in, opening it (and any empty ones between) when needed.
export const intoBucket = (
  buckets: SpendBucket[],
  now: number,
  change: (b: SpendBucket) => SpendBucket,
): SpendBucket[] => {
  const start = Math.floor(now / BUCKET_MS) * BUCKET_MS
  const list = [...buckets]
  let last = list[list.length - 1]
  if (!last) {
    list.push({ start, usd: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, planPercent: null })
  } else {
    for (let at = last.start + BUCKET_MS; at <= start; at += BUCKET_MS) {
      list.push({ start: at, usd: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, planPercent: last.planPercent })
    }
  }
  last = list[list.length - 1]!
  list[list.length - 1] = change(last)
  return list.slice(-MAX_BUCKETS)
}

// A column chart `height` rows tall, one column per value, as text rows top first.
export const columns = (values: number[], height: number) => {
  const max = Math.max(...values, 0)
  const rows: string[] = []
  for (let row = height - 1; row >= 0; row -= 1) {
    rows.push(values.map(v => {
      const eighths = max > 0 ? Math.round((v / max) * height * 8) : 0
      const fill = eighths - row * 8
      return fill >= 8 ? '█' : fill <= 0 ? ' ' : EIGHTHS[fill]!
    }).join(''))
  }
  return rows
}

export const sparkline = (values: number[], max = Math.max(...values, 0)) =>
  values.map(v => (max > 0 ? SPARK[Math.min(SPARK.length - 1, Math.round((v / max) * (SPARK.length - 1)))] : SPARK[0])).join('')

const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
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
// The same weights keyed by model, so each poll's increase also splits across models.
let pendingByModel: Record<string, number> = {}
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

// Whether the budget in force is used up: dollars this session, or the plan line on the 5-hour window.
export const budgetReached = (l: Pick<Ledger, 'budgetUsd' | 'planBudgetPercent' | 'totalUsd' | 'limits'>) => {
  const fiveHour = (l.limits ?? []).find(w => w.kind === 'five_hour')
  if (l.planBudgetPercent != null && fiveHour && fiveHour.percentUsed >= l.planBudgetPercent) {
    return `the 5-hour plan window is at ${Math.round(fiveHour.percentUsed)}%, past your ${l.planBudgetPercent}% line`
  }
  if (l.budgetUsd != null && l.totalUsd >= l.budgetUsd) {
    return `${usd(l.totalUsd)} spent this session, past your ${usd(l.budgetUsd)} budget`
  }
  return null
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
    const saved = (await $.store.get(HISTORY_KEY)) as Ledger['history'] | undefined
    const startedAt = await $.clock.now()
    const history = saved && typeof saved === 'object' && saved.days ? saved : emptyHistory()
    const counted = addToDay({ ...history, sessions: history.sessions + 1, firstSeen: history.firstSeen ?? startedAt }, startedAt, d => ({ ...d, sessions: d.sessions + 1 }))
    await update($, ledger, l => ({ ...initial, ...l, history: counted, sessionStartedAt: l?.sessionStartedAt ?? startedAt }))
    await $.store.set(HISTORY_KEY, counted)
    const budget = await $.store.get('budgetUsd')
    const planBudget = await $.store.get('planBudgetPercent')
    const hardStop = await $.store.get('hardStop')
    await update($, ledger, l => ({
      ...initial,
      ...l,
      budgetUsd: typeof budget === 'number' ? budget : l?.budgetUsd ?? null,
      planBudgetPercent: typeof planBudget === 'number' ? planBudget : l?.planBudgetPercent ?? null,
      hardStop: hardStop === true,
    }))
    await $.command.register({ name: 'spend', description: 'Spend panel: /spend opens it; /spend budget 50 (dollars) or /spend budget 80% (plan window), add hard to refuse prompts once reached; /spend hard on|off; /spend budget off clears it' })
    void $.ui.open({ id: PANE, title: 'Spend' })

    // Claude Code's own usage history, the file /usage reads: the 7-day, 30-day and all-time views.
    const loadClaudeStats = async () => {
      try {
        const home = await $.env.get('HOME')
        if (!home) return
        const parsed = parseClaudeStats(await $.fs.read(`${home}/.claude/stats-cache.json`))
        if (parsed) await update($, ledger, l => ({ ...initial, ...l, claudeStats: parsed }))
      } catch {
        // No file yet (a new install) or unreadable: the charts use this mod's own days only.
      }
    }
    await loadClaudeStats()
    $.clock.every(10 * 60_000, () => void loadClaudeStats())

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
      const weighedNow = Object.values(pending).reduce((sum, w) => sum + w, 0)
      await update($, ledger, current => ({
        ...initial,
        ...current,
        usdBaseline: current.usdBaseline ?? total,
        weightedSince: current.usdBaseline == null ? 0 : (current.weightedSince ?? 0) + weighedNow,
      }))
      const shares = delta > 0.000001 ? apportion(delta, pending) : {}
      const modelShares = delta > 0.000001 && Object.keys(pendingByModel).length > 0 ? apportion(delta, pendingByModel) : {}
      pending = {}
      pendingByModel = {}

      if (shares[HELPERS] !== undefined) {
        await ensureEntry($, { id: HELPERS, kind: 'helpers', label: 'Engine helpers (titles, compaction, forks)', model: '', usd: 0, steps: 0, startedAt: now })
      }
      await update($, ledger, current => ({
        ...initial,
        ...current,
        history: addToDay(
          {
            ...(current.history ?? emptyHistory()),
            longestSessionMs: Math.max(current.history?.longestSessionMs ?? 0, now - (current.sessionStartedAt ?? now)),
          },
          now,
          d => {
            const models = { ...d.models }
            for (const [id, share] of Object.entries(modelShares)) {
              const m = models[id] ?? { usd: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
              models[id] = { ...m, usd: m.usd + share }
            }
            return { ...d, usd: d.usd + Math.max(0, delta), models }
          },
        ),
        buckets: intoBucket(current.buckets ?? [], now, b => ({
          ...b,
          usd: b.usd + Math.max(0, delta),
          planPercent: (current.limits ?? []).find(w => w.kind === 'five_hour')?.percentUsed ?? b.planPercent,
        })),
        totalUsd: total,
        entries: current.entries.map(entry => (shares[entry.id] ? { ...entry, usd: entry.usd + shares[entry.id]! } : entry)),
        models: Object.fromEntries(
          Object.entries(current.models ?? {}).map(([id, m]) => [id, { ...m, usd: m.usd + (modelShares[id] ?? 0) }]),
        ),
        samples: [...current.samples, { at: now, usd: total }].filter(s => now - s.at <= BURN_WINDOW_MS + POLL_MS),
      }))
      await warnOnBudget($)
      if (now - lastSaved > SAVE_EVERY_MS) {
        lastSaved = now
        await $.store.set(HISTORY_KEY, (await readLedger($)).history)
      }
    })

    return next(e)
  })

  // The hard stop: a prompt you type is refused once the budget is reached. Slash commands go
  // through so /spend can raise or clear it, and anything that is not your own typing (an agent's
  // result arriving, a scheduled wake-up) is left alone.
  on('prompt.submit', async ($, e, next) => {
    const isOwn = !e.origin || e.origin.kind === 'composer'
    if (!isOwn || e.text.trim().startsWith('/')) return next(e)
    const l = await readLedger($)
    if (!l.hardStop) return next(e)
    const reason = budgetReached(l)
    if (!reason) return next(e)
    return { drop: `Budget reached: ${reason}. Raise it (/spend budget 100), clear it (/spend budget off) or turn the hard stop off (/spend hard off) to continue.` }
  }).catch(($, e, next) => next(e))

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
    const w = weight(result.usage, model)
    pending[id] = (pending[id] ?? 0) + w
    if (model) pendingByModel[model] = (pendingByModel[model] ?? 0) + w
    const u = result.usage
    await update($, ledger, current => {
      const models = { ...(current.models ?? {}) }
      const m = models[model] ?? { usd: 0, steps: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
      models[model] = {
        ...m,
        steps: m.steps + 1,
        inputTokens: m.inputTokens + u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens,
        cacheReadTokens: m.cacheReadTokens + u.cache_read_input_tokens,
        outputTokens: m.outputTokens + u.output_tokens,
      }
      const at = Date.now()
      return {
        ...initial,
        ...current,
        models,
        history: addToDay(current.history ?? emptyHistory(), at, d => {
          const dm = d.models[model] ?? { usd: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          const fresh = u.input_tokens
          return {
            ...d,
            requests: d.requests + 1,
            input: d.input + fresh + u.cache_creation_input_tokens + u.cache_read_input_tokens,
            output: d.output + u.output_tokens,
            cacheRead: d.cacheRead + u.cache_read_input_tokens,
            cacheWrite: d.cacheWrite + u.cache_creation_input_tokens,
            models: {
              ...d.models,
              [model]: {
                ...dm,
                requests: dm.requests + 1,
                input: dm.input + fresh + u.cache_creation_input_tokens + u.cache_read_input_tokens,
                output: dm.output + u.output_tokens,
                cacheRead: dm.cacheRead + u.cache_read_input_tokens,
                cacheWrite: dm.cacheWrite + u.cache_creation_input_tokens,
              },
            },
          }
        }),
        buckets: intoBucket(current.buckets ?? [], at, b => ({
          ...b,
          inputTokens: b.inputTokens + u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens,
          cacheReadTokens: b.cacheReadTokens + u.cache_read_input_tokens,
          outputTokens: b.outputTokens + u.output_tokens,
        })),
      }
    })
    await update($, ledger, l => ({ ...initial, ...l, entries: l.entries.map(entry => (entry.id === id ? { ...entry, steps: entry.steps + 1, model } : entry)) }))
    return result
  })

  on('command.run', { command: 'spend' }, async ($, e) => {
    const [word, value, extra] = e.args.trim().split(/\s+/)
    if (word === 'hard') {
      const enabled = value !== 'off'
      await $.store.set('hardStop', enabled)
      await update($, ledger, l => ({ ...initial, ...l, hardStop: enabled }))
      return { text: enabled ? 'Hard stop on: once the budget is reached, new prompts are refused until you raise or clear it.' : 'Hard stop off: the budget only warns.' }
    }
    if (word === 'budget' && extra === 'hard') {
      await $.store.set('hardStop', true)
      await update($, ledger, l => ({ ...initial, ...l, hardStop: true }))
    }
    if (word === 'budget') {
      if (value === 'off') {
        await $.store.delete('budgetUsd')
        await $.store.delete('planBudgetPercent')
        await $.store.delete('hardStop')
        await update($, ledger, l => ({ ...initial, ...l, budgetUsd: null, planBudgetPercent: null, warned: [], hardStop: false }))
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
    const top = l.expanded ? ranked : ranked.slice(0, SHOWN)
    const hidden = ranked.slice(top.length)
    const subtotal = (kind: string) => l.entries.filter(entry => entry.kind === kind).reduce((sum, entry) => sum + entry.usd, 0)
    const count = (kind: string) => l.entries.filter(entry => entry.kind === kind).length
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

    const setStats = (change: Partial<Pick<Ledger, 'statsView' | 'statsRange' | 'statsModel' | 'statsChart'>>) =>
      void update($, ledger, current => ({ ...initial, ...current, ...change }))
    const cycle = <T,>(list: T[], value: T) => list[(list.indexOf(value) + 1) % list.length]!

    // A row of clickable tabs, each with its colour underneath: a thin rule at rest, a bold bar
    // under the chosen one. The labels are plain buttons, so the rule lines up character for
    // character beneath them.
    const tabs = <T extends string,>(
      list: T[], chosen: T, label: (t: T) => string, hue: (t: T) => string, choose: (t: T) => void, prefix: string,
    ) => (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={TAB_GAP}>
          {list.map(t => (
            <Button key={`${prefix}-${t}`} plain dimColor={t !== chosen} label={label(t)} onPress={() => choose(t)} />
          ))}
        </Box>
        <Text>
          {list.map((t, i) => (
            <Text key={`${prefix}-rule-${t}`}>
              <Text color={hue(t)} bold={t === chosen} dimColor={t !== chosen}>{(t === chosen ? '▀' : '─').repeat(label(t).length)}</Text>
              {i < list.length - 1 ? ' '.repeat(TAB_GAP) : ''}
            </Text>
          ))}
        </Text>
      </Box>
    )

    const renderStats = () => {
      const view: StatsView = l.statsView ?? 'overview'
      const range: StatsRange = l.statsRange ?? 'session'
      const chartStyle: StatsChart = l.statsChart ?? 'line'
      const history = mergeHistory(l.history ?? emptyHistory(), l.claudeStats ?? null)
      // On a subscription the dollar figures are what the tokens would cost at API prices, not a
      // charge: say so wherever a dollar figure is shown.
      const asValue = onPlan
      const costWord = asValue ? 'API value' : 'Cost'
      const modelIds = Object.keys(l.models ?? {})
      const model = l.statsModel && modelIds.includes(l.statsModel) ? l.statsModel : null
      const chartWidth = Math.max(16, width - 10)

      const header = (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text bold color="#fb923c">▤ STATS  </Text>
            <Text bold color={VIEW_HUE[view]}>{VIEW_LABEL[view]}</Text>
            <Text dimColor> · </Text>
            <Text bold color={RANGE_HUE[range]}>{RANGE_LABEL[range]}</Text>
            {model ? <Text><Text dimColor> · </Text><Text bold color={modelHue(model)}>{modelName(model)}</Text></Text> : null}
          </Text>
          {tabs(VIEWS, view, v => VIEW_LABEL[v], v => VIEW_HUE[v], v => setStats({ statsView: v }), 'view')}
          {tabs(RANGES, range, r => RANGE_LABEL[r], r => RANGE_HUE[r], r => setStats({ statsRange: r }), 'range')}
          {view !== 'overview' && tabs(CHARTS, chartStyle, c => CHART_LABEL[c], c => CHART_HUE[c], c => setStats({ statsChart: c }), 'chart')}
          <Box gap={1} flexWrap="wrap">
            <Button key="cycle-view" hotkey="v" label="Next view" onPress={() => setStats({ statsView: cycle(VIEWS, view) })} />
            <Button key="cycle-range" hotkey="r" label="Next range" onPress={() => setStats({ statsRange: cycle(RANGES, range) })} />
            {view !== 'overview' && (
              <Button key="cycle-chart" hotkey="c" label="Next chart" onPress={() => setStats({ statsChart: cycle(CHARTS, chartStyle) })} />
            )}
            {modelIds.length > 1 && (
              <Button
                key="cycle-model"
                hotkey="m"
                label={model ? `Model: ${modelName(model)}` : 'Model: all'}
                onPress={() => setStats({ statsModel: cycle([null, ...modelIds], model) })}
              />
            )}
          </Box>
        </Box>
      )

      if (view === 'overview') {
        const today = history.days[dayKey(now)] ?? null
        const tiles = tilesFor(history, range, now, today)
        const weeks = Math.max(8, Math.min(52, Math.floor((width - 6) / 1)))
        const map = heatmap(history, now, weeks)
        const dayNames = ['Mon', '   ', 'Wed', '   ', 'Fri', '   ', 'Sun']
        const tile = (label: string, value: string, hue = '#fdba74') => (
          <Text key={label}><Text dimColor>{label}: </Text><Text bold color={hue}>{value}</Text></Text>
        )
        return (
          <Box flexDirection="column">
            {header}
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>{'    '}{map.months}</Text>
              {map.levels.map((row, d) => (
                <Text key={`hm-${d}`}>
                  <Text dimColor>{dayNames[d]} </Text>
                  {row.map((lvl, w) => (
                    <Text key={`c-${d}-${w}`} color={lvl < 0 ? '#1e293b' : LEVEL_HUE[lvl]}>{lvl < 0 ? ' ' : SHADES[lvl]}</Text>
                  ))}
                </Text>
              ))}
              <Text>
                <Text dimColor>{'    '}Less </Text>
                {LEVEL_HUE.map((hue, i) => <Text key={`lg-${i}`} color={hue}>{SHADES[i]}</Text>)}
                <Text dimColor> More</Text>
              </Text>
            </Box>
            {l.claudeStats && l.claudeStats.hourCounts.some(n => n > 0) && (() => {
              const hours = l.claudeStats!.hourCounts
              const rows = barChart(hours, Math.min(48, Math.max(24, width - 6)), 3, Math.max(...hours))
              const busiest = hours.indexOf(Math.max(...hours))
              return (
                <Box flexDirection="column" marginTop={1}>
                  <Text><Text bold dimColor>ACTIVE HOURS  </Text><Text dimColor>busiest </Text><Text bold color="#fdba74">{String(busiest).padStart(2, '0')}:00</Text></Text>
                  {rows.map((row, i) => <Text key={`hr-${i}`} color="#fb923c">{'    '}{row}</Text>)}
                  <Text dimColor>{'    '}{'00'.padEnd(Math.floor(rows[0]!.length / 2))}{'12'.padEnd(Math.ceil(rows[0]!.length / 2) - 2)}23</Text>
                </Box>
              )
            })()}
            <Box flexDirection="column" marginTop={1}>
              {tile('Favorite model', tiles.favorite ? modelName(tiles.favorite) : '-', tiles.favorite ? modelHue(tiles.favorite) : '#94a3b8')}
              {tile('Total tokens', compact(tiles.total.input + tiles.total.output))}
              {tile('Requests', compact(tiles.total.requests))}
              {tile(costWord, usd(tiles.total.usd), '#4ade80')}
              {range !== 'session' && tile('Sessions', String(tiles.total.sessions))}
              {range !== 'session' && (
                <Text><Text dimColor>Active days: </Text><Text bold color="#fdba74">{tiles.activeDays}</Text><Text dimColor>/{tiles.spanDays}</Text></Text>
              )}
              {tiles.busiest && range !== 'session' && tile('Most active day', tiles.busiest)}
              {tile('Longest session', durationText(tiles.longestSessionMs))}
              {tile('Longest streak', `${tiles.longestStreak} ${tiles.longestStreak === 1 ? 'day' : 'days'}`)}
              {tile('Current streak', `${tiles.currentStreak} ${tiles.currentStreak === 1 ? 'day' : 'days'}`)}
              <Text dimColor>
                Input {compact(tiles.total.input - tiles.total.cacheRead - tiles.total.cacheWrite)} · Output {compact(tiles.total.output)} · Cache read {compact(tiles.total.cacheRead)} · Cache write {compact(tiles.total.cacheWrite)}
              </Text>
              <Text color="#93c5fd">{funFact(tiles.total.input + tiles.total.output)}</Text>
              {l.claudeStats && range !== 'session' && (
                <Text dimColor>past days from Claude Code's own history, priced at list prices; their in/out split is estimated</Text>
              )}
            </Box>
          </Box>
        )
      }

      const points = pointsFor(range, l.buckets ?? [], history, range === 'session' ? null : model, now)
      const series = seriesFor(view, points)
      const percent = view === 'cache'
      const max = percent ? 100 : Math.max(...series.flatMap(s => s.values).filter(Number.isFinite), 0)
      const height = 8
      const fmt = (v: number) => (view === 'cost' ? usd(v) : percent ? `${Math.round(v)}%` : compact(v))
      const axis = [max, (max * 2) / 3, max / 3, 0].map(fmt)
      const labelWidth = Math.max(...axis.map(a => a.length)) + 1

      return (
        <Box flexDirection="column">
          {header}
          {points.length < 2 ? (
            <Text dimColor>{'\n'}Not enough {range === 'session' ? 'of this session' : 'history'} yet for a chart. It fills in as you work.</Text>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>{view === 'cost' ? costWord : VIEW_LABEL[view]} {range === 'session' ? 'per 5 minutes' : 'per day'}{model && range !== 'session' ? `, ${modelName(model)}` : ''}</Text>
              {view === 'cost' && asValue && (
                <Text color="#93c5fd">› what these tokens would cost at API prices; on a plan you pay the plan, not this</Text>
              )}
              {series.map(s => {
                const rows = drawChart(chartStyle, s.values, chartWidth - labelWidth, height, max)
                // Each column takes the colour of its point's change: rising, falling or level.
                const plotWidth = chartWidth - labelWidth
                const trendHue = TREND_HUE[view]
                const columnHues = columnPoints(chartStyle, s.values.length, plotWidth).map(i => {
                  const t = i < 0 ? 'flat' : trendOf(s.values, i)
                  return t === 'up' ? trendHue.up : t === 'down' ? trendHue.down : s.hue
                })
                return (
                  <Box key={`chart-${s.name}`} flexDirection="column">
                    {rows.map((row, i) => (
                      <Text key={`r-${s.name}-${i}`}>
                        <Text dimColor>{((i === 0 ? axis[0] : i === Math.floor(height / 3) ? axis[1] : i === Math.floor((2 * height) / 3) ? axis[2] : i === height - 1 ? axis[3] : '') ?? '').padStart(labelWidth - 1)} {i === 0 || i === height - 1 || i === Math.floor(height / 3) || i === Math.floor((2 * height) / 3) ? '┤' : '│'}</Text>
                        {chartStyle === 'line' ? (
                          <Text color={s.hue}>{row}</Text>
                        ) : (
                          colourRuns(row, columnHues).map((run, k) => (
                            <Text key={`run-${s.name}-${i}-${k}`} color={run.hue}>{run.text}</Text>
                          ))
                        )}
                      </Text>
                    ))}
                  </Box>
                )
              })}
              {(() => {
                const plot = chartWidth - labelWidth
                const first = points[0]!.label
                const middle = points[Math.floor(points.length / 2)]!.label
                const last = points[points.length - 1]!.label
                const gap = Math.max(1, Math.floor((plot - first.length - middle.length - last.length) / 2))
                return (
                  <Text dimColor>
                    {' '.repeat(labelWidth + 1)}{first}{' '.repeat(gap)}{middle}{' '.repeat(Math.max(1, plot - first.length - gap - middle.length - last.length))}{last}
                  </Text>
                )
              })()}
              {range !== 'session' && !l.claudeStats && points.filter(p => p.input + p.output > 0).length <= 1 && (
                <Text color="#93c5fd">› daily history started recently; This session shows today in 5-minute slices</Text>
              )}
              <Text>
                {series.map(s => (
                  <Text key={`lg-${s.name}`}><Text color={s.hue}>● </Text><Text dimColor>{s.name}  </Text></Text>
                ))}
                {chartStyle !== 'line' && (
                  <Text>
                    <Text color={TREND_HUE[view].up}>▲ </Text><Text dimColor>{view === 'cache' ? 'more from cache  ' : 'rising  '}</Text>
                    <Text color={TREND_HUE[view].down}>▼ </Text><Text dimColor>{view === 'cache' ? 'less from cache' : 'falling'}</Text>
                  </Text>
                )}
              </Text>
              {view === 'tokens' && Object.keys(l.models ?? {}).length > 0 && (
                <Box flexDirection="column" marginTop={1}>
                  {Object.entries(l.models).sort((a, b) => b[1].inputTokens + b[1].outputTokens - (a[1].inputTokens + a[1].outputTokens)).map(([id, m]) => {
                    const all = Object.values(l.models).reduce((t, x) => t + x.inputTokens + x.outputTokens, 0)
                    return (
                      <Box key={`mc-${id}`} flexDirection="column">
                        <Text><Text color={modelHue(id)}>● </Text><Text bold>{modelName(id)}</Text><Text dimColor> ({all > 0 ? (((m.inputTokens + m.outputTokens) / all) * 100).toFixed(1) : 0}%)</Text></Text>
                        <Text dimColor>  In: {compact(m.inputTokens - m.cacheReadTokens)} · Out: {compact(m.outputTokens)} · Cache: {compact(m.cacheReadTokens)} read</Text>
                      </Box>
                    )
                  })}
                </Box>
              )}
            </Box>
          )}
        </Box>
      )
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
            {hidden.length > 0 && (
              <Text dimColor>  + {hidden.length} more, {usd(hidden.reduce((sum, x) => sum + x.usd, 0))}</Text>
            )}
            {ranked.length > SHOWN && (
              <Box marginTop={1}>
                <Button
                  key="expand"
                  hotkey="a"
                  label={l.expanded ? `Show top ${SHOWN}` : `Show all ${ranked.length}`}
                  onPress={() => void update($, ledger, current => ({ ...initial, ...current, expanded: !current.expanded }))}
                />
              </Box>
            )}

            <Box flexDirection="column" marginTop={1}>
              <Text bold dimColor>TOTAL</Text>
              <Text>
                <Text color="#93c5fd">❯ </Text>
                <Text dimColor>{`your prompts (${count('prompt')})`.padEnd(22)}</Text>
                <Text bold>{usd(subtotal('prompt')).padStart(7)}</Text>
              </Text>
              <Text>
                <Text color="#fb923c">◆ </Text>
                <Text dimColor>{`sub-agents (${count('agent')})`.padEnd(22)}</Text>
                <Text bold>{usd(subtotal('agent')).padStart(7)}</Text>
              </Text>
              {count('helpers') > 0 && (
                <Text>
                  <Text color="#64748b">⚙ </Text>
                  <Text dimColor>{'engine helpers'.padEnd(22)}</Text>
                  <Text bold>{usd(subtotal('helpers')).padStart(7)}</Text>
                </Text>
              )}
              <Text dimColor>{'─'.repeat(Math.min(width, 33))}</Text>
              <Text>
                <Text>  </Text>
                <Text bold>{'session total'.padEnd(22)}</Text>
                <Text bold color="#4ade80">{usd(l.totalUsd).padStart(7)}</Text>
                {onPlan ? <Text dimColor>  API-price value</Text> : null}
              </Text>
            </Box>

            {Object.keys(l.models ?? {}).length > 0 && (() => {
              const models = Object.entries(l.models).sort((a, b) => b[1].usd - a[1].usd)
              const modelTotal = models.reduce((sum, [, m]) => sum + m.usd, 0)
              return (
                <Box flexDirection="column" marginTop={1}>
                  <Text bold dimColor>BY MODEL</Text>
                  {models.map(([id, m]) => {
                    const share = modelTotal > 0 ? m.usd / modelTotal : 0
                    const hit = m.inputTokens > 0 ? m.cacheReadTokens / m.inputTokens : 0
                    return (
                      <Box key={id} flexDirection="column">
                        <Text wrap="truncate-end">
                          <Text color={modelHue(id)} bold>● {modelName(id).padEnd(16)}</Text>
                          <Text color={modelHue(id)}>{bar(share, Math.max(6, Math.min(14, width - 36)))}</Text>
                          <Text bold> {usd(m.usd).padStart(6)}</Text>
                          <Text dimColor> {Math.round(share * 100)}%</Text>
                        </Text>
                        <Text dimColor wrap="truncate-end">
                          {'  '}{m.steps} requests · in {shortTokens(m.inputTokens)} ({Math.round(hit * 100)}% cached) · out {shortTokens(m.outputTokens)}
                        </Text>
                      </Box>
                    )
                  })}
                </Box>
              )
            })()}

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
            {renderStats()}
          </Box>
        )}
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text bold dimColor>BUDGET  </Text>
            {l.planBudgetPercent !== null && <Text color="#fb923c">warn at {l.planBudgetPercent}% of the 5-hour window</Text>}
            {l.budgetUsd !== null && <Text color="#fb923c">{usd(l.budgetUsd)} this session</Text>}
            {l.planBudgetPercent === null && l.budgetUsd === null && <Text dimColor>none set</Text>}
            {(l.planBudgetPercent !== null || l.budgetUsd !== null) && (
              l.hardStop
                ? <Text color={budgetReached(l) ? '#ef4444' : '#fb923c'} bold>{budgetReached(l) ? '  ■ HARD STOP: prompts refused' : '  ■ hard stop on'}</Text>
                : <Text dimColor>  warn only</Text>
            )}
          </Text>
          <Box flexDirection="row" columnGap={1} flexWrap="wrap">
            {(onPlan
              ? [['p50', '1', 'Warn at 50%', 'budget 50%'], ['p75', '2', '75%', 'budget 75%'], ['p90', '3', '90%', 'budget 90%']]
              : [['b25', '1', '$25', 'budget 25'], ['b50', '2', '$50', 'budget 50'], ['b100', '3', '$100', 'budget 100'], ['b250', '4', '$250', 'budget 250']]
            )
              .concat(l.budgetUsd !== null || l.planBudgetPercent !== null
                ? [['hard', 'h', l.hardStop ? 'Hard stop: on' : 'Hard stop: off', l.hardStop ? 'hard off' : 'hard on'], ['boff', '0', 'Clear', 'budget off']]
                : [])
              .map(([key, hotkey, label, args]) => (
                <Button key={key!} hotkey={hotkey!} label={label!} onPress={() => void $.command.run({ command: 'spend', args: args! })} />
              ))}
          </Box>
        </Box>
      </Box>
    )
  })
}
