---
name: setup
description: Configure Ralph for your Linear workspace and GitHub repository
allowed-tools: Read, Write, Edit, Bash, mcp__plugin_linear_linear__list_teams, mcp__plugin_linear_linear__get_team, mcp__plugin_linear_linear__list_issue_statuses
argument-hint: [--reconfigure]
---

# Ralph Setup Wizard

Configure Ralph for your project. This wizard helps you set up Linear integration and GitHub repository settings.

## Prerequisites

Before running setup, ensure:
1. **Linear MCP server is installed and configured**
2. **You have admin access to your Linear workspace**
3. **You know your GitHub repository URL**

## Setup Process

### Step 1: Check Existing Configuration

Check if configuration already exists:

```bash
if [ -f ".ralph/config.json" ]; then
  echo "Existing configuration found"
  cat .ralph/config.json
fi
```

If `--reconfigure` argument provided, proceed to overwrite.
If configuration exists and no `--reconfigure`, ask user if they want to reconfigure.

### Step 2: Discover Linear Team

Query available teams:

```
mcp__plugin_linear_linear__list_teams
```

Present teams to user and ask them to select one. Store the team name and ID.

### Step 3: Discover Workflow States

Query workflow states for the selected team:

```
mcp__plugin_linear_linear__list_issue_statuses
- team: [selected-team-name]
```

Map the discovered states to Ralph's required states:
- Look for states matching: Backlog, Research Needed, Research in Progress, Ready for Plan, Plan in Progress, Plan in Review, Todo, In Progress, In Review, Done, Human Needed
- If any required state is missing, warn the user and provide instructions to create it

### Step 4: Collect GitHub Configuration

Ask user for:
1. GitHub repository URL (e.g., `https://github.com/org/repo`)
2. Default branch (default: `main`)

Validate the URL format.

### Step 5: Configure Paths

Ask user for custom paths or accept defaults:
- Worktree base directory (default: `../worktrees`)
- Plans directory (default: `docs/plans`)
- Research directory (default: `docs/research`)
- Tickets directory (default: `docs/tickets`)

### Step 6: Write Configuration

Create `.ralph/config.json` with collected values:

```bash
mkdir -p .ralph
```

Write the configuration file:

```json
{
  "linear": {
    "teamName": "[discovered]",
    "teamId": "[discovered]",
    "states": {
      "backlog": "[discovered-uuid]",
      "researchNeeded": "[discovered-uuid]",
      "researchInProgress": "[discovered-uuid]",
      "readyForPlan": "[discovered-uuid]",
      "planInProgress": "[discovered-uuid]",
      "planInReview": "[discovered-uuid]",
      "todo": "[discovered-uuid]",
      "inProgress": "[discovered-uuid]",
      "inReview": "[discovered-uuid]",
      "done": "[discovered-uuid]",
      "humanNeeded": "[discovered-uuid]"
    },
    "labels": {
      "triaged": "ralph-triage",
      "planning": "planning",
      "research": "research"
    }
  },
  "github": {
    "repoUrl": "[user-input]",
    "defaultBranch": "[user-input]"
  },
  "paths": {
    "worktreeBase": "[user-input]",
    "plansDir": "[user-input]",
    "researchDir": "[user-input]",
    "ticketsDir": "[user-input]"
  }
}
```

### Step 7: Create Directory Structure

```bash
mkdir -p [plansDir] [researchDir] [ticketsDir]
```

### Step 8: Verify Setup

1. Test Linear connection by fetching team details
2. Verify all required workflow states exist
3. Confirm directories are created

### Step 9: Report Success

```
Ralph setup complete!

Linear Team: [team-name]
GitHub Repo: [repo-url]

Workflow states configured:
  Backlog
  Research Needed
  Research in Progress
  Ready for Plan
  Plan in Progress
  Plan in Review
  Todo
  In Progress
  In Review
  Done
  Human Needed

Document directories:
- Plans: [plansDir]
- Research: [researchDir]
- Tickets: [ticketsDir]

You can now use:
- /ralph:triage - Triage backlog tickets
- /ralph:research - Research tickets
- /ralph:plan - Create implementation plans
- /ralph:impl - Implement tickets

Or run the full loop:
  ./scripts/ralph-loop.sh
```

## Missing State Instructions

If required states are missing, provide these instructions:

```
Missing Linear workflow states. Please create them:

1. Go to Linear Settings -> Team -> [team-name] -> Workflow
2. Create these states (if missing):
   - "Research Needed" (type: unstarted)
   - "Research in Progress" (type: started)
   - "Ready for Plan" (type: unstarted)
   - "Plan in Progress" (type: started)
   - "Plan in Review" (type: started)
   - "Human Needed" (type: started)

3. Re-run /ralph:setup after creating states
```

## State Name Matching

When matching discovered states to required states, use fuzzy matching:

| Required State | Acceptable Names |
|----------------|------------------|
| backlog | Backlog, Backlog/Triage |
| researchNeeded | Research Needed, Needs Research |
| researchInProgress | Research in Progress, Researching |
| readyForPlan | Ready for Plan, Ready to Plan, Planning Ready |
| planInProgress | Plan in Progress, Planning |
| planInReview | Plan in Review, Plan Review |
| todo | Todo, To Do, Ready |
| inProgress | In Progress, In Development, Working |
| inReview | In Review, Review, Code Review |
| done | Done, Complete, Completed |
| humanNeeded | Human Needed, Needs Human, Blocked |

## Reconfiguration

When `--reconfigure` is provided:
1. Read existing config to show current values as defaults
2. Allow user to change any value or keep existing
3. Overwrite the config file with new values
