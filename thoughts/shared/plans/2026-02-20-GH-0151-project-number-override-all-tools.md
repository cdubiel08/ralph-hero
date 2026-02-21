---
date: 2026-02-20
status: draft
github_issues: [151]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/151
primary_issue: 151
---

# GH-151: Add `projectNumber` Override to All Project-Aware Tools

## Overview

Single issue: add optional `projectNumber` parameter to all tools that interact with a project but currently lack an override. This enables per-call project targeting for multi-project environments.

**Depends on**: GH-150 (`resolveFullConfig` args extension) -- must be merged first.

## Current State Analysis

Tools fall into 4 categories based on how they resolve the project number:

| Category | Count | Change Required |
|----------|-------|-----------------|
| A: Uses `resolveFullConfig` | ~25 | Add `projectNumber` to Zod schema only |
| B: Uses `resolveConfig` (no project) | 9 | No change (except `get_issue` special case) |
| C: Manual inline resolution | 2 | Refactor to `resolveFullConfig` + add schema |
| D: Already has override | 4 | No change |

After GH-150 extends `resolveFullConfig` to extract `projectNumber` from args, Category A tools automatically pick it up once the schema field is added. Category C tools (`advance_children`, `advance_parent`) need refactoring from inline resolution to `resolveFullConfig`. `get_issue` (Category B exception) needs a one-line handler change.

## Desired End State

### Verification
- [ ] All ~28 project-aware tools accept optional `projectNumber` parameter
- [ ] When `projectNumber` provided, tool operates on that project
- [ ] When `projectNumber` omitted, falls back to configured default (backward compat)
- [ ] `get_issue` filters `projectItems` by override number
- [ ] `advance_children` and `advance_parent` use `resolveFullConfig` instead of inline resolution
- [ ] Tests verify override and fallback for representative tools

## What We're NOT Doing

- Config parsing or `resolveFullConfig` args extension (GH-150)
- `FieldOptionCache` multi-project keying (GH-144)
- Renaming existing `number` param in Category D tools (`get_project`, `list_project_items`, `list_views`, `update_field_options`) to `projectNumber` -- cosmetic alignment deferred
- Documentation updates (GH-152 sibling issue)

## Implementation Approach

Three phases, each building on the prior:
1. **Refactor** the 2 Category C tools to use `resolveFullConfig` (prerequisite for schema addition)
2. **Add schema field** to all ~28 tools across 4 files (mechanical, identical change per tool)
3. **Tests** for representative tools verifying override and fallback behavior

---

## Phase 1: Refactor `advance_children` and `advance_parent` to `resolveFullConfig`

> **Issue**: [GH-151](https://github.com/cdubiel08/ralph-hero/issues/151) | **Research**: [research doc](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0151-project-number-override-all-tools.md)

### Changes Required

#### 1. Refactor `advance_children` inline resolution
**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`
**Lines**: ~549-563

Replace the manual 3-step resolution pattern:
```typescript
// Before (lines 549-563):
const { owner, repo } = resolveConfig(client, args);
const projectNumber = client.config.projectNumber;
if (!projectNumber) {
  return toolError("projectNumber is required (set RALPH_GH_PROJECT_NUMBER env var)");
}
const projectOwner = resolveProjectOwner(client.config);
if (!projectOwner) {
  return toolError("projectOwner is required (set RALPH_GH_PROJECT_OWNER or RALPH_GH_OWNER env var)");
}

// After:
const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(client, args);
```

`resolveFullConfig` already throws on missing `projectNumber`/`projectOwner`, so the manual error checks are redundant and can be removed. The handler's existing `try/catch` will catch these errors.

Also update the import at the top of the file to include `resolveFullConfig` (currently only imports `resolveConfig`).

#### 2. Refactor `advance_parent` inline resolution
**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`
**Lines**: ~731-746

Identical change to `advance_children`:
```typescript
// Before (lines 731-746):
const { owner, repo } = resolveConfig(client, args);
const projectNumber = client.config.projectNumber;
// ... same manual checks ...

// After:
const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(client, args);
```

#### 3. Update imports
**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`

Add `resolveFullConfig` to the import from `../lib/helpers.js`. Currently imports:
```typescript
import { ensureFieldCache, resolveConfig, ... } from "../lib/helpers.js";
```
Add `resolveFullConfig` to this import list.

**Note**: `resolveProjectOwner` import from `../types.js` can be removed if no other code in the file uses it (only the 2 inline patterns referenced it).

### Success Criteria
- [x] Automated: `npm run build` passes
- [x] Automated: `npm test` passes (existing advance_children/advance_parent tests still pass)
- [x] Manual: Both tools behave identically to before (same error messages via `resolveFullConfig` throws)

**Creates for Phase 2**: Both tools now use `resolveFullConfig`, making them eligible for the mechanical schema addition.

---

## Phase 2: Add `projectNumber` Schema Field to All Tools

> **Issue**: [GH-151](https://github.com/cdubiel08/ralph-hero/issues/151) | **Depends on**: Phase 1

### Changes Required

#### 1. Add `projectNumber` to `issue-tools.ts` tools (9 tools)
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`

Add to the Zod schema of each tool listed below, alongside the existing `owner` and `repo` optional params:

```typescript
projectNumber: z.coerce.number().optional()
  .describe("Project number override (defaults to configured project)"),
```

| Tool | Schema Location |
|------|----------------|
| `list_issues` | After `repo` param (~line 64) |
| `get_issue` | After `repo` param (~line 435) |
| `create_issue` | After `repo` param (~line 725) |
| `update_workflow_state` | After `repo` param (~line 1049) |
| `update_estimate` | After `repo` param (~line 1144) |
| `update_priority` | After `repo` param (~line 1198) |
| `detect_pipeline_position` | After `repo` param (~line 1317) |
| `check_convergence` | After `repo` param (~line 1389) |
| `pick_actionable_issue` | After `repo` param (~line 1526) |

**Special case: `get_issue`** -- In addition to the schema field, update the handler to use the override:
```typescript
// Before (line 448):
const projectNumber = client.config.projectNumber;

// After:
const projectNumber = args.projectNumber ?? client.config.projectNumber;
```

The other 8 tools need no handler changes -- they already call `resolveFullConfig(client, args)` which will extract `projectNumber` from args after GH-150.

#### 2. Add `projectNumber` to `relationship-tools.ts` tools (2 tools)
**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`

Add the same schema field to:

| Tool | Schema Location |
|------|----------------|
| `advance_children` | After `repo` param (~line 530) |
| `advance_parent` | After `repo` param (~line 726) |

No handler changes needed (Phase 1 already switched them to `resolveFullConfig`).

#### 3. Add `projectNumber` to `project-management-tools.ts` tools (16 tools)
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`

Add the same schema field to all 16 tools:

| Tool | Schema Location |
|------|----------------|
| `archive_item` | After `repo` param (~line 49) |
| `remove_from_project` | After `repo` param (~line 119) |
| `add_to_project` | After `repo` param (~line 180) |
| `link_repository` | After `repo` param (~line 249) |
| `clear_field` | After `repo` param (~line 343) |
| `create_draft_issue` | After `repo` param (~line 414) |
| `update_draft_issue` | After `repo` param (~line 485) |
| `reorder_item` | After `repo` param (~line 542) |
| `update_project` | After `repo` param (~line 612) |
| `delete_field` | After `repo` param (~line 706) |
| `update_collaborators` | After `repo` param (~line 788) |
| `create_status_update` | After `repo` param (~line 909) |
| `update_status_update` | After `repo` param (~line 995) |
| `delete_status_update` | After `repo` param (~line 1088) |
| `bulk_archive` | After `repo` param (~line 1134) |
| `link_team` | After `repo` param (~line 1273) |

No handler changes needed -- all use `resolveFullConfig(client, args)`.

#### 4. Add `projectNumber` to `batch-tools.ts` (1 tool)
**File**: `plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts`

Add the same schema field to `batch_update`:

| Tool | Schema Location |
|------|----------------|
| `batch_update` | After `repo` param (~line 230) |

No handler changes needed.

### Success Criteria
- [x] Automated: `npm run build` passes
- [x] Automated: `npm test` passes
- [x] Manual: Verify `projectNumber` appears in tool schema via MCP introspection for all 28 tools
- [x] Manual: Verify backward compatibility (omitting `projectNumber` uses config default)

**Creates for Phase 3**: All tools now accept the override, ready for test coverage.

---

## Phase 3: Tests

> **Issue**: [GH-151](https://github.com/cdubiel08/ralph-hero/issues/151) | **Depends on**: Phase 2

### Changes Required

#### 1. Schema validation tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-number-override.test.ts` (NEW)

Test the Zod schema for representative tools to verify `projectNumber` is accepted and optional:

```typescript
describe("projectNumber override schema", () => {
  // Extract schemas from a representative set (not all 28)
  test("accepts projectNumber as optional number", () => { ... });
  test("omitting projectNumber is valid", () => { ... });
  test("coerces string to number", () => { ... });
  test("rejects non-numeric values", () => { ... });
});
```

#### 2. `resolveFullConfig` override test
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/helpers.test.ts` (or existing test file)

Verify that `resolveFullConfig` extracts `projectNumber` from args when present (this is really a GH-150 test, but we confirm integration here):

```typescript
describe("resolveFullConfig with projectNumber override", () => {
  test("uses args.projectNumber when provided", () => { ... });
  test("falls back to config.projectNumber when args omitted", () => { ... });
});
```

**Note**: This test depends on GH-150's changes to `resolveFullConfig`. If GH-150 is not yet merged when implementing, write the test against the expected API and skip it until GH-150 lands.

#### 3. `get_issue` projectNumber filter test
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-number-override.test.ts`

Test the `get_issue` handler's `projectItems` filtering with override:

```typescript
describe("get_issue projectNumber override", () => {
  test("filters projectItems by override number", () => { ... });
  test("falls back to config number when no override", () => { ... });
});
```

#### 4. `advance_children`/`advance_parent` refactor verification
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-number-override.test.ts`

Verify the refactored tools accept `projectNumber` in their schemas:

```typescript
describe("advance_children/advance_parent projectNumber", () => {
  test("advance_children schema accepts projectNumber", () => { ... });
  test("advance_parent schema accepts projectNumber", () => { ... });
});
```

### Success Criteria
- [ ] Automated: `npm test` passes with all new tests
- [ ] Automated: No regressions in existing test suites
- [ ] Manual: Test coverage includes schema validation, `resolveFullConfig` integration, `get_issue` filtering, and advance_* refactor

---

## Integration Testing
- [ ] Build passes: `npm run build`
- [ ] All tests pass: `npm test`
- [ ] `get_issue` correctly filters `projectItems` when `projectNumber` override is provided
- [ ] Existing tools work identically when `projectNumber` is omitted (backward compat)
- [ ] `advance_children` and `advance_parent` work identically after `resolveFullConfig` refactor

## Known Limitations

- **`FieldOptionCache` single-project identity**: Until GH-144 makes the cache project-aware, overriding `projectNumber` may serve stale field data from a previously cached project. Single-project usage (the vast majority) is unaffected.
- **Naming divergence**: The 4 existing override tools in `project-tools.ts`/`view-tools.ts` use `number` while the new 28 use `projectNumber`. Cosmetic alignment deferred.

## References
- Research: [GH-151 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0151-project-number-override-all-tools.md)
- Predecessor group plan: [GH-144/145/150 group plan](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-20-group-GH-0144-multi-project-config-cache-dashboard.md)
- Issue: [GH-151](https://github.com/cdubiel08/ralph-hero/issues/151)
- Parent: [GH-103](https://github.com/cdubiel08/ralph-hero/issues/103)
