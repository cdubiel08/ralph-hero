---
date: 2026-02-20
status: draft
github_issue: 149
github_url: https://github.com/cdubiel08/ralph-hero/issues/149
primary_issue: 149
---

# GH-149: Add `profile` Param to List Tools - Implementation Plan

## Overview

Single issue implementation: GH-149 — Wire the filter profile expansion from GH-147 into `list_issues` and `list_project_items` tools.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-149 | Add `profile` param to list tools | XS |

**Prerequisite**: GH-147 (filter profile registry) must be merged first. This issue imports `expandProfile` from `src/lib/filter-profiles.ts` created by GH-147.

**Group plan**: This issue is also covered as Phase 2 in `thoughts/shared/plans/2026-02-20-group-GH-147-filter-profile-registry-and-wiring.md`.

## Current State Analysis

- `list_issues` (`issue-tools.ts:50-305`) accepts 11 filter params via Zod schema; client-side filter chain at lines 174-257
- `list_project_items` (`project-tools.ts:382-602`) accepts 8 filter params via Zod schema; client-side filter chain at lines 520-564
- Both tools follow the same pattern: Zod schema -> handler entry -> resolveConfig -> ensureFieldCache -> GraphQL query -> sequential Array.filter() chain -> format response
- GH-147 creates `src/lib/filter-profiles.ts` with `expandProfile(name: string): ProfileFilterParams` that returns filter defaults for a named profile or throws for invalid names
- Tests follow the structural source-code pattern (read .ts file as string, assert presence of patterns)

## Desired End State

### Verification
- [ ] `list_issues` accepts optional `profile` string param
- [ ] `list_project_items` accepts optional `profile` string param
- [ ] Profile filters apply as defaults; explicit args override them
- [ ] Invalid profile name returns `toolError` with list of valid profile names
- [ ] Omitting `profile` param is a no-op (backwards compatible)
- [ ] All tests pass: `npm test` in `mcp-server/`
- [ ] Build succeeds: `npm run build` in `mcp-server/`

## What We're NOT Doing
- Defining the profiles themselves (GH-147 scope)
- Updating agent skill SKILL.md files (GH-148 scope)
- Adding runtime profile extensibility or user-defined profiles
- Adding profile param to other tools (get_issue, pick_actionable_issue, etc.)

## Implementation Approach

Add one import, one Zod param, and one merge block to each of the two list tools. Add structural tests to both test files. Total ~20 lines of new code.

---

## Phase 1: GH-149 — Add `profile` param to list tools
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/149 | **Research**: thoughts/shared/research/2026-02-20-GH-0149-profile-param-list-tools.md | **Depends on**: GH-147

### Changes Required

#### 1. Add profile param and expansion to `list_issues`
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`

**Import** (add after existing imports, around line 26):
```typescript
import { expandProfile } from "../lib/filter-profiles.js";
```

**Zod schema** (add after `repo` param, before `workflowState`, around line 63):
```typescript
profile: z
  .string()
  .optional()
  .describe(
    "Named filter profile (e.g., 'analyst-triage', 'builder-active'). " +
    "Profile filters are defaults; explicit params override them.",
  ),
```

**Handler expansion** (add at top of handler, line 113, before `const { owner, repo, ... } = resolveFullConfig(...)`):
```typescript
// Expand profile into filter defaults (explicit args override)
if (args.profile) {
  const profileFilters = expandProfile(args.profile);
  for (const [key, value] of Object.entries(profileFilters)) {
    if (args[key as keyof typeof args] === undefined) {
      (args as Record<string, unknown>)[key] = value;
    }
  }
}
```

**Error handling**: `expandProfile()` throws for invalid names. The throw propagates to the existing `catch` block (line 300) which returns `toolError()`. No additional error handling needed.

#### 2. Add profile param and expansion to `list_project_items`
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`

**Import** (add after existing imports, around line 22):
```typescript
import { expandProfile } from "../lib/filter-profiles.js";
```

**Zod schema** (add after `number` param, before `workflowState`, around line 395):
```typescript
profile: z
  .string()
  .optional()
  .describe(
    "Named filter profile (e.g., 'analyst-triage', 'builder-active'). " +
    "Profile filters are defaults; explicit params override them.",
  ),
```

**Handler expansion** (add at top of handler, line 433, before `const owner = args.owner || ...`):
```typescript
// Expand profile into filter defaults (explicit args override)
if (args.profile) {
  const profileFilters = expandProfile(args.profile);
  for (const [key, value] of Object.entries(profileFilters)) {
    if (args[key as keyof typeof args] === undefined) {
      (args as Record<string, unknown>)[key] = value;
    }
  }
}
```

#### 3. Add structural tests for `list_issues` profile param
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/issue-tools.test.ts`
**Where**: After the existing `list_issues structural` describe block (after line 52)

```typescript
describe("list_issues profile param", () => {
  it("has profile param in Zod schema", () => {
    expect(issueToolsSrc).toContain("profile: z");
  });

  it("imports expandProfile from filter-profiles", () => {
    expect(issueToolsSrc).toContain(
      'import { expandProfile } from "../lib/filter-profiles.js"',
    );
  });

  it("calls expandProfile when profile is set", () => {
    expect(issueToolsSrc).toContain("expandProfile(args.profile)");
  });

  it("explicit args override profile defaults", () => {
    expect(issueToolsSrc).toContain("=== undefined");
  });
});
```

#### 4. Add structural tests for `list_project_items` profile param
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-tools.test.ts`
**Where**: After the existing `list_project_items structural` describe block (after line 45)

```typescript
describe("list_project_items profile param", () => {
  it("has profile param in Zod schema", () => {
    expect(projectToolsSrc).toContain("profile: z");
  });

  it("imports expandProfile from filter-profiles", () => {
    expect(projectToolsSrc).toContain(
      'import { expandProfile } from "../lib/filter-profiles.js"',
    );
  });

  it("calls expandProfile when profile is set", () => {
    expect(projectToolsSrc).toContain("expandProfile(args.profile)");
  });
});
```

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/issue-tools.test.ts`
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/project-tools.test.ts`
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build`
- [ ] Manual: calling `list_issues(profile="analyst-triage")` expands to `workflowState: "Backlog"`
- [ ] Manual: calling `list_issues(profile="analyst-triage", workflowState="Research Needed")` uses explicit `workflowState` override
- [ ] Manual: calling `list_issues(profile="invalid")` returns `toolError` with valid profile names

---

## File Ownership Summary

| File | Action | Lines Changed |
|------|--------|---------------|
| `src/tools/issue-tools.ts` | Add import + Zod param + merge block | ~12 |
| `src/tools/project-tools.ts` | Add import + Zod param + merge block | ~12 |
| `src/__tests__/issue-tools.test.ts` | Add structural test describe block | ~16 |
| `src/__tests__/project-tools.test.ts` | Add structural test describe block | ~12 |

## Integration Testing
- [ ] `npm run build` succeeds (TypeScript compiles without errors)
- [ ] `npm test` passes all existing and new tests
- [ ] Profile expansion is a no-op when `profile` param is omitted (backwards compatible)
- [ ] Invalid profile name returns a `toolError` with list of valid profile names

## References
- Research: thoughts/shared/research/2026-02-20-GH-0149-profile-param-list-tools.md
- Group plan: thoughts/shared/plans/2026-02-20-group-GH-147-filter-profile-registry-and-wiring.md
- Parent: https://github.com/cdubiel08/ralph-hero/issues/109
- Dependency: https://github.com/cdubiel08/ralph-hero/issues/147
