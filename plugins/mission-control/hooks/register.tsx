import { atom, read } from 'claude-code'
import type { Register } from 'claude-code'

// Read-only views of the three mods' state: any plugin reads any value, its owner alone writes it.
const agents = atom({ plugin: 'agent-progress', key: 'agents' } as const, [])
const crewTick = atom({ plugin: 'agent-progress', key: 'tick' } as const, 0)
const reading = atom({ plugin: 'cache-tax', key: 'reading' } as const, null as never)
const ledger = atom({ plugin: 'spend-ledger', key: 'ledger' } as const, null as never)

const PANE = 'mission-control'
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

type Role = { glyph: string; hue: string }
const ROLES: Array<[RegExp, Role]> = [
  [/re-?review|review|verify|audit|check/i, { glyph: '◉', hue: '#22d3ee' }],
  [/implement|build|fix|write|add|create/i, { glyph: '⚒', hue: '#fb923c' }],
  [/explore|map|find|search|survey|locate/i, { glyph: '⌖', hue: '#4ade80' }],
  [/plan|design|architect|spec/i, { glyph: '△', hue: '#a78bfa' }],
  [/guide|docs|setting|research/i, { glyph: '❖', hue: '#f472b6' }],
]
export const roleOf = (description: string, type: string): Role => {
  if (/explore/i.test(type)) return ROLES[2]![1]
  if (/guide/i.test(type)) return ROLES[4]![1]
  return ROLES.find(([test]) => test.test(description))?.[1] ?? { glyph: '●', hue: '#93c5fd' }
}

export const tokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`
export const usd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `${Math.round(n * 100)}¢`)
export const bar = (share: number, width: number, on = '█', off = '░') => {
  const cells = Math.max(0, Math.min(width, Math.round(share * width)))
  return on.repeat(cells) + off.repeat(width - cells)
}
const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}` : `${s}s`
}
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mission', description: 'Open Mission Control: Crew, Cache and Spend stacked in one panel' })
    void $.ui.open({ id: PANE, title: 'Mission' })
    return next(e)
  })

  on('command.run', { command: 'mission' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Mission', focus: true })
    return { text: 'Mission Control open. Focus it and use the arrows to scroll.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const width = Math.max(26, (e.props.bodyColumns ?? 44) - 2)
    const rows = (await read($, agents)) ?? []
    const frame = (await read($, crewTick)) ?? 0
    const cache = (await read($, reading)) as any
    const spend = (await read($, ledger)) as any

    const Section = ({ title, hue, right }: { title: string; hue: string; right?: string }) => (
      <Box flexDirection="column" marginTop={1}>
        <Box justifyContent="space-between">
          <Text bold color={hue}>{title}</Text>
          {right ? <Text dimColor>{right}</Text> : null}
        </Box>
        <Text color={hue} dimColor>{'━'.repeat(width)}</Text>
      </Box>
    )

    // Crew
    const running = rows.filter((r: any) => r.endedAt === null)
    const crew = [...running, ...rows.filter((r: any) => r.endedAt !== null)].slice(0, 10)

    // Cache
    const ttl = (cache?.ttlMinutes ?? 60) * 60_000
    const left = cache?.lastRequestAt ? cache.lastRequestAt + ttl - now : null
    const cacheState = !cache || left === null || !cache.cachedTokens ? 'empty' : left <= 0 ? 'cold' : left < ttl * 0.25 ? 'fading' : 'warm'
    const cacheHue = { warm: '#22c55e', fading: '#f97316', cold: '#ef4444', empty: '#64748b' }[cacheState]
    const reads = cache?.readTokens ?? 0
    const writes = cache?.writtenTokens ?? 0
    const hit = reads + writes > 0 ? reads / (reads + writes) : 0

    // Spend
    const entries = [...(spend?.entries ?? [])].sort((a: any, b: any) => b.usd - a.usd)
    const biggest = entries[0]?.usd ?? 0
    const samples = (spend?.samples ?? []).filter((s: any) => now - s.at <= 15 * 60_000)
    const burn = samples.length > 1 ? ((samples.at(-1).usd - samples[0].usd) / ((samples.at(-1).at - samples[0].at) / 3_600_000 || 1)) : 0
    const budget = spend?.budgetUsd ?? null
    const budgetShare = budget ? (spend?.totalUsd ?? 0) / budget : 0
    const budgetHue = budgetShare >= 1 ? '#ef4444' : budgetShare >= 0.8 ? '#f97316' : '#22c55e'

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text bold color="#e2e8f0">◈ MISSION CONTROL</Text>
          <Text>
            <Text color="#4ade80" bold>{running.length}</Text>
            <Text dimColor> working  </Text>
            <Text color={cacheHue}>●</Text>
            <Text dimColor> cache  </Text>
            <Text color="#4ade80" bold>{usd(spend?.totalUsd ?? 0)}</Text>
          </Text>
        </Box>

        <Section title="⚑ CREW" hue="#fb923c" right={`${running.length} at work · ${rows.length - running.length} done`} />
        {crew.length === 0 && <Text dimColor>No sub-agents right now.</Text>}
        {crew.map((r: any) => {
          const role = roleOf(r.description, r.type)
          const done = r.endedAt !== null
          const failed = r.status === 'failed' || r.status === 'killed'
          const share = r.inputTokens > 0 ? r.cacheReadTokens / r.inputTokens : 0
          const quiet = !done && now - (r.lastStepAt ?? r.startedAt) > 3 * 60_000
          return (
            <Text key={r.id} wrap="truncate-end">
              <Text color={failed ? '#ef4444' : done ? '#22c55e' : role.hue}>{failed ? '✗' : done ? '✓' : SPIN[frame % SPIN.length]} </Text>
              <Text color={done ? '#64748b' : role.hue} bold>{role.glyph} </Text>
              <Text dimColor={done} bold={!done}>{r.description.slice(0, Math.max(12, width - 30))}</Text>
              <Text dimColor>  {r.steps}st {elapsed((r.endedAt ?? now) - r.startedAt)} </Text>
              <Text color={share >= 0.8 ? '#22c55e' : share >= 0.5 ? '#f97316' : '#ef4444'}>{Math.round(share * 100)}%</Text>
              {quiet ? <Text color="#f97316"> ⚠ quiet</Text> : null}
            </Text>
          )
        })}

        <Section title="❄ CACHE" hue="#22d3ee" right={cacheState.toUpperCase()} />
        {cacheState === 'empty' ? (
          <Text dimColor>Nothing cached yet.</Text>
        ) : (
          <Box flexDirection="column">
            <Text>
              <Text color={cacheHue}>{bar(cacheState === 'cold' ? 0 : (left ?? 0) / ttl, Math.max(10, width - 14), '▰', '▱')}</Text>
              <Text bold color={cacheHue}> {cacheState === 'cold' ? 'lapsed' : clock(left ?? 0)}</Text>
            </Text>
            <Text dimColor>
              {tokens(cache.cachedTokens)} held · {Math.round(hit * 100)}% hits · {cache.keepWarm ? 'kept warm' : 'keep-warm off'}
            </Text>
            {(() => {
              // Same estimate as the Cache panel: a token priced from /cost, then the cache multipliers.
              const factor = (m: string) => (/haiku/i.test(m) ? 1 : /sonnet/i.test(m) ? 3 : /opus|fable/i.test(m) ? 5 : 3)
              const spentSince = cache.sessionUsd != null && cache.usdBaseline != null ? cache.sessionUsd - cache.usdBaseline : 0
              const base = spentSince > 0 && (cache.weightedAll ?? 0) >= 200_000 ? (spentSince / cache.weightedAll) * factor(cache.mainModel || 'opus') : null
              if (base === null) return null
              const write = (cache.ttlMinutes ?? 60) >= 60 ? 2 : 1.25
              const saved = (cache.readTokens ?? 0) * 0.9 * base
              const coldTax = (cache.rewrittenTokens ?? 0) * (write - 0.1) * base
              const ifCold = (cache.cachedTokens ?? 0) * (write - 0.1) * base
              return (
                <Text>
                  <Text dimColor>saved </Text><Text color="#4ade80" bold>{usd(saved)}</Text>
                  <Text dimColor>  cold tax </Text><Text color={coldTax > 0 ? '#f97316' : '#64748b'} bold>{usd(coldTax)}</Text>
                  <Text dimColor>  going cold +</Text><Text color="#f97316">{usd(ifCold)}</Text>
                </Text>
              )
            })()}
            {cacheState === 'cold' && <Text color="#ef4444">✗ next prompt re-writes the cache</Text>}
            {cacheState === 'fading' && <Text color="#f97316">⚠ under a quarter of the window left</Text>}
          </Box>
        )}

        <Section title={spend?.limits?.length ? '◆ USAGE' : '$ SPEND'} hue="#4ade80" right={spend?.limits?.length ? 'plan' : `${usd(burn)}/h`} />
        {(spend?.limits ?? []).map((w: any) => {
          const hue = w.percentUsed >= 85 ? '#ef4444' : w.percentUsed >= 60 ? '#f97316' : '#22c55e'
          return (
            <Text key={w.kind}>
              <Text dimColor>{(w.kind === 'five_hour' ? '5-hour' : w.kind === 'seven_day' ? 'weekly' : w.kind).padEnd(8)}</Text>
              <Text color={hue}>{bar(Math.min(1, w.percentUsed / 100), Math.max(10, width - 16))}</Text>
              <Text bold color={hue}> {Math.round(w.percentUsed)}%</Text>
            </Text>
          )
        })}
        {budget !== null && (
          <Text>
            <Text color={budgetHue}>{bar(Math.min(1, budgetShare), Math.max(10, width - 18))}</Text>
            <Text bold color={budgetHue}> {Math.round(budgetShare * 100)}%</Text>
            <Text dimColor> of {usd(budget)}</Text>
          </Text>
        )}
        {entries.length === 0 && <Text dimColor>No spend recorded yet.</Text>}
        {entries.slice(0, 6).map((entry: any) => {
          const hue = entry.kind === 'prompt' ? '#93c5fd' : entry.kind === 'helpers' ? '#64748b' : roleOf(entry.label, '').hue
          return (
            <Text key={entry.id} wrap="truncate-end">
              <Text color={hue}>{bar(biggest > 0 ? entry.usd / biggest : 0, 8)}</Text>
              <Text bold> {usd(entry.usd).padStart(6)}</Text>
              <Text dimColor>  {entry.label}</Text>
            </Text>
          )
        })}
        {entries.length > 6 && <Text dimColor>+ {entries.length - 6} more in /spend</Text>}
        <Section title="▸ CONTROLS" hue="#e2e8f0" />
        <Box gap={1} flexWrap="wrap">
          <Button key="warm" hotkey="w" label={cache?.keepWarm ? 'Stop keeping warm' : 'Keep cache warm'} onPress={() => void $.command.run({ command: 'keepwarm' })} />
          <Button key="ping" hotkey="p" label="Ping cache" onPress={() => void $.command.run({ command: 'keepwarm', args: 'now' })} />
          <Button key="budget" hotkey="b" label={budget ? `Budget ${usd(budget)}: +$50` : 'Budget $50'} onPress={() => void $.command.run({ command: 'spend', args: `budget ${(budget ?? 0) + 50}` })} />
          {budget !== null && <Button key="nobudget" hotkey="0" label="Clear budget" onPress={() => void $.command.run({ command: 'spend', args: 'budget off' })} />}
        </Box>
        <Box gap={1} flexWrap="wrap" marginTop={1}>
          <Button key="crew" hotkey="c" label="Crew" onPress={() => void $.command.run({ command: 'crew' })} />
          <Button key="cachepane" hotkey="k" label="Cache" onPress={() => void $.command.run({ command: 'keepwarm', args: 'panel' })} />
          <Button key="spendpane" hotkey="s" label="Spend" onPress={() => void $.command.run({ command: 'spend' })} />
        </Box>
      </Box>
    )
  })
}
