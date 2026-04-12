---
date: 2026-04-12
status: draft
type: plan
tags: [finish, skill, fork, inline, hang]
github_issue: 758
github_issues: [758]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/758
primary_issue: 758
---

# Finish Skill Hang Fix — Implementation Plan

## Prior Work

- builds_on:: [[2026-04-05-GH-0743-finish-skill]]

## Overview

The `/ralph-hero:finish` skill hangs at "Initializing…" when invoked directly. The root cause is `context: fork` — the skill forks a new context to run, and something in that fork initialization hangs indefinitely with no error feedback. Finish is an orchestrator (dispatches val-agent, ralph-merge, impl-agent) and should use `context: inline` like the `hero` orchestrator.

## Current State Analysis

- `finish/SKILL.md:5` has `context: fork` and `model: sonnet`
- `hero/SKILL.md:4` has `context: inline` with no `model:` — the working reference pattern for orchestrators
- Hero uses SessionStart hooks with inline (`hero/SKILL.md:6-9`) — proves inline + SessionStart hooks works
- The finish skill body contains zero self-referential calls — the recursion observed in the UI (`Skill(finish)` → `Skill(ralph-hero:finish)`) comes from the fork initialization, not from skill code
- `prune-merged-worktrees.sh:23` does `git fetch origin main` with no timeout on every fork SessionStart — secondary hang risk for all fork skills
- `skill-vs-agent-dispatch.md:14-25` dispatch table is missing finish-agent

### Key Discoveries:
- `hero/SKILL.md:4-9` — inline + SessionStart + PreToolUse hooks is a proven pattern
- `skill-precondition.sh:25-36` — checks `RALPH_COMMAND` on `get_issue`; if unset and no `agent_type`, blocks. SessionStart must fire to set this.
- `merge-state-gate.sh:20` — defaults `RALPH_VALID_OUTPUT_STATES` to `'Done,Human Needed'` which matches what finish sets, so the default is safe
- `finish-agent.md` — preloads finish via `skills:` field; agents always fork regardless of skill `context`, so this is unaffected by the change
- `impl/SKILL.md:236` — interactive impl dispatches `Skill("ralph-hero:finish")` from its "Run finish" picker; will work correctly with inline

## Desired End State

`/ralph-hero:finish NNN` loads instantly and executes the validate → merge → CI watch pipeline without hanging. The skill runs inline in the caller's context.

### Verification:
- `/ralph-hero:finish NNN` on an issue in "In Review" runs the full chain without hanging
- Hero dispatching `Skill("ralph-hero:finish")` still works (inline → inline)
- `finish-agent` via `Agent(subagent_type="ralph-hero:finish-agent")` still works (agent fork is independent of skill context)

## What We're NOT Doing

- Changing finish's execution logic (steps 1-6 unchanged)
- Modifying ralph-merge, ralph-val, or impl-agent
- Investigating Claude Code's fork initialization internals (out of scope — we're removing the fork)
- Changing any other skill's context mode

## Implementation Approach

Minimal change — update frontmatter and fix the secondary hang risk. No logic changes to the skill body.

## Phase 1: Change Finish Skill to Inline

### Overview
Switch the finish skill from `context: fork` to `context: inline` and remove the `model:` override (inline skills inherit the caller's model).

### Changes Required:

#### 1. Finish Skill Frontmatter
**File**: `plugin/ralph-hero/skills/finish/SKILL.md`
**Lines**: 5-6

Replace:
```yaml
context: fork
model: sonnet
```

With:
```yaml
context: inline
```

This matches the pattern used by `hero/SKILL.md:4` (the other orchestrator skill).

#### 2. Finish Agent — Add Model Override
**File**: `plugin/ralph-hero/agents/finish-agent.md`
**Line**: 3

The agent already has `model: sonnet` — no change needed. When dispatched via `Agent(subagent_type="ralph-hero:finish-agent")`, the agent creates its own forked context with the sonnet model regardless of the skill's `context` field.

### Success Criteria:

#### Automated Verification:
- [ ] `grep -c 'context: inline' plugin/ralph-hero/skills/finish/SKILL.md` returns 1
- [ ] `grep -c 'context: fork' plugin/ralph-hero/skills/finish/SKILL.md` returns 0
- [ ] `grep -c 'model: sonnet' plugin/ralph-hero/skills/finish/SKILL.md` returns 0
- [ ] Build passes: `cd plugin/ralph-hero/mcp-server && npm run build`

#### Manual Verification:
- [ ] `/ralph-hero:finish NNN` loads without hanging at "Initializing…"
- [ ] The full pipeline (validate → merge → CI watch) executes

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Add Timeout to prune-merged-worktrees.sh

### Overview
The `git fetch origin main` call in the SessionStart hook has no timeout. If the network is unreachable, it hangs ALL fork skills until the OS TCP timeout fires (potentially minutes). Add a timeout.

### Changes Required:

#### 1. Add Timeout to git fetch
**File**: `plugin/ralph-hero/hooks/scripts/prune-merged-worktrees.sh`
**Line**: 23

Replace:
```bash
git fetch origin main --quiet 2>/dev/null || exit 0
```

With:
```bash
timeout 10 git fetch origin main --quiet 2>/dev/null || exit 0
```

10 seconds is generous for a fetch — if the remote isn't reachable by then, it won't be reachable at all. The `|| exit 0` ensures the hook exits cleanly on timeout.

### Success Criteria:

#### Automated Verification:
- [ ] `grep 'timeout 10 git fetch' plugin/ralph-hero/hooks/scripts/prune-merged-worktrees.sh` matches

#### Manual Verification:
- [ ] Fork skills (e.g., `/ralph-hero:status`) still load normally

---

## Phase 3: Update Dispatch Fragment

### Overview
Add finish-agent to the canonical dispatch table in the shared fragment.

### Changes Required:

#### 1. Dispatch Table
**File**: `plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md`
**Line**: 25 (after val-agent row)

Add row:
```
| `ralph-hero:finish-agent` | finish | sonnet |
```

### Success Criteria:

#### Automated Verification:
- [ ] `grep 'finish-agent' plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md` matches

---

## Testing Strategy

### Manual Testing:
1. Invoke `/ralph-hero:finish NNN` directly on an issue in "In Review" with a PR — verify no hang
2. Run `/ralph-hero:hero NNN` through to the INTEGRATOR phase — verify finish dispatches correctly
3. Run `/ralph-hero:status` — verify fork skills still work (prune hook timeout doesn't break anything)

### Edge Cases:
- Network offline: `prune-merged-worktrees.sh` should timeout after 10s and exit cleanly
- No worktrees directory: hook exits early (line 17-19), timeout is irrelevant

## References

- Finish skill: `plugin/ralph-hero/skills/finish/SKILL.md`
- Hero orchestrator: `plugin/ralph-hero/skills/hero/SKILL.md`
- Finish agent: `plugin/ralph-hero/agents/finish-agent.md`
- Prune hook: `plugin/ralph-hero/hooks/scripts/prune-merged-worktrees.sh`
- Dispatch fragment: `plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md`
- Original finish plan: `thoughts/shared/plans/2026-04-05-GH-0743-finish-skill.md`
