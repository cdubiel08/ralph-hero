---
date: 2026-02-20
github_issue: 175
github_url: https://github.com/cdubiel08/ralph-hero/issues/175
status: complete
type: research
---

# GH-175: Actions — Issue Close/Reopen Triggers Workflow State Sync

## Problem Statement

When issues are closed or reopened through the GitHub UI, the custom Workflow State field in the Ralph project is not updated. GitHub's built-in project automations only sync the default Status field (Todo/In Progress/Done) — they don't distinguish `completed` vs `not_planned` close reasons and don't touch the custom Workflow State field. A GitHub Actions workflow is needed to map close/reopen events to the correct Workflow State transitions.

## Current State Analysis

### Built-in Automations vs Custom Workflow State

GitHub's built-in project automations (configured in project UI):
- Close → Status = Done (all close reasons, no discrimination)
- Reopen → Status = In Progress or Todo

These only affect the **default Status field**, not the custom **Workflow State** field that Ralph uses for its 11-state pipeline. The MCP server's `WORKFLOW_STATE_TO_STATUS` mapping ([`workflow-states.ts:117-129`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts#L117)) provides one-way sync from Workflow State → Status, but there's no reverse sync from GitHub UI actions → Workflow State.

### `update_workflow_state` Tool — The Existing Pattern

The `ralph_hero__update_workflow_state` tool ([`issue-tools.ts:930-1020`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L930)) performs:

1. `resolveState(args.state, args.command)` — semantic intent → concrete state name
2. `ensureFieldCache()` — populate field/option IDs
3. `getCurrentFieldValue()` — read previous Workflow State
4. `resolveProjectItemId()` — issue number → project item node ID
5. `updateProjectItemField()` — fire `updateProjectV2ItemFieldValue` mutation
6. `syncStatusField()` — best-effort Status sync (Done/Canceled → Status "Done")

The Actions workflow must replicate steps 2-5 using GraphQL directly, since MCP tools can't be invoked from Actions.

### `WORKFLOW_STATE_TO_STATUS` Mapping

[`workflow-states.ts:117-129`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts#L117):

| Workflow State | Status |
|----------------|--------|
| Done | Done |
| Canceled | Done |
| Human Needed | Done |
| In Progress, In Review, Research/Plan in Progress | In Progress |
| Backlog, Research Needed, Ready for Plan, Plan in Review | Todo |

Both Done and Canceled map to Status "Done". The built-in automation already handles this. The Actions workflow only needs to set Workflow State — the Status sync follows automatically if the built-in automation is enabled.

### Auth Constraint

`GITHUB_TOKEN` cannot access Projects V2. A classic PAT with `repo` + `project` scopes is required. The GH-169 research established `secrets.ROUTING_PAT` as the standard secret name for project-scoped Actions. This workflow should use the same secret for consistency.

### `issues` Webhook Payload

The `github.event.issue` object includes:

| Field | Type | Example |
|-------|------|---------|
| `number` | integer | `42` |
| `state` | string | `"open"` or `"closed"` |
| `state_reason` | string or null | `"completed"`, `"not_planned"`, `"duplicate"`, `"reopened"`, `null` |
| `node_id` | string | `"I_kwDO..."` |
| `labels[].name` | string[] | `["bug", "enhancement"]` |

**`state_reason` is NOT filterable at the trigger level** — must use `if:` conditions in job steps. The `duplicate` value was added later without a spec bump; treat `state_reason` as an open string.

## Key Discoveries

### 1. Close Reason → Workflow State Mapping

| `state_reason` | Target Workflow State | Rationale |
|----------------|----------------------|-----------|
| `completed` | Done | Issue resolved successfully |
| `not_planned` | Canceled | Explicitly won't fix |
| `duplicate` | Canceled | Duplicate = superseded = canceled |
| `null` | Done | No reason → assume completed (conservative) |

### 2. Reopen → Backlog (Not Previous State)

The issue's acceptance criteria state "Reset Workflow State to Backlog" on reopen. This is correct — there's no reliable way to recover the previous Workflow State from the webhook payload or issue history. Resetting to Backlog is the safest approach.

### 3. Two Implementation Approaches

**Option A: `gh` CLI shell script** (simpler, no dependencies):
```yaml
steps:
  - name: Sync Workflow State
    env:
      GH_TOKEN: ${{ secrets.ROUTING_PAT }}
    run: |
      # 1. Get project and field IDs
      # 2. Find project item for this issue via node_id
      # 3. Update Workflow State field
```

**Option B: Node.js script using `@octokit/graphql`** (reuses MCP server patterns):
```yaml
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
  - run: npx tsx .github/scripts/sync-workflow-state.ts
    env:
      ROUTING_PAT: ${{ secrets.ROUTING_PAT }}
```

### 4. Efficient Project Item Resolution

The webhook payload includes `github.event.issue.node_id`. Instead of listing all project items (O(n)), query the issue's `projectItems` directly:

```graphql
query($issueId: ID!) {
  node(id: $issueId) {
    ... on Issue {
      projectItems(first: 20) {
        nodes {
          id
          project { id number }
        }
      }
    }
  }
}
```

This mirrors the pattern in `resolveProjectItemId` ([`helpers.ts:179-202`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L179)).

### 5. Idempotency Check

The acceptance criteria require idempotency: "if already in target state, no-op". Before updating, query the current Workflow State value:

```graphql
query($itemId: ID!) {
  node(id: $itemId) {
    ... on ProjectV2Item {
      fieldValueByName(name: "Workflow State") {
        ... on ProjectV2ItemFieldSingleSelectValue {
          name
        }
      }
    }
  }
}
```

If `currentState === targetState`, skip the mutation and log "Already in target state".

### 6. Field and Option ID Resolution

The workflow needs the Workflow State field ID and the target option ID (e.g., "Done" option). These can be resolved by querying the project's fields:

```graphql
query($projectId: ID!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      fields(first: 20) {
        nodes {
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id name }
          }
        }
      }
    }
  }
}
```

This is the same query used by `fetchProjectForCache` ([`helpers.ts:41-85`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L41)).

### 7. Group Context

Parent #127 has 3 children:
1. **#175** — Close/reopen → Workflow State (this issue, no blockers)
2. **#176** — PR merge → advance linked issue (blocked by #175 for shared workflow patterns)
3. **#177** — Parent auto-advance when all children Done (blocked by #175)

The shared auth pattern (`ROUTING_PAT`), field resolution logic, and `updateProjectV2ItemFieldValue` mutation are established by #175 and reused by siblings.

### 8. Workflow Should NOT Sync Status Field

The built-in project automation already handles Status sync on close/reopen. If this workflow also syncs Status, it creates a race condition or redundant mutation. The workflow should **only** update the custom Workflow State field. The built-in automation handles Status → Done independently.

## Potential Approaches

### Approach A: Shell Script with `gh` CLI (Recommended)

A single workflow file `.github/workflows/sync-issue-state.yml` with inline shell using `gh api graphql`. No checkout, no Node.js setup, no dependencies.

**Pros:** Fastest to implement, no build step, `gh` is pre-installed on Actions runners, consistent with GH-169 routing workflow pattern.
**Cons:** Shell GraphQL queries are verbose, limited error handling.

### Approach B: Node.js Script with `@octokit/graphql`

A workflow that checks out the repo and runs a TypeScript script from `.github/scripts/`.

**Pros:** Better error handling, can reuse patterns from MCP server, type safety.
**Cons:** Requires checkout + Node.js setup steps, adds ~30s to workflow startup, introduces a dependency on repo structure.

### Approach C: Marketplace Action (`nipe0324/update-project-v2-item-field`)

Use a pre-built marketplace action to update the field.

**Pros:** Minimal YAML, maintained externally.
**Cons:** Third-party dependency, limited control over close reason logic, no idempotency check.

### Recommendation: Approach A

Shell script with `gh` CLI is the simplest path. The logic is straightforward (3 GraphQL calls) and doesn't justify a Node.js build pipeline. This also matches the pattern established in GH-169 research for the routing workflow.

## Implementation Sketch

```yaml
name: Sync Workflow State on Close/Reopen

on:
  issues:
    types: [closed, reopened]

jobs:
  sync-workflow-state:
    runs-on: ubuntu-latest
    if: github.event.issue.state_reason != null || github.event.action == 'reopened'
    env:
      GH_TOKEN: ${{ secrets.ROUTING_PAT }}
      PROJECT_OWNER: cdubiel08
      PROJECT_NUMBER: 3
    steps:
      - name: Determine target state
        id: target
        run: |
          if [ "${{ github.event.action }}" = "reopened" ]; then
            echo "state=Backlog" >> $GITHUB_OUTPUT
          elif [ "${{ github.event.issue.state_reason }}" = "completed" ]; then
            echo "state=Done" >> $GITHUB_OUTPUT
          else
            echo "state=Canceled" >> $GITHUB_OUTPUT
          fi

      - name: Update Workflow State
        run: |
          # ... resolve project item, check idempotency, update field
```

## Risks

1. **`duplicate` close reason**: GitHub added `state_reason: "duplicate"` without a spec bump. The workflow should handle unknown `state_reason` values by defaulting to `Canceled` (conservative — unknown close reasons are treated as cancellations).
2. **Issue not in project**: If the issue hasn't been added to the Ralph project, the project item query returns empty. The workflow should exit gracefully with a log message, not fail.
3. **Race with built-in automation**: If both the built-in automation and this workflow run simultaneously, the Status field update from the built-in automation and the Workflow State update from this workflow could interleave. Since they update different fields, this is harmless.
4. **PAT expiration**: `ROUTING_PAT` is a classic PAT that expires. The workflow will fail silently when the PAT expires. Consider adding a health check or expiry alert.
5. **Reopen loses context**: Resetting to Backlog on reopen discards the previous pipeline position. If an issue was "In Review" when closed, reopening sends it back to Backlog. This is stated as acceptable in the issue's AC.

## Recommended Next Steps

1. Create `.github/workflows/sync-issue-state.yml` with `issues: [closed, reopened]` triggers
2. Map `state_reason` to target Workflow State: `completed` → Done, `not_planned`/`duplicate`/unknown → Canceled, reopen → Backlog
3. Resolve project item via issue `node_id` → `projectItems` query (not item list scan)
4. Add idempotency check: query current Workflow State, skip if already at target
5. Use `ROUTING_PAT` secret (same as routing workflow)
6. Document `ROUTING_PAT` requirement in workflow comments and README
7. Add `workflow_dispatch` trigger for manual testing
