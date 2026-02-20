---
date: 2026-02-20
github_issue: 108
github_url: https://github.com/cdubiel08/ralph-hero/issues/108
status: complete
type: research
---

# GH-108: Add Draft Issue Filtering (`is:draft` / `-is:draft`) to List Tools

## Problem Statement

Agents need to include or exclude draft issues from list results. Currently, `list_issues` hardcodes `item.type === "ISSUE"` excluding all drafts, while `list_project_items` includes everything with no type filter. There's no way to specifically query for drafts or exclude them.

## Current State Analysis

### `list_issues` — Drafts Always Excluded

[`issue-tools.ts:154-156`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L154):

```typescript
let items = itemsResult.nodes.filter(
  (item) => item.type === "ISSUE" && item.content,
);
```

- Hardcoded `item.type === "ISSUE"` excludes `DRAFT_ISSUE`, `PULL_REQUEST`, and `REDACTED`
- GraphQL query (L120-131) only fetches `... on Issue` fragment — no DraftIssue fragment
- No way to include drafts even if desired

### `list_project_items` — All Types Included, No Filter

[`project-tools.ts:495-515`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L495):

- No `item.type` filter applied — all items (Issue, PullRequest, DraftIssue, Redacted) pass through
- GraphQL query (L445-463) fetches all three content fragments including `... on DraftIssue { title body }`
- `type` field is already included in formatted response (L521)
- DraftIssue items have `undefined` for `number`, `state`, `url`, `labels`, `assignees`

### `dashboard-tools` — Uses `__typename` Check

[`dashboard-tools.ts:153-156`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts#L153):

```typescript
if (!r.content || r.content.__typename !== "Issue") continue;
```

Dashboard filters by `content.__typename` rather than `item.type`.

### Type Definitions

[`types.ts:125-136`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L125):

```typescript
type: "ISSUE" | "PULL_REQUEST" | "DRAFT_ISSUE" | "REDACTED";
```

`DraftIssue` interface (L132-136) has only `__typename`, `title`, `body` — no `number`, `url`, or `state`.

### `RawProjectItem` — Duplicate Definitions

Both `issue-tools.ts:1587-1601` and `project-tools.ts:556-570` define identical local `RawProjectItem` interfaces with `type: string` (plain string, not the union from `types.ts`).

## Key Discoveries

### 1. Two Separate Filtering Needs

**`list_project_items`** — Needs an `itemType` filter to include/exclude specific types:
- Filter by `ISSUE`, `PULL_REQUEST`, `DRAFT_ISSUE` individually or in combination
- Default: all types (backward compatible)
- Most useful for agents needing "only drafts for triage" or "only real issues"

**`list_issues`** — Could add `includeDrafts` boolean:
- Would change the `item.type === "ISSUE"` filter to also allow `DRAFT_ISSUE`
- Would require adding `... on DraftIssue` to the GraphQL query
- Less useful since `list_issues` is specifically for issues — drafts don't have `number`, `state`, `url`

### 2. Recommended: `itemType` Param on `list_project_items` Only

Adding type filtering to `list_project_items` is clean and sufficient:

```typescript
itemType: z.enum(["ISSUE", "PULL_REQUEST", "DRAFT_ISSUE"])
  .optional()
  .describe("Filter by item type. Omit to include all types.")
```

This follows the existing pattern where `list_project_items` is the broader tool (includes PRs, drafts, text/number fields) while `list_issues` is focused on issues only.

### 3. Alternative: Multi-Value `itemType` Filter

For more flexibility, accept an array:

```typescript
itemType: z.array(z.enum(["ISSUE", "PULL_REQUEST", "DRAFT_ISSUE"]))
  .optional()
  .describe("Filter by item type(s). Omit to include all types.")
```

This allows combinations like `["ISSUE", "PULL_REQUEST"]` (exclude drafts) or `["DRAFT_ISSUE"]` (only drafts). However, this adds complexity. The simpler single-value approach covers the primary use cases.

**Recommended**: Start with single-value `itemType` enum. If multi-select is needed later, it's a backward-compatible expansion.

### 4. Filter Placement

Following the existing pattern in `list_project_items` (L496-515):

```typescript
let items = itemsResult.nodes;

if (args.itemType) {
  items = items.filter((item) => item.type === args.itemType);
}

// ... existing workflowState, estimate, priority filters
```

Place the `itemType` filter **first** in the chain, before field value filters, since it's the broadest filter.

### 5. `list_issues` Change: Optional Enhancement

If `list_issues` should also support draft awareness, the minimal change is:

```typescript
// Current (L154-156):
let items = itemsResult.nodes.filter(
  (item) => item.type === "ISSUE" && item.content,
);

// With includeDrafts:
const allowedTypes = ["ISSUE"];
if (args.includeDrafts) allowedTypes.push("DRAFT_ISSUE");
let items = itemsResult.nodes.filter(
  (item) => allowedTypes.includes(item.type) && item.content,
);
```

This also requires adding `... on DraftIssue { title body }` to the GraphQL query at L120-131. However, drafts in `list_issues` results would have `undefined` for `number`, `state`, `url` — potentially confusing. **Recommend deferring this to a follow-up or skipping entirely.** The issue's acceptance criteria only specify `list_project_items`.

### 6. Response Already Handles Drafts

`list_project_items` formatted response (L518-537) already uses optional chaining for all content fields. DraftIssue items produce valid output:

```json
{
  "itemId": "PVTI_...",
  "type": "DRAFT_ISSUE",
  "title": "Draft title",
  "number": null,
  "state": null,
  "url": null,
  "workflowState": "Backlog",
  "estimate": "XS"
}
```

No response format changes needed. The `body` field from DraftIssue is not currently included in the response — could be added but is out of scope.

### 7. Group Context

Part of Epic #94 (Intelligent Agent Filtering), 8-issue group. #108 has no external blockers. The triage comment mentions it's blocked by #120 (create/update draft issue tools) but this is for phase ordering within the group — the filter tool can be implemented independently since DraftIssue items already exist in projects.

## Recommended Approach

### Changes

1. **Modify: `tools/project-tools.ts`** — Add `itemType` param and filter to `list_project_items`
2. **Tests** — Add structural test for `itemType` filter

### Implementation

**Zod schema** (add after `priority` param at L406):

```typescript
itemType: z
  .enum(["ISSUE", "PULL_REQUEST", "DRAFT_ISSUE"])
  .optional()
  .describe("Filter by item type (ISSUE, PULL_REQUEST, DRAFT_ISSUE). Omit to include all types."),
```

**Filter block** (add before workflowState filter at L498):

```typescript
if (args.itemType) {
  items = items.filter((item) => item.type === args.itemType);
}
```

**No GraphQL changes needed** — `list_project_items` already fetches all three content type fragments.

## Risks

1. **Backward compatibility**: Default behavior (no `itemType` param) continues to include all types. No breaking change.
2. **REDACTED items**: The `itemType` enum doesn't include `REDACTED`. These are rare (cross-repo private items) and would be excluded if `itemType` is specified. This is acceptable — REDACTED items have null content and are generally noise.
3. **Scope creep**: Adding `includeDrafts` to `list_issues` would expand scope. Keep this focused on `list_project_items` per acceptance criteria.

## Recommended Next Steps

1. Add `itemType` param to `list_project_items` zod schema
2. Add `item.type` filter block before existing field filters
3. Add structural tests verifying the filter
4. Consider follow-up for `list_issues` `includeDrafts` if needed
