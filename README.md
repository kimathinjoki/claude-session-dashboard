# Session dashboard for Claude Code

Four side-panel mods for Claude Code (function hooks, early access API):

| Mod | Panel | Command |
|---|---|---|
| agent-progress | **Crew**: each sub-agent with a worker avatar (builder, inspector, scout, architect, librarian), model, live activity, steps, elapsed time, cache hit bar, tokens, and a warning when a worker goes quiet | `/crew` |
| cache-tax | **Cache**: prompt cache countdown gauge, hit-rate sparkline, cold-start warnings, keep-warm pings, and what caching cost: spent, saved by reads, the cold-start tax, what pings cost and what going cold now would add (estimated from /cost with the published cache multipliers) | `/keepwarm`, `/keepwarm now`, `/keepwarm ttl 5\|60`, `/keepwarm panel` |
| spend-ledger | **Spend**: what each prompt and each sub-agent cost, a STATS dashboard modelled on /usage stats: views Overview, Tokens, Cost, Cache and In/Out; ranges This session, 7 days, 30 days and All time; a model filter; an activity heatmap, charts in four styles (line, area, bars, dots) with axes, stat tiles (favorite model, total tokens, sessions, active days, longest session, streaks) and per-model cards. Past days come from Claude Code's own history (~/.claude/stats-cache.json, the file /usage reads), with their in/out/cache split and cost estimated from each model's totals; today is exact, from the mod's own tracking. An active-hours chart shows when you work, a by-model breakdown (cost, share, requests, tokens, cache hit rate), burn rate, budget, running insights. On an API key it budgets in dollars (`/spend budget 50`, warnings at 80% and 100%). On a Claude subscription it shows the plan's 5-hour and weekly windows with reset times and how long the 5-hour window lasts at your pace, and budgets as a share of it (`/spend budget 80%`); the dollar figures are then the API-price value of the work, not a charge | `/spend`, `/spend budget 50`, `/spend budget 80%`, add `hard` to refuse new prompts once reached (`/spend budget 50 hard`), `/spend hard on\|off`, `/spend budget off` |
| mission-control | **Mission Control**: all three stacked in one scrollable panel, with buttons for every command | `/mission` |

Every panel has buttons with hotkeys for its commands.

## Install

At the prompt of a terminal session:

```
/plugin install mission-control --marketplace kimathinjoki/claude-session-dashboard
```

Answer `y` to add the marketplace, choose the user scope, then install the other three the same way (`agent-progress`, `cache-tax`, `spend-ledger`). Mission Control reads their state, so it needs all three.

## Best viewed

Side panels dock beside the transcript in fullscreen mode (`"tui": "fullscreen"` in `~/.claude/settings.json`, or `/config`) from 110 columns. They open on their own at session start from 144 columns; at any width the commands above open them. With several open they share the dock as tabs.

The Cache panel follows your `promptCacheTtl` setting (`"1h"` keeps the cache for an hour; 1-hour cache writes cost more than 5-minute ones).
