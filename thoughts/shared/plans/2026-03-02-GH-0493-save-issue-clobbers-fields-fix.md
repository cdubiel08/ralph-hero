---
date: 2026-03-02
status: draft
github_issues: [493]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/493
primary_issue: 493
---

# Fix save_issue Partial Metadata Update Clobbering - Atomic Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-493 | fix: save_issue clobbers body, labels, and assignees on partial metadata updates | XS |

## Current State Analysis

The `save_issue` handler in [`issue-tools.ts:1251-1274`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1251-L1274) always sends all metadata fields (`title`, `body`, `labelIds`, `assigneeIds`) to the `updateIssue` GraphQL mutation, defaulting unprovided fields to `null`. GitHub's API interprets `null` as "clear this field," not "leave unchanged." Omitting a field entirely leaves it unchanged.

Three sub-bugs:
1. `body: null` sent when body not provided -- clears issue description
2. `labelIds: null` sent when labels not provided -- removes all labels
3. `assigneeIds` hardcoded to `null` (line 1272) -- always clears assignees

## Desired End State

### Verification
- [ ] `save_issue(number, title)` only updates title; body, labels, assignees preserved
- [ ] `save_issue(number, labels)` only updates labels; title, body, assignees preserved
- [ ] `save_issue(number, body)` only updates body; title, labels, assignees preserved
- [ ] `save_issue(number, assignees)` only updates assignees; title, labels, body preserved
- [ ] `save_issue(number, title, labels)` only updates title and labels
- [ ] Existing test suite passes unchanged

## What We're NOT Doing
- Not implementing username-to-node-ID resolution for assignees (separate feature; `assigneeIds` is simply excluded from mutation when `args.assignees` is not provided)
- Not changing the `hasMetadataFields` guard logic -- it correctly detects when any metadata field is present
- Not adding integration tests that mock `client.mutate()` (test gap exists but is out of scope for this bug fix)
- Not changing the project-field mutation path (it already handles partial updates correctly)
- Not changing close/reopen mutation paths (3a/3b are unaffected)

## Implementation Approach

Dynamic mutation construction: build the GraphQL mutation string and variables object based on which `args` fields are actually provided (`!== undefined`). This avoids sending `null` for unprovided fields, which GitHub would interpret as "clear."

For `assigneeIds`, resolve usernames to node IDs when `args.assignees` is provided (using a repository collaborators query), and omit the field entirely when not provided.

---

## Phase 1: GH-493 - Fix Partial Metadata Update
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/493 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-02-save-issue-clobbers-fields-on-partial-update.md

### Changes Required

#### 1. Dynamically build updateIssue mutation
**File**: [`plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:1251-1274`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1251-L1274)

**Changes**: Replace the static mutation with dynamically constructed mutation and variables. Only include fields in the GraphQL `input` and `variables` when the caller explicitly provided them.

Before (buggy):
```typescript
await client.mutate<...>(
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
    assigneeIds: null,
  },
);
```

After (fixed):
```typescript
// Build mutation dynamically to avoid sending null for unprovided fields
// (GitHub treats null as "clear" not "leave unchanged")
const varDefs: string[] = ["$issueId: ID!"];
const inputFields: string[] = ["id: $issueId"];
const variables: Record<string, unknown> = { issueId };

if (args.title !== undefined) {
  varDefs.push("$title: String");
  inputFields.push("title: $title");
  variables.title = args.title;
}
if (args.body !== undefined) {
  varDefs.push("$body: String");
  inputFields.push("body: $body");
  variables.body = args.body;
}
if (labelIds !== undefined) {
  varDefs.push("$labelIds: [ID!]");
  inputFields.push("labelIds: $labelIds");
  variables.labelIds = labelIds;
}
if (assigneeIds !== undefined) {
  varDefs.push("$assigneeIds: [ID!]");
  inputFields.push("assigneeIds: $assigneeIds");
  variables.assigneeIds = assigneeIds;
}

await client.mutate<{
  updateIssue: {
    issue: { number: number; title: string; url: string };
  };
}>(
  `mutation(${varDefs.join(", ")}) {
    updateIssue(input: { ${inputFields.join(", ")} }) {
      issue { number title url }
    }
  }`,
  variables,
);
```

#### 2. Add assignee username-to-ID resolution
**File**: [`plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts) -- inside section 3c, after the label resolution block (lines 1228-1249)

**Changes**: Add a parallel block for resolving assignee usernames to node IDs when `args.assignees` is provided. Use GitHub's `user(login:)` query to resolve each username to its node ID. Define `assigneeIds` as `string[] | undefined` (matching `labelIds` pattern).

```typescript
// Resolve assignee IDs if provided
let assigneeIds: string[] | undefined;
if (args.assignees) {
  assigneeIds = [];
  for (const username of args.assignees) {
    const userResult = await client.query<{
      user: { id: string } | null;
    }>(
      `query($login: String!) { user(login: $login) { id } }`,
      { login: username },
      { cache: true, cacheTtlMs: 5 * 60 * 1000 },
    );
    if (userResult.user) {
      assigneeIds.push(userResult.user.id);
    }
  }
}
```

#### 3. Update structural test for dynamic mutation
**File**: [`plugin/ralph-hero/mcp-server/src/__tests__/save-issue.test.ts:254-262`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/save-issue.test.ts#L254-L262)

**Changes**: The structural test at line 254 (`"updateIssue mutation does not include state or stateReason"`) finds the `updateIssue(input:` string and checks a 300-char window. After the fix, the mutation is constructed dynamically so `updateIssue(input:` appears in a template literal, not a static string. Update this test to verify the dynamic construction pattern instead:

- Assert source contains `"updateIssue(input:"` (still present in the template literal)
- Assert source does NOT contain `assigneeIds: null` (the hardcoded null is gone)
- Assert source contains the dynamic builder pattern (e.g., `varDefs` and `inputFields`)

#### 4. Add test verifying no hardcoded null for metadata fields
**File**: [`plugin/ralph-hero/mcp-server/src/__tests__/save-issue.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/save-issue.test.ts)

**Changes**: Add a new structural test in the "structural" describe block:

```typescript
it("does not hardcode null for metadata fields in updateIssue variables", () => {
  // After the fix, metadata fields should only be included when provided
  // There should be no `assigneeIds: null` or `args.title ?? null` patterns
  // in the updateIssue mutation section
  expect(issueToolsSrc).not.toContain("assigneeIds: null");
  expect(issueToolsSrc).not.toContain("args.title ?? null");
  expect(issueToolsSrc).not.toContain("args.body ?? null");
});

it("uses dynamic mutation construction for updateIssue", () => {
  expect(issueToolsSrc).toContain("varDefs");
  expect(issueToolsSrc).toContain("inputFields");
});
```

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test` -- all tests pass
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` -- compiles without errors
- [ ] Manual: Source no longer contains `assigneeIds: null` hardcoded pattern
- [ ] Manual: Source no longer contains `args.title ?? null` or `args.body ?? null` patterns
- [ ] Manual: The `updateIssue` mutation string is constructed from `varDefs` and `inputFields` arrays

---

## Integration Testing
- [ ] Build succeeds: `npm run build`
- [ ] All existing tests pass: `npm test`
- [ ] New structural tests verify the dynamic pattern and absence of hardcoded nulls

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-02-save-issue-clobbers-fields-on-partial-update.md
- Related issues: https://github.com/cdubiel08/ralph-hero/issues/493
- GitHub UpdateIssueInput docs: null semantics = "clear field", omission = "leave unchanged"
