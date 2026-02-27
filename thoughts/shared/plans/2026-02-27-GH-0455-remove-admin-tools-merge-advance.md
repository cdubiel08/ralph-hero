---
date: 2026-02-27
status: draft
github_issues: [455]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/455
primary_issue: 455
---

# Remove Setup/Admin Tools and Merge advance_issue — Atomic Implementation Plan

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-455 | Remove setup/admin tools and merge advance_issue | XS |

## Current State Analysis

**16 zero-usage tools** serve one-time setup, project administration, or operational concerns. All have `gh` CLI equivalents and 0 skill mentions in the runtime workflow. They add noise to the MCP toolspace that agents scan on every invocation.

**Advance tools**: `advance_children` (`relationship-tools.ts:642-849`) and `advance_parent` (`relationship-tools.ts:855-1097`) are separate tools with overlapping concerns. They can be merged into a single `advance_issue` tool with a `direction` parameter.

**`list_dependencies`** (`relationship-tools.ts:457-551`) returns `blocking`/`blockedBy` arrays — data already available in `get_issue`'s response (lines 722-730). Minor differences: `list_dependencies` returns `id` per item, uses `first: 50`, and includes `totalCount`. These differences don't affect any known skill usage.

**Status update CRUD**: `create_status_update` (line 1258) is used by `ralph-report` skill. `update_status_update` (line 1346) and `delete_status_update` (line 1441) have 0 skill mentions.

**Empty files after removal**: `sync-tools.ts` (1 tool), `routing-tools.ts` (1 tool), `view-tools.ts` (2 tools) will be completely empty after their tools are removed → delete files and remove `register*` calls from `index.ts`.

## Desired End State

- 18 tool registrations removed
- 2 tool registrations removed and replaced by 1 (`advance_children` + `advance_parent` → `advance_issue`)
- 3 source files deleted (`sync-tools.ts`, `routing-tools.ts`, `view-tools.ts`)
- 3 `register*` calls removed from `index.ts`
- Net: -19 tools + 1 new = -18

### Verification
- [ ] `advance_issue(direction: "children", number: N, targetState: "Ready for Plan")` works
- [ ] `advance_issue(direction: "parent", number: N)` works
- [ ] Empty source files deleted
- [ ] `index.ts` clean (no orphan imports)
- [ ] `npm test` and `npm run build` pass

## What We're NOT Doing

- Updating skills/agents that reference removed tools (Phase 5, GH-456)
- Building `save_issue` (Phase 1, GH-452)
- Collapsing read tools (Phase 3, GH-454)
- Updating `ralph-setup` skill to use `gh` CLI (Phase 5, GH-456)

## Implementation Approach

Mostly mechanical deletion. The only creative work is merging `advance_children` + `advance_parent` into `advance_issue`. Order: (1) create `advance_issue`, (2) remove old advance tools, (3) remove admin/setup tools file by file, (4) delete empty files, (5) clean up `index.ts`.

---

## Phase 1: GH-455 — Remove setup/admin tools and merge advance_issue
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/455

### Changes Required

#### 1. Create unified `advance_issue` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`
**Changes**: Add new tool registration (insert before or after the existing advance tools):

```typescript
server.tool(
  "ralph_hero__advance_issue",
  "Advance workflow state for related issues. " +
    "direction='children': advance sub-issues (or explicit list) to targetState, skipping those already at/past it. " +
    "direction='parent': check if all siblings reached a gate state and advance parent if so.",
  {
    owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
    repo: z.string().optional().describe("Repository name. Defaults to env var"),
    projectNumber: z.coerce.number().optional().describe("Project number override"),
    direction: z.enum(["children", "parent"])
      .describe("'children' advances sub-issues to targetState; 'parent' auto-detects gate state from siblings"),
    number: z.coerce.number().describe("Parent issue number (for children) or child issue number (for parent)"),
    // children-specific params
    targetState: z.string().optional()
      .describe("Target state to advance children to. Required when direction='children'."),
    issues: z.array(z.coerce.number()).optional()
      .describe("Explicit issue list instead of sub-issues. Only used with direction='children'."),
  },
  async (args) => {
    if (args.direction === "children") {
      // Validate targetState is provided
      if (!args.targetState) {
        return toolError("targetState is required when direction='children'.");
      }
      // Copy handler logic from advance_children (lines 672-849)
      // ... resolveFullConfig, ensureFieldCache, build issueNumbers,
      // ... iterate, getCurrentFieldValue, skip if at/past, updateProjectItemField, syncStatusField
      // ... return { advanced, skipped, errors }
    } else {
      // direction === "parent"
      // Copy handler logic from advance_parent (lines 873-1097)
      // ... fetch child issue, get parent, fetch siblings,
      // ... find minimum state, check gate state, advance parent
      // ... return { advanced, parent: { fromState, toState }, childStates }
    }
  }
);
```

**Implementation**: The handler bodies are direct copies from the existing `advance_children` (lines 672-849) and `advance_parent` (lines 873-1097) handlers, dispatched by the `direction` parameter. No logic changes needed — just structural reorganization.

#### 2. Remove old advance tools
**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`
**Changes**: Remove:
- `ralph_hero__advance_children` registration (lines ~642-849)
- `ralph_hero__advance_parent` registration (lines ~855-1097)

#### 3. Remove `list_dependencies` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`
**Changes**: Remove registration at lines ~457-551. The `get_issue` response already includes `blocking` and `blockedBy` arrays.

#### 4. Remove tools from `project-management-tools.ts`
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Changes**: Remove these 10 tool registrations (preserve `create_status_update` at line 1258 and `bulk_archive` at line 1489):

| Tool | Lines |
|------|-------|
| `remove_from_project` | ~131-207 |
| `add_to_project` | ~209-278 |
| `link_repository` | ~280-374 |
| `reorder_item` | ~881-953 |
| `update_project` | ~955-1049 |
| `delete_field` | ~1051-1133 |
| `update_collaborators` | ~1135-1256 |
| `update_status_update` | ~1346-1439 |
| `delete_status_update` | ~1441-1487 |
| `link_team` | ~1678-end |

**Note**: `archive_item` (lines 44-126) and `clear_field` (lines 376-442) are removed in Phases 3 and 2 respectively, not here. If those phases haven't landed yet, leave them in place.

After removal, `project-management-tools.ts` should contain only:
- `archive_item` (removed by Phase 3)
- `clear_field` (removed by Phase 2)
- `create_status_update` (kept)
- `bulk_archive` (kept, extended by Phase 3)

Plus any shared imports/helpers used by the remaining tools.

#### 5. Remove tools from `project-tools.ts`
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`
**Changes**: Remove these 3 tool registrations (preserve `setup_project` at line 173, `get_project` at line 417):

| Tool | Lines |
|------|-------|
| `list_projects` | ~489-615 |
| `copy_project` | ~617-767 |
| `list_project_repos` | ~1102-end |

**Note**: `list_project_items` (lines 769-1097) is removed by Phase 3, not here.

After removal, `project-tools.ts` should contain only:
- `setup_project` (kept)
- `get_project` (kept)
- `list_project_items` (removed by Phase 3)

#### 6. Delete `view-tools.ts`
**File**: `plugin/ralph-hero/mcp-server/src/tools/view-tools.ts`
**Changes**: Delete the entire file. It contains only `list_views` (line 29) and `update_field_options` (line 83) — both being removed.

#### 7. Delete `sync-tools.ts`
**File**: `plugin/ralph-hero/mcp-server/src/tools/sync-tools.ts`
**Changes**: Delete the entire file. It contains only `sync_across_projects` (line 207).

**Note**: The file also exports two pure functions (`buildSyncAuditBody`, `detectSyncAuditMarker`) used in tests. If tests import these, either:
- Delete the corresponding tests (they test removed functionality)
- Move the functions to a test helper file

#### 8. Delete `routing-tools.ts`
**File**: `plugin/ralph-hero/mcp-server/src/tools/routing-tools.ts`
**Changes**: Delete the entire file. It contains only `configure_routing` (line 40).

#### 9. Update `index.ts`
**File**: `plugin/ralph-hero/mcp-server/src/index.ts`
**Changes**:
- Remove import at line 19: `import { registerViewTools } from "./tools/view-tools.js"`
- Remove import at line 26: `import { registerRoutingTools } from "./tools/routing-tools.js"`
- Remove import at line 27: `import { registerSyncTools } from "./tools/sync-tools.js"`
- Remove call at line 332: `registerViewTools(server, client, fieldCache)`
- Remove call at line 353: `registerRoutingTools(server, client, fieldCache)`
- Remove call at line 356: `registerSyncTools(server, client, fieldCache)`

#### 10. Update tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/`
**Changes**:

a. **Remove test files** for deleted tools:
- Any test file for `sync-tools` (e.g., `sync-tools.test.ts`)
- Any test file for `routing-tools`
- Any test file for `view-tools`
- Tests referencing `advance_children`, `advance_parent`, `list_dependencies`

b. **Add tests** for `advance_issue`:
- Schema test: `direction: "children"` + `number` + `targetState` accepted
- Schema test: `direction: "parent"` + `number` accepted (no `targetState` needed)
- Schema test: `direction: "children"` without `targetState` → should fail at runtime
- Schema test: `issues` array accepted with `direction: "children"`
- Structural test: tool is registered as `ralph_hero__advance_issue`

c. **Preserve** existing tests for `advance_children` schema if they exist — migrate them to test `advance_issue` schema with `direction: "children"`.

### Success Criteria

#### Automated Verification:
- [x] `npm run build` passes
- [x] `npm test` passes
- [x] `grep -r "list_projects\|copy_project\|update_project\|list_views\|list_project_repos\|remove_from_project\|reorder_item\|link_team\|delete_field\|update_collaborators\|add_to_project\|link_repository\|update_status_update\|delete_status_update\|sync_across_projects\|configure_routing\|update_field_options\|advance_children\|advance_parent\|list_dependencies" plugin/ralph-hero/mcp-server/src/tools/` returns no tool registrations
- [x] Files `sync-tools.ts`, `routing-tools.ts`, `view-tools.ts` do not exist
- [x] `index.ts` has no imports from deleted files
- [x] `advance_issue` tool registered with `direction` enum

#### Manual Verification:
- [ ] `advance_issue(direction: "children", number: N, targetState: "Ready for Plan")` advances sub-issues
- [ ] `advance_issue(direction: "parent", number: N)` checks gate and advances parent
- [ ] MCP server starts cleanly with no registration errors

**Implementation Note**: After automated verification passes, pause for manual confirmation.

---

## Key Implementation Notes

1. **Order of removal matters for merge conflicts**: Since Phases 1-4 may be implemented in parallel branches, each phase should only remove the tools assigned to it. Phase 4 should NOT remove `archive_item` (Phase 3) or `clear_field`/`update_issue`/`update_workflow_state`/`update_estimate`/`update_priority` (Phase 2).

2. **`advance_issue` is a mechanical merge**: No logic changes — just dispatch by `direction`. Copy the handler bodies verbatim from the existing tools.

3. **`sync-tools.ts` exports**: The file exports `buildSyncAuditBody` and `detectSyncAuditMarker` pure functions used in tests. Delete the tests along with the file, or move functions to a test-only module if tests have value.

4. **`project-management-tools.ts` will shrink dramatically**: After Phase 4 removes 10 tools, and Phase 2 removes `clear_field`, and Phase 3 removes `archive_item`, the file will contain only `create_status_update` and the merged `bulk_archive`/`archive_items`. Consider whether this file is still worth keeping or whether to move remaining tools to another file — but that's a Phase 6 cleanup decision, not Phase 4.

5. **No skill updates in this phase**: Skills referencing `link_repository`, `configure_routing`, `update_field_options` (used by `ralph-setup`) will be updated in Phase 5 (GH-456) to use `gh` CLI equivalents.

## References

- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/451
- Parent plan: `thoughts/shared/plans/2026-02-27-mcp-toolspace-consolidation.md` Phase 4
- `advance_children`: `relationship-tools.ts:642-849`
- `advance_parent`: `relationship-tools.ts:855-1097`
- `list_dependencies`: `relationship-tools.ts:457-551`
- `index.ts` register calls: lines 332, 353, 356
- `index.ts` imports: lines 19, 26, 27
