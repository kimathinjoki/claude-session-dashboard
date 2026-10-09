import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheReading } from '../types'

const initial: CacheReading = {
  lastRequestAt: null, cachedTokens: 0, ttlMinutes: 60, keepWarm: false, pings: 0, lastPingAt: null,
  history: [], readTokens: 0, writtenTokens: 0, coldStarts: 0,
  rewrittenTokens: 0, pingReadTokens: 0, weightedAll: 0, sessionUsd: null, usdBaseline: null, mainModel: '',
}
const reading = atom({ plugin: 'cache-tax', key: 'reading' } as const, initial)
const tick = atom({ plugin: 'cache-tax', key: 'tick' } as const, 0)

const PANE = 'cache'

// State saved by an earlier version of this mod may lack fields added since; fill them in.
async function readReading($: EngineInterface): Promise<CacheReading> {
  return { ...initial, ...(await read($, reading)) }
}
// Anthropic's published multipliers on the base input price: a cache write costs 1.25x
// (2x for the one-hour cache), a cache read 0.1x. A cold prefix is re-written, not read.
const READ = 0.1
const writeMultiplier = (ttlMinutes: number) => (ttlMinutes >= 60 ? 2 : 1.25)
const MARGIN_MS = 60_000
const TICK_MS = 15_000
const HISTORY = 24
const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

// Relative list prices by model family, as the Spend panel uses them.
const MODEL_FACTOR: Array<[RegExp, number]> = [[/opus/i, 5], [/sonnet/i, 3], [/haiku/i, 1], [/fable/i, 5]]
export const modelFactor = (model: string) => MODEL_FACTOR.find(([test]) => test.test(model))?.[1] ?? 3

// A request in units of "base input tokens", so /cost divided by the sum prices one.
export const weightOf = (
  u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number },
  model: string,
  ttlMinutes: number,
) =>
  (u.input_tokens + writeMultiplier(ttlMinutes) * u.cache_creation_input_tokens + READ * u.cache_read_input_tokens + 5 * u.output_tokens) *
  modelFactor(model)

// The main thread's base input price per token, estimated from what the session actually cost.
// Below this many weighted units the estimate is noise, and the panel says it is calibrating.
export const MIN_WEIGHT = 200_000

export const basePrice = (r: Pick<CacheReading, 'sessionUsd' | 'usdBaseline' | 'weightedAll' | 'mainModel'>) => {
  if (r.sessionUsd == null || r.usdBaseline == null || r.weightedAll < MIN_WEIGHT) return null
  const spent = r.sessionUsd - r.usdBaseline
  return spent > 0 ? (spent / r.weightedAll) * modelFactor(r.mainModel || 'opus') : null
}

export type CacheCosts = { spent: number; saved: number; coldTax: number; pings: number; ifColdNow: number }

export const cacheCosts = (r: CacheReading): CacheCosts | null => {
  const base = basePrice(r)
  if (base === null) return null
  const write = writeMultiplier(r.ttlMinutes)
  return {
    spent: (r.writtenTokens * write + r.readTokens * READ) * base,
    saved: r.readTokens * (1 - READ) * base,
    coldTax: r.rewrittenTokens * (write - READ) * base,
    pings: r.pingReadTokens * READ * base,
    ifColdNow: r.cachedTokens * (write - READ) * base,
  }
}

export const money = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `${Math.max(0, Math.round(n * 100))}¢`)

export const tokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

export const remainingMs = (r: CacheReading, now: number) =>
  r.lastRequestAt === null ? null : r.lastRequestAt + r.ttlMinutes * 60_000 - now

export const coldFactor = (ttlMinutes: number) => Math.round((writeMultiplier(ttlMinutes) / READ) * 10) / 10

export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const sparkline = (values: number[]) =>
  values.map(v => SPARK[Math.max(0, Math.min(SPARK.length - 1, Math.round(v * (SPARK.length - 1))))]).join('')

// Warm, fading (under a quarter of the window), or cold.
export const mood = (r: CacheReading, now: number) => {
  const left = remainingMs(r, now)
  if (left === null || r.cachedTokens === 0) return 'empty' as const
  if (left <= 0) return 'cold' as const
  return left < r.ttlMinutes * 60_000 * 0.25 ? ('fading' as const) : ('warm' as const)
}

export const statusText = (r: CacheReading, now: number) => {
  const left = remainingMs(r, now)
  if (left === null || r.cachedTokens === 0) return undefined
  const warmth = r.keepWarm ? ', kept warm' : ''
  if (left > 0) return `cache warm ${clock(left)} left (${tokens(r.cachedTokens)})${warmth}`
  return `cache cold: next prompt re-writes ${tokens(r.cachedTokens)} tokens`
}

let pinging = false

// A fork re-sends the main thread's own prefix, so a warm entry is read (and its clock
// restarted) at the read price. Nothing is added to the conversation.
async function ping($: EngineInterface): Promise<string> {
  pinging = true
  try {
    const reply = await $.model.fork({ prompt: 'Reply with the single word: ok' })
    if (!reply.isAnswered) {
      return reply.reason === 'nothing-to-fork' ? 'Nothing cached yet: no response in this session.' : `The ping did not go through (${reply.reason}).`
    }
    const now = await $.clock.now()
    const readBack = reply.usage.cache_read_input_tokens
    await update($, reading, r => ({ ...initial, ...r, lastRequestAt: now, lastPingAt: now, pings: r.pings + 1, pingReadTokens: (r.pingReadTokens ?? 0) + readBack }))
    return readBack > 0 ? `Cache pinged: ${tokens(readBack)} tokens read, window restarted.` : 'The cache had already lapsed; the ping re-wrote it.'
  } finally {
    pinging = false
  }
}

async function toggleKeepWarm($: EngineInterface): Promise<CacheReading> {
  return update($, reading, current => ({ ...initial, ...current, keepWarm: !current.keepWarm }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The window Claude Code actually asks for: an explicit /keepwarm ttl wins, then the
    // promptCacheTtl setting. Never a value remembered from an earlier version of this mod.
    const saved = await $.store.get('ttlMinutes')
    const settings = (await $.settings.read()) as { promptCacheTtl?: string }
    const ttlMinutes = typeof saved === 'number' ? saved : settings.promptCacheTtl === '5m' ? 5 : 60
    await update($, reading, r => ({ ...initial, ...r, ttlMinutes }))

    await $.command.register({
      name: 'keepwarm',
      description: 'Prompt cache: /keepwarm toggles keep-warm, /keepwarm now pings, /keepwarm ttl 5|60, /keepwarm panel opens the Cache panel',
    })
    void $.ui.open({ id: PANE, title: 'Cache' })

    $.clock.every(1000, () => void update($, tick, n => n + 1))
    $.clock.every(TICK_MS, async () => {
      const now = await $.clock.now()
      const usage = await $.session.usage()
      const usd = usage.cost?.usd ?? null
      await update($, reading, saved => {
        const r = { ...initial, ...saved }
        // Start (or restart, after an older version) the measured stretch here: weights so far
        // were counted against an unknown share of the cost, so they are dropped.
        if (usd !== null && r.usdBaseline === null) return { ...r, sessionUsd: usd, usdBaseline: usd, weightedAll: 0 }
        return { ...r, sessionUsd: usd }
      })
      const r = await readReading($)
      $.ui.status(statusText(r, now))

      const left = remainingMs(r, now)
      if (r.keepWarm && !pinging && left !== null && left > 0 && left < MARGIN_MS + TICK_MS) {
        await ping($)
      }
    })

    return next(e)
  })

  // The main thread's requests decide what is cached; a sub-agent's have their own prefix.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (!result.usage) return result

    const u = result.usage
    const model = u.model || e.model
    if (e.agentId) {
      await update($, reading, saved => {
        const r = { ...initial, ...saved }
        return { ...r, weightedAll: r.weightedAll + weightOf(u, model, 5) }
      })
      return result
    }

    const cached = u.cache_read_input_tokens + u.cache_creation_input_tokens
    const total = cached + u.input_tokens
    const share = total > 0 ? u.cache_read_input_tokens / total : 0
    const now = await $.clock.now()
    await update($, reading, saved => {
      const r = { ...initial, ...saved }
      const isCold = r.cachedTokens > 20_000 && u.cache_creation_input_tokens > r.cachedTokens * 0.5
      return {
      ...r,
      lastRequestAt: now,
      cachedTokens: cached || r.cachedTokens,
      history: [...r.history, share].slice(-HISTORY),
      readTokens: r.readTokens + u.cache_read_input_tokens,
      writtenTokens: r.writtenTokens + u.cache_creation_input_tokens,
      weightedAll: r.weightedAll + weightOf(u, model, r.ttlMinutes),
      mainModel: model || r.mainModel,
      // A request that re-wrote most of a large prefix it should have read is a cold start.
      coldStarts: r.coldStarts + (isCold ? 1 : 0),
      rewrittenTokens: r.rewrittenTokens + (isCold ? u.cache_creation_input_tokens : 0),
      }
    })
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const r = await readReading($)
    const left = remainingMs(r, await $.clock.now())
    if (left !== null && left <= 0 && r.cachedTokens > 0) {
      $.ui.toast(
        `Cache is cold: this prompt re-writes about ${tokens(r.cachedTokens)} tokens, ` +
          `${coldFactor(r.ttlMinutes)}x what reading them warm would cost. /keepwarm stops this.`,
        { timeoutMs: 8000 },
      )
    }
    return next(e)
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const [word, value] = e.args.trim().split(/\s+/)

    if (word === 'panel') {
      await $.ui.open({ id: PANE, title: 'Cache', focus: true })
      return { text: 'Cache panel open.' }
    }
    if (word === 'ttl') {
      const minutes = Number(value)
      if (minutes !== 5 && minutes !== 60) return { text: 'The cache window is 5 or 60 minutes: /keepwarm ttl 5 or /keepwarm ttl 60.' }
      await $.store.set('ttlMinutes', minutes)
      await update($, reading, r => ({ ...initial, ...r, ttlMinutes: minutes }))
      return { text: `Cache window set to ${minutes} minutes.` }
    }
    if (word === 'now') return { text: await ping($) }

    const r = await toggleKeepWarm($)
    return {
      text: r.keepWarm
        ? `Keeping the cache warm: a one-line ping ${MARGIN_MS / 1000}s before each ${r.ttlMinutes}-minute window ends. Each ping reads the cache at ${READ}x.`
        : 'Stopped keeping the cache warm.',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const r = await readReading($)
    await read($, tick)
    const now = await $.clock.now()
    const width = Math.max(24, (e.props.bodyColumns ?? 40) - 2)
    const gaugeWidth = Math.max(10, width - 16)
    const state = mood(r, now)
    const left = remainingMs(r, now) ?? 0
    const windowMs = r.ttlMinutes * 60_000
    const share = state === 'cold' || state === 'empty' ? 0 : left / windowMs
    const hue = { warm: '#22c55e', fading: '#f97316', cold: '#ef4444', empty: '#64748b' }[state]
    const label = { warm: '● WARM', fading: '◐ FADING', cold: '○ COLD', empty: '· EMPTY' }[state]
    const filled = Math.round(share * gaugeWidth)
    const hitRate = r.readTokens + r.writtenTokens > 0 ? r.readTokens / (r.readTokens + r.writtenTokens) : 0
    // Reading a token warm costs a tenth of full input: everything read is 90% saved.
    const savedFull = Math.round(r.readTokens * (1 - READ))

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text bold color="#22d3ee">❄ PROMPT CACHE</Text>
          <Text bold color={hue} inverse={state === 'cold'}> {label} </Text>
        </Box>
        <Text dimColor>{'─'.repeat(width)}</Text>

        {state === 'empty' ? (
          <Text dimColor>Nothing cached yet. The gauge starts with the first response.</Text>
        ) : (
          <Box flexDirection="column">
            <Text>
              <Text color={hue}>{'▰'.repeat(filled)}</Text>
              <Text dimColor>{'▱'.repeat(gaugeWidth - filled)}</Text>
              <Text bold color={hue}> {state === 'cold' ? 'lapsed' : clock(left)}</Text>
            </Text>
            <Text dimColor>
              {tokens(r.cachedTokens)} tokens held  ·  {r.ttlMinutes === 60 ? '1 hour' : '5 minute'} window
            </Text>
            {state === 'fading' && (
              <Text color="#f97316">⚠ under a quarter of the window left. /keepwarm now keeps it.</Text>
            )}
            {state === 'cold' && (
              <Text color="#ef4444">✗ your next prompt re-writes {tokens(r.cachedTokens)} tokens, {coldFactor(r.ttlMinutes)}x a warm read.</Text>
            )}
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text dimColor>hits     </Text>
            <Text color={hitRate >= 0.8 ? '#22c55e' : hitRate >= 0.5 ? '#f97316' : '#ef4444'}>{sparkline(r.history) || '·'}</Text>
            <Text bold> {Math.round(hitRate * 100)}%</Text>
            <Text dimColor> read from cache</Text>
          </Text>
          <Text>
            <Text dimColor>saved    </Text>
            <Text color="#4ade80" bold>{tokens(savedFull)}</Text>
            <Text dimColor> full-price input tokens</Text>
          </Text>
          {r.coldStarts > 0 && (
            <Text color="#f97316">⚠ {r.coldStarts} cold {r.coldStarts === 1 ? 'start' : 'starts'} this session</Text>
          )}
        </Box>

        {(() => {
          const c = cacheCosts(r)
          if (!c) return <Text dimColor>{'\n'}COST: calibrating against /cost, a few more requests needed.</Text>
          const row = (label: string, value: string, hue: string, note?: string) => (
            <Text key={label}>
              <Text dimColor>{label.padEnd(18)}</Text>
              <Text bold color={hue}>{value.padStart(7)}</Text>
              {note ? <Text dimColor>  {note}</Text> : null}
            </Text>
          )
          return (
            <Box flexDirection="column" marginTop={1}>
              <Text bold dimColor>COST (est.)</Text>
              {row('caching this run', money(c.spent), '#22d3ee', `${tokens(r.writtenTokens)} written, ${tokens(r.readTokens)} read`)}
              {row('saved by reads', money(c.saved), '#4ade80', 'vs paying full input')}
              {row('cold-start tax', money(c.coldTax), c.coldTax > 0 ? '#f97316' : '#64748b', `${r.coldStarts} cold ${r.coldStarts === 1 ? 'start' : 'starts'}, ${tokens(r.rewrittenTokens)} re-written`)}
              {row('keep-warm pings', money(c.pings), '#93c5fd', `${r.pings} ${r.pings === 1 ? 'ping' : 'pings'}`)}
              {state !== 'empty' && row(state === 'cold' ? 'next prompt costs' : 'if it goes cold', `+${money(c.ifColdNow)}`, state === 'cold' ? '#ef4444' : '#f97316', `extra to re-write ${tokens(r.cachedTokens)}`)}
              {r.pings > 0 && c.ifColdNow > 0 && (
                <Text color="#4ade80">› each ping costs about {money((c.pings || 0) / Math.max(1, r.pings))}; a cold start about {money(c.ifColdNow)}</Text>
              )}
              <Text dimColor>priced from /cost with the published cache multipliers</Text>
            </Box>
          )
        })()}

        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text dimColor>keep warm </Text>
            <Text bold color={r.keepWarm ? '#22c55e' : '#64748b'}>{r.keepWarm ? 'ON' : 'off'}</Text>
            <Text dimColor>   pings {r.pings}{r.lastPingAt ? `, last ${clock(now - r.lastPingAt)} ago` : ''}</Text>
          </Text>
          <Box gap={1}>
            <Button key="toggle" hotkey="w" label={r.keepWarm ? 'Stop keeping warm' : 'Keep warm'} onPress={() => void toggleKeepWarm($)} />
            <Button key="ping" hotkey="p" label="Ping now" onPress={() => void ping($).then(text => $.ui.toast(text))} />
            <Button key="ttl" hotkey="t" label={r.ttlMinutes === 60 ? 'Window: 1h' : 'Window: 5m'} onPress={() => void $.command.run({ command: 'keepwarm', args: `ttl ${r.ttlMinutes === 60 ? 5 : 60}` })} />
          </Box>
        </Box>
      </Box>
    )
  })
}
