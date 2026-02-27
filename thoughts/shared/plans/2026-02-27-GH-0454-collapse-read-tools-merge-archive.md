---
date: 2026-02-27
status: draft
github_issues: [454]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/454
primary_issue: 454
---

# Collapse Redundant Read Tools and Merge Archive — Atomic Implementation Plan

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-454 | Collapse redundant read tools and merge archive | S |

## Current State Analysis

Seven tools are redundant with existing capabilities:

| Tool | File | Why redundant |
|------|------|---------------|
| `detect_group` | `relationship-tools.ts:562-590` | `get_issue(includeGroup: true)` already calls `detectGroup()` at `issue-tools.ts:661-691` |
| `detect_pipeline_position` | `issue-tools.ts:1357-1457` | Can be folded into `get_issue` as `includePipeline` flag |
| `check_convergence` | `issue-tools.ts:1462-1594` | Pipeline data from `get_issue(includePipeline: true)` includes convergence |
| `list_project_items` | `project-tools.ts:769-1097` | `list_issues` has richer filtering; only unique feature is `DRAFT_ISSUE`/`PULL_REQUEST` item types |
| `detect_work_streams` | `relationship-tools.ts:595-637` | `detect_stream_positions` in `dashboard-tools.ts:478` calls `detectWorkStreams()` internally |
| `archive_item` | `project-management-tools.ts:44-126` | Can be merged into `bulk_archive` with a `number` parameter |

Additionally, `archive_item` and `bulk_archive` share archive functionality but have different interfaces.

**Key insight for `includePipeline`**: The existing `get_issue` handler already calls `detectGroup()` and has the seed issue's field values (workflowState, estimate, priority) from the GraphQL response. To add pipeline detection, we need to: (1) call `getIssueFieldValues` for each non-seed group member, (2) fetch sub-issue counts for M/L/XL estimates, (3) call `detectPipelinePosition()`. This mirrors exactly what the `detect_pipeline_position` tool does at `issue-tools.ts:1384-1457`.

**`list_project_items` migration note**: The only feature in `list_project_items` not in `list_issues` is the `itemType` filter for `DRAFT_ISSUE` and `PULL_REQUEST` items. Draft issues have their own dedicated tools (`get_draft_issue`, `list_sub_issues` returns them). PR items are not used by any skill. No feature migration is needed.

## Desired End State

- `get_issue` gains `includePipeline: boolean` parameter (default `false`)
- When `true`: auto-enables `includeGroup`, fetches field values for group members, runs `detectPipelinePosition()`, returns pipeline data including convergence
- `bulk_archive` gains optional `number` parameter for single-item archiving with `unarchive` support
- 7 tool registrations removed (detect_group, detect_pipeline_position, check_convergence, list_project_items, detect_work_streams, archive_item)
- Net: -7 tools + 0 new = -7

### Verification
- [ ] `get_issue(number: N, includePipeline: true)` returns pipeline position + convergence
- [ ] `get_issue(number: N, includePipeline: false)` returns same as before (no regression)
- [ ] `bulk_archive(number: N)` archives a single item
- [ ] `bulk_archive(number: N, unarchive: true)` unarchives a single item
- [ ] All 7 removed tools are gone from source
- [ ] `npm test` and `npm run build` pass

## What We're NOT Doing

- Updating skills/agents that reference removed tools (Phase 5, GH-456)
- Removing setup/admin tools (Phase 4, GH-455)
- Building `save_issue` (Phase 1, GH-452)

## Implementation Approach

Two parallel workstreams: (A) extend `get_issue` with `includePipeline` and remove 6 read tools, (B) merge `archive_item` into `bulk_archive`. Both are independent changes in different files.

---

## Phase 1: GH-454 — Collapse redundant read tools and merge archive
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/454

### Changes Required

#### 1. Export `getIssueFieldValues` from issue-tools.ts
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: The `getIssueFieldValues` function at line 1892 is currently module-private. Either:
- Export it so the `get_issue` handler can call it (it's in the same file, so no import needed — it's already accessible)
- If it's a nested function inside a tool registration callback, extract it to module scope

Since `getIssueFieldValues` is already at module scope (lines 1892-1964), it's directly callable from the `get_issue` handler. No export needed.

#### 2. Add `includePipeline` parameter to `get_issue`
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: Add to the `get_issue` Zod schema (near `includeGroup` parameter):

```typescript
includePipeline: z.boolean().optional().default(false)
  .describe("Include pipeline position: phase, convergence, member states, remaining phases. Auto-enables includeGroup."),
```

#### 3. Add pipeline detection logic to `get_issue` handler
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: After the existing `includeGroup` block (~line 691) and before `return toolSuccess(...)` (~line 693), add:

```typescript
let pipeline = null;
if (args.includePipeline) {
  try {
    // Force includeGroup if not already run
    if (!group) {
      const groupResult = await detectGroup(client, cfgOwner, cfgRepo, args.number);
      group = { isGroup: groupResult.isGroup, primary: {...}, members: [...], totalTickets: groupResult.totalTickets };
    }

    // Need resolveFullConfig for project field lookups
    const { projectNumber: pn, projectOwner: po } = resolveFullConfig(client, args);
    await ensureFieldCache(client, fieldCache, po, pn);

    // Build IssueState[] from group members
    // The seed issue already has workflowState/estimate from the main query (lines 607-646)
    const issueStates: IssueState[] = await Promise.all(
      (group.members || []).map(async (member) => {
        if (member.number === args.number) {
          // Use already-fetched values for the seed issue
          return {
            number: member.number,
            title: member.title,
            workflowState: workflowState || "unknown",
            estimate: estimate || null,
            subIssueCount: 0,
          };
        }
        // Fetch field values for non-seed members
        const state = await getIssueFieldValues(client, fieldCache, cfgOwner, cfgRepo, member.number);
        return {
          number: member.number,
          title: member.title,
          workflowState: state.workflowState || "unknown",
          estimate: state.estimate || null,
          subIssueCount: 0,
        };
      }),
    );

    // Fetch sub-issue counts for M/L/XL estimates (same pattern as detect_pipeline_position:1406-1434)
    const oversized = issueStates.filter((s) =>
      s.estimate && ["M", "L", "XL"].includes(s.estimate)
    );
    if (oversized.length > 0) {
      await Promise.all(
        oversized.map(async (s) => {
          try {
            // Query subIssuesSummary.total for this issue
            const result = await client.query<{ repository: { issue: { subIssuesSummary: { total: number } } } }>(
              `query($owner: String!, $repo: String!, $number: Int!) {
                repository(owner: $owner, name: $repo) {
                  issue(number: $number) { subIssuesSummary { total } }
                }
              }`,
              { owner: cfgOwner, repo: cfgRepo, number: s.number }
            );
            s.subIssueCount = result.repository.issue.subIssuesSummary.total;
          } catch {
            // Best-effort, leave at 0
          }
        }),
      );
    }

    // Run pipeline detection
    const pipelineResult = detectPipelinePosition(
      issueStates,
      group.isGroup,
      group.primary?.number ?? null,
    );

    pipeline = {
      phase: pipelineResult.phase,
      reason: pipelineResult.reason,
      remainingPhases: pipelineResult.remainingPhases,
      convergence: pipelineResult.convergence,
      memberStates: pipelineResult.issues,
      suggestedRoster: pipelineResult.suggestedRoster,
    };
  } catch {
    pipeline = null; // Best-effort, same as includeGroup
  }
}
```

Then add `pipeline` to the `toolSuccess(...)` return object.

**Import**: Add `import { detectPipelinePosition, type IssueState, type PipelinePosition } from "../lib/pipeline-detection.js"` at the top of the file (if not already imported).

#### 4. Remove `detect_pipeline_position` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: Remove the entire tool registration block at lines ~1357-1457. The `getIssueFieldValues` function (lines 1892-1964) must be preserved — it's now used by the `get_issue` handler's `includePipeline` logic.

#### 5. Remove `check_convergence` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: Remove the entire tool registration block at lines ~1462-1594. Also remove `computeDistance` helper (lines ~1972-1977) if it's only used by `check_convergence`. The convergence data is now available via `get_issue(includePipeline: true)`.

**Note**: `check_convergence` supports a caller-supplied `targetState` for checking convergence against a specific state. The pipeline-based convergence auto-detects the target from the current phase. This is a capability reduction — document in the PR description that callers needing custom target state checks should use the pipeline data and filter manually.

#### 6. Remove `detect_group` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`
**Changes**: Remove the tool registration block at lines ~562-590. The `detectGroup` function in `lib/group-detection.ts` is preserved — it's used by `get_issue`.

#### 7. Remove `detect_work_streams` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`
**Changes**: Remove the tool registration block at lines ~595-637. The `detectWorkStreams` function in `lib/work-stream-detection.ts` is preserved — it's called by `detect_stream_positions`.

#### 8. Remove `list_project_items` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`
**Changes**: Remove the entire tool registration block at lines ~769-1097. This is a large block (~330 lines). No function extraction needed — `list_issues` covers the same use cases for ISSUE items.

#### 9. Merge `archive_item` into `bulk_archive`
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Changes**:

a. Add optional parameters to `bulk_archive` schema:
```typescript
number: z.coerce.number().optional()
  .describe("Archive a single issue by number. Mutually exclusive with workflowStates filter."),
projectItemId: z.string().optional()
  .describe("Archive by project item ID (for draft issues). Mutually exclusive with number and workflowStates."),
unarchive: z.boolean().optional().default(false)
  .describe("Unarchive instead of archive. Only works with number or projectItemId (single-item mode)."),
```

b. Make `workflowStates` optional (currently required with `min(1)`):
```typescript
workflowStates: z.array(z.string()).optional()
  .describe("Filter: archive items in these workflow states (bulk mode). Required unless number or projectItemId is provided."),
```

c. Add validation at handler start:
```typescript
const isSingleItem = args.number !== undefined || args.projectItemId !== undefined;
const isBulk = args.workflowStates && args.workflowStates.length > 0;
if (!isSingleItem && !isBulk) {
  return toolError("Provide either 'number'/'projectItemId' (single item) or 'workflowStates' (bulk filter).");
}
if (isSingleItem && isBulk) {
  return toolError("Cannot combine number/projectItemId with workflowStates. Use one mode.");
}
if (args.unarchive && isBulk) {
  return toolError("Unarchive is only supported for single items (number or projectItemId).");
}
```

d. Add single-item path (copy logic from `archive_item` handler at lines 70-120):
```typescript
if (isSingleItem) {
  // Resolve itemId from number or use projectItemId directly
  // Fire archiveProjectV2Item or unarchiveProjectV2Item mutation
  // Return { number, archived: !args.unarchive, projectItemId }
}
```

e. Existing bulk path remains unchanged (lines ~1560-1673).

f. Remove standalone `archive_item` tool registration (lines 44-126).

g. Optionally rename tool from `ralph_hero__bulk_archive` to `ralph_hero__archive_items` for clarity. This is a breaking name change — if renaming, update the tool registration name at line ~1489.

#### 10. Update tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/`
**Changes**:

a. **New/updated test file** for `get_issue` with `includePipeline`:
- Schema test: `includePipeline` parameter accepted, defaults to `false`
- Structural test: handler imports `detectPipelinePosition`
- Structural test: handler calls `getIssueFieldValues` when `includePipeline` is true

b. **Remove tests** for removed tools:
- Any tests referencing `detect_group`, `detect_pipeline_position`, `check_convergence`, `list_project_items`, `detect_work_streams`, `archive_item` as tool names

c. **Add tests** for merged `bulk_archive`/`archive_items`:
- Schema test: accepts `number` (single-item mode)
- Schema test: accepts `workflowStates` (bulk mode)
- Schema test: rejects both `number` and `workflowStates` together
- Schema test: rejects `unarchive: true` with `workflowStates`

### Success Criteria

#### Automated Verification:
- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] `grep -r "detect_group\|detect_pipeline_position\|check_convergence\|list_project_items\|detect_work_streams\|archive_item" plugin/ralph-hero/mcp-server/src/tools/` returns no tool registrations (library functions preserved)
- [ ] `get_issue` schema includes `includePipeline` parameter
- [ ] `bulk_archive` (or `archive_items`) schema includes `number` and `unarchive` parameters

#### Manual Verification:
- [ ] `get_issue(number: N, includePipeline: true)` returns `pipeline` object with `phase`, `convergence`, `memberStates`
- [ ] `get_issue(number: N, includePipeline: false)` returns same as before (no `pipeline` key)
- [ ] `bulk_archive(number: N)` archives a single item
- [ ] `bulk_archive(number: N, unarchive: true)` unarchives it

**Implementation Note**: After automated verification passes, pause for manual confirmation.

---

## Key Implementation Notes

1. **`getIssueFieldValues` needs `resolveFullConfig`**: The `get_issue` handler currently only calls `resolveConfig` (no project awareness) for the main issue. When `includePipeline` is true, we need `resolveFullConfig` to get `projectNumber` and `projectOwner` for the `getIssueFieldValues` calls. Add this conditional resolution only when `includePipeline` is true.

2. **Seed issue optimization**: The `get_issue` handler already extracts `workflowState`, `estimate`, `priority` from the main GraphQL response (lines 607-646). For the seed issue, reuse these values instead of calling `getIssueFieldValues` again.

3. **Best-effort pattern**: Both `includeGroup` and `includePipeline` use try/catch with silent fallback to `null`. This matches the existing pattern and prevents pipeline detection failures from breaking `get_issue`.

4. **`check_convergence` capability reduction**: The removed `check_convergence` tool supported checking against a caller-supplied `targetState`. The `includePipeline` path auto-detects the target from the current phase. Skills that used `check_convergence` with a specific target state will need to derive it from the pipeline data instead. This is acceptable because all known skill usage follows the auto-detected pattern.

5. **`archive_item` → `bulk_archive` naming**: Consider renaming to `archive_items` for clarity since it now handles both single and bulk. If renaming, it's a tool name change that Phase 5 (GH-456) will pick up in skill updates.

6. **`list_project_items` removal is clean**: No skill references `list_project_items` directly — they all use `list_issues`. The `itemType` filter for `DRAFT_ISSUE`/`PULL_REQUEST` is not used by any skill.

## References

- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/451
- Parent plan: `thoughts/shared/plans/2026-02-27-mcp-toolspace-consolidation.md` Phase 3
- `get_issue` handler: `issue-tools.ts:453-739`
- `detectPipelinePosition`: `lib/pipeline-detection.ts:113-338`
- `detectGroup`: `lib/group-detection.ts:180-381`
- `getIssueFieldValues`: `issue-tools.ts:1892-1964`
- `detect_pipeline_position` tool: `issue-tools.ts:1357-1457`
- `check_convergence` tool: `issue-tools.ts:1462-1594`
- `detect_group` tool: `relationship-tools.ts:562-590`
- `detect_work_streams` tool: `relationship-tools.ts:595-637`
- `list_project_items` tool: `project-tools.ts:769-1097`
- `archive_item` tool: `project-management-tools.ts:44-126`
- `bulk_archive` tool: `project-management-tools.ts:1489-1673`
