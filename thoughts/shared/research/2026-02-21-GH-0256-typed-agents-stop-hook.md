---
date: 2026-02-21
github_issue: 256
github_url: https://github.com/cdubiel08/ralph-hero/issues/256
status: complete
type: research
---

# GH-256: Activate Typed Agents and Add Worker Stop Hook

## Problem Statement

Workers are spawned as `general-purpose` (`SKILL.md:224`), so the agent definitions in `agents/ralph-*.md` never load as system prompts. This means:
1. The role-specific knowledge (Task Loop, dispatch tables, procedures) is dead code
2. Workers have no Stop hook, so they rely on inline "check TaskList" instructions in the spawn template for work discovery
3. The integrator's PR Creation and Merge procedures are unreachable

GH-256 activates typed agents (changing `subagent_type` from `general-purpose` to role-specific values) and adds a worker Stop hook (`worker-stop-gate.sh`) that replaces inline work-discovery instructions.

## Current State

### Agent Definitions (4 files)

| File | Lines | Body Content | Hooks |
|------|-------|-------------|-------|
| `agents/ralph-analyst.md` | 30 | Task Loop (scan/claim/dispatch for triage/split/research), shutdown | None |
| `agents/ralph-builder.md` | 35 | Task Loop (plan/implement), revision handling, "DO NOT push" note, shutdown | None |
| `agents/ralph-validator.md` | 28 | Task Loop (review/validate), optional mode note, shutdown | None |
| `agents/ralph-integrator.md` | 62 | Task Loop + PR Creation Procedure (15 lines) + Merge Procedure (18 lines), serialization note, shutdown | None |

**Common pattern in all 4**: A 7-step Task Loop that scans TaskList, claims tasks, dispatches by subject keyword, reports via TaskUpdate, and repeats. This loop duplicates what the spawn template already instructs.

### Spawn Procedure (`SKILL.md:222-227`)

```
Task(subagent_type="general-purpose", team_name=TEAM_NAME, name="[role]",
     prompt=[resolved template content],
     description="[Role] GH-NNN")
```

The spawn table (`SKILL.md:190-199`) lists `general-purpose` for all roles in the "Agent type" column.

### Worker Template (`worker.md`)

Line 7: `Then check TaskList for more tasks matching your role. If none, notify team-lead.`

This inline work-discovery instruction is the only mechanism keeping workers from stopping after their first task. With typed agents and a Stop hook, this line moves to the hook.

### Existing Hooks

- `team-stop-gate.sh` (52 lines): Lead stop hook. Checks GitHub for processable issues. Pattern to follow.
- `team-teammate-idle.sh` (27 lines): Contains "Peers will wake this teammate" -- guidance only.
- `hook-utils.sh` (167 lines): Shared utilities (`read_input()`, `block()`, `warn()`, `allow()`).

## Analysis

### Part 1: Activating Typed Agents

**Change**: In `SKILL.md:190-199` spawn table, change the "Agent type" column from `general-purpose` to the agent name:

| Task subject contains | Role | Agent type (current) | Agent type (proposed) |
|----------------------|------|---------------------|----------------------|
| "Triage" | analyst | general-purpose | ralph-analyst |
| "Split" | analyst | general-purpose | ralph-analyst |
| "Research" | analyst | general-purpose | ralph-analyst |
| "Plan" (not "Review") | builder | general-purpose | ralph-builder |
| "Review" | validator | general-purpose | ralph-validator |
| "Implement" | builder | general-purpose | ralph-builder |
| "Create PR" | integrator | general-purpose | ralph-integrator |
| "Merge" or "Integrate" | integrator | general-purpose | ralph-integrator |

And in `SKILL.md:224`:
```
Task(subagent_type="[agent-type-from-table]", team_name=TEAM_NAME, name="[role]",
```

**Effect**: Agent definitions load as system prompts. The worker gets both:
1. The spawn template as the initial prompt (task-specific context)
2. The agent definition as the system prompt (role-specific behavior, tools, hooks)

### Part 2: Slimming Agent Definitions

When typed agents are active, the Task Loop is redundant with the spawn template. Workers arrive with a pre-assigned task and clear instructions. The agent definition should provide:

1. **Identity and behavioral constraints** (1-3 lines)
2. **Stop hook** (in frontmatter -- replaces inline work discovery)
3. **Role-specific procedures** (integrator only -- PR/Merge procedures)
4. **Shutdown behavior** (1 line)

**Proposed slim structure** (all agents except integrator):

```markdown
---
name: ralph-[role]
description: [unchanged]
tools: [unchanged]
model: [unchanged]
color: [unchanged]
hooks:
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/worker-stop-gate.sh"
---

You are a **[ROLE]** in the Ralph Team.

[1-2 role-specific behavioral constraints if any]

## Shutdown

[1 line -- unchanged from current]
```

**Target sizes**: analyst ~12 lines, builder ~15 lines (keep "DO NOT push" + revision handling), validator ~12 lines, integrator ~35 lines (keep PR/Merge procedures, remove Task Loop wrapper).

### Part 3: Worker Stop Hook (`worker-stop-gate.sh`)

**Purpose**: When a worker finishes a task and tries to stop, check if more work exists before allowing it.

**Design**:

```bash
#!/bin/bash
# worker-stop-gate.sh
# Stop: Prevent workers from stopping while matching tasks exist
#
# Checks TaskList for tasks matching the worker's role.
# Uses CLAUDE_TEAM_NAME and worker name from stdin JSON.
#
# Exit codes:
#   0 - No matching work, allow stop
#   2 - Work exists, block stop with guidance

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

INPUT=$(cat)

# Extract worker info from stdin
TEAMMATE=$(echo "$INPUT" | jq -r '.teammate_name // "unknown"')

# Map worker name to task subject keywords
case "$TEAMMATE" in
  analyst*)  KEYWORDS=("Research" "Triage" "Split") ;;
  builder*)  KEYWORDS=("Plan" "Implement") ;;
  validator*) KEYWORDS=("Review" "Validate") ;;
  integrator*) KEYWORDS=("Create PR" "Merge" "Integrate") ;;
  *)         exit 0 ;; # Unknown role, allow stop
esac

# Check TaskList output (from stdin or via tool)
# The hook receives task list state in the input JSON
TASKS=$(echo "$INPUT" | jq -r '.tasks // [] | .[] | select(.status == "pending" and (.blockedBy | length == 0))')

# ... match keywords against task subjects
# If match found: exit 2 with guidance
# If no match: exit 0
```

**Open question -- TaskList access from shell hook**: The Stop hook runs as a shell command, not as an agent tool call. It does NOT have access to `TaskList()`. The hook receives a JSON object on stdin with context about the stop event, but the exact schema of this JSON needs verification.

**Two approaches**:

1. **Approach A -- Rely on stdin context**: If the Stop hook's stdin JSON includes task state (pending tasks, etc.), the hook can check directly. This requires verifying the Claude Code hook protocol for Stop events.

2. **Approach B -- Exit 2 with generic guidance**: The hook always blocks the first stop attempt with "Check TaskList for matching tasks before stopping." The worker then checks TaskList via tool call (which it can do), and if no tasks exist, it stops again. The second stop is allowed via re-entry safety (like `team-stop-gate.sh`'s `stop_hook_active` pattern).

**Recommendation**: Approach B is simpler and more reliable. The hook doesn't need TaskList access -- it just needs to force one re-check. Pattern:

```bash
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [[ "$STOP_HOOK_ACTIVE" == "true" ]]; then
  exit 0  # Worker already checked, allow stop
fi

cat >&2 <<EOF
Before stopping, check TaskList for pending tasks matching your role.
Keywords: ${KEYWORDS[*]}
If tasks exist, claim and process them.
If no tasks, you may stop.
EOF
exit 2
```

This is the same re-entry safety pattern used in `team-stop-gate.sh:21-24`.

### Part 4: Template Update (`worker.md`)

Remove the work-discovery line from `worker.md`:

**Current** (line 7):
```
Then check TaskList for more tasks matching your role. If none, notify team-lead.
```

**Proposed**:
```
Report via TaskUpdate: "{REPORT_FORMAT}"
```

(Remove the entire last line. Work discovery moves to the Stop hook.)

### Part 5: Integrator Special Handling

The integrator is unique because:
1. It has no skill invocation (PR/Merge procedures are in the agent definition body)
2. Its `{SKILL_INVOCATION}` placeholder already says "Follow the corresponding procedure in your agent definition"
3. With typed agents active, the integrator WILL load `ralph-integrator.md` as system prompt
4. The PR Creation and Merge procedures (lines 20-53) are the integrator's core knowledge

**Proposed integrator slim-down**:
- Remove Task Loop (lines 12-18) -- replaced by spawn template + Stop hook
- Keep PR Creation Procedure (lines 20-35) unchanged
- Keep Merge Procedure (lines 37-53) unchanged
- Keep Serialization note (lines 55-57) unchanged
- Add Stop hook in frontmatter
- Keep shutdown section (lines 59-62) unchanged

This brings `ralph-integrator.md` from 62 lines to ~45 lines.

## Implementation Plan

### Files to Modify

| File | Change | Lines affected |
|------|--------|---------------|
| `skills/ralph-team/SKILL.md` | Lines 190-199: Change "Agent type" column values. Line 224: Change `subagent_type` parameter. | ~10 lines |
| `agents/ralph-analyst.md` | Remove Task Loop (lines 11-25), add Stop hook to frontmatter, keep identity + shutdown | -18 / +5 |
| `agents/ralph-builder.md` | Remove Task Loop (lines 11-22), add Stop hook to frontmatter, keep "DO NOT push", revision handling, shutdown | -11 / +5 |
| `agents/ralph-validator.md` | Remove Task Loop (lines 11-19), add Stop hook to frontmatter, keep notes + shutdown | -8 / +5 |
| `agents/ralph-integrator.md` | Remove Task Loop (lines 12-18), add Stop hook to frontmatter, keep PR/Merge procedures + serialization + shutdown | -6 / +5 |
| `templates/spawn/worker.md` | Remove line 7 (work discovery instruction) | -1 |
| `hooks/scripts/worker-stop-gate.sh` | New file -- Stop hook for all workers | +30 |

### Files NOT Modified

- `hooks/scripts/team-stop-gate.sh` -- Lead hook, unchanged
- `hooks/scripts/team-teammate-idle.sh` -- GH-258 scope (peer handoff model)
- `hooks/scripts/team-task-completed.sh` -- GH-257 scope (bough advancement)
- `skills/shared/conventions.md` -- GH-258 scope (remove assignment prohibition, update handoff protocol)

### Dependency Chain

- GH-255 (consolidate templates): CLOSED -- prerequisite satisfied
- **GH-256 (this issue)**: typed agents + Stop hook
- GH-257 (bough model): blocked by this -- needs typed agents for task-creation changes
- GH-258 (peer handoff): blocked by GH-257 -- needs bough model for handoff changes

## Risks

1. **Agent tools list constraint**: When workers spawn as typed agents, the `tools` list in the agent frontmatter constrains what the worker can call. All 4 agent definitions have comprehensive tool lists, but skill execution may require tools not listed. ADR-001 in conventions.md warns: "Do NOT remove MCP tools from agent definitions." Verify skill tool requirements against agent tool lists.

2. **Stop hook stdin schema**: The exact JSON schema of the Stop hook's stdin is not documented in Claude Code's public API. The `team-stop-gate.sh` hook reads `stop_hook_active` from stdin, confirming at least that field exists. The `team-teammate-idle.sh` hook reads `teammate_name`. The worker Stop hook needs both `teammate_name` (for role mapping) and potentially `stop_hook_active` (for re-entry safety).

3. **Re-entry safety correctness**: The `stop_hook_active` pattern assumes the system sets this field to `true` on the second stop attempt. If the system doesn't set this field automatically, the worker would loop forever. The existing `team-stop-gate.sh` uses this pattern successfully, confirming the system behavior.

4. **Integrator template resolution**: The integrator's `{SKILL_INVOCATION}` resolves to multi-line text ("Check your task subject...\nFollow the corresponding procedure in your agent definition."). With typed agents active, "your agent definition" correctly references `ralph-integrator.md` which the worker now actually has as its system prompt. This is the first time the integrator's spawn template instruction actually makes sense.

## Recommendation

Implement as a single S-sized PR with the following commit structure:
1. Add `worker-stop-gate.sh` (new hook)
2. Update 4 agent definitions (add Stop hook, remove Task Loop, slim body)
3. Update `SKILL.md` spawn table and procedure (typed agent types)
4. Update `worker.md` (remove work-discovery line)

All changes are tested together because activating typed agents without the Stop hook would cause workers to stop after their first task (the work-discovery instruction in `worker.md` is removed, and the Task Loop in agent definitions is removed).
