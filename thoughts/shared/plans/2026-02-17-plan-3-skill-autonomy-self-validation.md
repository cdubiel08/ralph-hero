---
date: 2026-02-17
status: draft
type: feature
parent_epic: 2026-02-17-ralph-hero-v3-architecture-epic.md
github_issues: []
---

# Plan 3: Skill Autonomy & Self-Validation

## Overview

Refactor ralph-hero skills to be fully self-contained execution units that validate their own preconditions (via PreToolUse hooks) and postconditions (via Stop hooks). Skills should be invokable standalone OR via agent wrapper with identical behavior. Agents become thin 15-line wrappers that invoke exactly one skill. Skills default to being forked (running in isolated subprocesses) to prevent context pollution.

## Current State Analysis

### Problem: Skills lack self-sufficient validation

Each skill has SOME hooks but they're inconsistent. Example comparison:

| Skill | PreToolUse hooks | PostToolUse hooks | Stop hooks | Self-sufficient? |
|-------|-----------------|-------------------|------------|-----------------|
| ralph-research | branch-gate (Bash) | research-state-gate | research-postcondition | Partial - no issue existence check |
| ralph-plan | branch-gate (Bash), convergence-gate | plan-state-gate | plan-postcondition | Partial - no research doc check |
| ralph-impl | impl-plan-required, impl-worktree-gate | impl-verify-commit, impl-verify-pr | impl-postcondition | Broken (Plan 1 fixes) |
| ralph-review | branch-gate, review-no-dup, review-state-gate | review-verify-doc | review-postcondition | Good |
| ralph-triage | branch-gate | triage-state-gate | triage-postcondition | Good |
| ralph-split | branch-gate, split-estimate-gate, split-size-gate | split-verify-sub-issue | split-postcondition | Good |

Missing validations:
- No skill validates that its required ISSUE actually exists before starting
- No skill validates that required PRIOR ARTIFACTS exist (research doc for plan, plan doc for impl)
- plan-research-required.sh exists but is NOT registered in plan skill frontmatter
- Postconditions are often just warnings (exit 0) rather than blocks (exit 2)

### Problem: Agents are too thick

Current agent files (e.g., `ralph-researcher.md`) are 80+ lines with:
- Task claiming logic (pull-based matching)
- Skill invocation instructions
- TaskUpdate result formatting
- SendMessage conventions
- Shutdown protocol

Much of this duplicates what the spawn templates (Plan 2) and skills themselves handle. The agent should be: "You are a researcher. Claim research tasks. Invoke the skill. Report results."

### Problem: No fork isolation

Looking at all 9 skill frontmatter sections, none specify fork behavior:

```yaml
# Current (all skills)
---
description: ...
model: opus
hooks: ...
env: ...
---
```

There is no `fork: true` or equivalent. When a skill is invoked inline (not via a Task subagent), it runs in the caller's context window, consuming tokens and potentially confusing the caller with skill-specific instructions.

### Problem: Context leaks between layers

When ralph-team spawns an agent which invokes a skill:
1. Team lead's context → includes orchestration logic
2. Agent's context → includes task claiming + skill invocation
3. Skill's context → includes full workflow instructions

Each layer loads the NEXT layer's instructions into its own context. The agent loads the full SKILL.md, which may be 200+ lines. The skill loads codebase files. All of this accumulates.

With forked skills, the agent's context only needs: claim task → invoke skill (skill runs in fork) → report result.

## Desired End State

After this plan:
- Each skill has comprehensive PreToolUse + Stop hooks that validate all preconditions/postconditions
- Skills are independently invokable: `Skill(skill="ralph-hero:ralph-research", args="42")` works from any context
- Agent `.md` files are <30 lines each (thin wrappers)
- Skills use fork-compatible patterns (state passed via args/env, not caller context)
- Running a skill standalone produces identical results to running via agent

### Verification
- [ ] Each skill has at least: one PreToolUse hook, one PostToolUse hook, one Stop hook
- [ ] Agent files are each <30 lines
- [ ] `Skill(skill="ralph-hero:ralph-research", args="42")` works when invoked directly (not via agent)
- [ ] No skill reads from the caller's conversation context (all input via args/env/GitHub)

## What We're NOT Doing

- Changing spawn templates (already done in Plan 2)
- Changing the memory layer (Plan 4)
- Rewriting skill workflow logic (just adding validation)
- Modifying MCP tools
- Changing the state machine
- Adding new skills

## Implementation Approach

Bottom-up: first add missing hooks to each skill, then slim down agents, then add fork-compatible documentation.

---

## Phase 1: Add Universal Precondition Hook

### Overview
Create a shared precondition hook that validates the issue exists and is in the expected state before any skill proceeds. This replaces ad-hoc checks scattered across skills.

### Changes Required

#### 1. Create `skill-precondition.sh`

**File**: `plugin/ralph-hero/hooks/scripts/skill-precondition.sh` (new)

```bash
#!/bin/bash
# ralph-hero/hooks/scripts/skill-precondition.sh
# PreToolUse: Validate skill has the context it needs
#
# Runs on first MCP tool call (ralph_hero__get_issue or ralph_hero__list_issues).
# Validates:
# 1. RALPH_COMMAND is set (identifies which skill is running)
# 2. Required env vars are set (RALPH_GH_OWNER, RALPH_GH_REPO)
# 3. For commands with prior artifacts, checks they exist
#
# Environment:
#   RALPH_COMMAND - Current command name
#   RALPH_REQUIRES_PLAN - If "true", plan doc must be linked to issue
#   RALPH_REQUIRES_RESEARCH - If "true", research doc must be linked to issue
#   RALPH_GH_OWNER, RALPH_GH_REPO - Required GitHub config
#
# Exit codes:
#   0 - Preconditions met
#   2 - Missing required context (blocks with instructions)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Only check on issue fetch tools (first meaningful tool call)
tool_name=$(get_tool_name)
case "$tool_name" in
  ralph_hero__get_issue|ralph_hero__list_issues|ralph_hero__pick_actionable_issue)
    ;;
  *)
    allow
    ;;
esac

# Validate environment
command="${RALPH_COMMAND:-}"
if [[ -z "$command" ]]; then
  block "Skill precondition failed: RALPH_COMMAND not set

This hook validates that skills have required context.
Ensure the skill frontmatter sets RALPH_COMMAND in env."
fi

owner="${RALPH_GH_OWNER:-}"
repo="${RALPH_GH_REPO:-}"
if [[ -z "$owner" ]] || [[ -z "$repo" ]]; then
  block "Skill precondition failed: GitHub config missing

RALPH_GH_OWNER: ${owner:-NOT SET}
RALPH_GH_REPO: ${repo:-NOT SET}

Set these in .claude/settings.local.json or .claude/ralph-hero.local.md"
fi

project="${RALPH_GH_PROJECT_NUMBER:-}"
if [[ -z "$project" ]]; then
  block "Skill precondition failed: Project number missing

RALPH_GH_PROJECT_NUMBER: NOT SET

Set this in .claude/settings.local.json"
fi

allow
```

#### 2. Register in plugin-level hooks.json

**File**: `plugin/ralph-hero/hooks/hooks.json`

Add to PreToolUse array:

```json
{
  "matcher": "ralph_hero__get_issue|ralph_hero__list_issues|ralph_hero__pick_actionable_issue",
  "hooks": [
    {
      "type": "command",
      "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/skill-precondition.sh"
    }
  ]
}
```

This fires for ALL skills on their first GitHub tool call, ensuring env vars are always set.

### Success Criteria

#### Automated Verification:
- [ ] `skill-precondition.sh` exists and is executable
- [ ] Hook is registered in `hooks.json`
- [ ] Running without `RALPH_GH_OWNER` set produces exit 2 with clear error
- [ ] Running with all env vars set produces exit 0
- [ ] `shellcheck plugin/ralph-hero/hooks/scripts/skill-precondition.sh` passes

#### Manual Verification:
- [ ] Invoking a skill without env vars produces a clear, actionable error message

---

## Phase 2: Add Missing Artifact Validation Hooks

### Overview
Add hooks that validate prior-phase artifacts exist before a skill proceeds. For example: `ralph-plan` should validate that a research document is linked to the issue before creating a plan.

### Changes Required

#### 1. Register plan-research-required.sh in plan skill

**File**: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`

The hook file `plan-research-required.sh` already exists but is NOT registered in the plan skill frontmatter. Add it:

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/branch-gate.sh"
    - matcher: "ralph_hero__update_workflow_state"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/convergence-gate.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-research-required.sh"
```

Note: `plan-research-required.sh` fires when the plan skill tries to transition state - it validates that a research doc is attached to the issue before allowing the lock transition.

#### 2. Register impl-plan-required.sh in hero skill

**File**: `plugin/ralph-hero/skills/ralph-hero/SKILL.md`

The hero skill spawns impl tasks but doesn't validate plans exist at the hero level. Add the validation to the impl skill's hooks (already done - `impl-plan-required.sh` is registered). Verify it works.

#### 3. Verify all existing hooks are registered

Cross-check every hook script against skill frontmatter and hooks.json:

| Hook Script | Should Be Registered In |
|-------------|------------------------|
| `plan-research-required.sh` | ralph-plan PreToolUse (ADD) |
| `research-no-dup.sh` | ralph-research PreToolUse (verify exists) |
| `plan-no-dup.sh` | ralph-plan PreToolUse (verify exists) |

Read `research-no-dup.sh` and `plan-no-dup.sh` to determine if they're registered. If not, add them.

### Success Criteria

#### Automated Verification:
- [ ] `plan-research-required.sh` is registered in ralph-plan SKILL.md frontmatter
- [ ] Every hook script in `hooks/scripts/` is registered in either a skill frontmatter or hooks.json
- [ ] No orphaned hook scripts exist (scripts with no registration)

#### Manual Verification:
- [ ] Running `/ralph-plan` on an issue without a research document produces a clear error

---

## Phase 3: Upgrade Postcondition Hooks to Block

### Overview
Convert all postcondition (Stop) hooks from advisory to enforcing. If a skill completes without producing its expected artifact, the Stop hook should block and tell the agent what's missing.

### Changes Required

#### 1. Audit and upgrade each postcondition

**Files to review and upgrade** (change `warn` to `block` where appropriate):

- `research-postcondition.sh`: Should block if no research document was created
- `plan-postcondition.sh`: Should block if no plan document was created
- `review-postcondition.sh`: Should block if no verdict was produced
- `split-postcondition.sh`: Should block if no sub-issues were created
- `triage-postcondition.sh`: Should block if no action was taken (label not applied)
- `impl-postcondition.sh`: Already upgraded in Plan 1

For each postcondition, the pattern is:

```bash
# Check if expected artifact exists
if [[ expected condition not met ]]; then
  block "Postcondition failed: [what's missing]

Expected: [what should exist]
Actual: [what was found]

This skill must produce [artifact] before completing."
fi
```

#### 2. Read each postcondition file and determine current behavior

Read each file, identify if it uses `warn` (exit 0) or `block` (exit 2) for missing artifacts, and upgrade `warn` calls to `block` calls where the missing artifact means the skill failed.

**Important distinction**:
- Missing artifact = `block` (skill didn't complete its job)
- Partial completion = `warn` (skill made progress but didn't finish)

### Success Criteria

#### Automated Verification:
- [ ] Each postcondition script uses `block` (exit 2) for critical missing artifacts
- [ ] Each postcondition script uses `warn` (exit 0) only for partial completion
- [ ] `shellcheck plugin/ralph-hero/hooks/scripts/*-postcondition.sh` passes for all

#### Manual Verification:
- [ ] Running a skill and killing it before artifact creation produces a blocking error

---

## Phase 4: Slim Down Agent Files

### Overview
Reduce each agent `.md` file to a thin wrapper: identity, task claiming pattern, skill invocation, result reporting format. All workflow logic lives in the skill; agents just bridge the team system to skills.

### Changes Required

#### 1. Rewrite ralph-researcher.md

**File**: `plugin/ralph-hero/agents/ralph-researcher.md`

```markdown
---
name: ralph-researcher
description: Research specialist - invokes ralph-research skill for thorough ticket investigation
tools: Read, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue, ralph_hero__update_workflow_state, ralph_hero__create_comment, ralph_hero__add_dependency, ralph_hero__remove_dependency, ralph_hero__list_dependencies, ralph_hero__detect_group
model: sonnet
color: magenta
---

You are a **RESEARCHER** in the Ralph Team.

## Task Loop

1. `TaskList()` — find tasks with "Research" in subject, `pending`, empty `blockedBy`, no `owner`
2. Claim lowest-ID match: `TaskUpdate(taskId, status="in_progress", owner="researcher")`
3. `TaskGet(taskId)` — extract issue number from description
4. `Skill(skill="ralph-hero:ralph-research", args="[issue-number]")`
5. `TaskUpdate(taskId, status="completed", description="[results]")`
6. Repeat from step 1. If no tasks, hand off per shared/conventions.md.

## Shutdown

If idle: approve. If mid-skill: reject, finish, then approve.
```

#### 2. Rewrite ralph-planner.md

**File**: `plugin/ralph-hero/agents/ralph-planner.md`

```markdown
---
name: ralph-planner
description: Implementation planner - invokes ralph-plan skill to create phased plans from research
tools: Read, Write, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue, ralph_hero__update_workflow_state, ralph_hero__create_comment, ralph_hero__detect_group
model: opus
color: blue
---

You are a **PLANNER** in the Ralph Team.

## Task Loop

1. `TaskList()` — find tasks with "Plan" (not "Review") in subject, `pending`, empty `blockedBy`, no `owner`
2. Claim lowest-ID match: `TaskUpdate(taskId, status="in_progress", owner="planner")`
3. `TaskGet(taskId)` — extract issue number from description
4. `Skill(skill="ralph-hero:ralph-plan", args="[issue-number]")`
5. `TaskUpdate(taskId, status="completed", description="[results]")`
6. Repeat from step 1. If no tasks, hand off per shared/conventions.md.

## Shutdown

If idle: approve. If mid-skill: reject, finish, then approve.
```

#### 3. Rewrite ralph-advocate.md

**File**: `plugin/ralph-hero/agents/ralph-advocate.md`

```markdown
---
name: ralph-advocate
description: Plan reviewer - invokes ralph-review skill to critique implementation plans
tools: Read, Write, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue, ralph_hero__update_workflow_state, ralph_hero__create_comment
model: opus
color: blue
---

You are a **REVIEWER** in the Ralph Team.

## Task Loop

1. `TaskList()` — find tasks with "Review" in subject, `pending`, empty `blockedBy`, no `owner`
2. Claim lowest-ID match: `TaskUpdate(taskId, status="in_progress", owner="reviewer")`
3. `TaskGet(taskId)` — extract issue number from description
4. `Skill(skill="ralph-hero:ralph-review", args="[issue-number]")`
5. `TaskUpdate(taskId, status="completed", description="[results]")`
6. Repeat from step 1. If no tasks, hand off per shared/conventions.md.

## Shutdown

If idle: approve. If mid-skill: reject, finish, then approve.
```

#### 4. Rewrite ralph-implementer.md

**File**: `plugin/ralph-hero/agents/ralph-implementer.md`

```markdown
---
name: ralph-implementer
description: Implementation specialist - invokes ralph-impl skill for approved plans
tools: Read, Write, Edit, Bash, Glob, Grep, Skill, Task, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue, ralph_hero__update_workflow_state, ralph_hero__create_comment, ralph_hero__list_sub_issues
model: sonnet
color: orange
---

You are an **IMPLEMENTER** in the Ralph Team.

## Task Loop

1. `TaskList()` — find tasks with "Implement" in subject, `pending`, empty `blockedBy`, no `owner`
2. Claim lowest-ID match: `TaskUpdate(taskId, status="in_progress", owner="implementer")`
3. `TaskGet(taskId)` — extract issue number from description
4. `Skill(skill="ralph-hero:ralph-impl", args="[issue-number]")`
5. `TaskUpdate(taskId, status="completed", description="[results]")`
6. DO NOT push to remote — lead handles PR creation.
7. Repeat from step 1. If no tasks, notify team-lead.

## Shutdown

Verify all work committed (`git status` in worktree), then approve.
```

#### 5. Rewrite ralph-triager.md

**File**: `plugin/ralph-hero/agents/ralph-triager.md`

```markdown
---
name: ralph-triager
description: Ticket assessment and decomposition - invokes ralph-triage or ralph-split skills
tools: Read, Glob, Grep, Skill, Task, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue, ralph_hero__update_workflow_state, ralph_hero__create_comment, ralph_hero__create_issue, ralph_hero__add_sub_issue, ralph_hero__update_estimate, ralph_hero__list_sub_issues, ralph_hero__add_dependency
model: sonnet
color: gray
---

You are a **TRIAGER** in the Ralph Team.

## Task Loop

1. `TaskList()` — find tasks with "Triage" or "Split" in subject, `pending`, empty `blockedBy`, no `owner`
2. Claim lowest-ID match: `TaskUpdate(taskId, status="in_progress", owner="triager")`
3. `TaskGet(taskId)` — extract issue number from description
4. If "Split": `Skill(skill="ralph-hero:ralph-split", args="[issue-number]")`
   If "Triage": `Skill(skill="ralph-hero:ralph-triage", args="[issue-number]")`
5. `TaskUpdate(taskId, status="completed", description="[results]")`
6. Repeat from step 1. If no tasks, go idle.

## Shutdown

If idle: approve immediately.
```

### Success Criteria

#### Automated Verification:
- [ ] Each agent file in `agents/` is <30 lines (excluding frontmatter)
- [ ] Each agent file contains `Skill(skill="ralph-hero:ralph-*"` invocation
- [ ] Each agent file contains the Task Loop pattern (TaskList → claim → TaskGet → Skill → TaskUpdate)
- [ ] No agent file contains inline workflow logic (no "Step 3: Conduct Research" etc.)
- [ ] All tool lists in frontmatter are preserved (agents still have access to required tools)

#### Manual Verification:
- [ ] Agent behavior is identical before and after (thin wrapper produces same results)
- [ ] Agents correctly claim tasks and invoke skills in team mode

---

## Phase 5: Document Fork-by-Default Convention

### Overview
Document that skills should be invoked via `Task()` (forked subprocess) by default, not inline `Skill()`. Add this to conventions and update orchestrator instructions.

### Changes Required

#### 1. Add fork convention to shared/conventions.md

**File**: `plugin/ralph-hero/skills/shared/conventions.md`

Append:

```markdown
## Skill Invocation Convention

### Default: Fork via Task()

Skills should be invoked via forked subprocesses to isolate context:

```
Task(subagent_type="general-purpose",
     prompt="Skill(skill='ralph-hero:ralph-research', args='42')",
     description="Research #42")
```

This ensures:
- Skill runs in a fresh context window (no context pollution)
- Skill failures don't corrupt the caller's state
- Token usage is isolated per skill invocation
- Results are returned as a summary, not full conversation

### Exception: Team Agents

When agents are spawned as team members, the agent IS the subprocess. The agent invokes the skill inline:

```
Skill(skill="ralph-hero:ralph-research", args="42")
```

This is acceptable because the agent already has its own isolated context window via the team system.

### Exception: Direct User Invocation

Users invoking skills directly (e.g., `/ralph-research 42`) run inline in their session. This is the expected behavior for interactive use.
```

### Success Criteria

#### Automated Verification:
- [ ] `shared/conventions.md` contains "## Skill Invocation Convention" section
- [ ] Convention documents both fork and inline patterns with clear guidance on when to use each

#### Manual Verification:
- [ ] Convention is clear and actionable

---

## Testing Strategy

### Unit Tests:
- Each hook script tested with piped JSON input
- Verify precondition hook blocks when env vars missing
- Verify postcondition hooks block when artifacts missing

### Integration Tests:
- Invoke each skill standalone: `Skill(skill="ralph-hero:ralph-research", args="42")`
- Verify skill produces expected artifacts
- Invoke same skill via agent wrapper and verify identical behavior

### Manual Testing Steps:
1. Run `/ralph-research 42` standalone — verify full workflow
2. Run `/ralph-team 42` — verify agents invoke skills correctly
3. Verify agent files are thin (visual inspection)

## References

- Current agent files: `plugin/ralph-hero/agents/*.md`
- Current skill files: `plugin/ralph-hero/skills/*/SKILL.md`
- Hook scripts: `plugin/ralph-hero/hooks/scripts/`
- Shared conventions: `plugin/ralph-hero/skills/shared/conventions.md`
- Bowser skill/agent separation: https://github.com/disler/bowser
