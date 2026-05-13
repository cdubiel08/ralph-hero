# Ralph Hero

The naive hero picks tickets, does their best work, and moves on. No questions, no interruptions - just ship it.

An autonomous development workflow plugin for Claude Code with GitHub Issues + Projects V2 integration. Ralph automates the full software development lifecycle: triage, research, planning, review, and implementation.

## Prerequisites

- **Node.js 18+** (for the bundled MCP server)
- **GitHub Personal Access Token** with scopes: `project`, `repo`, `read:org`
- **Claude Code** (latest version)

## Installation

### From Git Repository

```bash
claude plugin install https://github.com/cdubiel08/ralph-hero
```

### Local Development

```bash
claude --plugin-dir ./ralph-hero
```

### Manual Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/cdubiel08/ralph-hero.git
   ```

2. Build the MCP server:
   ```bash
   cd ralph-hero/mcp-server
   npm install
   npm run build
   ```

3. Set environment variables:
   ```bash
   # Single-token setup (simplest)
   export RALPH_HERO_GITHUB_TOKEN="ghp_your_token_here"
   export RALPH_GH_OWNER="your-github-username-or-org"
   export RALPH_GH_REPO="your-repository-name"
   export RALPH_GH_PROJECT_NUMBER="1"  # Set after running setup

   # For org repos where project is owned by a different user:
   export RALPH_GH_REPO_TOKEN="ghp_org_repo_token"
   export RALPH_GH_PROJECT_TOKEN="ghp_personal_project_token"
   export RALPH_GH_PROJECT_OWNER="your-personal-username"
   ```

## Setup

Run the setup skill to create a GitHub Project with all required configuration:

```bash
claude "/ralph-hero:setup"
```

This creates:
- A GitHub Projects V2 board with custom fields:
  - **Workflow State** (11 states: Backlog through Done)
  - **Priority** (P0 through P3)
  - **Estimate** (XS, S, M, L, XL)
- Four default views (Research Pipeline, Planning Pipeline, Active Development, All Items)
- Local configuration file at `.claude/ralph-hero.local.md`

## Usage

### Individual Skills

Each skill handles one phase of the workflow:

| Skill | Description |
|-------|-------------|
| `/ralph-hero:ralph-triage` | Assess backlog issues, close duplicates, route to research |
| `/ralph-hero:ralph-split` | Split large issues (M/L/XL) into smaller sub-issues |
| `/ralph-hero:ralph-research` | Research one XS/S issue, create findings document |
| `/ralph-hero:ralph-plan` | Create implementation plan from researched issue |
| `/ralph-hero:ralph-review` | Review implementation plan for quality |
| `/ralph-hero:ralph-impl` | Implement one planned issue in isolated worktree |
| `/ralph-hero:ralph-debug-collate` | Collate Langfuse error spans, file `debug-auto` issues for self-healing observability (interactive dry-run → confirm → file) |

### Trends

Ralph captures a daily JSONL snapshot of each project (velocity, riskScore, WIP, points-by-phase, lead-time percentiles) under `~/.ralph-hero/snapshots/<owner>/<projectNumber>.jsonl`. The `/trends` skill captures a fresh row and prints a markdown report with sparklines and 1d/7d/30d deltas — read-only, nothing is posted back to GitHub.

```bash
# Default — capture now, trend the last 7 days
claude "/ralph-hero:trends"

# Wider window
claude "/ralph-hero:trends --since 30d"
```

Sample output:

```
## velocity   ▁▂▃▄▅▆▇█   12.3
- 1d: +1.2   7d: +4.5   30d: +9.1

## riskScore  █▇▆▅▄▃▂▁   0.27
- 1d: -0.04  7d: -0.18  30d: -0.42
```

Under the hood:

- `ralph_hero__capture_snapshot` appends one schema-versioned row to the JSONL file.
- `ralph_hero__metrics_trends` reads the file, computes deltas, and renders markdown or JSON.
- An optional launchd template at `plugin/ralph-hero/scripts/snapshot/launchd/com.ralph.snapshot.plist.template` schedules a daily capture so history accumulates without manual runs.
- A 30-row reference fixture lives at `plugin/ralph-hero/mcp-server/src/__tests__/fixtures/snapshots.fixture.jsonl` for tests and as a documentation example of the on-disk format.

### Orchestrators

| Skill | Description |
|-------|-------------|
| `/ralph-hero:hero` | Tree-expansion orchestrator with task blocking for sequential execution |
| `/ralph-hero:team` | Multi-agent coordinator that spawns specialists for each pipeline phase |

### `/ralph-hero:autopilot` — Backlog Clearer

Thin wrapper around `/loop /ralph-hero:hero`. Delegates wakeup cadence to `/loop`'s dynamic mode (model self-paces) and trusts hero for every per-issue decision, including escalation to `Human Needed`. Drains the queue end-to-end.

**Opt-in (enforced by hook)**: `export RALPH_AUTOPILOT_ENABLE=true` before invoking. The skill is gated by `autopilot-enable-gate.sh` — if the env var is not `true`, the inner `/loop` dispatch is blocked with a deterministic message. No LLM in the loop.

**Invocation**:
- `/ralph-hero:autopilot` — drain the queue

**How it terminates**: `/loop` in dynamic mode keeps re-firing until the model decides to stop calling `ScheduleWakeup`. The skill prompt instructs the model to stop when the filtered queue (excludes `Done`, `Canceled`, `Human Needed`) is empty. Hero's escalation decisions move issues to `Human Needed` automatically, which removes them from the next pick.

**Review mode is inherited, not overridden**: autopilot does NOT set `RALPH_REVIEW_MODE` itself. For end-to-end runs (ticket → RPI → review → merge), set `RALPH_REVIEW_MODE=auto` (and any other env hero/finish/merge need) before invoking. With interactive mode, hero lands PRs and stops; autopilot drains forward-progress work but in-review PRs await human merge.

**Run unblock alongside**: `/ralph-hero:ralph-unblock` (autonomous) or `/ralph-hero:unblock` (interactive) drains `Human Needed` work. Autopilot and unblock are designed to run concurrently — autopilot never picks `Human Needed` issues, unblock only picks them.

**Cancel an in-flight loop**: use `/tasks` to find the pending wakeup and delete it via the cron tools — same as any `/loop` dynamic-mode run.

### CLI (`just` recipes)

Ralph also provides a `just`-based CLI for running workflows from the terminal with budget and timeout controls, plus zero-cost quick actions via [mcptools](https://github.com/f/mcptools):

```bash
cd plugin/ralph-hero

just                    # List all recipes
just triage 42          # Triage issue #42
just impl 42 budget=8   # Implement with higher budget
just loop               # Full autonomous loop
just team 42            # Multi-agent team on #42
just doctor             # Diagnose setup issues
just quick-status       # Instant pipeline dashboard (no LLM)
just quick-move 42 "In Progress"  # Move issue state (no LLM)
```

See the full **[CLI Reference](docs/cli.md)** for all recipes, parameters, and shell completions.

## How It Works

Ralph drives GitHub issues through a fully automated development lifecycle with one command:

```bash
claude "/ralph-team 42"
```

A multi-agent team spins up automatically — analyst, builder, and integrator — each handling their phase of the pipeline in sequence:

```
Issue #42
  │
  ▼
[Analyst]  Triage → Research → Plan
  │         Backlog → Research Needed → Ready for Plan → Plan in Review
  │
  ▼
[Builder]  Implement → PR
  │         In Progress → In Review
  │
  ▼
[Integrator]  Validate → Merge
               In Review → Done
```

Each stage produces a durable artifact committed to git:
- **Research** → `thoughts/shared/research/YYYY-MM-DD-GH-NNN-description.md`
- **Plan** → `thoughts/shared/plans/YYYY-MM-DD-GH-NNN-description.md`
- **Implementation** → feature branch in a git worktree
- **PR** → GitHub pull request with `Closes #NNN`

GitHub Projects V2 is the source of truth for state — the board updates in real-time as agents advance issues through workflow states.

### Demo

> **[Demo recording — coming soon]()**
>
> A real `/ralph-team` session processing an umbrella issue with 3 XS sub-issues end-to-end:
> issue detection → triage → research → plan → implementation → PR merged → Done.

**Key moments:**
- `0:00` — Single command entry point: `/ralph-team NNN`
- `0:30` — TeamCreate: analyst/builder/integrator spawned with task list coordination
- `1:00` — Issues move on the GitHub Projects board as workflow states change
- `3:00` — Research document committed to git; issue advances to Ready for Plan
- `5:00` — Implementation plan committed; issue advances to Plan in Review
- `7:00` — PR opens, CI runs — standard GitHub flow, nothing proprietary
- `9:00` — PR merged, board shows Done; end-to-end traceability complete

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RALPH_HERO_GITHUB_TOKEN` | Yes* | Single token with repo + project scopes |
| `RALPH_GH_REPO_TOKEN` | No | Separate token for repo operations (issues, PRs, comments) |
| `RALPH_GH_PROJECT_TOKEN` | No | Separate token for project operations (fields, workflow state) |
| `RALPH_GH_OWNER` | Yes | Repository owner (user or org) |
| `RALPH_GH_REPO` | No† | Repository name |
| `RALPH_GH_PROJECT_OWNER` | No | Project owner if different from repo owner |
| `RALPH_GH_PROJECT_NUMBER` | Yes | GitHub Project V2 number |
| `MAX_ITERATIONS` | No | Max loop iterations (default: 10) |
| `TIMEOUT` | No | Per-task timeout (default: 15m) |

*Either `RALPH_HERO_GITHUB_TOKEN` or `RALPH_GH_REPO_TOKEN` must be set.

†`RALPH_GH_REPO` is inferred from the repositories linked to the project (via `link_repository`). It only needs to be set explicitly as a tiebreaker when multiple repos are linked. Bootstrap: run `setup_project` → `link_repository` → repo is inferred automatically.

### Token Scopes

Your GitHub token(s) need these scopes:

| Scope | Purpose |
|-------|---------|
| `repo` | Create/modify issues, comments, PRs |
| `project` | Create/modify Projects V2, fields, views |
| `read:org` | Access organization-level projects |

For **single-token** setups, one token needs all scopes.

For **dual-token** setups (org repo + personal project):
- `RALPH_GH_REPO_TOKEN` needs `repo` + `read:org` scopes
- `RALPH_GH_PROJECT_TOKEN` needs `project` scope

Create tokens at: https://github.com/settings/tokens/new

**Important**: After changing environment variables, restart Claude Code for the MCP server to pick up the new values.

## Delegation (optional)

ralph-hero ships with an opt-in delegation wrapper, `plugin/ralph-hero/scripts/ralph-delegate.sh`, that lets skills offload narrow sub-tasks (locator ranking, PR-description drafting, pass/fail classification, etc.) to a local or cheaper OpenAI-compatible endpoint instead of the primary Claude session. **The feature is fully gated on `RALPH_DELEGATE_ENABLED=true`** — with the variable unset (the default), ralph-hero behavior is bit-identical to today: no extra HTTP calls, no audit-log writes, no behavioral drift.

It reuses the existing `RALPH_LLM_URL` (default `http://localhost:8000`) and `RALPH_LLM_MODEL` (default `mlx-community/gemma-4-26b-a4b-it-mxfp8`) values that the ralph-knowledge plugin and the dream-loop already honor, so a single endpoint configuration works across all ralph features.

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `RALPH_DELEGATE_ENABLED` | unset (treated as `false`) | Master opt-in toggle. Anything other than `true`/`1`/`yes`/`on` exits 126 immediately. |
| `RALPH_DELEGATE_TIMEOUT_SECONDS` | `60` | Per-call timeout, enforced via `portable_timeout`. |
| `RALPH_DELEGATE_LOG_PATH` | `~/.ralph-hero/delegate.log` | JSONL audit log path. One line per attempt (except 126). |
| `RALPH_DELEGATE_<TASK_UPPER>_URL` | falls back to `RALPH_LLM_URL` | Per-task endpoint override (e.g. `RALPH_DELEGATE_LOCATOR_URL`). |
| `RALPH_DELEGATE_<TASK_UPPER>_MODEL` | falls back to `RALPH_LLM_MODEL` | Per-task model override (e.g. `RALPH_DELEGATE_LOCATOR_MODEL`). |

### Exit codes

The wrapper obeys a fixed 5-value contract so callers can switch on `$?` without parsing stderr:

| Code | Meaning | Caller behavior |
|------|---------|-----------------|
| 0 | Success | Use stdout as the model's completion |
| 1 | Hard error (parse failure, HTTP 4xx/5xx) | Caller falls back; log records `parse_error` or `http_<code>` |
| 124 | Timeout (GNU timeout convention) | Caller falls back; log records `timeout` |
| 126 | Delegation disabled | Caller does work natively, **no** audit-log noise |
| 127 | Endpoint unreachable | Caller falls back; log records `unreachable` |

The 126 vs 127 split is intentional: 126 means "operator chose not to delegate" (silent skip); 127 means "operator opted in but the endpoint is down" (visible degradation worth noticing).

### Quick check

```bash
gemma-up   # start the local Gemma server on :8000 (see ../../CLAUDE.md)
export RALPH_DELEGATE_ENABLED=true
bash plugin/ralph-hero/scripts/ralph-delegate.sh --health-check
```

`--health-check` issues a `GET ${RALPH_LLM_URL}/v1/models` with a hard 2s timeout and returns 0 if the endpoint replies 200, 127 otherwise. The JSONL audit log records every attempt as a `status=ok` or `status=unreachable` line.

### Audit log

Every invocation (except the disabled-126 short-circuit) appends one JSONL line to `~/.ralph-hero/delegate.log`:

```json
{"ts":"2026-05-12T02:38:34Z","task":"locator","model":"...","url":"...","ms":284,"status":"ok","bytes_in":1340,"bytes_out":612,"caller":"<skill-name>"}
```

The `status` field is one of `ok` | `timeout` | `unreachable` | `parse_error` | `http_<code>` | `dry_run`. This log is consumed by upcoming telemetry tooling (see epic [#965](https://github.com/cdubiel08/ralph-hero/issues/965), Feature F5).

### Authoring a delegating skill

Skills can call `ralph-delegate.sh` from a `Bash` tool block to offload narrow sub-tasks. The pattern is documented end-to-end in [`docs/delegation-authoring.md`](docs/delegation-authoring.md), with the eligible/ineligible matrix in [`skills/shared/delegation-conventions.md`](skills/shared/delegation-conventions.md). The reference implementation is [`skills/delegate-test/SKILL.md`](skills/delegate-test/SKILL.md) — invoke it as `/ralph-hero:delegate-test "<input>"` to confirm the delegation toolchain is working.

- Authoring guide: [`docs/delegation-authoring.md`](docs/delegation-authoring.md)
- Conventions (what's delegate-eligible): [`skills/shared/delegation-conventions.md`](skills/shared/delegation-conventions.md)

## Architecture

```
ralph-hero/
├── .claude-plugin/
│   └── plugin.json           # Plugin manifest
├── .mcp.json                 # Bundled MCP server configuration
├── mcp-server/               # TypeScript MCP server
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts          # Entry point + tool registration
│       ├── github-client.ts  # GraphQL client with auth, rate limiting, caching
│       ├── types.ts          # TypeScript types for Projects V2
│       ├── tools/
│       │   ├── project-tools.ts      # Project setup + query
│       │   ├── view-tools.ts         # View management
│       │   ├── issue-tools.ts        # Issue CRUD + state transitions
│       │   └── relationship-tools.ts # Sub-issues, dependencies, group detection
│       └── lib/
│           ├── pagination.ts     # Cursor-based pagination
│           ├── rate-limiter.ts   # Point-based rate limit tracker
│           ├── cache.ts          # Session-scoped LRU cache
│           └── group-detection.ts # Transitive closure + topological sort
├── skills/                   # Workflow skills (SKILL.md files)
│   ├── hello/                # Session briefing (user-visible)
│   ├── draft/                # Quick idea capture (user-visible)
│   ├── form/                 # Crystallize ideas (user-visible)
│   ├── plan/                 # Create implementation plan (user-visible)
│   ├── iterate/              # Iterate on plan (user-visible)
│   ├── impl/                 # Implement plan (user-visible)
│   ├── research/             # Codebase research (user-visible)
│   ├── hero/                 # Tree-expansion orchestrator (user-visible)
│   ├── team/                 # Multi-agent coordinator (user-visible)
│   ├── setup/                # Project setup (user-visible)
│   ├── status/               # Pipeline dashboard (user-visible)
│   ├── report/               # Status report (user-visible)
│   ├── ralph-triage/         # Autonomous triage (hidden)
│   ├── ralph-split/          # Autonomous split (hidden)
│   ├── ralph-research/       # Autonomous research (hidden)
│   ├── ralph-plan/           # Autonomous planning (hidden)
│   ├── ralph-review/         # Autonomous review (hidden)
│   ├── ralph-impl/           # Autonomous implementation (hidden)
│   ├── ralph-val/            # Validation (hidden)
│   ├── ralph-pr/             # PR creation (hidden)
│   ├── ralph-merge/          # Merge (hidden)
│   └── ralph-hygiene/        # Hygiene check (hidden)
├── agents/                   # Scope-bounded worker definitions
│   ├── ralph-analyst.md
│   ├── ralph-builder.md
│   └── ralph-integrator.md
├── hooks/                    # State machine enforcement
│   ├── hooks.json
│   └── scripts/
└── scripts/                  # Loop scripts for autonomous operation
    ├── ralph-loop.sh
    └── ralph-team-loop.sh
```

### MCP Server Tools

The bundled MCP server provides these tools:

| Tool | Description |
|------|-------------|
| `ralph_hero__health_check` | Verify GitHub API connectivity |
| `ralph_hero__setup_project` | Create project with custom fields |
| `ralph_hero__get_project` | Query project details and fields |
| `ralph_hero__list_project_items` | List items filtered by field values |
| `ralph_hero__list_views` | List project views |
| `ralph_hero__update_field_options` | Update single-select field options (colors, descriptions) |
| `ralph_hero__list_issues` | Query issues with field-based filtering |
| `ralph_hero__get_issue` | Get issue with full context |
| `ralph_hero__create_issue` | Create issue and add to project |
| `ralph_hero__update_issue` | Update issue properties |
| `ralph_hero__update_workflow_state` | Change workflow state |
| `ralph_hero__update_estimate` | Change estimate |
| `ralph_hero__update_priority` | Change priority |
| `ralph_hero__create_comment` | Add comment to issue |
| `ralph_hero__add_sub_issue` | Create parent/child relationship |
| `ralph_hero__list_sub_issues` | Get children of a parent issue |
| `ralph_hero__add_dependency` | Create blocks/blocked-by relationship |
| `ralph_hero__remove_dependency` | Remove a dependency |
| `ralph_hero__list_dependencies` | Get dependencies for an issue |
| `ralph_hero__detect_group` | Transitive closure + topological sort |

### Workflow States

The Ralph workflow uses an 11-state machine managed via a custom Projects V2 field:

```
Backlog -> Research Needed -> Research in Progress -> Ready for Plan
-> Plan in Progress -> Plan in Review -> In Progress
-> In Review -> Done

Any state -> Human Needed (escalation)
```

## Differences from Linear-Based Ralph

This plugin replaces the Linear-based Ralph workflow. Key differences:

| Aspect | Linear Ralph | GitHub Ralph |
|--------|-------------|--------------|
| Backend | Linear API | GitHub Issues + Projects V2 |
| State Management | Linear workflow states | Custom Projects V2 field |
| Ticket IDs | `PREFIX-NNN` | `#NNN` |
| Estimates | Integer (1-5) | String ("XS"/"S"/"M"/"L"/"XL") |
| Sub-issues | `parentId` parameter | `add_sub_issue` mutation |
| Dependencies | Bulk `blocks: [...]` | Per-pair `add_dependency` |
| Plan Discovery | Ticket attachments | Issue comments |
| PR Linking | Explicit link attachment | `Closes #NNN` in PR body |
| Tool Names | `mcp__plugin_linear_linear__*` | `ralph_hero__*` |

## License

MIT
