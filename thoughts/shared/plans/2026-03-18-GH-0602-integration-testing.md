---
date: 2026-03-18
status: draft
type: plan
tags: [integration-testing, ralph-val, smoke-tests]
github_issue: 602
github_issues: [602]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/602
primary_issue: 602
parent_plan: docs/superpowers/specs/2026-03-15-superpowers-ralph-hero-quality-integration-design.md
---

# Integration Testing & Validation — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create end-to-end test scenarios that verify the full tiered planning pipeline works, enhance `ralph-val` with cross-phase and drift log checks, and validate that all 7 prior plans integrate correctly.

**Architecture:** Integration testing happens at two levels: (1) MCP server unit tests for new state machine paths, (2) skill-level smoke tests that verify the SKILL.md documents produce correct behavior when invoked. `ralph-val` gets minor enhancements to check drift logs and cross-phase integration.

**Tech Stack:** TypeScript/Vitest (MCP tests), Bash (smoke tests), Markdown (ralph-val)

**Spec:** `docs/superpowers/specs/2026-03-15-superpowers-ralph-hero-quality-integration-design.md` Section 9

---

## Chunk 1: MCP Server Integration Tests

### Task 1: Add state machine integration tests for tiered planning paths

**Files:**
- Create: `plugin/ralph-hero/mcp-server/src/__tests__/tiered-planning.test.ts`

- [ ] **Step 1: Write failing tests for the full epic → feature → atomic state path**

```typescript
import { describe, it, expect } from "vitest";
import { resolveState, COMMAND_ALLOWED_STATES } from "../lib/state-resolution.js";
import { SKIP_ENTRY_STATES } from "../lib/workflow-states.js";

describe("tiered planning state paths", () => {
  describe("epic (3+ tier) path", () => {
    it("ralph_plan_epic locks to Plan in Progress", () => {
      const result = resolveState("__LOCK__", "ralph_plan_epic");
      expect(result.resolvedState).toBe("Plan in Progress");
    });

    it("ralph_plan_epic completes to In Progress", () => {
      const result = resolveState("__COMPLETE__", "ralph_plan_epic");
      expect(result.resolvedState).toBe("In Progress");
    });

    it("ralph_split can create children at Ready for Plan (from plan-of-plans)", () => {
      const result = resolveState("Ready for Plan", "ralph_split");
      expect(result.resolvedState).toBe("Ready for Plan");
    });

    it("ralph_split can create children at In Progress (from implementation plan)", () => {
      const result = resolveState("In Progress", "ralph_split");
      expect(result.resolvedState).toBe("In Progress");
    });

    it("ralph_plan can exit to In Progress (split-after-plan)", () => {
      const result = resolveState("In Progress", "ralph_plan");
      expect(result.resolvedState).toBe("In Progress");
    });
  });

  describe("SKIP_ENTRY_STATES mapping", () => {
    it("plan-of-plans children enter at Ready for Plan", () => {
      expect(SKIP_ENTRY_STATES["plan-of-plans"]).toBe("Ready for Plan");
    });

    it("implementation plan children enter at In Progress", () => {
      expect(SKIP_ENTRY_STATES["plan"]).toBe("In Progress");
    });
  });

  describe("full lifecycle simulation", () => {
    it("epic lifecycle: Ready for Plan → Plan in Progress → In Progress → Done", () => {
      // Lock
      expect(resolveState("__LOCK__", "ralph_plan_epic").resolvedState).toBe("Plan in Progress");
      // Complete (children being worked)
      expect(resolveState("__COMPLETE__", "ralph_plan_epic").resolvedState).toBe("In Progress");
      // Epic reaches Done via autoAdvanceParent (not tested here — that's helpers.ts)
    });

    it("feature lifecycle: Ready for Plan → Plan in Progress → Plan in Review → In Progress", () => {
      // Lock
      expect(resolveState("__LOCK__", "ralph_plan").resolvedState).toBe("Plan in Progress");
      // Complete (plan written, goes to review)
      expect(resolveState("__COMPLETE__", "ralph_plan").resolvedState).toBe("Plan in Review");
      // Review approves
      expect(resolveState("__COMPLETE__", "ralph_review").resolvedState).toBe("In Progress");
    });

    it("parent-planned atomic lifecycle: In Progress → In Review → Done", () => {
      // Atomic enters at In Progress (skipped R and P via parent plan)
      // Lock
      expect(resolveState("__LOCK__", "ralph_impl").resolvedState).toBe("In Progress");
      // Complete
      expect(resolveState("__COMPLETE__", "ralph_impl").resolvedState).toBe("In Review");
      // Merge
      expect(resolveState("__COMPLETE__", "ralph_merge").resolvedState).toBe("Done");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they pass (all state changes from Plans 1 should be in place)**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/tiered-planning.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/__tests__/tiered-planning.test.ts
git commit -m "test(state): add integration tests for tiered planning state paths"
```

---

## Chunk 2: Hook Integration Tests

### Task 2: Create tier-detection integration test

**Files:**
- Modify: `plugin/ralph-hero/hooks/scripts/__tests__/test-tier-detection.sh`

The basic unit tests exist from Plan 2. Add integration-style tests that simulate real issue scenarios.

- [ ] **Step 1: Add edge case tests to test-tier-detection.sh**

```bash
# Edge cases:

# XS with children (shouldn't happen but handle gracefully) → feature
result=$(detect_tier "XS" "true" "false")
[[ "$result" == "feature" ]] || { echo "FAIL: XS with children should be feature, got $result"; exit 1; }

# M with plan reference (child of epic, not yet split) → atomic
result=$(detect_tier "M" "false" "true")
[[ "$result" == "atomic" ]] || { echo "FAIL: M with plan ref should be atomic, got $result"; exit 1; }

# Empty estimate → standalone
result=$(detect_tier "" "false" "false")
[[ "$result" == "standalone" ]] || { echo "FAIL: empty estimate should be standalone, got $result"; exit 1; }

echo "ALL PASS (including edge cases)"
```

- [ ] **Step 2: Run tests**

Run: `bash plugin/ralph-hero/hooks/scripts/__tests__/test-tier-detection.sh`
Expected: ALL PASS (including edge cases)

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/hooks/scripts/__tests__/test-tier-detection.sh
git commit -m "test(hooks): add edge case tests for tier detection"
```

---

## Chunk 3: ralph-val Enhancements

### Task 3: Enhance ralph-val with drift log and cross-phase checks

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-val/SKILL.md`

- [ ] **Step 1: Add drift log verification to validation checks**

After the existing automated verification section, add:

```markdown
### Step 5.5: Drift Log Verification

Search issue comments for `## Drift Log — Phase N` headers.

For each drift log found:
1. Parse drift entries
2. For each minor drift: verify the adaptation is consistent with plan intent
3. For each entry: verify a `DRIFT:` commit message exists in the worktree git log
4. Flag any undocumented drift (files changed that aren't in any task's file list AND have no DRIFT: commit)

Report drift summary in validation output:
```
Drift Analysis:
- Phase 1: 2 minor drifts (documented)
- Phase 2: 0 drifts
- Undocumented changes: none
```
```

- [ ] **Step 2: Add cross-phase integration check**

```markdown
### Step 5.6: Cross-Phase Integration Check (multi-phase plans only)

If the plan has more than one phase:
1. Verify each phase's "Creates for next phase" items actually exist
2. Check imports between phase outputs (Phase 1 exports used by Phase 2)
3. Run the plan's `## Integration Testing` section checks if they exist

Report integration status:
```
Cross-Phase Integration:
- Phase 1 → Phase 2: types.ts exports used correctly ✓
- Phase 2 → Phase 3: parser.ts interface matches ✓
- Integration tests: 3/3 passing ✓
```
```

- [ ] **Step 3: Update validation report format**

Add drift and integration sections to the `## Validation` comment:

```markdown
## Validation

Overall: PASS

### Automated Checks:
- [x] npm test — 47/47 passing
- [x] npm run build — no errors

### Drift Analysis:
- Phase 1: 1 minor drift (documented)
- Undocumented changes: none

### Cross-Phase Integration:
- All phase outputs verified ✓
```

- [ ] **Step 4: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-val/SKILL.md
git commit -m "feat(ralph-val): add drift log verification and cross-phase integration checks"
```

---

## Chunk 4: Smoke Test Scenarios

### Task 4: Create smoke test documentation

**Files:**
- Create: `plugin/ralph-hero/skills/shared/integration-test-scenarios.md`

- [ ] **Step 1: Write integration test scenario document**

```markdown
# Integration Test Scenarios — Tiered Planning

Manual verification scenarios for the full tiered planning pipeline.
Run these after all plans (1-7) are implemented.

## Scenario 1: Standalone XS Issue (1 tier)

1. Create XS issue: "Add type guard for StreamConfig"
2. Run through: research → plan → review → impl → val → pr → merge
3. Verify:
   - Plan has task-level metadata (tdd, complexity, depends_on, acceptance)
   - ralph-impl dispatches implementer subagent with TDD protocol
   - Task reviewer checks acceptance criteria
   - Phase reviewer runs holistic code quality check
   - ralph-val passes all automated checks

## Scenario 2: Feature with Atomic Children (2 tiers)

1. Create M issue: "Add stream configuration support"
2. Run through: research → plan (produces multi-phase plan) → split (creates XS children)
3. Verify:
   - Plan has multiple phases, one per atomic child
   - Split creates children at "In Progress" (skipping R and P)
   - Each child has ## Plan Reference comment
   - Children reference specific phase of parent plan
   - Implementation uses TDD subagents per task
   - Parent auto-advances to Done when all children Done

## Scenario 3: Epic with Feature Children (3 tiers)

1. Create L issue: "Redesign pipeline processing"
2. Run through: research → plan-epic (plan-of-plans) → split (creates M features) → feature planning in waves
3. Verify:
   - Plan-of-plans has Feature Decomposition and Feature Sequencing
   - Feature children created at "Ready for Plan"
   - Wave 1 features planned in parallel
   - Wave 2 features receive sibling context from Wave 1 plans
   - Each feature plan produces atomic children at "In Progress"
   - All atomic children have ## Plan Reference comments
   - Epic state is "In Progress" (tracking children)

## Scenario 4: Drift During Implementation

1. Take any in-progress atomic issue
2. During implementation, simulate:
   a. Minor drift: rename a file that the plan references by old name
   b. Verify implementer logs DRIFT: in commit message
   c. Verify drift-tracker.sh emits warning
   d. Verify ## Drift Log comment posted at phase completion
3. Simulate major drift:
   a. Implementer reports BLOCKED
   b. Verify controller assesses and escalates appropriately

## Scenario 5: Hero Mode with Tiered Issue

1. Invoke hero on an L issue
2. Verify:
   - Hero invokes ralph-plan-epic via Skill() (not Agent())
   - ralph-plan-epic writes plan-of-plans
   - ralph-plan-epic invokes ralph-plan per feature via Skill()
   - ralph-impl dispatches subagents (one level deep from hero's context)
   - Full pipeline completes without nesting errors

## Scenario 6: Team Mode with Tiered Issue

1. Invoke team on an L issue
2. Verify:
   - Analyst worker handles triage + plan-epic
   - Builder workers handle implementation with subagent dispatch
   - Integrator validates and merges
   - Parallel builders don't conflict (worktree isolation + lock states)
```

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-hero/skills/shared/integration-test-scenarios.md
git commit -m "docs(test): add integration test scenarios for tiered planning pipeline"
```

---

## Final Verification

- [ ] **Run full MCP server test suite**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: ALL PASS

- [ ] **Run tier-detection tests**

Run: `bash plugin/ralph-hero/hooks/scripts/__tests__/test-tier-detection.sh`
Expected: ALL PASS

- [ ] **Verify all plan documents exist**

```bash
ls -la docs/superpowers/plans/2026-03-1*plan-*.md
```
Expected: 8 plan files

---

## Summary of Changes

| File | Type | What Changed |
|------|------|-------------|
| `mcp-server/src/__tests__/tiered-planning.test.ts` | Created | State machine integration tests for all tiered planning paths |
| `hooks/scripts/__tests__/test-tier-detection.sh` | Modified | Edge case tests for tier detection |
| `skills/ralph-val/SKILL.md` | Modified | Drift log verification, cross-phase integration checks |
| `skills/shared/integration-test-scenarios.md` | Created | Manual smoke test scenarios for full pipeline verification |
