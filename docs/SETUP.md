# Ralph Hero Setup Guide

Complete setup guide for configuring Ralph Hero in your project.

## Prerequisites

Before setting up Ralph Hero, ensure you have:

### 1. Claude Code
- Claude Code CLI installed and configured
- Access to Claude Code in your terminal

### 2. Linear MCP Server
Install the Linear MCP server for Claude Code:

```bash
# Install Linear MCP (follow Claude Code MCP documentation)
claude mcp add linear
```

Verify the Linear MCP is working:
```bash
claude -p "Use mcp__plugin_linear_linear__list_teams to list my teams"
```

### 3. Linear Workspace Access
- Admin access to your Linear workspace (for creating workflow states)
- Know your team name in Linear

### 4. Git Repository
- A git repository for your project
- Remote named `origin` pointing to your GitHub repository

### 5. Optional: jq
For the worktree scripts to read configuration:
```bash
# macOS
brew install jq

# Ubuntu/Debian
apt install jq
```

## Installation

### Option 1: From GitHub (Recommended)

```bash
# Install the plugin
claude plugin install cdubiel08/ralph-hero
```

### Option 2: Local Development

Clone the repository and link it:
```bash
git clone https://github.com/cdubiel08/ralph-hero
cd ralph-hero
claude plugin link .
```

## Configuration

### Run the Setup Wizard

After installation, run the setup wizard:

```bash
/ralph:setup
```

The wizard will:
1. Discover your Linear teams and let you select one
2. Query and map your workflow states
3. Ask for your GitHub repository URL
4. Configure document directories
5. Verify everything is working

### Manual Configuration

If you prefer manual configuration, create `.ralph/config.json`:

```bash
mkdir -p .ralph
```

Create `.ralph/config.json`:

```json
{
  "linear": {
    "teamName": "Your-Team",
    "teamId": "your-team-uuid-here",
    "states": {
      "backlog": "state-uuid-backlog",
      "researchNeeded": "state-uuid-research-needed",
      "researchInProgress": "state-uuid-research-in-progress",
      "readyForPlan": "state-uuid-ready-for-plan",
      "planInProgress": "state-uuid-plan-in-progress",
      "planInReview": "state-uuid-plan-in-review",
      "todo": "state-uuid-todo",
      "inProgress": "state-uuid-in-progress",
      "inReview": "state-uuid-in-review",
      "done": "state-uuid-done",
      "humanNeeded": "state-uuid-human-needed"
    },
    "labels": {
      "triaged": "ralph-triage",
      "planning": "planning",
      "research": "research"
    }
  },
  "github": {
    "repoUrl": "https://github.com/your-org/your-repo",
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

See [LINEAR_STATES.md](LINEAR_STATES.md) for how to find your state UUIDs.

## Workflow States

Ralph requires specific workflow states in Linear. If they don't exist, create them:

### Required States

| State | Type | Purpose |
|-------|------|---------|
| Backlog | Unstarted | Initial triage queue |
| Research Needed | Unstarted | Tickets needing investigation |
| Research in Progress | Started | Active research |
| Ready for Plan | Unstarted | Research complete, awaiting planning |
| Plan in Progress | Started | Active planning |
| Plan in Review | Started | Plan awaiting approval |
| Todo | Unstarted | Ready for implementation |
| In Progress | Started | Active development |
| In Review | Started | Code review |
| Done | Completed | Ticket complete |
| Human Needed | Started | Escalation required |

### Creating Missing States

1. Go to Linear Settings → Team → Your Team → Workflow
2. Add any missing states with the types specified above
3. Re-run `/ralph:setup` to pick up the new states

## Document Directories

Create the directories where Ralph will store documents:

```bash
mkdir -p docs/plans docs/research docs/tickets
```

These should be committed to your repository.

## Labels

Ralph uses labels to track ticket status. Create these labels in Linear:

| Label | Purpose |
|-------|---------|
| `ralph-triage` | Applied after triage to avoid re-processing |
| `planning` | Auto-applied to tickets in planning states |
| `research` | Auto-applied to research tickets |

## Verifying Setup

After setup, verify everything works:

```bash
# Check configuration exists
cat .ralph/config.json

# Test Linear connection
/ralph:linear status

# Try triaging a ticket (will report if queue is empty)
/ralph:triage
```

## Troubleshooting

### "Ralph not configured"
Run `/ralph:setup` to create the configuration file.

### "Linear MCP not available"
Ensure the Linear MCP server is installed:
```bash
claude mcp add linear
```

### "State not found"
The workflow state doesn't exist in your Linear workspace. Create it in Linear Settings → Team → Workflow.

### "Permission denied" on scripts
Make the scripts executable:
```bash
chmod +x ./path/to/plugin/scripts/*.sh
```

### "jq: command not found"
Install jq for configuration loading in scripts:
```bash
# macOS
brew install jq

# Ubuntu/Debian
apt install jq
```

Without jq, scripts will use default values for `worktreeBase`.

## Updating Configuration

To reconfigure Ralph:

```bash
/ralph:setup --reconfigure
```

Or manually edit `.ralph/config.json`.

## Uninstalling

Remove the plugin:
```bash
claude plugin uninstall ralph-hero
```

Optionally remove configuration:
```bash
rm -rf .ralph/
```
