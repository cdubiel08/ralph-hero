---
date: 2026-02-27
github_issue: 432
github_url: https://github.com/cdubiel08/ralph-hero/issues/432
status: complete
type: research
---

# GH-432: team-stop-gate.sh Missing "In Review" State

## Problem Statement

When `ralph-team` processes an issue through the full pipeline, the team shuts down prematurely after the builder moves the issue to "In Review". The `team-stop-gate.sh` hook (which prevents the team lead from shutting down while processable work exists) does not include "In Review" in its list of monitored states, so it returns exit 0 (allow shutdown) even though the integrator still needs to merge the PR.

## Current State Analysis

### The Stop Gate Script

`plugin/ralph-hero/hooks/scripts/team-stop-gate.sh` (line 27):

```bash
STATES=("Backlog" "Research Needed" "Ready for Plan" "Plan in Review" "In Progress")
```

The script iterates over each state, queries GitHub issues filtered by that label/state, and sums up a `TOTAL_FOUND` count. If `TOTAL_FOUND > 0`, it blocks shutdown (exit 2). If `TOTAL_FOUND == 0`, it allows shutdown (exit 0).

"In Review" is absent from `STATES`. When an issue reaches "In Review" (PR created, awaiting review/merge), it contributes nothing to `TOTAL_FOUND`. If it's the only remaining work, the gate exits 0 and the team lead shuts down before the integrator can act.

There is also a re-entry guard at line 22: if `stop_hook_active == true`, the script skips all checks and exits 0 immediately. This prevents infinite stop-block loops.

### The Task Completion Hook

`plugin/ralph-hero/hooks/scripts/team-task-completed.sh` is a **logging-only** hook (always exits 0). It emits a stderr message when a task completes but does not create any follow-up tasks or call any APIs. The merge task creation is the team lead LLM's responsibility, triggered by reading the hook output and the ralph-team skill's "Add tasks incrementally" instruction.

### The Ralph-Team Skill

`plugin/ralph-hero/skills/ralph-team/SKILL.md` line 54-58 instructs the team lead to:

> Add tasks incrementally as phases complete rather than predicting the entire pipeline upfront. When a task completes, check if follow-up tasks for the next phase should be created.

> Hooks fire when tasks complete or teammates go idle. When a task completes, decide if the next phase is ready and create those tasks.

The skill explicitly covers NEEDS_ITERATION and validation failure cases but does not explicitly call out "When implementation completes and issue is In Review, create merge task for integrator." This is implicitly covered by the general "add tasks incrementally" instruction but could be made explicit.

### Why the Bug Occurs (Sequence)

1. Builder finishes impl → creates PR → moves issue to "In Review" → marks task complete
2. `team-task-completed.sh` fires → logs completion (exit 0, no action)
3. Team lead receives `TaskCompleted` event → should create merge task for integrator
4. However, before the team lead can act on this, stop gate fires
5. Stop gate checks STATES (no "In Review") → TOTAL_FOUND = 0 → exits 0 → team shuts down
6. Integrator never receives a merge task

## Key Discoveries

### File: `plugin/ralph-hero/hooks/scripts/team-stop-gate.sh:27`

The STATES array is the single source of truth for what the stop gate considers "processable". Adding "In Review" here is the minimal, sufficient fix.

### File: `plugin/ralph-hero/hooks/scripts/team-task-completed.sh:26`

This hook is informational only. It does not create tasks. The team lead LLM creates follow-up tasks based on the event notification.

### File: `plugin/ralph-hero/agents/ralph-integrator.md:20-22`

The integrator agent's instructions explicitly say: "For merging, verify the issue is in 'In Review' and find the PR link." The integrator is designed and ready to handle "In Review" issues — it just never gets the chance because the team shuts down first.

### File: `plugin/ralph-hero/skills/ralph-impl/SKILL.md:80-86`

The impl skill also handles "In Review" in Address Mode for PR review feedback — confirming "In Review" is a standard mid-pipeline state that the team must handle, not a terminal one.

## Potential Approaches

### Option A: Add "In Review" to STATES array (Recommended)

**Change**: `plugin/ralph-hero/hooks/scripts/team-stop-gate.sh` line 27:

```bash
STATES=("Backlog" "Research Needed" "Ready for Plan" "Plan in Review" "In Progress" "In Review")
```

**Pros**:
- Minimal, surgical fix (one line change)
- Directly addresses root cause
- No risk of side effects elsewhere
- Consistent with the stop gate's purpose: monitor all non-terminal processable states

**Cons**:
- None significant

### Option B: Add "In Review" + Explicit Merge Task Instruction in ralph-team skill

**Additional change**: Add explicit guidance in `ralph-team/SKILL.md` that when an implementation task completes and the issue is in "In Review", create a merge task for the integrator.

**Pros**:
- Makes the implicit behavior explicit, reducing LLM ambiguity
- Defensive improvement for edge cases where LLM might not infer merge task creation

**Cons**:
- SKILL.md change is additive/documentation risk
- The general "add tasks incrementally" instruction already covers this

## Recommendation

**Option A only** — single-line fix to `team-stop-gate.sh`. The task creation flow (team lead creating merge tasks) already works correctly per the ralph-team skill instructions. The problem is purely that the stop gate kills the team before the lead gets to act on the `TaskCompleted` event.

Optionally: If the skill edit is desired for clarity, it can be included, but it is not required to fix the bug.

## Risks

- **None for Option A**: Adding "In Review" to the STATES array only extends the stop gate's monitoring. It cannot cause false positives because "In Review" issues genuinely require integrator attention.
- **Re-entry guard**: The existing `stop_hook_active` re-entry guard (line 22) still prevents infinite loops. The gate will fire once, prompt the lead to check work, then allow stop on the second attempt if no action is taken.

## Files Affected

### Will Modify
- `plugin/ralph-hero/hooks/scripts/team-stop-gate.sh` - Add "In Review" to STATES array (line 27)

### Will Read (Dependencies)
- `plugin/ralph-hero/hooks/scripts/hook-utils.sh` - Shared hook utilities (block/allow/warn functions)
- `plugin/ralph-hero/hooks/scripts/team-task-completed.sh` - TaskCompleted hook (informational, no change needed)
- `plugin/ralph-hero/skills/ralph-team/SKILL.md` - Team lead skill instructions
- `plugin/ralph-hero/agents/ralph-integrator.md` - Integrator agent definition
