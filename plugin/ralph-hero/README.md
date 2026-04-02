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

### Orchestrators

| Skill | Description |
|-------|-------------|
| `/ralph-hero:hero` | Tree-expansion orchestrator with task blocking for sequential execution |
| `/ralph-hero:team` | Multi-agent coordinator that spawns specialists for each pipeline phase |

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
