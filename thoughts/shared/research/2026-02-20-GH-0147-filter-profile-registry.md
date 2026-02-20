---
date: 2026-02-20
github_issue: 147
github_url: https://github.com/cdubiel08/ralph-hero/issues/147
status: complete
type: research
---

# GH-147: Define Filter Profile Registry and Expansion Logic

## Problem Statement

Each Ralph agent role (analyst, builder, validator, integrator) repeatedly specifies the same filter combinations when calling `list_issues` or `list_project_items`. These repeated filter params waste context window tokens and introduce copy-paste errors. GH-147 asks for a centralized registry of named filter profiles that map to concrete filter parameter objects, plus an `expandProfile()` function that returns the filter params for a given profile name.

## Current State Analysis

### How agents currently filter issues

Skills currently hardcode filter params inline:

- `ralph-research/SKILL.md` calls `list_issues(workflowState="Research Needed", limit=50)`
- `ralph-plan/SKILL.md` calls `list_issues(workflowState="Ready for Plan", limit=50)`
- `ralph-triage/SKILL.md` calls `list_issues(workflowState="Backlog")` (multiple variants)
- `ralph-impl/SKILL.md` calls `list_issues` with various workflow state filters
- `ralph-review/SKILL.md` calls `list_issues` to find review items

### Existing filter parameters on `list_issues`

From `issue-tools.ts:50-111`, `list_issues` accepts:
- `workflowState` (string, single value)
- `estimate` (string: XS, S, M, L, XL)
- `priority` (string: P0, P1, P2, P3)
- `label` (string, single value)
- `query` (string, substring search)
- `state` (OPEN/CLOSED, default OPEN)
- `reason` (completed/not_planned/reopened)
- `updatedSince` / `updatedBefore` (date-math strings)
- `orderBy` (CREATED_AT/UPDATED_AT/COMMENTS)
- `limit` (number, default 50)

### Existing filter parameters on `list_project_items`

From `project-tools.ts:382-431`, `list_project_items` accepts:
- `workflowState` (string)
- `estimate` (string)
- `priority` (string)
- `itemType` (ISSUE/PULL_REQUEST/DRAFT_ISSUE)
- `updatedSince` / `updatedBefore` (date-math)
- `limit` (number, default 50)

### Missing filter features (dependencies)

Some profiles in the issue spec depend on not-yet-implemented features:
- `analyst-triage` wants `no:estimate` -- requires GH-141 (has/no presence filters)
- `validator-review` wants multi-value `workflowState` (e.g., "Plan in Review" OR "In Review") -- not currently supported
- `stale` profile wants `-workflowState:Done` negation -- requires GH-142 (exclude filters)
- `integrator-merge` wants "has linked PR" -- no current support for this

## Key Discoveries

### 1. Profile type must be a partial of list tool filter params

The expansion function should return a `Partial<FilterParams>` where `FilterParams` is a union/intersection of the filter params accepted by both `list_issues` and `list_project_items`. The two tools share most filter params but `list_issues` has extras (`label`, `query`, `state`, `reason`, `orderBy`), and `list_project_items` has `itemType`.

**Recommendation**: Define the profile filter type as the intersection of common params, plus optional tool-specific params. The expansion function returns whatever params the profile needs; the calling tool ignores params it doesn't support.

### 2. Existing pattern to follow: `state-resolution.ts`

The state resolution module (`lib/state-resolution.ts:12-29`) provides an excellent pattern:
- A const record mapping names to structured data (`SEMANTIC_INTENTS`)
- A public function that resolves a name to a result (`resolveState`)
- Error messages listing valid options for recovery
- Exported for unit testing

The filter profiles module should follow this same pattern: a `FILTER_PROFILES` const record, an `expandProfile()` function, and clear error messages.

### 3. Profile definitions from the issue spec

| Profile | Filters | Notes |
|---------|---------|-------|
| `analyst-triage` | `workflowState: "Backlog"` | Full version needs `no:estimate` from GH-141 |
| `analyst-research` | `workflowState: "Research Needed"` | Straightforward |
| `builder-active` | `workflowState: "In Progress"` | Straightforward |
| `builder-planned` | `workflowState: "Plan in Review"` | Full version may want "approved" flag |
| `validator-review` | `workflowState: "Plan in Review"` | Full version needs multi-value workflowState for "Plan in Review" OR "In Review" |
| `integrator-merge` | `workflowState: "In Review"` | Full version needs "has linked PR" check |

### 4. Merge semantics: explicit args override profile defaults

The issue specifies: "Explicit args override profile defaults." This means `expandProfile` returns a base object, and the caller merges explicit args on top using spread: `{ ...profileFilters, ...explicitArgs }`. This is a simple, predictable pattern.

### 5. File placement follows existing lib/ convention

The issue specifies `plugin/ralph-hero/mcp-server/src/lib/filter-profiles.ts` for the implementation and `src/__tests__/filter-profiles.test.ts` for tests. This aligns with the existing convention where pure logic modules live in `lib/` (e.g., `workflow-states.ts`, `state-resolution.ts`, `date-math.ts`).

### 6. The type for filter params should be defined in the new module

Rather than importing from tool files (which would create a circular dependency), the filter profile types should be self-contained in `filter-profiles.ts`. The profile type needs only the keys that profiles actually use. It can be expanded later as new filter features land.

## Potential Approaches

### Approach A: Simple const record + function (Recommended)

```typescript
// Type for filter params that profiles can set
interface ProfileFilterParams {
  workflowState?: string;
  estimate?: string;
  priority?: string;
  state?: "OPEN" | "CLOSED";
  limit?: number;
  // Future: has?, no?, excludeWorkflowStates?, etc.
}

// Registry
const FILTER_PROFILES: Record<string, ProfileFilterParams> = {
  "analyst-triage": { workflowState: "Backlog" },
  "analyst-research": { workflowState: "Research Needed" },
  // ...
};

// Expansion
function expandProfile(name: string): ProfileFilterParams { ... }
```

**Pros**: Simple, typesafe, follows existing patterns (state-resolution.ts). Easy to test.
**Cons**: No runtime extensibility (profiles are compile-time constants). This is fine for this use case.

### Approach B: Profile class with validation

Define a class that validates profile names and can compose profiles. Overkill for 6 static profiles.

### Approach C: Profile definitions in YAML/JSON

External config file. Too complex, no existing precedent in the codebase.

## Risks and Edge Cases

1. **Multi-value workflowState not supported yet**: The `validator-review` profile wants both "Plan in Review" and "In Review". Current `list_issues` only accepts a single string. The profile should document this limitation with a TODO comment referencing the dependency.

2. **Profiles that depend on unimplemented features**: `analyst-triage` wants `no:estimate` (GH-141), `stale` wants negation (GH-142). These should be defined with the currently-possible filters and TODO comments noting the future enhancement.

3. **Profile name collisions**: Use kebab-case with role prefix to avoid collisions. The 6 profiles defined in the spec all follow `role-purpose` naming.

4. **Type safety for merge**: When expanding a profile and merging with explicit args, TypeScript's spread operator handles this naturally. No special handling needed.

## Recommended Next Steps

1. Create `src/lib/filter-profiles.ts` with:
   - `ProfileFilterParams` interface
   - `FILTER_PROFILES` const record
   - `expandProfile(name: string)` function with error handling
   - `VALID_PROFILE_NAMES` export for documentation/error messages
   - TODO comments on profiles that need future filter features

2. Create `src/__tests__/filter-profiles.test.ts` with:
   - Test each profile mapping returns expected filter params
   - Test unknown profile name returns descriptive error
   - Test profile expansion merging with explicit args
   - Test that all profiles reference valid workflow states (cross-check with `VALID_STATES`)

3. This is a pure library module with no dependencies on MCP server or GitHub client. It can be implemented and tested independently.

## Group Context

This is issue 1 of 3 under parent #109 (Pre-canned agent filter profiles):
- **#147** (this): Define registry and expansion logic (S) -- foundational
- **#149**: Add `profile` param to list tools (XS) -- depends on #147
- **#148**: Document filter profiles in agent skill files (XS) -- independent

#147 must be completed before #149 can wire profiles into the list tools.
