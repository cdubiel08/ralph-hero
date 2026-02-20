---
date: 2026-02-20
status: draft
github_issues: [180, 181]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/180
  - https://github.com/cdubiel08/ralph-hero/issues/181
primary_issue: 180
---

# Cross-Project State Sync - Atomic Implementation Plan

## Overview
2 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-180 | Implement sync_across_projects MCP tool for cross-project state propagation | S |
| 2 | GH-181 | GitHub Actions webhook handler for cross-project state sync | S |

**Why grouped**: GH-181's Actions script replicates the same GraphQL logic as GH-180's MCP tool in a different runtime context (plain CJS vs MCP server). Both address cross-project Workflow State propagation — shipping together ensures the full sync pipeline is immediately operational. The Actions handler depends on GH-180 establishing the query/mutation patterns.

## Current State Analysis

- `projectItems(first: 10)` with `fieldValues` already used in `get_issue` (`issue-tools.ts:425-440`) — reuse that query shape
- `FieldOptionCache` is single-project only — must fetch field metadata directly for non-default projects
- `resolveIssueNodeId` exists in `helpers.ts:119-147` — reuse for node ID resolution
- `client.projectMutate()` (`github-client.ts:49-52`) accepts mutation + variables, no cache
- `client.projectQuery()` (`github-client.ts:36-40`) uses project token for project-scoped queries
- Last import in `index.ts` is `registerRoutingTools` (line 25), last register call is line 314
- `resolveConfig` in `helpers.ts:324-339` returns `{ owner, repo }`
- `toolSuccess`/`toolError` in `types.ts:246-257` — standard return helpers
- `scripts/routing/route.js` (from GH-169/171) established the standalone CJS script pattern for Actions
- `ROUTING_PAT` secret already configured (from GH-169) — reused for sync Actions
- `projects_v2_item` is NOT a GitHub Actions trigger — v1 uses `workflow_dispatch` + `repository_dispatch`

## Desired End State

### Verification
- [x] `ralph_hero__sync_across_projects` MCP tool discovers all project memberships via `projectItems` query
- [x] Tool propagates Workflow State to projects where current state differs from target
- [x] Tool is idempotent — skips projects already at the target state
- [x] Tool supports `dryRun` mode — returns affected list without mutations
- [x] Tool gracefully skips projects missing Workflow State field or target option
- [ ] `.github/workflows/sync-project-state.yml` triggers via `workflow_dispatch` and `repository_dispatch`
- [ ] `.github/scripts/sync/sync-project-state.js` replicates sync logic with loop prevention
- [ ] Script skips originating project number to prevent sync loops
- [ ] Concurrency group prevents parallel syncs for the same content node
- [ ] Build succeeds, all tests pass

## What We're NOT Doing
- No automated org webhook bridge (future follow-up — requires external infrastructure)
- No Status field sync for non-default projects (documented gap — `syncStatusField` is single-project scoped)
- No `projectItems` pagination beyond `first: 20` (sufficient for typical 2-5 project setups)
- No shared code between MCP tool and Actions script (different runtime contexts)
- No GitHub App setup (PAT-based auth only)
- No `SYNC_PROJECT_FILTER` repo variable creation (manual setup by operator)

## Implementation Approach

Phase 1 creates the MCP tool (`sync-tools.ts`) with the core GraphQL queries and mutation logic, wired into `index.ts`. Phase 2 creates the GitHub Actions workflow and standalone CJS script that replicates the same sync logic for Actions-triggered execution, following the `scripts/routing/route.js` pattern established in GH-169/171.

---

## Phase 1: GH-180 — Implement sync_across_projects MCP tool
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/180 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0180-sync-across-projects-mcp-tool.md

### Changes Required

#### 1. Create sync tools module
**File**: `plugin/ralph-hero/mcp-server/src/tools/sync-tools.ts` (NEW)

**Changes**: Create new tool file following the `registerXxxTools(server, client, fieldCache)` pattern (same as `routing-tools.ts`, `hygiene-tools.ts`):

- **`fetchProjectFieldMeta(client, projectId)`** private helper: Queries `node(id: $projectId) { ... on ProjectV2 { fields(first: 20) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } } } }` via `client.projectQuery()`. Returns array of `{ id, name, options }`. Same query shape as `fetchProjectForCache` in `helpers.ts:60-85` but returns raw data without populating `FieldOptionCache`.

- **`ralph_hero__sync_across_projects` tool**:
  - Schema: `number` (required), `workflowState` (required string), `owner`/`repo` (optional, default from env), `dryRun` (optional boolean, default false)
  - Handler logic:
    1. `resolveConfig(client, args)` for owner/repo
    2. `resolveIssueNodeId(client, owner, repo, args.number)` for node ID
    3. Query `node(id: $issueId) { ... on Issue { projectItems(first: 20) { nodes { id, project { id number }, fieldValues(first: 20) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { __typename name field { ... on ProjectV2FieldCommon { name } } } } } } } } }` via `client.projectQuery()`
    4. For each project item: extract current Workflow State from `fieldValues`, skip if already at target (idempotency), skip if `dryRun`, else fetch field metadata via `fetchProjectFieldMeta()`, resolve field/option IDs, call `client.projectMutate()` with `updateProjectV2ItemFieldValue`
    5. Return `toolSuccess({ number, workflowState, dryRun, syncedCount, skippedCount, synced, skipped })`
  - Error handling: wrap in try/catch, return `toolError()` on failure

- **Imports**: `McpServer` from SDK, `z` from zod, `GitHubClient` from `../github-client.js`, `FieldOptionCache` from `../lib/cache.js`, `toolSuccess`, `toolError` from `../types.js`, `resolveIssueNodeId`, `resolveConfig` from `../lib/helpers.js`

#### 2. Wire sync tools into index.ts
**File**: `plugin/ralph-hero/mcp-server/src/index.ts`

**Changes**:
- Add import after line 25: `import { registerSyncTools } from "./tools/sync-tools.js";`
- Add registration after line 314: `registerSyncTools(server, client, fieldCache);`

#### 3. Create tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/sync-tools.test.ts` (NEW)

**Changes**: Structural tests following `dashboard-tools.test.ts` factory pattern:
- Factory `makeProjectItem(overrides)` for creating test project items
- Tests:
  1. Tool is registered with correct name and schema
  2. No project memberships → returns empty synced/skipped
  3. Single project, state differs → included in synced list
  4. Single project, already at target state → skipped with `already_at_target_state`
  5. Project missing Workflow State field → skipped with `no_workflow_state_field`
  6. Project with field but missing target option → skipped with `invalid_option`
  7. `dryRun=true` → synced list populated but no mutations called
  8. Multiple projects → syncs differing, skips matching

### Success Criteria
- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` succeeds
- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes (all tests including new sync tests)
- [ ] Manual: Tool appears in MCP server tool listing

**Creates for next phase**: Established GraphQL query/mutation patterns that Phase 2's CJS script replicates

---

## Phase 2: GH-181 — GitHub Actions webhook handler for cross-project state sync
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/181 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0181-cross-project-sync-webhook-handler.md | **Depends on**: Phase 1 (establishes query/mutation patterns)

### Changes Required

#### 1. Create sync workflow
**File**: `.github/workflows/sync-project-state.yml` (NEW)

**Changes**: Create GitHub Actions workflow:

```yaml
name: Sync Project State

on:
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
  repository_dispatch:
    types: [project-item-workflow-state-changed]

concurrency:
  group: sync-project-state-${{ github.event.inputs.content_node_id || github.event.client_payload.content_node_id }}
  cancel-in-progress: false

jobs:
  sync:
    runs-on: ubuntu-latest
    if: github.actor != 'github-actions[bot]'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install dependencies
        run: npm ci
        working-directory: .github/scripts/sync
      - name: Verify ROUTING_PAT is set
        run: |
          if [ -z "$SYNC_PAT" ]; then
            echo "::error::ROUTING_PAT secret is not set."
            exit 1
          fi
        env:
          SYNC_PAT: ${{ secrets.ROUTING_PAT }}
      - name: Sync Workflow State across projects
        env:
          SYNC_PAT: ${{ secrets.ROUTING_PAT }}
          CONTENT_NODE_ID: ${{ github.event.inputs.content_node_id || github.event.client_payload.content_node_id }}
          WORKFLOW_STATE: ${{ github.event.inputs.workflow_state || github.event.client_payload.workflow_state }}
          ORIGINATING_PROJECT_NUMBER: ${{ github.event.inputs.originating_project_number || github.event.client_payload.originating_project_number || '0' }}
          SYNC_PROJECT_FILTER: ${{ vars.SYNC_PROJECT_FILTER }}
        run: node .github/scripts/sync/sync-project-state.js
```

Key design decisions:
- `workflow_dispatch` for manual/testing use, `repository_dispatch` for future org webhook bridge
- Reuses `ROUTING_PAT` secret (same as GH-169 routing workflow)
- Concurrency group on `content_node_id` prevents parallel syncs for same issue
- `github.actor != 'github-actions[bot]'` as loop prevention layer 3
- All inputs passed via `env:` block (safe injection pattern)

#### 2. Create sync script package
**File**: `.github/scripts/sync/package.json` (NEW)

**Changes**:
```json
{
  "name": "sync-project-state",
  "version": "1.0.0",
  "private": true,
  "description": "GitHub Actions script for cross-project Workflow State sync",
  "dependencies": {
    "@octokit/graphql": "^9.0.3"
  }
}
```

Note: Uses same `@octokit/graphql` version as `scripts/routing/package.json` for consistency.

#### 3. Create sync script
**File**: `.github/scripts/sync/sync-project-state.js` (NEW)

**Changes**: Standalone CommonJS script (same pattern as `scripts/routing/route.js`):

- **Env var reading**: `SYNC_PAT`, `CONTENT_NODE_ID`, `WORKFLOW_STATE`, `ORIGINATING_PROJECT_NUMBER`, `SYNC_PROJECT_FILTER`. Validate required vars present.
- **`fetchProjectFieldMeta(graphqlWithAuth, projectId)`** function: Same query as MCP tool's helper — fetches `ProjectV2SingleSelectField` entries with IDs and option mappings.
- **`main()`** async function:
  1. Query `node(id: $nodeId) { ... on Issue { projectItems(first: 20) { ... } } }` to discover all project memberships with current Workflow State
  2. For each project item:
     - Filter by `SYNC_PROJECT_FILTER` if set (comma-separated project numbers)
     - Skip originating project (loop prevention layer 2)
     - Skip if already at target state (idempotency)
     - Fetch field metadata for target project
     - Skip if no Workflow State field or target option not found
     - Call `updateProjectV2ItemFieldValue` mutation
  3. Console.log sync results (synced count, skipped with reasons)
- **Error handling**: `main().catch()` with `::error::` annotation and `process.exit(1)`

#### 4. Generate package-lock.json
Run `cd .github/scripts/sync && npm install` to generate `package-lock.json` (required for `npm ci` in the workflow).

### Success Criteria
- [ ] Automated: `node -c .github/scripts/sync/sync-project-state.js` passes syntax check
- [ ] Automated: `cd .github/scripts/sync && npm install` succeeds
- [ ] Manual: Workflow appears in Actions tab after merge
- [ ] Manual: `workflow_dispatch` with test inputs triggers sync script

**Creates for next phase**: N/A (final phase)

---

## Integration Testing
- [x] MCP tool builds and all tests pass
- [ ] Sync script passes `node -c` syntax check
- [ ] `.github/scripts/sync/package.json` dependencies install cleanly
- [ ] Workflow YAML is syntactically valid
- [ ] Concurrency group uses correct expression for content node ID
- [ ] `ROUTING_PAT` verification step exits 1 when secret missing
- [ ] End-to-end: `workflow_dispatch` with real content node ID triggers sync across projects (requires ROUTING_PAT secret + multi-project issue)

## References
- Research GH-180: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0180-sync-across-projects-mcp-tool.md
- Research GH-181: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0181-cross-project-sync-webhook-handler.md
- Tool registration pattern: `index.ts:25` (import), `index.ts:314` (register call)
- `resolveIssueNodeId`: `helpers.ts:119-147`
- `resolveConfig`: `helpers.ts:324-339`
- `client.projectMutate()`: `github-client.ts:49-52`
- `client.projectQuery()`: `github-client.ts:36-40`
- `projectItems` query pattern: `issue-tools.ts:425-440`
- Actions script pattern: `scripts/routing/route.js` (GH-169/171)
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/129 (Cross-project sync)
