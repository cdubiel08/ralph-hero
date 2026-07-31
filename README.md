# Ralph

A [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) that turns Claude into an autonomous software engineer, driven by a GitHub Projects V2 board. Ralph claims an issue, works it at whatever depth the unit demands — research, plan, code, verify, in the driver's own judgment — opens a PR, runs the merge gates, and moves on.

> *The naive hero picks tickets, does their best work, and moves on.*

## How It Works

Six board states, one typed CLI, no prescribed phases:

```text
Backlog → In Progress → In Review → Done
              ↕︎              ↓
         Human Needed ←──────┘        Canceled
```

- **`ralph/scripts/board`** is the sole board mutation path: transition legality, claims with TTL (no `--force` anywhere — a stale claim is the only override), a scope gate refusing writes from the wrong repo, and a `doctor` invariant sweep. ~1,100 lines of TypeScript with a vitest contract suite, shipped inside the plugin — no npm dependency.
- **`/ralph:work`** drives one issue end-to-end under an 8-rule contract (claim before work, board truthful, findings outlive the transcript, gates are run not predicted, …). Frontier-model bookends dispatch in-session on large units only.
- **`/ralph:board`** is the human surface: orientation, intake, answering blocked items.
- **`state-guard.yml`** corrects drift server-side (issue events + a 15-minute reconciler), commenting every correction. A weekly `doctor.yml` sweep makes silence impossible.
- **The loop** is a scheduler-owned `tick.sh`: one issue per tick, worktree-per-job, hard timeout, subscription-billing guard, opt-in via `install-loop.sh --enable`. No sentinels, no self-scheduling sessions.

Human checkpoints: anything the contract doesn't grant (destructive ops, spend, out-of-scope work) lands in **Human Needed** with the exact decision needed as a comment; `CHANGES_REQUESTED` on a PR always blocks merge.

## Installation

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Node.js 20+ (for the board CLI's tsx runner; or bun)
- `gh` CLI authenticated with `repo` + `project` scopes (`gh auth login -s repo,project`)

### Install

```bash
claude plugins add cdubiel08/ralph-hero --plugin ralph
```

### Configure

**Auth is the gh keyring only** — `gh auth login -s repo,project`. Never put GitHub tokens in `.claude/settings.json`, `.claude/settings.local.json`, or any committed file; the board CLI has no token variable to set.

Board coordinates go in ONE of two places (`.ralph.json` wins when both exist):

Your repo's tracked `.claude/settings.json` (env-block shape):

```json
{
  "env": {
    "RALPH_GH_OWNER": "your-github-username",
    "RALPH_GH_REPO": "your-repo",
    "RALPH_GH_PROJECT_NUMBER": "1"
  }
}
```

Or a repo-root `.ralph.json` (flat shape — note the different schema):

```json
{ "owner": "your-github-username", "repo": "your-repo", "projectNumber": 1 }
```

Then create the board fields once:

```bash
ralph/scripts/board setup
```

## Skills

| Skill | Description |
|-------|-------------|
| `/ralph:work` | Drive one issue (or described outcome) end-to-end — the only execution verb |
| `/ralph:board` | Orientation, intake, answering Human Needed items, board doctor |

Plus one read-only `investigator` agent for parallel fan-out, and four optional saved Workflows (`research-panel`, `plan-critique`, `tree-impl`, `adversarial-review`) the driver may invoke — never prescribed.

## The Board CLI

```text
board get / list / next / tree          reads (next = ranked queue + blocker report)
board create / claim / release / move / cancel / reopen / link / dep / comment
board adopt / reconcile / parent-check  reality-sync + rollup lanes (state-guard uses these)
board doctor [--fix] [--strict]         invariant sweep
board setup                             field bootstrap (idempotent)
```

Every mutation echoes the resulting board state. Foreign-repo items on a shared board are surfaced and never touched; archived items are skipped everywhere.

## Merge Gate

`main` should be ruleset-protected; merges go through `scripts/merge-pr.sh`, which verifies CI, review state, and a head-SHA-bound attestation (`scripts/attest-pr.sh`) carrying real test exit codes. `validate-attestation.yml` republishes the verdict server-side. Agents attempt the gate and trust its verdict — never pre-judge it.

## Configuration Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `RALPH_GH_OWNER` / `RALPH_GH_REPO` / `RALPH_GH_PROJECT_NUMBER` | Yes | Board coordinates (tracked settings or `.ralph.json`) |
| `RALPH_GH_HOST` | No | GitHub Enterprise host (default `github.com`) — used by both the scope gate and API transport |
| `RALPH_LOCK_TTL_MIN` | No | Claim staleness threshold, minutes (default 120) |
| `RALPH_CLAIM_HOLDER` | No | Claim holder identity (default `user@host`) |
| `RALPH_TICK_RUNNER` | No | Loop transport (default `claude -p --model sonnet`); any command accepting a prompt |
| `RALPH_TICK_TIMEOUT_MIN` | No | Hard per-tick timeout (default 45) |
| `RALPH_ALLOW_API_BILLING` | No | Must be `"true"` for tick to spawn with `ANTHROPIC_API_KEY` set (guards subscription users against silent API billing) |

Autopilot opt-in is `autopilot=true` in `~/.ralph/config`, written by `install-loop.sh --enable`.

## Repository Layout

```text
ralph/                   # The Claude Code plugin (skills, agent, hooks, board CLI, loop)
plugin/
├── ralph-knowledge/     # Semantic search over thoughts/ documents (own MCP server)
├── ralph-playwright/    # Polymorphic UI testing
└── ralph-demo/          # Sprint demo video generation
```

v1 (9 verb skills, 16 agents, 40 hooks, a 20k-line MCP server) was replaced in GH-1662; the npm package `ralph-hero-mcp-server` is deprecated. Design record: `thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md`.

## Security

To report a vulnerability or review our supported versions and disclosure process, see [SECURITY.md](SECURITY.md).

## License

MIT
