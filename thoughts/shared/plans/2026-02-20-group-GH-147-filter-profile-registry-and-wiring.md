---
date: 2026-02-20
status: draft
github_issues: [147, 149]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/147
  - https://github.com/cdubiel08/ralph-hero/issues/149
primary_issue: 147
---

# Filter Profile Registry and List Tool Wiring - Atomic Implementation Plan

## Overview
2 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-147 | Define filter profile registry and expansion logic | S |
| 2 | GH-149 | Add `profile` param to list tools | XS |

**Why grouped**: GH-149 has a hard dependency on GH-147 (imports `expandProfile` from the registry module). Both are part of the #109 parent (Pre-canned agent filter profiles). Implementing together avoids a broken intermediate state where the registry exists but isn't wired in.

## Current State Analysis

- Agents hardcode filter params inline in skill files (e.g., `workflowState: "Backlog"`)
- `list_issues` (`issue-tools.ts:50-111`) accepts 11 filter params via Zod schema
- `list_project_items` (`project-tools.ts:382-431`) accepts 8 filter params via Zod schema
- Both tools use client-side `Array.filter()` chains after fetching data
- Pure library modules live in `src/lib/` following the `state-resolution.ts` pattern: const record + public function + error messages + exports
- Tests follow the vitest pattern with direct imports from `../lib/*.js`
- Structural source-code tests are used for tool-level assertions (reading source as string)

## Desired End State
### Verification
- [ ] `FILTER_PROFILES` constant maps 6 profile names to `ProfileFilterParams` objects
- [ ] `expandProfile(name)` returns filter params for valid names, throws for invalid
- [ ] `list_issues` and `list_project_items` accept optional `profile` string param
- [ ] Profile filters apply as defaults; explicit args override them
- [ ] All tests pass: `npm test` in `mcp-server/`
- [ ] Build succeeds: `npm run build` in `mcp-server/`

## What We're NOT Doing
- Implementing `has`/`no` presence filters (GH-141) -- profiles that need these get TODO comments
- Implementing multi-value `workflowState` support -- `validator-review` uses single-value approximation
- Implementing negation filters (GH-142) -- future enhancement
- Updating agent skill SKILL.md files (GH-148, separate issue in Backlog)
- Adding runtime profile extensibility -- profiles are compile-time constants

## Implementation Approach
Phase 1 creates the pure library module (`filter-profiles.ts`) with the profile registry and expansion function. Phase 2 wires it into the two list tools by adding a `profile` Zod param and calling `expandProfile()` at handler entry. The merge semantics are simple: iterate profile keys, only set if `args[key]` is `undefined`.

---

## Phase 1: GH-147 - Define filter profile registry and expansion logic
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/147 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0147-filter-profile-registry.md

### Changes Required

#### 1. Create filter profiles module
**File**: `plugin/ralph-hero/mcp-server/src/lib/filter-profiles.ts` (NEW)
**Changes**:
- Define `ProfileFilterParams` interface with optional fields: `workflowState`, `estimate`, `priority`, `state`, `limit` (the common filter params across both list tools)
- Define `FILTER_PROFILES` as `Record<string, ProfileFilterParams>` with 6 profiles:
  - `analyst-triage`: `{ workflowState: "Backlog" }` (TODO: add `no: "estimate"` when GH-141 lands)
  - `analyst-research`: `{ workflowState: "Research Needed" }`
  - `builder-active`: `{ workflowState: "In Progress" }`
  - `builder-planned`: `{ workflowState: "Plan in Review" }`
  - `validator-review`: `{ workflowState: "Plan in Review" }` (TODO: multi-value for "Plan in Review" OR "In Review" when supported)
  - `integrator-merge`: `{ workflowState: "In Review" }`
- Define `VALID_PROFILE_NAMES` as `Object.keys(FILTER_PROFILES)`
- Implement `expandProfile(name: string): ProfileFilterParams` that:
  - Returns a shallow copy of `FILTER_PROFILES[name]` if it exists
  - Throws an `Error` with message listing valid profile names if not found
- Export: `ProfileFilterParams`, `FILTER_PROFILES`, `VALID_PROFILE_NAMES`, `expandProfile`
- Follow the `state-resolution.ts` pattern: const record at top, helpers, public API, exports at bottom

#### 2. Create filter profiles tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/filter-profiles.test.ts` (NEW)
**Changes**:
- Import `expandProfile`, `FILTER_PROFILES`, `VALID_PROFILE_NAMES` from `../lib/filter-profiles.js`
- Import `VALID_STATES` from `../lib/workflow-states.js` for cross-validation
- Test each profile returns expected filter params (6 individual assertions)
- Test `expandProfile` returns a copy (not the same reference) to prevent mutation
- Test unknown profile name throws with descriptive error containing valid names
- Test all profile `workflowState` values exist in `VALID_STATES` (cross-check)
- Test `VALID_PROFILE_NAMES` contains all 6 expected names

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/filter-profiles.test.ts`
- [ ] Manual: `FILTER_PROFILES` contains exactly 6 profiles with correct workflow states

**Creates for next phase**: `expandProfile` function and `ProfileFilterParams` type imported by Phase 2.

---

## Phase 2: GH-149 - Add `profile` param to list tools
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/149 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0149-profile-param-list-tools.md | **Depends on**: Phase 1

### Changes Required

#### 1. Add profile param to `list_issues`
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**:
- Add import at top: `import { expandProfile } from "../lib/filter-profiles.js";`
- Add `profile` param to Zod schema (after `repo`, before `workflowState`, around line 63):
  ```
  profile: z.string().optional().describe("Named filter profile (e.g., 'analyst-triage', 'builder-active'). Profile filters are defaults; explicit params override them.")
  ```
- Add expansion logic at top of handler (line 113, before `resolveFullConfig`):
  ```
  if (args.profile) {
    const profileFilters = expandProfile(args.profile);
    for (const [key, value] of Object.entries(profileFilters)) {
      if (args[key as keyof typeof args] === undefined) {
        (args as Record<string, unknown>)[key] = value;
      }
    }
  }
  ```

#### 2. Add profile param to `list_project_items`
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`
**Changes**:
- Add import at top: `import { expandProfile } from "../lib/filter-profiles.js";`
- Add `profile` param to Zod schema (after `number`, before `workflowState`, around line 395):
  ```
  profile: z.string().optional().describe("Named filter profile (e.g., 'analyst-triage', 'builder-active'). Profile filters are defaults; explicit params override them.")
  ```
- Add expansion logic at top of handler (line 433, before config resolution):
  ```
  if (args.profile) {
    const profileFilters = expandProfile(args.profile);
    for (const [key, value] of Object.entries(profileFilters)) {
      if (args[key as keyof typeof args] === undefined) {
        (args as Record<string, unknown>)[key] = value;
      }
    }
  }
  ```

#### 3. Add structural tests for profile wiring
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/issue-tools.test.ts`
**Changes**: Add a `describe("list_issues profile param")` block with structural assertions:
- Source contains `profile: z` (Zod param)
- Source contains `import { expandProfile } from "../lib/filter-profiles.js"`
- Source contains `expandProfile(args.profile)` (expansion call)
- Source contains `=== undefined` (override semantics check)

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-tools.test.ts`
**Changes**: Add a `describe("list_project_items profile param")` block with structural assertions:
- Source contains `profile: z` (Zod param)
- Source contains `import { expandProfile } from "../lib/filter-profiles.js"`
- Source contains `expandProfile(args.profile)` (expansion call)

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npx vitest run`
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build`
- [ ] Manual: calling `list_issues(profile="analyst-triage")` expands to `workflowState: "Backlog"`
- [ ] Manual: calling `list_issues(profile="analyst-triage", workflowState="Research Needed")` uses explicit `workflowState` override

**Creates for next phase**: N/A (final phase)

---

## Integration Testing
- [ ] `npm run build` succeeds (TypeScript compiles without errors)
- [ ] `npm test` passes all existing and new tests
- [ ] Profile expansion is a no-op when `profile` param is omitted (backwards compatible)
- [ ] Invalid profile name returns a `toolError` with list of valid profile names
- [ ] All 6 profile workflow states are valid per `VALID_STATES` cross-check

## References
- Research GH-147: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0147-filter-profile-registry.md
- Research GH-149: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0149-profile-param-list-tools.md
- Pattern: [state-resolution.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts) (const record + function + exports)
- Pattern: [workflow-states.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts) (STATE_ORDER, VALID_STATES constants)
- Parent: https://github.com/cdubiel08/ralph-hero/issues/109
