// The STATS dashboard: pure helpers for the history the mod keeps across sessions, the series
// each view charts, a braille line chart, a day heatmap and the stat tiles.

import type { DayStat, History, SpendBucket, StatsRange, StatsView } from '../types'

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
        values: points.map(p => (p.input > 0 ? (p.cacheRead / p.input) * 100 : 0)),
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
    const slice = values.slice(from, to)
    out.push(slice.reduce((a, b) => a + b, 0) / slice.length)
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

// One continuous line in box-drawing characters, the way /usage draws it: flat runs as ─,
// rises and falls as rounded corners joined by │. `height` rows, top first.
export const lineChart = (values: number[], width: number, height: number, max = Math.max(...values, 0)) => {
  const pts = stretch(values, width)
  const top = height - 1
  const rowOf = (v: number) => (max > 0 ? Math.max(0, Math.min(top, Math.round((v / max) * top))) : 0)
  const grid: string[][] = Array.from({ length: height }, () => Array(width).fill(' '))
  const put = (level: number, x: number, ch: string) => {
    grid[top - level]![x] = ch
  }
  for (let x = 0; x < width; x += 1) {
    const y0 = rowOf(pts[x]!)
    const y1 = x + 1 < width ? rowOf(pts[x + 1]!) : y0
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
