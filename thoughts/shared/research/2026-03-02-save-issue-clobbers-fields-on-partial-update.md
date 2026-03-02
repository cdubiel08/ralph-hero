---
date: 2026-03-02
topic: "save_issue clobbers labels, body, and assignees on partial metadata updates"
tags: [research, codebase, save-issue, issue-tools, graphql, bug]
status: complete
type: research
git_commit: c8f865f2c39245bb6df6f4620207b16485d73d68
---

# Research: save_issue clobbers fields on partial metadata updates

## Research Question

When `save_issue` is called with partial updates (e.g., just changing `title`), does it overwrite labels, body, and assignees with empty/null values instead of preserving existing values?

## Summary

**Yes, confirmed bug.** The `updateIssue` GraphQL mutation in `save_issue` always passes all metadata fields (`title`, `body`, `labelIds`, `assigneeIds`) regardless of which fields the caller actually provided. Unprovided fields default to `null`, which GitHub interprets as "clear this field." This means any call that triggers the metadata update path will clobber every unprovided metadata field.

Three distinct sub-bugs:

1. **Body clobbered**: `save_issue(number: 42, title: "new title")` sends `body: null` → clears the issue description
2. **Labels clobbered**: same scenario sends `labelIds: null` → removes all labels
3. **Assignees always clobbered**: `assigneeIds` is hardcoded to `null` (line 1272) with a TODO comment — every metadata update clears all assignees

## Detailed Findings

### The Bug: `issue-tools.ts:1251-1274`

The `updateIssue` mutation in section 3c (metadata update) is constructed at [`issue-tools.ts:1256-1273`](https://github.com/cdubiel08/ralph-hero/blob/c8f865f2c39245bb6df6f4620207b16485d73d68/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1256-L1273):

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
    title: args.title ?? null,      // null if not provided → clears title
    body: args.body ?? null,          // null if not provided → clears body
    labelIds: labelIds ?? null,       // null if not provided → removes all labels
    assigneeIds: null,                // ALWAYS null → always clears assignees
  },
);
```

The mutation always includes all four fields in the `input` object. In GitHub's GraphQL API, `updateIssue` treats `null` for optional fields as "clear/reset," not "leave unchanged." To leave a field unchanged, it must be **omitted** from the input entirely.

### Gate Logic: When Does the Bug Trigger?

The metadata update path is guarded by `hasMetadataFields` at [`issue-tools.ts:1184-1185`](https://github.com/cdubiel08/ralph-hero/blob/c8f865f2c39245bb6df6f4620207b16485d73d68/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1184-L1185):

```typescript
const hasMetadataFields = args.title !== undefined || args.body !== undefined ||
  args.labels !== undefined || args.assignees !== undefined;
```

The bug triggers when **any one** metadata field is provided. Scenarios:

| Call | Triggers updateIssue? | Clobbers |
|------|----------------------|----------|
| `save_issue(number, workflowState)` | No | Nothing (project-only path) |
| `save_issue(number, title)` | Yes | body, labels, assignees |
| `save_issue(number, body)` | Yes | title(?), labels, assignees |
| `save_issue(number, labels)` | Yes | title(?), body, assignees |
| `save_issue(number, title, labels)` | Yes | body, assignees |
| `save_issue(number, workflowState: "Done")` | Yes (auto-close) | No (hasMetadataFields=false, only closeIssue runs) |

Note: Whether `title: null` actually clears the title in GitHub's API is uncertain — GitHub may reject null titles. But `body: null`, `labelIds: null`, and `assigneeIds: null` definitely clear those fields.

### Current Caller Patterns

No skill in the codebase currently triggers the bug in production because:

- **Dominant pattern**: `workflowState` + `command` only — never enters the metadata path
- **Estimate/priority only**: project-field path only, no metadata mutation
- **Labels (ralph-triage)**: calls `save_issue` with `labels` alone, but the skill explicitly reads existing labels first and includes them all ([`ralph-triage/SKILL.md:241-246`](https://github.com/cdubiel08/ralph-hero/blob/c8f865f2c39245bb6df6f4620207b16485d73d68/plugin/ralph-hero/skills/ralph-triage/SKILL.md#L241-L246)) — this is a workaround for the bug, not a fix

No skill calls `save_issue` with `title` + `body` combined, or with `title`/`body` alongside other fields. The title/body path through `updateIssue` is effectively untested in real usage.

**However**, the bug is easily triggered by any LLM agent that calls `save_issue` with a subset of metadata fields — for example, an agent updating just labels without reading existing body/assignees first.

### Test Coverage Gap

[`save-issue.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/c8f865f2c39245bb6df6f4620207b16485d73d68/plugin/ralph-hero/mcp-server/src/__tests__/save-issue.test.ts) contains only:

- **Schema validation** (lines 48-135): Zod parse tests for valid/invalid inputs
- **Auto-close logic** (lines 141-176): Pure function tests for terminal state detection
- **Semantic intent resolution** (lines 182-201): `resolveState()` integration tests
- **Structural tests** (lines 207-271): String-presence assertions on source code

No test mocks `client.mutate()` or calls the handler end-to-end. The existing research document for GH-483 explicitly notes this: "Existing tests are structural, not integration tests — `save-issue.test.ts` verifies source code strings and schema parsing but does not exercise the actual GraphQL mutations."

### `batch_update` and `advance_issue` Are Not Affected

`batch-tools.ts` and `relationship-tools.ts` operate exclusively on Projects V2 fields via `updateProjectV2ItemFieldValue` — they never call `updateIssue`. The `buildBatchMutationQuery` function (shared with `save_issue` for project-field updates) only handles `SingleSelectField` mutations.

### Related Prior Research

[`thoughts/shared/research/2026-03-01-GH-0483-save-issue-terminal-state-stateReason-bug.md`](https://github.com/cdubiel08/ralph-hero/blob/c8f865f2c39245bb6df6f4620207b16485d73d68/thoughts/shared/research/2026-03-01-GH-0483-save-issue-terminal-state-stateReason-bug.md) documents the `UpdateIssueInput` schema fields and confirms that `updateIssue` does not accept `stateReason`. The same document notes the structural-only test coverage.

## Code References

- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:1095-1395` — `save_issue` tool registration and handler
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:1184-1185` — `hasMetadataFields` guard
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:1226-1280` — section 3c: metadata update with `updateIssue` mutation
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:1256-1273` — the buggy mutation and variable binding
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:1272` — `assigneeIds: null` hardcoded with TODO comment
- `plugin/ralph-hero/mcp-server/src/__tests__/save-issue.test.ts` — structural tests only, no mutation verification
- `plugin/ralph-hero/skills/ralph-triage/SKILL.md:241-246` — labels workaround (read-then-replace)

## Architecture Documentation

### How `save_issue` Partitions Its Work

The handler splits into two independent mutation paths:

1. **Issue mutations (GitHub Issue API)**: close/reopen (`closeIssue`/`reopenIssue`) + metadata update (`updateIssue`)
2. **Project-field mutations (Projects V2 API)**: workflow state, estimate, priority via `updateProjectV2ItemFieldValue` + `clearProjectV2ItemFieldValue`

The bug is isolated to path 1, specifically the `updateIssue` call. Path 2 (project fields) correctly handles partial updates — it only mutates fields that are explicitly provided.

### GitHub GraphQL `updateIssue` Null Semantics

GitHub's `UpdateIssueInput` treats included-but-null fields as "clear this field":
- `body: null` → clears the issue body
- `labelIds: null` → removes all labels
- `assigneeIds: null` → removes all assignees
- Omitting a field entirely → leaves it unchanged

The fix requires conditionally building the mutation to only include fields the caller actually provided.

## Open Questions

1. Does GitHub's `updateIssue` accept `title: null`? If so, it could blank issue titles. If not, it may error — either way the current code is wrong.
2. Should `assigneeIds` support be implemented (username → ID resolution), or should it remain unsupported and be removed from the mutation entirely?
3. Should the fix use dynamic mutation construction (building the GraphQL string based on which fields are present) or separate per-field mutations?
