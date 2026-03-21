# Ralph Hero

A [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) that turns Claude into an autonomous software engineer. Ralph triages issues, researches codebases, writes implementation plans, codes in isolated worktrees, creates PRs, and merges -- all driven by a GitHub Projects V2 board.

> *The naive hero picks tickets, does their best work, and moves on.*

## How It Works

Ralph manages GitHub issues through a structured workflow state machine:

```
Backlog → Research Needed → Research in Progress → Ready for Plan
       → Plan in Progress → Plan in Review → In Progress → In Review → Done
```

Each transition is enforced by hooks and validated by the MCP server. Issues flow through phases -- triage, research, planning, review, implementation, and merge -- with human checkpoints at plan review and code review.

**Autonomous mode** (`/ralph-hero:hero`): Ralph drives an issue tree end-to-end, splitting large tickets, researching each sub-issue, creating plans, and implementing them sequentially.

**Interactive mode**: Use individual skills like `/ralph-hero:plan` or `/ralph-hero:impl` with human-in-the-loop verification at each step.

**Team mode** (`/ralph-hero:team`): Spawns parallel specialist agents (analyst, builder, integrator) to process issues concurrently.

## Installation

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Node.js 18+
- A GitHub Personal Access Token with `repo` and `project` scopes

### Install the Plugin

```bash
claude plugins add cdubiel08/ralph-hero
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
/ralph-hero:setup
```

This creates a GitHub Projects V2 board with the required custom fields: **Workflow State**, **Priority**, and **Estimate**.

## Skills

### Autonomous Workflow

Run the full pipeline or individual phases:

| Skill | Description |
|-------|-------------|
| `/ralph-hero:hero` | Drive an issue through the full lifecycle end-to-end |
| `/ralph-hero:team` | Multi-agent team with parallel analyst, builder, and integrator workers |
| `/ralph-hero:ralph-triage` | Assess backlog issues -- close duplicates, split large tickets, route to research |
| `/ralph-hero:ralph-research` | Investigate an issue, create a research document, update issue state |
| `/ralph-hero:ralph-plan` | Create an implementation plan from research findings |
| `/ralph-hero:ralph-review` | Review and critique plans (interactive or automated) |
| `/ralph-hero:ralph-impl` | Implement one phase of an approved plan in an isolated worktree |
| `/ralph-hero:ralph-val` | Validate implementation against plan requirements |
| `/ralph-hero:ralph-pr` | Push branch and create a pull request |
| `/ralph-hero:ralph-merge` | Merge an approved PR, clean up worktree, move issues to Done |
| `/ralph-hero:ralph-split` | Decompose M/L/XL issues into XS/S sub-issues |

### Interactive Workflow

Human-in-the-loop skills for collaborative development:

| Skill | Description |
|-------|-------------|
| `/ralph-hero:draft` | Quickly capture an idea for later refinement |
| `/ralph-hero:form` | Crystallize draft ideas into structured GitHub issues |
| `/ralph-hero:research` | Interactive codebase research with parallel sub-agents |
| `/ralph-hero:plan` | Create implementation plans through collaborative exploration |
| `/ralph-hero:iterate` | Refine or extend an existing plan |
| `/ralph-hero:impl` | Implement an approved plan phase-by-phase with manual verification |

### Project Management

| Skill | Description |
|-------|-------------|
| `/ralph-hero:hello` | Session briefing -- pipeline status, hygiene warnings, actionable insights |
| `/ralph-hero:status` | Pipeline dashboard with health indicators and WIP violations |
| `/ralph-hero:report` | Generate and post a project status report to GitHub |
| `/ralph-hero:ralph-hygiene` | Identify archive candidates, stale items, and board health issues |
| `/ralph-hero:setup` | One-time project board setup with required fields |
| `/ralph-hero:setup-repos` | Bootstrap multi-repo portfolio management |
| `/ralph-hero:idea-hunt` | Scout GitHub for interesting ideas, trends, and inspiration |
| `/ralph-hero:record-demo` | Record an annotated product demo and attach to an issue |

## MCP Server

The plugin bundles an MCP server ([`ralph-hero-mcp-server`](https://www.npmjs.com/package/ralph-hero-mcp-server)) that provides GitHub Projects V2 tools to Claude Code via the [Model Context Protocol](https://modelcontextprotocol.io/).

### Tools

| Tool | Description |
|------|-------------|
| `health_check` | Validate API connectivity, tokens, repo/project access, and required fields |
| `get_project` | Fetch project metadata, fields, and items |
| `setup_project` | Create or configure a project with required fields and workflow states |
| `get_issue` | Get full issue details with project fields, sub-issues, and dependencies |
| `list_issues` | Query issues with filtering, sorting, and pagination |
| `save_issue` | Create or update issues with project field values (workflow state, priority, estimate) |
| `create_issue` | Create a new issue and add it to the project |
| `create_draft_issue` | Create a draft issue on the project board |
| `get_draft_issue` | Fetch a draft issue by ID |
| `update_draft_issue` | Update a draft issue's title or body |
| `convert_draft_issue` | Convert a draft issue to a real issue |
| `create_comment` | Add a comment to an issue |
| `create_status_update` | Post a status update to the project |
| `add_sub_issue` | Add a sub-issue relationship |
| `list_sub_issues` | List sub-issues of a parent |
| `add_dependency` | Add a blocking dependency between issues |
| `remove_dependency` | Remove a blocking dependency |
| `list_dependencies` | List blocking and blocked-by relationships |
| `list_groups` | List detected issue groups (epics, features) |
| `advance_issue` | Move an issue to the next workflow state with validation |
| `batch_update` | Bulk-update project fields across multiple issues |
| `archive_items` | Archive single or multiple project items |
| `pipeline_dashboard` | Aggregated pipeline view with counts per workflow state, WIP violations, and velocity metrics |
| `detect_stream_positions` | Detect issue positions in the workflow stream |
| `project_hygiene` | Board health report -- stale items, orphans, field gaps |
| `pick_actionable_issue` | Find the highest-priority actionable issue for a given workflow phase |
| `decompose_feature` | Cross-repo feature decomposition using `.ralph-repos.yml` registry |

### Architecture

```
plugin/ralph-hero/
├── .claude-plugin/plugin.json     # Plugin manifest
├── .mcp.json                      # MCP server configuration
├── mcp-server/                    # TypeScript MCP server
│   └── src/
│       ├── index.ts               # Server entrypoint
│       ├── github-client.ts       # GraphQL client (rate limiting, caching, dual-token)
│       ├── types.ts               # GitHub Projects V2 type definitions
│       ├── tools/                 # Tool implementations
│       │   ├── issue-tools.ts
│       │   ├── project-tools.ts
│       │   ├── project-management-tools.ts
│       │   ├── relationship-tools.ts
│       │   ├── batch-tools.ts
│       │   ├── dashboard-tools.ts
│       │   ├── hygiene-tools.ts
│       │   ├── decompose-tools.ts
│       │   └── debug-tools.ts
│       ├── lib/                   # Shared libraries
│       │   ├── workflow-states.ts  # State machine definitions
│       │   ├── cache.ts            # Session and field option caching
│       │   ├── rate-limiter.ts     # Proactive rate limit tracking
│       │   ├── pagination.ts       # GraphQL cursor pagination
│       │   ├── dashboard.ts        # Pipeline aggregation logic
│       │   ├── hygiene.ts          # Board health analysis
│       │   ├── metrics.ts          # Velocity and throughput metrics
│       │   ├── group-detection.ts  # Epic/feature group detection
│       │   ├── pipeline-detection.ts
│       │   ├── filter-profiles.ts  # Query filter presets
│       │   ├── state-resolution.ts # State conflict resolution
│       │   ├── routing-engine.ts   # Issue routing logic
│       │   ├── repo-registry.ts    # Multi-repo registry types
│       │   └── ...
│       └── __tests__/             # 38 test files (vitest)
├── skills/                        # 30 skill definitions
├── agents/                        # 10 specialized agents
├── hooks/                         # 50+ workflow enforcement hooks
└── scripts/                       # CLI and automation scripts
```

## Agents

Ralph uses specialized agents for parallel task execution:

| Agent | Role |
|-------|------|
| `ralph-analyst` | Triage, split, research, and plan composition |
| `ralph-builder` | Plan review and code implementation |
| `ralph-integrator` | Validation, PR creation, merge, worktree cleanup |
| `codebase-locator` | Find files and components relevant to a topic |
| `codebase-analyzer` | Understand implementation details with file:line references |
| `codebase-pattern-finder` | Find similar patterns and usage examples |
| `thoughts-locator` | Discover prior research docs, plans, and decisions |
| `thoughts-analyzer` | Extract key decisions, constraints, and insights from thought documents |
| `web-search-researcher` | External API docs and best practices research |
| `github-lister` | Search GitHub for trending repos and patterns |
| `github-analyzer` | Analyze GitHub findings and synthesize insights |

## Hooks

Ralph enforces workflow integrity through lifecycle hooks:

- **State gates** -- Verify issues are in the correct workflow state before skills run
- **Branch gates** -- Ensure operations requiring main branch are on main
- **Worktree gates** -- Validate worktree setup for implementation
- **Postcondition validators** -- Confirm expected outputs (documents committed, comments posted, state changed)
- **Artifact validators** -- Ensure research/plan documents follow naming conventions
- **Lock management** -- Prevent concurrent processing of the same issue
- **Team protocol validators** -- Enforce multi-agent coordination rules

## CI/CD

| Workflow | Trigger | Description |
|----------|---------|-------------|
| `ci.yml` | PR to main | Build + test across Node 18, 20, 22 |
| `release.yml` | Push to main | Auto-bump version, publish to npm with provenance |
| `route-issues.yml` | Issue opened | Route new issues to project board |
| `sync-issue-state.yml` | Issue state change | Sync GitHub issue state with project workflow |
| `sync-pr-merge.yml` | PR merged | Move linked issues to Done |
| `sync-project-state.yml` | Project field change | Sync project state changes back to issues |
| `advance-parent.yml` | Sub-issue state change | Auto-advance parent when all children reach a gate state |

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `RALPH_HERO_GITHUB_TOKEN` | Yes | GitHub PAT with `repo` + `project` scopes |
| `RALPH_GH_OWNER` | Yes | GitHub owner (user or org) |
| `RALPH_GH_PROJECT_NUMBER` | Yes | GitHub Projects V2 number |
| `RALPH_GH_REPO` | No | Repository name (inferred from project if omitted) |
| `RALPH_GH_PROJECT_NUMBERS` | No | Comma-separated project numbers for cross-project dashboard |
| `RALPH_GH_PROJECT_OWNER` | No | Project owner if different from repo owner |
| `RALPH_GH_REPO_TOKEN` | No | Separate repo token (falls back to main token) |
| `RALPH_GH_PROJECT_TOKEN` | No | Separate project token (falls back to repo token) |

Set all variables in `.claude/settings.local.json` under the `"env"` key. Do not put tokens in `.mcp.json`.

## Development

```bash
cd plugin/ralph-hero/mcp-server
npm install
npm run build
npm test
```

Tests use [Vitest](https://vitest.dev/) with 38 test files covering tools, lib modules, and integration scenarios.

**Release process**: Merges to `main` that touch MCP server source automatically bump the version, tag, and publish to npm. Include `#minor` or `#major` in a commit message for larger version bumps.

## License

MIT
