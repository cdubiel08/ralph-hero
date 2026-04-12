---
date: 2026-04-06
status: draft
type: plan
tags: [hero, dispatch, agents, context-window, haiku]
---

# Haiku Skill-to-Agent Dispatch Fix

## Overview

Convert haiku-model integrator-phase `Skill()` calls to `Agent()` dispatches in hero and finish skills. When hero (running in Opus 1M context) invokes `Skill("ralph-hero:ralph-pr")`, the skill content loads into the current context window — then the haiku model tries to execute within a context that was built for 1M tokens, causing context crashes. The fix: dispatch these as `Agent()` calls so they run in isolated haiku-sized context windows.

## Current State Analysis

The hero orchestrator has an inconsistent dispatch pattern:

| Phase | Current Dispatch | Model | Problem? |
|-------|-----------------|-------|----------|
| Research | `Skill()` inline | sonnet | No — same context family |
| Plan | `Skill()` inline | opus | No — same context |
| Review | `Skill()` inline | opus | No — same context |
| Impl | `Agent()` ✓ | opus | No — already correct |
| PR | `Skill()` ✗ | **haiku** | **YES — context crash** |
| Val | `Agent()` ✓ | haiku | No — already correct |
| Merge | `Skill()` ✗ (inside finish) | **haiku** | **YES — context crash** |
| Finish | `Skill()` inline | sonnet | No — orchestrator, stays as Skill |

The `pr-agent` and `merge-agent` definitions already exist with correct tool allowlists and preloaded skills. They're just not being used in single-session mode.

## Desired End State

- `ralph-pr` is always dispatched as `Agent(subagent_type="ralph-hero:pr-agent")` — never `Skill()`
- `ralph-merge` is always dispatched as `Agent(subagent_type="ralph-hero:merge-agent")` — never `Skill()`
- `finish` remains a `Skill()` that orchestrates agent dispatches underneath
- The dispatch architecture docs reflect the actual pattern

### How to verify:
- `grep -n 'Skill.*ralph-pr' plugin/ralph-hero/skills/*/SKILL.md` returns zero matches
- `grep -n 'Skill.*ralph-merge' plugin/ralph-hero/skills/*/SKILL.md` returns zero matches
- `grep -n 'Agent.*pr-agent' plugin/ralph-hero/skills/hero/SKILL.md` returns the PR dispatch
- `grep -n 'Agent.*merge-agent' plugin/ralph-hero/skills/finish/SKILL.md` returns the merge dispatch

## What We're NOT Doing

- NOT converting analyst-phase Skill() calls (research, plan, review) — they benefit from inline context sharing at opus/sonnet model
- NOT converting finish to an Agent dispatch — it's an orchestrator that dispatches agents underneath
- NOT changing agent definitions — pr-agent.md and merge-agent.md are already correct

## Phase 1: Convert PR dispatch in hero

### Changes Required:

#### 1. hero/SKILL.md — PR tasks section (~line 441-444)

**File**: `plugin/ralph-hero/skills/hero/SKILL.md`

Replace:
```
#### PR tasks
```
Skill("ralph-hero:ralph-pr", args="NNN")
```
```

With:
```
#### PR tasks
```
Agent(subagent_type="ralph-hero:pr-agent", prompt="Create PR for GH-NNN. Worktree: worktrees/GH-NNN", description="PR for GH-NNN")
```
```

#### 2. hero/SKILL.md — Dispatch Architecture section (~lines 425-437)

**File**: `plugin/ralph-hero/skills/hero/SKILL.md`

Replace the dispatch architecture explanation. Current text describes "single-session mode uses Skill() for everything" vs "team mode uses agents." New text should explain the actual pattern:

- Analyst/builder phases (research, plan, review): `Skill()` inline — these are opus/sonnet and benefit from context sharing
- Implementation: `Agent()` dispatch — impl-agent runs in isolated worktree
- Integrator leaf tasks (PR, merge, val): `Agent()` dispatch — these are haiku and must run in isolated context
- Finish: `Skill()` inline — orchestrator that dispatches agents underneath

### Success Criteria:

#### Automated Verification:
- [ ] `grep -rn 'Skill.*ralph-pr' plugin/ralph-hero/skills/hero/SKILL.md` returns no matches
- [ ] `grep -rn 'Agent.*pr-agent' plugin/ralph-hero/skills/hero/SKILL.md` returns the PR dispatch line

#### Manual Verification:
- [ ] Run `/ralph-hero:hero` on a test issue through PR creation — pr-agent dispatches as isolated agent, no context crash

---

## Phase 2: Convert merge dispatch in finish

### Changes Required:

#### 1. finish/SKILL.md — Step 4 heading and dispatch (~lines 108-121)

**File**: `plugin/ralph-hero/skills/finish/SKILL.md`

Replace:
```markdown
## Step 4: Merge (dispatch ralph-merge)

Build args for ralph-merge — always pass the PR URL to avoid redundant lookup:

```
Skill("ralph-hero:ralph-merge", args="NNN --pr-url PR_URL")
```

ralph-merge handles: code review gate (including optional `code-review:code-review` dispatch), PR readiness check, merge via `merge-pr.sh`, worktree cleanup, state transition to Done, parent advancement, cross-repo unblock, and posting the Merged comment.

Check the skill output:

- If output contains `MERGE BLOCKED` or `MERGE NOT READY`: report the status and stop.
- If output contains `MERGED`: continue to Step 5.
```

With:
```markdown
## Step 4: Merge (dispatch merge-agent)

Dispatch merge as an agent — always pass the PR URL to avoid redundant lookup:

```
Agent(subagent_type="ralph-hero:merge-agent", prompt="Merge PR for GH-NNN. PR URL: PR_URL", description="Merge GH-NNN")
```

merge-agent handles: code review gate (including optional `code-review:code-review` dispatch), PR readiness check, merge via `merge-pr.sh`, worktree cleanup, state transition to Done, parent advancement, cross-repo unblock, and posting the Merged comment.

Check the agent output:

- If output contains `MERGE BLOCKED` or `MERGE NOT READY`: report the status and stop.
- If output contains `MERGED`: continue to Step 5.
```

### Success Criteria:

#### Automated Verification:
- [ ] `grep -rn 'Skill.*ralph-merge' plugin/ralph-hero/skills/finish/SKILL.md` returns no matches
- [ ] `grep -rn 'Agent.*merge-agent' plugin/ralph-hero/skills/finish/SKILL.md` returns the merge dispatch line

#### Manual Verification:
- [ ] Run `/ralph-hero:finish` on a test issue — merge-agent dispatches as isolated agent, no context crash

---

## Testing Strategy

### Smoke test:
1. Pick a test issue that's in "In Review" state
2. Run `/ralph-hero:finish NNN` — verify val-agent and merge-agent both dispatch as isolated agents
3. Check that the finish skill's context window doesn't bloat with haiku skill content

### Regression check:
- Hero pipeline end-to-end: `/ralph-hero:hero NNN` through PR creation → verify pr-agent dispatches correctly
- Finish pipeline: verify the val → merge → CI watch chain still works

## References

- Agent definitions: `plugin/ralph-hero/agents/pr-agent.md`, `plugin/ralph-hero/agents/merge-agent.md`
- Hero skill: `plugin/ralph-hero/skills/hero/SKILL.md:425-463`
- Finish skill: `plugin/ralph-hero/skills/finish/SKILL.md:108-121`
