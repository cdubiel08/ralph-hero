---
date: 2026-03-01
status: draft
github_issues: [483]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/483
primary_issue: 483
---

# Fix `save_issue` Terminal State Transitions - Atomic Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-483 | Bug: `save_issue` fails on terminal state transitions -- `stateReason` not accepted by `UpdateIssueInput` | S |

## Current State Analysis

`save_issue` in [`issue-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts) passes `stateReason` (e.g., `COMPLETED`, `NOT_PLANNED`) directly into the `updateIssue` GraphQL mutation's `UpdateIssueInput`. GitHub's schema does not accept `stateReason` on `UpdateIssueInput` -- it belongs exclusively to `CloseIssueInput` (used by the `closeIssue` mutation). This causes all terminal state transitions to fail with:

```
InputObject 'UpdateIssueInput' doesn't accept argument 'stateReason'
```

A secondary bug exists: the code assigns `stateReason = "REOPENED"` for the `issueState === "OPEN"` path, but `REOPENED` is not a valid `IssueClosedStateReason` enum value (only `COMPLETED`, `NOT_PLANNED`, `DUPLICATE` are valid). The `reopenIssue` mutation takes no `stateReason` parameter at all.

**Scope**: Only `issue-tools.ts` needs changes. `batch_update` and `advance_issue` are unaffected -- they only update project fields via `updateProjectV2ItemFieldValue`, never calling `updateIssue`.

## Desired End State

### Verification
- [ ] `save_issue` with `workflowState: "Done"` auto-closes the issue with `stateReason: COMPLETED`
- [ ] `save_issue` with `workflowState: "Canceled"` auto-closes with `stateReason: NOT_PLANNED`
- [ ] `save_issue` with `issueState: "CLOSED"` closes with `stateReason: COMPLETED`
- [ ] `save_issue` with `issueState: "CLOSED_NOT_PLANNED"` closes with `stateReason: NOT_PLANNED`
- [ ] `save_issue` with `issueState: "OPEN"` reopens via `reopenIssue` (no `stateReason`)
- [ ] Combined metadata + close works (e.g., `title` + `workflowState: "Done"`)
- [ ] Metadata-only updates (title, body, labels) still use `updateIssue` without state fields
- [ ] All existing tests pass; new structural tests verify correct mutation usage
- [ ] `npm run build` succeeds with no type errors

## What We're NOT Doing
- Not adding `DUPLICATE` as a new `issueState` option (future enhancement, out of scope)
- Not changing `batch_update` or `advance_issue` (confirmed unaffected)
- Not adding integration tests that call the real GitHub API (structural tests are sufficient for this fix)

## Implementation Approach

Split the single `updateIssue` mutation call (lines 1212-1239) into up to three separate mutation calls:

1. **`closeIssue`** -- when `targetState === "CLOSED"`, with correct `stateReason`
2. **`reopenIssue`** -- when `targetState === "OPEN"`, no `stateReason`
3. **`updateIssue`** -- only for metadata fields (title, body, labels, assignees), without `state` or `stateReason`

The state change and metadata update are independent operations and already execute sequentially, so splitting them has no semantic impact. API call count increases from 1 to at most 2 when both metadata and state change are needed -- negligible for this synchronous path.

---

## Phase 1: Fix `save_issue` Mutation Split

> **Issue**: [GH-483](https://github.com/cdubiel08/ralph-hero/issues/483) | **Research**: [Research Doc](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0483-save-issue-terminal-state-stateReason-bug.md)

### Changes Required

#### 1. Fix the `stateReason` type declaration
**File**: [`plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:1163`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1163)
**Changes**: Remove `"REOPENED"` from the `stateReason` type union since it is not a valid `IssueClosedStateReason` enum value.

Before:
```typescript
let stateReason: "COMPLETED" | "NOT_PLANNED" | "REOPENED" | undefined;
```

After:
```typescript
let stateReason: "COMPLETED" | "NOT_PLANNED" | undefined;
```

#### 2. Remove `stateReason = "REOPENED"` assignment
**File**: [`plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:1171-1174`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1171-L1174)
**Changes**: The `issueState === "OPEN"` branch should set `targetState = "OPEN"` but NOT set `stateReason` (the `reopenIssue` mutation has no `stateReason` parameter).

Before:
```typescript
} else if (args.issueState === "OPEN") {
  targetState = "OPEN";
  stateReason = "REOPENED";
}
```

After:
```typescript
} else if (args.issueState === "OPEN") {
  targetState = "OPEN";
  // reopenIssue mutation has no stateReason parameter
}
```

#### 3. Split the `updateIssue` mutation block into three separate mutation paths
**File**: [`plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:1183-1246`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1183-L1246)
**Changes**: Replace the single `needsIssueMutation` block with separate blocks for (a) state changes and (b) metadata updates.

The current code at lines 1183-1246 has one big block that:
1. Resolves `issueId` (line 1186)
2. Resolves `labelIds` if labels provided (lines 1190-1210)
3. Calls `updateIssue` with all fields including `state` and `stateReason` (lines 1212-1239)

Replace with this structure:

```typescript
// 3. Issue state mutations (close/reopen) - use dedicated mutations
const hasMetadataFields = args.title !== undefined || args.body !== undefined ||
  args.labels !== undefined || args.assignees !== undefined;
const needsIssueMutation = hasMetadataFields || targetState !== undefined;

if (needsIssueMutation) {
  const issueId = await resolveIssueNodeId(client, owner, repo, args.number);

  // 3a. Close issue (uses closeIssue mutation which accepts stateReason)
  if (targetState === "CLOSED") {
    await client.mutate<{
      closeIssue: {
        issue: { number: number; state: string; stateReason: string | null };
      };
    }>(
      `mutation($issueId: ID!, $stateReason: IssueClosedStateReason) {
        closeIssue(input: { issueId: $issueId, stateReason: $stateReason }) {
          issue { number state stateReason }
        }
      }`,
      { issueId, stateReason: stateReason ?? null },
    );
    if (args.issueState !== undefined) changes.issueState = args.issueState;
  }

  // 3b. Reopen issue (uses reopenIssue mutation, no stateReason)
  if (targetState === "OPEN") {
    await client.mutate<{
      reopenIssue: {
        issue: { number: number; state: string };
      };
    }>(
      `mutation($issueId: ID!) {
        reopenIssue(input: { issueId: $issueId }) {
          issue { number state }
        }
      }`,
      { issueId },
    );
    if (args.issueState !== undefined) changes.issueState = args.issueState;
  }

  // 3c. Metadata update (uses updateIssue, NO state/stateReason fields)
  if (hasMetadataFields) {
    // Resolve label IDs if provided
    let labelIds: string[] | undefined;
    if (args.labels) {
      const labelResult = await client.query<{
        repository: {
          labels: { nodes: Array<{ id: string; name: string }> };
        };
      }>(
        `query($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) {
            labels(first: 100) {
              nodes { id name }
            }
          }
        }`,
        { owner, repo },
        { cache: true, cacheTtlMs: 5 * 60 * 1000 },
      );
      const allLabels = labelResult.repository.labels.nodes;
      labelIds = args.labels
        .map((name) => allLabels.find((l) => l.name === name)?.id)
        .filter((id): id is string => id !== undefined);
    }

    await client.mutate<{
      updateIssue: {
        issue: { number: number; title: string; url: string };
      };
    }>(
      `mutation($issueId: ID!, $title: String, $body: String, $labelIds: [ID!], $assigneeIds: [ID!]) {
        updateIssue(input: {
          id: $issueId,
          title: $title,
          body: $body,
          labelIds: $labelIds,
          assigneeIds: $assigneeIds
        }) {
          issue { number title url }
        }
      }`,
      {
        issueId,
        title: args.title ?? null,
        body: args.body ?? null,
        labelIds: labelIds ?? null,
        assigneeIds: null, // Would need username -> ID resolution
      },
    );

    if (args.title !== undefined) changes.title = args.title;
    if (args.body !== undefined) changes.body = "(updated)";
    if (args.labels !== undefined) changes.labels = args.labels;
    if (args.assignees !== undefined) changes.assignees = args.assignees;
  }
}
```

Key differences from current code:
- `closeIssue` mutation used for closes (accepts `stateReason`)
- `reopenIssue` mutation used for reopens (no `stateReason`)
- `updateIssue` mutation only handles metadata (no `state` or `stateReason` variables)
- `issueId` resolution moved to the top of the block (shared by all three paths)
- Label resolution only happens when `hasMetadataFields` is true

#### 4. Update structural tests to verify correct mutation usage
**File**: [`plugin/ralph-hero/mcp-server/src/__tests__/save-issue.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/save-issue.test.ts)
**Changes**:

**4a. Update existing structural test** (lines 239-242): The test `"supports issueState with state and stateReason in mutation"` currently asserts `$state: IssueState` and `$stateReason: IssueClosedStateReason` appear in the source. After the fix, `$stateReason` should appear in a `closeIssue` context, not `updateIssue`. Update the test:

Before:
```typescript
it("supports issueState with state and stateReason in mutation", () => {
  expect(issueToolsSrc).toContain("$state: IssueState");
  expect(issueToolsSrc).toContain("$stateReason: IssueClosedStateReason");
});
```

After:
```typescript
it("uses closeIssue mutation with stateReason for closing", () => {
  expect(issueToolsSrc).toContain("closeIssue(input:");
  expect(issueToolsSrc).toContain("$stateReason: IssueClosedStateReason");
});
```

**4b. Add new structural tests** to verify correct mutation separation:

```typescript
it("uses reopenIssue mutation for reopening (no stateReason)", () => {
  expect(issueToolsSrc).toContain("reopenIssue(input:");
  // reopenIssue should NOT reference stateReason
  const reopenBlock = issueToolsSrc.slice(
    issueToolsSrc.indexOf("reopenIssue(input:"),
    issueToolsSrc.indexOf("reopenIssue(input:") + 200,
  );
  expect(reopenBlock).not.toContain("stateReason");
});

it("updateIssue mutation does not include state or stateReason", () => {
  // Find the updateIssue mutation input block
  const updateIdx = issueToolsSrc.indexOf("updateIssue(input:");
  expect(updateIdx).toBeGreaterThan(-1);
  const updateBlock = issueToolsSrc.slice(updateIdx, updateIdx + 300);
  expect(updateBlock).not.toContain("stateReason");
  // state should not be in updateIssue input (it's handled by closeIssue/reopenIssue)
  expect(updateBlock).not.toContain("$state");
});

it("does not assign REOPENED as stateReason", () => {
  expect(issueToolsSrc).not.toContain('"REOPENED"');
});
```

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` succeeds with no errors
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test` -- all tests pass including new structural tests
- [ ] Manual: Call `save_issue(number=<test-issue>, workflowState="Done", command="ralph_impl")` -- issue closes with `stateReason: COMPLETED` in GitHub UI
- [ ] Manual: Call `save_issue(number=<test-issue>, issueState="OPEN")` -- issue reopens successfully
- [ ] Manual: Call `save_issue(number=<test-issue>, issueState="CLOSED_NOT_PLANNED")` -- issue closes with `stateReason: NOT_PLANNED` in GitHub UI

---

## Integration Testing
- [ ] Build passes: `npm run build` in `plugin/ralph-hero/mcp-server`
- [ ] All tests pass: `npm test` in `plugin/ralph-hero/mcp-server`
- [ ] End-to-end: `save_issue` with terminal `workflowState` succeeds (previously failed)
- [ ] End-to-end: `save_issue` with metadata + terminal state succeeds (combined operation)
- [ ] No regression: `save_issue` with only metadata fields (title, labels) still works
- [ ] No regression: `save_issue` with only project fields (workflowState, estimate) still works

## References
- Research: [GH-0483 Research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0483-save-issue-terminal-state-stateReason-bug.md)
- Issue: [GH-483](https://github.com/cdubiel08/ralph-hero/issues/483)
- Source: [`issue-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts)
- Tests: [`save-issue.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/save-issue.test.ts)
