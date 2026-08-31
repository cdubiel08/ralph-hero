# ralph

Board-driven autonomous development over a GitHub Projects V2 board, packaged as a Claude Code plugin.

One execution verb (`/ralph:work`), two follow-through lanes (`/ralph:deliver`, `/ralph:tend`), one human surface (`/ralph:board`), one typed board CLI (`scripts/board`), and one read-only fan-out agent. The driving model sequences its own research/plan/build/verify at whatever depth the unit demands; enforcement is code, not prose.

This is ralph v2 (GH-1662). Design record (normative): [`../thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md`](../thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md).

## What's in the box

| Surface | Purpose |
|---|---|
| `/ralph:work` | The only execution verb: claim → work (no prescribed phase order) → PR → gates → close-out, under a 9-rule contract |
| `/ralph:deliver` | Follow-through lane: shepherds In Review PRs to merged — concluded checks, review deltas, re-attestation (`--carry-review` only), rework demotion, close-outs. Mechanical remediation only, never `--force` |
| `/ralph:tend` | Hygiene lane: Backlog shape + Done audit — dedup, dependency wiring, stale-body detection against the live tree, observation intake with provenance. Metadata-only; closures are proposals via Human Needed |
| `/ralph:board` | Human surface: orientation ("what's going on"), intake ("make a ticket"), answering blocked items, doctor, readiness |
| `scripts/board` | Typed board CLI — the sole sanctioned mutation path: 6-state machine, claims with TTL, scope gate, doctor, and the lane selectors (`next`, `deliver-queue`, `tend-queue`) |
| `scripts/deliver-push.sh` | The deliver lane's branch-write gate (GH-1917): a pinned `--force-with-lease` push, so a work session that pushed first wins atomically instead of being silently clobbered. No `--force` exists |
| `examples/README.md` | Transport recipes for driving the lanes — `/loop` (fixed and self-paced), scheduled routines, scheduler scripts. Copy and own; ralph executes none of them |
| `agents/investigator.md` | Read-only fan-out worker (Read/Grep/Glob hard allowlist) for parallel investigation |
| `hooks/funnel-{board,merge,push}.sh` | Courtesy redirects: raw board mutations → the CLI; bare `gh pr merge` → the merge gate, when the host repo ships one; a raw **force** push on a branch with an open PR → `scripts/deliver-push.sh` (GH-1930). A quoted mention of a guarded command is an argument, not a run, and passes. **Not** enforcement |
| `scripts/tick.sh` + `scripts/install-loop.sh` | The scheduler-transport recipe for the work lane: one iteration per invocation, typed opt-in — one transport among several (see `examples/README.md`), not *the* loop |
| `skills/using-html` | Vendored utility (byte-identical upstream; do not edit) |

## The board

Six states, one machine, defined once in `board.ts`:

```text
Intake → Backlog → In Progress → In Review → Done
                        ↕︎              ↓
                   Human Needed ←──────┘        Canceled (explicit cancel; reopen is the only exit from a terminal state)
```

- A **claim** is `{holder}|{iso8601}` in a `Claim` text field on the board, TTL 120 min. `claim --steal` evicts a stale holder and posts an eviction comment. **No `--force` flag exists anywhere** — a stale TTL is the only side door.
- **Phase is derived, never stored.** `board get` reports it from artifacts (research doc? plan? PR?); there are no phase states to maintain.
- **Scope gate**: the working repo's origin remote must match the configured host/owner/repo before any mutation. Wrong repo = hard error, including `doctor --fix`.
- Sub-issues and dependency edges are native (`board link`, `board dep`); `board next` excludes items with open blockers and reports why.

## Install

From Claude Code:

```text
/plugin marketplace add cdubiel08/ralph-hero
/plugin install ralph@ralph-hero
```

Requirements: `gh` authenticated with project scope, and a TypeScript runtime — `bun` if present, otherwise the `board` shim falls back to a version-pinned `tsx` via node/npx.

```bash
gh auth login -s repo,project
```

Then, in the host repo:

1. **Point ralph at the board** — either a repo-root `.ralph.json`:

   ```json
   { "owner": "you", "repo": "your-repo", "projectNumber": 7 }
   ```

   or env vars in the tracked `.claude/settings.json` `env` block: `RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER` (plus `RALPH_GH_HOST` for GitHub Enterprise). `.ralph.json` takes precedence when both exist.
2. **Bootstrap the fields**: `board setup` — idempotent; creates the Workflow State, Claim, Estimate, and Priority fields (never edits existing fields) and prints exactly which steps (if any) must be done in the board UI.
3. **Sanity check**: `board doctor`.
4. **See what level of autonomy the repo supports**: `board readiness` — an advisory report at three levels (interactive / unattended / autonomous loop). Recommendations, never gates: ralph adapts to the host repo, and beyond the board itself its conventions are detect-if-present suggestions, never requirements.

In an installed plugin the CLI lives at `${CLAUDE_PLUGIN_ROOT}/scripts/board` (in this repo: `ralph/scripts/board`). `board help` lists every subcommand.

### Install the `rh` operator command

From this repository, install the stable shim with:

```bash
bash ralph/scripts/install-rh.sh
```

The default target is `${XDG_BIN_HOME:-$HOME/.local/bin}/rh`; add that directory to `PATH` if needed. Use `--bin-dir DIR` for another target. The installer updates only a recognized Ralph Hero shim and refuses to overwrite an unrelated `rh` executable. The existing `board` command remains permanent: `rh board ...` delegates to that exact CLI rather than replacing it.

`rh` accepts `--color=auto|always|never` before the command. Any non-empty `NO_COLOR` disables color, including when `--color=always` was requested.

## Everyday use

| Command | Semantics |
|---|---|
| `rh` | read-only operator home |
| `rh dispatch` | read-only dispatch status |
| `rh dispatch up` | ensure Herdr + dispatch only; do not change focus |
| `rh day` | prepare/resume the day, then enter Herdr on this repo's dispatch from an interactive terminal |
| `rh day --no-attach` | prepare/resume the day without changing focus or attaching Herdr |
| `rh day --team N` | same, plus explicit new team N |
| `rh board ...` | exact existing board CLI |
| `rh inbox` | read-only human inbox |
| `rh fleet` | read-only scoped fleet status |
| `rh doctor` | read-only setup and board diagnosis |

`rh day` is terminal-aware. At an interactive macOS or WSL shell it ensures the
dispatch hero and cockpit, prints the inbox summary, and then attaches the full
Herdr UI with the current repository's dispatch hero selected. When run inside
Herdr it switches the existing client to that hero rather than nesting another
client. Pipes, CI, other non-TTY automation, and `--no-attach` retain the
background-only path.

- `/ralph:board` — catch up, triage, form new tickets, answer Human Needed items, run doctor. Read-mostly; the Projects V2 UI is the dashboard.
- `/ralph:work NNN` — drive one issue end-to-end. Also accepts an outcome description (creates the issue first) or empty args (folds Human Needed replies, then takes `board next`).
- The CLI directly: `board get NNN`, `board list --state human`, `board next`, `board tree NNN`, `board create --intake --title …` / `board create --backlog --title … --priority P1 --estimate S`, `board claim NNN`, `board move NNN in-review`, `board doctor --fix`, `board readiness`.

## Lanes and how to drive them

A **lane** is a typed selector + a judgment skill + a goal (its termination condition). Cadence is never configured — it is derived per pass from what the queue is blocked on, and each skill ends its pass reporting exactly what a driver needs (`checked`/`acted`, blocked reasons, earliest window expiry):

| Lane | Selector | Skill | Goal |
|---|---|---|---|
| work | `board next` | `/ralph:work` | empty `next` |
| deliver | `board deliver-queue` | `/ralph:deliver` | empty `next` + no time-bounded blocked rows |
| tend | `board tend-queue` | `/ralph:tend` | one clean sweep (`checked>0, acted=0`) |

Every transport is valid against the same contracts — a direct invocation, a `/loop` session (fixed or self-paced), a scheduled routine, or a scheduler script. Recipes, including the fail-closed opt-in keys and billing guard for unattended transports (`autopilot=true` plus `autopilot.<lane>=true` for deliver/tend): [`examples/README.md`](examples/README.md).

## The scheduler recipe (optional autopilot for the work lane)

`tick.sh` runs ONE iteration: lock → heartbeat → `board next` (empty queue = exit before spawning anything) → worktree-per-job → `$RALPH_TICK_RUNNER "/ralph:work NNN"` under a hard timeout → per-issue log. A timeout releases the claim; success is judged by board state, not exit codes (a no-op runner logs loudly). The scheduler owns cadence — no sentinels, no in-session wakeups. It is the worked example of the scheduler transport, not the architecture.

```bash
ralph/scripts/install-loop.sh --enable    # writes autopilot=true, installs the launchd job (macOS) or prints the cron line
ralph/scripts/install-loop.sh --disable
```

- **Opt-in is typed and fail-closed**: tick.sh refuses to run unless `$RALPH_HOME/config` (default `~/.ralph/config`) contains `autopilot=true`.
- **Billing guard**: tick.sh refuses to spawn when `ANTHROPIC_API_KEY` is set (it would bill API credits instead of the subscription) unless `RALPH_ALLOW_API_BILLING=true`.
- **Transport-agnostic**: `RALPH_TICK_RUNNER` is any command that accepts a prompt (default `claude -p --model sonnet --permission-mode acceptEdits`). An interactive `/ralph:work` session and a bridge-routine drive are equally valid — tick.sh is a convenience, not the architecture.

## Enforcement, honestly labeled

1. **`board.ts`** — typed gates at the path all sanctioned traffic uses: transition legality from live state, claim protocol with read-back verification, scope gate, mutation echo.
2. **`state-guard.yml`** (a repo workflow, in this repo at `.github/workflows/state-guard.yml`) — the corrective wall for bypass traffic: an issue-event lane (adopt/reconcile/parent gate) plus a `doctor --fix` reconciler cron configured at `*/15`. **That cadence is a ceiling, not a guarantee** — GitHub delays scheduled workflows under load and deprioritizes them on low-activity repositories, so the reconciler's real interval is the number to reason about, not the one in the `cron:` line. Measured on this repo: median 14 min with a 33 min tail over 30 consecutive fires (2026-08-16), and 30–80 min intervals across a quiet stretch (2026-08-02). So the corrective wall's worst-case latency is *tens of minutes*, and anything whose safety argument rests on "one reconcile pass" is making an unbounded-in-practice claim — the event lane (issue opened/closed/reopened) is the prompt half; the cron half is best-effort. Needs a classic-PAT `ROUTING_PAT` secret — `GITHUB_TOKEN` cannot write a personal-account Projects V2 board. Every correction posts a visible comment.
3. **The funnel hooks** — ~35-line courtesy redirects. They fail open by nature and are never counted as enforcement; layers 1–2 are the guarantees.
4. **`doctor.yml`** — a weekly `doctor --strict` CI cron, the watcher-of-the-watcher (this repo has observed silent Actions non-fire and an expired PAT).

Merges in this repo go through `bash scripts/merge-pr.sh PR` (never bare `gh pr merge`): no `CHANGES_REQUESTED`, CI green, a head_sha-bound attestation, an external review per policy. Gates are run, not predicted. The funnel-merge hook redirects bare `gh pr merge` to that gate only when the host repo ships `scripts/merge-pr.sh` — a repo without one keeps its own merge flow untouched (recommending a gate is `board readiness`'s job, never a hook's).

## Environment reference

| Variable | Default | Effect |
|---|---|---|
| `RALPH_GH_OWNER` / `RALPH_GH_REPO` / `RALPH_GH_PROJECT_NUMBER` | — | Board coordinates (settings.json lane; `.ralph.json` wins) |
| `RALPH_GH_HOST` | `github.com` | GitHub Enterprise host |
| `RALPH_LOCK_TTL_MIN` | `120` | Claim TTL in minutes |
| `RALPH_CLAIM_HOLDER` | `user@hostname` | Holder string written into claims |
| `RALPH_HOME` | `~/.ralph` | Config, logs, heartbeat, tick lock |
| `RALPH_TICK_RUNNER` | `claude -p --model sonnet --permission-mode acceptEdits` | The command a tick invokes with the work prompt |
| `RALPH_TICK_TIMEOUT_MIN` | `45` | Hard timeout per tick's work session |
| `RALPH_TICK_INTERVAL_MIN` | `15` | Scheduler cadence written by `install-loop.sh` |
| `RALPH_ALLOW_API_BILLING` | unset | Set `true` to let tick.sh spawn with `ANTHROPIC_API_KEY` present |
| `RALPH_SETTLE_MIN` | `5` | deliver-queue quiescence window (minutes) |
| `RALPH_RETRY_MIN` | `60` | deliver-queue bounded-retry window, any verdict (minutes) |
| `RALPH_DELIVER_DRYRUN_MAX` | `3` | deliver-queue `merge-pr.sh --dry-run` probes per pass |
| `RALPH_STALE_DAYS` | `30` | tend-queue stale-body threshold (days) |
| `RALPH_AUDIT_DAYS` | `14` | tend-queue Done-audit lookback (days) |
| `RALPH_TEND_BATCH` | `5` | tend skill's per-session item budget |

Autopilot itself is not an env var: it is `autopilot=true` in `$RALPH_HOME/config` (default `~/.ralph/config`), written by `install-loop.sh --enable`.

## Development

From the repo root:

```bash
npm install
npx vitest run ralph/scripts/                # board contract suite + metrics registry
npx tsc --noEmit
shellcheck -S error ralph/hooks/*.sh ralph/scripts/*.sh
```

There is no npm publish — the repo copy is the version. Claude Code installs the plugin as an immutable versioned copy from the marketplace clone; edits here reach a running session after merge → `release-ralph.yml` bumps + tags → plugin update. Every `board.ts` change ships with tests and must keep the parity invariant: `get` reads exactly the fields `move`/`claim` write.

## History

v1 (9 verb skills, 16 agents, 40 hooks, a 20.7k-line MCP server, an 11-state machine) was replaced wholesale in GH-1662. The npm package `ralph-hero-mcp-server` is deprecated. Rationale and evidence live in the design record linked above.

## License

MIT.
