---
date: 2026-07-01
status: draft
type: plan
tags: [directions, next-actions, catch-up, workflow-state]
github_issue: 1526
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1526
primary_issue: 1526
estimate: S
---

# `next_actions` aggregate stateless-triage direction — Implementation Plan

## Prior Work

- builds_on:: [[2026-07-01-GH-1526-next-actions-stateless-aggregate-direction]] (research — primary evidence; all file:line refs verified there)
- builds_on:: [[2026-07-01-GH-1524-create-issue-workflow-state-default]] (research — same incident family; creation-gap fix)
- builds_on:: [[2026-07-01-GH-1525-hygiene-missing-workflow-state-fieldgap]] (research — audit-net fix)

## Overview

`next_actions(audience='human')` returns `directions: []` over a board whose only items are stateless, so `/ralph:catch-up` prints "Things look calm — nothing stuck, nothing on fire" (2026-07-01 incident: 27 stateless items, calm message). This plan adds a single aggregate direction — `kind: "triage"`, "N items have no workflow state" — emitted post-slice for the human audience only when the result would otherwise be empty, plus the two consumer-contract rows in the catch-up ranking doc so the picker labels it and dispatches `/ralph:caretake --mode triage`.

## Current State Analysis

- `Direction.kind` is a closed 5-value union (`mcp-server/src/lib/directions.ts:122`); `issue`/`pr` are required-but-nullable and every current Direction sets exactly one non-null (`:792-810`, `:967-1010`).
- Agent-only fallback (`:846-873`): `config.audience === "agent" && scored.length === 0` → per-item Backlog/null-state entries with `AGENT_BACKLOG_FALLBACK_PENALTY` (`thresholds.ts:52`). Never fires for human.
- `rankDirections` finishes with slice/construct (`:950-1011`) then `recommended` on `directions[0]` (`:1013-1018`).
- Tool description asserts "the fallback never fires for `audience='human'`" (`mcp-server/src/tools/directions-tools.ts:483`).
- Catch-up contract: picker labels (`ralph/skills/catch-up/next-action-ranking.md:57-68`, all rows template `#NNN`), title-fragment rule (`:70-74`, keys on `issue.title`/`pr.title`), dispatch table (`:90-99`, all rows dispatch a single `#NNN`). Empty case at `SKILL.md:85-89` prints the calm message.

### Key Discoveries

- The post-slice boundary is the safe seam: the aggregate fires only when `directions.length === 0`, so it cannot perturb existing scoring, tie-breaking, tree-continue promotion, or the agent path.
- `DirectionSignals` (`directions.ts:67-112`) has no count field — add optional `statelessCount?: number`.
- `reason`/`tags` are deprecated but required; `buildReason` (`:698-773`) branches per kind — the aggregate synthesizes its own strings without touching `buildReason`'s issue/PR branches.
- Null-state check: `DashboardItem.workflowState: string | null`, never `undefined`/`""`; a terminal item cannot be stateless (terminal IS a state value), so `workflowState === null` alone is the correct filter. Exclude items with open blockers? No — triage is exactly what unblocks/classifies them; count all null-state items.
- Closest test to mirror: `"human audience: Backlog-only board returns no directions"` (`directions.test.ts:199-209`).

## Desired End State

1. `next_actions(audience='human')` over a board with zero actionable directions and ≥1 null-state items returns exactly one direction: `kind: "triage"`, `rank: 1`, `recommended: true`, `issue: null`, `pr: null`, `signals.statelessCount = N`, `signals.tags` including `"stateless-triage"`.
2. Human-audience behavior unchanged when any real direction exists (no aggregate appended) and on Backlog-only boards with no null-state items (still `[]` — calm message remains accurate).
3. Agent-audience behavior byte-identical (per-item fallback untouched).
4. Catch-up ranking doc has a picker-label row, a title-rule carve-out, and a dispatch row mapping `triage` → `Skill("ralph:caretake", args="--mode triage")`.
5. Tool description accurately describes the human-audience aggregate exception.

### Verification

- `cd mcp-server && npm run build` exits 0; `npm test` passes; `npx vitest run src/__tests__/directions.test.ts` passes.
- New tests cover the four cases in Testing Strategy.

## What We're NOT Doing

- Not including Backlog items in the aggregate (Backlog is a legitimate, dashboard-visible parking state; including it re-creates the noise the audience split prevents).
- Not emitting per-item human directions (no-spam philosophy — single aggregate only).
- Not changing the agent fallback, scoring, `buildReason`'s existing branches, or `ACTIONABLE_PHASES`.
- Not modifying catch-up `SKILL.md` (its empty case now only fires when genuinely quiet — by construction).
- Not implementing a caretake triage auto-run — dispatch mapping only.

## Implementation Approach

Single phase, two coupled tasks plus a doc task. In `directions.ts`: extend the kind union + `DirectionSignals`, and after the `recommended` stamp add the human-audience aggregate branch (`directions.length === 0 && config.audience === "human"` → count `items.filter(i => i.workflowState === null)`; if > 0 push the synthetic Direction). In `directions-tools.ts`: amend the description sentence. In `next-action-ranking.md`: add the two rows + title carve-out.

## Phase 1: Aggregate triage direction end-to-end

depends_on: null

### Overview

Emit the aggregate direction for the human audience on otherwise-empty results; wire the consumer contract; prove with unit tests.

### Changes Required

#### 1. Direction emission
**File**: `mcp-server/src/lib/directions.ts`
**Changes**:
- Kind union (`:122`): add `"triage"`.
- `DirectionSignals` (`:67-112`): add `statelessCount?: number` (doc comment: only on `kind: "triage"` aggregate directions).
- After the `recommended` stamp (`:1013-1018`): if `config.audience === "human" && directions.length === 0`, compute `statelessCount = items.filter((i) => i.workflowState === null).length`; if > 0, push one Direction: `{ rank: 1, recommended: true, kind: "triage", issue: null, pr: null, signals: { tags: ["stateless-triage"], statelessCount }, reason: "<N> item(s) have no workflow state — run /ralph:caretake --mode triage", tags: ["stateless-triage"], score: AGENT_BACKLOG_FALLBACK_PENALTY }`.

#### 2. Tool description
**File**: `mcp-server/src/tools/directions-tools.ts`
**Changes**: amend the `:483` description sentence: the per-item fallback still never fires for `audience='human'`, but when the human scan yields zero directions and ≥1 items have a null Workflow State, a single aggregate `kind: "triage"` direction (with `signals.statelessCount`) is returned instead of an empty list.

#### 3. Consumer contract
**File**: `ralph/skills/catch-up/next-action-ranking.md`
**Changes**:
- Picker label table: new row `kind: "triage"` → label `Triage N stateless items` (N from `signals.statelessCount`; no `#NNN`).
- Title-fragment rule: carve-out — `triage` directions have no `issue.title`/`pr.title`; the label stands alone.
- Dispatch table: new row `triage` → `Skill("ralph:caretake", args="--mode triage")` (board-wide, no issue argument).

#### 4. Tests
**File**: `mcp-server/src/__tests__/directions.test.ts`
**Changes**: new describe block mirroring the `:199-209` fixture shape.

#### Task 1.1: directions.ts + directions-tools.ts changes
- **files**: `mcp-server/src/lib/directions.ts` (modify), `mcp-server/src/tools/directions-tools.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `"triage"` in the kind union; `statelessCount?` on DirectionSignals
  - [ ] Aggregate emitted post-`recommended`, human-only, empty-result-only, null-state-count > 0 only; both `issue` and `pr` null
  - [ ] Tool description amended accurately
  - [ ] `cd mcp-server && npm run build` exits 0

#### Task 1.2: unit tests
- **files**: `mcp-server/src/__tests__/directions.test.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Case A: human + null-state-only board → exactly one direction, `kind: "triage"`, `recommended: true`, `issue === null && pr === null`, `signals.statelessCount` equals fixture count
  - [ ] Case B: human + Backlog-only (all states non-null) → `[]` (existing `:199-209` test still green)
  - [ ] Case C: human + one actionable item + null-state items → normal directions only, no `triage` entry
  - [ ] Case D: agent + null-state-only board → per-item fallback unchanged (no `triage` entry)
  - [ ] `npx vitest run src/__tests__/directions.test.ts` passes

#### Task 1.3: catch-up ranking doc rows
- **files**: `ralph/skills/catch-up/next-action-ranking.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Picker label row, title-rule carve-out, and dispatch row present and consistent with the emitted shape

### Success Criteria

#### Automated Verification
- [ ] `cd mcp-server && npm run build` exits 0
- [ ] `cd mcp-server && npm test` passes (full suite)
- [ ] `npx vitest run src/__tests__/directions.test.ts` passes

#### Manual Verification
- [ ] Post-release, `/ralph:catch-up` over a board with stateless items surfaces "Triage N stateless items" instead of the calm message (observable on a live board)

## Testing Strategy

### Unit Tests
Four cases (A-D above) in a new describe block using the existing `makeItem`/`makeConfig` fixtures; plus existing fallback/audience suites stay green untouched.

### Integration Tests
None — directions are pure-function tested per repo convention.

### Manual Testing Steps
1. After merge/release, on a project with ≥1 stateless item and nothing actionable, run `/ralph:catch-up`.
2. Confirm the picker shows `Triage N stateless items` as the recommended option and dispatches caretake triage.

## Performance Considerations

One extra `.filter().length` over already-fetched items, only on the empty-result path. Negligible.

## Migration Notes

- Additive: a new `kind` value and optional signal field. In-repo consumers are updated in the same PR; external JSON consumers switching on `kind` see a new value only in the previously-empty case (they showed nothing before; unknown-kind fallthrough should be tolerated — noted in the tool description).
- Touches `ralph/**` (ranking doc) → merge triggers the ralph plugin version bump alongside the mcp-server release. Expected.
- The deprecated `reason`/`tags` fields are populated for the new kind to keep the 2.7.0 deprecation window contract.

## References

- Research: `thoughts/shared/research/2026-07-01-GH-1526-next-actions-stateless-aggregate-direction.md`
- Issue: https://github.com/cdubiel08/ralph-hero/issues/1526
- Siblings: PR #1527 (GH-1524), PR #1530 (GH-1525)
