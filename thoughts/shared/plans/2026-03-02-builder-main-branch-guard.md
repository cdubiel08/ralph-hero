---
type: plan
date: 2026-03-02
status: draft
github_issues: []
github_urls: []
primary_issue: null
---

# Builder Main Branch Guard - Implementation Plan

## Overview

Add a builder-level Bash hook that blocks `git commit`, `git push`, and `git add` on the main branch. This closes the gap where the builder agent could commit directly to main without going through a worktree/feature branch, bypassing the integrator's PR workflow.

## Current State Analysis

The builder agent (`plugin/ralph-hero/agents/ralph-builder.md:7-12`) has one hook:
- **PreToolUse Write|Edit**: `require-skill-context.sh` — blocks file writes without an active skill (forces ralph-impl usage)

The ralph-impl skill (`plugin/ralph-hero/skills/ralph-impl/SKILL.md:23-27`) has Bash hooks:
- **PreToolUse Bash**: `impl-staging-gate.sh` — blocks blanket `git add`
- **PreToolUse Bash**: `impl-branch-gate.sh` — blocks git ops on main

**The gap**: `impl-branch-gate.sh:18-20` has an early exit `if RALPH_COMMAND != "impl" → allow`. This means the guard only fires inside the ralph-impl skill. If the builder commits to main outside skill context (or if the skill fails to set up a worktree), nothing stops it.

**Observed failure**: In the GH-493 team session, the builder committed `1237c35` directly to main instead of using a worktree + feature branch. The integrator had no PR to create.

## Desired End State

### Verification
- [ ] Builder agent cannot `git commit` on main branch (blocked by hook with exit code 2)
- [ ] Builder agent cannot `git push` on main branch (blocked by hook)
- [ ] Builder agent cannot `git add` on main branch (blocked by hook)
- [ ] Builder agent CAN run non-git Bash commands on main (npm test, npm build, etc.)
- [ ] Builder agent CAN run git commit/push/add on feature branches
- [ ] Builder agent CAN run `git checkout`/`git switch` on any branch
- [ ] Existing impl-level hooks continue to work unchanged
- [ ] Analyst and integrator agents are unaffected

## What We're NOT Doing

- Not modifying `impl-branch-gate.sh` — it remains as a second layer of defense within the skill
- Not adding Bash file-write guards (sed, echo >, tee) — the Write|Edit skill-context guard is sufficient
- Not adding guards to the integrator agent — it legitimately pushes to main for PR merges
- Not adding guards to the analyst agent — it works on main for research/planning artifacts

## Implementation Approach

Create a new hook script that mirrors `impl-branch-gate.sh` but without the `RALPH_COMMAND` guard, making it always-active for the builder agent. Register it in the builder agent's frontmatter.

---

## Phase 1: Add Builder Main Branch Guard

### Changes Required

#### 1. Create `builder-branch-guard.sh`
**File**: `plugin/ralph-hero/hooks/scripts/builder-branch-guard.sh` (new)

```bash
#!/bin/bash
# ralph-hero/hooks/scripts/builder-branch-guard.sh
# PreToolUse (Bash): Block git commit/push/add on main for builder agents
#
# Agent-level guard — always active, no RALPH_COMMAND check.
# Defense-in-depth: impl-branch-gate.sh provides skill-level protection;
# this script provides agent-level protection.
#
# Exit codes:
#   0 - Allowed (on feature branch or non-git command)
#   2 - Blocked (on main during git operation)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

command=$(get_field '.tool_input.command')
if [[ -z "$command" ]]; then
  allow
fi

# Only check git commit/push/add operations
if [[ "$command" != *"git commit"* ]] && [[ "$command" != *"git push"* ]] && [[ "$command" != *"git add"* ]]; then
  allow
fi

# Allow git checkout/switch (agent may be switching to a worktree)
if [[ "$command" =~ ^[[:space:]]*git[[:space:]]+(checkout|switch) ]]; then
  allow
fi

# Check current branch
current_branch=$(git branch --show-current 2>/dev/null || echo "unknown")

if [[ "$current_branch" == "main" ]] || [[ "$current_branch" == "master" ]]; then
  block "Builder cannot commit to main branch.

Current branch: $current_branch
Command: $command

Builders must work on feature branches in worktrees.
Use /ralph-hero:ralph-impl to set up a worktree automatically.

This guard is agent-level — it applies regardless of which skill is active."
fi

allow
```

#### 2. Register hook on builder agent
**File**: `plugin/ralph-hero/agents/ralph-builder.md:7-12`

Add a Bash PreToolUse hook alongside the existing Write|Edit hook:

```yaml
hooks:
  PreToolUse:
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/require-skill-context.sh"
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/builder-branch-guard.sh"
```

### Success Criteria

#### Automated Verification
- [ ] `builder-branch-guard.sh` exists and is executable
- [ ] `ralph-builder.md` frontmatter contains Bash PreToolUse hook entry
- [ ] Existing tests pass: `cd plugin/ralph-hero/mcp-server && npm test`

#### Manual Verification
- [ ] Spawn a builder agent on main, attempt `git commit` — should be blocked
- [ ] Spawn a builder agent on a feature branch, attempt `git commit` — should succeed
- [ ] Builder can still run `npm test`, `npm run build` on main — not blocked

---

## References

- Builder agent: `plugin/ralph-hero/agents/ralph-builder.md`
- Existing skill-level guard: `plugin/ralph-hero/hooks/scripts/impl-branch-gate.sh`
- Skill context guard: `plugin/ralph-hero/hooks/scripts/require-skill-context.sh`
- Hook utilities: `plugin/ralph-hero/hooks/scripts/hook-utils.sh`
- Observed failure: GH-493 team session — builder committed `1237c35` directly to main
