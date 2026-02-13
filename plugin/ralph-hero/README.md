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
claude "/ralph-setup"
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
| `/ralph-triage` | Assess backlog issues, close duplicates, route to research |
| `/ralph-split` | Split large issues (M/L/XL) into smaller sub-issues |
| `/ralph-research` | Research one XS/S issue, create findings document |
| `/ralph-plan` | Create implementation plan from researched issue |
| `/ralph-review` | Review implementation plan for quality |
| `/ralph-impl` | Implement one planned issue in isolated worktree |

### Orchestrators

| Skill | Description |
|-------|-------------|
| `/ralph-hero` | Tree-expansion orchestrator with task blocking for sequential execution |
| `/ralph-team` | Multi-agent coordinator that spawns specialists for each pipeline phase |

### Loop Scripts

For fully autonomous operation:

```bash
# Full autonomous loop (sequential phases)
./scripts/ralph-loop.sh

# Individual phases only
./scripts/ralph-loop.sh --triage-only
./scripts/ralph-loop.sh --research-only
./scripts/ralph-loop.sh --plan-only
./scripts/ralph-loop.sh --impl-only

# Control split and review behavior
./scripts/ralph-loop.sh --split=auto     # Auto-split large issues (default)
./scripts/ralph-loop.sh --split=skip     # Skip splitting
./scripts/ralph-loop.sh --review=auto    # Enable auto-review of plans
./scripts/ralph-loop.sh --review=skip    # Skip review (default)

# Team orchestrator (parallel multi-agent)
./scripts/ralph-team-loop.sh             # Auto-detect work
./scripts/ralph-team-loop.sh 42          # Process issue #42
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RALPH_HERO_GITHUB_TOKEN` | Yes* | Single token with repo + project scopes |
| `RALPH_GH_REPO_TOKEN` | No | Separate token for repo operations (issues, PRs, comments) |
| `RALPH_GH_PROJECT_TOKEN` | No | Separate token for project operations (fields, workflow state) |
| `RALPH_GH_OWNER` | Yes | Repository owner (user or org) |
| `RALPH_GH_REPO` | Yes | Repository name |
| `RALPH_GH_PROJECT_OWNER` | No | Project owner if different from repo owner |
| `RALPH_GH_PROJECT_NUMBER` | Yes | GitHub Project V2 number |
| `MAX_ITERATIONS` | No | Max loop iterations (default: 10) |
| `TIMEOUT` | No | Per-task timeout (default: 15m) |

*Either `RALPH_HERO_GITHUB_TOKEN` or `RALPH_GH_REPO_TOKEN` must be set.

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
│   ├── ralph-triage/
│   ├── ralph-split/
│   ├── ralph-research/
│   ├── ralph-plan/
│   ├── ralph-review/
│   ├── ralph-impl/
│   ├── ralph-hero/
│   ├── ralph-team/
│   └── ralph-setup/
├── agents/                   # Specialized agent definitions
│   ├── ralph-triager.md
│   ├── ralph-researcher.md
│   ├── ralph-planner.md
│   ├── ralph-advocate.md
│   └── ralph-implementer.md
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
