---
date: 2026-02-17
github_issue: 47
github_url: https://github.com/cdubiel08/ralph-hero/issues/47
status: complete
type: research
---

# Validator Worker Agent Definition - Research Findings

## Problem Statement

Issue #47 requires creating a Validator worker agent (`ralph-validator.md`) that replaces the current `ralph-advocate` agent. The Validator is an **optional** worker that observes Plan in Review (interactive mode only) and In Review (future quality gates). Per the #44 scope boundaries research, the Validator does NOT own any state exclusively -- it observes states owned by other workers and only activates under specific conditions.

## Current State Analysis

### Existing Advocate Agent (`ralph-advocate.md`)

The current advocate agent at `plugin/ralph-hero/agents/ralph-advocate.md` has:

**Frontmatter**:
- `name: ralph-advocate`
- `model: opus`
- `color: blue`
- `tools`: Read, Write, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, plus MCP tools (get_issue, list_issues, update_issue, update_workflow_state, create_comment)

**Behavior**:
- Task loop: finds tasks with "Review" in subject, claims, executes `ralph-hero:ralph-review` skill, reports verdict
- Critical requirement: full verdict MUST be in task description (lead cannot see skill output)
- After completion, hands off to `ralph-implementer` via pipeline convention

**Key limitation**: The advocate is mandatory in the current pipeline -- every plan goes through Plan in Review -> advocate review -> In Progress. This is a bottleneck.

### Ralph-Review Skill (`skills/ralph-review/SKILL.md`)

The review skill already supports two modes:
- **INTERACTIVE**: Human reviews via wizard (AskUserQuestion), immediate approval/rejection
- **AUTO**: Opus critiques in isolated context, routes based on quality

**State transitions**:
- Input: Plan in Review
- Output (approved): In Progress (via `__COMPLETE__` intent on `ralph_review` command)
- Output (rejected): Ready for Plan (with `needs-iteration` label)
- Escalation: Human Needed (via `__ESCALATE__` intent)

**Environment variables**:
- `RALPH_COMMAND: "review"`
- `RALPH_REQUIRED_BRANCH: "main"`
- `RALPH_VALID_INPUT_STATES: "Plan in Review"`
- `RALPH_VALID_OUTPUT_STATES: "In Progress,Ready for Plan,Human Needed"`
- `RALPH_ARTIFACT_DIR: "thoughts/shared/reviews"`

### Current Pipeline Handoff

Per `shared/conventions.md`:
- `ralph-advocate` (reviewer) hands off to `ralph-implementer`
- In the new model, the Validator hands off back to Builder (rejection) or to Integrator (future quality gate approval)

## Key Discoveries

### 1. Validator Activation Conditions

Per the #44 research, the Validator only activates for:

| Condition | State Observed | Action |
|-----------|---------------|--------|
| `RALPH_REVIEW_MODE=interactive` | Plan in Review | Run `ralph-review` in interactive mode |
| Builder self-review flags issues | Plan in Review | Run `ralph-review` to provide external critique |
| Future: quality gate failure | In Review | Run future `ralph-test` / `ralph-quality-gate` skills |

When `RALPH_REVIEW_MODE=skip` (default) or `RALPH_REVIEW_MODE=auto`, the Builder handles Plan in Review itself. The Validator does NOT activate.

### 2. Tool Requirements (Reduced from Advocate)

The Validator needs fewer tools than the advocate since it's read-only for implementation:

**Keep from advocate**:
- Read, Glob, Grep (read codebase for plan verification)
- Write (critique documents only -- `thoughts/shared/reviews/`)
- Skill (invoke `ralph-review`)
- Task, TaskList, TaskGet, TaskUpdate, SendMessage (team coordination)
- Bash (git operations, branch check)
- MCP: get_issue, list_issues, update_issue, update_workflow_state, create_comment

**Explicitly NOT needed**:
- Edit (never edits implementation files)
- No worktree write access

### 3. Model Selection

The current advocate uses `opus` because plan review requires deep reasoning about:
- Plan completeness and feasibility
- Technical accuracy (do referenced files/patterns exist?)
- Scope boundary assessment

The Validator should continue using `opus` for the same reasons.

### 4. Task Loop Pattern

The Validator's task loop differs from other workers because it's **conditional**:

```
1. TaskList() -- find tasks with "Review" or "Validate" in subject
2. If found: claim and execute
3. If not found AND RALPH_REVIEW_MODE == "interactive":
   - Query GitHub for issues in "Plan in Review" state
   - If found: create task and execute ralph-review --interactive
4. If not found AND issues exist in "In Review":
   - Future: run quality gates
   - Current: no action (PR awaiting human code review)
5. If nothing to do: go idle
```

### 5. Spawn Template Impact

The current spawn template is `reviewer.md`:
```
Review plan for #{ISSUE_NUMBER}: {TITLE}.
{GROUP_CONTEXT}

Invoke: Skill(skill="ralph-hero:ralph-review", args="{ISSUE_NUMBER}")

Report results per your agent definition.
Then check TaskList for more review tasks. If none, hand off per shared/conventions.md.
```

This template works for the Validator with no changes needed. The orchestrator just needs to map `ralph-validator` agent type to the `reviewer.md` template (or rename it to `validator.md`).

### 6. Pipeline Handoff Changes

Current: `ralph-advocate` -> `ralph-implementer` (always)
New: `ralph-validator` -> `ralph-builder` (rejection case, back to Ready for Plan) or no handoff (approval moves to In Progress, Builder resumes)

The `shared/conventions.md` Pipeline Handoff Protocol table will need updating in a follow-up issue (#49 or #50).

## Recommended Agent Definition Structure

```yaml
---
name: ralph-validator
description: Quality gate - invokes ralph-review skill for plan critique and future quality validation
tools: Read, Write, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue, ralph_hero__update_workflow_state, ralph_hero__create_comment
model: opus
color: blue
---
```

**Worker loop pseudocode**:
```
1. TaskList() -- find tasks with "Review" or "Validate" in subject, pending, empty blockedBy, no owner
2. Claim lowest-ID match: TaskUpdate(taskId, status="in_progress", owner="validator")
3. TaskGet(taskId) -- extract issue number from description
4. Determine mode:
   - If task subject contains "Review": Skill(skill="ralph-hero:ralph-review", args="[issue-number]")
   - If task subject contains "Validate": future quality gate skill
5. TaskUpdate(taskId, status="completed", description="VALIDATION VERDICT\nTicket: #NNN\nPlan: [path]\nVERDICT: [APPROVED/NEEDS_ITERATION]\n[blocking issues]\n[warnings]\n[what's good]")
6. CRITICAL: Full verdict MUST be in task description -- lead cannot see skill output.
7. Repeat from step 1. If no tasks, go idle.
```

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Validator never activates (skip mode is default) | Low | This is by design -- Builder handles happy path. Validator is for quality-critical scenarios. |
| Task subject matching confusion with Builder's self-review | Low | Different task subjects: Builder creates "Self-review #NNN", orchestrator creates "Review plan for #NNN" for Validator |
| Future quality gate skills don't exist yet | Medium | Agent definition should be forward-compatible with placeholder for future skills |

## Recommended Next Steps

1. Create `plugin/ralph-hero/agents/ralph-validator.md` following the structure above
2. Keep the existing `reviewer.md` spawn template (rename to `validator.md` optionally)
3. Document that Validator is optional and mode-dependent in agent description
4. Update orchestrator dispatch (in #49) to check `RALPH_REVIEW_MODE` before spawning Validator
