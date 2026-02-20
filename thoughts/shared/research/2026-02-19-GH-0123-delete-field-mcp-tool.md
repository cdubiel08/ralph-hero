---
date: 2026-02-19
github_issue: 123
github_url: https://github.com/cdubiel08/ralph-hero/issues/123
status: complete
type: research
---

# GH-123: Add `delete_field` MCP Tool

## Problem Statement

GitHub Projects V2 accumulate custom fields over time. Unused fields clutter the project UI and field cache. The ralph-hero MCP server has `clear_field` (clears a field's value on an item) but no tool to delete field definitions from the project schema.

## Current State Analysis

### Existing Field Operations

- **Clear field value**: [`project-management-tools.ts:327-392`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L327) — `ralph_hero__clear_field` uses `clearProjectV2ItemFieldValue` to clear a single item's field value
- **Update field options**: [`view-tools.ts:146-181`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/view-tools.ts#L146) — `updateProjectV2Field` updates field configuration (e.g., single-select options)
- **Field resolution**: [`lib/field-option-cache.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/field-option-cache.ts) — `FieldOptionCache` resolves field names to IDs via `getFieldId()`
- **No deletion**: No `deleteProjectV2Field` mutation call exists anywhere

### GitHub GraphQL API

**Mutation: `deleteProjectV2Field`**

Input (`DeleteProjectV2FieldInput!`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `projectId` | `ID!` | Yes | Project node ID |
| `fieldId` | `ID!` | Yes | Field node ID to delete |
| `clientMutationId` | `String` | No | Idempotency key |

Return (`DeleteProjectV2FieldPayload`):

| Field | Type | Description |
|-------|------|-------------|
| `projectV2Field` | `ProjectV2FieldConfiguration` | The deleted field (union: `ProjectV2Field`, `ProjectV2SingleSelectField`, `ProjectV2IterationField`) |

**Key notes:**
- Only custom fields can be deleted — built-in system fields (Title, Assignees, Status, Labels, Milestone, Repository, Linked pull requests) cannot be removed
- Requires project admin access
- Deletion is irreversible — all values for that field across all project items are lost

## Key Discoveries

### 1. Safety Guardrails Are Critical

The issue specifies refusing to delete Ralph's required fields: **Workflow State**, **Priority**, **Estimate**. These are custom single-select fields that Ralph depends on. The tool must:

1. Resolve the field name to an ID via `fieldCache.getFieldId(fieldName)`
2. Check against a hardcoded protected list before calling the mutation
3. Return an error if a protected field is targeted

Protected fields list:
- `Workflow State` — core workflow automation
- `Priority` — issue prioritization
- `Estimate` — sizing for sprint planning
- `Status` — synced from Workflow State (built-in, but should be protected too)

### 2. Dry-Run Mode

The issue requests `dryRun` mode or explicit `confirm: true`. Recommended approach:

- Default: **dry-run** (returns what would be deleted without executing)
- Requires `confirm: true` to actually delete
- This prevents accidental field deletion

### 3. Field ID Resolution via `FieldOptionCache`

The existing `getFieldId(fieldName)` in `FieldOptionCache` resolves field names to IDs. After deletion, the cache entry for that field becomes stale. The tool should invalidate the field cache after successful deletion.

### 4. Cache Invalidation After Deletion

After deleting a field, the `FieldOptionCache` will have stale entries. Options:
- Call `fieldCache.invalidate()` to clear the entire cache (simplest)
- Or rely on `projectMutate`'s automatic `query:` prefix invalidation (may not be sufficient since field cache is separate)

Recommended: Explicitly invalidate the field option cache after deletion.

## Recommended Approach

Add to `project-management-tools.ts`:

```typescript
server.tool(
  "ralph_hero__delete_field",
  "Delete a custom field from the project (refuses to delete Ralph required fields)",
  {
    owner: z.string().optional(),
    repo: z.string().optional(),
    field: z.string().describe("Name of the field to delete"),
    confirm: z.boolean().optional().default(false).describe("Must be true to execute deletion; false for dry-run"),
  },
  async (args) => { ... }
);
```

Data flow:
1. `resolveFullConfig(client, args)` → resolve project context
2. `ensureFieldCache(...)` → populate field/option IDs
3. Check `args.field` against protected list → error if protected
4. `fieldCache.getFieldId(args.field)` → resolve field ID
5. If `!args.confirm` → return dry-run result: `{ field, fieldId, action: "would_delete", confirm: false }`
6. If `args.confirm` → call `client.projectMutate(deleteProjectV2Field)` with `projectId` and `fieldId`
7. Invalidate field option cache
8. Return `{ field, deleted: true }`

## Risks

1. **Irreversible**: Field deletion cannot be undone. All item values for that field are permanently lost. The dry-run default mitigates this.
2. **Cache staleness**: After deletion, the `FieldOptionCache` has stale field entries. Must invalidate explicitly.
3. **Built-in vs custom**: The GitHub API itself prevents deleting built-in system fields, but the tool should also refuse Ralph's custom required fields before making the API call.

## Recommended Next Steps

1. Implement in `project-management-tools.ts` with dry-run default
2. Hardcode protected field list: `["Workflow State", "Priority", "Estimate", "Status"]`
3. Add explicit field cache invalidation after deletion
4. Add structural tests + test for protected field rejection
