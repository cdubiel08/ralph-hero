# State Machine & MCP Server Changes — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register `ralph_plan_epic` as a new command, expand `ralph_split` and `ralph_plan` allowed states for tiered planning, and add skip-entry-state logic for parent-planned children.

**Architecture:** Three files change in lockstep: `ralph-state-machine.json` (source of truth), `state-resolution.ts` (hardcoded mirror with resolveState), and `workflow-states.ts` (new SKIP_ENTRY_STATES export). An existing cross-file drift test ensures JSON and TS stay in sync.

**Tech Stack:** TypeScript, Vitest, JSON

**Spec:** `docs/superpowers/specs/2026-03-15-superpowers-ralph-hero-quality-integration-design.md` Section 2

---

## Chunk 1: Register `ralph_plan_epic` command

### Task 1: Add `ralph_plan_epic` to state-resolution.ts — SEMANTIC_INTENTS

**Files:**
- Modify: `plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts:12-30`
- Test: `plugin/ralph-hero/mcp-server/src/__tests__/state-resolution.test.ts`

- [ ] **Step 1: Write failing test — __LOCK__ resolves for ralph_plan_epic**

```typescript
// In state-resolution.test.ts, inside "resolveState - semantic intents" describe block
// Add after the existing "__LOCK__" test (after line 32):

it("resolves __LOCK__ for ralph_plan_epic", () => {
  expect(resolveState("__LOCK__", "ralph_plan_epic").resolvedState).toBe(
    "Plan in Progress",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/state-resolution.test.ts -t "resolves __LOCK__ for ralph_plan_epic"`
Expected: FAIL with `Unknown command "ralph_plan_epic"`

- [ ] **Step 3: Add ralph_plan_epic to SEMANTIC_INTENTS**

In `state-resolution.ts`, modify `SEMANTIC_INTENTS`:

```typescript
const SEMANTIC_INTENTS: Record<string, Record<string, string | null>> = {
  __LOCK__: {
    ralph_research: "Research in Progress",
    ralph_plan: "Plan in Progress",
    ralph_plan_epic: "Plan in Progress",
    ralph_impl: "In Progress",
  },
  __COMPLETE__: {
    ralph_triage: null, // multi-path: caller must use direct state
    ralph_split: "Backlog",
    ralph_research: "Ready for Plan",
    ralph_plan: "Plan in Review",
    ralph_plan_epic: "In Progress",
    ralph_impl: "In Review",
    ralph_review: "In Progress",
    ralph_merge: "Done",
  },
  __ESCALATE__: { "*": "Human Needed" },
  __CLOSE__: { "*": "Done" },
  __CANCEL__: { "*": "Canceled" },
};
```

- [ ] **Step 4: Run test to verify it still fails (command not yet in COMMAND_ALLOWED_STATES)**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/state-resolution.test.ts -t "resolves __LOCK__ for ralph_plan_epic"`
Expected: FAIL with `Unknown command "ralph_plan_epic"` (because COMMAND_ALLOWED_STATES doesn't have it yet)

---

### Task 2: Add `ralph_plan_epic` to state-resolution.ts — COMMAND_ALLOWED_STATES

**Files:**
- Modify: `plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts:34-49`
- Test: `plugin/ralph-hero/mcp-server/src/__tests__/state-resolution.test.ts`

- [ ] **Step 1: Add ralph_plan_epic to COMMAND_ALLOWED_STATES**

```typescript
const COMMAND_ALLOWED_STATES: Record<string, string[]> = {
  ralph_triage: [
    "Research Needed",
    "Ready for Plan",
    "Done",
    "Canceled",
    "Human Needed",
  ],
  ralph_split: ["Backlog"],
  ralph_research: ["Research in Progress", "Ready for Plan", "Human Needed"],
  ralph_plan: ["Plan in Progress", "Plan in Review", "Human Needed"],
  ralph_plan_epic: ["Plan in Progress", "In Progress", "Human Needed"],
  ralph_impl: ["In Progress", "In Review", "Human Needed"],
  ralph_review: ["In Progress", "Ready for Plan", "Human Needed"],
  ralph_hero: ["In Review", "Human Needed"],
  ralph_merge: ["Done", "Human Needed"],
};
```

- [ ] **Step 2: Run the __LOCK__ test to verify it now passes**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/state-resolution.test.ts -t "resolves __LOCK__ for ralph_plan_epic"`
Expected: PASS

- [ ] **Step 3: Write test — __COMPLETE__ resolves for ralph_plan_epic**

```typescript
// In "resolves __COMPLETE__ for commands with single completion target" test
// Add after line 68 (after ralph_merge):

expect(resolveState("__COMPLETE__", "ralph_plan_epic").resolvedState).toBe(
  "In Progress",
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/state-resolution.test.ts -t "resolves __COMPLETE__ for commands with single completion target"`
Expected: PASS (already implemented in Step 1 of Task 1)

- [ ] **Step 5: Write test — direct state validation for ralph_plan_epic**

```typescript
// In "resolveState - direct state names" describe block, add:

it("accepts valid output states for ralph_plan_epic", () => {
  expect(resolveState("Plan in Progress", "ralph_plan_epic").resolvedState).toBe(
    "Plan in Progress",
  );
  expect(resolveState("In Progress", "ralph_plan_epic").resolvedState).toBe(
    "In Progress",
  );
  expect(resolveState("Human Needed", "ralph_plan_epic").resolvedState).toBe(
    "Human Needed",
  );
});

it("rejects invalid output states for ralph_plan_epic", () => {
  expect(() => resolveState("Plan in Review", "ralph_plan_epic")).toThrow(
    /not a valid output for ralph_plan_epic/i,
  );
  expect(() => resolveState("Done", "ralph_plan_epic")).toThrow(
    /not a valid output for ralph_plan_epic/i,
  );
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/state-resolution.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts plugin/ralph-hero/mcp-server/src/__tests__/state-resolution.test.ts
git commit -m "feat(state): register ralph_plan_epic command in state resolution"
```

---

### Task 3: Add `ralph_plan_epic` to ralph-state-machine.json

**Files:**
- Modify: `plugin/ralph-hero/hooks/scripts/ralph-state-machine.json`
- Test: `plugin/ralph-hero/mcp-server/src/__tests__/state-resolution.test.ts` (drift test)

- [ ] **Step 1: Add ralph_plan_epic command to commands section**

In `ralph-state-machine.json`, add after the `ralph_plan` command block (after line 160):

```json
    "ralph_plan_epic": {
      "description": "Strategic planning for 3+ tier work — writes plan-of-plans, orchestrates feature planning",
      "valid_input_states": ["Ready for Plan"],
      "valid_output_states": ["In Progress", "Human Needed"],
      "lock_state": "Plan in Progress",
      "creates_artifacts": ["thoughts/shared/plans/YYYY-MM-DD-GH-{issue_number}-*.md"],
      "preconditions": [
        "Must be on main branch",
        "Issue must be in Ready for Plan state",
        "Research document must be attached"
      ],
      "postconditions": [
        "Plan-of-plans document created and committed",
        "Feature children created via ralph_split",
        "Feature children planned via ralph_plan",
        "Issue moved to In Progress (children being worked)"
      ]
    },
```

- [ ] **Step 2: Add ralph_plan_epic to semantic_states**

In `ralph-state-machine.json`, update the `semantic_states` section:

```json
  "semantic_states": {
    "description": "Mappings from semantic intents to actual states per command",
    "__LOCK__": {
      "ralph_research": "Research in Progress",
      "ralph_plan": "Plan in Progress",
      "ralph_plan_epic": "Plan in Progress",
      "ralph_impl": "In Progress"
    },
    "__COMPLETE__": {
      "ralph_triage": null,
      "ralph_research": "Ready for Plan",
      "ralph_plan": "Plan in Review",
      "ralph_plan_epic": "In Progress",
      "ralph_impl": "In Review",
      "ralph_review": "In Progress",
      "ralph_split": "Backlog",
      "ralph_merge": "Done"
    },
    "__ESCALATE__": {
      "*": "Human Needed"
    },
    "__CLOSE__": {
      "*": "Done"
    },
    "__CANCEL__": {
      "*": "Canceled"
    }
  },
```

- [ ] **Step 3: Update states section — add ralph_plan_epic to produces_for_commands**

In the `"Ready for Plan"` state (line 26-31), add `ralph_plan_epic` to `required_by_commands`:

```json
    "Ready for Plan": {
      "description": "Research complete, ready for implementation planning",
      "allowed_transitions": ["Plan in Progress", "Human Needed"],
      "required_by_commands": ["ralph_plan", "ralph_plan_epic"],
      "produces_for_commands": ["ralph_research"]
    },
```

In the `"Plan in Progress"` state (line 32-38), add `ralph_plan_epic` to `produces_for_commands`:

```json
    "Plan in Progress": {
      "description": "Plan actively being created (LOCKED)",
      "allowed_transitions": ["Plan in Review", "In Progress", "Human Needed"],
      "required_by_commands": [],
      "produces_for_commands": ["ralph_plan", "ralph_plan_epic"],
      "is_lock_state": true
    },
```

Note: `Plan in Progress` gains `"In Progress"` in `allowed_transitions` because `ralph_plan_epic` exits to `In Progress` (via `__COMPLETE__`).

In the `"In Progress"` state (line 46-51), add `ralph_plan_epic` to `produces_for_commands`:

```json
    "In Progress": {
      "description": "Implementation actively underway",
      "allowed_transitions": ["In Review", "Human Needed"],
      "required_by_commands": ["ralph_impl"],
      "produces_for_commands": ["ralph_plan_epic", "ralph_review"]
    },
```

- [ ] **Step 4: Run drift tests to verify JSON and TS are in sync**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/state-resolution.test.ts -t "data consistency"`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add plugin/ralph-hero/hooks/scripts/ralph-state-machine.json
git commit -m "feat(state): add ralph_plan_epic to state machine JSON"
```

---

## Chunk 2: Expand `ralph_split` and `ralph_plan` for tiered planning

### Task 4: Update `ralph_split` allowed states for parent-planned children

**Files:**
- Modify: `plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts:20,42`
- Test: `plugin/ralph-hero/mcp-server/src/__tests__/state-resolution.test.ts`

- [ ] **Step 1: Write failing test — ralph_split __COMPLETE__ still resolves to Backlog (current default)**

```typescript
// This test already passes (line 63-65). Write a NEW test for the expanded states:

it("accepts In Progress and Ready for Plan as direct states for ralph_split", () => {
  expect(resolveState("In Progress", "ralph_split").resolvedState).toBe(
    "In Progress",
  );
  expect(resolveState("Ready for Plan", "ralph_split").resolvedState).toBe(
    "Ready for Plan",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/state-resolution.test.ts -t "accepts In Progress and Ready for Plan as direct states for ralph_split"`
Expected: FAIL with `State "In Progress" is not a valid output for ralph_split`

- [ ] **Step 3: Update COMMAND_ALLOWED_STATES for ralph_split**

In `state-resolution.ts`, change line 42:

```typescript
  ralph_split: ["Backlog", "In Progress", "Ready for Plan"],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/state-resolution.test.ts -t "accepts In Progress and Ready for Plan as direct states for ralph_split"`
Expected: PASS

- [ ] **Step 5: Write test — __COMPLETE__ for ralph_split still resolves to Backlog (backward compat)**

```typescript
// Verify existing test still passes:
it("__COMPLETE__ for ralph_split still defaults to Backlog", () => {
  expect(resolveState("__COMPLETE__", "ralph_split").resolvedState).toBe(
    "Backlog",
  );
});
```

- [ ] **Step 6: Run test — confirm backward compatibility**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/state-resolution.test.ts -t "__COMPLETE__ for ralph_split still defaults to Backlog"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts plugin/ralph-hero/mcp-server/src/__tests__/state-resolution.test.ts
git commit -m "feat(state): expand ralph_split allowed outputs for parent-planned children"
```

---

### Task 5: Update `ralph_plan` allowed states for split-after-plan

**Files:**
- Modify: `plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts:44`
- Test: `plugin/ralph-hero/mcp-server/src/__tests__/state-resolution.test.ts`

- [ ] **Step 1: Write failing test — ralph_plan accepts In Progress as direct state**

```typescript
it("accepts In Progress as direct state for ralph_plan (split-after-plan)", () => {
  expect(resolveState("In Progress", "ralph_plan").resolvedState).toBe(
    "In Progress",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/state-resolution.test.ts -t "accepts In Progress as direct state for ralph_plan"`
Expected: FAIL with `State "In Progress" is not a valid output for ralph_plan`

- [ ] **Step 3: Add In Progress to ralph_plan COMMAND_ALLOWED_STATES**

In `state-resolution.ts`, change line 44:

```typescript
  ralph_plan: ["Plan in Progress", "Plan in Review", "In Progress", "Human Needed"],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/state-resolution.test.ts -t "accepts In Progress as direct state for ralph_plan"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts plugin/ralph-hero/mcp-server/src/__tests__/state-resolution.test.ts
git commit -m "feat(state): add In Progress to ralph_plan outputs for split-after-plan"
```

---

### Task 6: Update ralph-state-machine.json for ralph_split and ralph_plan changes

**Files:**
- Modify: `plugin/ralph-hero/hooks/scripts/ralph-state-machine.json`
- Test: `plugin/ralph-hero/mcp-server/src/__tests__/state-resolution.test.ts` (drift test)

- [ ] **Step 1: Update ralph_split in JSON**

In `ralph-state-machine.json`, update the `ralph_split` command (lines 103-120):

```json
    "ralph_split": {
      "description": "Decompose large tickets into sub-tickets. When splitting from a plan, children enter at appropriate states based on parent plan context.",
      "valid_input_states": ["Backlog", "Research Needed", "Plan in Review"],
      "valid_output_states": ["Backlog", "In Progress", "Ready for Plan"],
      "valid_input_estimates": ["M", "L", "XL"],
      "can_create_tickets": true,
      "can_modify_blocks": true,
      "preconditions": [
        "Must be on main branch",
        "Ticket estimate must be M/L/XL",
        "Ticket must be in Backlog, Research Needed, or Plan in Review"
      ],
      "postconditions": [
        "Sub-tickets created with appropriate estimates",
        "Parent ticket state updated",
        "Blocking relationships established",
        "If parent has plan: children get ## Plan Reference comments"
      ]
    },
```

- [ ] **Step 2: Update ralph_plan in JSON**

In `ralph-state-machine.json`, update the `ralph_plan` command (lines 140-160):

```json
    "ralph_plan": {
      "description": "Create implementation plan from research. For M issues with children, splits after planning and exits to In Progress.",
      "valid_input_states": ["Ready for Plan"],
      "valid_output_states": ["Plan in Review", "In Progress", "Human Needed"],
      "valid_input_estimates": ["XS", "S", "M"],
      "lock_state": "Plan in Progress",
      "requires_artifacts": ["Research document attached"],
      "creates_artifacts": ["thoughts/shared/plans/YYYY-MM-DD-GH-{issue_number}-*.md"],
      "preconditions": [
        "Must be on main branch",
        "Ticket must be in Ready for Plan state",
        "Research document must be attached",
        "No existing plan document attached"
      ],
      "postconditions": [
        "Plan document created and committed",
        "Plan URL posted as comment on ticket",
        "If standalone: ticket moved to Plan in Review",
        "If splitting: children created, ticket moved to In Progress"
      ]
    },
```

Note: `valid_input_estimates` now includes `"M"` because `ralph-plan` handles the bottom 2 tiers (Feature + Atomic).

- [ ] **Step 3: Update Plan in Review state — add ralph_split to required_by_commands**

```json
    "Plan in Review": {
      "description": "Plan awaiting human approval or split into children",
      "allowed_transitions": ["In Progress", "Ready for Plan", "Human Needed"],
      "required_by_commands": ["ralph_review", "ralph_split"],
      "produces_for_commands": ["ralph_plan", "ralph_review"],
      "requires_human_action": true
    },
```

- [ ] **Step 4: Run drift tests**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/state-resolution.test.ts -t "data consistency"`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add plugin/ralph-hero/hooks/scripts/ralph-state-machine.json
git commit -m "feat(state): update JSON for ralph_split and ralph_plan tiered planning"
```

---

## Chunk 3: Add SKIP_ENTRY_STATES to workflow-states.ts

### Task 7: Add SKIP_ENTRY_STATES export

**Files:**
- Modify: `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts`
- Test: `plugin/ralph-hero/mcp-server/src/__tests__/workflow-states.test.ts`

- [ ] **Step 1: Write failing test — SKIP_ENTRY_STATES exported and has correct structure**

```typescript
// In workflow-states.test.ts, add a new describe block:

import {
  // ... existing imports ...
  SKIP_ENTRY_STATES,
} from "../lib/workflow-states.js";

describe("SKIP_ENTRY_STATES", () => {
  it("maps parent plan context to child entry states", () => {
    expect(SKIP_ENTRY_STATES).toEqual({
      "plan-of-plans": "Ready for Plan",
      "plan": "In Progress",
    });
  });

  it("plan-of-plans children enter at Ready for Plan", () => {
    expect(SKIP_ENTRY_STATES["plan-of-plans"]).toBe("Ready for Plan");
  });

  it("implementation plan children enter at In Progress", () => {
    expect(SKIP_ENTRY_STATES["plan"]).toBe("In Progress");
  });

  it("all entry states are valid workflow states", () => {
    for (const state of Object.values(SKIP_ENTRY_STATES)) {
      expect(isValidState(state)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/workflow-states.test.ts -t "SKIP_ENTRY_STATES"`
Expected: FAIL with import error (SKIP_ENTRY_STATES not exported)

- [ ] **Step 3: Add SKIP_ENTRY_STATES to workflow-states.ts**

Add after `WORKFLOW_STATE_TO_STATUS` (after line 130):

```typescript

/**
 * Maps parent plan document type to the entry state for children
 * created by ralph_split from that plan.
 *
 * When a parent issue has a plan-of-plans, its feature children
 * skip to "Ready for Plan" (they need their own detailed plan).
 *
 * When a parent issue has an implementation plan, its atomic children
 * skip to "In Progress" (the plan already covers their implementation).
 */
export const SKIP_ENTRY_STATES: Record<string, string> = {
  "plan-of-plans": "Ready for Plan",
  "plan": "In Progress",
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/workflow-states.test.ts -t "SKIP_ENTRY_STATES"`
Expected: PASS

- [ ] **Step 5: Run full test suite to catch regressions**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts plugin/ralph-hero/mcp-server/src/__tests__/workflow-states.test.ts
git commit -m "feat(state): add SKIP_ENTRY_STATES for parent-planned children"
```

---

## Chunk 4: Add plan-of-plans artifact pattern to JSON

### Task 8: Register plan-of-plans artifact pattern

**Files:**
- Modify: `plugin/ralph-hero/hooks/scripts/ralph-state-machine.json`

- [ ] **Step 1: Add plan-of-plans artifact pattern**

In `ralph-state-machine.json`, add to the `artifact_patterns` section (after line 240):

```json
    "plan_of_plans_document": {
      "path_pattern": "thoughts/shared/plans/YYYY-MM-DD-GH-{issue_number}-*.md",
      "frontmatter_type": "plan-of-plans",
      "uniqueness": "One per epic per day",
      "created_by": ["ralph_plan_epic"]
    },
```

- [ ] **Step 2: Run full test suite**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: ALL PASS (JSON changes don't break TS tests — artifact_patterns aren't validated by drift tests)

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/hooks/scripts/ralph-state-machine.json
git commit -m "feat(state): add plan-of-plans artifact pattern to state machine JSON"
```

---

## Final Verification

- [ ] **Run full test suite one final time**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: ALL PASS

- [ ] **Verify no untracked files**

Run: `git status`
Expected: clean working tree

---

## Summary of Changes

| File | Lines Changed | What Changed |
|------|--------------|-------------|
| `state-resolution.ts:12-30` | +2 lines | Added `ralph_plan_epic` to `__LOCK__` and `__COMPLETE__` in `SEMANTIC_INTENTS` |
| `state-resolution.ts:34-49` | +2 lines | Added `ralph_plan_epic` entry and expanded `ralph_split`, `ralph_plan` in `COMMAND_ALLOWED_STATES` |
| `workflow-states.ts:131+` | +12 lines | New `SKIP_ENTRY_STATES` export |
| `ralph-state-machine.json` | ~40 lines | New `ralph_plan_epic` command, updated `ralph_split`/`ralph_plan` commands, updated state metadata, new artifact pattern |
| `state-resolution.test.ts` | ~30 lines | Tests for new command, expanded states |
| `workflow-states.test.ts` | ~20 lines | Tests for `SKIP_ENTRY_STATES` |
