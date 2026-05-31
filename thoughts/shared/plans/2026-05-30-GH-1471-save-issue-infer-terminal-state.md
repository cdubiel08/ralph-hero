---
date: 2026-05-30
status: draft
type: plan
tags: [save-issue, workflow-states, triage, terminal-state, mcp-server]
github_issue: 1471
github_issues: [1471]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1471
primary_issue: 1471
estimate: S
---

# GH-1471 — save_issue: infer terminal workflowState from issueState on close

## Prior Work

- builds_on:: [[2026-05-30-ralph-triage-autonomy-gaps]] — Gap B (P0). This plan implements the Gap-B proposal verbatim; line refs below are reproduced from that research against the live tree and re-verified.
- tensions:: none. Gap B is independent of Gap A (`dashboard-fetch.ts` / `directions.ts`) and ships in parallel.

## Overview

`save_issue` currently bridges workflow state and GitHub issue state in only one direction: a terminal `workflowState` (Done/Canceled) auto-closes the GitHub issue. The reverse is missing — `save_issue({issueState: "CLOSED_NOT_PLANNED"})` with no `workflowState` closes the issue on GitHub but leaves the project board field stranded in a non-terminal column (observed: landcrawler-ai #669/#670 stuck in "Human Needed" after close-not-planned).

This plan adds reverse inference: when `issueState` resolves to CLOSED and no explicit `workflowState` is supplied, default the workflow state to the matching terminal state (CLOSED→Done, CLOSED_NOT_PLANNED→Canceled) and write it through the existing project-field path so the board Status syncs to Done. Explicit `workflowState` always wins; the existing forward (workflowState→close) path is unchanged. The change is small (one inference block + one guard widening + a tool-description tweak + a docs edit) and S-estimate.

## Current State Analysis

The `save_issue` handler lives in `mcp-server/src/tools/issue-tools.ts` (handler starts at `:1185`). The relevant flow, verified against the live tree:

- **`hasProjectFields`** (`:1224-1226`) is computed only from `workflowState | estimate | priority | iteration`. A close-only call (`{issueState: "CLOSED"}`) leaves this `false`.
- **Workflow-state resolution** (`:1236-1254`) sets `resolvedWorkflowState` from `args.workflowState` (semantic-intent or direct). When `args.workflowState` is absent, `resolvedWorkflowState` stays `undefined`.
- **Close/reopen resolution** (`:1256-1269`) maps `args.issueState` → `targetState` (`"CLOSED" | "OPEN" | undefined`) + `stateReason` (`"COMPLETED" | "NOT_PLANNED" | undefined`). `CLOSED`→COMPLETED, `CLOSED_NOT_PLANNED`→NOT_PLANNED.
- **Forward auto-close** (`:1271-1276`) — `if (!args.issueState && resolvedWorkflowState && TERMINAL_STATES.includes(resolvedWorkflowState))` sets `targetState = "CLOSED"` and derives `stateReason`. This is the existing forward bridge that must stay unchanged.
- **Issue mutation block** (`:1278-1409`) closes/reopens/updates the GitHub issue using `targetState`/`stateReason`.
- **Project-field block** (`:1412`) is guarded by `if (hasProjectFields)`. Inside: the lock guard (`:1427`), the 4a Workflow-State + Status sync (`:1448-1469`), estimate (`:1472`), priority (`:1491`). A close-only call has `hasProjectFields === false` and skips this entire block, so the board is never updated.
- The 4a branch (`:1448 if (resolvedWorkflowState)`) already pushes a Workflow-State option update AND a `WORKFLOW_STATE_TO_STATUS[resolvedWorkflowState]` Status sync (`:1456-1466`). Reusing it means **no new mutation code** — we only need `resolvedWorkflowState` to be set and the guard to let us in.
- `TERMINAL_STATES = ["Done", "Canceled"]` (`workflow-states.ts:27`). `LOCK_STATES` (`:32-36`) is `Research in Progress | Plan in Progress | In Progress` — neither Done nor Canceled, so inferred terminal states never trip the lock guard at `:1427`.

### Key Discoveries

- `targetState` and `stateReason` are computed at `:1256-1276`, i.e. **before** the project-field block at `:1412`, so the new inference block can read them. (`mcp-server/src/tools/issue-tools.ts:1257-1258`)
- The 4a path already performs both the Workflow-State write and the Status sync — reverse inference needs only to populate `resolvedWorkflowState` and open the guard. (`mcp-server/src/tools/issue-tools.ts:1448-1466`)
- The lock guard at `:1427` only fires when `resolvedWorkflowState ∈ LOCK_STATES`; Done/Canceled are not lock states, so inferred closes are guard-safe. (`mcp-server/src/tools/issue-tools.ts:1427`, `workflow-states.ts:32-36`)
- `changes` is a plain `Record<string, unknown>` (`:1232`) returned to the caller — adding `changes.workflowStateInferred` is observable and lets a structural test assert the inference fired.
- The `resolvedWorkflowState === undefined` precondition on the inference block is exactly what makes an explicit `workflowState` win: if the caller passed one, `resolvedWorkflowState` is already set and inference is skipped.

## Desired End State

1. `save_issue({issueState: "CLOSED"})` with no `workflowState` → GitHub issue closed AND project Workflow State = "Done", Status = "Done".
2. `save_issue({issueState: "CLOSED_NOT_PLANNED"})` with no `workflowState` → GitHub issue closed-not-planned AND Workflow State = "Canceled", Status = "Done".
3. `save_issue({issueState: "CLOSED", workflowState: "Backlog"})` → explicit wins; board stays at "Backlog" (issue still closes via the existing path).
4. The existing forward path `save_issue({workflowState: "Done"})` → still auto-closes the issue; behavior byte-for-byte unchanged.
5. Reverse inference writes the board ONLY when `targetState === "CLOSED"`. OPEN/reopen and metadata-only calls are unaffected.
6. Inferred Done/Canceled never trip the lock guard.

### Verification

- `npm test` (vitest) green, including new precedence cases in the save_issue test file.
- `npm run build` exits 0 (TypeScript strict).
- New unit tests assert: CLOSED→Done, CLOSED_NOT_PLANNED→Canceled, explicit-wins, OPEN→no inference, and the `hasProjectFields || inferredFromClose` guard widening.
- Manual smoke against a live project: close an issue parked in a non-terminal column with no `workflowState` and confirm the board lands on Done with Status=Done.

## What We're NOT Doing

- NOT touching the forward `workflowState → issueState` auto-close (`:1271-1276`). It already works via `__COMPLETE__`/terminal states and must stay unchanged.
- NOT implementing Gap A (`dashboard-fetch.ts` / `directions.ts` dependency-edge picker), Gap C (`watch-blockers` mode), or the Gap D triage decision-table beyond the minimal CLOSE-branch rewrite called out in the issue.
- NOT adding new GraphQL mutations — the inference reuses the existing 4a Workflow-State + Status-sync path.
- NOT changing `TERMINAL_STATES`, `LOCK_STATES`, or `WORKFLOW_STATE_TO_STATUS`.
- NOT altering reopen (`OPEN`) semantics.

## Implementation Approach

Two phases. Phase 1 is the server-side behavior change (the inference block, the guard widening, and the tool-description update) plus its unit tests — this is the load-bearing fix and satisfies every acceptance criterion. Phase 2 is the docs alignment in `ralph/skills/caretake/modes/triage.md` so the CLOSE verdicts lead with the board transition (now that close infers terminal state, the separate "update workflow state" step is redundant). Phase 1 owns `mcp-server/`; Phase 2 owns `ralph/skills/caretake/modes/triage.md`. No file overlap.

## Phase 1: Reverse-infer terminal workflowState on close

depends_on: null

### Overview

Add a reverse-inference block to `save_issue` so a close-only call defaults `resolvedWorkflowState` to the matching terminal state, widen the project-field guard to admit that case, document the reverse direction in the tool description, and cover all precedence cases with unit tests.

### Changes Required

#### 1. Reverse-inference block

**File**: `mcp-server/src/tools/issue-tools.ts`
**Changes**: Immediately after the forward auto-close block (after `:1276`, before the "3. Issue state mutations" comment at `:1278`), insert:

```ts
// Reverse inference: a close-only call (no explicit workflowState) should
// land the board on the matching terminal state so closed issues never
// strand in a non-terminal column. Explicit workflowState always wins
// because resolvedWorkflowState is already set in that case.
let inferredFromClose = false;
if (resolvedWorkflowState === undefined && targetState === "CLOSED") {
  resolvedWorkflowState = stateReason === "NOT_PLANNED" ? "Canceled" : "Done";
  inferredFromClose = true;
  changes.workflowStateInferred = resolvedWorkflowState;
}
```

`inferredFromClose` must be declared at the handler scope (a `let` here, before the project-field block) so the guard at `:1412` can read it. Done/Canceled are not in `LOCK_STATES`, so the lock guard at `:1427` is untouched.

#### 2. Widen the project-field guard

**File**: `mcp-server/src/tools/issue-tools.ts`
**Changes**: Change the guard at `:1412` from `if (hasProjectFields)` to `if (hasProjectFields || inferredFromClose)`. The existing 4a branch (`:1448 if (resolvedWorkflowState)`) then performs the Workflow-State option update and the `WORKFLOW_STATE_TO_STATUS` Status sync with no new code. No other line in the block needs to change — estimate/priority/iteration branches are guarded by their own `args.X !== undefined` checks and stay inert on a close-only call.

#### 3. Document the reverse direction in the tool description

**File**: `mcp-server/src/tools/issue-tools.ts`
**Changes**: Extend the description string at `:1190` (the "Auto-closes the GitHub issue when workflowState resolves to a terminal state..." sentence) to also state the reverse: closing an issue (issueState CLOSED / CLOSED_NOT_PLANNED) with no explicit workflowState infers the terminal Workflow State (Done / Canceled respectively) and syncs Status. Keep the note that an explicit workflowState wins.

#### 4. Unit tests for all precedence cases

**File**: `mcp-server/src/__tests__/save-issue.test.ts` (the save_issue test file; if the repo's test for this handler lives in `issue-tools.test.ts`, add the block there instead — confirm at impl time which file holds the existing save_issue/close tests).
**Changes**: Add a reverse-inference describe block. Mirror the research's helper shape — extract or inline a pure predicate `inferWorkflowFromClose(issueState, workflowState)` returning the inferred state (or use the same conditional logic) and assert:
- CLOSED + no workflowState → "Done"
- CLOSED_NOT_PLANNED + no workflowState → "Canceled"
- OPEN + no workflowState → undefined (no inference)
- CLOSED + explicit workflowState "Backlog" → undefined-from-inference (explicit wins; board stays Backlog)
- Structural assertion that the project-field guard admits the close-only case (`hasProjectFields || inferredFromClose`) — i.e. a `{issueState: "CLOSED"}` call writes the Workflow State + Status, and a `{issueState: "OPEN"}`-only or metadata-only call does not.

### Success Criteria

#### Automated Verification
- [ ] `cd mcp-server && npm run build` exits 0
- [ ] `cd mcp-server && npx vitest run src/__tests__/save-issue.test.ts` (or the file holding the save_issue tests) passes, including the new reverse-inference block
- [ ] `cd mcp-server && npm test` — full suite green
- [ ] `grep -n "inferredFromClose" src/tools/issue-tools.ts` shows the declaration, the inference assignment, and `|| inferredFromClose` in the guard

#### Manual Verification
- [ ] Against a live project, `save_issue({number: N, issueState: "CLOSED"})` on an issue parked in a non-terminal column closes it AND moves the board to Workflow State = Done, Status = Done
- [ ] `save_issue({number: N, issueState: "CLOSED_NOT_PLANNED"})` lands Workflow State = Canceled, Status = Done
- [ ] `save_issue({number: N, issueState: "CLOSED", workflowState: "Backlog"})` leaves the board at Backlog (explicit wins)
- [ ] A reopen call `save_issue({number: N, issueState: "OPEN"})` does not write a terminal workflow state

## Phase 2: Align triage.md CLOSE branches with reverse inference

depends_on: [phase-1]

### Overview

Now that close infers the terminal board state, the triage skill's CLOSE verdicts should lead with the single `workflowState` transition (forward auto-close handles the GitHub close) and drop the separate "update workflow state" step. Doc-only; depends on Phase 1 so the docs never describe behavior that has not shipped.

### Changes Required

#### 1. Rewrite CLOSE verdict branches

**File**: `ralph/skills/caretake/modes/triage.md`
**Changes**: In the verdict table and the CLOSE branches (the research cites `:67-72` and `:103-110` — confirm current line numbers at impl time), rewrite so:
- `CLOSE-done → save_issue(workflowState: "Done", command: "ralph_triage")` (forward auto-close sets CLOSED/COMPLETED on GitHub).
- `CLOSE-canceled → save_issue(workflowState: "Canceled", command: "ralph_triage")` (forward auto-close sets CLOSED/NOT_PLANNED).
- Drop the now-redundant separate "update workflow state after close" step.

Add a one-line note that the inverse also holds (closing via `issueState` infers the terminal board state) so an agent closing by `issueState` no longer needs a follow-up board write.

### Success Criteria

#### Automated Verification
- [ ] `grep -n "workflowState: \"Done\"" ralph/skills/caretake/modes/triage.md` and `"Canceled"` both present in the CLOSE branches
- [ ] No remaining "then update the workflow state" style two-step CLOSE instruction in the file (manual grep review)

#### Manual Verification
- [ ] A reader of triage.md sees CLOSE expressed as a single `workflowState` transition with the auto-close behavior explained, consistent with Phase 1

## Testing Strategy

### Unit Tests
- Reverse-inference precedence matrix in the save_issue test file: CLOSED→Done, CLOSED_NOT_PLANNED→Canceled, OPEN→none, explicit-wins.
- Guard-widening structural test: close-only call writes board fields; metadata-only / reopen-only call does not.
- Confirm existing forward-auto-close tests still pass unchanged (regression guard for Desired End State #4).

### Integration Tests
- None new required; the change reuses the existing project-field mutation path already covered by the suite.

### Manual Testing Steps
1. Build (`npm run build`) and run the full suite (`npm test`).
2. Point the MCP server at a scratch project; create an issue, park it in "Human Needed".
3. `save_issue({issueState: "CLOSED_NOT_PLANNED"})` → verify GitHub closed-not-planned + board Canceled/Status Done.
4. Reopen, then `save_issue({issueState: "CLOSED", workflowState: "Backlog"})` → verify board stays Backlog.
5. `save_issue({workflowState: "Done"})` on another issue → verify it still auto-closes (forward path intact).

## Performance Considerations

Negligible. The inference adds a handful of comparisons in the handler; it reuses the existing aliased project-field batch mutation (no extra round-trip). A close-only call that previously made one issue mutation now also makes the project-field batch it should have made all along — one additional mutation, intended.

## Migration Notes

No schema or data migration. Behavior change only: close-only `save_issue` calls now also move the board to a terminal column. Existing callers that close via `issueState` and separately set `workflowState` are unaffected (explicit wins). Callers that relied on close leaving the board untouched would change behavior, but per Gap B that prior behavior is the bug being fixed.

## References

- Research: `thoughts/shared/research/2026-05-30-ralph-triage-autonomy-gaps.md` (Gap B, P0)
- `mcp-server/src/tools/issue-tools.ts:1185-1499` — `save_issue` handler
- `mcp-server/src/lib/workflow-states.ts:27` (`TERMINAL_STATES`), `:32-36` (`LOCK_STATES`)
- `ralph/skills/caretake/modes/triage.md` — CLOSE verdict branches
- Issue: https://github.com/cdubiel08/ralph-hero/issues/1471
