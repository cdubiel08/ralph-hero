---
date: 2026-02-27
status: draft
github_issues: [453]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/453
primary_issue: 453
---

# Remove 5 Old Mutation Tools — Atomic Implementation Plan

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-453 | Remove 5 old mutation tools | XS |

## Current State Analysis

Phase 1 (GH-452) created the unified `save_issue` tool that replaces 5 separate mutation tools:

| Tool to remove | File | Lines | What it does |
|----------------|------|-------|-------------|
| `update_issue` | `issue-tools.ts` | ~969-1074 | Title, body, labels via `updateIssue` mutation |
| `update_workflow_state` | `issue-tools.ts` | ~1079-1174 | Workflow state via `updateProjectV2ItemFieldValue` + status sync |
| `update_estimate` | `issue-tools.ts` | ~1179-1232 | Estimate via `updateProjectV2ItemFieldValue` |
| `update_priority` | `issue-tools.ts` | ~1237-1290 | Priority via `updateProjectV2ItemFieldValue` |
| `clear_field` | `project-management-tools.ts` | ~374-442 | Clears any project field via `clearProjectV2ItemFieldValue` |

All 5 tools' capabilities are now handled by `save_issue`:
- `update_issue` → `save_issue(title=..., body=..., labels=...)`
- `update_workflow_state` → `save_issue(workflowState=..., command=...)`
- `update_estimate` → `save_issue(estimate=...)`
- `update_priority` → `save_issue(priority=...)`
- `clear_field` → `save_issue(estimate=null)` or `save_issue(priority=null)`

**Prerequisite**: `save_issue` must be implemented and tested (GH-452 done) before these tools are removed.

## Desired End State

- 5 tool registrations removed from source
- Tests for removed tools deleted or migrated to `save_issue` tests
- Helper functions used by multiple tools preserved (e.g., `resolveConfig`, `resolveFullConfig`, `ensureFieldCache`, `resolveProjectItemId`, `updateProjectItemField`, `syncStatusField`)
- `npm test` and `npm run build` pass

### Verification
- [x] 5 tool registrations gone from source
- [x] No broken imports or references
- [x] All tests pass
- [x] Build succeeds

## What We're NOT Doing

- Updating skills/agents/justfile that reference removed tools (Phase 5, GH-456)
- Removing read tools (Phase 3, GH-454)
- Removing admin tools (Phase 4, GH-455)

## Implementation Approach

Straight mechanical deletion. Remove tool registrations in order from bottom to top within each file (to avoid shifting line numbers). Preserve all shared helper functions. Delete or migrate tests.

---

## Phase 1: GH-453 — Remove 5 old mutation tools
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/453

### Changes Required

#### 1. Remove 4 tool registrations from `issue-tools.ts`
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: Remove these 4 `server.tool(...)` blocks in reverse order (bottom-up to preserve line numbers):

1. **`ralph_hero__update_priority`** (~lines 1237-1290)
   - Remove entire `server.tool("ralph_hero__update_priority", ...)` block
   - ~53 lines

2. **`ralph_hero__update_estimate`** (~lines 1179-1232)
   - Remove entire `server.tool("ralph_hero__update_estimate", ...)` block
   - ~53 lines

3. **`ralph_hero__update_workflow_state`** (~lines 1079-1174)
   - Remove entire `server.tool("ralph_hero__update_workflow_state", ...)` block
   - ~95 lines
   - **Note**: The `resolveState` import from `state-resolution.ts` must be preserved — `save_issue` uses it

4. **`ralph_hero__update_issue`** (~lines 969-1074)
   - Remove entire `server.tool("ralph_hero__update_issue", ...)` block
   - ~105 lines
   - **Note**: The label resolution pattern (fetching repo labels, resolving names to IDs) is now in `save_issue`. If `save_issue` inlined this logic, the old code can be safely removed. If `save_issue` calls a shared helper, preserve the helper.

**Total**: ~306 lines removed from `issue-tools.ts`

**Preserve these (used by `save_issue` and other tools)**:
- `getIssueFieldValues` function (~lines 1892-1964) — used by `get_issue(includePipeline: true)` after Phase 3
- `computeDistance` helper (~lines 1972-1977) — may be removed if `check_convergence` was removed in Phase 3
- All imports: `resolveState`, `resolveConfig`, `resolveFullConfig`, `ensureFieldCache`, `resolveProjectItemId`, `updateProjectItemField`, `syncStatusField`, `WORKFLOW_STATE_TO_STATUS`, `TERMINAL_STATES`

#### 2. Remove `clear_field` from `project-management-tools.ts`
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Changes**: Remove `server.tool("ralph_hero__clear_field", ...)` block at ~lines 374-442 (~68 lines).

**Note**: The `clearProjectV2ItemFieldValue` mutation pattern may have been extracted to a helper in `helpers.ts` during Phase 1 (GH-452) for use by `save_issue`. If so, preserve the helper. If `clear_field` was the only caller and `save_issue` inlined its own clearing logic, the removal is clean.

#### 3. Clean up unused imports
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: After removing the 4 tools, check for any imports that are now unused. Common candidates:
- If `getCurrentFieldValue` was only used by `update_workflow_state` and `check_convergence` (removed in Phase 3), it may become unused
- If `isValidState` was only used by `check_convergence`, it may become unused

Run `npm run build` — TypeScript will flag unused imports if `noUnusedLocals` is enabled. Otherwise, manually verify.

**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Changes**: Check if removing `clear_field` leaves any unused imports. Likely candidates: field cache helpers that were only used by `clear_field`.

#### 4. Remove or migrate tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/`
**Changes**:

a. **Search for test files** referencing the 5 removed tools:
```
grep -rl "update_issue\|update_workflow_state\|update_estimate\|update_priority\|clear_field" plugin/ralph-hero/mcp-server/src/__tests__/
```

b. **For each match**:
- If the entire test file tests only removed tools → delete the file
- If the test file has a mix of removed and kept tool tests → delete only the `describe`/`it` blocks for removed tools
- If tests verify behavior now covered by `save_issue` → ensure equivalent coverage exists in `save-issue.test.ts` (created in Phase 1)

c. **Structural tests** (like `issue-tools.test.ts` that read source code):
- Remove any assertions that check for the existence of removed tool registrations
- Remove any assertions about removed tools' schema parameters

d. **Schema validation tests** (like `project-number-override.test.ts`):
- If they test `projectNumber` override on `update_estimate`/`update_priority` schemas → remove those specific test cases (the behavior is now tested on `save_issue`'s schema)

### Success Criteria

#### Automated Verification:
- [x] `npm run build` passes in `plugin/ralph-hero/mcp-server/`
- [x] `npm test` passes in `plugin/ralph-hero/mcp-server/`
- [x] `grep -r "ralph_hero__update_issue\|ralph_hero__update_workflow_state\|ralph_hero__update_estimate\|ralph_hero__update_priority\|ralph_hero__clear_field" plugin/ralph-hero/mcp-server/src/tools/` returns empty (no tool registrations)
- [x] No orphaned imports in modified files

#### Manual Verification:
- [ ] MCP server starts cleanly
- [ ] Tool list no longer shows the 5 removed tools
- [ ] `save_issue` still works (regression check)

**Implementation Note**: This is a quick mechanical phase. After automated verification, pause briefly for manual spot-check.

---

## Key Implementation Notes

1. **Remove bottom-up**: Delete tool registrations from the bottom of the file upward to avoid shifting line numbers mid-edit.

2. **Preserve shared helpers**: The helper functions in `helpers.ts` (`resolveConfig`, `resolveFullConfig`, `ensureFieldCache`, `resolveProjectItemId`, `updateProjectItemField`, `syncStatusField`, `getCurrentFieldValue`) are used by multiple tools including `save_issue`, `batch_update`, `advance_issue`, and `get_issue`. Do NOT remove them.

3. **Line numbers may have shifted**: Phase 1 (GH-452) added `save_issue` to `issue-tools.ts`, which shifted all subsequent line numbers. The builder should use tool names (grep for `ralph_hero__update_issue` etc.) rather than hard-coded line numbers to locate the blocks to remove.

4. **`clear_field` has a protected fields list**: The `clear_field` tool at `project-management-tools.ts` has a `PROTECTED_FIELDS` check that prevents clearing `Workflow State`. If `save_issue` doesn't have equivalent protection, consider whether it's needed. Since `save_issue` uses explicit `workflowState` param (not a generic field name), the protection is inherent — you can't accidentally clear workflow state by setting it to `null` because it's typed as a string, not nullable.

5. **No skill updates here**: Skills still reference the old tool names. That's intentional — Phase 5 (GH-456) handles all consumer updates. The old tool names in skills will cause runtime warnings/errors until Phase 5 lands, which is acceptable for the consolidation rollout.

## References

- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/451
- Parent plan: `thoughts/shared/plans/2026-02-27-mcp-toolspace-consolidation.md` Phase 2
- Phase 1 plan (save_issue): `thoughts/shared/plans/2026-02-27-GH-0452-build-save-issue-tool.md`
- Tool registrations: `issue-tools.ts:969-1290`, `project-management-tools.ts:374-442`
- Shared helpers: `helpers.ts:471-597`
