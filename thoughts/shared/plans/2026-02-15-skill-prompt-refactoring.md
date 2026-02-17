---
date: 2026-02-15
status: draft
type: plan
topic: "Skill Prompt Refactoring - Anti-Pattern Elimination"
tags: [refactoring, skills, mcp-tools, prompts, autonomy]
---

# Skill Prompt Refactoring - Anti-Pattern Elimination

## Overview

Comprehensive refactoring of the ralph-hero plugin to eliminate three classes of anti-patterns identified in PR review, reduce prompt token usage by ~55%, and increase agent autonomy.

**Current state**: 5 skill files totaling ~3,251 lines with verbose tool call examples, redundant sequential calls, and external validation patterns.

**Target state**: ~1,400 lines of concise, heuristic-based guidance that trusts tool docstrings and hooks as guardrails.

## Anti-Patterns Identified

### AP1: Redundant Sequential Tool Calls

The LLM is instructed to make multiple tool calls that internally do the same work.

| Skill | Pattern | Root Cause |
|-------|---------|-----------|
| ralph-hero Step 1 | `get_issue` -> `detect_group` -> `detect_pipeline_position` | `detect_pipeline_position` already calls `detectGroup()` (issue-tools.ts:1194) |
| ralph-team Mode A | `get_issue` -> `detect_group` | `detect_group` returns issue details in group members |
| ralph-research Step 1 | `list_issues` -> `detect_group` per issue -> `get_issue` again | Triple fetch of same data |
| ralph-plan Step 1a/1b | `get_issue` -> `detect_group` | Same redundancy |
| ralph-impl Step 5.1 | `get_issue` again just for parent check | Data already available from Step 2 |

**Fix**: Consolidate MCP tools so one call returns complete context. Skills reference the tool, not its internal API shape.

### AP2: External Validation of Subagent Results

The LLM makes a separate tool call to validate what a subagent already did.

| Skill | Pattern | Fix |
|-------|---------|-----|
| ralph-hero CONVERGENCE CHECK | Calls `check_convergence` after research subagents complete | `detect_pipeline_position` already includes convergence info; just re-call it |
| ralph-team 4.4 step 3 | Lead queries GitHub to verify research convergence | Same - trust pipeline detection |
| ralph-research Step 5.4 | Manually checks group convergence after own work | Subagent should self-validate via `detect_pipeline_position` |

**Fix**: Eliminate separate convergence checks. `detect_pipeline_position` already returns convergence status. Subagents validate their own work via hooks (postcondition checks).

### AP3: Over-Prescribed Tool Calls in Prompts

Skills contain full tool call examples with all parameters spelled out, duplicating what tool docstrings already say.

| Skill | Lines | Tool call examples | Estimated waste |
|-------|-------|-------------------|----------------|
| ralph-team | 818 | 18+ spawn examples | ~500 lines |
| ralph-impl | 865 | 3 full PR templates, escalation table | ~400 lines |
| ralph-plan | 556 | 2 full plan templates, escalation table | ~300 lines |
| ralph-research | 415 | Tool call blocks, escalation table | ~200 lines |
| ralph-hero | 597 | Phase examples with full params | ~300 lines |

**Fix**: Remove concrete tool call examples. Replace with concise guidance. Move templates into tool docstrings or separate template files. Tools should be self-documenting.

## Design Principles (Informed by Anthropic Best Practices)

1. **Trust the model** - "Let intelligent models act intelligently." Avoid rigid if-else chains.
2. **Tools are self-documenting** - Good descriptions + error recovery messages eliminate need for prompt-level examples.
3. **Hooks are guardrails** - 41 hook scripts already enforce state gates, branch gates, and postconditions. Prompts don't need to re-enforce.
4. **Heuristics over prescriptions** - "Specific enough to guide behavior effectively, yet flexible enough to provide strong heuristics."
5. **Progressive disclosure** - Start minimal, let error messages guide the agent to correct usage.
6. **Self-healing via error messages** - Every error response should include `Recovery:` guidance.

---

## Phase 1: MCP Tool Consolidation

### 1.1 Enrich `get_issue` with group context

**File**: `mcp-server/src/tools/issue-tools.ts`

Add an optional `includeGroup` parameter (default: `true`) to `get_issue` that calls `detectGroup()` internally and merges group data into the response.

**Current response shape**:
```json
{ "number": 42, "title": "...", "workflowState": "...", "parent": {...}, "subIssues": [...], "blocking": [...], "blockedBy": [...] }
```

**New response shape** (when `includeGroup: true`):
```json
{
  ...existingFields,
  "group": {
    "isGroup": true,
    "primary": { "number": 42, "title": "..." },
    "members": [{ "number": 42, "state": "Research Needed", "order": 0 }, ...],
    "totalTickets": 3
  }
}
```

This eliminates the `get_issue` -> `detect_group` double-call in every skill.

**Implementation**:
- Import `detectGroup` from `lib/group-detection.ts`
- Add `includeGroup` boolean parameter with default `true`
- Call `detectGroup()` when enabled and merge result into response
- Update tool description to document the group field

### 1.2 Enrich `detect_pipeline_position` response

**File**: `mcp-server/src/tools/issue-tools.ts`

The tool already calls `detectGroup()` internally (line 1194). Ensure the response includes everything needed for routing decisions, making separate `check_convergence` unnecessary for the common case.

**Current response**: Already includes `convergence: { required, met, blocking }`.

**Enhancement**: Add `recommendation` field matching `check_convergence`'s output:
```json
{
  ...existingFields,
  "convergence": {
    "required": true,
    "met": false,
    "blocking": [{ "number": 43, "state": "Research in Progress" }],
    "recommendation": "wait"  // NEW: "proceed" | "wait" | "escalate"
  }
}
```

This means `check_convergence` becomes redundant for pipeline decisions. Keep it available for edge cases but remove it from skill prompts.

### 1.3 Improve tool descriptions with self-healing patterns

**Files**: All files in `mcp-server/src/tools/`

For each tool, ensure the MCP description includes:
1. **When to use it** (1 sentence)
2. **What it returns** (key fields, not full schema)
3. **Common errors and recovery** (already partially done with `Recovery:` pattern)

**Example improvement for `detect_pipeline_position`**:
```
Current: "Determine the current pipeline position for an issue or group."
Better: "Determine which workflow phase to execute next for an issue or its group. Returns phase (SPLIT/RESEARCH/PLAN/REVIEW/IMPLEMENT/COMPLETE/TERMINAL), convergence status, and all group member states. Call this INSTEAD of separate detect_group + check_convergence calls."
```

### 1.4 Add `pick_actionable_issue` group enrichment

**File**: `mcp-server/src/tools/issue-tools.ts`

When `pick_actionable_issue` finds an issue, optionally include group detection in the response. This eliminates the pattern of `pick_actionable_issue` -> `detect_group` in the dispatch loop.

### Success Criteria

#### Automated Verification
- [ ] `npm test` passes in `mcp-server/`
- [ ] `npm run build` succeeds
- [ ] `get_issue` with `includeGroup: true` returns group data
- [ ] `detect_pipeline_position` returns recommendation in convergence

#### Manual Verification
- [ ] Tool descriptions are self-documenting (no ambiguity about when to use each)
- [ ] Error messages all include `Recovery:` guidance

---

## Phase 2: Skill Prompt Compression

### 2.1 ralph-hero SKILL.md (597 -> ~200 lines)

**Major changes**:

1. **Remove Step 1 entirely** (get_issue + detect_group). Replace with single `detect_pipeline_position` call:
   ```
   ### Step 1: Detect Pipeline Position
   Call `detect_pipeline_position` for the root issue. This returns the phase,
   group members, and convergence status in a single call.
   ```

2. **Remove CONVERGENCE CHECK phase**. After RESEARCHING completes, just re-call `detect_pipeline_position`. If it returns PLAN phase, proceed. If not, it returns blocking info.

3. **Remove verbose spawn examples**. Replace 20+ lines of Task() pseudocode per phase with:
   ```
   Spawn background Tasks invoking the appropriate skill for each issue.
   Example: Skill(skill='ralph-hero:ralph-research', args='NNN')
   ```

4. **Remove full parameter lists** from tool call examples. The tool descriptions + env vars are sufficient.

5. **Keep**: State machine diagram, phase descriptions, error handling rules, environment variables.

### 2.2 ralph-team SKILL.md (818 -> ~350 lines)

**Major changes**:

1. **Section 2 Mode A**: Replace `get_issue` + `detect_group` with single `get_issue` (now includes group data).

2. **Section 2 Mode B**: Remove verbose 30-line parallel discovery example. Replace with:
   ```
   Spawn 3 parallel agents to query GitHub for urgent, in-progress, and unstarted work.
   Each uses `list_issues` with appropriate filters.
   ```

3. **Section 4.2**: Keep task structure but remove full TaskCreate examples. The patterns are established; just describe what tasks to create.

4. **Section 4.4 dispatch loop**: Remove convergence re-checking. Trust `detect_pipeline_position` for state transitions.

5. **Section 6 spawn examples**: Dramatically compress. Currently 18 examples across 125 lines. Replace with a **spawn template** and per-role notes:
   ```
   ### Spawn Template
   Task(subagent_type="[agent]", team_name=TEAM_NAME, name="[role]",
        prompt="[Role] for #NNN: [title]. State: [state]. [Artifacts if any].
                Invoke: Skill(skill='ralph-hero:[skill]', args='NNN')
                Embed results in task description via TaskUpdate.",
        description="[Role] #NNN")

   ### Per-Role Notes
   - **Triager**: Invoke ralph-triage (XS/S) or ralph-split (M+)
   - **Researcher**: Invoke ralph-research
   - **Planner**: Invoke ralph-plan. For groups, use primary issue number.
   - **Reviewer**: Invoke ralph-review. Include plan path.
   - **Implementer**: Invoke ralph-impl. Include plan path + worktree path.
   ```

6. **Remove PR templates** from Section 4.5. Move to a helper or let `gh pr create` defaults work with a concise body.

7. **Keep**: Dispatch loop logic, behavioral principles, known limitations, error handling.

### 2.3 ralph-research SKILL.md (415 -> ~180 lines)

**Major changes**:

1. **Step 1**: Replace triple-fetch pattern with:
   ```
   If issue number provided: Call `get_issue` (returns group data automatically).
   If no issue number: Call `list_issues` for "Research Needed" state, then
   `get_issue` on the best candidate.
   ```
   Remove separate `detect_group` calls - `get_issue` now includes group info.

2. **Step 3**: Keep research guidance but remove example Task() spawns with full prompts. Replace with:
   ```
   Spawn parallel codebase research using specialized agents:
   - codebase-locator: Find relevant files
   - codebase-analyzer: Understand implementation details
   - codebase-pattern-finder: Find similar patterns
   - thoughts-locator: Find existing research
   ```

3. **Step 5.4**: Remove manual group convergence check. The postcondition hook validates completion. The next skill invocation will call `detect_pipeline_position` to determine readiness.

4. **Remove**: Escalation table (duplicated across all skills). Move to a shared reference doc or rely on the `__ESCALATE__` intent's error message for guidance.

5. **Remove**: Link formatting section (duplicated across all skills). Move to shared reference.

### 2.4 ralph-plan SKILL.md (556 -> ~250 lines)

**Major changes**:

1. **Step 1a/1b**: Replace `get_issue` + `detect_group` with single `get_issue` call (now includes group).

2. **Step 1b blocker verification**: Simplify. Currently says "you MUST fetch each blocker individually via `ralph_hero__get_issue`". The `get_issue` response already includes `blockedBy` with workflow states. Remove the instruction to re-fetch.

3. **Plan templates**: Keep ONE template (the group template works for single issues too with N=1). Remove the duplicate single-issue template. Or better: move templates to a separate file that the skill references.

4. **Remove**: Escalation table, link formatting section (shared across all skills).

5. **Keep**: Plan quality guidelines, edge cases, commit/push steps.

### 2.5 ralph-impl SKILL.md (865 -> ~400 lines)

**Major changes**:

1. **Step 5.1**: Remove separate `get_issue` call for epic detection. The Step 2 `get_issue` already returns parent info. Just reference the parent field from Step 2.

2. **PR templates**: Keep ONE generic PR template that handles single/group/epic via conditional sections, instead of 3 separate 20+ line templates. Or move to a PR template file.

3. **Remove**: Escalation table, link formatting section (shared).

4. **Address Mode**: Keep but compress. The step-by-step is clear and necessary.

5. **Keep**: Worktree management, phase execution logic, resumption behavior.

### 2.6 Create shared reference doc

**New file**: `plugin/ralph-hero/skills/shared/conventions.md`

Move shared content here (referenced by all skills):
- Escalation protocol (~40 lines, currently duplicated 5x = 200 wasted lines)
- Link formatting (~15 lines, currently duplicated 5x = 75 wasted lines)
- Common error handling patterns

Skills reference it: "See shared/conventions.md for escalation and link formatting."

### Success Criteria

#### Automated Verification
- [ ] All skill files parse valid YAML frontmatter
- [ ] No broken references to tool names
- [ ] Total line count across 5 skills < 1,500 lines (currently 3,251)

#### Manual Verification
- [ ] Each skill still covers its core workflow clearly
- [ ] Shared conventions doc is complete and referenced
- [ ] No tool call examples include full parameter lists

---

## Phase 3: Subagent Self-Validation

### 3.1 Remove external convergence checks from ralph-hero

**File**: `skills/ralph-hero/SKILL.md`

The CONVERGENCE CHECK phase (lines 267-290) calls `check_convergence` after research subagents complete. This is unnecessary because:
1. Each research subagent's postcondition hook validates completion
2. Re-calling `detect_pipeline_position` already checks convergence internally
3. If convergence isn't met, `detect_pipeline_position` returns the blocking issues

**Change**: After RESEARCHING phase completes, simply re-call `detect_pipeline_position` and route based on the returned `phase`:
```
After all research tasks complete:
Re-call detect_pipeline_position(number=[ROOT-NUMBER]).
- If phase == "PLAN": proceed to PLANNING
- Otherwise: report blocking issues from convergence.blocking and STOP
```

### 3.2 Remove external convergence checks from ralph-team

**File**: `skills/ralph-team/SKILL.md`

In the dispatch loop (Section 4.4 step 2), the lead currently queries GitHub to verify convergence. Instead:
- Trust the task blocking system (research tasks block plan tasks)
- When all research tasks complete, the plan task automatically unblocks
- No manual convergence verification needed

### 3.3 Trust hooks for state validation

The following hooks already enforce correctness:
- `convergence-gate.sh` - Prevents premature state transitions
- `research-state-gate.sh` - Validates research preconditions
- `plan-state-gate.sh` - Validates plan preconditions
- `impl-state-gate.sh` - Validates implementation preconditions
- `*-postcondition.sh` - Validates expected outputs exist

Skills should not duplicate hook logic in their prompts. If a skill tries an invalid transition, the hook blocks it and provides recovery guidance.

### Success Criteria

#### Automated Verification
- [ ] `check_convergence` is not referenced in any skill file (grep confirms)
- [ ] `detect_group` is called at most once per skill workflow (grep confirms)
- [ ] No skill calls a tool just to verify another tool's result

#### Manual Verification
- [ ] Each skill's workflow still terminates correctly
- [ ] Hook-based validation is tested (run a dry-run of each skill)

---

## Phase 4: Lead Autonomy Enhancement (ralph-team)

### Research Findings: Hook-Driven Continuous Operation

The Claude Code hook system provides three mechanisms for keeping the team lead running:

1. **Stop hook (exit 2)**: When a Stop hook exits with code 2, Claude **cannot stop** and receives stderr as feedback. The hook input includes a `stop_hook_active` field to detect re-entrancy and prevent infinite loops.

2. **TaskCompleted hook**: Fires when a task is marked complete. Exit 2 blocks completion; stderr feeds back to the agent. Currently ralph-team uses an inline echo -- can be replaced with a script that provides specific next-step guidance.

3. **TeammateIdle hook**: Fires when a teammate goes idle. Exit 2 keeps the teammate working; stderr provides feedback. Currently ralph-team uses an inline echo.

**Key insight**: The existing `post-blocker-reminder.sh` already demonstrates the `additionalContext` nudge pattern via JSON stdout. The Stop hook can use the simpler exit 2 + stderr pattern since it only needs to block or allow.

**Critical safety**: The `stop_hook_active` field in Stop hook input prevents infinite loops. On first invocation, check GitHub for work. On re-entry (stop_hook_active=true), allow the stop to proceed -- the agent already tried to find work and found none.

### 4.1 Create `team-stop-gate.sh` hook script

**File**: `hooks/scripts/team-stop-gate.sh`

This Stop hook prevents the team lead from shutting down while processable GitHub issues exist. It replaces the prompt-level behavioral principles with an enforced mechanism.

```bash
#!/bin/bash
# team-stop-gate.sh - Prevent team lead from stopping while work exists
set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

INPUT=$(cat)

# Safety: prevent infinite loop. If we already nudged once and the lead
# still wants to stop, it means it genuinely found no work. Allow it.
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [[ "$STOP_HOOK_ACTIVE" == "true" ]]; then
  exit 0  # Allow stop on re-entry
fi

# Check GitHub for processable issues across all pipeline stages
STATES=("Backlog" "Research Needed" "Ready for Plan" "Plan in Review" "In Progress")
TOTAL_FOUND=0
SUMMARY=""

for state in "${STATES[@]}"; do
  # Use the MCP server's list_issues via gh API or direct query
  # This is a simplified check -- the actual script would use
  # ralph_hero__pick_actionable_issue or gh CLI
  COUNT=$(gh issue list --repo "$RALPH_GH_OWNER/$RALPH_GH_REPO" \
    --label "$state" --json number --jq 'length' 2>/dev/null || echo "0")
  if [[ "$COUNT" -gt 0 ]]; then
    TOTAL_FOUND=$((TOTAL_FOUND + COUNT))
    SUMMARY="$SUMMARY\n  - $state: $COUNT issues"
  fi
done

if [[ "$TOTAL_FOUND" -gt 0 ]]; then
  cat >&2 <<EOF
GitHub has $TOTAL_FOUND processable issues waiting:
$SUMMARY

Run the dispatch loop: check TaskList for unblocked tasks, spawn workers
for available roles, or use pick_actionable_issue to find new work.
Do NOT shut down while work remains.
EOF
  exit 2  # Block stop, keep working
fi

exit 0  # No work found, allow stop
```

**Registration** in ralph-team SKILL.md frontmatter:
```yaml
hooks:
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/team-stop-gate.sh"
```

**Why this works**: The hook fires every time the lead tries to finish its response. If GitHub has processable issues, the hook blocks the stop and the stderr message tells the lead exactly what to do. The `stop_hook_active` safety valve prevents infinite loops -- if the lead already tried and couldn't find work, it can stop gracefully.

### 4.2 Enhance TaskCompleted and TeammateIdle hooks

**Current state** (inline echoes in ralph-team SKILL.md frontmatter):
```yaml
TaskCompleted:
  - hooks:
      - type: command
        command: "echo 'Task completed. Read its results...' >&2; exit 0"
TeammateIdle:
  - hooks:
      - type: command
        command: "echo 'Teammate idle. Check if workers exist...' >&2; exit 0"
```

**New state**: Replace with proper scripts that provide specific guidance.

**File**: `hooks/scripts/team-task-completed.sh`
```bash
#!/bin/bash
# team-task-completed.sh - Guide lead after task completion
set -euo pipefail
INPUT=$(cat)

TASK_SUBJECT=$(echo "$INPUT" | jq -r '.task_subject // "unknown"')
TEAMMATE=$(echo "$INPUT" | jq -r '.teammate_name // "unknown"')

cat >&2 <<EOF
Task completed by $TEAMMATE: "$TASK_SUBJECT"

DISPATCH LOOP:
1. TaskGet the completed task for results (paths, verdicts, issue numbers)
2. Advance pipeline: create next-phase tasks, update GitHub workflow states
3. Check TaskList for newly unblocked tasks -> spawn workers if needed
4. If no tasks remain: pick_actionable_issue for each idle role
5. If no GitHub work found: proceed to shutdown
EOF
exit 0
```

**File**: `hooks/scripts/team-teammate-idle.sh`
```bash
#!/bin/bash
# team-teammate-idle.sh - Guide lead when teammate goes idle
set -euo pipefail
INPUT=$(cat)

TEAMMATE=$(echo "$INPUT" | jq -r '.teammate_name // "unknown"')

cat >&2 <<EOF
$TEAMMATE is idle. Check if unblocked tasks exist for their role.
If tasks exist: worker will self-claim. No action needed.
If no tasks: use pick_actionable_issue to find new GitHub work for this role.
EOF
exit 0
```

**Registration** in ralph-team SKILL.md frontmatter:
```yaml
hooks:
  TaskCompleted:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/team-task-completed.sh"
  TeammateIdle:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/team-teammate-idle.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/team-stop-gate.sh"
```

### 4.3 Remove user-choice patterns from ralph-team

**Current anti-pattern** in Mode B (Section 2, lines 115-118):
```
- If multiple viable options exist with no clear winner, present candidates
  with context and ask the user to choose.
```

**Problem**: This breaks autonomous operation. The rails are well-defined: workflow states, estimates, priorities, and blocking relationships provide enough signal to make decisions without human input.

**Change**: Replace with autonomous decision-making:
```
Mode B: No Issue Number

1. Parallel discovery: Spawn 3 agents to query urgent, in-progress, and unstarted work
2. Select best candidate autonomously:
   - Priority order: P0 > P1 > P2 > none
   - Prefer in-progress work (resume) over new work (start)
   - Prefer XS/S estimates
   - Prefer unblocked issues
   - If truly equal: pick lowest issue number (oldest)
3. Proceed with selected issue. Report selection to user but don't wait for approval.
```

**Similarly remove** from Section 10 error handling (line 803-804):
```
Current: "Otherwise -- ask user for guidance"
New:     "Otherwise -- escalate via GitHub comment, move to next available issue"
```

The team lead should never block on user input. If it can't resolve a situation:
1. Escalate via `__ESCALATE__` intent (moves issue to "Human Needed")
2. Add GitHub comment explaining the situation
3. Move on to the next processable issue
4. Only stop when genuinely no work remains (enforced by Stop hook)

### 4.4 Simplify dispatch loop to trust hooks + task system

The dispatch loop (Section 4.4, ~75 lines) has extensive commentary explaining mechanics. The hooks now enforce the critical behaviors, so the prompt can be much leaner:

```markdown
### Dispatch Loop

The lifecycle hooks (`TaskCompleted`, `TeammateIdle`, `Stop`) fire at natural
decision points and tell you what to check. Follow their guidance.

1. **Read completed tasks**: TaskList -> TaskGet for each newly completed task
2. **Advance pipeline**: Create next-phase tasks, advance GitHub workflow states
   via `advance_children` for parent issues
3. **Ensure workers**: For each role with unblocked tasks but no active worker,
   spawn one. Workers self-claim.
4. **Find new work**: If no tasks remain, call `pick_actionable_issue` for each
   idle role. Create tasks for found issues.
5. **Lookahead**: While workers are busy, pre-create tasks for the next pipeline
   stage to eliminate gaps between task completion and next claim.

The Stop hook prevents premature shutdown -- you cannot stop while GitHub
has processable issues. Trust it.
```

### 4.5 Behavioral principles as heuristics, not rules

**Current** (Section 5, ~20 lines of prescriptive rules): "Workers drive their own flow", "Between phases, create tasks IMMEDIATELY", etc.

**New** (compressed to essential heuristics):
```markdown
### Behavioral Principles

- **Delegate everything**: You never research, plan, review, or implement.
  You manage tasks and spawn workers.
- **Workers are autonomous**: They self-claim from TaskList. Your job is to
  ensure workers exist, not to assign work.
- **Bias toward action**: When in doubt, check TaskList. When idle, query GitHub.
- **Hooks are your safety net**: Stop hook prevents premature shutdown.
  State hooks prevent invalid transitions. Trust them.
- **Escalate and move on**: If stuck, escalate via GitHub comment and find
  other work. Never block on user input.
```

### 4.6 Cost and security guardrails (the only human gates)

The user identified that the only legitimate reasons to pause for human input are:
1. **New infrastructure costs** - e.g., provisioning new cloud resources
2. **Security risks** - e.g., handling credentials, modifying auth systems

These are already handled by Claude Code's permission system and can be codified:

```markdown
### Human Gates (Exhaustive List)

The team operates autonomously EXCEPT for:
1. **Cost-incurring actions**: Cloud resource provisioning, API subscriptions
2. **Security-sensitive actions**: Credential handling, auth system changes
3. **Explicit user stop request**: User says "stop" or terminates session

Everything else is autonomous. The state machine, hooks, and GitHub Projects
provide sufficient guardrails for all workflow decisions.
```

### Success Criteria

#### Automated Verification
- [ ] `team-stop-gate.sh` exists and is executable
- [ ] `team-task-completed.sh` exists and is executable
- [ ] `team-teammate-idle.sh` exists and is executable
- [ ] ralph-team SKILL.md frontmatter references all 3 hook scripts
- [ ] No "ask user" or "present candidates" language in ralph-team SKILL.md
- [ ] grep confirms: zero occurrences of "ask the user" in ralph-team skill

#### Manual Verification
- [ ] Stop hook correctly blocks when GitHub has processable issues
- [ ] Stop hook allows exit when `stop_hook_active=true` (re-entry safety)
- [ ] Team lead processes multiple issues in sequence without stopping
- [ ] Escalation moves to next issue instead of blocking on user input
- [ ] Lead never idles while processable GitHub issues exist

---

## Implementation Order

1. **Phase 4.1-4.2** (hook scripts) - Create the 3 hook scripts first; they're standalone and don't depend on other phases. This immediately enables continuous operation testing.
2. **Phase 1** (MCP tools) - Tool consolidation enables prompt simplification
3. **Phase 2.6** (shared conventions doc) - Create before compressing skills
4. **Phase 2.1-2.5 + Phase 3** (skill compression + self-validation) - Can be done in parallel per skill
5. **Phase 4.3-4.6** (ralph-team prompt changes) - Apply after hook scripts are proven and skill compression patterns are established

## Token Impact Estimate

| File | Current | Target | Reduction |
|------|---------|--------|-----------|
| ralph-team SKILL.md | 818 lines | ~350 lines | 57% |
| ralph-impl SKILL.md | 865 lines | ~400 lines | 54% |
| ralph-hero SKILL.md | 597 lines | ~200 lines | 66% |
| ralph-plan SKILL.md | 556 lines | ~250 lines | 55% |
| ralph-research SKILL.md | 415 lines | ~180 lines | 57% |
| shared/conventions.md | 0 lines | ~60 lines | (new) |
| **Total** | **3,251** | **~1,440** | **56%** |

## Risk Mitigation

1. **Regression risk**: Skills may lose critical guidance. Mitigate by running each skill through one full workflow after compression and verifying outputs.
2. **Tool change risk**: Enriching `get_issue` changes its response shape. Existing callers must handle the new `group` field (it's additive, so backward compatible).
3. **Over-compression risk**: Don't remove guidance that addresses real failure modes. The escalation protocol and hook-trust principles are important.
4. **Runaway cost risk**: The Stop hook enables indefinite operation. The `stop_hook_active` re-entry safety prevents infinite loops, but a stuck agent could still accumulate costs. Mitigate with: (a) session-level token budget limits, (b) the Stop hook only blocks once per stop attempt, (c) GitHub issue counts provide a natural termination condition.
5. **Autonomous escalation risk**: Removing user-choice patterns means the lead will autonomously escalate issues. Mitigate by ensuring `__ESCALATE__` always creates a visible GitHub comment with @mention, so humans are notified even if not watching the session.

## References

- Anthropic Tool Use Best Practices: https://docs.anthropic.com/en/docs/build-with-claude/tool-use/best-practices-and-known-issues
- MCP Tool Design: https://modelcontextprotocol.io/docs/concepts/tools
- Claude Code Hooks Reference: https://code.claude.com/docs/en/hooks
- Claude Code Agent Teams: https://code.claude.com/docs/en/agent-teams
- Current tool implementations: `plugin/ralph-hero/mcp-server/src/tools/`
- Current hook scripts: `plugin/ralph-hero/hooks/scripts/`

## Appendix: Hook System Architecture (Phase 4 Context)

### How Hooks Drive Autonomy

```
┌─────────────────────────────────────────────────────┐
│                 TEAM LEAD SESSION                    │
│                                                      │
│  ┌──────────────┐    ┌──────────────────────────┐   │
│  │ TaskCompleted │───>│ team-task-completed.sh    │   │
│  │ hook fires    │    │ stderr: "Read results,   │   │
│  └──────────────┘    │ advance pipeline..."      │   │
│                      └──────────────────────────┘   │
│                                                      │
│  ┌──────────────┐    ┌──────────────────────────┐   │
│  │ TeammateIdle  │───>│ team-teammate-idle.sh     │   │
│  │ hook fires    │    │ stderr: "Check tasks     │   │
│  └──────────────┘    │ for idle role..."         │   │
│                      └──────────────────────────┘   │
│                                                      │
│  ┌──────────────┐    ┌──────────────────────────┐   │
│  │ Stop          │───>│ team-stop-gate.sh         │   │
│  │ hook fires    │    │ Checks GitHub for work.  │   │
│  └──────────────┘    │ exit 2 if work exists    │   │
│                      │ exit 0 if truly done     │   │
│                      │ (or stop_hook_active)    │   │
│                      └──────────────────────────┘   │
│                                                      │
│  Result: Lead CANNOT stop while issues exist.        │
│  Lead ALWAYS knows what to do next (hook guidance).  │
│  Lead NEVER asks user for direction (autonomous).    │
└─────────────────────────────────────────────────────┘
```

### Hook Communication Patterns Used

| Pattern | Mechanism | Example |
|---------|-----------|---------|
| **Block + nudge** | exit 2 + stderr | Stop hook blocks shutdown, tells lead to find work |
| **Allow + context** | exit 0 + JSON `additionalContext` | Post-blocker-reminder injects verification guidance |
| **Block + recovery** | exit 2 + stderr with Recovery steps | State gates provide specific corrective actions |
| **Allow silently** | exit 0, no output | Most PostToolUse hooks when validation passes |

### Safety Invariants

1. **Stop hook re-entry**: `stop_hook_active=true` on second invocation -> always exit 0. Prevents infinite loops.
2. **State machine enforcement**: Hooks validate transitions independently of prompts. Invalid transitions are blocked regardless of what the prompt says.
3. **Postcondition validation**: Stop hooks on individual skills (research-postcondition.sh, plan-postcondition.sh, etc.) ensure work products exist before allowing completion.
4. **Cost boundary**: The only infinite loop risk is the Stop hook. The re-entry safety valve limits it to one extra attempt per stop.
