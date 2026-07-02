---
date: 2026-07-01
status: draft
type: plan
tags: [mcp-tools, issue-tools, workflow-state, field-defaults]
github_issue: 1524
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1524
primary_issue: 1524
estimate: XS
---

# `create_issue` Workflow State default — Implementation Plan

## Prior Work

- builds_on:: [[2026-07-01-GH-1524-create-issue-workflow-state-default]] (research — primary evidence; all file:line refs below verified there)
- builds_on:: [[2026-03-04-GH-0516-create-issue-status-sync]] (plan — added `syncStatusField` on the create path, inside the same conditional this plan removes)
- builds_on:: [[2026-03-04-group-GH-0514-skill-workflowstate-enforcement]] (plan — the prose-only enforcement layer whose bypass motivates this fix)

## Overview

`create_issue` writes the Workflow State project field only when the caller passes `workflowState`; omission silently produces a stateless board item invisible to `next_actions(audience='human')` and hygiene (2026-07-01 incident: 27 stateless meta-plan issues). This plan defaults the field to `"Backlog"` using the handler's existing `effective*` local-variable convention, makes the Step-5 write unconditional, and reports the defaulted value in `fieldsSet`.

## Current State Analysis

All in `mcp-server/src/tools/issue-tools.ts` (handler registered at :931-1181):

- `workflowState` is optional with no default in the zod schema (`issue-tools.ts:952-955`).
- The Workflow State write + `syncStatusField` call are gated behind `if (args.workflowState)` (`issue-tools.ts:1124-1140`); no else, no warning.
- `fieldsSet.workflowState` echoes the raw arg: `args.workflowState || null` (`issue-tools.ts:1171`).

### Key Discoveries

- The `effective*` convention already exists in this handler: `let effectiveEstimate = args.estimate` + registry merge (`issue-tools.ts:977-993`). `mergeDefaults` (`mcp-server/src/lib/repo-registry.ts:272-300`) has no `workflowState` field, so the mirror is a plain local default — no registry plumbing.
- `syncStatusField` (`mcp-server/src/lib/helpers.ts:650-678`) is best-effort (early-returns on missing mapping/field/option, inner try/catch) — safe to call unconditionally. `WORKFLOW_STATE_TO_STATUS["Backlog"] === "Todo"` (`mcp-server/src/lib/workflow-states.ts:134`).
- `updateProjectItemField` throws if the project's Workflow State field lacks a `"Backlog"` option (`mcp-server/src/lib/helpers.ts:313-320`, exact-string lookup `mcp-server/src/lib/cache.ts:188-195`), caught by the handler's outer catch (`issue-tools.ts:1176-1178`) *after* the issue exists. **Decision: keep the defaulted write strict** — `setup_project` always provisions "Backlog", and a loud failure beats the silent statelessness this fixes. This matches existing explicit-value behavior exactly.
- No existing `create_issue` unit tests (`issue-tools.test.ts` covers list/get only; no create test file exists). Handler-invocation pattern: `mcp-server/src/__tests__/cross-tool-consistency.test.ts:306-317` (`getTool` via `_registeredTools`) + mock shapes from `mcp-server/src/__tests__/auto-advance-parent.test.ts:81-139` (`FieldOptionCache.populate`, sequential-response mock client).

## Desired End State

1. `create_issue` with `workflowState` omitted produces a board item in `Backlog` (field written + Status synced to `Todo`), and the response reports `fieldsSet.workflowState: "Backlog"`.
2. Explicit `workflowState` values behave exactly as today (e.g. hero-fable's `"In Progress"`).
3. Semantic intents unaffected (they route via `save_issue`, untouched).
4. A unit test covers the defaulted path and the explicit-value-wins path.

### Verification

- `npm run build` (mcp-server) exits 0.
- `npm test` (mcp-server) passes, including the new create-issue test file.
- New test asserts: Workflow State mutation fired with the Backlog option when omitted; `fieldsSet.workflowState === "Backlog"`; explicit value passes through unchanged.

## What We're NOT Doing

- Not touching `save_issue` (defaulting there would clobber real states on existing items).
- Not touching `create_draft_issue` / `convert_draft_issue` (same gap exists in draft path; out of GH-1524's scope).
- Not adding `workflowState` to repo-registry `mergeDefaults` (no per-repo state defaults).
- Not adding fuzzy/tolerant option matching — a project without a `"Backlog"` option fails loudly (pre-existing behavior for explicit values).
- Not building the belt-and-braces nets (GH-1525 hygiene fieldGap, GH-1526 next_actions aggregate direction — filed separately).

## Implementation Approach

Single phase, two tasks in one file-pair: introduce `effectiveState` alongside the other `effective*` locals, switch the Step-5 block to use it unconditionally, report it in `fieldsSet`, and add a dedicated unit test file. < 20 LOC of production change.

## Phase 1: Default Workflow State to Backlog

depends_on: null

### Overview

Make `create_issue` always set Workflow State (defaulting to `"Backlog"`), sync Status, report the effective value, and prove it with unit tests.

### Changes Required

#### 1. Handler default
**File**: `mcp-server/src/tools/issue-tools.ts`
**Changes**:
- With the other effective locals (after `issue-tools.ts:979`): `const effectiveState = args.workflowState ?? "Backlog";`
- Replace the `if (args.workflowState) { ... }` block (`issue-tools.ts:1124-1140`) with the same two calls unconditionally, passing `effectiveState` to both `updateProjectItemField(..., "Workflow State", effectiveState, ...)` and `syncStatusField(..., effectiveState, ...)`.
- `fieldsSet.workflowState: effectiveState` (`issue-tools.ts:1171`) — never null now.
- Update the zod `.describe()` (`issue-tools.ts:952-955`) to `"Initial Workflow State name (defaults to \"Backlog\")"`.

#### 2. Unit test
**File**: `mcp-server/src/__tests__/create-issue-defaults.test.ts` (create)
**Changes**: New test file modeled on `cross-tool-consistency.test.ts` handler extraction + `auto-advance-parent.test.ts` mocks:
- Populate `FieldOptionCache` with `Workflow State` (options incl. `Backlog`, `In Progress`) and `Status` (options incl. `Todo`) for the test project; mock client returns the repo-ID query, createIssue mutation, addProjectV2ItemById mutation, then field-update mutations in sequence.
- Case 1 (default): invoke `create_issue` handler without `workflowState`; assert a Workflow State field mutation targeted the Backlog option and `fieldsSet.workflowState === "Backlog"`.
- Case 2 (explicit wins): invoke with `workflowState: "In Progress"`; assert the mutation targeted the In Progress option and `fieldsSet.workflowState === "In Progress"`.

#### Task 1.1: default + report effectiveState in create_issue
- **files**: `mcp-server/src/tools/issue-tools.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `effectiveState` local defaults to `"Backlog"` via `??`; explicit arg wins
  - [ ] Step-5 Workflow State write + `syncStatusField` run unconditionally with `effectiveState`
  - [ ] `fieldsSet.workflowState` reports `effectiveState`
  - [ ] `npm run build` exits 0

#### Task 1.2: unit tests for defaulted + explicit paths
- **files**: `mcp-server/src/__tests__/create-issue-defaults.test.ts` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] `npx vitest run src/__tests__/create-issue-defaults.test.ts` passes both cases
  - [ ] Default case asserts the Backlog option ID was used in the field mutation, not just the response echo

### Success Criteria

#### Automated Verification
- [ ] `cd mcp-server && npm run build` exits 0
- [ ] `cd mcp-server && npm test` passes (full suite — guards against regressions in cross-tool-consistency tests that invoke create_issue-adjacent paths)
- [ ] `npx vitest run src/__tests__/create-issue-defaults.test.ts` passes

#### Manual Verification
- [ ] A direct MCP `create_issue` call without `workflowState` lands on the board in Backlog/Todo (observable on the project board after release)

## Testing Strategy

### Unit Tests
New `create-issue-defaults.test.ts` (Task 1.2): defaulted path + explicit-value-wins, asserting on the actual field mutation payload and the `fieldsSet` response.

### Integration Tests
None — the GraphQL surface is mocked per repo convention; no live-API tests exist in this suite.

### Manual Testing Steps
1. After merge/release, call `ralph_hero__create_issue` with title only.
2. Confirm the new item shows Workflow State "Backlog" and Status "Todo" on project 3, and the tool response shows `fieldsSet.workflowState: "Backlog"`.

## Performance Considerations

Two extra GraphQL mutations per formerly-stateless create (field write + status sync) — identical cost to what every well-formed create already pays. No new queries.

## Migration Notes

- Behavior change is additive-by-default: callers that previously produced stateless items now get Backlog items. Callers relying on statelessness (none known; it was the bug) would need to pass an explicit state.
- Projects whose Workflow State field lacks a `"Backlog"` option will now get `toolError` on plain creates (issue is still created — pre-existing partial-failure shape, `issue-tools.ts:1176-1178`). Standard `setup_project` boards are unaffected; this is the accepted strict-semantics decision.
- No schema/DB migration. Release flows through the normal `release.yml` auto-bump on merge.

## References

- Research: `thoughts/shared/research/2026-07-01-GH-1524-create-issue-workflow-state-default.md`
- Issue: https://github.com/cdubiel08/ralph-hero/issues/1524
- Prior fix on the same block: `thoughts/shared/plans/2026-03-04-GH-0516-create-issue-status-sync.md`
