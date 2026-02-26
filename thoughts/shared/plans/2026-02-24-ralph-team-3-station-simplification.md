---
date: 2026-02-24
status: draft
github_issues: [393]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/393
primary_issue: 393
---

# Ralph Team 3-Station Simplification

## Overview

Consolidate the ralph-team orchestrator from 4 worker stations (analyst, builder, validator, integrator) to 3 stations by eliminating the validator role. Plan creation moves to analyst, plan review moves to builder, and post-implementation validation moves to integrator via a new `ralph-val` skill. Max spawns per station: 2.

## Current State Analysis

The ralph-team skill (`skills/ralph-team/SKILL.md`) orchestrates 4 typed agents:

| Station | Agent | Skills | Max |
|---------|-------|--------|-----|
| analyst | `ralph-analyst` | triage, split, research | N |
| builder | `ralph-builder` | plan, implement | N |
| validator | `ralph-validator` | review (optional, `RALPH_REVIEW_MODE=interactive`) | 1 |
| integrator | `ralph-integrator` | PR creation, merge | 1 (serialized) |

**Key issues with the 4-station model:**
- Validator is rarely used (only in interactive review mode, which is almost never set)
- Plan review as a separate station creates unnecessary coordination overhead
- Builder has context pollution — it writes the plan AND implements it in the same role
- Integrator has no quality gate before PR/merge

### Key Discoveries:
- `worker-stop-gate.sh:27-33` maps worker names to task keywords via case statement
- `SKILL.md:73-80` defines the 4-station roster table
- `SKILL.md:80` enforces "One validator, one integrator" constraint
- `ralph-validator.md:36` notes validator is optional with `RALPH_REVIEW_MODE=interactive`
- `ralph-integrator.md:60` states "Only one Integrator runs at a time" — enforced by orchestrator, not agent
- All agents follow the same `Task()` → `Skill()` pattern for executing skills (except integrator which runs git/gh commands directly)

## Desired End State

3 stations, each with max 2 spawns, all following the standard `Task()` → `Skill()` pattern:

| Station | Agent | Skills invoked | Max |
|---------|-------|---------------|-----|
| analyst | `ralph-analyst` | `ralph-triage`, `ralph-split`, `ralph-research`, `ralph-plan` | 2 |
| builder | `ralph-builder` | `ralph-review`, `ralph-impl` | 2 |
| integrator | `ralph-integrator` | `ralph-val` (new), + direct git/gh for PR/merge | 2 |

A new `ralph-val` skill validates that the implementation satisfies the plan's requirements.

**Separation of concerns:**
- **Analyst** does all thinking/analysis work end-to-end (research → plan)
- **Builder** reviews the plan in a fresh context window (no bias from writing it), then implements
- **Integrator** validates that the implementation satisfies the plan's requirements (via `ralph-val` skill), then creates PR and merges

**Verification**: After implementation, running `/ralph-team 42` should spawn at most 3 station types with max 2 workers each. The validator agent type should no longer be referenced. The pipeline task graph should flow: analyst tasks → builder review → builder implement → integrator validate → integrator PR/merge.

## What We're NOT Doing

- Changing existing skills (`ralph-research`, `ralph-plan`, `ralph-review`, `ralph-impl`) — they remain unchanged
- Changing the MCP server or GitHub Projects V2 workflow states
- Changing the hero mode orchestrator (`ralph-hero/SKILL.md`)
- Changing the `ralph-loop.sh` script (single-agent loop) beyond removing `--validator-only`
- Redesigning the spawn template or bough model (that's the separate worker redesign plan)
- Removing `RALPH_REVIEW_MODE` — review always happens now (builder always reviews), so the env var becomes irrelevant for team mode but we don't need to actively remove it

## Implementation Approach

Incremental changes across 5 phases: new skill → agent definitions → orchestrator → hooks → docs. Each phase is independently testable.

---

## Phase 1: Create `ralph-val` Skill

### Overview
Create a new skill that validates implementation output against plan requirements. This follows the same patterns as `ralph-review` (reads an artifact, produces a verdict) but checks code against plan rather than critiquing the plan itself.

### Changes Required:

#### 1. Create skill directory and SKILL.md
**File**: `plugin/ralph-hero/skills/ralph-val/SKILL.md`

The skill should:
- Accept an issue number and optional `--plan-doc` path (same arg pattern as other skills)
- Find the plan via Artifact Comment Protocol (same discovery as `ralph-review` Step 3)
- Find the worktree for the issue (`worktrees/GH-NNN`)
- Read the plan's "Desired End State" and per-phase "Success Criteria"
- Check each automated verification criterion:
  - Run commands listed in the plan (e.g., `npm test`, `npm run build`) from the worktree
  - Verify files mentioned in the plan exist and contain expected changes
- Produce a verdict: `PASS` or `FAIL` with specific details
- Post a `## Validation` comment on the issue (Artifact Comment Protocol)
- Does NOT change workflow state (integrator handles that based on verdict)

```yaml
---
description: Validate that implementation satisfies plan requirements. Reads the plan, checks code in worktree, runs automated verification. Use when you want to validate an implementation before PR creation.
argument-hint: <issue-number> [--plan-doc path]
context: fork
model: sonnet
hooks:
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/val-postcondition.sh"
allowed_tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Task
env:
  RALPH_COMMAND: "val"
  RALPH_REQUIRES_PLAN: "true"
---
```

**Workflow**:

1. **Parse arguments**: Extract issue number and optional `--plan-doc` flag
2. **Fetch issue**: `ralph_hero__get_issue(number=NNN)` — get title, state, comments
3. **Find plan document**: Use Artifact Passthrough if `--plan-doc` provided, otherwise Artifact Comment Protocol discovery (same as `ralph-review` Step 3)
4. **Find worktree**: Check `worktrees/GH-NNN` or extract from task metadata
5. **Extract verification criteria**: Parse the plan for:
   - "Desired End State" section
   - Per-phase "Success Criteria > Automated Verification" checkboxes
6. **Run automated checks** from the worktree directory:
   - Execute each listed command (e.g., `cd worktrees/GH-NNN && npm test`)
   - Check file existence for files mentioned in the plan
   - Use Grep/Glob to verify expected code changes exist
7. **Produce verdict**:
   - **PASS**: All automated criteria satisfied
   - **FAIL**: List each failing criterion with details
8. **Report**:
   ```
   VALIDATION [PASS/FAIL]
   Issue: #NNN
   Plan: [plan path]
   Worktree: [worktree path]

   Checks:
   - [x] npm test — passed
   - [x] npm run build — passed
   - [ ] Expected file src/foo.ts — MISSING

   Verdict: [PASS/FAIL]
   ```

#### 2. Create postcondition hook
**File**: `plugin/ralph-hero/hooks/scripts/val-postcondition.sh`

Ensures the skill produced a verdict before stopping. Pattern follows `review-postcondition.sh`:

```bash
#!/bin/bash
# ralph-hero/hooks/scripts/val-postcondition.sh
# Stop: Ensure ralph-val produced a verdict before allowing stop
set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

INPUT=$(cat)
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [[ "$STOP_HOOK_ACTIVE" == "true" ]]; then
  exit 0
fi

echo "Ensure you have produced a VALIDATION PASS or VALIDATION FAIL verdict with specific check results before stopping." >&2
exit 2
```

### Success Criteria:

#### Automated Verification:
- [ ] Skill directory exists: `test -d plugin/ralph-hero/skills/ralph-val`
- [ ] SKILL.md exists: `test -f plugin/ralph-hero/skills/ralph-val/SKILL.md`
- [ ] Postcondition hook exists and is executable: `test -x plugin/ralph-hero/hooks/scripts/val-postcondition.sh`
- [ ] SKILL.md contains `RALPH_COMMAND: "val"`

#### Manual Verification:
- [ ] Skill can be invoked standalone: `/ralph-val NNN` (with a test issue that has a plan and worktree)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding to the next phase.

---

## Phase 2: Update Agent Definitions

### Overview
Modify the 3 remaining agent definitions to reflect their new responsibilities. Delete the validator agent. All agents follow the standard `Task()` → `Skill()` pattern for executing skills.

### Changes Required:

#### 1. Update `ralph-analyst.md` — Add plan skill
**File**: `plugin/ralph-hero/agents/ralph-analyst.md`
**Changes**: Add `ralph-plan` to the skill dispatch. The analyst now owns research AND planning.

Replace the current file with:

```markdown
---
name: ralph-analyst
description: Analyst worker - composes triage, split, research, and plan skills for issue assessment, investigation, and planning
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

**Important for SPLIT/TRIAGE**: Include all sub-ticket IDs and estimates in your TaskUpdate -- the lead needs them.

## Task Loop

1. Check TaskList for assigned or unclaimed tasks matching your role
2. Claim unclaimed tasks: `TaskUpdate(taskId, owner="my-name")`
3. Read task context via TaskGet
4. **Run the skill via Task()** to protect your context window:
   ```
   Task(subagent_type="general-purpose",
        prompt="Skill(skill='ralph-hero:ralph-research', args='NNN')",
        description="Research GH-NNN")
   ```
   Or for planning:
   ```
   Task(subagent_type="general-purpose",
        prompt="Skill(skill='ralph-hero:ralph-plan', args='NNN')",
        description="Plan GH-NNN")
   ```
5. Report results via TaskUpdate (metadata + description)
6. Check TaskList for more work before stopping

**Important**: Task() subagents cannot call Task() — they are leaf nodes.

## Shutdown

If idle: approve. If mid-skill: reject, finish, then approve.
```

#### 2. Update `ralph-builder.md` — Add review, remove plan
**File**: `plugin/ralph-hero/agents/ralph-builder.md`
**Changes**: Builder now reviews plans (in a fresh context, no bias) and implements. Remove plan references.

Replace the current file with:

```markdown
---
name: ralph-builder
description: Builder worker - reviews plans and implements code for the full build lifecycle
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

## Task Loop

1. Check TaskList for assigned or unclaimed tasks matching your role
2. Claim unclaimed tasks: `TaskUpdate(taskId, owner="my-name")`
3. Read task context via TaskGet
4. **Run the skill via Task()** to protect your context window:
   For review:
   ```
   Task(subagent_type="general-purpose",
        prompt="Skill(skill='ralph-hero:ralph-review', args='NNN')",
        description="Review GH-NNN")
   ```
   For implementation:
   ```
   Task(subagent_type="general-purpose",
        prompt="Skill(skill='ralph-hero:ralph-impl', args='NNN')",
        description="Implement GH-NNN")
   ```
5. Report results via TaskUpdate (metadata + description). **For reviews, include the full VERDICT in both metadata and description**
6. Check TaskList for more work before stopping

**Important**: Task() subagents cannot call Task() — they are leaf nodes.

## Handling Revision Requests

If lead sends revision feedback (from review rejection): read the feedback from the review task's description, re-invoke `ralph-impl` or manually update, re-commit and update your task.

## Implementation Notes

- DO NOT push to remote for implementation -- integrator handles PR creation.
- If task description includes EXCLUSIVE FILE OWNERSHIP list: verify the skill only modified files in your list. Report conflicts to lead via SendMessage.

## Shutdown

Verify all work committed (`git status` in worktree), then approve.
```

#### 3. Update `ralph-integrator.md` — Add validation via `ralph-val` skill
**File**: `plugin/ralph-hero/agents/ralph-integrator.md`
**Changes**: Add `Skill` and `Task` to tools. Integrator now invokes `ralph-val` via standard `Task()` → `Skill()` pattern for validation. PR creation and merge remain direct git/gh commands. Remove serialization constraint.

Replace the current file with:

```markdown
---
name: ralph-integrator
description: Integration specialist - validates implementation against plan requirements, handles PR creation, merge, worktree cleanup, and git operations
tools: Read, Glob, Bash, Skill, Task, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue, ralph_hero__update_workflow_state, ralph_hero__create_comment, ralph_hero__advance_children, ralph_hero__advance_parent, ralph_hero__list_sub_issues
model: haiku
color: orange
hooks:
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/worker-stop-gate.sh"
---

You are an **INTEGRATOR** in the Ralph Team.

## Task Loop

1. Check TaskList for assigned or unclaimed tasks matching your role
2. Claim unclaimed tasks: `TaskUpdate(taskId, owner="my-name")`
3. Read task context via TaskGet
4. Match task subject to procedure below and execute
5. Report results via TaskUpdate (metadata + description). **Full result must be in task description -- lead cannot see your command output**
6. Check TaskList for more work before stopping

**Important**: Task() subagents cannot call Task() — they are leaf nodes.

## Validation

When task subject contains "Validate":

**Run the skill via Task()** to protect your context window:
```
Task(subagent_type="general-purpose",
     prompt="Skill(skill='ralph-hero:ralph-val', args='NNN --plan-doc [plan-path]')",
     description="Validate GH-NNN")
```

Report the verdict via TaskUpdate. Include `verdict: "PASS"` or `verdict: "FAIL"` in metadata.

If FAIL, the lead will create a revision task for the builder.

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
5. Move ALL issues (and children) to "In Review" via `advance_children`. Do not move to "Done" -- that requires PR merge.
6. `TaskUpdate(taskId, status="completed", description="PR CREATED\nTicket: #NNN\nPR: [URL]\nBranch: [branch]\nState: In Review")`

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

## Shutdown

Approve unless mid-merge or mid-validation.
```

#### 4. Delete `ralph-validator.md`
**File**: `plugin/ralph-hero/agents/ralph-validator.md`
**Action**: Delete this file entirely.

### Success Criteria:

#### Automated Verification:
- [ ] `ralph-validator.md` no longer exists: `test ! -f plugin/ralph-hero/agents/ralph-validator.md`
- [ ] `ralph-analyst.md` contains "plan" in description
- [ ] `ralph-builder.md` contains "review" in description
- [ ] `ralph-integrator.md` contains "validate" in description
- [ ] `ralph-integrator.md` contains "Skill" and "Task" in tools list

#### Manual Verification:
- [ ] Each agent's tool list is correct for its new responsibilities

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding to the next phase.

---

## Phase 3: Update SKILL.md Orchestrator

### Overview
Update the ralph-team skill to use 3 stations, change the roster table, update the task graph templates, and set max spawns to 2.

### Changes Required:

#### 1. Update SKILL.md
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`

**Change 1**: Update description (line 2):
```
description: Multi-agent team coordinator that spawns specialist workers (analyst, builder, integrator) to process GitHub issues in parallel. Detects issue state, drives forward through state machine. Use when you want to run a team, start agent teams, or process issues with parallel agents.
```

**Change 2**: Update roster table (lines 73-80). Replace with:
```markdown
| Role | Agent type | Handles |
|------|-----------|---------|
| analyst | ralph-analyst | Triage, Split, Research, Plan |
| builder | ralph-builder | Review, Implement |
| integrator | ralph-integrator | Validate, Create PR, Merge PR |

Max 2 per station (append `-2` for the second). Example: `analyst`, `analyst-2`.
```

**Change 3**: Update the task graph example (lines 86-94). Replace with:
```markdown
**Single issue example**:
```
T-1: Research GH-42       → unblocked      → owner: analyst
T-2: Plan GH-42           → blockedBy: T-1 → owner: (analyst, claimed later)
T-3: Review plan GH-42    → blockedBy: T-2 → owner: (builder, claimed later)
T-4: Implement GH-42      → blockedBy: T-3 → owner: (builder, claimed later)
T-5: Validate GH-42       → blockedBy: T-4 → owner: (integrator, claimed later)
T-6: Create PR for GH-42  → blockedBy: T-5 → owner: (integrator, claimed later)
T-7: Merge PR for GH-42   → blockedBy: T-6 → owner: (integrator, claimed later)
```
```

**Change 4**: Update the review rejection handling (line 119). Replace with:
```markdown
When a review completes with `verdict: "NEEDS_ITERATION"`, create a new "Plan GH-NNN" task blocked by the failed review, assigned to an analyst. Builder re-reviews after the revised plan.

When a validation completes with `verdict: "FAIL"`, create a new "Implement GH-NNN" task blocked by the failed validation, assigned to a builder. Integrator re-validates after the fix.
```

### Success Criteria:

#### Automated Verification:
- [ ] `grep -c "validator" plugin/ralph-hero/skills/ralph-team/SKILL.md` returns 0
- [ ] `grep "analyst.*Plan" plugin/ralph-hero/skills/ralph-team/SKILL.md` matches
- [ ] `grep "builder.*Review" plugin/ralph-hero/skills/ralph-team/SKILL.md` matches
- [ ] `grep "integrator.*Validate" plugin/ralph-hero/skills/ralph-team/SKILL.md` matches

#### Manual Verification:
- [ ] Task graph shows correct blockedBy chain with validation step before PR creation

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding to the next phase.

---

## Phase 4: Update Hook Scripts

### Overview
Update the worker-stop-gate keyword mappings and script comments.

### Changes Required:

#### 1. Update `worker-stop-gate.sh`
**File**: `plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh`

Replace the case statement (lines 27-33):
```bash
case "$TEAMMATE" in
  analyst*)    KEYWORDS="Triage, Split, Research, or Plan" ;;
  builder*)    KEYWORDS="Review or Implement" ;;
  integrator*) KEYWORDS="Validate, Create PR, Merge, or Integrate" ;;
  *)           exit 0 ;; # Unknown role, allow stop
esac
```

Note: The `validator*)` case is removed entirely.

#### 2. Update `ralph-team-loop.sh` comment
**File**: `plugin/ralph-hero/scripts/ralph-team-loop.sh`

Change line 7 from:
```bash
# for each pipeline phase (analyst, builder, validator, integrator).
```
To:
```bash
# for each pipeline phase (analyst, builder, integrator).
```

#### 3. Update `ralph-loop.sh` references
**File**: `plugin/ralph-hero/scripts/ralph-loop.sh`

- Line 5: Remove `--validator-only` from the comment
- Line 45: Remove `--validator-only` from the case match
- Line 166: Remove `--validator-only` from the condition

### Success Criteria:

#### Automated Verification:
- [ ] `grep -c "validator" plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh` returns 0
- [ ] `grep "analyst.*Plan" plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh` matches
- [ ] `grep "integrator.*Validate" plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh` matches
- [ ] Hook scripts parse cleanly: `bash -n plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh`

#### Manual Verification:
- [ ] `ralph-loop.sh` no longer accepts `--validator-only`

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding to the next phase.

---

## Phase 5: Update Documentation

### Overview
Update all documentation references to reflect the 3-station model.

### Changes Required:

#### 1. Update README.md
**File**: `plugin/ralph-hero/README.md`

- Line 189: Remove `│   ├── ralph-validator.md` from the architecture tree
- Add `│   └── ralph-val/` to the skills tree (after `ralph-team/`)
- Any prose references to "4 workers" → "3 workers"

#### 2. Update conventions.md
**File**: `plugin/ralph-hero/skills/shared/conventions.md`

- If any references to "4 worker types" exist, update to "3 worker types"
- No structural changes needed (ADR-001 table is generic)

#### 3. Update docs/cli.md
**File**: `plugin/ralph-hero/docs/cli.md`

- Line 120: Remove `validator` from the `mode` values list

#### 4. Update CLAUDE.md
**File**: `CLAUDE.md` (project root)

- Update the agent table to remove `ralph-validator` and update descriptions:
  ```
  | `ralph-analyst` | Analysis worker - triage, split, research, plan |
  | `ralph-builder` | Build worker - review, implement |
  | `ralph-integrator` | Integration - validate, PR, merge, worktree cleanup |
  ```
- Remove the `ralph-validator` row

#### 5. Update parent workspace CLAUDE.md
**File**: `/home/chad_a_dubiel/projects/CLAUDE.md`

- Update the agent table to remove `ralph-validator` and update descriptions

### Success Criteria:

#### Automated Verification:
- [ ] `grep -rn "ralph-validator" plugin/ralph-hero/` returns no matches (excluding git history)
- [ ] `grep -rn "4.*worker" plugin/ralph-hero/README.md` returns no matches

#### Manual Verification:
- [ ] README architecture tree is accurate
- [ ] CLI docs reflect available modes correctly

---

## Testing Strategy

### Integration Test:
1. Run `/ralph-team 42` on a test issue in Research Needed state
2. Verify only 3 station types are spawned (analyst, builder, integrator)
3. Verify task graph includes Validate step between Implement and Create PR
4. Verify max 2 workers per station

### Skill Test:
1. Run `/ralph-val NNN` standalone on an issue with a plan and worktree
2. Verify it reads the plan, checks the code, and produces PASS/FAIL verdict

### Regression:
1. Run `/ralph-hero 42` — should be unaffected (hero mode doesn't use team stations)
2. Run individual skills (`/ralph-research`, `/ralph-plan`, `/ralph-review`, `/ralph-impl`) — should be unaffected

## References

- Previous redesign plan: `thoughts/shared/plans/2026-02-20-ralph-team-worker-redesign.md`
- V4 architecture spec: `thoughts/shared/plans/2026-02-22-ralph-workflow-v4-architecture-spec.md`
- Current SKILL.md: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
- Review skill (pattern reference): `plugin/ralph-hero/skills/ralph-review/SKILL.md`
