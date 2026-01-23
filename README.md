# Ralph Hero

The naive hero picks tickets, does their best work, and moves on. No questions, no interruptions - just ship it.

An autonomous development workflow plugin for Claude Code with Linear integration.

## Features

- **Autonomous Ticket Processing**: Triage, research, plan, and implement tickets without human intervention
- **Linear Integration**: Full workflow state management and ticket lifecycle
- **Git Worktree Isolation**: Safe, isolated development for each ticket
- **Exploration Agents**: Bundled agents for codebase navigation
- **Configurable Paths**: Customize where documents and worktrees live

## Prerequisites

1. **Claude Code** installed and configured
2. **Linear MCP server** installed (`/plugin install linear`)
3. **Git** with worktree support
4. **jq** for JSON parsing in scripts (optional but recommended)

## Installation

```bash
# Add the marketplace (if not already added)
/plugin marketplace add cdubiel08/ralph-hero

# Install the plugin
/plugin install ralph-hero
```

## Setup

Ralph automatically detects if it's configured when you start a session. If not configured, it will prompt you to run setup.

Run the setup wizard to configure Ralph for your project:

```bash
/ralph:setup
```

This will:
1. Discover your Linear teams and workflow states
2. Configure your GitHub repository URL
3. Set up document directories
4. Verify all required Linear states exist

Check your configuration status at any time:

```bash
/ralph:status           # Quick status check
/ralph:status --verbose # Detailed check with Linear connection test
```

## Usage

### Individual Commands

```bash
# Triage one backlog ticket
/ralph:triage

# Triage a specific ticket
/ralph:triage ENG-123

# Research a ticket
/ralph:research

# Create implementation plan
/ralph:plan

# Implement a ticket
/ralph:impl
```

### Full Autonomous Loop

```bash
# Run all phases until queues empty
./path/to/plugin/scripts/ralph-loop.sh

# Specific phases only
./path/to/plugin/scripts/ralph-loop.sh --triage-only
./path/to/plugin/scripts/ralph-loop.sh --research-only
./path/to/plugin/scripts/ralph-loop.sh --plan-only
./path/to/plugin/scripts/ralph-loop.sh --impl-only

# Custom iterations and timeout
MAX_ITERATIONS=5 TIMEOUT=20m ./path/to/plugin/scripts/ralph-loop.sh
```

## Workflow

Tickets flow through these Linear states:

```
Backlog → Research Needed → Research in Progress → Ready for Plan
                                                        ↓
                            Plan in Progress ← Ready for Plan
                                    ↓
                            Plan in Review → Todo
                                                ↓
                            In Progress ← Todo
                                    ↓
                            In Review → Done
```

## Configuration

Configuration is stored in `.ralph/config.json`:

```json
{
  "linear": {
    "teamName": "Your-Team",
    "teamId": "uuid",
    "states": { ... }
  },
  "github": {
    "repoUrl": "https://github.com/org/repo",
    "defaultBranch": "main"
  },
  "paths": {
    "worktreeBase": "../worktrees",
    "plansDir": "docs/plans",
    "researchDir": "docs/research",
    "ticketsDir": "docs/tickets"
  }
}
```

## Safety Constraints

- **XS/Small tickets only**: Larger tickets are skipped
- **PR only, no merge**: Human approves and merges
- **Worktree isolation**: Changes don't affect main branch
- **Timeout protection**: Tasks time out after configurable duration
- **Max iterations**: Loop stops after configurable iterations

## Commands Reference

| Command | Description |
|---------|-------------|
| `/ralph:setup` | Configure Ralph for your Linear workspace |
| `/ralph:status` | Check configuration status and health |
| `/ralph:triage` | Assess backlog tickets, close/split/keep |
| `/ralph:research` | Research tickets, create findings documents |
| `/ralph:plan` | Create implementation plans from research |
| `/ralph:impl` | Implement tickets phase-by-phase |
| `/ralph:linear` | Linear ticket management utilities |

## Hooks

Ralph uses hooks for automatic configuration management:

- **SessionStart**: Checks if configured and informs you of status
- **PreToolUse**: Validates configuration before Linear API operations

## Bundled Agents

| Agent | Description |
|-------|-------------|
| `codebase-locator` | Find files by topic/feature |
| `codebase-analyzer` | Analyze implementation details |
| `codebase-pattern-finder` | Find similar patterns to model after |
| `thoughts-locator` | Find documents in thoughts/ directory |
| `thoughts-analyzer` | Extract insights from thought documents |
| `web-search-researcher` | Web research for external information |

## License

MIT
