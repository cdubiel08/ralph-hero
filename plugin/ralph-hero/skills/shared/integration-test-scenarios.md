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

## Scenario 7: Legacy Plan Backward Compatibility

1. Take an existing plan WITHOUT ### Tasks sections
2. Run ralph-impl on it
3. Verify:
   - Falls back to monolithic implementation (Step 6.5 detects no tasks)
   - Skips subagent dispatch, implements directly
   - All existing hooks still enforce constraints
   - No regressions in basic impl flow
