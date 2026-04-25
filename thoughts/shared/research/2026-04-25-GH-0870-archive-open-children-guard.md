---
date: 2026-04-25
github_issue: 870
github_url: https://github.com/cdubiel08/ralph-hero/issues/870
status: complete
type: research
tags: [ralph-hygiene, archive, sub-issues, hygiene-ts, bug]
---

# Add sub-issue open-children guard to findArchiveCandidates()

## Prior Work

- builds_on:: [[2026-04-25-GH-0572-ralph-hygiene-audit]]
- tensions:: None identified.

## Problem Statement

`findArchiveCandidates()` in `hygiene.ts` identifies archive candidates by age alone — Done/Canceled items older than `archiveDays` are returned regardless of whether they are parent issues with open sub-issues. A parent with in-progress children can be incorrectly surfaced as an archive candidate even though work is still active under it.

`DashboardItem.subIssueCount` has been reliably populated since GH-868 (Done/CLOSED). The fix is a single predicate addition inside the existing `.filter()` callback.

## Current State Analysis

### `findArchiveCandidates()` — the gap

`plugin/ralph-hero/mcp-server/src/lib/hygiene.ts` lines 94–107:

```ts
export function findArchiveCandidates(
  items: DashboardItem[],
  now: number,
  archiveDays: number,
): HygieneItem[] {
  return items
    .filter((item) => {
      const ws = item.workflowState;
      if (!ws || !TERMINAL_STATES.includes(ws)) return false;
      const ts = item.closedAt ?? item.updatedAt;
      return ageDays(ts, now) > archiveDays;
    })
    .map((item) => toHygieneItem(item, now));
}
```

The filter has exactly two guards:
1. Must be in a terminal state (Done or Canceled).
2. Must be older than `archiveDays` (using `closedAt ?? updatedAt`).

There is no check for sub-issues. A parent issue closed weeks ago that still has open children will pass both guards and be returned as an archive candidate.

### `DashboardItem.subIssueCount` — confirmed available

`plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` line 40:
```ts
subIssueCount: number;
```

Populated in `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` line 194:
```ts
subIssueCount: r.content.subIssues?.totalCount ?? 0,
```

The GraphQL field `subIssues { totalCount }` is queried (dashboard-tools.ts line 234) and defaults to `0` when absent. This field is reliable (GH-868 verified).

`DashboardItem` does NOT carry a `subIssuesSummary.completed` breakdown — only the raw count. The guard must use `subIssueCount > 0` (any children → skip) rather than a completed-vs-total comparison.

### SKILL.md limitation note

`plugin/ralph-hero/skills/ralph-hygiene/SKILL.md` line 138 contains the note:

> Archive confidence is timestamp-only — items with open PRs, open sub-issues, or recent comments are not currently filtered out by `findArchiveCandidates()`. Sub-issue guard is a follow-up — see future ticket.

This note was written during the GH-572 audit (prior research document). After this fix lands, the sub-issue portion of this sentence should be removed or the sentence revised to reflect only the remaining limitations (open PRs, recent comments).

### Test factory gap

`plugin/ralph-hero/mcp-server/src/__tests__/hygiene.test.ts` lines 28–41 — the `makeItem()` factory does NOT include `subIssueCount` in its default fields:

```ts
function makeItem(overrides: Partial<DashboardItem> = {}): DashboardItem {
  return {
    number: 1,
    title: "Test issue",
    updatedAt: new Date(NOW - 1 * HOUR_MS).toISOString(),
    closedAt: null,
    workflowState: "Backlog",
    priority: null,
    estimate: null,
    assignees: [],
    blockedBy: [],
    ...overrides,
  };
}
```

Contrast with `dashboard.test.ts` line 48 where `subIssueCount: 0` is included in defaults. TypeScript does not catch this gap at compile time because `overrides` is `Partial<DashboardItem>` and the spread means the field will be `undefined` unless explicitly set — which evaluates to falsy. The guard `item.subIssueCount > 0` would still work correctly with `undefined` (undefined > 0 is false), but the factory should be updated for correctness and consistency.

### No changelog file

No `CHANGELOG.md` exists in the project. The issue's "add changelog entry" requirement is met by a conventional commit message (`fix(hygiene): skip archive candidates with open sub-issues`). The auto-release workflow in CLAUDE.md picks up semantic prefixes automatically.

## Key Discoveries

### Discovery 1: One-line guard, no schema change

The fix is minimal:
```ts
if (item.subIssueCount > 0) return false;
```
Added inside `findArchiveCandidates()`'s `.filter()` callback before the age check. No new imports, no new types, no changes to `DashboardItem`.

### Discovery 2: Guard semantics — "any children → skip"

Because `DashboardItem` only carries `subIssueCount` (not a per-state breakdown), the guard cannot distinguish "parent with all-Done children" from "parent with open children." The issue body and triage comment both acknowledge this and confirm that `subIssueCount > 0` is the correct and safe choice: the false-positive cost (skipping an archive-eligible all-done parent) is far lower than the false-negative cost (incorrectly archiving an in-progress parent).

Parents with only Done/Canceled children are edge cases — normally the parent itself closes when all children are done, and the parent's own `closedAt` reflects the correct timestamp. Skipping such parents for an extra archive cycle is an acceptable trade-off.

### Discovery 3: Factory update needed in hygiene.test.ts

The `makeItem()` in `hygiene.test.ts` is missing `subIssueCount: 0`. This does not break existing tests (undefined is falsy), but it creates inconsistency with `dashboard.test.ts` and could mask a bug where a test accidentally depends on `undefined` rather than `0`. Add `subIssueCount: 0` to the factory defaults as part of this PR.

### Discovery 4: Two new unit tests needed

1. **Parent with open children → excluded**: `makeItem({ workflowState: "Done", closedAt: <20 days ago>, subIssueCount: 1 })` → `findArchiveCandidates` returns empty array.
2. **Parent with all-done children (subIssueCount: 0) → still eligible**: `makeItem({ workflowState: "Done", closedAt: <20 days ago>, subIssueCount: 0 })` → `findArchiveCandidates` returns the item.

### Discovery 5: SKILL.md note update is a text edit only

Line 138 of `SKILL.md` needs one of:
- Remove the sub-issue clause: "Archive confidence is timestamp-only — items with open PRs or recent comments are not currently filtered out by `findArchiveCandidates()`."
- Or annotate as resolved: "~~open sub-issues~~" if markdown strikethrough is preferred.

The rest of the constraints section is unaffected.

## Potential Approaches

### Approach A: Minimal guard with `subIssueCount > 0` (recommended)

Add `if (item.subIssueCount > 0) return false;` as first guard in `findArchiveCandidates()`.

**Pros**: Simplest possible change. Consistent with how `subIssueCount` is already used in `dashboard.ts:413` (oversized-in-pipeline detection skips `subIssueCount === 0` cases). One-line diff in the lib, two tests, one factory line, one SKILL.md edit.

**Cons**: Over-skips parents where all children are Done but `subIssueCount` is still non-zero (the field reflects total children, not open children). This is an accepted trade-off per the triage comment.

### Approach B: Future — subIssuesSummary.completed breakdown

If `DashboardItem` is extended in a future issue to carry `subIssuesSummary: { completed: number; total: number }`, the guard could be refined to `item.subIssuesSummary.completed < item.subIssuesSummary.total`. This is outside the scope of #870.

## Risks

- **Low**: The change only affects archive candidate selection, not any mutation path. `project_hygiene` is a read-only reporting tool; the `archive_items` tool consumes hygiene output separately.
- **Low**: The `subIssueCount > 0` guard is a strict superset exclusion — it can only reduce the archive candidate list, never add items. No regressions possible on existing test cases that have `subIssueCount: 0` (explicitly or via undefined default).
- **None**: No schema changes, no new imports, no API changes.

## Recommended Next Steps

1. Add `subIssueCount: 0` to `makeItem()` defaults in `hygiene.test.ts`.
2. Add guard `if (item.subIssueCount > 0) return false;` to `findArchiveCandidates()` in `hygiene.ts` (before the age check).
3. Add two unit tests:
   - `parent with open children (subIssueCount: 1) is NOT returned as archive candidate`
   - `parent with no children (subIssueCount: 0) that meets age criteria IS returned`
4. Update `SKILL.md` line 138: remove "open sub-issues" from the limitation note.
5. Commit with `fix(hygiene): skip archive candidates with open sub-issues (#870)`.

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/lib/hygiene.ts` - Add `subIssueCount > 0` guard in `findArchiveCandidates()`
- `plugin/ralph-hero/mcp-server/src/__tests__/hygiene.test.ts` - Add `subIssueCount: 0` to `makeItem()` defaults; add 2 unit tests for the guard
- `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md` - Remove sub-issue clause from the archive confidence limitation note (line 138)

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` - `DashboardItem` type definition (line 31-49)
- `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` - `subIssueCount` population from GraphQL (line 194)
- `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts` - `TERMINAL_STATES` constant used by `findArchiveCandidates()`
