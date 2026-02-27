---
date: 2026-02-27
status: draft
github_issues: [432]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/432
primary_issue: 432
---

# Fix team-stop-gate.sh Missing "In Review" State - Implementation Plan

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-432 | team-stop-gate.sh missing "In Review" causes team shutdown before integrator can merge | XS |

## Current State Analysis

`plugin/ralph-hero/hooks/scripts/team-stop-gate.sh` line 27 defines the workflow states that the stop gate monitors to prevent premature team shutdown:

```bash
STATES=("Backlog" "Research Needed" "Ready for Plan" "Plan in Review" "In Progress")
```

"In Review" is missing. When a builder moves an issue to "In Review" after creating a PR, the stop gate sees no processable issues and allows the team lead to shut down — before the integrator can create merge tasks and complete the pipeline.

## Desired End State

### Verification
- [x] `team-stop-gate.sh` STATES array includes "In Review"
- [x] Team stays alive when issues are in "In Review" state
- [x] Existing re-entry guard still works (stop_hook_active bypass)
- [x] No other workflow states are accidentally excluded

## What We're NOT Doing

- Not modifying `team-task-completed.sh` (it's logging-only by design; task creation is the team lead LLM's job)
- Not modifying `ralph-team/SKILL.md` (the "add tasks incrementally" instruction already covers merge task creation implicitly)
- Not adding new states beyond "In Review" (all other non-terminal states are already present)

## Implementation Approach

Single-line change: append `"In Review"` to the STATES array in `team-stop-gate.sh`.

---

## Phase 1: Add "In Review" to team-stop-gate.sh STATES array
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/432 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0432-team-stop-gate-missing-in-review.md

### Changes Required

#### 1. Add "In Review" to STATES array
**File**: `plugin/ralph-hero/hooks/scripts/team-stop-gate.sh`
**Line**: 27
**Change**: Add `"In Review"` to the end of the STATES array

Before:
```bash
STATES=("Backlog" "Research Needed" "Ready for Plan" "Plan in Review" "In Progress")
```

After:
```bash
STATES=("Backlog" "Research Needed" "Ready for Plan" "Plan in Review" "In Progress" "In Review")
```

### Success Criteria

- [x] Automated: `grep -q '"In Review"' plugin/ralph-hero/hooks/scripts/team-stop-gate.sh` exits 0
- [x] Automated: `bash -n plugin/ralph-hero/hooks/scripts/team-stop-gate.sh` exits 0 (syntax valid)
- [x] Manual: STATES array contains exactly 6 entries: Backlog, Research Needed, Ready for Plan, Plan in Review, In Progress, In Review
- [x] Manual: No other lines in the file are changed

## Integration Testing

- [x] Run `bash -n plugin/ralph-hero/hooks/scripts/team-stop-gate.sh` to verify syntax
- [x] Verify the script still sources `hook-utils.sh` correctly
- [x] Confirm the re-entry guard (lines 19-24) is untouched

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0432-team-stop-gate-missing-in-review.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/432
- Workflow states definition: `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts`
