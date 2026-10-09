# Session dashboard for Claude Code

Four side-panel mods for Claude Code (function hooks, early access API):

| Mod | Panel | Command |
|---|---|---|
| agent-progress | **Crew**: each sub-agent with a worker avatar (builder, inspector, scout, architect, librarian), model, live activity, steps, elapsed time, cache hit bar, tokens, and a warning when a worker goes quiet | `/crew` |
| cache-tax | **Cache**: prompt cache countdown gauge, hit-rate sparkline, tokens saved, cold-start warnings, keep-warm pings | `/keepwarm`, `/keepwarm now`, `/keepwarm ttl 5\|60`, `/keepwarm panel` |
| spend-ledger | **Spend**: what each prompt and each sub-agent cost, burn rate per hour, budget bar with warnings at 80% and 100%, running insights. The total is `/cost`; the split is estimated by tokens | `/spend`, `/spend budget 50`, `/spend budget off` |
| mission-control | **Mission Control**: all three stacked in one scrollable panel, with buttons for every command | `/mission` |

Every panel has buttons with hotkeys for its commands.

## Install

At the prompt of a terminal session:

```
/plugin install mission-control --marketplace <owner>/<repo>
```

Answer `y` to add the marketplace, choose the user scope, then install the other three the same way (`agent-progress`, `cache-tax`, `spend-ledger`). Mission Control reads their state, so it needs all three.

## Best viewed

Side panels dock beside the transcript in fullscreen mode (`"tui": "fullscreen"` in `~/.claude/settings.json`, or `/config`) from 110 columns. They open on their own at session start from 144 columns; at any width the commands above open them. With several open they share the dock as tabs.

The Cache panel follows your `promptCacheTtl` setting (`"1h"` keeps the cache for an hour; 1-hour cache writes cost more than 5-minute ones).
