// The STATS dashboard: pure helpers for the history the mod keeps across sessions, the series
// each view charts, a braille line chart, a day heatmap and the stat tiles.

import type { DayStat, History, SpendBucket, StatsRange, StatsView } from '../types'

export const VIEWS: StatsView[] = ['overview', 'tokens', 'cost', 'cache', 'inout']
export const RANGES: StatsRange[] = ['session', '7d', '30d', 'all']
export const VIEW_LABEL: Record<StatsView, string> = {
  overview: 'Overview', tokens: 'Tokens', cost: 'Cost', cache: 'Cache', inout: 'In / Out',
}
export const RANGE_LABEL: Record<StatsRange, string> = {
  session: 'This session', '7d': 'Last 7 days', '30d': 'Last 30 days', all: 'All time',
}

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
      return [{ name: 'cost', hue: '#4ade80', values: points.map(p => p.usd) }]
    case 'cache':
      return [{
        name: 'read from cache',
        hue: '#22d3ee',
        values: points.map(p => (p.input > 0 ? (p.cacheRead / p.input) * 100 : 0)),
      }]
    case 'inout':
      return [
        { name: 'in', hue: '#60a5fa', values: points.map(p => p.input) },
        { name: 'out', hue: '#fb923c', values: points.map(p => p.output) },
      ]
    default:
      return [{ name: 'tokens', hue: '#93c5fd', values: points.map(p => p.input + p.output) }]
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

// A line chart in braille: each cell holds 2 x 4 dots, so `width` cells plot 2 x width points
// and `height` rows give 4 x height levels. Rows top first.
const BRAILLE = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]] as const
export const brailleLine = (values: number[], width: number, height: number, max = Math.max(...values, 0)) => {
  const cols = width * 2
  const pts = resample(values, cols)
  const levels = height * 4
  const grid: number[][] = Array.from({ length: height }, () => Array(width).fill(0))
  const yOf = (v: number) => (max > 0 ? Math.min(levels - 1, Math.round((v / max) * (levels - 1))) : 0)
  const plot = (x: number, y: number) => {
    const row = height - 1 - Math.floor(y / 4)
    const dotRow = 3 - (y % 4)
    const cell = Math.floor(x / 2)
    if (row >= 0 && row < height && cell < width) grid[row]![cell]! |= BRAILLE[dotRow]![x % 2]!
  }
  pts.forEach((v, x) => {
    const y = yOf(v)
    plot(x, y)
    // Join to the previous point with a vertical run so the line reads as one stroke.
    if (x > 0) {
      const prev = yOf(pts[x - 1]!)
      for (let k = Math.min(prev, y) + 1; k < Math.max(prev, y); k += 1) plot(x, k)
    }
  })
  return grid.map(row => row.map(bits => String.fromCharCode(0x2800 + bits)).join(''))
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
