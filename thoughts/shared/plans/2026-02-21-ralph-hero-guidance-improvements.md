---
date: 2026-02-21
status: draft
---

# Ralph Hero Plugin Guidance Improvements - Implementation Plan

## Overview

Improve the ralph-hero plugin's guidance quality across skills, agents, hooks, and team coordination to reduce agent thrashing, improve context passing between teammates, and add reusable includes for task list patterns and communication discipline. The goal is that every agent in the system has consistent, sufficient guidance without flooding context windows.

## Current State Analysis

The ralph-hero plugin has 12 skills, 9 agents, 40+ hook scripts, and a 6-line spawn template. The architecture follows a 4-layer pattern (Scripts → Skills → Agents → MCP Tools) with strong structural enforcement via hooks.

### Key Discoveries:

- **Skills lack shared includes**: `conventions.md` handles artifact protocols and escalation, but nothing about task list usage, metadata practices, or communication patterns. Landcrawler's `task-list-patterns.md` shows the pattern but hasn't been adapted for ralph-hero's GitHub workflow.
- **Agent definitions are too thin**: `ralph-analyst.md` is 11 lines of content, `ralph-builder.md` is 15 lines. They have role identity but no behavioral coaching on patience, task list usage, or context passing.
- **Template integrity rules are overly strict**: `conventions.md:207-226` uses absolute language ("MUST NOT", "NEVER", "CRITICAL") to forbid adding any context to spawn prompts. This prevents the lead from passing useful metadata like artifact paths and GitHub URLs in task descriptions.
- **Hook guidance creates urgency loops**: `team-task-completed.sh` says "ACTION: Check pipeline convergence" on every completion. `team-teammate-idle.sh` fires guidance every idle cycle. These create a pattern of constant reactive checking.
- **Task metadata is underspecified**: Section 4.2 of `ralph-team/SKILL.md` describes task subjects but says nothing about what goes in task *descriptions* — the primary channel for passing context to teammates.
- **Result Format Contracts exist but are one-way**: `conventions.md:321-412` defines what workers report *back*, but there's no equivalent guidance for what the lead puts *into* task descriptions when creating tasks.

## Desired End State

After this plan:

1. **Shared includes** exist in `skills/shared/` providing reusable guidance for task list patterns and communication discipline
2. **Task descriptions** carry structured metadata (GitHub URLs, artifact paths, group membership, worktree info) that teammates can parse and use
3. **Agent definitions** carry short inline summaries of task list usage and communication, with **explicit pointers to the same shared includes** that the lead uses — ensuring lead and teammates share a single source of truth
4. **Hooks** use softer language that guides rather than demands, reducing the urgency-loop effect
5. **Template integrity rules** are relaxed to allow the lead to include structured context in task descriptions (not spawn prompts — those stay minimal)
6. **Every teammate** knows what to expect in a task description and how to use that information, because agent definitions and shared includes use consistent language
7. **Timing patience** is built into both sides: the lead avoids nudging immediately after assigning tasks, and teammates tolerate task list propagation delays gracefully

### Verification:

- [x] Each agent `.md` file contains inline summary + explicit pointer to `skills/shared/task-list-guide.md` and `skills/shared/team-communication.md`
- [x] `conventions.md` has new sections for Task Description Protocol and Communication Discipline
- [x] Hook scripts use "try/should/avoid" language instead of "MUST/NEVER/CRITICAL"
- [x] `ralph-team/SKILL.md` Section 4.2 has explicit task description templates with metadata fields, referencing `task-list-guide.md` as canonical source
- [x] The spawn template guidance in conventions.md is softened from "MUST NOT add context" to "try to keep spawn prompts minimal; put context in task descriptions instead"
- [x] Lead guidance includes "don't nudge immediately after assigning" principle
- [x] Teammate guidance includes "be patient if task list doesn't show your task yet" principle

## What We're NOT Doing

- Changing the 6-line spawn template itself (worker.md) — it stays minimal
- Adding messaging frequency counters or rate-limiting infrastructure — the system is event-based
- Restructuring the skill/agent/hook architecture — this is a guidance improvement, not a refactor
- Changing MCP tool implementations or state machine logic
- Modifying hook exit codes or enforcement behavior — only the guidance text changes
- Adding new skills or agents

## Implementation Approach

Changes flow from shared foundations (includes, conventions) outward to consumers (agents, skills, hooks). Phase 1 creates the reusable guidance. Phase 2 wires it into the team-lead skill. Phase 3 softens hooks. Phase 4 enhances agents.

---

## Phase 1: Create Shared Includes and Update Conventions

### Overview
Add reusable guidance documents to `skills/shared/` and extend `conventions.md` with new sections for task metadata and communication discipline.

### Changes Required

#### 1. Create `skills/shared/task-list-guide.md`

**File**: `plugin/ralph-hero/skills/shared/task-list-guide.md`
**Changes**: New file — task list usage guidance adapted for ralph-hero's GitHub workflow

Content should cover:
- **Task Description Protocol** — What goes in task descriptions when the lead creates tasks. Structured metadata fields:
  ```
  Task descriptions should include relevant context that helps the worker start quickly:

  **GitHub context** (when available):
  - Issue URL: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
  - Workflow state at time of task creation
  - Estimate (XS/S)

  **Artifact paths** (when the prior phase produced them):
  - Research doc: thoughts/shared/research/YYYY-MM-DD-GH-NNNN-description.md
  - Plan doc: thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-description.md
  - Worktree: worktrees/GH-NNN/

  **Group context** (when IS_GROUP is true):
  - Group primary: GH-NNN
  - Group members: GH-AAA, GH-BBB, GH-CCC
  - Phase ordering from dependencies

  **Structured format example**:
  Research GH-42: Add caching support.
  Issue: https://github.com/owner/repo/issues/42
  State: Research Needed | Estimate: S
  ```

- **Task metadata conventions** — Standard metadata keys that teammates can rely on:
  ```
  metadata: {
    "issue_number": "42",
    "issue_url": "https://github.com/owner/repo/issues/42",
    "command": "research",
    "phase": "research",
    "estimate": "S",
    "group_primary": "42",          // only for groups
    "group_members": "42,43,44",    // only for groups
    "artifact_path": "thoughts/...", // when prior artifact exists
    "worktree": "worktrees/GH-42/"  // when worktree exists
  }
  ```

- **TaskUpdate as results channel** — How workers report results:
  ```
  Workers report completion via TaskUpdate(description=...) using the
  Result Format Contracts from conventions.md. The lead reads results
  via TaskGet. This is the primary communication channel — prefer it
  over SendMessage for structured results.
  ```

- **Checking for existing tasks before creating** — The resumption pattern
- **Task ID conventions** — `T-N` for task list items vs `GH-NNN` for GitHub issues
- **Blocking patterns** — When to use `addBlockedBy` vs sequential processing
- **Task list propagation patience** — When spawned, your task may not appear in TaskList immediately. If you call TaskList and don't see a task matching your role, wait a few seconds and try again rather than assuming there's no work. The lead creates tasks and assigns them, but there can be a brief delay before they're visible to teammates.

#### 2. Create `skills/shared/team-communication.md`

**File**: `plugin/ralph-hero/skills/shared/team-communication.md`
**Changes**: New file — communication discipline for team agents

Content should cover:
- **Idle is normal** — Teammates go idle after every turn. This is expected behavior, not an error. The lead should avoid reacting to every idle notification.
- **TaskUpdate is the primary channel** — Structured results go in task descriptions. SendMessage is for exceptions and handoffs, not status updates.
- **When to use SendMessage**:
  - Escalation: you discovered something blocking that the lead should know about
  - Handoff: you finished your task and a specific peer should know (the Stop hook handles this for standard pipeline flow)
  - Question: you genuinely need information that isn't in your task description or skill context
- **When to avoid SendMessage**:
  - Acknowledging receipt of a task (just start working)
  - Reporting progress mid-task (update task description instead)
  - Confirming you're still working (idle notifications handle this)
  - Responding to idle notifications (they're informational)
- **Lead communication principles**:
  - Prefer creating/assigning tasks over sending messages
  - **Don't nudge after assigning** — After creating and assigning a task to a teammate, let them work. Avoid sending a follow-up message to "make sure they saw it" or to "remind them." The task assignment itself is the communication. If the worker is idle, the Stop hook will prevent premature shutdown and surface the task.
  - Avoid nudging workers who have been idle for less than 2 minutes
  - When a worker completes a task, check convergence first — don't message unless there's a decision to communicate
  - If a worker needs redirection, update their task description with the new context rather than sending a multi-paragraph message
- **Context passing examples** — Show concrete before/after examples of good vs bad task creation and messaging patterns

#### 3. Update `skills/shared/conventions.md`

**File**: `plugin/ralph-hero/skills/shared/conventions.md`
**Changes**: Add new sections, soften existing language

New sections to add:
- **Task Description Protocol** reference — Point to `task-list-guide.md` and summarize the key metadata fields that the lead should include
- **Communication Discipline** reference — Point to `team-communication.md` and summarize when to message vs when not to

Language softening throughout the file:
- Replace "MUST" → "should" where the constraint is behavioral guidance (not structural enforcement)
- Replace "NEVER" → "avoid" where violation isn't catastrophic
- Replace "CRITICAL" → "important" for emphasis without absolutism
- Keep "MUST" only where structural enforcement backs it (e.g., "First line is the key" in Result Format Contracts — hooks parse this)
- Keep "DO NOT" only where the anti-pattern would cause concrete failure (e.g., sub-agent team isolation — phantom teammates flood the lead)

Specific softening in Template Integrity section (`conventions.md:206-226`):
- Current: "Resolved template content is the COMPLETE prompt for spawned teammates. Orchestrators MUST NOT add context beyond placeholder substitution."
- New: "The resolved template content is the primary prompt for spawned teammates. Try to keep spawn prompts close to the template output. Additional context like artifact paths and group membership should go in task descriptions (via TaskCreate/TaskUpdate) rather than in the spawn prompt itself. This way teammates discover context through their task metadata rather than having it front-loaded."
- Current: "A correctly resolved prompt is 6-8 lines. If the prompt exceeds 10 lines, the orchestrator has violated template integrity by adding prohibited context."
- New: "A correctly resolved prompt is typically 6-8 lines. If the prompt exceeds 12-15 lines, consider whether the extra context would be better placed in the task description."

Specific softening in Template Authoring Rules (`conventions.md:206-210`):
- Current: "DO NOT include: conversation history, document contents, code snippets, assignment instructions"
- New: "Avoid including: conversation history, document contents, or lengthy code snippets. Brief contextual notes (1-2 lines) are acceptable when they help the worker orient faster."

### Success Criteria

#### Automated Verification:
- [x] File exists: `plugin/ralph-hero/skills/shared/task-list-guide.md`
- [x] File exists: `plugin/ralph-hero/skills/shared/team-communication.md`
- [x] `conventions.md` contains "Task Description Protocol" section
- [x] `conventions.md` contains "Communication Discipline" section
- [x] Word count check: `grep -c "MUST\|NEVER\|CRITICAL" conventions.md` reduced from 7 to 4

#### Manual Verification:
- [ ] New includes read naturally and provide actionable examples
- [ ] Language softening doesn't remove essential structural constraints
- [ ] Task metadata examples are realistic and match what MCP tools actually return

---

## Phase 2: Enhance Team-Lead Context Passing

### Overview
Update `ralph-team/SKILL.md` to specify what goes in task descriptions, how task metadata should be structured, and reference the new shared includes.

### Changes Required

#### 1. Update Section 4.2 (Create Tasks for Current Phase Only)

**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Changes**: Add task description templates to each phase's task creation rules

Currently Section 4.2 says things like:
```
- **RESEARCH**: `"Research GH-NNN"` per issue (for groups: per-member)
```

Expand each to include description template:
```
- **RESEARCH**:
  Subject: `"Research GH-NNN"`
  Description: Include issue URL, current workflow state, estimate, and any parent/group context from get_issue response.
  Metadata: `{ "issue_number": "NNN", "issue_url": "[url]", "command": "research", "phase": "research", "estimate": "[XS/S]" }`

- **PLAN**:
  Subject: `"Plan GH-NNN"` (group: `"Plan group GH-NNN"`)
  Description: Include issue URL, research document path(s) from artifact comments, group membership if applicable.
  Metadata: `{ "issue_number": "NNN", "issue_url": "[url]", "command": "plan", "phase": "plan", "artifact_path": "[research doc path]", "group_primary": "NNN", "group_members": "NNN,AAA,BBB" }`

- **IMPLEMENT**:
  Subject: `"Implement GH-NNN"`
  Description: Include issue URL, plan document path from artifact comments, worktree path if already created.
  Metadata: `{ "issue_number": "NNN", "issue_url": "[url]", "command": "impl", "phase": "implement", "artifact_path": "[plan doc path]", "worktree": "worktrees/GH-NNN/" }`
```

#### 2. Update Section 4.4 (Dispatch Loop)

**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Changes**: Add guidance about bough advancement context passing

When the lead creates next-bough tasks after convergence:
```
When creating next-bough tasks, carry forward artifact paths discovered during the
prior phase. For example, after research converges:
1. TaskGet each completed research task to extract artifact paths from the result description
2. Include those paths in the new Plan task descriptions
3. This saves the planner from having to re-discover artifacts via comments
```

#### 3. Update Section 5 (Behavioral Principles)

**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Changes**: Soften language and add communication discipline reference

Current:
```
- **Workers are autonomous**: After their initial pre-assigned task, workers self-claim from TaskList. Your job is ensuring workers exist and pre-assigning their first task at spawn.
```

Add:
```
- **Task descriptions are the context channel**: Put GitHub URLs, artifact paths, and group context in task descriptions. Workers read these via TaskGet before invoking their skill. This is more reliable than SendMessage because it persists and doesn't require the worker to be awake. See shared/task-list-guide.md for metadata field conventions.
- **Don't nudge after assigning**: After creating and assigning a task, let the worker discover it. Avoid sending a follow-up message "just to make sure." The task assignment is the communication. See shared/team-communication.md for the full principle.
- **Patience with idle workers**: Workers go idle after every turn — this is normal. Avoid reacting to idle notifications unless the pipeline has genuinely drained. See shared/team-communication.md for guidance.
```

#### 4. Update Section 6 (Teammate Spawning) — Template Integrity

**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Changes**: Soften template integrity rules

Current (lines 236-248):
```
**CRITICAL**: The resolved template content is the COMPLETE spawn prompt. Do NOT add any additional context.
**Rules**:
- The prompt passed to `Task()` must be the template output and NOTHING else
...
**Anti-patterns** (NEVER do these):
- Prepending root cause analysis, research hints, or investigation guidance
```

Replace with:
```
**Template guidance**: The resolved template content should be the primary spawn prompt. Try to keep the prompt close to the template output — typically 6-8 lines.

**Where to put additional context**:
- Task descriptions (via TaskCreate) — GitHub URLs, artifact paths, group membership, worktree paths
- Task metadata — Structured key-value pairs that teammates and hooks can parse
- Avoid putting lengthy analysis, code snippets, or multi-paragraph instructions in the spawn prompt

**Context that belongs in task descriptions, not spawn prompts**:
- Root cause analysis or investigation guidance
- File paths or code snippets
- Architectural context or background sections
- Research hints or prior findings

**Why**: Agents invoke skills in isolated context windows. The skill's own discovery process (reading GitHub comments, globbing for artifacts) provides canonical context. Task descriptions supplement this with quick-reference metadata.
```

#### 5. Update Section 9 (Known Limitations)

**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Changes**: Soften the idle guidance and messaging patterns

Current:
```
- **Idle is NORMAL**: Teammates fire idle notifications every turn. Do NOT shut down or re-send messages. Only worry if task stalled >5 min.
- **Fire-and-forget messages**: Wait 2 min, re-send once, then check manually.
```

Replace with:
```
- **Idle is normal**: Teammates go idle after every turn. This is expected behavior. Avoid shutting down workers or re-sending messages based solely on idle notifications. If a task appears stalled for more than 5 minutes, check the task description for progress updates before escalating.
- **Messages are fire-and-forget**: If a message doesn't get a response within 2 minutes, try re-sending once, then check the task list or work product directly.
```

### Success Criteria

#### Automated Verification:
- [x] `grep -c "Metadata:" plugin/ralph-hero/skills/ralph-team/SKILL.md` returns 7 (>= 3)
- [x] `grep -c "artifact_path" plugin/ralph-hero/skills/ralph-team/SKILL.md` returns 3 (>= 2)
- [x] `grep -c "CRITICAL" plugin/ralph-hero/skills/ralph-team/SKILL.md` reduced from 2 to 1
- [x] `grep -c "NEVER" plugin/ralph-hero/skills/ralph-team/SKILL.md` reduced from 4 to 3

#### Manual Verification:
- [ ] Task description templates are complete enough that a teammate can orient without additional messages
- [ ] Template integrity section still discourages large spawn prompts while allowing task description enrichment
- [ ] Behavioral principles section reads naturally without absolutist language

---

## Phase 3: Tune Hooks for Reduced Interference

### Overview
Soften hook guidance text to be less urgent and more advisory. No changes to hook logic, exit codes, or enforcement behavior — only the stderr messages that get injected into agent context.

### Changes Required

#### 1. Soften `team-task-completed.sh`

**File**: `plugin/ralph-hero/hooks/scripts/team-task-completed.sh`
**Changes**: Reduce urgency in guidance text

Current (non-review path):
```
Task completed by $TEAMMATE: "$TASK_SUBJECT"
ACTION: Check pipeline convergence via detect_pipeline_position.
If phase converged: create next-bough tasks (Section 4.2) and assign to idle workers.
If not converged: wait for remaining tasks to complete. No lead action needed.
CHECK: Are there idle workers with no unblocked tasks? If so, pull new GitHub issues.
```

Replace with:
```
Task completed by $TEAMMATE: "$TASK_SUBJECT"
Consider checking pipeline convergence via detect_pipeline_position.
If the phase has converged, create next-bough tasks (Section 4.2).
If not converged, no action needed — wait for remaining tasks.
```

The review path can stay similar but also soften "ACTION:" to just describe what to do.

#### 2. Soften `team-teammate-idle.sh`

**File**: `plugin/ralph-hero/hooks/scripts/team-teammate-idle.sh`
**Changes**: Reduce noise — idle is normal, guidance should be minimal

Current:
```
$TEAMMATE is idle.
This is NORMAL if upstream pipeline stages haven't completed yet.
Stop hook will block shutdown if matching tasks appear in TaskList.
ACTION: Only intervene if TaskList shows NO pending/in-progress tasks at all.
If pipeline is drained: use pick_actionable_issue to find new GitHub work.
```

Replace with:
```
$TEAMMATE is idle. This is normal — upstream stages may still be in progress.
```

This is a significant reduction. The rationale: idle notifications fire *constantly* and each one adds context tokens. The detailed guidance about pick_actionable_issue belongs in the skill document, not repeated in every idle notification.

#### 3. Soften `worker-stop-gate.sh`

**File**: `plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh`
**Changes**: Soften the guidance text (keep the exit 2 behavior)

Current:
```
Before stopping, check TaskList for pending tasks matching your role.
Look for tasks with "$KEYWORDS" in the subject that are pending and unblocked.
If matching tasks exist, claim and process them.
If no matching tasks exist, you may stop.
```

Replace with:
```
Before stopping, check TaskList for pending tasks matching your role ($KEYWORDS).
If matching tasks exist, try claiming and processing them.
If none are available, you may stop.
```

#### 4. Soften `team-stop-gate.sh`

**File**: `plugin/ralph-hero/hooks/scripts/team-stop-gate.sh`
**Changes**: Soften the guidance text when work is found

Current:
```
GitHub has $TOTAL_FOUND processable issues waiting:
$(echo -e "$SUMMARY")

Run the dispatch loop: check TaskList for unblocked tasks, spawn workers
for available roles, or use pick_actionable_issue to find new work.
Do NOT shut down while work remains.
```

Replace with:
```
GitHub has $TOTAL_FOUND processable issues that may need attention:
$(echo -e "$SUMMARY")

Consider checking TaskList for unblocked tasks or spawning workers for available roles.
```

#### 5. Review `post-blocker-reminder.sh` — keep as-is

This hook adds genuinely useful context about blocker verification. The language is already informational ("BLOCKER VERIFICATION REQUIRED") and fires only when blockedBy relations exist. No changes needed.

#### 6. Review `artifact-discovery.sh` — keep as-is

This hook provides reminder-level guidance (uses `warn()` not `block()`). Already appropriately soft.

#### 7. Review `pre-artifact-validator.sh` — soften slightly

**File**: `plugin/ralph-hero/hooks/scripts/pre-artifact-validator.sh`
**Changes**: Soften the blocking message

Current:
```
DUPLICATE ARTIFACT BLOCKED

A $ARTIFACT_TYPE document for $TICKET_ID already exists:
  $EXISTING

Actions:
1. If this is intentional (updating existing): Use Edit tool instead of Write
2. If this is a retry: Check if ticket already has document attached
3. If different content needed: Use a unique filename suffix
```

Replace with:
```
A $ARTIFACT_TYPE document for $TICKET_ID already exists:
  $EXISTING

If updating the existing document, use the Edit tool instead of Write.
If this is a different artifact, use a unique filename suffix.
```

### Success Criteria

#### Automated Verification:
- [x] `grep -c "ACTION:" plugin/ralph-hero/hooks/scripts/team-task-completed.sh` returns 0
- [x] `grep -c "ACTION:" plugin/ralph-hero/hooks/scripts/team-teammate-idle.sh` returns 0
- [x] `grep -c "Do NOT" plugin/ralph-hero/hooks/scripts/team-stop-gate.sh` returns 0
- [ ] All hook scripts still pass shellcheck: `shellcheck plugin/ralph-hero/hooks/scripts/*.sh` (shellcheck not installed)
- [x] Hook exit codes unchanged: all scripts preserve original exit 0/exit 2 behavior

#### Manual Verification:
- [ ] `team-teammate-idle.sh` output is noticeably shorter than before
- [ ] `team-task-completed.sh` guidance feels advisory rather than commanding
- [ ] Blocking hooks still provide enough information for agents to self-correct

---

## Phase 4: Enhance Agent Definitions with Shared-Reference Behavioral Coaching

### Overview
Add consistent guidance to all 4 team agent definitions (analyst, builder, validator, integrator) using a **short inline summary + pointer to shared includes** pattern. This ensures teammates and the lead share the same source of truth for task list conventions and communication discipline, rather than maintaining parallel guidance that can diverge.

### Design Principle: Inline Summary + Shared Reference

Agent definitions are loaded as system prompts — they can't auto-include other files. But they can:
1. Carry a **short inline summary** of the essential behaviors (enough to orient immediately)
2. Include **explicit pointers** to the shared includes for the full conventions

The shared includes (`skills/shared/task-list-guide.md` and `skills/shared/team-communication.md`) from Phase 1 are the **canonical source of truth**. The lead's skill (`ralph-team/SKILL.md`) references these same files. This means both sides speak the same language about task metadata fields, communication patterns, and timing expectations.

### Changes Required

#### 1. Define the common inline block

All 4 agents get this block (adapted per role), placed after the role identity line and before role-specific sections. Target: ~15-20 lines of inline guidance + 2 lines of shared-include pointers.

```markdown
## Working with Tasks

1. Read your task via TaskGet before starting — descriptions contain GitHub URLs, artifact paths, and group context
2. Use metadata fields (issue_number, artifact_path, worktree) to orient before invoking your skill
3. Report results via TaskUpdate(description=...) using Result Format Contracts
4. Check TaskList for more matching tasks before stopping
5. **If TaskList doesn't show your task yet, wait a few seconds and retry** — there can be a brief propagation delay after the lead assigns work

## Communication

- **TaskUpdate is your primary channel** — structured results go in task descriptions, not messages
- **Avoid unnecessary messages** — don't acknowledge tasks, report routine progress, or respond to idle notifications
- **SendMessage is for exceptions** — escalations, blocking discoveries, or questions not answerable from your task description
- **Be patient** — idle is normal; the Stop hook blocks premature shutdown when matching tasks exist

For full task metadata conventions: see `skills/shared/task-list-guide.md`
For full communication discipline: see `skills/shared/team-communication.md`
```

**Why this works**: The inline summary gives teammates enough to operate correctly from the moment they're spawned. The pointers to shared includes mean that if a teammate needs the full spec (e.g., what metadata keys to expect, when to use SendMessage vs TaskUpdate in edge cases), they `Read()` the same document the lead uses. No divergence.

#### 2. Update `agents/ralph-analyst.md`

**File**: `plugin/ralph-hero/agents/ralph-analyst.md`
**Changes**: Add the inline block, keep the existing SPLIT/TRIAGE note and shutdown section

#### 3. Update `agents/ralph-builder.md`

**File**: `plugin/ralph-hero/agents/ralph-builder.md`
**Changes**: Add the inline block, keep existing revision handling and implementation notes

#### 4. Update `agents/ralph-validator.md`

**File**: `plugin/ralph-hero/agents/ralph-validator.md`
**Changes**: Add the inline block, keep existing verdict reporting note

#### 5. Update `agents/ralph-integrator.md`

**File**: `plugin/ralph-hero/agents/ralph-integrator.md`
**Changes**: Add the inline block, keep existing PR and merge procedures. Adapt "invoking your skill" language to reference the PR/Merge procedures in the agent definition itself (integrator has no Skill() call).

### Success Criteria

#### Automated Verification:
- [x] `grep -l "Working with Tasks" plugin/ralph-hero/agents/ralph-*.md | wc -l` returns 4
- [x] `grep -l "Communication" plugin/ralph-hero/agents/ralph-*.md | wc -l` returns 4
- [x] `grep -l "task-list-guide.md" plugin/ralph-hero/agents/ralph-*.md | wc -l` returns 4
- [x] `grep -l "team-communication.md" plugin/ralph-hero/agents/ralph-*.md | wc -l` returns 4
- [x] Agent line counts: analyst=38, builder=45, validator=43, integrator=73 (integrator exceeds 60 due to essential PR/Merge procedures)

#### Manual Verification:
- [ ] Each agent's inline block reads naturally when combined with its existing content
- [ ] Pointers to shared includes are clear and actionable (worker knows to `Read()` them if needed)
- [ ] Integrator adaptation makes sense given that integrator doesn't use standard skill invocation
- [ ] The guidance uses "try/should/avoid" not "MUST/NEVER"
- [ ] **Same metadata field names** appear in agent inline blocks and in `task-list-guide.md` — no divergent terminology

---

## Integration Testing

- [x] Read through the full flow: lead creates team → creates tasks with metadata → spawns worker with template → worker reads task via TaskGet → worker invokes skill → worker reports via TaskUpdate → lead reads result and creates next-bough tasks. Context flows through each handoff point via task descriptions and metadata.
- [x] **Shared-reference consistency check**: Metadata field names (issue_number, artifact_path, worktree, issue_url, group_primary, group_members) are identical across task-list-guide.md, SKILL.md Section 4.2, and agent inline blocks.
- [x] **Timing patience check**: "Don't nudge after assigning" appears in both team-communication.md and SKILL.md Section 5. "Task list propagation patience" appears in task-list-guide.md and all 4 agent inline blocks.
- [x] Hook message changes preserve re-entry safety patterns (stop_hook_active checks unchanged, exit codes unchanged)
- [x] conventions.md language changes are consistent with skill documents -- remaining MUST instances are in structurally-enforced sections (Result Format Contracts, Artifact Comment Protocol)

## File Ownership Summary

| Phase | Files Modified | Files Created |
|-------|---------------|---------------|
| 1 | `skills/shared/conventions.md` | `skills/shared/task-list-guide.md`, `skills/shared/team-communication.md` |
| 2 | `skills/ralph-team/SKILL.md` | (none) |
| 3 | `hooks/scripts/team-task-completed.sh`, `hooks/scripts/team-teammate-idle.sh`, `hooks/scripts/worker-stop-gate.sh`, `hooks/scripts/team-stop-gate.sh`, `hooks/scripts/pre-artifact-validator.sh` | (none) |
| 4 | `agents/ralph-analyst.md`, `agents/ralph-builder.md`, `agents/ralph-validator.md`, `agents/ralph-integrator.md` | (none) |

## References

- Landcrawler task-list-patterns: `landcrawler-ai/.claude/commands/includes/task-list-patterns.md`
- Current conventions: `plugin/ralph-hero/skills/shared/conventions.md`
- Current team skill: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
- Current spawn template: `plugin/ralph-hero/templates/spawn/worker.md`
- Agent definitions: `plugin/ralph-hero/agents/ralph-*.md`
- Hook scripts: `plugin/ralph-hero/hooks/scripts/*.sh`
