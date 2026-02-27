---
date: 2026-02-26
status: draft
github_issues: [417, 418, 419, 420, 421, 422, 423, 424]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/417
  - https://github.com/cdubiel08/ralph-hero/issues/418
  - https://github.com/cdubiel08/ralph-hero/issues/419
  - https://github.com/cdubiel08/ralph-hero/issues/420
  - https://github.com/cdubiel08/ralph-hero/issues/421
  - https://github.com/cdubiel08/ralph-hero/issues/422
  - https://github.com/cdubiel08/ralph-hero/issues/423
  - https://github.com/cdubiel08/ralph-hero/issues/424
primary_issue: 417
---

# Enforce Skill Context for Team Workers

## Overview

Worker agents (analyst, builder, integrator) can currently bypass skills and call MCP tools or write files directly. This plan adds hard enforcement via PreToolUse hooks on agent definitions that block "substantive work" tools unless the agent is inside a skill (detected by `RALPH_COMMAND` being set). Two new skills (ralph-pr, ralph-merge) are created so the integrator's direct operations become skill-gated too.

## Current State Analysis

### The Gap

Workers are told to use skills via prompt instructions, but nothing prevents them from calling tools directly:
- The analyst has `update_workflow_state`, `create_issue`, etc. in its tools list
- The builder has `Write`, `Edit`, `Bash` for code changes
- The integrator does PR creation and merging entirely without skills

When tools are called outside a skill, no skill-level hooks fire — no state gates, no branch gates, no postconditions. Only plugin-level hooks in `hooks.json` apply.

### Why It Works Today (Mostly)

Skills use `context: fork`, so when a worker calls `Skill("ralph-hero:ralph-research", "42")`, the skill runs in a subprocess where its `SessionStart` hook sets `RALPH_COMMAND` and all skill-level hooks fire. Workers generally follow their prompt instructions. But there's no hard enforcement preventing direct tool calls.

### Key Discoveries

- Agent definitions support the same hook YAML format as skills (`agents/ralph-analyst.md:7-11` already has a `Stop` hook)
- `RALPH_COMMAND` is only set inside `context: fork` skills via `SessionStart` → `set-skill-env.sh`
- `skill-precondition.sh` already blocks `get_issue`/`list_issues` without `RALPH_COMMAND` at the plugin level
- The integrator's PR and merge flows are well-defined sequences (documented in `ralph-integrator.md:20-22`)

## Desired End State

1. All three worker agents have PreToolUse hooks that block substantive tools unless `RALPH_COMMAND` is set
2. Workers retain full tool access — tools work fine inside skills, only direct calls are blocked
3. The integrator has two new skills (ralph-pr, ralph-merge) covering its direct operations, plus ralph-val for validation — all three integrator operations are skill-gated
4. Coordination tools (TaskList, TaskGet, TaskUpdate, SendMessage, Read, Glob, Grep, Skill) remain ungated
5. All ralph-* skills have consistent frontmatter: `context: fork`, `SessionStart` hook, and `hooks.Stop` postcondition where applicable

### Verification

- Worker calls `update_workflow_state` directly → blocked with guidance to use a skill
- Worker calls `Skill("ralph-hero:ralph-research", "42")` → skill fork → `RALPH_COMMAND=research` → `update_workflow_state` → allowed
- Integrator calls `Skill("ralph-hero:ralph-pr", "42")` → skill fork → `RALPH_COMMAND=pr` → `advance_children` → allowed
- Integrator calls `advance_children` directly → blocked

## What We're NOT Doing

- Changing any existing skill prompt content or hook logic
- Modifying plugin-level hooks in `hooks.json`
- Changing the `tools:` list on any agent (tools stay, hooks gate them)
- Adding enforcement to non-team agents (codebase-locator, etc.)
- Gating Read/Glob/Grep/Bash — these remain freely usable for task assessment
- Adding `context: fork` to orchestrators (ralph-hero, ralph-team) — they spawn subagents, not forked skill processes

## Implementation Approach

One shared hook script does all the enforcement. Agent definitions add PreToolUse entries with matchers for the tools that require skill context. Two new skills give the integrator skill-gated paths for PR and merge operations.

---

## Phase 1: Create `require-skill-context.sh` hook script

### Overview

A single shared script that blocks tool calls when `RALPH_COMMAND` is not set. Used by all three worker agents.

### Changes Required

#### 1. New file: `plugin/ralph-hero/hooks/scripts/require-skill-context.sh`

```bash
#!/usr/bin/env bash
# Blocks tool calls that require skill context.
# Used as a PreToolUse hook on worker agent definitions.
#
# When a worker invokes a skill with context: fork, the skill's
# SessionStart hook sets RALPH_COMMAND via set-skill-env.sh.
# If RALPH_COMMAND is empty, the tool call is happening outside
# a skill and should be blocked.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"

read_input

command="${RALPH_COMMAND:-}"
if [[ -n "$command" ]]; then
  allow
fi

tool_name=$(get_field ".tool_name" 2>/dev/null || echo "unknown")
block "This tool requires skill context.

$tool_name cannot be called directly — invoke the appropriate skill instead.
Skills set RALPH_COMMAND via SessionStart hooks, which enables tool access.

Available skills: ralph-triage, ralph-split, ralph-research, ralph-plan,
ralph-review, ralph-impl, ralph-val, ralph-pr, ralph-merge"
```

### Success Criteria

#### Automated Verification
- [ ] `test -f plugin/ralph-hero/hooks/scripts/require-skill-context.sh`
- [ ] `test -x plugin/ralph-hero/hooks/scripts/require-skill-context.sh`
- [ ] `bash -n plugin/ralph-hero/hooks/scripts/require-skill-context.sh`

---

## Phase 2: Add PreToolUse hooks to analyst agent

### Overview

Gate all mutating MCP tools on the analyst. Read-only tools (`get_issue`, `list_issues`) are already gated by `skill-precondition.sh` at the plugin level. Read-only relationship tools (`list_sub_issues`, `list_dependencies`, `detect_group`) remain ungated since they don't mutate state.

### Changes Required

#### 1. `plugin/ralph-hero/agents/ralph-analyst.md`

Add PreToolUse hooks before the existing Stop hook. The matcher uses regex alternation to cover all mutating MCP tools in a single entry:

**Before:**
```yaml
hooks:
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/worker-stop-gate.sh"
```

**After:**
```yaml
hooks:
  PreToolUse:
    - matcher: "ralph_hero__update_workflow_state|ralph_hero__update_issue|ralph_hero__update_estimate|ralph_hero__update_priority|ralph_hero__create_issue|ralph_hero__create_comment|ralph_hero__add_sub_issue|ralph_hero__add_dependency|ralph_hero__remove_dependency"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/require-skill-context.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/worker-stop-gate.sh"
```

### Success Criteria

#### Automated Verification
- [ ] `grep -c "require-skill-context" plugin/ralph-hero/agents/ralph-analyst.md` returns 1
- [ ] `grep -c "PreToolUse" plugin/ralph-hero/agents/ralph-analyst.md` returns 1
- [ ] YAML frontmatter parses without errors

---

## Phase 3: Add PreToolUse hooks to builder agent

### Overview

Gate `Write` and `Edit` tools on the builder. The builder has no MCP tools, so only file-writing tools need gating. `Bash` is NOT gated — builders need it for `git status`, test runs, and other assessment commands outside skills.

### Changes Required

#### 1. `plugin/ralph-hero/agents/ralph-builder.md`

**Before:**
```yaml
hooks:
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/worker-stop-gate.sh"
```

**After:**
```yaml
hooks:
  PreToolUse:
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/require-skill-context.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/worker-stop-gate.sh"
```

### Success Criteria

#### Automated Verification
- [ ] `grep -c "require-skill-context" plugin/ralph-hero/agents/ralph-builder.md` returns 1
- [ ] `grep -c "PreToolUse" plugin/ralph-hero/agents/ralph-builder.md` returns 1

---

## Phase 4: Create `ralph-pr` skill for the integrator

### Overview

Extracts the integrator's PR creation flow into a skill with `context: fork`. The skill handles: fetch issue context, push branch, create PR via `gh`, move issues to "In Review" via `advance_children`, post comment.

### Changes Required

#### 1. New directory and file: `plugin/ralph-hero/skills/ralph-pr/SKILL.md`

```yaml
---
description: Create a pull request for a completed implementation — pushes branch, creates PR via gh, moves issues to In Review. Use when you want to create a PR for a completed issue.
argument-hint: <issue-number> [--worktree path]
context: fork
model: haiku
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=pr RALPH_VALID_OUTPUT_STATES='In Review,Human Needed'"
  PreToolUse:
    - matcher: "ralph_hero__update_workflow_state|ralph_hero__advance_children"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/pr-state-gate.sh"
  PostToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-verify-pr.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/pr-postcondition.sh"
allowed-tools:
  - Read
  - Glob
  - Bash
  - ralph_hero__get_issue
  - ralph_hero__list_sub_issues
  - ralph_hero__advance_children
  - ralph_hero__update_workflow_state
  - ralph_hero__create_comment
---
```

The skill prompt content should cover:

1. **Accept issue number** from arguments
2. **Fetch issue** via `get_issue` for title, group context, and current state
3. **Determine worktree and branch** — single issues use `worktrees/GH-NNN` with branch `feature/GH-NNN`, groups use the primary issue number
4. **Push branch** — `git push -u origin feature/GH-NNN` from worktree
5. **Create PR** — `gh pr create` with title from issue, body with `Closes #NNN` for each issue
6. **Move issues to In Review** — `advance_children` with `targetState: "In Review"`
7. **Report result** — output PR URL for the caller

#### 2. New file: `plugin/ralph-hero/hooks/scripts/pr-state-gate.sh`

State gate that validates output states for the PR skill. Allows only "In Review" and "Human Needed".

```bash
#!/usr/bin/env bash
# State gate for ralph-pr skill.
# Allows: In Review, Human Needed
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"
read_input

new_state=$(get_field ".tool_input.state" 2>/dev/null || get_field ".tool_input.targetState" 2>/dev/null || echo "")
if [[ -z "$new_state" ]]; then
  allow
fi

valid="${RALPH_VALID_OUTPUT_STATES:-In Review,Human Needed}"
if validate_state "$new_state" "$valid"; then
  allow_with_context "PR state transition to '$new_state' is valid."
fi

block "Invalid state transition for PR creation: '$new_state'
Valid output states: $valid"
```

#### 3. New file: `plugin/ralph-hero/hooks/scripts/pr-postcondition.sh`

Postcondition that verifies a PR was actually created.

```bash
#!/usr/bin/env bash
# Postcondition for ralph-pr: verify PR was created.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"
read_input

if [[ "${RALPH_COMMAND:-}" != "pr" ]]; then
  allow
fi

ticket_id="${RALPH_TICKET_ID:-}"
if [[ -z "$ticket_id" ]]; then
  allow
fi

# Check if a PR exists for the feature branch
pr_url=$(gh pr list --repo "${RALPH_GH_OWNER}/${RALPH_GH_REPO}" --head "feature/${ticket_id}" --json url --jq '.[0].url' 2>/dev/null || echo "")
if [[ -n "$pr_url" ]]; then
  allow
fi

warn "No PR found for feature/${ticket_id}. PR creation may have failed."
```

### Success Criteria

#### Automated Verification
- [ ] `test -f plugin/ralph-hero/skills/ralph-pr/SKILL.md`
- [ ] `grep "context: fork" plugin/ralph-hero/skills/ralph-pr/SKILL.md`
- [ ] `grep "RALPH_COMMAND=pr" plugin/ralph-hero/skills/ralph-pr/SKILL.md`
- [ ] `test -x plugin/ralph-hero/hooks/scripts/pr-state-gate.sh`
- [ ] `test -x plugin/ralph-hero/hooks/scripts/pr-postcondition.sh`

---

## Phase 5: Create `ralph-merge` skill for the integrator

### Overview

Extracts the integrator's merge flow into a skill with `context: fork`. The skill handles: verify issue state, check PR readiness, merge PR, clean up worktree, move issues to "Done", advance parent.

### Changes Required

#### 1. New directory and file: `plugin/ralph-hero/skills/ralph-merge/SKILL.md`

```yaml
---
description: Merge an approved pull request — checks PR readiness, merges, cleans up worktree, moves issues to Done. Use when you want to merge a PR for a completed issue.
argument-hint: <issue-number> [--pr-url url]
context: fork
model: haiku
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=merge RALPH_VALID_OUTPUT_STATES='Done,Human Needed'"
  PreToolUse:
    - matcher: "ralph_hero__update_workflow_state|ralph_hero__advance_children|ralph_hero__advance_parent"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/merge-state-gate.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/merge-postcondition.sh"
allowed-tools:
  - Read
  - Glob
  - Bash
  - ralph_hero__get_issue
  - ralph_hero__list_sub_issues
  - ralph_hero__advance_children
  - ralph_hero__advance_parent
  - ralph_hero__update_workflow_state
  - ralph_hero__create_comment
---
```

The skill prompt content should cover:

1. **Accept issue number** from arguments
2. **Fetch issue** via `get_issue` — verify it's in "In Review"
3. **Find PR** — `gh pr list --head feature/GH-NNN` or use provided `--pr-url`
4. **Check PR readiness** — `gh pr view --json mergeable,reviewDecision,state`. If not ready, report status and exit (the integrator will retry later)
5. **Merge PR** — `gh pr merge NNN --merge --delete-branch`
6. **Clean up worktree** — `./scripts/remove-worktree.sh GH-NNN`
7. **Move issues to Done** — `advance_children` with `targetState: "Done"`
8. **Advance parent** — `advance_parent` if applicable
9. **Post completion comment** — `create_comment` summarizing what was merged

#### 2. New file: `plugin/ralph-hero/hooks/scripts/merge-state-gate.sh`

State gate that validates output states for the merge skill. Allows "Done" and "Human Needed". Also allows `advance_parent` calls unconditionally (parent advancement state is computed server-side).

```bash
#!/usr/bin/env bash
# State gate for ralph-merge skill.
# Allows: Done, Human Needed. advance_parent calls pass through.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"
read_input

tool_name=$(get_field ".tool_name" 2>/dev/null || echo "")
# advance_parent computes target state server-side — allow unconditionally
if [[ "$tool_name" == *"advance_parent"* ]]; then
  allow
fi

new_state=$(get_field ".tool_input.state" 2>/dev/null || get_field ".tool_input.targetState" 2>/dev/null || echo "")
if [[ -z "$new_state" ]]; then
  allow
fi

valid="${RALPH_VALID_OUTPUT_STATES:-Done,Human Needed}"
if validate_state "$new_state" "$valid"; then
  allow_with_context "Merge state transition to '$new_state' is valid."
fi

block "Invalid state transition for merge: '$new_state'
Valid output states: $valid"
```

#### 3. New file: `plugin/ralph-hero/hooks/scripts/merge-postcondition.sh`

Postcondition that verifies the PR was merged.

```bash
#!/usr/bin/env bash
# Postcondition for ralph-merge: verify PR was merged.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"
read_input

if [[ "${RALPH_COMMAND:-}" != "merge" ]]; then
  allow
fi

ticket_id="${RALPH_TICKET_ID:-}"
if [[ -z "$ticket_id" ]]; then
  allow
fi

# Check if the PR for this branch is in merged state
pr_state=$(gh pr list --repo "${RALPH_GH_OWNER}/${RALPH_GH_REPO}" --head "feature/${ticket_id}" --state merged --json number --jq 'length' 2>/dev/null || echo "0")
if [[ "$pr_state" -gt 0 ]]; then
  allow
fi

warn "PR for feature/${ticket_id} does not appear to be merged. Merge may have failed or PR may not be ready."
```

### Success Criteria

#### Automated Verification
- [ ] `test -f plugin/ralph-hero/skills/ralph-merge/SKILL.md`
- [ ] `grep "context: fork" plugin/ralph-hero/skills/ralph-merge/SKILL.md`
- [ ] `grep "RALPH_COMMAND=merge" plugin/ralph-hero/skills/ralph-merge/SKILL.md`
- [ ] `test -x plugin/ralph-hero/hooks/scripts/merge-state-gate.sh`
- [ ] `test -x plugin/ralph-hero/hooks/scripts/merge-postcondition.sh`

---

## Phase 6: Add PreToolUse hooks to integrator agent and update prompt

### Overview

Gate all mutating MCP tools on the integrator. Update the integrator's prompt to invoke ralph-val, ralph-pr, and ralph-merge — all three integrator operations become skill-gated.

### Changes Required

#### 1. `plugin/ralph-hero/agents/ralph-integrator.md`

Add PreToolUse hooks:

**Before:**
```yaml
hooks:
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/worker-stop-gate.sh"
```

**After:**
```yaml
hooks:
  PreToolUse:
    - matcher: "ralph_hero__update_workflow_state|ralph_hero__update_issue|ralph_hero__advance_children|ralph_hero__advance_parent|ralph_hero__create_comment"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/require-skill-context.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/worker-stop-gate.sh"
```

#### 2. Update integrator prompt

Replace the inline PR and merge instructions with skill invocations. All three operations now go through skills:

**Before** (lines 14-22):
```
You are an integrator in the Ralph Team. You validate implementations, create pull requests, and merge them.

...

For validation, invoke ralph-val directly...
For PR creation, fetch the issue for title and group context...
For merging, verify the issue is in "In Review"...
```

**After:**
```
You are an integrator in the Ralph Team. You validate implementations, create pull requests, and merge them.

...

Invoke the appropriate skill directly — ralph-val for validation, ralph-pr for PR creation, ralph-merge for merging.

For validation, invoke ralph-val with the issue number...
For PR creation, invoke ralph-pr with the issue number...
For merging, invoke ralph-merge with the issue number...
```

### Success Criteria

#### Automated Verification
- [ ] `grep -c "require-skill-context" plugin/ralph-hero/agents/ralph-integrator.md` returns 1
- [ ] `grep -c "ralph-val" plugin/ralph-hero/agents/ralph-integrator.md` returns at least 1
- [ ] `grep -c "ralph-pr" plugin/ralph-hero/agents/ralph-integrator.md` returns at least 1
- [ ] `grep -c "ralph-merge" plugin/ralph-hero/agents/ralph-integrator.md` returns at least 1

---

## Phase 7: Frontmatter parity across all ralph-* skills

### Overview

The audit found inconsistent frontmatter across ralph-* skills. This phase brings all skills to a consistent baseline: `context: fork` where appropriate, `SessionStart` hooks everywhere, and `hooks.Stop` postconditions for skills that produce output.

### Current State (from audit)

| Gap | Skills affected |
|-----|----------------|
| Missing `context: fork` | hygiene, setup, report, status |
| Missing `hooks.Stop` postcondition | hygiene, setup, report, status |
| Missing `argument-hint` | hygiene |

**Intentionally excluded from `context: fork`**: ralph-hero and ralph-team are orchestrators that spawn subagents — they should NOT use `context: fork` because they need to maintain the parent session context for team coordination.

### Changes Required

#### 1. `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md`

Add missing `argument-hint` and `context: fork`:

```yaml
argument-hint: ""
context: fork
```

Add Stop postcondition hook. The hygiene skill should verify it produced output (identified archive candidates or reported clean board):

```yaml
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/hygiene-postcondition.sh"
```

#### 2. `plugin/ralph-hero/skills/ralph-setup/SKILL.md`

Add `context: fork`:

```yaml
context: fork
```

Add Stop postcondition hook (verify project was configured):

```yaml
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/setup-postcondition.sh"
```

#### 3. `plugin/ralph-hero/skills/ralph-report/SKILL.md`

Add `context: fork`:

```yaml
context: fork
```

Add Stop postcondition hook (verify report was posted):

```yaml
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/report-postcondition.sh"
```

#### 4. `plugin/ralph-hero/skills/ralph-status/SKILL.md`

Add `context: fork`:

```yaml
context: fork
```

Add Stop postcondition hook (verify status was displayed):

```yaml
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/status-postcondition.sh"
```

#### 5. New postcondition scripts

Create minimal postcondition scripts for each. These should be lightweight — they verify the skill did its job but don't need complex validation:

- `hooks/scripts/hygiene-postcondition.sh` — warn if no output was produced
- `hooks/scripts/setup-postcondition.sh` — warn if setup didn't complete
- `hooks/scripts/report-postcondition.sh` — warn if no report was posted
- `hooks/scripts/status-postcondition.sh` — warn if no status was displayed

Each follows the same pattern:
```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"
read_input

if [[ "${RALPH_COMMAND:-}" != "<command>" ]]; then
  allow
fi

# Lightweight check — warn only, don't block
allow
```

These are intentionally permissive (warn-only) since these are utility skills, not pipeline-critical.

### Success Criteria

#### Automated Verification
- [ ] `grep -r "context: fork" plugin/ralph-hero/skills/ralph-hygiene/SKILL.md` returns 1
- [ ] `grep -r "context: fork" plugin/ralph-hero/skills/ralph-setup/SKILL.md` returns 1
- [ ] `grep -r "context: fork" plugin/ralph-hero/skills/ralph-report/SKILL.md` returns 1
- [ ] `grep -r "context: fork" plugin/ralph-hero/skills/ralph-status/SKILL.md` returns 1
- [ ] All 4 postcondition scripts exist and are executable
- [ ] `grep -r "argument-hint" plugin/ralph-hero/skills/ralph-hygiene/SKILL.md` returns 1
- [ ] ralph-hero and ralph-team do NOT have `context: fork` (orchestrators)

---

## Testing Strategy

### Manual Testing Steps

1. **Analyst enforcement**: Spawn an analyst agent, have it attempt to call `update_workflow_state` directly (not through a skill) — should be blocked with guidance message
2. **Analyst skill path**: Have the analyst invoke `ralph-research` — the skill fork should set `RALPH_COMMAND=research` and all tools work normally
3. **Builder enforcement**: Spawn a builder, have it attempt `Write` directly — should be blocked
4. **Builder skill path**: Have the builder invoke `ralph-impl` — Write/Edit work inside the skill
5. **Integrator PR flow**: Have the integrator invoke `ralph-pr` — PR creation works through the skill with state gates
6. **Integrator merge flow**: Have the integrator invoke `ralph-merge` — merge works through the skill
7. **Full team run**: Run `ralph-team` on a test issue through the complete pipeline — verify all phases complete with skill enforcement active

### Risk Assessment

- **Low risk**: `require-skill-context.sh` — simple RALPH_COMMAND check, fails safe (blocks if unsure)
- **Low risk**: Agent PreToolUse hooks — same YAML format already proven by skill hooks and the existing Stop hooks on agents
- **Medium risk**: New skills (ralph-pr, ralph-merge) — the integrator's flow is well-defined but extracting it into skills could introduce prompt-following edge cases. The `context: fork` isolation means the skill gets its own context window, which may need tuning for the integrator's haiku model
- **Key concern**: The `gh` CLI auth. Skills run in forked subprocesses — `gh` auth should inherit from the parent environment, but this needs verification

## References

- Research: `thoughts/shared/research/2026-02-26-ralph-team-state-machine-management.md`
- v4 architecture spec: `thoughts/shared/plans/2026-02-22-ralph-workflow-v4-architecture-spec.md`
- Agent-skill invocation patterns: `thoughts/shared/research/2026-02-19-GH-0132-agent-skill-patterns-bowser-reference.md`
- Skill frontmatter fix: `thoughts/shared/plans/2026-02-26-fix-skill-frontmatter.md`
