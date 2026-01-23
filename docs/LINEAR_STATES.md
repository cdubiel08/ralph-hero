# Finding Linear State IDs

Guide for finding your Linear workflow state UUIDs for Ralph configuration.

## Why State IDs?

Linear uses UUIDs to identify workflow states. State names can change or have variations, but UUIDs are stable identifiers. Ralph uses these IDs to reliably transition tickets between states.

## Method 1: Setup Wizard (Recommended)

The easiest way is to run `/ralph:setup`. It will:
1. Query your Linear team's workflow states
2. Map them to Ralph's required states
3. Generate the configuration automatically

## Method 2: Linear MCP Query

Query your states directly:

```bash
claude -p "Query mcp__plugin_linear_linear__list_issue_statuses with team: 'Your-Team-Name'"
```

This returns a list of states with their IDs:

```
{
  "states": [
    { "id": "abc123", "name": "Backlog", "type": "unstarted" },
    { "id": "def456", "name": "In Progress", "type": "started" },
    ...
  ]
}
```

## Method 3: Linear API (GraphQL)

Use Linear's GraphQL API directly:

```graphql
query WorkflowStates {
  team(id: "your-team-id") {
    states {
      nodes {
        id
        name
        type
        position
      }
    }
  }
}
```

## Method 4: Linear URL

When viewing an issue in Linear filtered by state, the URL contains the state ID:

```
https://linear.app/your-team/issue?status=abc123-def4-5678-...
```

## Required States Mapping

Ralph requires these specific states. Map your Linear states to these:

### Unstarted States

| Ralph State | Common Linear Names | Type |
|-------------|---------------------|------|
| `backlog` | Backlog, Backlog/Triage | unstarted |
| `researchNeeded` | Research Needed, Needs Research | unstarted |
| `readyForPlan` | Ready for Plan, Ready to Plan | unstarted |
| `todo` | Todo, To Do, Ready | unstarted |

### Started States

| Ralph State | Common Linear Names | Type |
|-------------|---------------------|------|
| `researchInProgress` | Research in Progress, Researching | started |
| `planInProgress` | Plan in Progress, Planning | started |
| `planInReview` | Plan in Review, Plan Review | started |
| `inProgress` | In Progress, Working | started |
| `inReview` | In Review, Code Review | started |
| `humanNeeded` | Human Needed, Needs Human, Blocked | started |

### Completed States

| Ralph State | Common Linear Names | Type |
|-------------|---------------------|------|
| `done` | Done, Complete, Completed | completed |

## Creating Missing States

If your Linear team doesn't have all required states:

### Via Linear UI

1. Go to Linear Settings
2. Navigate to Team → Your Team → Workflow
3. Click "Add state"
4. Enter the state name
5. Select the appropriate type:
   - **Unstarted**: Work hasn't begun
   - **Started**: Work is active
   - **Completed**: Work is finished
6. Position the state in your workflow order

### Recommended State Order

```
Backlog (unstarted)
Research Needed (unstarted)
Research in Progress (started)
Ready for Plan (unstarted)
Plan in Progress (started)
Plan in Review (started)
Todo (unstarted)
In Progress (started)
In Review (started)
Human Needed (started)
Done (completed)
```

## Example Configuration

After finding your state IDs, configure them in `.ralph/config.json`:

```json
{
  "linear": {
    "teamName": "My-Team",
    "teamId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "states": {
      "backlog": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "researchNeeded": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "researchInProgress": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "readyForPlan": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "planInProgress": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "planInReview": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "todo": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "inProgress": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "inReview": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "done": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "humanNeeded": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    }
  }
}
```

## Verification

After configuring, verify states work:

```bash
# Test state transitions
claude -p "Use mcp__plugin_linear_linear__get_issue_status with id: 'your-state-uuid' and team: 'Your-Team'"
```

If the query succeeds, the state ID is valid.

## Troubleshooting

### "State not found"

- Double-check the UUID is correct (no typos)
- Ensure the state exists in the correct team
- State may have been deleted - create it again

### "Invalid state transition"

- Some state transitions may not be allowed by Linear
- Check your Linear workflow settings

### "State type mismatch"

- Ensure state types match expected (unstarted, started, completed)
- Ralph assumes certain state types for workflow logic

## Team ID

You'll also need your team ID. Find it via:

```bash
claude -p "Query mcp__plugin_linear_linear__list_teams"
```

Or in the URL when viewing your team's issues:

```
https://linear.app/your-team/team/TM/...
```

The team ID is different from the team key (short identifier like "TM").
