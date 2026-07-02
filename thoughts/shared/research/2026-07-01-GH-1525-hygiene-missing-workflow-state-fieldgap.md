---
date: 2026-07-01
github_issue: 1525
github_url: https://github.com/cdubiel08/ralph-hero/issues/1525
topic: "Add missingWorkflowState to project_hygiene fieldGaps"
tags: [research, hygiene, mcp-tools, workflow-state, field-gaps]
status: complete
type: research
---

# Research: Add `missingWorkflowState` to `project_hygiene` fieldGaps

## Prior Work

- builds_on:: [[2026-07-01-GH-1524-create-issue-workflow-state-default]] (research — primary evidence; GH-1525 is the belt-and-braces net for the same incident, catching UI/automation-created stateless items the tool default can't)
- builds_on:: [[2026-05-06-group-GH-1085-hygiene-multi-repo]] (plan — introduced `HygieneRepoBreakdown` + per-repo renderer sections this fix must extend in parallel with the top-level)
- builds_on:: [[2026-02-21-GH-0114-project-hygiene-reporting-tool]] (research — original `project_hygiene` design; fieldGaps category origin)

## Research Question

`project_hygiene`'s fieldGaps detects missingEstimate and missingPriority only; items with a null Workflow State (added via GitHub UI, automation, or pre-fix `create_issue`) are invisible to hygiene sweeps. Extend fieldGaps with `missingWorkflowState` across collection, interfaces, summary counts, and markdown rendering (top-level and groupBy=repo).

## Summary

Confirmed, with two corrections to the issue body. The collector is `findFieldGaps` (not `computeFieldGaps`), at `mcp-server/src/lib/hygiene.ts:180-197` — it filters to non-terminal items via `!ws || !TERMINAL_STATES.includes(ws)`, which **already classifies null-state items as non-terminal** (the `!ws` short-circuit), then buckets only `estimate === null` and `priority === null`. A null-state item with estimate+priority set passes the filter and lands in no bucket — exactly the invisibility described. The fix is purely additive: a third bucket `missingWorkflowState: nonTerminal.filter(i => i.workflowState === null)`.

Second correction: `HygieneSummary` (`hygiene.ts:51-58`) has **no per-gap count fields** — the "summary count" the acceptance refers to is the renderer's `totalGaps` gate (`hygiene.ts:531-534`) and its per-repo mirror `repoTotalGaps` (`hygiene.ts:636-660`); both must include the new bucket or a board with *only* stateless items would render no Field Gaps section at all. The item shape guarantees `workflowState: string | null` (never `undefined`/`""` — `getFieldValue` returns `fv?.name ?? null`, `dashboard-fetch.ts:63-73`), so a strict `=== null` check is correct. The tool layer (`hygiene-tools.ts`) passes the report object verbatim in both JSON and markdown formats — no tool changes needed. `formatItemRow` already renders null state as an em-dash, so new table rows work unmodified.

## Detailed Findings

### The collector: `findFieldGaps` (`mcp-server/src/lib/hygiene.ts:180-197`)

```ts
export function findFieldGaps(items: DashboardItem[], now: number):
  { missingEstimate: HygieneItem[]; missingPriority: HygieneItem[] } {
  const nonTerminal = items.filter((item) => {
    const ws = item.workflowState;
    return !ws || !TERMINAL_STATES.includes(ws);
  });
  return {
    missingEstimate: nonTerminal.filter((i) => i.estimate === null).map((i) => toHygieneItem(i, now)),
    missingPriority: nonTerminal.filter((i) => i.priority === null).map((i) => toHygieneItem(i, now)),
  };
}
```

- Null-state items pass the `nonTerminal` filter (the `!ws` branch) — they reach the buckets but no bucket tests `workflowState === null`. The new bucket slots in beside the existing two.
- Called from exactly two places: `buildRepoBreakdown` (`hygiene.ts:353` → `fieldGaps` at `:378`) and `buildHygieneReport` (`hygiene.ts:407` → `fieldGaps` at `:450`). Both get the new bucket for free once the return shape is extended.
- `TERMINAL_STATES = ["Done", "Canceled"]` (`workflow-states.ts:27`). Contrast: `findArchiveCandidates` (`hygiene.ts:132-140`) uses the inverse idiom and correctly *excludes* null-state items from archive candidates.

### Item shape guarantees

- `DashboardItem.workflowState: string | null` (`dashboard.ts:42`); populated by `getFieldValue()` → `fv?.name ?? null` (`dashboard-fetch.ts:63-73`). Never `undefined`, never `""` — strict `=== null` is the consistent check (matches the estimate/priority checks).
- Upstream filtering: `toDashboardItems` keeps only `__typename === "Issue"` (`dashboard-fetch.ts:89`) — PRs/drafts never reach hygiene. No archived-state filter exists anywhere in the chain.
- `HygieneItem` (`hygiene.ts:38-44`) already carries `workflowState: string | null`, and `toHygieneItem` preserves `repository` (needed for the per-repo tests at `hygiene.test.ts:773-795`).

### Interfaces to extend

- `HygieneRepoBreakdown.fieldGaps` (`hygiene.ts:65`) and `HygieneReport.fieldGaps` (`hygiene.ts:87`) — identical inline shape `{ missingEstimate: HygieneItem[]; missingPriority: HygieneItem[] }`; both gain `missingWorkflowState: HygieneItem[]`.
- `HygieneSummary` (`hygiene.ts:51-58`) has no per-gap counts (only `fieldCoveragePercent`, a blended estimate+priority coverage metric at `hygiene.ts:420-426`). Extending `fieldCoveragePercent` semantics would be scope creep — leave untouched.

### Renderer sections to mirror

- **Top-level** (`hygiene.ts:530-554`): `totalGaps = missingEstimate.length + missingPriority.length` gates `## Field Gaps`; conditional `### Missing Estimate` / `### Missing Priority` subsections render `| Issue | Title | State | Age |` tables via `formatItemRow` (`hygiene.ts:469-471`, renders null state as `—`). Add the third term to `totalGaps` + a `### Missing Workflow State` subsection.
- **Per-repo** (`hygiene.ts:636-660`, inside `## Per-Repository Breakdown` from `:586`): same count-then-conditional pattern one heading level deeper (`#### Field Gaps`, `##### Missing …`), participating in the `renderedAny` flag. Mirror identically.

### Tool layer — no changes

`ralph_hero__project_hygiene` (`hygiene-tools.ts:41-218`) delegates entirely to `buildHygieneReport` / per-repo grouping and returns the report object verbatim in both `format: "json"` (`:209-212`) and `format: "markdown"` (`:201-207`, spreads full report + `formatted`). No fieldGap-specific params, no truncation. JSON output picks up the new bucket automatically.

### Adjacent surfaces (noted, out of scope)

- `directions.ts:846-863` already has an agent-audience fallback that includes `workflowState === null` items; the human-audience aggregate direction is GH-1526.
- `dashboard.ts` buckets null states under `"Unknown"` (`:256, :603, :680`) — the dashboard shows them; hygiene currently does not.

### Test patterns (`mcp-server/src/__tests__/hygiene.test.ts`)

- Fixture factory `makeItem` (`:32-46`) — defaults `workflowState: "Backlog"`; overrides per test.
- Collection positive/negative: `:224-236` (missing estimate on non-terminal) / `:252-264` (Done items excluded) — the missingWorkflowState collection test mirrors these with `workflowState: null` and, for the negative, a terminal state.
- Summary-count sync: `:301-329` (`buildHygieneReport` counts match array lengths).
- Markdown sections: `:573-583` (`## Field Gaps` + `### Missing …` assertions).
- Repository preservation: `:773-795` (`findFieldGaps preserves repository …`) — extend for the new bucket.

## Code References

- `mcp-server/src/lib/hygiene.ts:180-197` — `findFieldGaps` (add third bucket)
- `mcp-server/src/lib/hygiene.ts:65`, `:87` — `HygieneRepoBreakdown` / `HygieneReport` fieldGaps shapes
- `mcp-server/src/lib/hygiene.ts:530-554` — top-level Field Gaps renderer (`totalGaps` gate)
- `mcp-server/src/lib/hygiene.ts:636-660` — per-repo Field Gaps renderer (`repoTotalGaps` gate)
- `mcp-server/src/lib/hygiene.ts:469-471` — `formatItemRow` (null state → `—`, reuse as-is)
- `mcp-server/src/lib/dashboard-fetch.ts:63-73` — `getFieldValue` null guarantee
- `mcp-server/src/lib/workflow-states.ts:27` — `TERMINAL_STATES`
- `mcp-server/src/tools/hygiene-tools.ts:41-218` — tool layer (verbatim passthrough, unchanged)
- `mcp-server/src/__tests__/hygiene.test.ts:224-236, 301-329, 573-583, 773-795` — tests to mirror/extend

## Architecture Documentation

fieldGaps follows a collect-then-render pattern: pure collector (`findFieldGaps`) → two orchestrators embed the result in typed reports → renderer gates sections on non-zero counts. All three gap buckets share the `nonTerminal` pre-filter and `HygieneItem` row shape; the extension is symmetrical with the existing two buckets at every layer.

## Historical Context (from thoughts/)

- `thoughts/shared/plans/2026-05-06-group-GH-1085-hygiene-multi-repo.md` — added the per-repo breakdown; explains the duplicated top-level/per-repo renderer structure the fix must touch twice.
- `thoughts/shared/research/2026-02-21-GH-0114-project-hygiene-reporting-tool.md` — original hygiene tool design.

## Related Research

- `thoughts/shared/research/2026-07-01-GH-1524-create-issue-workflow-state-default.md` — the primary fix (tool-default); this issue is the detection net for non-MCP creation paths.

## Open Questions

- None blocking. One rendering choice for the plan: order the new subsection after Missing Priority (append) — recommended, matching the issue's framing and avoiding churn in existing test assertions that check section order implicitly via `toContain`.

## Files Affected

### Will Modify
- `mcp-server/src/lib/hygiene.ts` — `findFieldGaps` third bucket; both fieldGaps interface shapes; `totalGaps` + `repoTotalGaps` gates; `### Missing Workflow State` / `##### Missing Workflow State` subsections
- `mcp-server/src/__tests__/hygiene.test.ts` — collection (positive/negative), summary/gate, markdown-section, and repository-preservation tests for the new bucket

### Will Read (Dependencies)
- `mcp-server/src/lib/dashboard.ts` — `DashboardItem` shape
- `mcp-server/src/lib/dashboard-fetch.ts` — null guarantee for field values
- `mcp-server/src/lib/workflow-states.ts` — `TERMINAL_STATES`
- `mcp-server/src/tools/hygiene-tools.ts` — verbatim passthrough (verify no changes needed)
