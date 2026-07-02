---
date: 2026-07-01
status: draft
type: plan
tags: [hygiene, mcp-tools, workflow-state, field-gaps]
github_issue: 1525
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1525
primary_issue: 1525
estimate: S
---

# `project_hygiene` missingWorkflowState fieldGap — Implementation Plan

## Prior Work

- builds_on:: [[2026-07-01-GH-1525-hygiene-missing-workflow-state-fieldgap]] (research — primary evidence; all file:line refs verified there)
- builds_on:: [[2026-07-01-GH-1524-create-issue-workflow-state-default]] (research — the primary tool-default fix; this is the detection net for UI/automation-created stateless items)
- builds_on:: [[2026-05-06-group-GH-1085-hygiene-multi-repo]] (plan — origin of the per-repo breakdown structure this plan extends in parallel)

## Overview

`project_hygiene`'s fieldGaps category buckets only `missingEstimate` and `missingPriority`; board items with a null Workflow State (GitHub UI adds, Projects automation, pre-GH-1524 `create_issue` calls) pass the collector's non-terminal filter but land in no bucket — invisible to hygiene sweeps (2026-07-01 incident: 27 stateless items, zero hygiene signal). This plan adds a third, fully symmetrical `missingWorkflowState` bucket through the collector, both report interfaces, and both markdown renderer sections.

## Current State Analysis

All in `mcp-server/src/lib/hygiene.ts`:

- `findFieldGaps` (`hygiene.ts:180-197`) filters to non-terminal via `!ws || !TERMINAL_STATES.includes(ws)` — null states already pass (the `!ws` branch) — then buckets `estimate === null` and `priority === null` only.
- Fieldgaps shapes on `HygieneRepoBreakdown` (`hygiene.ts:65`) and `HygieneReport` (`hygiene.ts:87`): `{ missingEstimate: HygieneItem[]; missingPriority: HygieneItem[] }`.
- Renderer gates: top-level `totalGaps` (`hygiene.ts:531-534`) gates `## Field Gaps` with `### Missing Estimate` / `### Missing Priority` subsections (`:530-554`); per-repo `repoTotalGaps` (`:636-660`) gates `#### Field Gaps` with `##### …` subsections and feeds the `renderedAny` flag.

### Key Discoveries

- `DashboardItem.workflowState: string | null`, never `undefined`/`""` (`getFieldValue` → `fv?.name ?? null`, `dashboard-fetch.ts:63-73`) — strict `=== null` matches the sibling checks.
- `findFieldGaps` has exactly two call sites (`buildRepoBreakdown` `hygiene.ts:353→378`, `buildHygieneReport` `:407→450`) — extending the return shape propagates everywhere.
- `HygieneSummary` (`hygiene.ts:51-58`) has no per-gap counts; `fieldCoveragePercent` (`:420-426`) is a blended estimate+priority metric — redefining it is scope creep, leave untouched.
- `formatItemRow` (`hygiene.ts:469-471`) already renders null state as `—`; new table rows need no renderer changes.
- Tool layer (`hygiene-tools.ts:41-218`) returns the report verbatim in JSON and markdown — zero tool changes.
- Test patterns in `hygiene.test.ts`: collection `:224-236`/`:252-264`, summary sync `:301-329`, markdown `:573-583`, repository preservation `:773-795`.

## Desired End State

1. A non-terminal board item with `workflowState === null` appears in `fieldGaps.missingWorkflowState` in JSON output, top-level and `groupBy=repo`.
2. Markdown output renders `### Missing Workflow State` (top-level) and `##### Missing Workflow State` (per-repo) subsections, and a board whose only gap is stateless items still renders the `## Field Gaps` / `#### Field Gaps` sections (gates include the new bucket).
3. Existing `missingEstimate` / `missingPriority` behavior and `fieldCoveragePercent` semantics unchanged.
4. Unit tests cover collection (positive + terminal-exclusion is N/A for null — see note), gate inclusion, markdown sections, and repository preservation.

> Note: a null-state item cannot be "terminal", so the negative test mirrors `:252-264` by asserting a `Done` item with estimate/priority set contributes nothing to any bucket including the new one.

### Verification

- `cd mcp-server && npm run build` exits 0.
- `cd mcp-server && npm test` passes; `npx vitest run src/__tests__/hygiene.test.ts` passes with the new assertions.
- New tests assert: `missingWorkflowState` collection; `## Field Gaps` renders when it is the *only* non-empty bucket; both heading depths present; `repository` preserved.

## What We're NOT Doing

- Not adding per-gap counts to `HygieneSummary` or touching `fieldCoveragePercent` (blended estimate+priority metric keeps its meaning).
- Not changing `next_actions` (GH-1526 owns the human-audience aggregate direction).
- Not changing the dashboard's `"Unknown"` phase bucketing (`dashboard.ts:256/603/680`) — already surfaces null states.
- Not adding tool-level params or truncation to `hygiene-tools.ts`.
- Not backfilling states on existing items — detection only.

## Implementation Approach

Single phase, one tightly-coupled file pair. The new bucket is added symmetrically at each of the four touchpoints inside `hygiene.ts` (collector return shape, two interface literals, two renderer gates+subsections), ordered after Missing Priority everywhere. Tests extend the four existing pattern sites in `hygiene.test.ts`.

## Phase 1: Add missingWorkflowState bucket end-to-end

depends_on: null

### Overview

Extend `findFieldGaps`, both report interfaces, and both renderer sections with the third bucket; prove with unit tests mirroring the existing four pattern sites.

### Changes Required

#### 1. Collector + interfaces + renderer
**File**: `mcp-server/src/lib/hygiene.ts`
**Changes**:
- `findFieldGaps` return type + body (`:180-197`): add `missingWorkflowState: nonTerminal.filter((i) => i.workflowState === null).map((i) => toHygieneItem(i, now))`, ordered after `missingPriority`.
- `HygieneRepoBreakdown.fieldGaps` (`:65`) and `HygieneReport.fieldGaps` (`:87`): add `missingWorkflowState: HygieneItem[]`.
- Top-level renderer (`:530-554`): include the new bucket in `totalGaps`; add `### Missing Workflow State` subsection (same `| Issue | Title | State | Age |` table via `formatItemRow`) after Missing Priority.
- Per-repo renderer (`:636-660`): include in `repoTotalGaps`; add `##### Missing Workflow State` subsection after Missing Priority.

#### 2. Tests
**File**: `mcp-server/src/__tests__/hygiene.test.ts`
**Changes**: extend the four pattern sites:
- Collection: new test — `workflowState: null` item (estimate+priority set) lands only in `missingWorkflowState`; existing estimate/priority tests gain `expect(gaps.missingWorkflowState).toHaveLength(0)` where apt.
- Terminal exclusion: extend/mirror `:252-264` — `Done` item contributes to no bucket.
- Gate: board whose only gap is a stateless item still renders `## Field Gaps` + `### Missing Workflow State` (this is the regression the gates could silently miss).
- Markdown: extend `:573-583` with the new heading at both depths (top-level and a `groupBy`-style repo breakdown test if one exists for field gaps).
- Repository preservation: extend `:773-795` for the new bucket.

#### Task 1.1: collector, interfaces, renderer sections
- **files**: `mcp-server/src/lib/hygiene.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `findFieldGaps` returns `missingWorkflowState` with `=== null` check, after `missingPriority`
  - [ ] Both fieldGaps interface literals include the new array
  - [ ] `totalGaps` and `repoTotalGaps` gates include the new bucket; subsections render at `###` and `#####` depths
  - [ ] `cd mcp-server && npm run build` exits 0

#### Task 1.2: unit tests for the new bucket
- **files**: `mcp-server/src/__tests__/hygiene.test.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] `npx vitest run src/__tests__/hygiene.test.ts` passes
  - [ ] Includes the only-gap-is-stateless gate test (section renders with just the new bucket non-empty)
  - [ ] Repository preservation asserted for the new bucket

### Success Criteria

#### Automated Verification
- [ ] `cd mcp-server && npm run build` exits 0
- [ ] `cd mcp-server && npm test` passes (full suite)
- [ ] `npx vitest run src/__tests__/hygiene.test.ts` passes

#### Manual Verification
- [ ] `ralph_hero__project_hygiene` (markdown) on a board with a known stateless item shows it under `### Missing Workflow State` (observable post-release)

## Testing Strategy

### Unit Tests
Extend `hygiene.test.ts` at the four established pattern sites (collection, terminal-exclusion, gate/summary, markdown, repo preservation) per Task 1.2.

### Integration Tests
None — hygiene is pure-function tested against fixture `DashboardItem[]` per repo convention.

### Manual Testing Steps
1. After merge/release, run `project_hygiene` with `format: "markdown"` against project 3 (or any board with a UI-created item lacking Workflow State).
2. Confirm the item appears under `### Missing Workflow State` and, with `groupBy: "repo"`, under the repo's `##### Missing Workflow State`.

## Performance Considerations

One extra `.filter().map()` pass over the already-materialized non-terminal array per report — negligible; no new I/O.

## Migration Notes

- Additive JSON shape change: `fieldGaps` gains a third array. Consumers doing exhaustive key iteration see a new key; known consumers (hygiene skill prose, dashboards) read named buckets — no breakage expected.
- No schema/DB migration. Releases via the normal `release.yml` auto-bump on merge.

## References

- Research: `thoughts/shared/research/2026-07-01-GH-1525-hygiene-missing-workflow-state-fieldgap.md`
- Issue: https://github.com/cdubiel08/ralph-hero/issues/1525
- Sibling fix: PR #1527 (GH-1524 create_issue default)
