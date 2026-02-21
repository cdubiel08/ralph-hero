---
date: 2026-02-20
github_issue: 181
github_url: https://github.com/cdubiel08/ralph-hero/issues/181
status: complete
type: research
---

# GH-181: GitHub Actions Webhook Handler for Cross-Project State Sync

## Problem Statement

Create a GitHub Actions workflow that triggers when a project item's Workflow State field changes and calls the `sync_across_projects` logic (from #180) to propagate that state change to all other GitHub Projects the issue belongs to.

## Critical Architecture Constraint

**`projects_v2_item` is NOT a supported GitHub Actions workflow trigger.**

This is the most important finding of this research. GitHub Actions `on:` blocks cannot listen to `projects_v2_item` events directly. GitHub removed this from their roadmap in September 2023 with the explanation: "we don't have an elegant way to bridge the gaps between Orgs and Repos" ([discussion #40848](https://github.com/orgs/community/discussions/40848)).

Repository-level workflows can only receive `projects_v2_item` events indirectly via `repository_dispatch`. The required architecture is:

```
GitHub org webhook               repository_dispatch          Actions workflow
projects_v2_item.edited  →  external receiver  →  /repos/.../dispatches  →  on: repository_dispatch
```

The "external receiver" can be:
- **Option A** (v1, no infra): `workflow_dispatch` only — triggered manually or by other workflows
- **Option B** (full automation): A GitHub App or cloud function receives the org webhook and calls `repository_dispatch`
- **Option C** (zero infra): A scheduled cron workflow that polls for state drift

**Recommended for v1: `workflow_dispatch` + `repository_dispatch`** — wire the dispatch receiver now, document the org webhook bridge as a follow-up. The workflow is immediately usable for manual triggering and future automation.

## Webhook Payload Structure

When the external bridge is eventually wired, the `projects_v2_item.edited` event payload includes:

```json
{
  "action": "edited",
  "projects_v2_item": {
    "node_id": "PVTI_lADO...",
    "project_node_id": "PVT_kwDO...",
    "content_node_id": "I_kwDO...",
    "content_type": "Issue"
  },
  "changes": {
    "field_value": {
      "field_node_id": "PVTSSF_...",
      "field_type": "single_select",
      "field_name": "Workflow State",
      "project_number": 3,
      "from": { "id": "f75ad846", "name": "Backlog" },
      "to":   { "id": "47fc9ee4", "name": "In Progress" }
    }
  },
  "sender": { "login": "someuser", "type": "User" }
}
```

Key fields for the handler:
- `projects_v2_item.content_node_id` — issue/PR GraphQL node ID (passed to `projectItems` query)
- `changes.field_value.field_name` — field that changed; filter for `"Workflow State"` only
- `changes.field_value.to.name` — the target state to propagate
- `changes.field_value.project_number` — the originating project number (used for loop prevention)
- `sender.type` — `"User"` vs `"Bot"` (loop prevention)

**Note**: `project_number` is inside `changes.field_value`, not at the top level. The top level only has `project_node_id` (GraphQL ID).

## Org-Scope Requirements

`projects_v2_item` webhooks are **organization-level only**:
- User-account (personal) projects do NOT emit these webhooks
- Repository-level webhooks cannot subscribe to `projects_v2_item`
- GitHub App must have **"Projects" org permission** (read to receive events, write to update fields)
- Classic PAT with `project` scope required; fine-grained PATs do NOT support Projects V2 writes

## Loop Prevention

Two-layer strategy to prevent `A→B sync` triggering `B→A re-sync`:

**Layer 1 — Filter by field name**: Only trigger the workflow when `field_name === "Workflow State"`. The sync script only updates the Workflow State field — it never changes the triggering field itself in project B to something that would re-fire the event. (If the target state in B already equals the source, the idempotency check in the sync logic skips the update.)

**Layer 2 — Skip originating project**: Pass the originating `project_number` as an input to the sync script. The handler skips updating the project that triggered the event — it was already changed.

```javascript
// In the sync script
for (const item of projectItems) {
  if (item.project.number === originatingProjectNumber) {
    skipped.push({ projectNumber: item.project.number, reason: "originating_project" });
    continue;
  }
  // ... sync logic
}
```

**Layer 3 (for `repository_dispatch` bridge)**: Check `github.actor != 'github-actions[bot]'` in the workflow condition to skip runs triggered by the workflow itself.

## Implementation Plan

### Workflow File: `.github/workflows/sync-project-state.yml`

```yaml
name: Sync Project State

on:
  # Manual trigger (and for testing)
  workflow_dispatch:
    inputs:
      content_node_id:
        description: 'Issue/PR GraphQL node ID (I_kwDO... or PR_kwDO...)'
        required: true
      workflow_state:
        description: 'Target Workflow State to propagate'
        required: true
      originating_project_number:
        description: 'Project number that triggered the sync (skipped to prevent loops)'
        required: false
        default: '0'

  # Triggered by external org webhook bridge (future)
  repository_dispatch:
    types: [project-item-workflow-state-changed]

# Prevent concurrent syncs for the same content node
concurrency:
  group: sync-project-state-${{ github.event.inputs.content_node_id || github.event.client_payload.content_node_id }}
  cancel-in-progress: false

jobs:
  sync:
    runs-on: ubuntu-latest
    # Skip if triggered by our own bot (loop prevention layer 3)
    if: github.actor != 'github-actions[bot]'
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci
        working-directory: .github/scripts/sync

      - name: Sync Workflow State across projects
        env:
          SYNC_PAT: ${{ secrets.ROUTING_PAT }}
          CONTENT_NODE_ID: ${{ github.event.inputs.content_node_id || github.event.client_payload.content_node_id }}
          WORKFLOW_STATE: ${{ github.event.inputs.workflow_state || github.event.client_payload.workflow_state }}
          ORIGINATING_PROJECT_NUMBER: ${{ github.event.inputs.originating_project_number || github.event.client_payload.originating_project_number || '0' }}
          # Optional: comma-separated list of project numbers to sync (empty = all projects)
          SYNC_PROJECT_FILTER: ${{ vars.SYNC_PROJECT_FILTER }}
        run: node .github/scripts/sync/sync-project-state.js
```

### Script: `.github/scripts/sync/sync-project-state.js`

The script replicates the logic of the `sync_across_projects` MCP tool (#180) in plain CommonJS — the same pattern as `scripts/routing/route.js`. It does NOT import from the MCP server (different runtime context).

```javascript
#!/usr/bin/env node
'use strict';

const { graphql } = require('@octokit/graphql');

const {
  SYNC_PAT,
  CONTENT_NODE_ID,
  WORKFLOW_STATE,
  ORIGINATING_PROJECT_NUMBER = '0',
  SYNC_PROJECT_FILTER = '',
} = process.env;

if (!SYNC_PAT) {
  console.error('::error::SYNC_PAT is required. Set ROUTING_PAT as a repository secret.');
  process.exit(1);
}
if (!CONTENT_NODE_ID || !WORKFLOW_STATE) {
  console.error('::error::CONTENT_NODE_ID and WORKFLOW_STATE are required.');
  process.exit(1);
}

const graphqlWithAuth = graphql.defaults({
  headers: { authorization: `token ${SYNC_PAT}` },
});

const originProject = parseInt(ORIGINATING_PROJECT_NUMBER, 10) || 0;
const projectFilter = SYNC_PROJECT_FILTER
  ? SYNC_PROJECT_FILTER.split(',').map(n => parseInt(n.trim(), 10)).filter(Boolean)
  : [];

async function main() {
  // 1. Discover all project memberships + current Workflow State
  const result = await graphqlWithAuth(`
    query($nodeId: ID!) {
      node(id: $nodeId) {
        ... on Issue {
          projectItems(first: 20) {
            nodes {
              id
              project { id number }
              fieldValues(first: 20) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    __typename name
                    field { ... on ProjectV2FieldCommon { name } }
                  }
                }
              }
            }
          }
        }
      }
    }
  `, { nodeId: CONTENT_NODE_ID });

  const projectItems = result.node?.projectItems?.nodes ?? [];

  if (!projectItems.length) {
    console.log('Issue is not a member of any GitHub Project. Nothing to sync.');
    return;
  }

  const synced = [];
  const skipped = [];

  for (const item of projectItems) {
    const projectNumber = item.project.number;

    // Filter: only sync to specified projects if filter is set
    if (projectFilter.length && !projectFilter.includes(projectNumber)) {
      skipped.push({ projectNumber, reason: 'not_in_filter' });
      continue;
    }

    // Loop prevention: skip originating project
    if (projectNumber === originProject) {
      skipped.push({ projectNumber, reason: 'originating_project' });
      continue;
    }

    // Extract current Workflow State
    const currentState = item.fieldValues.nodes
      .find(fv => fv.__typename === 'ProjectV2ItemFieldSingleSelectValue'
        && fv.field?.name === 'Workflow State')
      ?.name ?? null;

    // Idempotency: skip if already at target
    if (currentState === WORKFLOW_STATE) {
      skipped.push({ projectNumber, reason: 'already_at_target_state', currentState });
      continue;
    }

    // Fetch field + option IDs for this project
    const fieldMeta = await fetchProjectFieldMeta(item.project.id);
    const wfField = fieldMeta.find(f => f.name === 'Workflow State');

    if (!wfField) {
      skipped.push({ projectNumber, reason: 'no_workflow_state_field' });
      continue;
    }

    const targetOption = wfField.options.find(o => o.name === WORKFLOW_STATE);
    if (!targetOption) {
      skipped.push({
        projectNumber,
        reason: 'invalid_option',
        detail: `"${WORKFLOW_STATE}" not found. Valid: ${wfField.options.map(o => o.name).join(', ')}`,
      });
      continue;
    }

    // Apply the update
    await graphqlWithAuth(`
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { singleSelectOptionId: $optionId }
        }) { projectV2Item { id } }
      }
    `, {
      projectId: item.project.id,
      itemId: item.id,
      fieldId: wfField.id,
      optionId: targetOption.id,
    });

    synced.push({ projectNumber, from: currentState, to: WORKFLOW_STATE });
    console.log(`✓ Synced project #${projectNumber}: ${currentState} → ${WORKFLOW_STATE}`);
  }

  console.log(`\nSync complete: ${synced.length} synced, ${skipped.length} skipped`);
  skipped.forEach(s => console.log(`  Skipped project #${s.projectNumber}: ${s.reason}${s.detail ? ' — ' + s.detail : ''}`));
}

async function fetchProjectFieldMeta(projectId) {
  const result = await graphqlWithAuth(`
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 20) {
            nodes {
              ... on ProjectV2SingleSelectField { id name options { id name } }
            }
          }
        }
      }
    }
  `, { projectId });
  return (result.node?.fields?.nodes ?? []).filter(f => f.id);
}

main().catch(err => {
  console.error('::error::Sync failed:', err.message);
  process.exit(1);
});
```

### Package File: `.github/scripts/sync/package.json`

```json
{
  "name": "sync-project-state",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "@octokit/graphql": "^7"
  }
}
```

### File Changes

| File | Change | Effort |
|------|--------|--------|
| `.github/workflows/sync-project-state.yml` | NEW — `workflow_dispatch` + `repository_dispatch` trigger, sync step | Primary |
| `.github/scripts/sync/sync-project-state.js` | NEW — plain CommonJS sync script (same pattern as `scripts/routing/route.js`) | Primary |
| `.github/scripts/sync/package.json` | NEW — `@octokit/graphql` dependency | Trivial |

### Repository Variables

Add to repo `vars` (not secrets — these are non-sensitive config):
- `SYNC_PROJECT_FILTER` — optional comma-separated project numbers to limit sync scope (empty = sync all)

### Tests

```javascript
// Pure function unit tests (extract sync logic from script for testability)
it('skips originating project to prevent loop')
it('skips project already at target state (idempotency)')
it('skips project without Workflow State field')
it('skips project with invalid option name, includes valid options in reason')
it('skips project not in SYNC_PROJECT_FILTER when filter is set')
it('applies mutation to all eligible projects')
it('handles empty projectItems gracefully')
```

## Future: Org Webhook Bridge

When automated (not manual) triggering is desired, a bridge is required:

**Lightweight option — Cloudflare Worker (free tier):**
```javascript
// Deployed at https://your-worker.workers.dev/webhook
async function handleWebhook(request, env) {
  const payload = await request.json();
  if (payload.action !== 'edited') return new Response('ok');

  const fieldChange = payload.changes?.field_value;
  if (fieldChange?.field_name !== 'Workflow State') return new Response('ok');
  if (payload.sender?.type === 'Bot') return new Response('ok');  // loop prevention

  // Forward to repository_dispatch
  await fetch(`https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/dispatches`, {
    method: 'POST',
    headers: { Authorization: `token ${env.ROUTING_PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_type: 'project-item-workflow-state-changed',
      client_payload: {
        content_node_id: payload.projects_v2_item.content_node_id,
        workflow_state: fieldChange.to.name,
        originating_project_number: String(fieldChange.project_number),
      },
    }),
  });
  return new Response('dispatched');
}
```

**Even simpler option — GitHub App with Actions integration:**
GitHub Apps can be configured to receive `projects_v2_item` webhooks and have built-in `repository_dispatch` capabilities. This avoids external infrastructure but requires App setup.

For v1, `workflow_dispatch` is sufficient — operators trigger sync manually when needed. The bridge can be added as a follow-up issue.

## Dependency Coordination

- **#180 (sync_across_projects MCP tool)** — This script (`sync-project-state.js`) implements the same GraphQL logic independently of the MCP tool. Both address the same need in different runtime contexts (MCP server vs. GitHub Actions). They share the GraphQL query/mutation pattern but do NOT share code.
- **#181 (this issue)** — standalone once `ROUTING_PAT` is available (established by #169)

## Risks

1. **`projects_v2_item` not triggerable from Actions**: Documented above. v1 uses `workflow_dispatch` only; automation requires org webhook bridge (deferred).

2. **Duplicate with GH-175 close/reopen sync**: GH-175 handles `issues.closed/reopened` → Workflow State transitions. GH-181 handles Workflow State → other projects (cross-project propagation). These are complementary, not duplicates.

3. **Script vs. MCP tool code duplication**: `sync-project-state.js` replicates the logic of `sync_across_projects` MCP tool. This is intentional — different runtime contexts (plain Node.js vs. MCP server framework). The MCP tool is the canonical implementation; the script is a Actions-compatible adaptation.

4. **`first: 20` project items limit**: Same risk as MCP tool (#180). Sufficient for typical 2-5 project setups.

5. **Sender type check for loop prevention**: Checking `github.actor != 'github-actions[bot]'` works for `GITHUB_TOKEN`-triggered workflows. When using `ROUTING_PAT`, the actor is the PAT owner's username, not a bot — so this check won't trigger. The field-name filter and originating-project skip (Layer 1 and Layer 2) are the primary loop prevention mechanisms.

6. **Concurrency race**: If two projects simultaneously change the same issue's Workflow State, two `repository_dispatch` events fire. The concurrency group on `content_node_id` serializes them. The idempotency check ensures the second run is a no-op.

## Recommended Approach

1. Create `.github/workflows/sync-project-state.yml` with `workflow_dispatch` + `repository_dispatch` triggers
2. Create `.github/scripts/sync/sync-project-state.js` following the `route.js` pattern
3. Document `ROUTING_PAT` reuse (same secret as GH-169/171/173)
4. Test via `workflow_dispatch` — manually input a content node ID, a target state, and a project number to skip
5. Document the org webhook bridge as a follow-up issue
6. Unit tests for pure sync logic functions
