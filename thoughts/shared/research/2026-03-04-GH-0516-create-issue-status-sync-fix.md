---
date: 2026-03-04
topic: "GH-516: create_issue should sync Status field like save_issue does"
tags: [research, create_issue, status-sync, state-machine, mcp-server, issue-tools]
status: complete
type: research
github_issue: 516
github_url: https://github.com/cdubiel08/ralph-hero/issues/516
---

# Research: GH-516 — `create_issue` Status Field Sync Fix

## Summary

The `create_issue` MCP handler sets `workflowState` via `updateProjectItemField` but never calls `syncStatusField()` afterward. This leaves the GitHub default Status field (Todo/In Progress/Done) at its default when `workflowState` is provided. The fix is adding one `await syncStatusField(...)` call in [`plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts) immediately after the workflowState block.

## Problem Confirmed

The audit research doc (`thoughts/shared/research/2026-03-03-GH-0000-state-machine-transition-audit.md`) identified this as a "latent inconsistency" at §7. Currently no skill passes `workflowState` to `create_issue`, so the bug is not actively triggered. However, with GH-514 and GH-515 fixes landing, skills will start calling `save_issue(workflowState: "Backlog")` after `create_issue` — the Status sync will happen via `save_issue`. But fixing `create_issue` directly makes it consistent and future-proof.

## Code Location

### `create_issue` handler — workflowState block

[`issue-tools.ts:1039-1049`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1039-L1049):

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
```

**Fix**: Add `await syncStatusField(...)` immediately after this block.

### `syncStatusField` signature

[`lib/helpers.ts:569-597`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L569-L597):

```typescript
export async function syncStatusField(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  projectItemId: string,
  workflowState: string,
  projectNumber?: number,
): Promise<void>
```

`syncStatusField` is already imported in `issue-tools.ts` at line 41.

### `save_issue` reference implementation

In `save_issue` (lines ~1095-1430), `syncStatusField` is called after every workflowState transition:
```typescript
if (workflowState) {
  await updateProjectItemField(...);
  await syncStatusField(client, fieldCache, projectItemId, workflowState, projectNumber);
}
```

## Implementation

Add after the existing workflowState block (after line 1049):

```typescript
if (args.workflowState) {
  await syncStatusField(
    client,
    fieldCache,
    projectItemId,
    args.workflowState,
    projectNumber,
  );
}
```

The function is best-effort (catches internally), so no try/catch needed here.

## Files to Change

| File | Location | Change |
|------|----------|--------|
| `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` | After line 1049 (end of workflowState block in Step 5) | Add `await syncStatusField(...)` call |

## Test Coverage

The existing `__tests__/` suite should cover this. A test verifying Status field sync after `create_issue` with workflowState would be ideal, but the function is best-effort, so a simple call verification suffices.

## Risk

- Low: `syncStatusField` is already tested, already imported, best-effort (never throws). Adding the call cannot break existing behavior.
- The guard `if (args.workflowState)` ensures the call only happens when workflowState is provided — same pattern as `save_issue`.

## Files Affected

### Will Modify

- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` — add `await syncStatusField(...)` after workflowState block in `create_issue` handler (after line 1049)

### Will Read (Dependencies)

- `plugin/ralph-hero/mcp-server/src/lib/helpers.ts` — `syncStatusField` implementation (lines 569-597)
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` — `save_issue` handler as reference (lines ~1095-1430)
- `thoughts/shared/research/2026-03-03-GH-0000-state-machine-transition-audit.md` — audit context

## Related Issues

- #514: `form-idea` SKILL.md — add workflowState to save_issue calls (skill layer fix)
- #515: `ralph-triage` SKILL.md — add workflowState to split path save_issue calls (skill layer fix)

These three issues form a coherent group: #516 fixes the MCP server layer, #514/#515 fix the skill prompt layer.
