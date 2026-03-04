---
date: 2026-03-04
github_issue: 522
github_url: https://github.com/cdubiel08/ralph-hero/issues/522
status: complete
type: research
---

# Auto-advance parent in save_issue using batch queries

## Problem Statement

When `save_issue` moves a sub-issue to a gate state (Ready for Plan, Plan in Review, In Review, Done), the parent issue should automatically advance if all siblings are at that gate. Currently only `ralph-merge` calls `advance_issue(direction="parent")`, leaving parents behind as children progress through research, planning, and review phases.

## Current State Analysis

### `save_issue` Structure (insertion point)

[`plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:1102-1431`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1102-L1431)

**Key variable availability** within `save_issue`:

| Variable | Line | Scope |
|----------|------|-------|
| `changes` | 1144 | handler scope |
| `resolvedWorkflowState` | 1145 | handler scope |
| `owner`, `repo` | ~1108 | handler scope |
| `client`, `fieldCache` | closure | always available |
| `projectNumber` | 1325 | inside `if (hasProjectFields)` only |
| `projectItemId` | 1328 | inside `if (hasProjectFields)` only |

**Insertion point**: After line 1425 (closing `}` of `if (hasProjectFields)`) and before line 1427 (`return toolSuccess(...)`).

**Scoping issue**: `projectNumber` is declared at line 1325 inside the `if (hasProjectFields)` block and won't be in scope at line 1426. Options:
1. Hoist `projectNumber` resolution outside the block (adds complexity)
2. Re-resolve via `resolveFullConfig(client, args).projectNumber` at the insertion point (clean, minimal)
3. Place the auto-advance call inside the `if (hasProjectFields)` block before line 1425 (simpler but couples to project field path)

Option 3 is recommended — auto-advance only makes sense when project fields are being set, and `projectNumber` is naturally in scope.

**Current imports** (line 27):
```typescript
import { buildBatchMutationQuery } from "./batch-tools.js";
```
Will need to add: `buildBatchResolveQuery`, `buildBatchFieldValueQuery`.

From `helpers.js` (lines 32-42): already imports `updateProjectItemField`, `syncStatusField`.

From `workflow-states.js`: will need to add `isParentGateState`.

### `advance_issue(direction="parent")` — Current N+5 Cost Pattern

[`plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts:652-877`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L652-L877)

The existing implementation:
1. Fetch child issue + parent reference (1 query) — line 665-703
2. Fetch parent with all siblings (1 query) — line 708-752
3. Per-sibling `getCurrentFieldValue()` — each costs ~3 queries (resolveProjectItemId + field values) — lines 754-794
4. Fetch parent's current state (3 queries) — lines 818-842
5. Advance parent mutation + status sync (2 mutations) — lines 845-861

**Total: 3N + 6 API calls** for N siblings.

### Batch Tools Available

[`plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts)

**`buildBatchResolveQuery`** (line 46-80):
```typescript
export function buildBatchResolveQuery(
  owner: string,
  repo: string,
  issueNumbers: number[],
): { queryString: string; variables: Record<string, unknown> }
```
Returns aliased GraphQL query with aliases `i0`, `i1`, etc. Each returns `{ issue: { id, projectItems: { nodes: [{ id, project: { id } }] } } }`.

**`buildBatchFieldValueQuery`** (line 132-162):
```typescript
export function buildBatchFieldValueQuery(
  projectItemIds: Array<{ alias: string; itemId: string }>,
): { queryString: string; variables: Record<string, unknown> }
```
Takes `{ alias, itemId }` pairs. Returns aliased query where each alias returns `{ fieldValues: { nodes: [{ __typename, name, field: { name } }] } }`.

Both are exported and can be imported directly.

### Batch Result Parsing Pattern

From `batch-tools.ts` lines 332-375 and 409-431:

**Resolve results**: Access via `resolveResult["i0"]`, check `data?.issue?.projectItems.nodes.find(item => item.project.id === projectId)`.

**Field value results**: Access via `fvResult["fv42"]`, find `fieldValues?.nodes?.find(fv => fv.field?.name === "Workflow State" && fv.__typename === "ProjectV2ItemFieldSingleSelectValue")?.name`.

### Helper Functions

**`updateProjectItemField`** ([`helpers.ts:231-271`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L231-L271)):
- Takes: `client`, `fieldCache`, `projectItemId`, `fieldName`, `optionName`, `projectNumber`
- Resolves field/option IDs from cache, executes mutation

**`syncStatusField`** ([`helpers.ts:569-597`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L569-L597)):
- Takes: `client`, `fieldCache`, `projectItemId`, `workflowState`, `projectNumber`
- Best-effort sync of Status field based on `WORKFLOW_STATE_TO_STATUS` mapping
- Last function in the file — `autoAdvanceParent` would go after line 597

**`resolveIssueNodeId`** ([`helpers.ts:127-155`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L127-L155)):
- Returns only `{ id }` — no parent field
- Cached for 30 minutes with key `issue-node-id:{owner}/{repo}#{number}`

### Existing Test Patterns

[`plugin/ralph-hero/mcp-server/src/__tests__/save-issue.test.ts:207-288`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/save-issue.test.ts#L207-L288):

Structural tests read source code as strings and validate patterns:
```typescript
const issueToolsSrc = fs.readFileSync(path.resolve(__dirname, "../tools/issue-tools.ts"), "utf-8");
it("handler calls resolveState when workflowState is provided", () => {
  expect(issueToolsSrc).toContain("resolveState(args.workflowState, args.command)");
});
```

New structural test would verify: `issueToolsSrc.toContain("autoAdvanceParent")` and `issueToolsSrc.toContain("isParentGateState")`.

## Key Decisions for Implementation

### 1. `autoAdvanceParent` Placement
- Goes in `helpers.ts` after `syncStatusField` (line 597+)
- Exported function, called from `save_issue`
- Best-effort: wrapped in try/catch, returns `null` on failure

### 2. Batch Query Strategy (constant-time)
Instead of N sequential `getCurrentFieldValue()` calls:
- **Step A**: 1 query to fetch parent number (new query — `resolveIssueNodeId` doesn't fetch parent)
- **Step B**: 1 query to fetch sibling numbers
- **Step C**: 1 `buildBatchResolveQuery` for all siblings + parent → project item IDs
- **Step D**: 1 `buildBatchFieldValueQuery` for all items → workflow states
- **Step E**: In-memory gate check (zero cost)
- **Step F**: 1-2 mutations to advance parent (if needed)

**Total: 4-6 calls regardless of N** vs current 3N+6.

### 3. `extractWorkflowState` Helper
Small function to parse batch field value responses. Used only by `autoAdvanceParent`. Can be a module-private function in `helpers.ts`.

### 4. Gate Check (zero-cost path)
```typescript
if (resolvedWorkflowState && isParentGateState(resolvedWorkflowState)) {
  // autoAdvanceParent call
}
```
Non-gate transitions (the vast majority) skip entirely — zero API cost.

### 5. Cache Priming
Batch resolve writes `issue-node-id:*` and `project-item-id:*` entries to `SessionCache`, benefiting subsequent operations in the same session.

## Risks

- **Low**: Best-effort wrapper means `save_issue` never breaks from auto-advance failures
- **Low**: `buildBatchResolveQuery` and `buildBatchFieldValueQuery` are battle-tested in `batch_update` tool
- **Medium**: Scoping of `projectNumber` at the insertion point needs care — recommend placing call inside `if (hasProjectFields)` block
- **Low**: No breaking changes — `changes.parentAdvanced` is a new additive field in the response

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/lib/helpers.ts` - Add `autoAdvanceParent()` and `extractWorkflowState()` helpers after `syncStatusField`
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` - Add `autoAdvanceParent` call in `save_issue` gated by `isParentGateState`; add imports for `buildBatchResolveQuery`, `buildBatchFieldValueQuery`, `isParentGateState`, `autoAdvanceParent`
- `plugin/ralph-hero/mcp-server/src/__tests__/save-issue.test.ts` - Add structural test for `autoAdvanceParent` gated by `isParentGateState`

### Will Create
- `plugin/ralph-hero/mcp-server/src/__tests__/auto-advance-parent.test.ts` - Unit tests for `autoAdvanceParent()` helper (no parent, not all at gate, parent already past, all at gate → advance, API error → null)

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts` - `buildBatchResolveQuery`, `buildBatchFieldValueQuery` patterns
- `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts` - Existing `advance_issue(direction="parent")` for reference
- `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts` - `isParentGateState`, `stateIndex`, `PARENT_GATE_STATES`
