---
date: 2026-04-25
status: draft
type: plan
github_issue: 870
github_issues: [870]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/870
primary_issue: 870
tags: [ralph-hygiene, archive, sub-issues, hygiene-ts, bug]
---

# Archive open-children guard for findArchiveCandidates() - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-25-GH-0870-archive-open-children-guard]]
- builds_on:: [[2026-04-25-GH-0572-ralph-hygiene-audit]]
- tensions:: None identified.

## Overview

Single XS issue implemented in one phase, single PR.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-870 | Add sub-issue open-children guard to findArchiveCandidates() | XS |

## Shared Constraints

- Source layer: `plugin/ralph-hero/mcp-server/` — TypeScript ESM, strict mode, vitest, tsc as the linter
- All internal imports must use `.js` extensions (project uses `"type": "module"` with `"module": "NodeNext"`)
- No new dependencies, no new types, no new exports — this is a one-line behavioral change in an existing pure function
- No `CHANGELOG.md` exists; the conventional commit message satisfies the changelog requirement (auto-release workflow consumes semantic prefixes)
- Test fixtures use the `makeItem()` factory in `hygiene.test.ts` — keep parity with the equivalent factory in `dashboard.test.ts` (which already includes `subIssueCount: 0`)
- The guard semantics are deliberately coarse: any `subIssueCount > 0` excludes the parent. The triage comment and research doc both confirm this is the correct trade-off — false positives (skipping an all-done parent) are far cheaper than false negatives (archiving an in-progress parent)
- Tests must remain pure (no I/O, no mocking) — `findArchiveCandidates()` is a pure function

## Current State Analysis

`findArchiveCandidates()` in [`plugin/ralph-hero/mcp-server/src/lib/hygiene.ts:94-107`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/hygiene.ts#L94-L107) decides archive eligibility with two guards: terminal workflow state and age. There is no check for sub-issues. A parent issue closed weeks ago that still has open children passes both guards and is incorrectly returned as an archive candidate.

`DashboardItem.subIssueCount` (defined at [`dashboard.ts:40`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L40)) is reliably populated from the GraphQL `subIssues { totalCount }` field at [`dashboard-tools.ts:194`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts#L194). GH-868 (Done) verified this field is non-zero for parents.

The `makeItem()` factory in [`hygiene.test.ts:28-41`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/hygiene.test.ts#L28-L41) is missing `subIssueCount: 0` from defaults — inconsistent with `dashboard.test.ts:48`. Existing tests still pass because `undefined > 0` evaluates falsy, but the inconsistency could mask future bugs.

The ralph-hygiene SKILL.md at [`SKILL.md:138`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-hygiene/SKILL.md#L138) documents the gap as a known limitation that becomes stale once the guard lands.

## Desired End State

### Verification

- [ ] `findArchiveCandidates()` skips items where `subIssueCount > 0` regardless of age/terminal state
- [ ] `makeItem()` factory in `hygiene.test.ts` includes `subIssueCount: 0` in defaults
- [ ] New unit test asserts a parent with open children (`subIssueCount: 1`) is excluded
- [ ] New unit test asserts a parent with no children (`subIssueCount: 0`) meeting age criteria is still included
- [ ] All existing `hygiene.test.ts` tests continue to pass with no modifications
- [ ] SKILL.md limitation note no longer mentions "open sub-issues" as an unfiltered case
- [ ] `npm run build` and `npm test` pass from `plugin/ralph-hero/mcp-server/`

## What We're NOT Doing

- Not extending `DashboardItem` with `subIssuesSummary.completed`/`total` breakdown (Approach B in research — out of scope)
- Not refining the guard to distinguish all-done children from open children (accepted trade-off)
- Not adding guards for open PRs or recent comments (those remain in the SKILL.md limitation note)
- Not modifying `findStaleItems()`, `findOrphanedItems()`, or any other hygiene functions
- Not modifying `archive_items` consumer logic — it reads `findArchiveCandidates()` output unchanged
- Not adding a new CHANGELOG.md file — conventional commit message satisfies the changelog requirement

## Implementation Approach

One phase. Three file edits in a single PR:

1. Update test factory defaults so test data is internally consistent
2. Add a one-line guard in the production filter
3. Add two regression tests directly under `describe("findArchiveCandidates")`
4. Edit one stale sentence in SKILL.md

The order within the phase keeps the test factory update first so the new tests can rely on the guaranteed default. Production change comes next so tests fail until the guard is added (TDD-friendly even though we're not strictly red-then-green).

---

## Phase 1: GH-870 — Add sub-issue open-children guard
- **depends_on**: null

### Overview

Add a `subIssueCount > 0` guard to `findArchiveCandidates()` so parent issues with any sub-issues are excluded from archive candidacy regardless of age. Update the test factory for consistency, add two regression tests, and refresh the SKILL.md limitation note.

### Tasks

#### Task 1.1: Add `subIssueCount: 0` default to `makeItem()` factory in hygiene.test.ts
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/hygiene.test.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `makeItem()` returns an object with `subIssueCount: 0` when no override provided
  - [ ] Field is inserted alphabetically/structurally between `assignees: []` and `blockedBy: []` (or append before spread — matches existing factory style)
  - [ ] All existing tests still pass after this change

#### Task 1.2: Add `subIssueCount > 0` guard to `findArchiveCandidates()` in hygiene.ts
- **files**: `plugin/ralph-hero/mcp-server/src/lib/hygiene.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] New filter line `if (item.subIssueCount > 0) return false;` added inside the `.filter()` callback in `findArchiveCandidates()` (around line 100-101)
  - [ ] Guard fires before the terminal-state check OR before the age check — order does not affect semantics, but place it as the first predicate so it short-circuits before timestamp parsing for performance and readability
  - [ ] No other behavior changed in `findArchiveCandidates()` — only the new guard line is added
  - [ ] No new imports added
  - [ ] `findStaleItems`, `findOrphanedItems`, `findFieldGaps`, `findWipViolations`, `findDuplicateCandidates`, and `buildHygieneReport` are NOT modified

#### Task 1.3: Add two unit tests for the new guard
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/hygiene.test.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - [ ] New test "excludes Done parents with open children" inside `describe("findArchiveCandidates")`: creates a `Done` item with `closedAt: NOW - 20*DAY_MS` and `subIssueCount: 1`, calls `findArchiveCandidates(items, NOW, 14)`, asserts result has length 0
  - [ ] New test "includes Done parents with no children when age criteria met" inside the same describe: creates a `Done` item with `closedAt: NOW - 20*DAY_MS` and `subIssueCount: 0` (explicit), asserts result has length 1
  - [ ] Both tests use the existing `makeItem()` factory and existing `NOW`, `DAY_MS` constants
  - [ ] Tests pass when Task 1.2 guard is in place
  - [ ] If guard is removed/reverted, the "excludes ... open children" test fails — confirming it is a real regression test for the new behavior

#### Task 1.4: Update ralph-hygiene SKILL.md limitation note
- **files**: `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Line 138's sentence revised to remove the "open sub-issues" clause AND the "Sub-issue guard is a follow-up — see future ticket" trailing sentence
  - [ ] Suggested replacement: `Archive confidence is timestamp-only — items with open PRs or recent comments are not currently filtered out by `+ "`findArchiveCandidates()`" + `.`
  - [ ] Sub-issue limitation references (if any other appear in the file) are similarly cleaned up — search for "sub-issue" in SKILL.md and remove or rewrite stale references
  - [ ] No other constraints lines modified

### Phase Success Criteria

#### Automated Verification:
- [x] `cd plugin/ralph-hero/mcp-server && npm run build` — no TypeScript errors
- [x] `cd plugin/ralph-hero/mcp-server && npm test` — all tests pass, including the two new ones
- [x] `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/hygiene.test.ts` — focused suite passes

#### Manual Verification:
- [ ] Diff review confirms only the four targeted files changed (`hygiene.ts`, `hygiene.test.ts`, `SKILL.md`, plus auto-format if any) and the change in `hygiene.ts` is exactly the one-line guard
- [ ] SKILL.md text reads coherently after edit (no orphaned "follow-up" sentence)
- [ ] Commit message uses `fix(hygiene): skip archive candidates with open sub-issues (#870)` — semantic prefix triggers patch release

**Creates for next phase**: N/A (single-phase plan)

---

## Integration Testing

This is a pure-function change with no integration surface. The `archive_items` tool that consumes `findArchiveCandidates()` output continues to work unchanged because the function still returns `HygieneItem[]` — just with the parent-with-open-children rows omitted. No end-to-end tests required beyond the two new unit tests.

- [ ] Optional sanity check: run `pipeline_dashboard` or `project_hygiene` against the live project after merge and confirm parents with open children no longer appear under "Archive Candidates"

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/870
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/847
- Sibling (independent): https://github.com/cdubiel08/ralph-hero/issues/869
- Dependency (Done): https://github.com/cdubiel08/ralph-hero/issues/868
- Research: [thoughts/shared/research/2026-04-25-GH-0870-archive-open-children-guard.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-25-GH-0870-archive-open-children-guard.md)
- Source PR (introduced gap): https://github.com/cdubiel08/ralph-hero/pull/844
- Hygiene audit context: [thoughts/shared/research/2026-04-25-GH-0572-ralph-hygiene-audit.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-25-GH-0572-ralph-hygiene-audit.md)
