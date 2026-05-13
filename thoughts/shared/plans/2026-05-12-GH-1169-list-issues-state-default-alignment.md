---
date: 2026-05-12
status: draft
type: plan
github_issue: 1169
github_issues: [1169]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1169
primary_issue: 1169
tags: [list-issues, workflow-state, dashboard, mcp-tools, bug-fix]
---

# Align list_issues state default with dashboard family — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-09-list-issues-and-dashboard-state-aggregation]]
- builds_on:: [[2026-05-07-GH-1129-list-issues-totalcount-misleading]]
- builds_on:: [[2026-02-20-GH-0107-reason-filter-list-issues]]
- builds_on:: [[2026-02-20-GH-0142-exclude-negation-filters-list-issues]]
- builds_on:: [[2026-04-05-filter-sort-cross-reference-matrix]]

## Overview

1 atomic issue, single PR.

| Phase | Issue   | Title                                                      | Estimate |
| ----- | ------- | ---------------------------------------------------------- | -------- |
| 1     | GH-1169 | list_issues defaults state=OPEN diverging from dashboard   | S        |

## Shared Constraints

- **No GraphQL changes** — the fix is purely client-side argument-handling. The existing `paginateConnection({ scanUntilExhausted: true })` already fetches every project item.
- **Backwards compatibility** — callers that explicitly pass `state: "OPEN"` or `state: "CLOSED"` must continue to see exactly the same filtering behavior as today.
- **TypeScript strict mode is the gate** — no linter is configured (`CLAUDE.md`). `tsc` + `vitest` are the only mechanical checks.
- **ESM `.js` imports** — internal imports require the `.js` suffix.
- **Tool description is part of the public contract** — MCP clients (Claude Code) read the description string at schema discovery; any change is observable to callers.
- **`list_groups` has the same default** at `relationship-tools.ts:1205-1210` (per research §Path E). It is out of scope for this issue (the acceptance criteria name `list_issues`, `next_actions`, and `pipeline_dashboard`), but we add a regression test that documents the current `list_groups` behavior so a future change there is deliberate.

## Current State Analysis

`ralph_hero__list_issues` (`tools/issue-tools.ts:60-505`) declares its `state` parameter with `.default("OPEN")` at line 113-117 and unconditionally applies a client-side filter at lines 274-279:

```typescript
if (args.state) {
  items = items.filter((item) => {
    const content = item.content as Record<string, unknown> | null;
    return content?.state === args.state;
  });
}
```

Because `state` defaults to `"OPEN"` via Zod, the filter always runs unless the caller explicitly passes `state: undefined` (which the Zod schema does not allow — the enum is `["OPEN", "CLOSED"]`). There is no way to express "both states" through the current schema.

The dashboard family (`fetchDashboardItems`, `dashboard-fetch.ts:225-289`) has no equivalent filter. `toDashboardItems` strips PRs and DraftIssues at line 88 but does not look at `content.state` at all — closed issues with any workflow state appear in dashboard buckets. `get_issue` (`issue-tools.ts:509-710`) also has no issue-state filter and returns the workflow state regardless.

The divergence is reachable in practice via `.github/workflows/sync-pr-merge.yml`, which advances a linked issue's Workflow State to `Done` without closing the GitHub issue — and via manual UI edits.

## Desired End State

`list_issues` agrees with `pipeline_dashboard`, `next_actions`, `project_hygiene`, `capture_snapshot`, `hello_directions`, and `pick_actionable_issue` on the visibility of any issue whose Workflow State is non-terminal, regardless of whether the underlying GitHub issue is OPEN or CLOSED.

### Verification

- [ ] An issue with `state: "CLOSED"` and `Workflow State: "Plan in Review"` is returned by `list_issues(workflowState: "Plan in Review")` with no explicit `state` argument
- [ ] An issue with `state: "CLOSED"` and `Workflow State: "Plan in Review"` is returned by `pipeline_dashboard()` in the Plan in Review bucket (this already works; the test pins the behavior)
- [ ] Both tools return the same set of issues for any non-terminal workflow state filter
- [ ] Explicit `state: "OPEN"` still returns only open issues (back-compat)
- [ ] Explicit `state: "CLOSED"` still returns only closed issues (back-compat)
- [ ] Updated tool description documents the new default
- [ ] All existing `list_issues` tests pass without modification except those that exercised the default

## What We're NOT Doing

- Not changing `list_groups`'s default (out of scope; named in the issue only as "`list_issues` divergence" — leave a regression test pinning current `list_groups` behavior for future work)
- Not modifying any of the dashboard-family tools — they already behave correctly
- Not changing the GraphQL queries (Path A already does a full project scan)
- Not adding a third `state` value (e.g., `"ALL"`) — dropping the default is sufficient; explicit `"OPEN"` / `"CLOSED"` already cover the narrowing cases
- Not changing `get_issue`'s behavior — it already returns issues regardless of state (per research §Path D)
- Not addressing the related `excludeWorkflowStates` coalesce-to-empty-string asymmetry (research §Path A) — separate concern, separate ticket if needed

## Implementation Approach

Single-phase change. Drop the `.default("OPEN")` from the Zod schema so `state` is truly optional. The existing filter at lines 274-279 is already guarded by `if (args.state)`, so when `state` is undefined no filter runs and both open and closed issues flow through. Update the description string to document the new default. Add a regression test that pins the new behavior and asserts cross-tool consistency with the dashboard family for a closed-non-terminal issue.

---

## Phase 1: GH-1169 — Drop list_issues OPEN default and align with dashboard family

- **depends_on**: null

### Overview

Make `list_issues`'s `state` parameter genuinely optional (no Zod default), update its description to reflect that omitting `state` returns issues in any state, and add regression tests that pin the new behavior plus cross-tool consistency with `pipeline_dashboard`.

### Tasks

#### Task 1.1: Drop OPEN default from list_issues Zod schema and update description

- **files**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Line ~113-117: `state` parameter no longer calls `.default("OPEN")` — it is now `z.enum(["OPEN", "CLOSED"]).optional()`
  - [ ] The `.describe(...)` for `state` reads: `"Issue state filter. When omitted, returns issues in any state (matches dashboard-family behavior). Pass 'OPEN' or 'CLOSED' to narrow."`
  - [ ] The main tool description at line 64 mentions that by default both open and closed issues are returned, with a forward pointer to the `state` parameter for narrowing
  - [ ] Lines 274-279 are unchanged — the existing `if (args.state)` guard correctly skips the filter when `state` is undefined
  - [ ] `tsc` compiles without errors
  - [ ] No other call sites in `issue-tools.ts` reference `args.state` outside the existing filter block

#### Task 1.2: Add regression tests pinning new default and cross-tool consistency

- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/issue-tools.test.ts` (modify), `plugin/ralph-hero/mcp-server/src/__tests__/cross-tool-consistency.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] New test in `issue-tools.test.ts` titled `"list_issues with no state arg returns both OPEN and CLOSED issues"` — fixture includes one open issue with workflowState `"Plan in Review"` and one closed issue with workflowState `"Plan in Review"`; calling `list_issues({ workflowState: "Plan in Review" })` (no `state` arg) returns BOTH issues
  - [ ] New test in `issue-tools.test.ts` titled `"list_issues with state=OPEN still excludes CLOSED issues"` — same fixture, calling with explicit `state: "OPEN"` returns only the open one (back-compat assertion)
  - [ ] New test in `issue-tools.test.ts` titled `"list_issues with state=CLOSED still excludes OPEN issues"` — same fixture, calling with explicit `state: "CLOSED"` returns only the closed one
  - [ ] New test in `cross-tool-consistency.test.ts` titled `"list_issues (no state arg) and pipeline_dashboard agree on closed-non-terminal issues"` — fixture includes a `state: "CLOSED"` issue with `workflowState: "Plan in Review"`; both `list_issues({ workflowState: "Plan in Review" })` and `pipeline_dashboard()` (Plan in Review bucket) see the same issue numbers
  - [ ] New test in `cross-tool-consistency.test.ts` titled `"list_groups still defaults state=OPEN (regression pin)"` — documents that `list_groups`'s OPEN default was deliberately left in place by this change so a future change is forced to update this test
  - [ ] Update existing line-481 and line-533 test fixtures: callers that passed `{ state: "OPEN", ... }` explicitly continue to work unchanged (no edit required because they pass `state` explicitly)
  - [ ] `npm test` — all suites pass

#### Task 1.3: Update CHANGELOG/release notes inline in commit message

- **files**: (no file change; commit message only)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - [ ] Commit message body explicitly calls out the behavior change: `BEHAVIOR CHANGE: list_issues no longer defaults state to "OPEN". Callers that relied on the implicit default must now pass state: "OPEN" explicitly. This aligns list_issues with the dashboard family (pipeline_dashboard, next_actions, project_hygiene) which see closed-but-non-terminal-workflow issues.`
  - [ ] Commit message references GH-1169 and the research doc

### Phase Success Criteria

#### Automated Verification:

- [x] `npm run build` (from `plugin/ralph-hero/mcp-server/`) — no errors
- [x] `npm test` (from `plugin/ralph-hero/mcp-server/`) — all suites pass including new regression tests
- [x] `npx vitest run src/__tests__/issue-tools.test.ts` — the three new state-arg tests pass
- [x] `npx vitest run src/__tests__/cross-tool-consistency.test.ts` — the new cross-tool consistency test passes

#### Manual Verification:

- [ ] Reload the MCP server in Claude Code, call `ralph_hero__list_issues(workflowState: "Done")` with no `state` arg, confirm closed Done issues are returned
- [ ] Call `ralph_hero__list_issues(workflowState: "Plan in Review", state: "OPEN")`, confirm only open issues in that bucket are returned (back-compat)
- [ ] Inspect the tool description in Claude Code's MCP debug panel — confirm new wording is present

**Creates for next phase**: n/a (single-phase plan)

---

## Integration Testing

- [ ] Reload the MCP server in Claude Code after merge and run `pipeline_dashboard` then `list_issues(workflowState=<each non-terminal state>)`; confirm the per-bucket issue numbers from the dashboard appear in the matching `list_issues` call without passing `state`
- [ ] Search the codebase for any internal call sites that pass `list_issues` args without `state` and verify their expectations match the new default (e.g., skill/agent prompts that say "list open issues" — none expected since skills typically pass explicit filters)

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1169
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-05-09-list-issues-and-dashboard-state-aggregation.md
- Related (out-of-scope): GH-1153 (`next_actions` Backlog/null-state fallback)
- Related (totalCount): GH-1129 (`list_issues` totalCount semantics)
