# Ralph Hero

A [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) that turns Claude into an autonomous software engineer. Ralph triages issues, researches codebases, writes implementation plans, codes in isolated worktrees, creates PRs, and merges — all driven by a GitHub Projects V2 board.

> *The naive hero picks tickets, does their best work, and moves on.*

## How It Works

Ralph manages GitHub issues through a structured workflow state machine:

```
Backlog → Research Needed → Research in Progress → Ready for Plan
       → Plan in Progress → Plan in Review → In Progress → In Review → Done
```

Each transition is enforced by hooks and validated by the MCP server. Issues flow through phases — triage, research, planning, review, implementation, and merge — autonomous by default, with a human checkpoint only when a plan raises an open design decision (it holds in Plan in Review with a `## Decision Request` comment until you answer) or a reviewer requests changes on the PR (`CHANGES_REQUESTED` always blocks merge).

**Autonomous mode** (`/ralph:hero`): Ralph drives an issue tree end-to-end, splitting large tickets, researching each sub-issue, creating plans, and implementing them.

**Interactive mode**: Use individual skills like `/ralph:plan` or `/ralph:impl` with human-in-the-loop verification at each step.

## Installation

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Node.js 20+
- A GitHub Personal Access Token with `repo` and `project` scopes

### Install the Plugin

```bash
claude plugins add cdubiel08/ralph-hero --plugin ralph
```

### Configure

Add your GitHub token and project settings to `.claude/settings.local.json` (gitignored):

```json
{
  "env": {
    "RALPH_HERO_GITHUB_TOKEN": "ghp_your_token_here",
    "RALPH_GH_OWNER": "your-github-username",
    "RALPH_GH_PROJECT_NUMBER": "1"
  }
}
```

### Set Up Your Project Board

```
/ralph:setup
```

This creates a GitHub Projects V2 board with the required custom fields: **Workflow State**, **Priority**, and **Estimate**.

## Token Expired?

```bash
gh auth refresh -s repo,project,read:org
```

Then restart Claude Code.

If you're using explicit `RALPH_GH_REPO_TOKEN` / `RALPH_GH_PROJECT_TOKEN` / `RALPH_HERO_GITHUB_TOKEN`: regenerate the PAT at https://github.com/settings/tokens, update `~/.claude/settings.json` (or `.claude/settings.local.json`), restart Claude Code.

## Skills

| Skill | Description |
|-------|-------------|
| `/ralph:hero` | Drive an issue through the full lifecycle end-to-end (autonomous) |
| `/ralph:hero-fable` | Experimental rail-free surface for Fable: outcome + boundaries + artifact contract, no prescribed phases (`/ralph:hero --model fable` forwards here) |
| `/ralph:research` | Investigate an issue, create a research document, update issue state |
| `/ralph:plan` | Create or review an implementation plan |
| `/ralph:impl` | Implement an approved plan in an isolated worktree |
| `/ralph:review` | Validate implementation or review a plan |
| `/ralph:caretake` | Triage, hygiene, unblock, report |
| `/ralph:catch-up` | Session orientation — narrative or status report |
| `/ralph:form` | Crystallize ideas into structured GitHub issues |
| `/ralph:setup` | One-time project board setup |

## MCP Server

The plugin bundles an MCP server ([`ralph-hero-mcp-server`](https://www.npmjs.com/package/ralph-hero-mcp-server)) that provides GitHub Projects V2 tools to Claude Code via the [Model Context Protocol](https://modelcontextprotocol.io/).

### Tools

The MCP server registers ~31 `ralph_hero__*` tools; the table below is a curated subset of the most-used ones (issue/project CRUD, relationships, dashboards, trends). Additional tools include `create_sub_issues`, `decompose_feature`, `archive_items`, `sync_plan_graph`, `remove_dependency`, and the `sre__*` autoremediation set; debug tools register only when `RALPH_DEBUG=true`.

| Tool | Description |
|------|-------------|
| `health_check` | Validate API connectivity, tokens, repo/project access, and required fields |
| `get_project` | Fetch project metadata, fields, and items |
| `setup_project` | Create or configure a project with required fields and workflow states |
| `get_issue` | Get full issue details with project fields, sub-issues, and dependencies |
| `list_issues` | Query issues with filtering, sorting, and pagination |
| `save_issue` | Create or update issues with project field values (workflow state, priority, estimate) |
| `create_issue` | Create a new issue and add it to the project |
| `create_comment` | Add a comment to an issue |
| `create_status_update` | Post a status update to the project |
| `add_sub_issue` | Add a sub-issue relationship |
| `list_sub_issues` | List sub-issues of a parent |
| `add_dependency` | Add a blocking dependency between issues |
| `list_dependencies` | List blocking and blocked-by relationships |
| `advance_issue` | Move an issue to the next workflow state with validation |
| `batch_update` | Bulk-update project fields across multiple issues |
| `pipeline_dashboard` | Aggregated pipeline view with counts per workflow state and health indicators |
| `project_hygiene` | Board health report — stale items, orphans, field gaps |
| `next_actions` | Ranked list of recommended next actions |
| `recent_activity` | Read per-session activity log |
| `capture_snapshot` | Capture pipeline snapshot for trend tracking |
| `metrics_trends` | 1d/7d/30d velocity and WIP trends |

### Architecture

```
mcp-server/              # TypeScript MCP server (published as ralph-hero-mcp-server)
ralph/                   # Claude Code plugin
├── skills/              # 9 fat verbs + experimental hero-fable surface
├── agents/              # 15 agents (7 per-phase + 8 investigators)
├── hooks/               # Lifecycle enforcement hooks
└── .claude-plugin/      # Plugin manifest + .mcp.json
plugin/
├── ralph-knowledge/     # Semantic search over thoughts/ documents
├── ralph-playwright/    # Polymorphic UI testing
└── ralph-demo/          # Sprint demo video generation
```

## CI/CD

| Workflow | Trigger | Description |
|----------|---------|-------------|
| `ci.yml` | PR to main | Build + test; hook tests; workflow lint |
| `release.yml` | mcp-server/ changes on main | Auto-bump version, publish to npm with provenance, pin ralph/.mcp.json |
| `release-ralph.yml` | ralph/ changes on main | Bump ralph plugin version + tag |
| `route-issues.yml` | Issue opened | Route new issues to project board |
| `sync-issue-state.yml` | Issue state change | Sync GitHub issue state with project workflow |
| `sync-pr-merge.yml` | PR merged | Move linked issues to Done |
| `sync-project-state.yml` | Project field change | Sync project state changes back to issues |
| `advance-parent.yml` | Sub-issue state change | Auto-advance parent when all children reach a gate state |

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `RALPH_HERO_GITHUB_TOKEN` | No (defaults to `gh auth token`) | GitHub PAT with `repo` + `project` scopes |
| `RALPH_GH_OWNER` | Yes | GitHub owner (user or org) |
| `RALPH_GH_PROJECT_NUMBER` | Yes | GitHub Projects V2 number |
| `RALPH_GH_REPO` | No | Repository name (inferred from project if omitted) |
| `RALPH_GH_PROJECT_NUMBERS` | No | Comma-separated project numbers for cross-project dashboard |
| `RALPH_GH_PROJECT_OWNER` | No | Project owner if different from repo owner |
| `RALPH_GH_REPO_TOKEN` | No | Separate repo token (falls back to main token) |
| `RALPH_GH_PROJECT_TOKEN` | No | Separate project token (falls back to repo token) |
| `RALPH_IMPL_MODEL` | No | Override model for `impl-agent` (`sonnet`, `opus`, or `fable`; default `sonnet`; BLOCKED escalation re-dispatches once at `opus`) |
| `RALPH_REVIEW_PLAN` | No | Plan-review gate (default `auto`, decision-driven: decision-free APPROVED plans auto-advance; plans with open `#### Decision:` blocks hold with a `## Decision Request` comment). `interactive` opts into the whole-plan picker. |
| `RALPH_REVIEW_MODE` | No | Merge gate (default `auto`: val → code-review → merge → CI watch unattended; `CHANGES_REQUESTED` always blocks). `interactive` opts into report-PR-URLs-and-stop. |
| `RALPH_AUTOPILOT_ENABLE` | No | Must be `"true"` for `/ralph:hero --mode auto` (enforced by `autopilot-enable-gate.sh`) |
| `RALPH_DEBUG` | No | Enable JSONL debug logging + OpenTelemetry export |

Set all variables in `.claude/settings.local.json` under the `"env"` key. Do not put tokens in `.mcp.json`.

## Development

```bash
cd mcp-server
npm install
npm run build
npm test
```

Tests use [Vitest](https://vitest.dev/).

**Release process**: Merges to `main` that touch `mcp-server/src/**` automatically bump the version, publish to npm, and pin `ralph/.mcp.json`. Include `#minor` or `#major` in a commit message for larger version bumps.

## Security

To report a vulnerability or review our supported versions and disclosure process, see [SECURITY.md](SECURITY.md).

## License

MIT
