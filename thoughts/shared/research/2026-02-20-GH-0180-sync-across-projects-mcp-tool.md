---
date: 2026-02-20
github_issue: 180
github_url: https://github.com/cdubiel08/ralph-hero/issues/180
status: complete
type: research
---

# GH-180: Implement `sync_across_projects` MCP Tool for Cross-Project State Propagation

## Problem Statement

Implement a `ralph_hero__sync_across_projects` MCP tool that discovers all GitHub Projects an issue belongs to (via the `projectItems` GraphQL field) and propagates a Workflow State change to all of them. The tool must be idempotent (skip projects already at the target state) and handle projects with different field configurations gracefully.

## Current State Analysis

### `projectItems` Field — Already Queried in Three Places

The `projectItems` connection on an `Issue` node is the key to multi-project discovery. It already exists in the codebase:

**`get_issue` (`issue-tools.ts:425-440`)** — The most complete usage: fetches `projectItems(first: 10)` with inline `fieldValues(first: 20)` per item, including `ProjectV2ItemFieldSingleSelectValue` fragments that surface the current field option name. This is exactly the pattern needed to detect current Workflow State per project.

**`resolveProjectItemId` (`helpers.ts:192-201`)** — Bare resolution: fetches `projectItems(first: 20)` with just `id` and `project.id`. Used by all existing tools to resolve the project item node ID for the single configured project.

**`buildBatchResolveQuery` (`batch-tools.ts:67-72`)** — Same as helpers.ts but `first: 5`.

**Critical gap**: All existing tools use `projectItems` to find ONE item (the one matching the configured project) and ignore the rest. `sync_across_projects` is the first tool to iterate ALL returned items.

### `FieldOptionCache` — Single-Project Only

The `FieldOptionCache` is populated for exactly one project (`RALPH_GH_PROJECT_NUMBER`) via `ensureFieldCache`. It stores field IDs and option IDs keyed by field name and option name for that project only.

For multi-project sync, the cache cannot be used for projects other than the default. **Solution**: Fetch field metadata directly from each target project's `fields` connection when needed, using the same query shape as `fetchProjectForCache` in `helpers.ts:41-85`.

### `updateProjectItemField` Pattern (`helpers.ts:222-261`)

The existing function resolves `projectId`, `fieldId`, and `optionId` from `fieldCache` and calls `updateProjectV2ItemFieldValue`. For `sync_across_projects`, a parallel inline implementation is needed that takes pre-fetched IDs instead of cache lookups:

```typescript
// Direct mutation (no cache dependency)
await client.projectMutate<...>(
  `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
      value: { singleSelectOptionId: $optionId }
    }) { projectV2Item { id } }
  }`,
  { projectId, itemId: projectItemId, fieldId, optionId }
);
```

### `update_workflow_state` — Single-Project Only

The existing `update_workflow_state` tool (`issue-tools.ts:958-1010`) operates on exactly one project (the configured `RALPH_GH_PROJECT_NUMBER`). It has no multi-project awareness. `sync_across_projects` is the complementary tool for cross-project propagation.

## Implementation Plan

### New File: `tools/sync-tools.ts`

Follows the same `registerXxxTools(server, client, fieldCache)` pattern as all other tool files. Add import + call to `index.ts`.

### Tool Schema

```typescript
server.tool(
  "ralph_hero__sync_across_projects",
  "Propagate a Workflow State change to all GitHub Projects an issue belongs to. Queries projectItems to find all project memberships, applies the target state to projects where current state differs. Idempotent: skips projects already at target state. Returns: list of projects synced and skipped with reasons.",
  {
    owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
    repo: z.string().optional().describe("Repository name. Defaults to env var"),
    number: z.number().describe("Issue number to sync"),
    workflowState: z.string().describe('Target Workflow State to propagate (e.g., "In Progress")'),
    dryRun: z.boolean().optional().default(false)
      .describe("If true, return affected projects without mutating (default: false)"),
  },
  async (args) => { ... }
);
```

### GraphQL Queries Needed

**Query 1 — Discover all project memberships with current Workflow State:**
```graphql
query($issueId: ID!) {
  node(id: $issueId) {
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
```

This surfaces the current Workflow State (`name` on a `ProjectV2ItemFieldSingleSelectValue` where `field.name === "Workflow State"`) for every project the issue belongs to. Items where Workflow State matches the target are skipped (idempotency).

**Query 2 — Fetch field IDs + option IDs for a target project** (per-project, only for projects needing update):
```graphql
query($projectId: ID!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      fields(first: 20) {
        nodes {
          ... on ProjectV2SingleSelectField {
            id name
            options { id name }
          }
        }
      }
    }
  }
}
```

This is the same shape as `fetchProjectForCache` in `helpers.ts:60-85`. Returns field IDs and option name→ID mappings for the project, without populating the shared `FieldOptionCache` (to avoid polluting the default project cache).

### Handler Logic

```typescript
async (args) => {
  try {
    const { owner, repo } = resolveConfig(client, args);

    // 1. Resolve issue node ID
    const issueNodeId = await resolveIssueNodeId(client, owner, repo, args.number);

    // 2. Fetch all project memberships + current Workflow State
    const projectItemsResult = await client.query<ProjectItemsResult>(
      SYNC_PROJECT_ITEMS_QUERY,
      { issueId: issueNodeId }
    );
    const projectItems = projectItemsResult.node?.projectItems?.nodes ?? [];

    if (!projectItems.length) {
      return toolSuccess({
        number: args.number,
        message: "Issue is not a member of any GitHub Project",
        synced: [],
        skipped: [],
      });
    }

    const synced: SyncResult[] = [];
    const skipped: SyncResult[] = [];

    for (const item of projectItems) {
      const projectId = item.project.id;
      const projectNumber = item.project.number;

      // Extract current Workflow State from fieldValues
      const currentState = item.fieldValues.nodes
        .find((fv) => fv.__typename === "ProjectV2ItemFieldSingleSelectValue"
          && fv.field?.name === "Workflow State")
        ?.name ?? null;

      // Idempotency: skip if already at target state
      if (currentState === args.workflowState) {
        skipped.push({ projectNumber, reason: "already_at_target_state", currentState });
        continue;
      }

      if (args.dryRun) {
        synced.push({ projectNumber, currentState, targetState: args.workflowState, dryRun: true });
        continue;
      }

      // Fetch field IDs for this project
      const fieldMeta = await fetchProjectFieldMeta(client, projectId);
      const wfField = fieldMeta.find(f => f.name === "Workflow State");

      if (!wfField) {
        skipped.push({ projectNumber, reason: "no_workflow_state_field", currentState });
        continue;
      }

      const targetOption = wfField.options.find(o => o.name === args.workflowState);
      if (!targetOption) {
        skipped.push({
          projectNumber,
          reason: "invalid_option",
          currentState,
          detail: `"${args.workflowState}" not found. Valid: ${wfField.options.map(o => o.name).join(", ")}`,
        });
        continue;
      }

      // Apply the update
      await client.projectMutate(UPDATE_FIELD_MUTATION, {
        projectId,
        itemId: item.id,
        fieldId: wfField.id,
        optionId: targetOption.id,
      });

      synced.push({ projectNumber, currentState, targetState: args.workflowState });
    }

    return toolSuccess({
      number: args.number,
      workflowState: args.workflowState,
      dryRun: args.dryRun,
      syncedCount: synced.length,
      skippedCount: skipped.length,
      synced,
      skipped,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`Failed to sync across projects: ${message}`);
  }
}
```

### Helper: `fetchProjectFieldMeta`

Shared private helper (not exported) inside `sync-tools.ts`:

```typescript
async function fetchProjectFieldMeta(
  client: GitHubClient,
  projectId: string,
): Promise<Array<{ id: string; name: string; options: Array<{ id: string; name: string }> }>> {
  const result = await client.projectQuery<ProjectFieldMetaResult>(
    `query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 20) {
            nodes {
              ... on ProjectV2SingleSelectField { id name options { id name } }
            }
          }
        }
      }
    }`,
    { projectId }
  );
  return (result.node?.fields?.nodes ?? []).filter(f => f.id);
}
```

### File Changes

| File | Change | Effort |
|------|--------|--------|
| `tools/sync-tools.ts` | NEW — `registerSyncTools()`, `sync_across_projects` tool, `fetchProjectFieldMeta` helper | Primary |
| `index.ts` | Add import + `registerSyncTools(server, client, fieldCache)` call | Trivial |
| `__tests__/sync-tools.test.ts` | NEW — tests following `dashboard.test.ts` factory pattern | Secondary |

### Tests

```typescript
// Factory helper
function makeProjectItem(overrides = {}) {
  return {
    id: "item-1",
    project: { id: "proj-1", number: 1 },
    fieldValues: { nodes: [
      { __typename: "ProjectV2ItemFieldSingleSelectValue",
        name: "Backlog", field: { name: "Workflow State" } }
    ]},
    ...overrides,
  };
}

// Test cases:
// 1. No project memberships → returns empty synced/skipped
// 2. Single project, state differs → synced
// 3. Single project, already at target state → skipped with reason "already_at_target_state"
// 4. Project missing Workflow State field → skipped with reason "no_workflow_state_field"
// 5. Project has field but not the target option → skipped with reason "invalid_option"
// 6. dryRun=true → returns synced list without calling projectMutate
// 7. Multiple projects → syncs differing, skips matching
```

## Dependency Coordination

- **#180 (this issue)** — standalone, no blockers
- **#181 (webhook handler)** — blocked by #180; calls this tool or replicates its logic

## Risks

1. **`projectItems(first: 20)` limit**: An issue could theoretically be in more than 20 projects. `first: 20` should be sufficient for practical use; could be increased or paginated if needed.

2. **API call count per sync**: `N_different_projects` API calls for `fetchProjectFieldMeta` + `N_different_projects` mutations. For a typical 2-3 project setup, this is 4-6 calls total — acceptable.

3. **`client.projectMutate` vs `client.mutate`**: The `updateProjectV2ItemFieldValue` mutation for non-default projects should use `client.projectMutate()` (project token), same as other field update tools. The project token must have write access to all relevant projects, not just the default one.

4. **Status field sync**: The existing `update_workflow_state` calls `syncStatusField` after updating Workflow State to keep the default Status field in sync. `sync_across_projects` should also call status sync per project — but `syncStatusField` in `helpers.ts:388` is scoped to the single default project. For v1, skip status sync for non-default projects (document the gap).

## Recommended Approach

1. Create `tools/sync-tools.ts` with `registerSyncTools()` and the `sync_across_projects` tool
2. Use `resolveIssueNodeId` (from `helpers.ts`) to get the issue node ID
3. Query `projectItems(first: 20)` with `fieldValues` to discover all memberships and current states
4. For each project needing update: call `fetchProjectFieldMeta()` → resolve field/option IDs → `updateProjectV2ItemFieldValue`
5. Wire into `index.ts`
6. Tests with mocked `client.query` and `client.projectMutate`
