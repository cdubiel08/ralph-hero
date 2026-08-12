---
description: Topic-routed setup help for ralph's optional equipment. First topic — herdr — checks and (with permission) wires the herdr cockpit for the board. Triggers on "/ralph:help", "help me set up herdr", "herdr setup", "is herdr set up", "wire the cockpit", "set up the herdr cockpit for ralph". Read-mostly; the only mutations are herdr's own config, each announced and permission-gated.
argument-hint: "[herdr]"
context: inline
model: sonnet
allowed-tools:
  - Read
  - Bash
  - AskUserQuestion
---

# /ralph:help — setup help, one topic at a time

Topics route on the argument. No argument, or an unknown topic → list the topics
below in one line each and stop. Never guess at a topic that isn't listed.

| Topic | What it covers |
|---|---|
| `herdr` | the herdr cockpit for the board — check the wiring, close the gaps |

## herdr

The cockpit is optional equipment: a [herdr](https://herdr.dev/) plugin that spawns
`/ralph:work` / `/ralph:deliver` / `/ralph:tend` sessions into persistent panes,
watches the queues, and notifies when a session blocks. The board stays the sole
source of truth; the cockpit only reads it and orchestrates herdr.

The wiring logic lives in one script — never re-derive its checks in prose:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/herdr-setup.sh check
```

Run it first, always. Then:

- **Everything ok** — say so; nothing else to do. Point at the cockpit
  actions (herdr's action menu in the repo workspace): work-next, work-fleet,
  attend, answer (the Human
  Needed exit, comment-first), cockpit (the board TUI over a degradation
  ladder), dashboard, deliver-pass, tend-pass, doctor, reconcile. Clicked
  issue/PR URLs route through the plugin's link handlers (focus the live
  session, or offer to spawn one). Fleet refill (`work-fleet --refill`) is
  opt-in per run, TTL- and budget-gated, and **never armed by default** — the
  2026-08-11 claim-TTL probe returned NO-GO for default arming.
- **`herdr: not installed` (exit 2)** — herdr itself is a manual install; send the
  user to https://herdr.dev/ and stop. Nothing else is checkable until it exists.
- **Gaps (exit 1)** — relay each GAP line plainly, then offer to run the fix pass.
  Only with the user's yes:

  ```bash
  bash ${CLAUDE_PLUGIN_ROOT}/scripts/herdr-setup.sh fix
  ```

  `fix` performs only the safely-automatable steps (plugin install/link/enable,
  claude integration) and prints exact commands for everything that needs a human
  hand (installing herdr, `gh auth`, exporting `RALPH_HERDR_BOARD`). Relay those
  manual steps verbatim — never run auth or install commands on the user's behalf.
  Re-run `check` afterwards and report the delta.

Notes (`note` lines) are advisory — mention them once, don't block on them.
`board doctor` carries the same verdict as its `herdr-cockpit` info line, so the
user can re-verify any time without this skill.

Deeper reference: the cockpit's own docs —
`plugin/ralph-herdr/README.md` and `plugin/ralph-herdr/CHEATSHEET.md` in
[cdubiel08/ralph-hero](https://github.com/cdubiel08/ralph-hero/tree/main/plugin/ralph-herdr)
(actions, knobs, the nesting model, honest limits). What a session running
*inside* a cockpit pane needs — naming grammar, self-report tokens, the
sanctioned spawn path, fleet claims, the ledger — is
`${CLAUDE_PLUGIN_ROOT}/skills/work/references/herdr-api.md`.
