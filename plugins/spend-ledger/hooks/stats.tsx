// The STATS dashboard: pure helpers for the history the mod keeps across sessions, the series
// each view charts, a braille line chart, a day heatmap and the stat tiles.

import type { ClaudeStats, DayStat, History, SpendBucket, StatsChart, StatsRange, StatsView } from '../types'

export const VIEWS: StatsView[] = ['overview', 'tokens', 'cost', 'cache', 'inout']
export const RANGES: StatsRange[] = ['session', '7d', '30d', 'all']
export const VIEW_LABEL: Record<StatsView, string> = {
  overview: 'Overview', tokens: 'Tokens', cost: 'Cost', cache: 'Cache', inout: 'In / Out',
}
export const RANGE_LABEL: Record<StatsRange, string> = {
  session: 'Session', '7d': '7 days', '30d': '30 days', all: 'All time',
}
// Each tab keeps its own colour: the thin rule under it at rest, a bold bar when chosen, and the
// chart drawn in the chosen view's colour.
export const VIEW_HUE: Record<StatsView, string> = {
  overview: '#fb923c', tokens: '#93c5fd', cost: '#4ade80', cache: '#22d3ee', inout: '#c084fc',
}
export const RANGE_HUE: Record<StatsRange, string> = {
  session: '#f472b6', '7d': '#34d399', '30d': '#60a5fa', all: '#c084fc',
}
export const TAB_GAP = 2
export const CHARTS: StatsChart[] = ['line', 'area', 'bars', 'dots']
export const CHART_LABEL: Record<StatsChart, string> = { line: 'Line', area: 'Area', bars: 'Bars', dots: 'Dots' }
export const CHART_HUE: Record<StatsChart, string> = { line: '#93c5fd', area: '#2dd4bf', bars: '#fb923c', dots: '#f472b6' }

export const emptyDay = (): DayStat => ({
  usd: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: 0, models: {},
})
export const emptyHistory = (): History => ({ days: {}, sessions: 0, longestSessionMs: 0, firstSeen: null })

// The local calendar day a moment falls on, as YYYY-MM-DD.
export const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const DAY_MS = 86_400_000

export const addToDay = (history: History, at: number, change: (d: DayStat) => DayStat): History => {
  const key = dayKey(at)
  return { ...history, days: { ...history.days, [key]: change(history.days[key] ?? emptyDay()) } }
}

export const compact = (n: number) => {
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}b`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}m`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return `${Math.round(n)}`
}

// The days a range covers, oldest first, filled with empty days where nothing happened.
export const daysIn = (history: History, range: StatsRange, now: number): Array<[string, DayStat]> => {
  const keys = Object.keys(history.days).sort()
  const span = range === '7d' ? 7 : range === '30d' ? 30 : null
  const firstKey = span ? dayKey(now - (span - 1) * DAY_MS) : keys[0] ?? dayKey(now)
  const out: Array<[string, DayStat]> = []
  for (let t = Date.parse(`${firstKey}T12:00:00`); dayKey(t) <= dayKey(now); t += DAY_MS) {
    const key = dayKey(t)
    out.push([key, history.days[key] ?? emptyDay()])
    if (out.length > 400) break
  }
  return out
}

type Point = { label: string; usd: number; input: number; output: number; cacheRead: number; cacheWrite: number }

const fromDay = (key: string, d: DayStat, model: string | null): Point => {
  const m = model ? d.models[model] : null
  const src = model ? m ?? { usd: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : d
  return { label: key.slice(5), usd: src.usd, input: src.input, output: src.output, cacheRead: src.cacheRead, cacheWrite: src.cacheWrite }
}

const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// The points a view charts: five-minute slices for this session, days otherwise.
export const pointsFor = (range: StatsRange, buckets: SpendBucket[], history: History, model: string | null, now: number): Point[] => {
  if (range === 'session') {
    return buckets.map(b => ({
      label: hhmm(b.start), usd: b.usd, input: b.inputTokens, output: b.outputTokens,
      cacheRead: b.cacheReadTokens, cacheWrite: 0,
    }))
  }
  return daysIn(history, range, now).map(([key, d]) => fromDay(key, d, model))
}

export type Series = { name: string; hue: string; values: number[] }

export const seriesFor = (view: StatsView, points: Point[]): Series[] => {
  switch (view) {
    case 'cost':
      return [{ name: 'cost', hue: VIEW_HUE.cost, values: points.map(p => p.usd) }]
    case 'cache':
      return [{
        name: 'read from cache',
        hue: VIEW_HUE.cache,
        values: points.map(p => (p.input > 0 ? (p.cacheRead / p.input) * 100 : Number.NaN)),
      }]
    case 'inout':
      return [
        { name: 'in', hue: '#60a5fa', values: points.map(p => p.input) },
        { name: 'out', hue: '#fb923c', values: points.map(p => p.output) },
      ]
    default:
      return [{ name: 'tokens', hue: VIEW_HUE.tokens, values: points.map(p => p.input + p.output) }]
  }
}

// Fit `values` to `width` columns: shorter series are kept, longer ones averaged into buckets.
export const resample = (values: number[], width: number) => {
  if (values.length <= width) return values
  const out: number[] = []
  for (let i = 0; i < width; i += 1) {
    const from = Math.floor((i * values.length) / width)
    const to = Math.max(from + 1, Math.floor(((i + 1) * values.length) / width))
    const slice = values.slice(from, to).filter(Number.isFinite)
    out.push(slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : Number.NaN)
  }
  return out
}

// Spread `values` across exactly `width` columns: each point holds its share of the width,
// so 30 days fill the chart rather than its left half. Longer series are averaged down.
export const stretch = (values: number[], width: number) => {
  if (values.length === 0) return Array(width).fill(0)
  if (values.length >= width) return resample(values, width)
  return Array.from({ length: width }, (_, i) => values[Math.min(values.length - 1, Math.floor((i * values.length) / width))]!)
}

// Spread `values` across `width` columns joining neighbouring points with straight slopes, so a
// rise between two days climbs across the columns between them instead of jumping in one. A gap
// stays a gap. Longer series are averaged down first.
export const interpolate = (values: number[], width: number) => {
  if (values.length === 0) return Array(width).fill(0)
  if (values.length >= width) return resample(values, width)
  if (values.length === 1) return Array(width).fill(values[0]!)
  return Array.from({ length: width }, (_, x) => {
    const at = (x * (values.length - 1)) / (width - 1)
    const i = Math.floor(at)
    const a = values[i]!
    const b = values[Math.min(values.length - 1, i + 1)]!
    if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.isFinite(a) && at - i < 0.5 ? a : Number.isFinite(b) && at - i >= 0.5 ? b : Number.NaN
    return a + (b - a) * (at - i)
  })
}

// One continuous line in box-drawing characters, the way /usage draws it: flat runs as ─,
// rises and falls as rounded corners joined by │. `height` rows, top first.
export const lineChart = (values: number[], width: number, height: number, max = Math.max(...values.filter(Number.isFinite), 0)) => {
  const pts = interpolate(values, width)
  const top = height - 1
  const rowOf = (v: number) => (max > 0 ? Math.max(0, Math.min(top, Math.round((v / max) * top))) : 0)
  const grid: string[][] = Array.from({ length: height }, () => Array(width).fill(' '))
  const put = (level: number, x: number, ch: string) => {
    grid[top - level]![x] = ch
  }
  for (let x = 0; x < width; x += 1) {
    // No data here (a day with no requests on a ratio view): leave the column empty.
    if (!Number.isFinite(pts[x]!)) continue
    const y0 = rowOf(pts[x]!)
    const nextKnown = x + 1 < width && Number.isFinite(pts[x + 1]!)
    const y1 = nextKnown ? rowOf(pts[x + 1]!) : y0
    if (y0 === y1) {
      put(y0, x, '─')
      continue
    }
    // Leaving y0 at this column, arriving at y1 in the same column, the run between as │.
    put(y0, x, y1 > y0 ? '╯' : '╮')
    put(y1, x, y1 > y0 ? '╭' : '╰')
    for (let k = Math.min(y0, y1) + 1; k < Math.max(y0, y1); k += 1) put(k, x, '│')
  }
  return grid.map(row => row.join(''))
}

const EIGHTHS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

// The level of each column in eighths of a row, or -1 for a gap.
const eighthsOf = (pts: number[], height: number, max: number) =>
  pts.map(v => (!Number.isFinite(v) ? -1 : max > 0 ? Math.round((Math.max(0, v) / max) * height * 8) : 0))

// Filled under the curve, its top edge smoothed to an eighth of a row. Rows top first.
export const areaChart = (values: number[], width: number, height: number, max = Math.max(...values.filter(Number.isFinite), 0)) => {
  const levels = eighthsOf(interpolate(values, width), height, max)
  const rows: string[] = []
  for (let row = height - 1; row >= 0; row -= 1) {
    rows.push(levels.map(l => (l < 0 ? ' ' : l - row * 8 >= 8 ? '█' : l - row * 8 <= 0 ? (row === 0 ? '▁' : ' ') : EIGHTHS[l - row * 8]!)).join(''))
  }
  return rows
}

// One bar per point with a gap between, as wide as the room allows. Rows top first.
export const barChart = (values: number[], width: number, height: number, max = Math.max(...values.filter(Number.isFinite), 0)) => {
  if (values.length === 0) return Array(height).fill(' '.repeat(width))
  const pts = values.length > width ? resample(values, Math.floor(width / 2)) : values
  const slot = Math.max(1, Math.floor(width / pts.length))
  const barWidth = slot >= 3 ? slot - 1 : slot
  const levels = eighthsOf(pts, height, max)
  const rows: string[] = []
  for (let row = height - 1; row >= 0; row -= 1) {
    let line = ''
    for (const l of levels) {
      const fill = l - row * 8
      const ch = l < 0 ? ' ' : fill >= 8 ? '█' : fill <= 0 ? ' ' : EIGHTHS[fill]!
      line += ch.repeat(barWidth) + ' '.repeat(slot - barWidth)
    }
    rows.push(line.padEnd(width).slice(0, width))
  }
  return rows
}

// A point per column in braille, two across and four down per cell, nothing joining them.
const DOT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]] as const
export const dotChart = (values: number[], width: number, height: number, max = Math.max(...values.filter(Number.isFinite), 0)) => {
  const pts = stretch(values, width * 2)
  const levels = height * 4
  const grid: number[][] = Array.from({ length: height }, () => Array(width).fill(0))
  pts.forEach((v, x) => {
    if (!Number.isFinite(v)) return
    const y = max > 0 ? Math.min(levels - 1, Math.round((Math.max(0, v) / max) * (levels - 1))) : 0
    const row = height - 1 - Math.floor(y / 4)
    grid[row]![Math.floor(x / 2)]! |= DOT[3 - (y % 4)]![x % 2]!
  })
  return grid.map(r => r.map(bits => String.fromCharCode(0x2800 + bits)).join(''))
}

// Which point each column of a chart shows, so a column can be coloured by that point's change.
export const columnPoints = (style: StatsChart, count: number, width: number) => {
  if (count === 0) return Array(width).fill(-1)
  if (style === 'bars') {
    const n = count > width ? Math.floor(width / 2) : count
    const slot = Math.max(1, Math.floor(width / n))
    return Array.from({ length: width }, (_, x) => Math.min(count - 1, Math.floor((Math.floor(x / slot) * count) / n)))
  }
  return Array.from({ length: width }, (_, x) => Math.min(count - 1, Math.floor((x * count) / width)))
}

export type Trend = 'up' | 'down' | 'flat'
// A point's change from the last point that had data; a gap or the first point is flat.
export const trendOf = (values: number[], i: number): Trend => {
  const v = values[i]
  if (v === undefined || !Number.isFinite(v)) return 'flat'
  for (let j = i - 1; j >= 0; j -= 1) {
    const prev = values[j]!
    if (!Number.isFinite(prev)) continue
    const delta = v - prev
    const scale = Math.max(Math.abs(prev), Math.abs(v), 1e-9)
    return Math.abs(delta) / scale < 0.02 ? 'flat' : delta > 0 ? 'up' : 'down'
  }
  return 'flat'
}

// Rising and falling colours per view: more spend is warm and less is cool; for the cache, more
// read from cache is good (green) and less is a slip (deep orange).
export const TREND_HUE: Record<StatsView, { up: string; down: string }> = {
  overview: { up: '#fb923c', down: '#60a5fa' },
  tokens: { up: '#fb923c', down: '#60a5fa' },
  cost: { up: '#fb923c', down: '#60a5fa' },
  inout: { up: '#fb923c', down: '#60a5fa' },
  cache: { up: '#22c55e', down: '#f97316' },
}

// A row split into runs of one colour, ready to draw as Text spans.
export const colourRuns = (row: string, hues: string[]) => {
  const runs: Array<{ text: string; hue: string }> = []
  const chars = Array.from(row)
  chars.forEach((ch, x) => {
    const hue = hues[x] ?? hues[hues.length - 1] ?? ''
    const last = runs[runs.length - 1]
    if (last && last.hue === hue) last.text += ch
    else runs.push({ text: ch, hue })
  })
  return runs
}

export const drawChart = (style: StatsChart, values: number[], width: number, height: number, max: number) =>
  style === 'area' ? areaChart(values, width, height, max)
    : style === 'bars' ? barChart(values, width, height, max)
      : style === 'dots' ? dotChart(values, width, height, max)
        : lineChart(values, width, height, max)

// GitHub-style activity: 7 rows (Mon to Sun) by `weeks` columns, each day shaded by tokens.
export const SHADES = ['·', '░', '▒', '▓', '█'] as const
export const heatmap = (history: History, now: number, weeks: number) => {
  const today = new Date(now)
  const mondayOffset = (today.getDay() + 6) % 7
  const lastMonday = now - mondayOffset * DAY_MS
  const start = lastMonday - (weeks - 1) * 7 * DAY_MS
  const values: number[][] = Array.from({ length: 7 }, () => Array(weeks).fill(-1))
  let max = 0
  for (let w = 0; w < weeks; w += 1) {
    for (let d = 0; d < 7; d += 1) {
      const t = start + (w * 7 + d) * DAY_MS
      if (t > now) continue
      const day = history.days[dayKey(t)]
      const v = day ? day.input + day.output : 0
      values[d]![w] = v
      if (v > max) max = v
    }
  }
  const level = (v: number) => (v < 0 ? -1 : v === 0 ? 0 : Math.max(1, Math.min(4, Math.ceil((v / max) * 4))))
  const months: string[] = []
  let lastMonth = -1
  for (let w = 0; w < weeks; w += 1) {
    const m = new Date(start + w * 7 * DAY_MS).getMonth()
    months.push(m !== lastMonth ? 'JFMAMJJASOND'[m]! : ' ')
    lastMonth = m
  }
  return { levels: values.map(row => row.map(level)), months: months.join('') }
}

export const LEVEL_HUE = ['#334155', '#7c2d12', '#c2410c', '#f97316', '#fdba74'] as const

// Headline figures for a range, as the /usage stats screen lists them.
export const tilesFor = (history: History, range: StatsRange, now: number, sessionDay: DayStat | null) => {
  const days = range === 'session' ? (sessionDay ? [[dayKey(now), sessionDay] as [string, DayStat]] : []) : daysIn(history, range, now)
  const total = days.reduce(
    (t, [, d]) => ({
      usd: t.usd + d.usd, requests: t.requests + d.requests, input: t.input + d.input, output: t.output + d.output,
      cacheRead: t.cacheRead + d.cacheRead, cacheWrite: t.cacheWrite + d.cacheWrite, sessions: t.sessions + d.sessions,
    }),
    { usd: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: 0 },
  )
  const byModel: Record<string, number> = {}
  for (const [, d] of days) for (const [id, m] of Object.entries(d.models)) byModel[id] = (byModel[id] ?? 0) + m.input + m.output
  const favorite = Object.entries(byModel).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const active = days.filter(([, d]) => d.requests > 0)
  const busiest = [...active].sort((a, b) => b[1].input + b[1].output - (a[1].input + a[1].output))[0]?.[0] ?? null

  // Streaks over every day ever recorded, ending today for the current one.
  const all = daysIn(history, 'all', now)
  let longest = 0
  let run = 0
  for (const [, d] of all) {
    run = d.requests > 0 ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  let current = 0
  for (let i = all.length - 1; i >= 0 && all[i]![1].requests > 0; i -= 1) current += 1

  return {
    total,
    favorite,
    activeDays: active.length,
    spanDays: days.length,
    busiest,
    longestStreak: longest,
    currentStreak: current,
    longestSessionMs: history.longestSessionMs,
  }
}

// One line of perspective on the token count, like the /usage screen's.
export const funFact = (tokens: number) => {
  const novels = tokens / 750_000 // roughly War and Peace, in tokens
  if (novels >= 2) return `That is about ${Math.round(novels).toLocaleString()} copies of War and Peace.`
  const pages = tokens / 500
  if (pages >= 1) return `That is about ${Math.round(pages).toLocaleString()} printed pages of text.`
  return 'Quiet so far.'
}

export const durationText = (ms: number) => {
  const m = Math.floor(ms / 60_000)
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return d > 0 ? `${d}d ${h}h ${m % 60}m` : h > 0 ? `${h}h ${m % 60}m` : `${m}m`
}


// ── Claude Code's own history ───────────────────────────────────────────────────────────────

// Parse ~/.claude/stats-cache.json into the shape the charts use. Unknown shapes give null.
export const parseClaudeStats = (text: string): ClaudeStats | null => {
  try {
    const raw = JSON.parse(text)
    const days: ClaudeStats['days'] = {}
    for (const row of raw.dailyModelTokens ?? []) {
      if (!row?.date) continue
      days[row.date] = { tokensByModel: row.tokensByModel ?? {}, messages: 0, sessions: 0, toolCalls: 0 }
    }
    for (const row of raw.dailyActivity ?? []) {
      if (!row?.date) continue
      const day = days[row.date] ?? { tokensByModel: {}, messages: 0, sessions: 0, toolCalls: 0 }
      days[row.date] = { ...day, messages: row.messageCount ?? 0, sessions: row.sessionCount ?? 0, toolCalls: row.toolCallCount ?? 0 }
    }
    const models: ClaudeStats['models'] = {}
    for (const [id, m] of Object.entries(raw.modelUsage ?? {}) as Array<[string, any]>) {
      models[id] = {
        input: m.inputTokens ?? 0, output: m.outputTokens ?? 0,
        cacheRead: m.cacheReadInputTokens ?? 0, cacheWrite: m.cacheCreationInputTokens ?? 0,
      }
    }
    const hours = Array(24).fill(0)
    for (const [h, n] of Object.entries(raw.hourCounts ?? {})) hours[Number(h)] = Number(n) || 0
    return {
      days,
      models,
      totalSessions: raw.totalSessions ?? 0,
      longestSessionMs: raw.longestSession?.duration ?? 0,
      firstSessionDate: raw.firstSessionDate ?? null,
      hourCounts: hours,
      computedOn: raw.lastComputedDate ?? null,
      recordsCost: Object.values(raw.modelUsage ?? {}).some((m: any) => (m?.costUSD ?? 0) > 0),
    }
  } catch {
    return null
  }
}

// Anthropic list prices per million tokens: input, output, cache read. A cache write is 1.25x
// input (the 5-minute cache, Claude Code's default before promptCacheTtl). Most specific first.
// Organisation-negotiated rates are not known here, so these are list-price figures.
export const PRICES: Array<[RegExp, { input: number; output: number; cacheRead: number }]> = [
  [/fable-5-1|mythos-5-1/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/fable-5|mythos-5/, { input: 10, output: 50, cacheRead: 1 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus-5|opus-4-[5-8]/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/opus-4/, { input: 15, output: 75, cacheRead: 1.5 }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/sonnet-4|sonnet-3/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/haiku-5/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  [/haiku-4/, { input: 1, output: 5, cacheRead: 0.1 }],
  [/haiku-3/, { input: 0.8, output: 4, cacheRead: 0.08 }],
]
export const priceOf = (model: string) => PRICES.find(([test]) => test.test(model))?.[1] ?? null

// Dollars for a split of tokens at a model's list price; null for a model with no known price.
export const listCost = (model: string, t: { input: number; output: number; cacheRead: number; cacheWrite: number }) => {
  const p = priceOf(model)
  if (!p) return null
  const fresh = Math.max(0, t.input - t.cacheRead - t.cacheWrite)
  return (fresh * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.input * 1.25) / 1_000_000
}

// A past day from Claude Code's file, split into input, output and cache by that model's all-time
// ratios (the file keeps only a daily total per model) and priced at that model's list price.
// Marked estimated.
export const dayFromClaude = (day: ClaudeStats['days'][string], models: ClaudeStats['models']): DayStat => {
  const out: DayStat = { ...emptyDay(), sessions: day.sessions, requests: day.messages, estimated: true }
  for (const [id, total] of Object.entries(day.tokensByModel)) {
    const m = models[id]
    const all = m ? m.input + m.output + m.cacheRead + m.cacheWrite : 0
    const share = (part: number) => (all > 0 ? (total * part) / all : 0)
    const input = m ? share(m.input) + share(m.cacheRead) + share(m.cacheWrite) : total
    const output = m ? share(m.output) : 0
    const cacheRead = m ? share(m.cacheRead) : 0
    const cacheWrite = m ? share(m.cacheWrite) : 0
    const usd = listCost(id, { input, output, cacheRead, cacheWrite }) ?? 0
    out.models[id] = { usd, requests: 0, input, output, cacheRead, cacheWrite }
    out.input += input
    out.output += output
    out.cacheRead += cacheRead
    out.cacheWrite += cacheWrite
    out.usd += usd
  }
  return out
}

// Our own days win (they are exact); every other day comes from Claude Code's file.
export const mergeHistory = (history: History, claude: ClaudeStats | null): History => {
  if (!claude) return history
  const days = { ...history.days }
  for (const [key, day] of Object.entries(claude.days)) {
    if (!days[key]) days[key] = dayFromClaude(day, claude.models)
  }
  return {
    ...history,
    days,
    sessions: Math.max(history.sessions, claude.totalSessions),
    longestSessionMs: Math.max(history.longestSessionMs, claude.longestSessionMs),
    firstSeen: claude.firstSessionDate ? Math.min(Date.parse(claude.firstSessionDate), history.firstSeen ?? Infinity) : history.firstSeen,
  }
}
