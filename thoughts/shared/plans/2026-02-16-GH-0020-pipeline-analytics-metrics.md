---
date: 2026-02-16
status: draft
github_issue: 20
github_url: https://github.com/cdubiel08/ralph-hero/issues/20
---

# Pipeline Analytics and Metrics Tracking

## Overview

Add pipeline analytics to the ralph-hero MCP server: (1) instrument `update_workflow_state` to record structured transition comments on every state change, and (2) implement a `pipeline_metrics` tool that returns a real-time pipeline snapshot with WIP counts, state distribution, and actionable bottleneck suggestions. This provides immediate visibility into pipeline health with no external dependencies — all data lives in GitHub.

## Current State Analysis

### No Temporal Data Exists

The `update_workflow_state` tool ([issue-tools.ts:1208-1295](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1208-L1295)) resolves semantic intents and updates the project field, but **does not record timestamps, create comments, or persist transition history**. The return value includes `previousState` and `newState` but this data is ephemeral.

### Existing Skill Comments as Approximate Audit Trail

Ralph skills leave structured comments during transitions:
- `"## Research Complete"` — research done
- `"## Plan Created (Phase N of M)"` — plan done
- `"## Review: APPROVED"` / `"REJECTED"` — review outcome

These have `createdAt` timestamps but formats aren't standardized and not all transitions leave comments.

### Relevant Infrastructure

| Component | Location | Reusable For |
|-----------|----------|-------------|
| `list_project_items` | [project-tools.ts:382-549](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L382-L549) | Fetching all items with field values for WIP counts |
| `paginateConnection` | [lib/pagination.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pagination.ts) | Paginating project items and comments |
| `SessionCache` | [lib/cache.ts:14-89](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts#L14-L89) | Caching expensive analytics queries within session |
| `FieldOptionCache` | [lib/cache.ts:100-189](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts#L100-L189) | Resolving field names to IDs |
| `resolveIssueNodeId` | [issue-tools.ts:117-145](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L117-L145) | Getting issue node ID for comment creation |
| `PipelinePhase` enum | [lib/pipeline-detection.ts:15-24](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L15-L24) | Phase categorization for metrics grouping |
| `STATE_ORDER` | [lib/workflow-states.ts:12-22](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts#L12-L22) | Canonical state ordering for pipeline display |

## Desired End State

1. Every `update_workflow_state` call appends a structured HTML transition comment to the issue
2. A new `ralph_hero__pipeline_metrics` tool returns a real-time pipeline snapshot (WIP by state, suggestions)
3. A new `lib/transition-comments.ts` module provides transition comment creation and parsing
4. All new code is tested

### Verification
- [ ] `npm run build` compiles with no type errors
- [ ] `npm test` passes with new transition-comments and pipeline-metrics tests
- [ ] Calling `update_workflow_state` creates an HTML comment with transition metadata on the issue
- [ ] Calling `pipeline_metrics` returns WIP counts grouped by workflow state with issue details
- [ ] `pipeline_metrics` returns actionable suggestions when WIP exceeds thresholds
- [ ] Transition comments are invisible in rendered GitHub markdown

## What We're NOT Doing

- Not implementing `cycle_time_report` tool (Phase 2 — requires transition comment history to exist first)
- Not implementing `bottleneck_check` tool (Phase 2 — requires temporal data from transition comments)
- Not adding DATE custom fields to the project (comment-based approach is more flexible)
- Not backfilling existing issues (backfill can be a follow-up once comment format is stable)
- Not adding local/external storage (all data lives in GitHub comments)
- Not changing the state machine or state transition rules
- Not parsing existing skill comments for approximate timelines (Phase 2 scope)

## Implementation Approach

Two independent workstreams that converge:

1. **Instrumentation**: Add a `createTransitionComment()` helper in `lib/transition-comments.ts`. Modify `update_workflow_state` in `issue-tools.ts` to call it after every successful field update. Cost: 1 extra mutation per state transition (~2 API points).

2. **Snapshot Metrics**: Create `tools/analytics-tools.ts` with `pipeline_metrics` tool. Reuse the `list_project_items` query pattern to fetch all items, group by Workflow State, compute WIP, and generate suggestions. Register via `registerAnalyticsTools()` in `index.ts`.

Phase 1 ships instrumentation. Phase 2 ships the metrics tool. Phase 2 depends on Phase 1 only for the shared `transition-comments.ts` types (the metrics tool itself uses existing project data, not transition comments).

---

## Phase 1: Transition Comment Instrumentation

### Overview

Create the transition comment helper and wire it into `update_workflow_state`. After this phase, every state transition automatically records a structured, machine-parseable HTML comment on the issue.

### Changes Required

#### 1. Create transition comment helper module
**File**: `plugin/ralph-hero/mcp-server/src/lib/transition-comments.ts` (new)

**Contents**:
- `TransitionRecord` interface: `{ from: string; to: string; command: string; at: string }`
- `buildTransitionComment(record: TransitionRecord): string` — returns `<!-- ralph-transition: {"from":"...","to":"...","command":"...","at":"..."} -->`
- `parseTransitionComments(commentBody: string): TransitionRecord[]` — extracts all `ralph-transition` markers from a comment body using regex `<!-- ralph-transition: ({.*?}) -->`
- `TRANSITION_COMMENT_PATTERN` exported regex constant for reuse

**Pattern to follow**: Similar to `lib/state-resolution.ts` — pure utility functions with no API dependencies.

#### 2. Instrument `update_workflow_state` with transition comment
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`

**Changes**: After the `updateProjectItemField` call at [line 1270-1276](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1270-L1276), add a `client.mutate()` call to create a comment on the issue:

```typescript
// After updateProjectItemField (line 1276):
import { buildTransitionComment } from "../lib/transition-comments.js";

const transitionBody = buildTransitionComment({
  from: previousState || "(unknown)",
  to: resolvedState,
  command: args.command,
  at: new Date().toISOString(),
});

const issueId = await resolveIssueNodeId(client, owner, repo, args.number);
await client.mutate(
  `mutation($subjectId: ID!, $body: String!) {
    addComment(input: { subjectId: $subjectId, body: $body }) {
      commentEdge { node { id } }
    }
  }`,
  { subjectId: issueId, body: transitionBody },
);
```

**Important**: The transition comment mutation should be fire-and-forget within a try/catch — if it fails, the state transition itself should still succeed. Log the error but don't fail the tool call.

#### 3. Add tests for transition comment module
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/transition-comments.test.ts` (new)

**Tests**:
- `buildTransitionComment` produces valid HTML comment with JSON payload
- `parseTransitionComments` extracts single transition from comment body
- `parseTransitionComments` extracts multiple transitions from multi-line body
- `parseTransitionComments` returns empty array for comment with no transitions
- `parseTransitionComments` handles malformed JSON gracefully (returns empty)
- Round-trip: `build` → `parse` produces identical `TransitionRecord`

### Success Criteria

#### Automated Verification
- [ ] `npm run build` — no type errors
- [ ] `npm test` — transition-comments tests pass
- [ ] `npx vitest run src/__tests__/transition-comments.test.ts` — focused test pass

#### Manual Verification
- [ ] Call `update_workflow_state` on a test issue — verify HTML comment appears on the issue
- [ ] View issue in GitHub — verify transition comment is invisible in rendered markdown
- [ ] View issue raw markdown — verify comment contains valid JSON with from/to/command/at

**Dependencies created for next phase**: `lib/transition-comments.ts` module with `TransitionRecord` type and `parseTransitionComments` function (will be used by future `cycle_time_report` tool).

---

## Phase 2: Pipeline Metrics Tool

### Overview

Implement the `ralph_hero__pipeline_metrics` MCP tool that returns a real-time pipeline snapshot. This queries all project items, groups them by Workflow State, computes WIP counts, and generates actionable suggestions.

### Changes Required

#### 1. Create analytics tools module
**File**: `plugin/ralph-hero/mcp-server/src/tools/analytics-tools.ts` (new)

**Contents**:

`registerAnalyticsTools(server, client, fieldCache)` function following the pattern of `registerProjectTools` / `registerIssueTools`.

**`ralph_hero__pipeline_metrics` tool**:

Input schema:
```typescript
{
  owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
  repo: z.string().optional().describe("Repository name. Defaults to env var"),
}
```

Output structure:
```typescript
{
  snapshot: {
    [workflowState: string]: {
      count: number;
      issues: Array<{
        number: number;
        title: string;
        estimate: string | null;
        priority: string | null;
      }>;
    };
  };
  totalOpen: number;
  totalDone: number;
  totalCanceled: number;
  wipByPhase: Record<string, number>;  // Workflow state name -> count
  suggestions: string[];
}
```

Implementation approach:
1. Resolve project config (reuse `resolveProjectOwner`, `ensureFieldCache` patterns)
2. Fetch ALL project items using `paginateConnection` with the same GraphQL query pattern from `list_project_items` (fetch items with `fieldValues` including Workflow State, Estimate, Priority)
3. Filter to ISSUE type items only (exclude PRs and draft issues)
4. Group items by Workflow State field value
5. For each state, collect issue number, title, estimate, priority
6. Compute suggestions based on WIP thresholds:
   - WIP > 3 in any non-terminal state: `"[State] has [N] items — consider running [suggested command]"`
   - WIP > 5 in any non-terminal state: `"WARNING: [State] has [N] items — pipeline bottleneck"`
   - 0 items in "Ready for Plan" but >0 in "Research in Progress": `"Pipeline flowing — research in progress"`
   - "Human Needed" has any items: `"[N] issue(s) need human attention"`
7. Order states by `STATE_ORDER` from `workflow-states.ts` for consistent display

Suggestion mapping (state → suggested command):
| State | Suggestion |
|-------|-----------|
| Backlog | `ralph-triage` |
| Research Needed | `ralph-research` |
| Ready for Plan | `ralph-plan` |
| Plan in Review | `ralph-review` |
| In Progress | (implementation underway) |
| In Review | (review underway) |
| Human Needed | (manual intervention needed) |

#### 2. Register analytics tools in index.ts
**File**: `plugin/ralph-hero/mcp-server/src/index.ts`

**Changes**:
- Add import: `import { registerAnalyticsTools } from "./tools/analytics-tools.js";`
- Add registration call after relationship tools (line ~294): `registerAnalyticsTools(server, client, fieldCache);`

#### 3. Export shared helpers from project-tools (if needed)
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`

**Changes**: If the `RawProjectItem` interface and `getFieldValue` / `ensureFieldCache` helpers are not already exported, export them for reuse. Alternatively, the analytics tool can inline its own copies of these small helpers.

**Preferred approach**: Duplicate the small `getFieldValue` helper inline in `analytics-tools.ts` to avoid coupling (it's ~5 lines). The `RawProjectItem` type and `ensureFieldCache` pattern can be duplicated too since they're trivial. This avoids circular dependencies and keeps modules independent.

#### 4. Add tests for pipeline metrics
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/analytics-tools.test.ts` (new)

**Tests** (unit tests with mock data, no API calls):
- Groups items by workflow state correctly
- Computes WIP counts per state
- Generates suggestion when WIP > 3 in a non-terminal state
- Generates WARNING when WIP > 5
- Generates human attention suggestion when Human Needed has items
- Excludes PR and draft issue types from counts
- Orders states by canonical pipeline order
- Returns empty snapshot for empty project

**Approach**: Extract the grouping/suggestion logic into a pure function (`computePipelineMetrics(items)`) that can be unit tested without mocking the GitHub API. The tool handler calls this function after fetching data.

### Success Criteria

#### Automated Verification
- [ ] `npm run build` — no type errors
- [ ] `npm test` — analytics-tools tests pass
- [ ] `npx vitest run src/__tests__/analytics-tools.test.ts` — focused test pass

#### Manual Verification
- [ ] Call `pipeline_metrics` — returns JSON with snapshot grouped by workflow state
- [ ] Verify WIP counts match actual project board state
- [ ] Verify suggestions appear when a state has >3 items

**Depends on**: Phase 1 (shares the `transition-comments.ts` types, though the metrics tool doesn't parse comments yet — that's Phase 2 scope for `cycle_time_report`).

---

## Integration Testing

After all phases complete:
- [ ] `npm run build` — clean compile, no type errors
- [ ] `npm test` — all tests pass (existing + new)
- [ ] Call `update_workflow_state` followed by `pipeline_metrics` — verify transition comment was created and metrics reflect the updated state
- [ ] Verify `pipeline_metrics` output is consistent with `list_project_items` filtered counts
- [ ] Run `ralph-review` or `ralph-plan` end-to-end — verify transition comments appear automatically

## API Cost Analysis

| Operation | API Points | Frequency |
|-----------|-----------|-----------|
| Transition comment (per state change) | ~2 points | Every `update_workflow_state` call |
| `pipeline_metrics` snapshot | ~4-6 points | On-demand (paginated project items query) |

The transition comment adds ~2 points per state transition, effectively doubling the cost of `update_workflow_state` from ~6 to ~8 points. For a typical issue lifecycle (8-9 transitions), this adds ~16-18 points total per issue — negligible against the 5000/hour budget.

## Interaction with Other Issues

- **#19 (Handoff Ticket)**: If `update_workflow_state` is replaced by `handoff_ticket`, the transition comment instrumentation should move to the new tool. The `buildTransitionComment` helper is tool-agnostic and will work with either.
- **#21 (Batch Operations)**: Batch state transitions should also create transition comments per issue. The `buildTransitionComment` helper can be called in a loop.

## References

- [Issue #20](https://github.com/cdubiel08/ralph-hero/issues/20)
- [Research: GH-20](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-16-GH-0020-pipeline-analytics.md)
- [issue-tools.ts — update_workflow_state](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1208-L1295)
- [project-tools.ts — list_project_items](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L382-L549)
- [lib/pipeline-detection.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts)
- [lib/workflow-states.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts)
