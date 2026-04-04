---
date: 2026-04-04
status: implemented-awaiting-manual-test
type: plan
tags: [hero, dispatch, skills, agents, architecture]
github_issue: 732
github_issues: [732]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/732
primary_issue: 732
---

# Hero Orchestrator: Agent() → Skill() Dispatch Migration

## Prior Work

- builds_on:: [[2026-04-04-hero-dispatch-architecture-single-vs-team]]
- supersedes:: [[2026-03-24-GH-0674-agent-per-phase-architecture]] (for single-session dispatch only)

## Overview

Migrate hero orchestrator's pipeline dispatch from `Agent(subagent_type="ralph-hero:*-agent")` to `Skill("ralph-hero:ralph-*")`. Agent()-spawned sub-agents cannot dispatch further sub-agents (empirically confirmed 2026-04-04), making all sub-agent dispatch instructions inside autonomous skills (ralph-research, ralph-plan, ralph-impl) dead code in single-session mode. Skill() runs inline and preserves Agent() access, making those sub-agent calls live.

Per-phase agent definitions are preserved for team mode — only the hero orchestrator's dispatch mechanism changes.

## Current State Analysis

**hero/SKILL.md** dispatches pipeline phases via Agent():
- Lines 250: `Agent(subagent_type="ralph-hero:split-agent", ...)`
- Lines 313: `Agent(subagent_type="ralph-hero:research-agent", ...)`
- Lines 322-337: `Agent(subagent_type="ralph-hero:plan-agent"|"plan-epic-agent", ...)`
- Lines 344: `Agent(subagent_type="ralph-hero:review-agent", ...)`
- Lines 358-362: `Agent(subagent_type="ralph-hero:impl-agent", ...)`
- PR dispatch is implicit (no explicit Agent() call in execution details)

**"Agent Dispatch Notes" section** (lines 365-376) describes Agent()-only dispatch and explicitly says "hero does NOT use Skill() for pipeline phases" — this is the statement that gets reversed.

**Execution loop** (line 241) says "Execute all unblocked tasks simultaneously (multiple Agent() calls in a single message)" — needs updating for Skill() dispatch semantics.

### Key Discoveries:
- All 10 autonomous skills already declare `model:` in frontmatter (sonnet/opus/haiku) — Skill() honors this (`hero/SKILL.md:370`)
- All autonomous skills have `context: fork` — isolated context within same top-level session, Agent() remains available
- All autonomous skills have `hooks:` frontmatter with SessionStart setting `RALPH_COMMAND` — fires automatically on Skill() load
- Skills accept args via `Skill("name", args="...")` matching their `argument-hint:` fields
- Model discrepancy: `ralph-val` declares `model: sonnet`, `val-agent` declares `model: haiku` — not relevant to this change since hero doesn't dispatch val directly

## Desired End State

Hero dispatches all pipeline phases via `Skill()` instead of `Agent()`. Sub-agent dispatch calls inside autonomous skills (codebase-locator, thoughts-locator, thoughts-analyzer, etc.) execute successfully when invoked through the hero pipeline.

### Verification:
- Run `/ralph-hero:hero` on a test issue and observe that pipeline phases execute via Skill()
- Verify skill hooks fire (RALPH_COMMAND set in env, branch gates enforced)
- Verify research skill successfully dispatches sub-agents (codebase-locator, thoughts-locator, etc.)

## Hook Compatibility Analysis

All enforcement hooks are safe under Skill() dispatch — they use dual-path design:

- **`agent-phase-gate.sh`**: Checks `RALPH_COMMAND` first (line 20); if set, skips and defers to skill's own hooks. The `agent_type` routing (lines 27-38) is a fallback for team mode only.
- **`impl-branch-gate.sh`**: Checks `RALPH_COMMAND == "impl"` first (line 18); `agent_type` is a fallback. Skill SessionStart sets `RALPH_COMMAND=impl`.
- **`skill-precondition.sh`**: Checks `RALPH_COMMAND` first (line 26); `agent_type` is a fallback for sub-agents.
- **`outcome-collector.sh`**: Uses `command` from `save_issue()` tool_input (not hook-level `agent_type`) for event type discrimination (lines 139-149). The `agentType` field from tool_input is supplementary and not in the `save_issue` schema — empty regardless of dispatch mode. Team-mode `handle_task_completed` infers agent_type from teammate_name — not relevant to single-session.

**Conclusion**: No enforcement or analytics lost. All hooks already prioritize `RALPH_COMMAND` (set by skill SessionStart) over `agent_type` (set by agent runtime).

## What We're NOT Doing

- **Modifying hello/SKILL.md** — hello runs inline (user-invocable), so its Agent() dispatch already works correctly
- **Modifying per-phase agent definitions** — preserved for team mode
- **Modifying autonomous skill content** — skills don't change, only how hero calls them
- **Modifying CLAUDE.md agent table** — still correct (documents agents for team mode)
- **Team mode rewrite** — separate future work

## Implementation Approach

Single-phase change: all edits are in `plugin/ralph-hero/skills/hero/SKILL.md`. The changes are mechanical — replace Agent() dispatch patterns with Skill() equivalents and rewrite the dispatch notes section.

## Phase 1: Migrate hero/SKILL.md Dispatch

### Overview
Replace all Agent() dispatch calls with Skill() calls and update surrounding documentation to reflect the dual dispatch model.

### Changes Required:

#### 1. Execution Loop
**File**: `plugin/ralph-hero/skills/hero/SKILL.md`
**Lines**: 239-244

Update the execution loop to use Skill() dispatch. The loop structure is largely unchanged — hero still iterates over unblocked tasks. The difference is the dispatch mechanism:

```markdown
### Step 3: Execution Loop

Loop until pipeline is complete:

1. `TaskList()` → filter to tasks with `status=pending` AND `blockedBy=[]` (empty/all resolved)
2. If no pending unblocked tasks: check for `in_progress` tasks — if all tasks are `completed`, STOP (pipeline complete)
3. For each unblocked task, execute the corresponding pipeline skill via `Skill()` (see phase-specific details below). The skill runs inline and can dispatch parallel Agent() sub-agents internally.
4. `TaskUpdate(status="completed")` for each completed task
5. Repeat from step 1
```

#### 2. SPLIT Dispatch
**Lines**: 248-251

```markdown
#### SPLIT tasks
```
Skill("ralph-hero:ralph-split", args="#NNN")
```
After all splits complete, re-call `get_issue(includePipeline=true)` and rebuild remaining task list.
```

#### 3. RESEARCH Dispatch
**Lines**: 311-314

Hero calls the research skill once per research task. The skill runs inline and handles its own parallelism — dispatching multiple Agent() sub-agents (codebase-locator, thoughts-locator, codebase-analyzer, etc.) in parallel. These sub-agent calls now execute successfully because Skill() preserves Agent() access.

```markdown
#### RESEARCH tasks
```
Skill("ralph-hero:ralph-research", args="#NNN")
```
After all research completes, run Stream Detection (Step 2.5) if applicable.
```

#### 4. PLAN Dispatch
**Lines**: 317-337

```markdown
#### PLAN tasks

Before dispatching, check the completed research task's metadata via `TaskGet` for `artifact_path`. If present, include `--research-doc {path}` in args.

Determine planning approach from issue estimate:
- **L/XL estimate** → `Skill("ralph-hero:ralph-plan-epic", args="#NNN --research-doc {path}")` — handles wave orchestration internally
- **M/S/XS estimate** → `Skill("ralph-hero:ralph-plan", args="#NNN --research-doc {path}")` or without `--research-doc` if no artifact_path

```
# For L/XL epics:
Skill("ralph-hero:ralph-plan-epic", args="#NNN --research-doc thoughts/shared/research/...")

# For M/S/XS with research doc:
Skill("ralph-hero:ralph-plan", args="#NNN --research-doc thoughts/shared/research/...")

# For M/S/XS without research doc:
Skill("ralph-hero:ralph-plan", args="#NNN")

# For multi-issue groups:
Skill("ralph-hero:ralph-plan", args="#[PRIMARY] --research-doc {path}")
```
```

#### 5. REVIEW Dispatch
**Lines**: 339-345

```markdown
#### REVIEW tasks (if RALPH_REVIEW_MODE == "auto")

Before dispatching, check the completed plan task's metadata for `artifact_path`. If present, include `--plan-doc {path}` in args:

```
Skill("ralph-hero:ralph-review", args="#NNN --plan-doc thoughts/shared/plans/...")
```
**Routing**: ALL APPROVED → continue. ANY NEEDS_ITERATION → STOP with critique links.
```

#### 6. IMPLEMENT Dispatch
**Lines**: 353-363

```markdown
#### IMPLEMENT tasks

Before dispatching, check the completed plan task's metadata for `artifact_path`. If present, include `--plan-doc {path}` in args:

```
Skill("ralph-hero:ralph-impl", args="#NNN --plan-doc thoughts/shared/plans/...")
```
If no `artifact_path` available, omit the plan doc reference:
```
Skill("ralph-hero:ralph-impl", args="#NNN")
```
```

#### 7. PR Dispatch
**Lines**: 378-379

Add explicit Skill() dispatch for PR creation:

```markdown
#### PR tasks
```
Skill("ralph-hero:ralph-pr", args="#NNN")
```
After all implementations complete, report all issue numbers with PR URLs and "In Review" status.
```

#### 8. Dispatch Notes Section — Rewrite
**Lines**: 365-376

Replace the entire "Agent Dispatch Notes" section with a dual dispatch model explanation:

```markdown
### Dispatch Architecture

Hero uses **two distinct dispatch modes** depending on session type:

**Single-session mode (default)**: Hero dispatches pipeline phases via `Skill()`. Skills run inline in hero's context window and CAN dispatch sub-agents via `Agent()`. This is the dispatch mode described above.

- `model:` in skill frontmatter is honored — opus for planning/review/impl, sonnet for research/triage, haiku for PR
- `hooks:` in skill frontmatter fire automatically — SessionStart sets `RALPH_COMMAND`, PreToolUse/PostToolUse enforce phase gates
- Skills accept args via the `args` parameter matching their `argument-hint:` field
- Sub-agent dispatch inside skills (codebase-locator, thoughts-locator, etc.) executes successfully
- Skill output is visible in hero's context — artifact paths (research docs, plan docs) can be observed directly or via TaskUpdate metadata

**Team mode**: Team spawns per-phase agents as teammates via Claude Code Agent Teams. Each agent is a full session with its own context window and CAN dispatch sub-agents. Per-phase agent definitions in `plugin/ralph-hero/agents/` serve this mode.

If any implementation fails, STOP immediately. Do NOT continue to next issue.
```

#### 9. Cross-Repo Decompose Dispatch
**Lines**: 260-288

The cross-repo tree expansion section dispatches `SubagentType: general-purpose` agents — these are NOT per-phase agents and should remain as Agent() calls. No changes needed here.

### Success Criteria:

#### Automated Verification:
- [x] No remaining `Agent(subagent_type="ralph-hero:*-agent"` patterns in `hero/SKILL.md` (excluding cross-repo general-purpose agents)
- [x] All 6 pipeline phases (SPLIT, RESEARCH, PLAN, REVIEW, IMPLEMENT, PR) use `Skill()` dispatch
- [x] "Agent Dispatch Notes" section replaced with dual dispatch model documentation
- [x] File passes markdown lint (no broken code blocks, consistent formatting)

#### Manual Verification:
- [ ] Run `/ralph-hero:hero` on a test issue in "Research Needed" state
- [ ] Observe Skill() dispatch executing ralph-research with correct model (sonnet)
- [ ] Verify research skill's sub-agent dispatch (codebase-locator, thoughts-locator) succeeds
- [ ] Verify skill hooks fire (RALPH_COMMAND=research visible in hook output)
- [ ] Verify branch gate enforcement (main branch required for research)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Automated:
- Grep `hero/SKILL.md` for residual `Agent(subagent_type="ralph-hero:` patterns — should find zero matches (cross-repo uses `SubagentType: general-purpose` which is fine)

### Manual Testing Steps:
1. Invoke `/ralph-hero:hero <issue-number>` on an issue in "Research Needed" state
2. Verify hero calls `Skill("ralph-hero:ralph-research")` instead of `Agent(subagent_type="ralph-hero:research-agent")`
3. Verify the research skill dispatches sub-agents (codebase-locator, thoughts-locator) — these should succeed where they previously silently failed
4. Check hook output for `RALPH_COMMAND=research` being set
5. If the issue reaches PLAN phase, verify `Skill("ralph-hero:ralph-plan")` dispatches with correct model (opus)

## References

- Original issue: #732
- Dispatch architecture research: `thoughts/shared/research/2026-04-04-hero-dispatch-architecture-single-vs-team.md`
- GH-674 agent-per-phase plan (superseded for single-session): `thoughts/shared/plans/2026-03-24-GH-0674-agent-per-phase-architecture.md`
- Hero skill: `plugin/ralph-hero/skills/hero/SKILL.md`
