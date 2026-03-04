---
date: 2026-03-04
status: draft
github_issues: [516]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/516
primary_issue: 516
---

# `create_issue` Status Field Sync — Implementation Plan

## Overview

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-516 | `create_issue` should sync Status field like `save_issue` does | XS |

## Current State Analysis

The `save_issue` handler in [`issue-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts) calls `syncStatusField()` after every workflowState change, mapping Workflow State values to the GitHub default Status field (Todo/In Progress/Done) via `WORKFLOW_STATE_TO_STATUS`.

The `create_issue` handler sets `workflowState` via `updateProjectItemField()` at [lines 1040-1048](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1040-L1048) but never calls `syncStatusField()`. This is a latent inconsistency — currently no skill passes `workflowState` to `create_issue`, but the parameter exists and would produce incorrect Status if used.

`syncStatusField` is already imported at [line 41](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L41).

## Desired End State

### Verification
- [ ] `create_issue` calls `syncStatusField()` after setting workflowState
- [ ] Build passes (`npm run build` in mcp-server)
- [ ] Tests pass (`npm test` in mcp-server)

## What We're NOT Doing
- Not modifying any SKILL.md files (those are GH-514 and GH-515)
- Not changing `save_issue` behavior
- Not adding new tests (function is best-effort, already tested independently)

## Implementation Approach

Single insertion of an `await syncStatusField(...)` call after the existing workflowState block in `create_issue`. The function is best-effort (catches errors internally), so no additional error handling is needed.

---

## Phase 1: GH-516 — `create_issue` Status sync
> **Issue**: [GH-516](https://github.com/cdubiel08/ralph-hero/issues/516) | **Research**: [2026-03-04-GH-0516](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-04-GH-0516-create-issue-status-sync-fix.md)

### Changes Required

#### 1. Add `syncStatusField()` call after workflowState block
**File**: [`plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts)
**Location**: After the `if (args.workflowState)` block ending at line 1049, before the `if (args.estimate)` block at line 1051.

Before (lines 1039-1051):
```typescript
        // Step 5: Set field values
        if (args.workflowState) {
          await updateProjectItemField(
            client,
            fieldCache,
            projectItemId,
            "Workflow State",
            args.workflowState,
            projectNumber,
          );
        }

        if (args.estimate) {
```

After:
```typescript
        // Step 5: Set field values
        if (args.workflowState) {
          await updateProjectItemField(
            client,
            fieldCache,
            projectItemId,
            "Workflow State",
            args.workflowState,
            projectNumber,
          );
          await syncStatusField(
            client,
            fieldCache,
            projectItemId,
            args.workflowState,
            projectNumber,
          );
        }

        if (args.estimate) {
```

### Success Criteria
- [ ] Automated: `npm run build` succeeds in `plugin/ralph-hero/mcp-server/`
- [ ] Automated: `npm test` passes in `plugin/ralph-hero/mcp-server/`
- [ ] Automated: `grep -A8 'if (args.workflowState)' plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts | grep syncStatusField` finds the call
- [ ] Manual: Verify the `syncStatusField` call is inside the `if (args.workflowState)` guard, matching `save_issue`'s pattern

---

## Integration Testing
- [ ] `npm run build` succeeds
- [ ] `npm test` passes
- [ ] `syncStatusField` call is present inside `if (args.workflowState)` block in `create_issue` handler
- [ ] No changes to `save_issue` handler or any other handler

## References
- Research: [2026-03-04-GH-0516-create-issue-status-sync-fix.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-04-GH-0516-create-issue-status-sync-fix.md)
- Audit: [2026-03-03-GH-0000-state-machine-transition-audit.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-03-GH-0000-state-machine-transition-audit.md)
- Related: [GH-514](https://github.com/cdubiel08/ralph-hero/issues/514), [GH-515](https://github.com/cdubiel08/ralph-hero/issues/515) — skill-layer workflowState fixes (separate plan)
