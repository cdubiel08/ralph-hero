---
description: Shortcut — bring up the dispatch seat. Runs `dispatch up` (GH-2213, D3.1; placement per GH-2246) — ensure the hero pane is up in the repo's main workspace (the one the fleet's worktrees nest under; the seat's address stays `<repo>/dispatch`), then relay the roster. Triggers on "/ralph:d", "dispatch up", "bring up dispatch", "open the dispatch seat", "stand up dispatch". Requires the herdr cockpit; a dispatch PASS (authorities + inbox) is /ralph:dispatch, and the attended sitting the seat hosts is /ralph:hero.
argument-hint: ""
context: inline
model: sonnet
allowed-tools:
  - Read
  - Bash
---

# /ralph:d — dispatch up, as a skill surface

One command, relayed — this skill adds no judgment and holds no state. The
command is unit E of the herd topology (`dispatch-up.sh`, GH-2213): idempotent
— re-run HEALS (reopen space/pane), never refuses — and it arms nothing
scheduled; the unattended half of dispatch is the event lane, not a rota.

1. **No herdr, no seat.** If `herdr` is absent or the server is down
   (`herdr plugin list` fails), say so and stop — the dispatch SEAT is cockpit
   chrome, and dispatch's durable address is the board (D5.1) either way.
   Offer `/ralph:dispatch` for a pass without the seat.
2. **Run it.** Resolve the plugin root once
   (`herdr plugin list --json | jq -r '.result.plugins[]|select(.plugin_id=="ralph-herdr").plugin_root'`)
   and run `bash <herdr-plugin-root>/scripts/dispatch-up.sh` — the summary and
   roster print inline. Equivalent from herdr's own surfaces:
   `herdr plugin action invoke dispatch-up --plugin ralph-herdr` (the action
   form opens a pane and prints there instead). A missing `dispatch-up.sh` is
   a STALE INSTALL (herdr has no auto-update): run
   `bash ${CLAUDE_PLUGIN_ROOT}/scripts/herdr-setup.sh check`, which names the
   reinstall command on drift.
3. **Relay** the verdict in one line — workspace created|standing, hero pane
   opened|live (`live-legacy` means a sitting still in a pre-GH-2246
   `<repo>/dispatch` space — relay its migration note too) — then the roster. A billing refusal (`ANTHROPIC_API_KEY` set
   without `RALPH_ALLOW_API_BILLING=true`) is the guard working: relay it
   verbatim and stop; the hero session this stands up bills like any spawn.

Never claim a unit, never write the tree — the seat this opens is
/ralph:hero's, and hero holds no state either.
