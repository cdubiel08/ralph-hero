# ralph-herdr

A [herdr](https://herdr.dev/) plugin — **not** a Claude Code plugin — that gives the
ralph board a cockpit: spawn lane sessions into persistent panes, watch the queues,
and get notified the moment a session blocks or finishes instead of at timeout.

It is an **attention surface, not a write surface**. The board remains the sole source
of truth and `board.ts` + `state-guard.yml` remain the only enforcement. These scripts
read the board through the repo's own `ralph/scripts/board` CLI and orchestrate herdr
(worktrees, agents, notifications); the only board mutations happen *inside* the
spawned `/ralph:work` / `/ralph:deliver` / `/ralph:tend` sessions, through the same
typed CLI every session uses. `work-next` does not claim the issue — the session it
spawns does.

## Requirements

- herdr >= 0.7.0 with a running server (`herdr`), plus `jq`
- a ralph-configured repo: a reachable board CLI, board scope configured
  (`.ralph.json` or the `RALPH_GH_*` env block), `gh` authed with `repo,project`
  scopes. The board CLI default is `ralph/scripts/board` in the repo tree (the
  vendored-checkout layout, i.e. ralph-hero itself); host repos that install ralph
  as a Claude Code plugin have no `ralph/` tree — set `RALPH_HERDR_BOARD` to the
  installed plugin's `scripts/board` path. The scripts die loudly anywhere else.
- optional but recommended: `herdr integration install claude` (session-identity
  restore after server restart; it does not change how `blocked` is detected)

## Install

Development (local checkout):

```bash
herdr plugin link /path/to/ralph-hero/plugin/ralph-herdr
```

From GitHub:

```bash
herdr plugin install cdubiel08/ralph-hero/plugin/ralph-herdr
```

Invoke actions from a workspace whose cwd is the ralph-configured repo (herdr's action
menu, or `herdr plugin action invoke <id> --plugin ralph-herdr`).

## The five actions

| Action | Pane | What it does |
|---|---|---|
| `work-next` | split (down) | `board next` → if empty, says so and exits. Otherwise: fetch, `herdr worktree create --branch feature/GH-N --base origin/main` (`--base` only applies to brand-new branches — an existing `feature/GH-N` branch is silently resumed as-is, possibly behind origin/main, and the session rebases; `worktree open` is the fallback when the *checkout* already exists), start agent `gh-N` in the new workspace's pane, prompt `/ralph:work N`, then the cockpit pane becomes the notification watcher |
| `deliver-pass` | split (down) | `board deliver-queue` → empty means spawn nothing (the lane contract). Otherwise a new tab hosts agent `ralph-deliver` running `/ralph:deliver`; cockpit pane watches |
| `tend-pass` | split (down) | same shape over `board tend-queue` → agent `ralph-tend` running `/ralph:tend` |
| `doctor` | popup | runs `board doctor` once, holds the popup open until Enter |
| `dashboard` | split (right) | read-only watch loop: board `next` (number/title/estimate + queue depth), deliver-queue, tend-queue, Human Needed count. No doctor call in the loop — doctor is its own action |

The watcher (`scripts/notify-watch.sh`) uses `herdr agent wait --until blocked --until
done --until idle` — level-triggered, no timeout, hangs on purpose — then fires
`herdr notification show` naming the agent, its state, and the repo. It re-arms while
the session keeps blocking and exits once the session is done or idle.

Agent names are fixed: `gh-N` for work sessions, `ralph-deliver` / `ralph-tend` for
lane passes — one live pass per lane. If a name is taken the script dies loudly
("a pass is already live"); it never improvises suffixes, never kills the live agent.

## Knobs

All knobs are plain env vars with defaults (`${VAR:-default}`), documented at the top
of each script:

| Var | Default | Meaning |
|---|---|---|
| `RALPH_HERDR_BOARD` | `<repo>/ralph/scripts/board` | path to the board CLI; set it on host repos that install ralph as a Claude Code plugin (board.ts ships inside the installed plugin, not the repo tree) |
| `RALPH_HERDR_DASH_INTERVAL` | `120` | dashboard refresh interval, seconds |
| `RALPH_ALLOW_API_BILLING` | unset | billing guard override, same contract as `tick.sh`: if `ANTHROPIC_API_KEY` is set, spawning is refused (it would bill API credits, not the subscription) unless this is exactly `true` |

Board scope (`RALPH_GH_OWNER` / `RALPH_GH_REPO` / `RALPH_GH_PROJECT_NUMBER`,
`.ralph.json`) belongs to `board.ts`, not this plugin — the scripts inherit whatever
the repo is configured with. The repo is always the pane's working directory (the
workspace the action was invoked from).

## Honest limits

- **`blocked` is screen-detected and hint-only.** Claude Code has no lifecycle
  authority in herdr; the chip comes from screen-manifest matching. It sharpens
  attention, it never gates anything. Likewise `working` measures liveness, not
  progress — a session parked in a CI wait reads `working` for as long as it polls.
- **Notifications are advisory.** Missing one changes nothing about board state; the
  board comment trail is the record.
- **The board is the sole source of truth.** No script here writes Workflow State,
  uses `--force`, or kills an agent process. Read the queues, spawn a session, watch,
  notify — that is the whole surface.
- **No unattended arming here.** The claim TTL vs pane-persistence probe (a pane that
  outlives its claim can double-work against a fresh claimant) has not been run yet —
  design doc §3.1/§5. Until it is, every action in this plugin is human-clicked;
  scheduler-owned herdr ticks stay in `ralph/examples/tick-herdr.sh`, which bounds its
  wait at the TTL, wraps up rather than kills, and requires its own typed
  `herdr_autopilot=true` opt-in key on top of tick.sh's `autopilot=true` — an existing
  tick.sh arming never silently extends to pane-persistence ticks.
- **A herdr plugin is unsandboxed local code** with your permissions. This one stays
  read-mostly by construction, but read the scripts before linking — they are short
  on purpose.

## Pointers

- Design record (normative): `thoughts/shared/research/2026-08-09-herdr-runtime-ralph-addon.md`
- Scheduler-owned herdr tick recipe: `ralph/examples/tick-herdr.sh` (copy and own —
  scripts are examples, contracts are doctrine: `ralph/examples/README.md`)
