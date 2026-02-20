---
date: 2026-02-20
github_issue: 149
github_url: https://github.com/cdubiel08/ralph-hero/issues/149
status: complete
type: research
---

# GH-149: Add `profile` Param to List Tools

## Problem Statement

Agents must manually specify individual filter parameters (workflowState, estimate, priority, etc.) every time they call `list_issues` or `list_project_items`. A `profile` param that expands to pre-defined filter sets would reduce token usage, eliminate typos, and make agent skill files more readable (e.g., `profile: "analyst-triage"` instead of `workflowState: "Backlog"`).

## Dependency

**GH-147 must be implemented first.** GH-147 creates `src/lib/filter-profiles.ts` with the `FILTER_PROFILES` constant and `expandProfile()` function. GH-149 wires that function into the two list tools. Without the registry, there is nothing to expand.

## Current State Analysis

### `list_issues` Tool (`issue-tools.ts:50-305`)

**Zod schema** (lines 53-111): 11 params — `owner`, `repo`, `workflowState`, `estimate`, `priority`, `label`, `query`, `state`, `reason`, `updatedSince`, `updatedBefore`, `orderBy`, `limit`.

**Handler entry** (line 112): `async (args) => { ... }` — the handler starts with `resolveFullConfig`, then `ensureFieldCache`, then the GraphQL query. Client-side filtering begins at line 174.

**Filter chain** (lines 174-257): Sequential `Array.filter()` calls for `state`, `reason`, `workflowState`, `estimate`, `priority`, `label`, `query`, `updatedSince`, `updatedBefore`.

**Key insertion point**: Profile expansion should happen at the very top of the handler (line 113), before `resolveFullConfig`. The expanded profile values need to be merged into `args` so all downstream filters work unchanged.

### `list_project_items` Tool (`project-tools.ts:382-602`)

**Zod schema** (lines 385-431): 9 params — `owner`, `number`, `workflowState`, `estimate`, `priority`, `itemType`, `updatedSince`, `updatedBefore`, `limit`.

**Handler entry** (line 432): Similar pattern — resolve config, ensure cache, GraphQL query, then client-side filtering.

**Filter chain** (lines 520-564): Sequential `Array.filter()` calls for `itemType`, `workflowState`, `estimate`, `priority`, `updatedSince`, `updatedBefore`.

**Key insertion point**: Profile expansion at line 433, before config resolution.

### Test Patterns

Both tool test files (`issue-tools.test.ts`, `project-tools.test.ts`) use **structural source-code tests** — they read the tool source file as a string and assert presence of param names, imports, and patterns. This is the pattern to follow for GH-149 tests.

## Implementation Plan

### 1. Add `profile` Param to `list_issues` Zod Schema

Insert after `repo` param (around line 63), before the filter params:

```typescript
profile: z
  .string()
  .optional()
  .describe(
    "Named filter profile to apply (e.g., 'analyst-triage', 'builder-active'). " +
    "Profile filters are applied first, then explicit params override them.",
  ),
```

### 2. Add Profile Expansion to `list_issues` Handler

At the top of the handler (line 113), before `resolveFullConfig`:

```typescript
// Expand profile into filter defaults (explicit args override)
if (args.profile) {
  const profileFilters = expandProfile(args.profile);
  // Merge: explicit args take precedence over profile defaults
  for (const [key, value] of Object.entries(profileFilters)) {
    if (args[key as keyof typeof args] === undefined) {
      (args as Record<string, unknown>)[key] = value;
    }
  }
}
```

Add the import at the top of `issue-tools.ts`:

```typescript
import { expandProfile } from "../lib/filter-profiles.js";
```

### 3. Add `profile` Param to `list_project_items` Zod Schema

Insert after `number` param (around line 395):

```typescript
profile: z
  .string()
  .optional()
  .describe(
    "Named filter profile to apply (e.g., 'analyst-triage', 'builder-active'). " +
    "Profile filters are applied first, then explicit params override them.",
  ),
```

### 4. Add Profile Expansion to `list_project_items` Handler

Same pattern as `list_issues` — at the top of the handler (line 433):

```typescript
if (args.profile) {
  const profileFilters = expandProfile(args.profile);
  for (const [key, value] of Object.entries(profileFilters)) {
    if (args[key as keyof typeof args] === undefined) {
      (args as Record<string, unknown>)[key] = value;
    }
  }
}
```

Add the import at the top of `project-tools.ts`:

```typescript
import { expandProfile } from "../lib/filter-profiles.js";
```

### 5. Error Handling for Invalid Profile

The `expandProfile()` function from GH-147 is expected to throw with a helpful error listing valid profile names when given an invalid name. This error will propagate to the tool's `catch` block and return a `toolError()` — no special handling needed in the tool code.

### 6. Tests

Add to `issue-tools.test.ts`:

```typescript
describe("list_issues profile param", () => {
  it("has profile param in Zod schema", () => {
    expect(issueToolsSrc).toContain("profile: z");
  });

  it("imports expandProfile", () => {
    expect(issueToolsSrc).toContain(
      'import { expandProfile } from "../lib/filter-profiles.js"',
    );
  });

  it("calls expandProfile when profile is set", () => {
    expect(issueToolsSrc).toContain("expandProfile(args.profile)");
  });

  it("explicit args override profile defaults", () => {
    // The merge loop should check for undefined before overwriting
    expect(issueToolsSrc).toContain("=== undefined");
  });
});
```

Add to `project-tools.test.ts`:

```typescript
describe("list_project_items profile param", () => {
  it("has profile param in Zod schema", () => {
    expect(projectToolsSrc).toContain("profile: z");
  });

  it("imports expandProfile", () => {
    expect(projectToolsSrc).toContain(
      'import { expandProfile } from "../lib/filter-profiles.js"',
    );
  });

  it("calls expandProfile when profile is set", () => {
    expect(projectToolsSrc).toContain("expandProfile(args.profile)");
  });
});
```

## Merge Semantics

The critical design decision is **explicit args override profile defaults**. This means:

- `profile: "analyst-triage"` expands to `{ workflowState: "Backlog" }`
- Adding `priority: "P0"` narrows further: `{ workflowState: "Backlog", priority: "P0" }`
- Adding `workflowState: "Research Needed"` overrides the profile's default: `{ workflowState: "Research Needed" }`

This is straightforward: iterate profile keys, only set if `args[key]` is `undefined`.

## Edge Cases

1. **No profile specified**: No-op. Behavior is identical to current code.
2. **Invalid profile name**: `expandProfile()` throws, caught by tool `catch` block, returns `toolError()`.
3. **Profile + explicit args overlap**: Explicit args win (checked before assignment).
4. **Profile expands to params not in tool schema**: The expanded object may contain keys like `label` or `query` from GH-147 profiles. `list_project_items` doesn't have these params, but the merge loop writes them to `args` anyway. Since no filter chain reads them, they are harmless dead keys. This is acceptable for simplicity.
5. **Profile depends on unimplemented features**: Some profiles from GH-147 (like `analyst-triage` with `no:estimate`) depend on GH-106 (has/no presence filters). When expanded, they only populate the filters that currently exist (e.g., `workflowState`). The missing filters are simply not present in the expanded object and have no effect.

## File Changes

| File | Change | Effort |
|------|--------|--------|
| `tools/issue-tools.ts` | Add `profile` param to Zod schema, add `expandProfile` import and merge logic | Primary |
| `tools/project-tools.ts` | Same pattern as issue-tools | Primary |
| `__tests__/issue-tools.test.ts` | Structural tests for profile param | Secondary |
| `__tests__/project-tools.test.ts` | Structural tests for profile param | Secondary |

## Group Context

Part of the #109 (Pre-canned agent filter profiles) group, child of #94 (Intelligent Agent Filtering). This issue depends on #147 (filter profile registry). #148 (skill documentation) is independent and can be done in parallel with this issue.

## Risks

1. **Low risk**: Additive change only. The `profile` param is optional — omitting it preserves all existing behavior.
2. **Type safety**: The merge loop uses a cast to `Record<string, unknown>` which bypasses TypeScript's strict checks. This is acceptable because the profile keys are a strict subset of the tool's known filter params, and any extra keys are harmless.
3. **Coupling to GH-147**: The import of `expandProfile` creates a hard dependency. If GH-147 is not merged first, the build fails. This is the intended ordering.

## Recommended Approach

Implement immediately after GH-147 merges. The total change is ~20 lines of new code across 2 tool files plus structural tests. Estimated effort: XS.
