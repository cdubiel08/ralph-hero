---
date: 2026-02-21
status: draft
github_issues: [256]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/256
primary_issue: 256
---

# Activate Typed Agents and Add Worker Stop Hook - Atomic Implementation Plan

## Overview
Single issue (GH-256) to activate typed agent definitions for all 4 worker roles, slim agent definition bodies by removing redundant Task Loop sections, add a worker Stop hook (`worker-stop-gate.sh`) for work discovery, and remove the inline work-discovery line from `worker.md`.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-256 | Activate typed agents and add worker Stop hook for work discovery | S |

## Current State Analysis

Workers are spawned as `general-purpose` (SKILL.md:192-199, line 224), so the 4 agent definitions (`agents/ralph-*.md`) never load as system prompts. The role-specific knowledge (dispatch tables, PR/Merge procedures) is dead code. Workers rely on an inline instruction in `worker.md` line 7 ("Then check TaskList...") for work discovery between tasks, with no Stop hook to enforce it.

GH-255 (consolidate spawn templates) is CLOSED -- the single `worker.md` template is in place.

## Desired End State

### Verification
- [ ] SKILL.md spawn table (lines 190-199) shows role-specific agent types instead of `general-purpose`
- [ ] SKILL.md spawn procedure (line 224) uses `[agent-type-from-table]` instead of `general-purpose`
- [ ] All 4 agent definitions have Stop hook in frontmatter referencing `worker-stop-gate.sh`
- [ ] All 4 agent definitions have Task Loop sections removed
- [ ] Integrator agent preserves PR Creation Procedure, Merge Procedure, Serialization, and Shutdown sections
- [ ] `worker.md` line 7 (work-discovery instruction) is removed; template is 6 lines
- [ ] `worker-stop-gate.sh` exists with re-entry safety pattern, role-keyword mapping, and mcptools integration

## What We're NOT Doing
- Modifying `team-stop-gate.sh` (lead hook, unchanged)
- Modifying `team-teammate-idle.sh` (GH-258 scope)
- Modifying `team-task-completed.sh` (GH-257 scope)
- Modifying `conventions.md` (GH-258 scope)
- Adding new tools or MCP server changes
- Changing the spawn table column structure (Task Verb, Skill columns stay as-is from GH-255)

## Implementation Approach

All 7 file changes ship together because activating typed agents without the Stop hook would cause workers to stop after their first task (the work-discovery instruction in `worker.md` is removed, and the Task Loop in agent definitions is removed).

Order of changes:
1. Create `worker-stop-gate.sh` (new hook -- independent, no dependencies)
2. Slim 4 agent definitions (add Stop hook frontmatter, remove Task Loop)
3. Update SKILL.md spawn table and procedure (activate typed agents)
4. Remove work-discovery line from `worker.md`

---

## Phase 1: GH-256 - Activate Typed Agents and Add Worker Stop Hook
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/256 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0256-typed-agents-stop-hook.md

### Changes Required

#### 1. Create `worker-stop-gate.sh`
**File**: `hooks/scripts/worker-stop-gate.sh` (NEW)
**Changes**: New Stop hook for all worker agents. Uses Approach B (re-entry safety) from research.

```bash
#!/bin/bash
# ralph-hero/hooks/scripts/worker-stop-gate.sh
# Stop: Prevent workers from stopping while matching tasks exist
#
# When a worker finishes a task and tries to stop, this hook forces
# one re-check of TaskList before allowing the stop. Uses the same
# re-entry safety pattern as team-stop-gate.sh.
#
# Exit codes:
#   0 - Re-entry (already checked), allow stop
#   2 - First attempt, block stop with guidance

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

INPUT=$(cat)

# Re-entry safety: if the worker already checked and still wants to stop, allow it.
# This prevents infinite loops. Same pattern as team-stop-gate.sh:21-24.
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [[ "$STOP_HOOK_ACTIVE" == "true" ]]; then
  exit 0
fi

# Map worker name to task subject keywords for role-specific matching
TEAMMATE=$(echo "$INPUT" | jq -r '.teammate_name // "unknown"')
case "$TEAMMATE" in
  analyst*)    KEYWORDS="Triage, Split, or Research" ;;
  builder*)    KEYWORDS="Plan or Implement" ;;
  validator*)  KEYWORDS="Review or Validate" ;;
  integrator*) KEYWORDS="Create PR, Merge, or Integrate" ;;
  *)           exit 0 ;; # Unknown role, allow stop
esac

cat >&2 <<EOF
Before stopping, check TaskList for pending tasks matching your role.
Look for tasks with "$KEYWORDS" in the subject that are pending and unblocked.
If matching tasks exist, claim and process them.
If no matching tasks exist, you may stop.
EOF
exit 2
```

**Design notes**:
- Sources `hook-utils.sh` for consistency with other hooks
- Uses `stop_hook_active` re-entry safety (same pattern as `team-stop-gate.sh:21-24`)
- Maps `teammate_name` to keywords using glob pattern (`analyst*` matches `analyst`, `analyst-2`, `analyst-3`)
- Unknown roles are allowed to stop immediately (defense against misconfiguration)
- Guidance message tells the worker exactly what to search for in TaskList

#### 2. Update `agents/ralph-analyst.md`
**File**: `agents/ralph-analyst.md`
**Changes**: Add Stop hook to frontmatter, remove Task Loop section (lines 11-25), keep identity line and shutdown.

Replace entire file with:
```markdown
---
name: ralph-analyst
description: Analyst worker - composes triage, split, and research skills for issue assessment and investigation
tools: Read, Write, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue, ralph_hero__update_workflow_state, ralph_hero__update_estimate, ralph_hero__update_priority, ralph_hero__create_issue, ralph_hero__create_comment, ralph_hero__add_sub_issue, ralph_hero__add_dependency, ralph_hero__remove_dependency, ralph_hero__list_sub_issues, ralph_hero__list_dependencies, ralph_hero__detect_group
model: sonnet
color: green
hooks:
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/worker-stop-gate.sh"
---

You are an **ANALYST** in the Ralph Team.

**CRITICAL for SPLIT/TRIAGE**: Include ALL sub-ticket IDs and estimates in your TaskUpdate -- the lead needs them.

## Shutdown

If idle: approve. If mid-skill: reject, finish, then approve.
```

**Rationale**: The Task Loop (scan/claim/dispatch) is fully handled by the spawn template + Stop hook. The CRITICAL note about sub-ticket IDs is preserved because it's a behavioral constraint unique to the analyst role, not part of the generic loop.

#### 3. Update `agents/ralph-builder.md`
**File**: `agents/ralph-builder.md`
**Changes**: Add Stop hook to frontmatter, remove Task Loop section (lines 11-22), keep identity, revision handling, implementation notes, and shutdown.

Replace entire file with:
```markdown
---
name: ralph-builder
description: Builder worker - composes plan, implement, and self-review skills for the full build lifecycle
tools: Read, Write, Edit, Bash, Glob, Grep, Skill, Task, TaskList, TaskGet, TaskUpdate, SendMessage
model: sonnet
color: cyan
hooks:
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/worker-stop-gate.sh"
---

You are a **BUILDER** in the Ralph Team.

## Handling Revision Requests

If lead sends revision feedback (from reviewer rejection): read the feedback from the review task's description, re-invoke `ralph-plan` or manually update the plan, re-commit and update your task.

## Implementation Notes

- DO NOT push to remote for implementation -- integrator handles PR creation.
- If task description includes EXCLUSIVE FILE OWNERSHIP list: verify the skill only modified files in your list. Report conflicts to lead via SendMessage.

## Shutdown

Verify all work committed (`git status` in worktree), then approve.
```

**Rationale**: Preserves revision handling and "DO NOT push" constraint (role-specific behavioral rules). Task Loop removed since spawn template + Stop hook handle task discovery.

#### 4. Update `agents/ralph-validator.md`
**File**: `agents/ralph-validator.md`
**Changes**: Add Stop hook to frontmatter, remove Task Loop section (lines 11-19), keep identity, notes, and shutdown.

Replace entire file with:
```markdown
---
name: ralph-validator
description: Quality gate - invokes ralph-review skill for plan critique and future quality validation
tools: Read, Write, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage
model: opus
color: blue
hooks:
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/worker-stop-gate.sh"
---

You are a **VALIDATOR** in the Ralph Team.

**CRITICAL**: The lead cannot see your skill output. The FULL verdict MUST be in the task description.

## Notes

- Validator is optional. Only spawned when `RALPH_REVIEW_MODE=interactive`.
- In `skip` or `auto` mode, Builder handles review internally.

## Shutdown

If idle: approve. If mid-skill: reject, finish, then approve.
```

**Rationale**: The CRITICAL note about task description is preserved because the lead genuinely cannot see skill output -- this is a platform constraint, not a task loop instruction.

#### 5. Update `agents/ralph-integrator.md`
**File**: `agents/ralph-integrator.md`
**Changes**: Add Stop hook to frontmatter, remove Task Loop section (lines 11-18), keep PR Creation Procedure, Merge Procedure, Serialization, and Shutdown.

Replace entire file with:
```markdown
---
name: ralph-integrator
description: Integration specialist - handles PR creation, merge, worktree cleanup, and git operations for completed implementations
tools: Read, Glob, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue, ralph_hero__update_workflow_state, ralph_hero__create_comment, ralph_hero__advance_children, ralph_hero__advance_parent, ralph_hero__list_sub_issues
model: sonnet
color: orange
hooks:
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/worker-stop-gate.sh"
---

You are an **INTEGRATOR** in the Ralph Team.

## PR Creation Procedure

When task subject contains "Create PR":

1. Fetch issue: `get_issue(number)` -- extract title, group context
2. Determine worktree and branch:
   - **Single issue**: Worktree at `worktrees/GH-NNN`, branch `feature/GH-NNN`
   - **Group**: Worktree at `worktrees/GH-[PRIMARY]`, branch `feature/GH-[PRIMARY]`
3. Push branch: `git push -u origin [branch]` from the worktree directory
4. Create PR via `gh pr create`:
   - **Single issue**: Title: `feat: [title]`. Body: summary + `Closes #NNN` (bare `#NNN` is GitHub PR syntax) + change summary from task description.
   - **Group**: Body: summary + `Closes #NNN` for each issue (bare `#NNN` is GitHub PR syntax) + changes by phase.
5. Move ALL issues (and children) to "In Review" via `advance_children`. NEVER to "Done" -- that requires PR merge.
6. `TaskUpdate(taskId, status="completed", description="PR CREATED\nTicket: #NNN\nPR: [URL]\nBranch: [branch]\nState: In Review")`
7. **CRITICAL**: Full result MUST be in task description -- lead cannot see your command output.

## Merge Procedure

When task subject contains "Merge" or "Integrate":

1. Fetch issue: `get_issue(number)` -- verify In Review state, find PR link in comments
2. Check PR readiness: `gh pr view [N] --json state,reviews,mergeable,statusCheckRollup`
   - If not ready: report status, keep task in_progress, go idle (will be re-checked)
3. If ready:
   a. Merge: `gh pr merge [N] --merge --delete-branch`
   b. Clean worktree: `scripts/remove-worktree.sh GH-NNN` (from git root)
   c. Update state: `update_workflow_state(number, state="Done")` for each issue
   d. Advance parent (downward): `advance_children(parentNumber=EPIC)` if epic member
   e. Advance parent (upward): `advance_parent(number=ISSUE)` -- checks if all siblings are at a gate state and advances the parent if so
   f. Post comment: merge completion summary
4. `TaskUpdate(taskId, status="completed", description="MERGE COMPLETE\nTicket: #NNN\nPR: [URL] merged\nBranch: deleted\nWorktree: removed\nState: Done")`
5. **CRITICAL**: Full result MUST be in task description -- lead cannot see your command output.

## Serialization

Only one Integrator runs at a time. This is enforced by the orchestrator, not the agent. If you encounter merge conflicts, escalate to Human Needed.

## Shutdown

Approve unless mid-merge.
```

**Rationale**: PR Creation and Merge procedures are the integrator's core knowledge -- they have no skill to invoke, so the procedures must live in the agent definition. The Task Loop wrapper around these procedures is removed; the spawn template directs the integrator to "Check your task subject" and "Follow the corresponding procedure in your agent definition."

#### 6. Update SKILL.md spawn table and procedure
**File**: `skills/ralph-team/SKILL.md`
**Lines**: 190-199 (spawn table), 224 (spawn procedure)
**Changes**: Replace `general-purpose` with role-specific agent types.

**Spawn table** (lines 190-199) -- replace Agent type column values:

| Task subject contains | Role | Skill | Task Verb | Agent type |
|----------------------|------|-------|-----------|------------|
| "Triage" | analyst | ralph-triage | Triage | ralph-analyst |
| "Split" | analyst | ralph-split | Split | ralph-analyst |
| "Research" | analyst | ralph-research | Research | ralph-analyst |
| "Plan" (not "Review") | builder | ralph-plan | Plan | ralph-builder |
| "Review" | validator | ralph-review | Review plan for | ralph-validator |
| "Implement" | builder | ralph-impl | Implement | ralph-builder |
| "Create PR" | integrator | (none) | Integration task for | ralph-integrator |
| "Merge" or "Integrate" | integrator | (none) | Integration task for | ralph-integrator |

**Spawn procedure** (line 224) -- change `subagent_type`:

Current:
```
Task(subagent_type="general-purpose", team_name=TEAM_NAME, name="[role]",
```

Replace with:
```
Task(subagent_type="[agent-type-from-table]", team_name=TEAM_NAME, name="[role]",
```

(No other changes to SKILL.md -- the placeholder substitution, template integrity, naming conventions, and all other sections remain unchanged.)

#### 7. Update `worker.md` template
**File**: `templates/spawn/worker.md`
**Changes**: Remove line 7 (work-discovery instruction). Template goes from 7 lines to 6 lines.

Current (7 lines):
```
{TASK_VERB} GH-{ISSUE_NUMBER}: {TITLE}.
{TASK_CONTEXT}

Invoke: {SKILL_INVOCATION}

Report via TaskUpdate: "{REPORT_FORMAT}"
Then check TaskList for more tasks matching your role. If none, notify team-lead.
```

Replace with (6 lines):
```
{TASK_VERB} GH-{ISSUE_NUMBER}: {TITLE}.
{TASK_CONTEXT}

Invoke: {SKILL_INVOCATION}

Report via TaskUpdate: "{REPORT_FORMAT}"
```

**Rationale**: Work discovery is now handled by the Stop hook (`worker-stop-gate.sh`). When a worker finishes and tries to stop, the hook forces a TaskList re-check. The inline instruction was the only mechanism before; now the hook is the mechanism.

**Template Integrity update**: The "6-8 lines" guardrail in SKILL.md Section 6 (line 237) remains valid. The template is now 6 lines (at the lower end of the range). After placeholder substitution with empty `{TASK_CONTEXT}`, the resolved prompt will be 5 lines (below the range only when context is empty, which is acceptable).

### File Ownership Summary

| File | Changes |
|------|---------|
| `hooks/scripts/worker-stop-gate.sh` | New file -- Stop hook for all worker agents |
| `agents/ralph-analyst.md` | Add Stop hook frontmatter, remove Task Loop, keep CRITICAL note + shutdown |
| `agents/ralph-builder.md` | Add Stop hook frontmatter, remove Task Loop, keep revision handling + DO NOT push + shutdown |
| `agents/ralph-validator.md` | Add Stop hook frontmatter, remove Task Loop, keep CRITICAL note + notes + shutdown |
| `agents/ralph-integrator.md` | Add Stop hook frontmatter, remove Task Loop, keep PR/Merge procedures + serialization + shutdown |
| `skills/ralph-team/SKILL.md` | Spawn table: `general-purpose` -> role-specific. Spawn procedure: same change. |
| `templates/spawn/worker.md` | Remove line 7 (work-discovery instruction) |

### Success Criteria
- [ ] Automated: `grep -c "general-purpose" skills/ralph-team/SKILL.md` returns 0
- [ ] Automated: `grep "ralph-analyst\|ralph-builder\|ralph-validator\|ralph-integrator" skills/ralph-team/SKILL.md | wc -l` returns at least 8 (8 spawn table rows)
- [ ] Automated: `grep "worker-stop-gate" agents/ralph-analyst.md agents/ralph-builder.md agents/ralph-validator.md agents/ralph-integrator.md | wc -l` returns 4
- [ ] Automated: `grep -c "Task Loop" agents/ralph-analyst.md agents/ralph-builder.md agents/ralph-validator.md agents/ralph-integrator.md` returns 0 for all files
- [ ] Automated: `wc -l < templates/spawn/worker.md` returns 6
- [ ] Automated: `test -x hooks/scripts/worker-stop-gate.sh` passes (executable)
- [ ] Manual: `just team 256` spawns workers with typed agents (agent definitions load as system prompts)

---

## Integration Testing
- [ ] Verify `worker-stop-gate.sh` blocks first stop attempt with role-specific keywords
- [ ] Verify `worker-stop-gate.sh` allows second stop attempt (re-entry safety)
- [ ] Verify `worker-stop-gate.sh` allows stop for unknown teammate names
- [ ] Verify analyst agent loads with Stop hook and no Task Loop
- [ ] Verify builder agent loads with Stop hook, revision handling, and "DO NOT push" constraint
- [ ] Verify validator agent loads with Stop hook and CRITICAL note about task description
- [ ] Verify integrator agent loads with Stop hook, PR Creation, and Merge procedures
- [ ] Verify SKILL.md spawn table has correct agent types in all 8 rows
- [ ] Verify `worker.md` has no work-discovery instruction (6 lines total)

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0256-typed-agents-stop-hook.md
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/230
- Predecessor (GH-255): https://github.com/cdubiel08/ralph-hero/issues/255 (CLOSED)
- Successor (GH-257): https://github.com/cdubiel08/ralph-hero/issues/257 (bough model)
- Successor (GH-258): https://github.com/cdubiel08/ralph-hero/issues/258 (conventions cleanup)
