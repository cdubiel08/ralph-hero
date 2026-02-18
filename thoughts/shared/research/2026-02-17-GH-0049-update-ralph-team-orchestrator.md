---
date: 2026-02-17
github_issue: 49
github_url: https://github.com/cdubiel08/ralph-hero/issues/49
status: complete
type: research
---

# Update ralph-team Orchestrator for 4-Worker Architecture - Research Findings

## Problem Statement

Issue #49 requires refactoring the `ralph-team` skill (SKILL.md) and spawn templates to use 4 new worker types (Analyst, Builder, Validator, Integrator) instead of the current 5 agent types (triager, researcher, planner, advocate, implementer). This also includes updating `shared/conventions.md` with the new pipeline handoff protocol and spawn template references.

## Current State Analysis

### ralph-team SKILL.md Structure

The team orchestrator at [plugin/ralph-hero/skills/ralph-team/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md) has 8 sections:

| Section | Content | Needs Update? |
|---------|---------|---------------|
| 1. Identity & Prime Directive | Lead role, direct work list | Minor (PR creation moves to Integrator) |
| 2. Entry Modes | Issue selection, group detection | No change |
| 3. State Detection | Pipeline position, group tracking, fast-track | No change (uses MCP tools) |
| 4. Team Lifecycle & Dispatch | Task creation, spawning, dispatch loop, PR creation, shutdown | **Major** (spawn mapping, PR ownership, intake states) |
| 5. Behavioral Principles | Delegation, autonomy, hooks | Minor (role references) |
| 6. Teammate Spawning | Spawn table, templates, naming | **Major** (core change) |
| 7. Lifecycle Hooks | TaskCompleted, TeammateIdle, Stop | Minor (role references in hook scripts) |
| 8. State Machine Enforcement | Source of truth | No change |

### Section 4.2 - Task Creation Patterns (Current)

Current task subject patterns that workers match on:
- `"Research #NNN"` -> researcher
- `"Plan #NNN"` -> planner
- `"Review plan for #NNN"` -> advocate
- `"Implement #NNN"` -> implementer
- `"Create PR for #NNN"` -> lead (direct work)

### Section 4.3 - Spawn Rules (Current)

- Check TaskList for pending, unblocked tasks
- Spawn one worker per role with available work
- Research: up to 3 parallel (`researcher`, `researcher-2`, `researcher-3`)

### Section 4.5 - Lead Creates PR (Current)

The team lead currently:
1. Pushes branch from worktree
2. Creates PR via `gh pr create`
3. Moves all issues to "In Review" via `advance_children`
4. Returns to dispatch loop

### Section 6 - Spawn Table (Current)

| Task subject contains | Role | Template | Agent type |
|----------------------|------|----------|------------|
| "Triage" | triager | `triager.md` | ralph-triager |
| "Split" | splitter | `splitter.md` | ralph-triager |
| "Research" | researcher | `researcher.md` | ralph-researcher |
| "Plan" (not "Review") | planner | `planner.md` | ralph-planner |
| "Review" | reviewer | `reviewer.md` | ralph-advocate |
| "Implement" | implementer | `implementer.md` | ralph-implementer |

### Section 6 - Instance Limits (Current)

- Research: up to 3 parallel (`researcher`, `researcher-2`, `researcher-3`)
- Implementation: up to 2 if plan has non-overlapping file ownership
- All other roles: single worker

### Current Spawn Templates (6 files)

| Template | File | Placeholders | Lines |
|----------|------|-------------|-------|
| `triager.md` | [templates/spawn/triager.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/triager.md) | `{ISSUE_NUMBER}`, `{TITLE}`, `{ESTIMATE}` | 4 |
| `splitter.md` | [templates/spawn/splitter.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/splitter.md) | `{ISSUE_NUMBER}`, `{TITLE}`, `{ESTIMATE}` | 4 |
| `researcher.md` | [templates/spawn/researcher.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/researcher.md) | `{ISSUE_NUMBER}`, `{TITLE}` | 4 |
| `planner.md` | [templates/spawn/planner.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/planner.md) | `{ISSUE_NUMBER}`, `{TITLE}`, `{GROUP_CONTEXT}` | 5 |
| `reviewer.md` | [templates/spawn/reviewer.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/reviewer.md) | `{ISSUE_NUMBER}`, `{TITLE}`, `{GROUP_CONTEXT}` | 5 |
| `implementer.md` | [templates/spawn/implementer.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/implementer.md) | `{ISSUE_NUMBER}`, `{TITLE}`, `{WORKTREE_CONTEXT}` | 6 |

### shared/conventions.md - Pipeline Handoff Protocol (Current)

| Current Role (agentType) | Next Stage | agentType to find |
|---|---|---|
| `ralph-researcher` | Planner | `ralph-planner` |
| `ralph-planner` | Reviewer | `ralph-advocate` |
| `ralph-advocate` | Implementer | `ralph-implementer` |
| `ralph-implementer` | Lead (PR creation) | `team-lead` |

### shared/conventions.md - Spawn Template Protocol (Current)

Available templates: `researcher`, `planner`, `reviewer`, `implementer`, `triager`, `splitter`

Template naming convention table maps agent types to templates:

| Agent type | Template |
|------------|----------|
| `ralph-triager` agent (triage mode) | `triager.md` |
| `ralph-triager` agent (split mode) | `splitter.md` |
| `ralph-researcher` agent | `researcher.md` |
| `ralph-planner` agent | `planner.md` |
| `ralph-advocate` agent | `reviewer.md` |
| `ralph-implementer` agent | `implementer.md` |

### Lifecycle Hook Scripts

Three hook scripts reference agent roles in their output text:

1. [team-task-completed.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/team-task-completed.sh) - References "review" task detection and "implementer" in guidance text
2. [team-teammate-idle.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/team-teammate-idle.sh) - Generic (uses `$TEAMMATE` variable, no hardcoded roles)
3. [team-stop-gate.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/team-stop-gate.sh) - Checks GitHub states, no role references

### Dispatch Loop Intake States (Section 4.4)

Current intake mapping for idle workers:
- Researcher -> `"Research Needed"`
- Planner -> `"Ready for Plan"`
- Reviewer -> `"Plan in Review"`
- Implementer -> `"In Progress"`
- Triager -> `"Backlog"`

## Key Discoveries

### 1. Task Subjects Drive Worker Matching -- No Code Change to Workers Needed

The team lead creates tasks with specific subject keywords. Workers match on these keywords to self-claim. This pattern stays identical in the new architecture:

**New task subjects** (same keywords, workers just have wider matching):
- `"Triage #NNN"` -> Analyst claims (matches "Triage")
- `"Split #NNN"` -> Analyst claims (matches "Split")
- `"Research #NNN"` -> Analyst claims (matches "Research")
- `"Plan #NNN"` -> Builder claims (matches "Plan")
- `"Review plan for #NNN"` -> Validator claims (matches "Review") OR Builder (if `RALPH_REVIEW_MODE != interactive`)
- `"Implement #NNN"` -> Builder claims (matches "Implement")
- `"Merge PR for #NNN"` -> Integrator claims (matches "Merge")
- `"Create PR for #NNN"` -> Lead (still direct work) OR Integrator (future)

The task subjects themselves do NOT need to change. Only the spawn table mapping changes (which agent type gets spawned for which subject).

### 2. Spawn Table Simplification -- 6 Rows to 4 Agent Types

Current: 6 rows mapping to 3 agent types (triager handles triage+split, others 1:1).
New: same 6+ task subject patterns, but only 4 agent types:

| Task subject contains | Role name | Template | Agent type (NEW) |
|----------------------|-----------|----------|-----------------|
| "Triage" | analyst | `triager.md` (reuse) | ralph-analyst |
| "Split" | analyst | `splitter.md` (reuse) | ralph-analyst |
| "Research" | analyst | `researcher.md` (reuse) | ralph-analyst |
| "Plan" (not "Review") | builder | `planner.md` (reuse) | ralph-builder |
| "Review" | validator | `reviewer.md` (reuse) | ralph-validator |
| "Implement" | builder | `implementer.md` (reuse) | ralph-builder |
| "Merge" or "Integrate" | integrator | `integrator.md` (NEW) | ralph-integrator |

**Key insight**: Existing spawn templates can be REUSED as-is. The templates contain skill invocations (`Skill(skill="ralph-hero:ralph-triage", ...)`) which are agent-type-agnostic. The agent definition (not the template) determines what tools and model the agent uses.

### 3. New Spawn Templates: Only `integrator.md` is Truly New

Existing templates work unchanged because they invoke skills directly:
- `triager.md` invokes `ralph-hero:ralph-triage` -- works with Analyst
- `splitter.md` invokes `ralph-hero:ralph-split` -- works with Analyst
- `researcher.md` invokes `ralph-hero:ralph-research` -- works with Analyst
- `planner.md` invokes `ralph-hero:ralph-plan` -- works with Builder
- `reviewer.md` invokes `ralph-hero:ralph-review` -- works with Validator
- `implementer.md` invokes `ralph-hero:ralph-impl` -- works with Builder

Only `integrator.md` is genuinely new because the Integrator has no existing skill and operates via direct git/gh CLI commands.

The issue scope calls for creating 4 new templates (`analyst.md`, `builder.md`, `validator.md`, `integrator.md`). Two approaches:

**Approach A: Create 4 new worker templates, keep 6 old ones**
- Analyst template combines triage/split/research guidance
- Builder template combines plan/impl guidance
- Validator template wraps review guidance
- Integrator template is new
- Old templates remain for backward compatibility

**Approach B: Reuse existing 6 templates, add only `integrator.md`**
- No new analyst/builder/validator templates needed
- The spawn table maps task subjects to existing templates + agent types
- Only truly new template is `integrator.md`
- Simpler, fewer files, less duplication

**Recommendation: Approach B** (reuse existing templates). The issue's acceptance criteria says "4 new spawn templates created" but analysis shows only 1 is truly needed. The existing templates work because they invoke skills, not agent-specific logic. Creating redundant wrapper templates would duplicate content and increase maintenance burden. The implementation plan should note this deviation from the original acceptance criteria with rationale.

### 4. PR Creation Ownership Shift

Per Integrator research (#48, Option B): PR creation stays in `ralph-impl` for now. The Integrator handles merge only.

This means Section 4.5 ("Lead Creates PR") has two options:

**Option A: Keep Section 4.5 as-is** -- Lead still creates PRs after implementation.
- Pro: Minimal change to orchestrator
- Con: Inconsistent with the "lead doesn't do substantive work" principle

**Option B: Remove Section 4.5** -- PR creation stays in `ralph-impl` (the skill already does this).
- Pro: Lead has zero direct work
- Con: Need to verify `ralph-impl` handles all PR creation scenarios (single issue and groups)

**Option C: Move PR creation to Integrator** -- New "Create PR" task type.
- Pro: All git-to-remote ops in one worker
- Con: Requires modifying `ralph-impl` skill (out of scope for #49)

**Recommendation: Option A for now**, with a note that Option B/C can be pursued in a follow-up. The PR creation logic in Section 4.5 is well-tested and changing it introduces risk. The Integrator adds merge capability without disrupting existing PR creation flow.

However, the Integrator DOES need a new "Merge PR" task that follows the "Create PR" task in the pipeline. The task chain becomes:
```
... -> Implement #NNN -> Create PR for #NNN (lead) -> Merge PR for #NNN (integrator)
```

### 5. Pipeline Handoff Protocol Update

Current 4-row handoff table becomes:

| Current Worker (agentType) | Next Stage | agentType to find |
|---|---|---|
| `ralph-analyst` | Builder | `ralph-builder` |
| `ralph-builder` (plan complete) | Validator | `ralph-validator` (if `RALPH_REVIEW_MODE=interactive`) |
| `ralph-builder` (impl complete) | Lead (PR creation) | `team-lead` |
| `ralph-validator` (approved) | Builder (impl) | `ralph-builder` |
| `ralph-validator` (rejected) | Builder (re-plan) | `ralph-builder` |
| `ralph-integrator` | None (terminal) | -- |

Note: The Analyst -> Builder handoff replaces Researcher -> Planner. The Builder -> Validator handoff is conditional (only in interactive review mode). The Builder -> Lead handoff for PR creation stays.

### 6. Instance Limits Update

Per worker research documents:

| Worker | Max Parallel | Reason | Naming |
|--------|-------------|--------|--------|
| Analyst | 3 | Read-only + docs, parallel per issue | `analyst`, `analyst-2`, `analyst-3` |
| Builder | 3 | Worktree isolation per issue | `builder`, `builder-2`, `builder-3` |
| Validator | 1 | Review is sequential per issue | `validator` |
| Integrator | 1 | Serialized on main branch | `integrator` |

### 7. Dispatch Loop Intake States Update

New intake mapping for idle workers using `pick_actionable_issue`:

| Worker | Intake State | Purpose |
|--------|-------------|---------|
| Analyst | `"Backlog"`, `"Research Needed"` | Both are Analyst scope |
| Builder | `"Ready for Plan"`, `"In Progress"` | Both are Builder scope |
| Validator | `"Plan in Review"` | Only in interactive mode |
| Integrator | `"In Review"` | Check for mergeable PRs |

Current intake checks Researcher->"Research Needed", Planner->"Ready for Plan", etc. The new mapping is:
- Analyst covers TWO states (Backlog + Research Needed) instead of two separate agents covering one each
- Builder covers TWO states (Ready for Plan + In Progress) instead of two separate agents
- Integrator is new (checks In Review for merge-ready PRs)

### 8. Task Chain Changes for Groups

Current group task chain:
```
Research #42 (blocked by nothing)
Research #43 (blocked by nothing)
Research #44 (blocked by nothing)
Plan #42 (blocked by all Research tasks)  -- GROUP plan
Review plan for #42 (blocked by Plan)
Implement #42 (blocked by Review)
Create PR for #42 (blocked by Implement)  -- Lead's work
```

New group task chain:
```
Triage #42 (if Backlog)                    -- Analyst
Research #42 (blocked by Triage if any)    -- Analyst
Research #43                               -- Analyst
Research #44                               -- Analyst
Plan #42 (blocked by all Research tasks)   -- Builder (GROUP plan)
Review plan for #42 (blocked by Plan)      -- Validator (optional per mode)
Implement #42 (blocked by Review/Plan)     -- Builder
Create PR for #42 (blocked by Implement)   -- Lead
Merge PR for #42 (blocked by Create PR)    -- Integrator (NEW)
```

The "Merge PR" task is new. It's blocked by "Create PR" and is claimed by the Integrator.

### 9. Hook Script Updates Needed

Only [team-task-completed.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/team-task-completed.sh) references specific roles:
- Line 21: `grep -qi "review"` -- still works (task subject unchanged)
- Line 23: mentions "implementer" in guidance text -- should say "builder" or be generic
- Line 25: mentions "planner" in guidance text -- should say "builder"

The other two hooks are role-agnostic and need no changes.

### 10. Review Task Handling Under RALPH_REVIEW_MODE

The dispatch loop's review handling (Section 4.4, item 1) currently:
- When review task completes with NEEDS_ITERATION, creates a revision task with "Plan" in subject

This stays the same. The Validator (replacing advocate) returns NEEDS_ITERATION, and the lead creates a "Plan" task that the Builder claims.

However, there's a new consideration: when `RALPH_REVIEW_MODE=skip`, the lead should NOT create a "Review" task at all. The Builder auto-progresses from Plan in Review to In Progress. When `RALPH_REVIEW_MODE=auto`, the Builder handles self-review (no separate Validator task). Only when `RALPH_REVIEW_MODE=interactive` does the lead create a "Review" task for the Validator.

This means the task creation logic in Section 4.2 needs a conditional:
```
if RALPH_REVIEW_MODE == "interactive":
    create "Review plan for #NNN" task (Validator claims)
elif RALPH_REVIEW_MODE == "auto":
    # No separate review task -- Builder's plan task handles self-review via skill
elif RALPH_REVIEW_MODE == "skip":
    # No review task -- Builder auto-progresses
```

### 11. Files to Modify

| File | Changes | Scope |
|------|---------|-------|
| `skills/ralph-team/SKILL.md` | Sections 1, 4.2, 4.3, 4.4, 4.5, 5, 6 | Major |
| `skills/shared/conventions.md` | Pipeline Handoff Protocol, Spawn Template Protocol, Naming Convention | Major |
| `templates/spawn/integrator.md` | Create new | New file |
| `hooks/scripts/team-task-completed.sh` | Update role references in guidance text | Minor |

### 12. Files NOT to Modify

| File | Reason |
|------|--------|
| `templates/spawn/triager.md` | Reused as-is by Analyst |
| `templates/spawn/splitter.md` | Reused as-is by Analyst |
| `templates/spawn/researcher.md` | Reused as-is by Analyst |
| `templates/spawn/planner.md` | Reused as-is by Builder |
| `templates/spawn/reviewer.md` | Reused as-is by Validator |
| `templates/spawn/implementer.md` | Reused as-is by Builder |
| `hooks/scripts/team-teammate-idle.sh` | Already role-agnostic |
| `hooks/scripts/team-stop-gate.sh` | Checks GitHub states, no role refs |
| `mcp-server/src/lib/pipeline-detection.ts` | Already returns generic phases |

## Potential Approaches

### Approach A: Full Rewrite of ralph-team SKILL.md (Not Recommended)

Rewrite the entire SKILL.md from scratch for the 4-worker model.

**Pros**: Clean slate, no legacy references
**Cons**: High risk of regression. The SKILL.md is 239 lines of carefully tuned orchestration logic. Rewriting it introduces subtle bugs in dispatch timing, group handling, and hook interactions.

### Approach B: Targeted Section Updates (Recommended)

Update only the sections that reference specific agent types:

1. **Section 1**: Update "Your ONLY direct work" list -- note Integrator handles merge post-PR
2. **Section 4.2**: Add conditional review task creation based on `RALPH_REVIEW_MODE`; add "Merge PR" task type blocked by "Create PR"
3. **Section 4.3**: Reference Section 6 (already does, just verify)
4. **Section 4.4**: Update intake state mapping for 4 workers; add Integrator intake for "In Review"
5. **Section 4.5**: Keep PR creation logic; add "create Merge task after PR" step
6. **Section 5**: Update role references
7. **Section 6**: Replace spawn table with 4-worker mapping; update instance limits; update naming convention

**Pros**: Minimal risk. Changes are scoped to role mapping, not orchestration logic.
**Cons**: Some legacy phrasing may survive in unchanged sections.

### Approach C: Hybrid (Recommended with Caveats)

Use Approach B for the SKILL.md, but create a fresh `integrator.md` spawn template and update `conventions.md` from scratch for the pipeline section.

## Implementation Guidance

### New Spawn Table (Section 6)

```markdown
| Task subject contains | Role | Template | Agent type |
|----------------------|------|----------|------------|
| "Triage" | analyst | `triager.md` | ralph-analyst |
| "Split" | analyst | `splitter.md` | ralph-analyst |
| "Research" | analyst | `researcher.md` | ralph-analyst |
| "Plan" (not "Review") | builder | `planner.md` | ralph-builder |
| "Review" | validator | `reviewer.md` | ralph-validator |
| "Implement" | builder | `implementer.md` | ralph-builder |
| "Merge" or "Integrate" | integrator | `integrator.md` | ralph-integrator |
```

### New Instance Limits (Section 6)

```markdown
- **Analyst**: Up to 3 parallel (`analyst`, `analyst-2`, `analyst-3`)
- **Builder**: Up to 3 parallel if non-overlapping file ownership (`builder`, `builder-2`, `builder-3`)
- **Validator**: Single worker (`validator`)
- **Integrator**: Single worker, serialized on main (`integrator`)
```

### New integrator.md Template

```markdown
Integrate #{ISSUE_NUMBER}: {TITLE}.

Check PR status and merge if ready per your agent definition.
Report results. Then check TaskList for more integration tasks.
```

### New Pipeline Handoff Table (conventions.md)

```markdown
| Current Role (agentType) | Next Stage | agentType to find |
|---|---|---|
| `ralph-analyst` | Builder | `ralph-builder` |
| `ralph-builder` (plan done) | Validator | `ralph-validator` (interactive mode only) |
| `ralph-builder` (impl done) | Lead (PR creation) | `team-lead` |
| `ralph-validator` (approved) | Builder | `ralph-builder` |
| `ralph-validator` (rejected) | Builder (re-plan) | `ralph-builder` |
```

### New Spawn Template Protocol (conventions.md)

Available templates: `triager`, `splitter`, `researcher`, `planner`, `reviewer`, `implementer`, `integrator`

```markdown
| Agent type | Template(s) |
|------------|-------------|
| `ralph-analyst` (triage mode) | `triager.md` |
| `ralph-analyst` (split mode) | `splitter.md` |
| `ralph-analyst` (research mode) | `researcher.md` |
| `ralph-builder` (plan mode) | `planner.md` |
| `ralph-builder` (implement mode) | `implementer.md` |
| `ralph-validator` | `reviewer.md` |
| `ralph-integrator` | `integrator.md` |
```

### Task Creation Conditional for Review (Section 4.2)

```
# After creating Plan task:
if RALPH_REVIEW_MODE == "interactive":
    create "Review plan for #NNN" task, blocked by Plan task
    create "Implement #NNN" task, blocked by Review task
else:
    # skip or auto mode: Builder handles review internally
    create "Implement #NNN" task, blocked by Plan task
```

### Intake State Mapping (Section 4.4)

```
# When idle workers need new work from GitHub:
for each idle analyst:
    pick_actionable_issue(workflowState="Backlog")
    pick_actionable_issue(workflowState="Research Needed")
for each idle builder:
    pick_actionable_issue(workflowState="Ready for Plan")
    pick_actionable_issue(workflowState="In Progress")  # resume
for idle validator (if interactive mode):
    pick_actionable_issue(workflowState="Plan in Review")
for idle integrator:
    pick_actionable_issue(workflowState="In Review")
```

## Risks and Considerations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Regression in dispatch loop timing | Medium | Targeted section updates (Approach B), not full rewrite. Test with real issues after change. |
| Builder claims both Plan and Implement tasks simultaneously | Low | Task blocking prevents this -- Implement is blocked by Plan/Review. Builder processes one at a time. |
| Validator spawned unnecessarily in skip/auto mode | Low | Conditional task creation based on `RALPH_REVIEW_MODE`. No Review task = no Validator spawn. |
| Integrator idle with no merge-ready PRs | Low | Normal -- Integrator goes idle, wakes when TeammateIdle hook fires and lead creates Merge tasks. |
| Backward compatibility during migration | Medium | Old agent files remain until #51 cleanup. Both old and new agents can coexist if needed. |
| Spawn template reuse confusion | Low | Document clearly in conventions.md that templates are task-specific (not worker-specific). |

## Recommended Next Steps

1. Create `integrator.md` spawn template
2. Update Section 6 spawn table in ralph-team SKILL.md
3. Update Section 4.2 task creation with conditional review and Merge task
4. Update Section 4.4 intake mapping
5. Update Section 4.5 to add Merge task after PR creation
6. Update Section 1 and 5 role references
7. Update conventions.md pipeline handoff and spawn template protocol tables
8. Update team-task-completed.sh guidance text
9. Test with a real issue through the full pipeline
