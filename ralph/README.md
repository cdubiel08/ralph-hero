# ralph

Board-driven autonomous development over a GitHub Projects V2 board, packaged as a Claude Code plugin.

One execution verb (`/ralph:work`), one human surface (`/ralph:board`), one typed board CLI (`scripts/board`), one read-only fan-out agent, two courtesy hooks, and a scheduler-owned loop. The driving model sequences its own research/plan/build/verify at whatever depth the unit demands; enforcement is code, not prose.

This is ralph v2 (GH-1662). Design record (normative): [`../thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md`](../thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md).

## What's in the box

| Surface | Purpose |
|---|---|
| `/ralph:work` | The only execution verb: claim → work (no prescribed phase order) → PR → gates → close-out, under an 8-rule contract |
| `/ralph:board` | Human surface: orientation ("what's going on"), intake ("make a ticket"), answering blocked items, doctor, readiness |
| `scripts/board` | Typed board CLI — the sole sanctioned mutation path: 6-state machine, claims with TTL, scope gate, doctor |
| `agents/investigator.md` | Read-only fan-out worker (Read/Grep/Glob hard allowlist) for parallel investigation |
| `hooks/funnel-{board,merge}.sh` | Courtesy redirects: raw board mutations → the CLI; bare `gh pr merge` → the merge gate, when the host repo ships one. **Not** enforcement |
| `scripts/tick.sh` + `scripts/install-loop.sh` | The autonomous loop: scheduler-owned, one iteration per invocation, typed opt-in |
| `skills/using-html` | Vendored utility (byte-identical upstream; do not edit) |

## The board

Six states, one machine, defined once in `board.ts`:

```text
Backlog → In Progress → In Review → Done
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

## Everyday use

- `/ralph:board` — catch up, triage, form new tickets, answer Human Needed items, run doctor. Read-mostly; the Projects V2 UI is the dashboard.
- `/ralph:work NNN` — drive one issue end-to-end. Also accepts an outcome description (creates the issue first) or empty args (folds Human Needed replies, then takes `board next`).
- The CLI directly: `board get NNN`, `board list --state human`, `board next`, `board tree NNN`, `board create --title …`, `board claim NNN`, `board move NNN in-review`, `board doctor --fix`, `board readiness`.

## The loop (optional autopilot)

`tick.sh` runs ONE iteration: lock → heartbeat → `board next` (empty queue = exit before spawning anything) → worktree-per-job → `$RALPH_TICK_RUNNER "/ralph:work NNN"` under a hard timeout → per-issue log. A timeout releases the claim; success is judged by board state, not exit codes (a no-op runner logs loudly). The scheduler owns cadence — no sentinels, no in-session wakeups.

```bash
ralph/scripts/install-loop.sh --enable    # writes autopilot=true, installs the launchd job (macOS) or prints the cron line
ralph/scripts/install-loop.sh --disable
```

- **Opt-in is typed and fail-closed**: tick.sh refuses to run unless `$RALPH_HOME/config` (default `~/.ralph/config`) contains `autopilot=true`.
- **Billing guard**: tick.sh refuses to spawn when `ANTHROPIC_API_KEY` is set (it would bill API credits instead of the subscription) unless `RALPH_ALLOW_API_BILLING=true`.
- **Transport-agnostic**: `RALPH_TICK_RUNNER` is any command that accepts a prompt (default `claude -p --model sonnet --permission-mode acceptEdits`). An interactive `/ralph:work` session and a bridge-routine drive are equally valid — tick.sh is a convenience, not the architecture.

## Enforcement, honestly labeled

1. **`board.ts`** — typed gates at the path all sanctioned traffic uses: transition legality from live state, claim protocol with read-back verification, scope gate, mutation echo.
2. **`state-guard.yml`** (a repo workflow, in this repo at `.github/workflows/state-guard.yml`) — the corrective wall for bypass traffic: an issue-event lane (adopt/reconcile/parent gate) plus a 15-minute `doctor --fix` reconciler cron. Needs a classic-PAT `ROUTING_PAT` secret — `GITHUB_TOKEN` cannot write a personal-account Projects V2 board. Every correction posts a visible comment.
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

Autopilot itself is not an env var: it is `autopilot=true` in `$RALPH_HOME/config` (default `~/.ralph/config`), written by `install-loop.sh --enable`.

## Development

From the repo root:

```bash
npm install
npx vitest run ralph/scripts/board.test.ts   # the board CLI's contract suite
npx tsc --noEmit
shellcheck -S error ralph/hooks/*.sh ralph/scripts/*.sh
```

There is no npm publish — the repo copy is the version. Claude Code installs the plugin as an immutable versioned copy from the marketplace clone; edits here reach a running session after merge → `release-ralph.yml` bumps + tags → plugin update. Every `board.ts` change ships with tests and must keep the parity invariant: `get` reads exactly the fields `move`/`claim` write.

## History

v1 (9 verb skills, 16 agents, 40 hooks, a 20.7k-line MCP server, an 11-state machine) was replaced wholesale in GH-1662. The npm package `ralph-hero-mcp-server` is deprecated. Rationale and evidence live in the design record linked above.

## License

MIT.
