---
date: 2026-03-01
github_issue: 483
github_url: https://github.com/cdubiel08/ralph-hero/issues/483
status: complete
type: research
---

# GH-483: `save_issue` Fails on Terminal State Transitions — `stateReason` Not Accepted by `UpdateIssueInput`

## Problem Statement

When `save_issue` is called with a terminal `workflowState` (e.g., `"Done"` or `"Canceled"`), or with `issueState: "CLOSED"` / `"CLOSED_NOT_PLANNED"`, the tool triggers an auto-close path that passes `stateReason` to the `updateIssue` GraphQL mutation. However, `UpdateIssueInput` does not accept `stateReason`. The mutation fails with:

```
InputObject 'UpdateIssueInput' doesn't accept argument 'stateReason'
```

This breaks all terminal state transitions made through `save_issue`, including auto-closes triggered by `workflowState: "Done"` or `workflowState: "Canceled"`, and explicit closes via `issueState: "CLOSED"` or `issueState: "CLOSED_NOT_PLANNED"`.

## Current State Analysis

### Root Cause — Confirmed via Schema Introspection

GitHub's GraphQL schema was introspected directly to confirm the field boundaries:

**`UpdateIssueInput` fields** (does NOT include `stateReason`):
- `clientMutationId`, `id`, `title`, `body`, `assigneeIds`, `milestoneId`, `labelIds`, `state` (IssueState enum: OPEN|CLOSED), `projectIds`, `issueTypeId`, `agentAssignment`

**`CloseIssueInput` fields** (DOES include `stateReason`):
- `clientMutationId`, `issueId` (required), `stateReason` (IssueClosedStateReason enum), `duplicateIssueId`

**`ReopenIssueInput` fields** (no stateReason):
- `clientMutationId`, `issueId` (required)

**`IssueClosedStateReason` enum values**: `COMPLETED`, `NOT_PLANNED`, `DUPLICATE`

### Buggy Code Location

`plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`, lines 1161–1238.

The `save_issue` handler computes `targetState` and `stateReason`:

```typescript
// lines 1162-1179
let targetState: "OPEN" | "CLOSED" | undefined;
let stateReason: "COMPLETED" | "NOT_PLANNED" | "REOPENED" | undefined;

if (args.issueState === "CLOSED") {
  targetState = "CLOSED";
  stateReason = "COMPLETED";
} else if (args.issueState === "CLOSED_NOT_PLANNED") {
  targetState = "CLOSED";
  stateReason = "NOT_PLANNED";
} else if (args.issueState === "OPEN") {
  targetState = "OPEN";
  stateReason = "REOPENED";
}

// Auto-close: if workflowState is terminal and issueState not explicitly set
if (!args.issueState && resolvedWorkflowState && TERMINAL_STATES.includes(resolvedWorkflowState)) {
  targetState = "CLOSED";
  stateReason = resolvedWorkflowState === "Canceled" ? "NOT_PLANNED" : "COMPLETED";
  changes.autoClose = true;
}
```

Then passes `stateReason` directly into `updateIssue` at line 1217–1238:

```typescript
await client.mutate<{...}>(
  `mutation($issueId: ID!, ..., $state: IssueState, $stateReason: IssueClosedStateReason) {
    updateIssue(input: {
      id: $issueId,
      ...
      state: $state,
      stateReason: $stateReason   // <-- INVALID for UpdateIssueInput
    }) { ... }
  }`,
  { ..., state: targetState ?? null, stateReason: stateReason ?? null },
);
```

### Secondary Issue: `REOPENED` is Not a Valid `IssueClosedStateReason`

The `IssueClosedStateReason` enum only has `COMPLETED`, `NOT_PLANNED`, `DUPLICATE`. The code assigns `stateReason = "REOPENED"` for the `issueState === "OPEN"` path, which is not a valid enum value. Reopening uses the separate `reopenIssue` mutation (which has no `stateReason` parameter at all).

### What `updateIssue` CAN Do

`UpdateIssueInput` accepts `state: IssueState` (OPEN|CLOSED), but it does NOT set `stateReason`. If you close via `updateIssue(state: CLOSED)`, the `stateReason` on the issue will be set to `null` (or a default). To close with a specific `stateReason`, you must use the `closeIssue` mutation.

## Key Discoveries

1. **Three separate mutations** exist for three operations: `updateIssue` (metadata + state toggle), `closeIssue` (close with reason), `reopenIssue` (reopen).
2. **The bug affects ALL close paths** in `save_issue`: auto-close from terminal `workflowState`, explicit `issueState: "CLOSED"`, and `issueState: "CLOSED_NOT_PLANNED"`.
3. **The reopen path also uses wrong variable** — `stateReason: "REOPENED"` which is not a valid enum value. However since the `state: OPEN` path calls `updateIssue(state: OPEN, stateReason: "REOPENED")`, both are wrong.
4. **Existing tests are structural, not integration tests** — `save-issue.test.ts` verifies source code strings and schema parsing but does not exercise the actual GraphQL mutations, so the bug was not caught by tests.
5. **`batch_update` and `advance_issue` are NOT affected** — they only update project fields (via `updateProjectV2ItemFieldValue`), never call `updateIssue` directly.
6. **`DUPLICATE` is a valid `IssueClosedStateReason`** not currently exposed by `save_issue`. This is minor but could be a future enhancement.

## Potential Approaches

### Approach A: Split `updateIssue` Call into Separate Mutations (Recommended)

Decompose the single `updateIssue` call into:
1. **`updateIssue`** — for title, body, labels, assignees (fields that `UpdateIssueInput` actually accepts, including `state` if reopening)
2. **`closeIssue`** — when `targetState === "CLOSED"`, using `stateReason: COMPLETED | NOT_PLANNED`
3. **`reopenIssue`** — when `targetState === "OPEN"`

This cleanly maps to how GitHub's API is designed. Each mutation is called only when the operation is needed. The issue fields update (`title`, `body`, etc.) and the state change are independent operations, which is fine since they are already sequential.

**Pros:**
- Correctly models the GitHub API contract
- Sets `stateReason` properly on closed issues
- Matches the workaround already working in the field
- Minimal change: add ~2 new mutation calls, keep the structure

**Cons:**
- Increases API calls for combined close+metadata updates (2 calls instead of 1 when both are needed)
- Slightly more code

### Approach B: Remove `stateReason` from `updateIssue`, Keep Single Mutation

Remove `stateReason` from `UpdateIssueInput` call, keeping `state: CLOSED | OPEN` in `updateIssue`. Closing via `updateIssue(state: CLOSED)` does close the issue but `stateReason` will be `null` on the GitHub issue.

**Pros:**
- Minimal code change (just remove `stateReason` from the mutation)
- One fewer mutation call

**Cons:**
- Issues closed via `save_issue` will always have `stateReason: null` (no "Completed" or "Not Planned" badge in GitHub UI)
- Degrades UX — `Canceled` issues should show "Not Planned" in GitHub
- Violates expected behavior described in tool docs

### Approach C: Use `closeIssue` Only (Remove `state` from `updateIssue` entirely)

Always use `closeIssue`/`reopenIssue` for state changes; never pass `state` to `updateIssue`.

**Pros:** Cleanest separation
**Cons:** Same as Approach A (multiple calls). Not materially different from A in practice.

## Recommended Approach: A

Split the mutation. When closing, call `closeIssue` with the correct `stateReason`. When reopening, call `reopenIssue`. When updating metadata (title, body, labels), call `updateIssue` without `state` or `stateReason`.

The fix is isolated to one function block in `issue-tools.ts` (lines 1184–1246). No changes needed in `batch-tools.ts` or `relationship-tools.ts`.

## Risks

- **Low risk**: The existing mutation structure is already sequential; splitting into multiple calls changes nothing semantically.
- **API call increase**: From 1 to 2 calls for combined updates — negligible for this synchronous path.
- **Test coverage gap**: Need to add structural tests that verify the correct mutation names (`closeIssue`, `reopenIssue`) are used, not just that `stateReason` appears somewhere.

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` - Fix `save_issue` mutation: split `updateIssue` into `updateIssue` + `closeIssue`/`reopenIssue` as appropriate
- `plugin/ralph-hero/mcp-server/src/__tests__/save-issue.test.ts` - Add structural tests asserting `closeIssue` and `reopenIssue` mutation names are present, `stateReason` is NOT in `updateIssue` input

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts` - `TERMINAL_STATES` constants used in auto-close logic
- `plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts` - `resolveState` used for semantic intent resolution upstream of auto-close
- `plugin/ralph-hero/mcp-server/src/lib/helpers.ts` - `resolveIssueNodeId` used to get the issue node ID for all mutations

## Implementation Notes

The fix in `issue-tools.ts` around line 1183 should be structured approximately as:

```typescript
// When closing: use closeIssue mutation (supports stateReason)
if (targetState === "CLOSED") {
  await client.mutate(
    `mutation($issueId: ID!, $stateReason: IssueClosedStateReason) {
      closeIssue(input: { issueId: $issueId, stateReason: $stateReason }) {
        issue { number state stateReason }
      }
    }`,
    { issueId, stateReason: stateReason ?? null },
  );
}
// When reopening: use reopenIssue mutation (no stateReason)
else if (targetState === "OPEN") {
  await client.mutate(
    `mutation($issueId: ID!) {
      reopenIssue(input: { issueId: $issueId }) {
        issue { number state }
      }
    }`,
    { issueId },
  );
}

// Separate call for metadata fields (title, body, labels, assignees) if any
if (hasMetadataFields) {
  await client.mutate(
    `mutation($issueId: ID!, $title: String, $body: String, $labelIds: [ID!], $assigneeIds: [ID!]) {
      updateIssue(input: { id: $issueId, title: $title, body: $body, labelIds: $labelIds, assigneeIds: $assigneeIds }) {
        issue { number title url }
      }
    }`,
    { issueId, title, body, labelIds, assigneeIds },
  );
}
```

The `stateReason = "REOPENED"` value in the current code should simply be removed (it is never passed to `reopenIssue` which takes no stateReason).
