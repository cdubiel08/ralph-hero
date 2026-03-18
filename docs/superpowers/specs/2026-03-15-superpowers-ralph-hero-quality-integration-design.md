---
date: 2026-03-15
status: draft
type: spec
tags: [superpowers, ralph-hero, tdd, plan-quality, code-quality, automation, tiered-planning]
github_issue: 594
github_issues: [594, 595, 596, 597, 598, 599, 600, 601, 602]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/594
primary_issue: 594
---

# Superpowers Quality Integration — Design Spec

## Goal

Marry Superpowers' plan quality (granular TDD-based tasks, exact acceptance criteria) and code quality (test-first development, two-stage review) into Ralph-Hero's autonomous pipeline while keeping Ralph-Hero's GitHub Projects V2 state management, observability, and automation.

## Non-Goals

- Replacing Ralph-Hero's state machine or GitHub Projects integration
- Making Superpowers a runtime dependency (we adopt its patterns, not its code)
- Changing the interactive skills (plan, research, impl) — this redesign targets the autonomous pipeline
- Adding new workflow states to GitHub Projects

## Prior Work

- builds_on:: [[2026-03-15-superpowers-vs-ralph-hero-comparison]]
- builds_on:: [[2026-02-24-GH-0379-skill-architecture-design]]
- builds_on:: [[2026-03-13-GH-0561-superpowers-bridge-integration]]
- builds_on:: [[2026-02-22-GH-0354-v4-upfront-task-list-ralph-team]]

---

## Architecture Overview

### Core Principles

1. **Plans are better when their dependencies are crystallized** — don't plan a feature until its inputs are concrete
2. **TDD is a planning decision, not an implementation decision** — the planner sets `tdd: true/false` per task, the implementer follows it
3. **The bottom 2 tiers are always one plan** — plan-of-plans only exists for 3+ tier hierarchies
4. **Subagents are flat siblings** — the controller dispatches all subagents, no nesting
5. **Same states, tier-aware behavior** — no new workflow states, skills interpret state based on issue tier
6. **Drift is tracked, not prevented** — implementers adapt locally for minor issues, escalate for major ones

### System Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     3+ Tier Work (Epic)                      │
│                                                              │
│  ralph-plan-epic                                             │
│    ├─ writes plan-of-plans                                   │
│    ├─ ralph-split → creates feature children                 │
│    └─ invokes ralph-plan per feature in dependency waves     │
│         ├─ Wave 1: features with no dependencies (parallel)  │
│         ├─ Wave 2: features depending on Wave 1 plans        │
│         └─ Wave N: ...                                       │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                    2 Tier Work (Feature)                      │
│                                                              │
│  ralph-plan                                                  │
│    ├─ writes implementation plan with task-level detail       │
│    ├─ ralph-split → creates atomic children at In Progress   │
│    └─ posts ## Plan Reference on each atomic child           │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                   1 Tier Work (Atomic)                        │
│                                                              │
│  ralph-plan                                                  │
│    └─ writes implementation plan with task-level detail       │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                    Implementation                            │
│                                                              │
│  ralph-impl (controller)                                     │
│    ├─ resolves plan context (direct or via ## Plan Reference)│
│    ├─ extracts phase tasks with dependency graph             │
│    ├─ dispatches implementer subagents:                      │
│    │    ├─ parallel for independent tasks                    │
│    │    └─ sequential for dependent tasks                    │
│    ├─ dispatches task reviewer subagent after each task      │
│    ├─ dispatches phase reviewer subagent after all tasks     │
│    ├─ handles drift (minor: local adapt, major: escalate)   │
│    └─ commits, pushes, PR on final phase                    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. Tiered Plan Architecture

### Document Types

| Document | Type field | When created | Contains |
|----------|-----------|-------------|----------|
| Plan of Plans | `type: plan-of-plans` | 3+ tier work, by `ralph-plan-epic` | Feature decomposition, shared constraints, integration strategy, wave sequencing |
| Implementation Plan | `type: plan` | Bottom 2 tiers, by `ralph-plan` | Phases, tasks with TDD flags, acceptance criteria, file paths, dependencies |

### Plan-of-Plans Format

```markdown
---
date: YYYY-MM-DD
status: draft
type: plan-of-plans
tags: [relevant, tags]
github_issue: NNN
github_issues: [NNN]
github_urls:
  - https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
primary_issue: NNN
---

# [Epic Name] — Plan of Plans

## Prior Work

- builds_on:: [[research-doc]]

## Strategic Context

[Problem space, why this exists, what success looks like]

## Shared Constraints

[Applies to ALL features — patterns, conventions, architectural decisions,
performance requirements, compatibility requirements]

## Feature Decomposition

### Feature A: [name]
- **Scope**: [what this feature covers]
- **Produces**: [interfaces, files, capabilities other features depend on]
- **Dependencies**: none
- **Estimated atomics**: N

### Feature B: [name]
- **Scope**: [what this feature covers]
- **Produces**: [interfaces, files, capabilities]
- **Dependencies**: Feature A (needs types defined by A)
- **Estimated atomics**: N

## Integration Strategy

[How features compose into the whole — shared interfaces,
integration test strategy, deployment order]

## Feature Sequencing

### Wave 1 (no dependencies — plan immediately):
- Feature A: GH-NNN
- Feature C: GH-NNN

### Wave 2 (depends on Wave 1 plans):
- Feature B: GH-NNN
  - blocked_by: [GH-NNN plan complete]

### Wave 3 (depends on Wave 2):
- Feature D: GH-NNN
  - blocked_by: [GH-NNN plan complete, GH-NNN plan complete]

## What We're NOT Doing

[Explicit scope boundaries]
```

### Implementation Plan Format (Enhanced)

The existing plan format is enhanced with task-level metadata inside each phase:

```markdown
---
date: YYYY-MM-DD
status: draft
type: plan
tags: [relevant, tags]
github_issue: NNN
github_issues: [NNN, NNN, NNN]
github_urls:
  - https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
primary_issue: NNN
parent_plan: thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-epic.md  # if child of plan-of-plans
---

# [Feature Name] Implementation Plan

## Prior Work

- builds_on:: [[research-doc]]
- builds_on:: [[parent-plan-of-plans]]  # if applicable

## Overview

[Table of phases with issue/title/estimate]

## Shared Constraints

[Inherited from parent plan-of-plans if applicable,
extended with feature-specific constraints]

## Current State Analysis
## Desired End State

### Verification
- [ ] [end-state criteria]

## What We're NOT Doing

## Implementation Approach

## Phase 1: [Atomic Issue GH-NNN — name]

### Overview
[What this phase accomplishes]

### Tasks

#### Task 1.1: [name]
- **files**: `src/types.ts` (create)
- **tdd**: true
- **complexity**: low | medium | high
- **depends_on**: null
- **acceptance**:
  - [ ] `StreamConfig` interface exported with required fields
  - [ ] `StreamState` enum with IDLE, RUNNING, COMPLETE, FAILED
  - [ ] Type guard `isStreamConfig()` validates shape

#### Task 1.2: [name]
- **files**: `src/parser.ts` (create), `src/types.ts` (read)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] `parseConfig(raw: string): StreamConfig` handles valid YAML
  - [ ] Throws `ParseError` with line number for invalid input

#### Task 1.3: [name]
- **files**: `src/index.ts:45-60` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - [ ] `createPipeline()` accepts optional `StreamConfig`
  - [ ] Backward compatible — no config = existing behavior

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm test` — all passing
- [ ] `npm run build` — no type errors

#### Manual Verification:
- [ ] Pipeline runs with and without config

---

## Phase 2: [Atomic Issue GH-NNN — name]
[same structure]

---

## Integration Testing
## References
```

### Task Metadata Fields

| Field | Required | Values | Purpose |
|-------|----------|--------|---------|
| `files` | yes | paths with (create/modify/read) | Defines scope; enables parallelism detection and drift tracking |
| `tdd` | yes | `true` / `false` | Planner's decision. true = test-first mandatory, false = implement directly |
| `complexity` | yes | `low` / `medium` / `high` | Drives implementer model selection |
| `depends_on` | yes | `null` or `[task IDs]` | Enables parallel dispatch of independent tasks |
| `acceptance` | yes | checkbox list | Specific verifiable criteria. Spec reviewer checks these mechanically |

### TDD Flag Guidelines for Planners

Set `tdd: true` when:
- Task creates or modifies functions/methods with testable behavior
- Task adds error handling paths
- Task implements business logic

Set `tdd: false` when:
- Task is pure wiring/configuration (imports, exports, config files)
- Task is type-only changes (interfaces, type definitions without logic)
- Task is migration/scaffolding
- Task modifies build/CI configuration

---

## 2. State Model — Same States, Tier-Aware Behavior

### Existing States (unchanged)

```
Backlog → Research Needed → Research in Progress → Ready for Plan →
Plan in Progress → Plan in Review → In Progress → In Review → Done
(+ Canceled, Human Needed)
```

No new states are added.

### Tier-Aware Behavior Within Existing States

| State | Parent (epic/feature) | Atomic |
|-------|-----------------------|--------|
| Research Needed | Research the problem space / feature scope | Research the specific issue |
| Plan in Progress | Writing plan-of-plans or implementation plan | Writing implementation plan |
| Plan in Review | Plan ready for review | (skipped if parent-planned) |
| In Progress | Children are being worked | Implementing with TDD subagents |
| In Review | All children in Review/Done | PR waiting review |
| Done | All children Done | Merged |

### Skip Logic for Parent-Planned Children

When `ralph-split` creates children from a plan:

```
If parent has plan-of-plans AND child is a feature:
  → child enters at "Ready for Plan"
  → post "## Plan of Plans" reference comment on child

If parent has implementation plan AND child is atomic:
  → child enters at "In Progress"
  → post "## Plan Reference" comment with phase anchor on child

Otherwise (no parent plan context):
  → child enters at "Backlog" (current behavior)
```

### State Transitions by Skill

| Skill | Entry state | Lock state | Exit state |
|-------|------------|------------|------------|
| `ralph-plan-epic` | Ready for Plan | Plan in Progress | In Progress (children being planned/worked) |
| `ralph-plan` | Ready for Plan | Plan in Progress | Plan in Review (standalone) or In Progress (if splitting into children) |
| `ralph-review` | Plan in Review | N/A | In Progress (approved) or Ready for Plan (rejected) |
| `ralph-impl` | In Progress | In Progress (lock) | In Review (final phase) |
| `ralph-val` | In Review | N/A (read-only) | N/A (read-only) |

### Tier Detection

A utility `tier-detection.sh` (sourced by hooks and skills) determines tier:

```bash
# Tier detection heuristic:
# - Has children + L/XL estimate → epic tier (parent behavior)
# - Has children + M estimate → feature tier (parent behavior)
# - Has parent with ## Plan Reference → parent-planned atomic
# - No children, XS/S → standalone atomic
# Context from user/orchestrator overrides heuristic
```

### ralph-split State Machine Change

Currently `ralph-split` operates from `Backlog` on M/L/XL issues. The one state machine change needed:

- `ralph-split` can also operate from `Plan in Review` — splitting after a plan is approved
- After splitting, parent moves to `In Progress` (meaning "my children are executing")

**Required `state-resolution.ts` changes:**
- Add `ralph_plan_epic` to `COMMAND_ALLOWED_STATES` with outputs: `["Plan in Progress", "In Progress", "Human Needed"]`
- Add `ralph_plan_epic` to `SEMANTIC_INTENTS`: `__LOCK__` → `Plan in Progress`, `__COMPLETE__` → `In Progress`
- Update `COMMAND_ALLOWED_STATES.ralph_plan` to include `"In Progress"` for the split-after-plan case
- Update `COMMAND_ALLOWED_STATES.ralph_split` to include `"In Progress"` and `"Ready for Plan"` for parent-planned children
- Add conditional `__COMPLETE__` resolution for `ralph_split`: when parent has implementation plan → `In Progress`; when parent has plan-of-plans → `Ready for Plan`; default → `Backlog` (current)

**Required `ralph-state-machine.json` changes:**
- Add `Plan in Review` to `ralph_split.valid_input_states` (currently `["Backlog", "Research Needed"]`)
- Add `Plan in Review → In Progress` as a valid transition for plan-then-split operations
- Register `ralph_plan_epic` as a new command with `valid_input_states: ["Ready for Plan"]`

**Required hook changes:**
- `split-estimate-gate.sh`: allow `Plan in Review` as entry state (currently validates `Backlog`/`Research Needed`)
- No `split-state-gate.sh` exists — the estimate gate is the relevant hook

---

## 3. Planning Skills

### `ralph-plan-epic` (new skill)

**Purpose:** Strategic decomposition for 3+ tier work. Writes plan-of-plans, orchestrates feature-level planning in dependency waves.

**Frontmatter:**
```yaml
name: ralph-plan-epic
description: Strategic planning for complex multi-tier work. Writes plan-of-plans, creates feature children, orchestrates feature planning in dependency waves.
user-invocable: false
context: fork
model: opus
```

**Process:**
1. Research the full problem space (existing pattern: codebase-analyzer, pattern-finder subagents)
2. Write plan-of-plans document (`type: plan-of-plans`)
3. Invoke `ralph-split` to create feature children from the plan
4. Identify dependency waves from plan's Feature Sequencing section
5. For each wave (sequentially):
   - For each feature in wave (parallel where independent):
     - `Skill("ralph-hero:ralph-plan", "GH-NNN --parent-plan <path>")`
   - Wave completion detection: after each `Skill()` call returns, the epic planner checks the feature issue's workflow state via `ralph_hero__get_issue`. When all features in the wave have exited `Plan in Progress` (either to `Plan in Review`, `In Progress`, or `Human Needed`), the wave is complete. This is synchronous inline skill invocation — no polling needed, each `Skill()` call blocks until the feature plan is written.
   - Verify: do features in next wave now have crystallized dependencies?
6. All feature plans complete → epic is In Progress, children are being worked

**Sibling context injection:** When invoking `ralph-plan` for a Wave 2+ feature, the epic planner extracts concrete interface definitions from completed sibling plans and passes them via `--sibling-context`:

```
Sibling Context: Feature A (GH-201) — PLANNED

Produces:
- src/types.ts: StreamConfig interface, StreamState enum
- tests/types.test.ts

Interface contract:
  StreamConfig { name: string, sources: Source[], mode: StreamState }
```

**Plan revision during waves:** If a feature planner discovers a sibling's plan doesn't provide what's needed:
- Minor (missing field, easily added): planner notes in its plan, posts `## Plan Revision Request` comment on sibling issue
- Major (fundamentally wrong interface): planner stops, escalates to epic level with details

**Hooks:** `branch-gate`, `plan-research-required` (adapted to check for research at epic level), state gate for L/XL issues.

### `ralph-plan` (enhanced)

**Changes from current:**

1. **`--parent-plan` flag**: When present, activates child plan mode:
   - Reads parent plan-of-plans for scope and shared constraints
   - Targeted research only for gaps (doesn't repeat epic-level research)
   - Phases anchored to parent plan's feature definition
   - Must satisfy parent plan's integration strategy

2. **`--sibling-context` flag**: Receives concrete interface definitions from sibling feature plans. Used to write task acceptance criteria with real type names, file paths, and function signatures.

3. **Task metadata in plan output**: Every phase now contains `#### Task N.M:` blocks with `files`, `tdd`, `complexity`, `depends_on`, and `acceptance` fields (see format above).

4. **Dispatchability quality check**: Planner self-validates that every task is self-contained enough to dispatch to a subagent with zero additional context.

5. **Split integration**: When planning an M issue with multiple phases mapping to atomic children, after writing the plan:
   - Invokes `ralph-split` to create atomic children
   - Posts `## Plan Reference` with phase anchor on each child
   - Children enter at `In Progress`

**Unchanged:** Standalone XS/S planning, research discovery chain, hook enforcement, commit/push flow.

---

## 4. Implementation Skill Redesign

### `ralph-impl` as Controller

`ralph-impl` becomes a controller that dispatches task subagents within a phase. One phase per invocation (unchanged), but within the phase, work is decomposed into subagent-executed tasks.

**Subagent prompt templates** (new files in `skills/ralph-impl/`):

```
plugin/ralph-hero/skills/ralph-impl/
  SKILL.md                    # controller logic (rewritten)
  implementer-prompt.md        # task implementation (with TDD protocol)
  task-reviewer-prompt.md      # per-task: does code match task spec?
  phase-reviewer-prompt.md     # per-phase: holistic code quality
```

### Revised Flow

```
ralph-impl picks up atomic issue "In Progress"
  │
  ├─ 1. Resolve plan context
  │     - Direct plan (standalone issue)
  │     - ## Plan Reference → parent plan → extract phase section
  │     - Also extract Shared Constraints from plan header
  │
  ├─ 2. Extract current phase's tasks
  │     - Parse #### Task N.M blocks
  │     - Build dependency graph from depends_on fields
  │     - Identify parallel groups (independent tasks)
  │
  ├─ 3. Worktree setup (existing flow, unchanged)
  │
  ├─ 4. Task execution loop:
  │     │
  │     │  For each task (parallel where independent, sequential where dependent):
  │     │
  │     ├─ 4a. Build context packet:
  │     │       - Task definition (from plan, specific task block)
  │     │       - Shared constraints (from plan header / plan-of-plans)
  │     │       - TDD flag + acceptance criteria
  │     │       - File paths to read/create/modify
  │     │       - Drift log (any prior adaptations in this phase)
  │     │       - NOT: full plan, NOT: epic context, NOT: session history
  │     │
  │     ├─ 4b. Dispatch implementer subagent
  │     │       - Model selected from complexity hint:
  │     │         low → haiku, medium → sonnet, high → opus
  │     │       - If tdd: true → must follow TDD protocol
  │     │       - If tdd: false → implement directly
  │     │       - Returns: DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED
  │     │
  │     ├─ 4c. Handle implementer status:
  │     │       DONE → proceed to review
  │     │       DONE_WITH_CONCERNS → evaluate concerns, then review
  │     │       NEEDS_CONTEXT → provide context, re-dispatch
  │     │       BLOCKED → assess:
  │     │         - Minor drift? Adapt locally, log, continue
  │     │         - Major drift? Pause phase, flag plan revision
  │     │         - Model too weak? Re-dispatch with more capable model (max 1 upgrade)
  │     │       Max retries per task: 3 (across all statuses except DONE)
  │     │
  │     ├─ 4d. Dispatch task reviewer subagent (haiku)
  │     │       - Checks acceptance criteria addressed
  │     │       - Checks nothing extra built
  │     │       - If tdd: true → verifies red-green evidence
  │     │       - Checks files match declared file list
  │     │       ✅ COMPLIANT → mark task complete
  │     │       ❌ ISSUES → implementer fixes, re-review (max 3 loops)
  │     │
  │     └─ 4e. Update drift log if local adaptations occurred
  │
  ├─ 5. Phase-level code quality review (opus)
  │     - Reviews ALL changes in phase holistically
  │     - git diff for entire phase
  │     - Checks: file responsibility, cross-task integration,
  │       pattern adherence, test quality, naming
  │     - Critical issues → dispatch fix subagent, re-review
  │     - Important issues → dispatch fix subagent
  │     - Minor issues → log in commit message
  │
  ├─ 6. Run phase success criteria (automated verification)
  │
  ├─ 7. Selective staging + commit (existing flow)
  │     - Only files in task file lists are staged
  │     - Unexpected files produce warning
  │     - git add -A / git add . still forbidden
  │
  └─ 8. Final phase → PR creation (existing flow)
```

### Parallelization Rules

Within a phase, tasks declare dependencies:

```
Task 1.1: files: [src/types.ts], depends_on: null
Task 1.2: files: [src/parser.ts], depends_on: null
Task 1.3: files: [src/index.ts], depends_on: [1.1, 1.2]
```

- Tasks with `depends_on: null` and no shared files → dispatched in parallel
- Tasks with shared files → always sequential regardless of depends_on
- Tasks with `depends_on: [X]` → wait for X to complete + pass review

The controller tracks task status and dispatches the next eligible batch after each completion.

### Model Selection

| Role | Model | Rationale |
|------|-------|-----------|
| Controller (ralph-impl) | opus | Coordination, judgment, drift assessment |
| Implementer (low complexity) | haiku | Mechanical implementation, clear spec |
| Implementer (medium complexity) | sonnet | Multi-file coordination, pattern matching |
| Implementer (high complexity) | opus | Architecture, design judgment |
| Task reviewer | haiku | Mechanical comparison — does output match spec? |
| Phase reviewer | opus | Holistic judgment across all changes |
| Fix subagent | same as original implementer | Preserves approach context |

### Dispatch Constraints

All subagents are **flat siblings** dispatched by the top-level context:

| Mode | Top-level context | Skills run as | Subagent depth |
|------|------------------|---------------|----------------|
| `ralph-loop.sh` | Claude session | Inline (Skill tool) | One level |
| Hero | Hero skill in session | Inline (Skill tool) | One level |
| Team | Worker agent | Inline (Skill tool inside worker) | One level |
| Interactive | User session | Inline (Skill tool) | One level |

Hero mode change: hero invokes skills inline (via `Skill` tool) instead of dispatching them as subagents. This trades context isolation for subagent capability.

**Hero inline invocation details:**
- Hero's `allowed-tools` must be expanded to include all tools needed by inlined skills (Write, Edit, Bash, Agent, etc.) — effectively hero becomes a superset
- When a skill is invoked inline via `Skill()`, it runs in hero's context with hero's hooks active. Per-skill hooks declared in the inlined skill's frontmatter are NOT automatically loaded — the hero skill must explicitly set the relevant `RALPH_COMMAND` env var before invoking each skill so that shared hooks (state gates, postconditions) activate correctly
- `context: fork` on skill frontmatter is ignored when invoked inline — the skill shares hero's context. This is the intended tradeoff: hero loses context isolation, gains subagent dispatch depth
- The `Agent()` calls within inlined skills (e.g., implementer subagents from `ralph-impl`) work because they dispatch from hero's top-level context — one level deep, not nested
- **Skill nesting via `Skill()` is fine** — `Skill()` is not `Agent()`. Calling `Skill()` from within an inlined skill does not create a new agent level; it loads and executes the skill's instructions in the current context. So hero → inline `ralph-plan-epic` → `Skill("ralph-plan")` is all one context, not nested agents. The flat sibling constraint applies only to `Agent()` dispatch, not `Skill()` invocation

### Implementer Prompt Template (`implementer-prompt.md`)

```markdown
# Implementer Subagent

You are implementing a single task within a larger plan.

## Task Definition

[FULL TASK BLOCK from plan — pasted by controller, not a file reference]

## Shared Constraints

[From plan header or plan-of-plans — pasted by controller]

## Drift Log

[Any prior adaptations in this phase — empty if first task]

## TDD Protocol

{{IF tdd: true}}
MANDATORY. You MUST follow this exactly:

1. Write ONE failing test for the first acceptance criterion
2. Run test suite — verify it FAILS (include failure output in report)
3. Write minimal code to make it pass
4. Run test suite — verify it PASSES (include pass output in report)
5. Repeat for each remaining acceptance criterion
6. Refactor if needed (keep green)
7. Commit with test + implementation together

If you write implementation code before a failing test exists:
DELETE IT. Start over. No exceptions.

Your report MUST include red-green evidence:
- Test failure output (showing the test fails for the right reason)
- Test pass output (showing minimal code makes it green)
{{END IF}}

{{IF tdd: false}}
Implement directly. Write tests after if the task's acceptance criteria
require verification, but test-first is not required for this task.
{{END IF}}

## Before You Begin

If ANYTHING is unclear about requirements, approach, or dependencies:
**Ask now.** Report NEEDS_CONTEXT. Don't guess.

## Your Job

1. Implement exactly what the task specifies
2. Follow TDD protocol if tdd: true
3. Verify all acceptance criteria are met
4. Commit your work
5. Self-review: completeness, quality, discipline, testing
6. Report back

## When You're in Over Your Head

Stop and report BLOCKED. Bad work is worse than no work.

## Drift Protocol

If you discover the plan's assumptions don't match reality:
- File renamed/moved, API slightly different, import path changed:
  → Adapt locally, note in commit message prefixed with "DRIFT:"
- Approach fundamentally wrong, missing capability, scope mismatch:
  → Report BLOCKED with drift details. Do not attempt a workaround.

## Report Format

- **Status:** DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
- What you implemented
- Files changed
- Test results (with red-green evidence if tdd: true)
- Self-review findings
- Drift notes (if any)
```

### Task Reviewer Prompt Template (`task-reviewer-prompt.md`)

```markdown
# Task Reviewer Subagent

You are verifying whether an implementation matches its task specification.

## Task Specification

[FULL TASK BLOCK from plan]

## Implementer Report

[Status, files changed, test results, drift notes]

## TDD Compliance

Task TDD flag: {{tdd_flag}}

{{IF tdd: true}}
VERIFY:
- Report contains test failure output (red phase)
- Report contains test pass output (green phase)
- Failure was for the RIGHT reason (feature missing, not typo)
- If red-green evidence is missing → FAIL regardless of code quality
{{END IF}}

## Your Job

Read the actual code. Do NOT trust the implementer's report.

Check:
1. Every acceptance criterion is addressed in the code
2. Nothing extra was built beyond the task spec
3. Files changed match the task's declared file list
   (unexpected files = flag, not auto-fail)
4. TDD compliance (if tdd: true)

## Output

**Status:** COMPLIANT | ISSUES

**Issues (if any):**
- [acceptance criterion]: [what's wrong, with file:line reference]

**Unexpected files (if any):**
- [file]: [what it contains, why it might be drift]
```

### Phase Reviewer Prompt Template (`phase-reviewer-prompt.md`)

```markdown
# Phase Reviewer Subagent

You are reviewing all changes in a completed phase for code quality.

## Phase Overview

[Phase description from plan]

## Changes

[git diff output for the entire phase — base commit to current HEAD]

## Shared Constraints

[From plan header — coding standards, patterns to follow]

## Your Job

Review holistically. Individual tasks have already passed spec compliance.
You are checking how they fit together.

Check:
1. Each file has one clear responsibility
2. Cross-task integration is clean (imports, interfaces align)
3. Tests verify behavior, not mocks
4. Naming is consistent with codebase conventions
5. No unnecessary complexity introduced
6. Follows existing codebase patterns

## Output

**Strengths:**
- [what's done well]

**Issues:**
- Critical: [must fix — blocks proceeding]
- Important: [should fix — dispatch fix subagent]
- Minor: [note for commit message — doesn't block]

**Assessment:** APPROVED | NEEDS_FIXES
```

---

## 5. Artifact Comment Protocol Extensions

### New Comment Headers

| Header | Posted on | Contains |
|--------|-----------|----------|
| `## Plan of Plans` | Epic issue | URL to plan-of-plans doc, feature list with issue numbers |
| `## Plan Reference` (new) | Atomic issue (parent-planned) | URL to parent plan + anchor to specific phase, inherited constraints summary |
| `## Phase N Review` (new) | Atomic issue | Phase code quality review result |
| `## Drift Log — Phase N` (new) | Atomic issue (if drift occurred) | List of adaptations with severity |
| `## Plan Revision Request` (new) | Sibling issue | What's needed, why current plan doesn't provide it |

### Existing Headers (unchanged)

| Header | Usage |
|--------|-------|
| `## Research Document` | Research doc link |
| `## Implementation Plan` | Plan doc link |
| `## Validation` | ralph-val results |
| `## Plan Review` | ralph-review verdict |

### Plan Discovery Chain (updated)

The four-level fallback used by consuming skills adds `## Plan Reference` support:

```
1. knowledge_search (existing)
2. --plan-doc flag (existing)
3. Artifact Comment Protocol — checks headers in order:
   a. ## Implementation Plan (direct plan)
   b. ## Plan Reference (backreference → follow to parent plan, extract phase)
   c. ## Plan of Plans (for feature-level context)
4. Glob fallback (existing)
```

When resolving via `## Plan Reference`:
- Extract the URL and phase anchor
- Read the parent plan
- Extract the specific phase section + `## Shared Constraints` section
- Optionally: extract `## Integration Strategy` from plan-of-plans if cross-feature work

---

## 6. Hook Updates

### New Hooks

| Hook | Type | Trigger | Purpose |
|------|------|---------|---------|
| `tier-detection.sh` | Utility (sourced) | N/A | Determines issue tier from estimate + children + comments. Returns: `epic`, `feature`, `atomic`, `standalone` |
| `drift-tracker.sh` | PostToolUse | `Write` / `Edit` in worktree | Detects file changes outside task's declared file list, logs to drift comment |
| `plan-tier-validator.sh` | PreToolUse | `ralph_hero__save_issue` | Validates plan type matches issue context (plan-of-plans for epic planning, implementation plan for feature/atomic) |

### Modified Hooks

| Hook | Change |
|------|--------|
| `split-estimate-gate.sh` | Allow `Plan in Review` as entry state (currently validates `Backlog`/`Research Needed` only) |
| `impl-plan-required.sh` | Follow `## Plan Reference` up to parent plan; validate phase section exists |
| `plan-research-required.sh` | If issue has parent with plan-of-plans, validate plan-of-plans exists (not just direct research) |
| `impl-staging-gate.sh` | Enhanced: cross-reference staged files against task's declared file list (task-level granularity replaces phase-level file ownership check) |

### Unchanged Hooks

All other hooks remain unchanged. State gates, branch gates, lock validators, postcondition validators, team protocol hooks — all work as-is because the state model is unchanged.

---

## 7. Quality Standards Update

### `shared/quality-standards.md` Changes

Add fifth plan quality dimension:

| Dimension | Criteria |
|-----------|----------|
| **Completeness** | (existing) All phases defined with specific file changes |
| **Feasibility** | (existing) Referenced files exist; patterns follow codebase conventions |
| **Clarity** | (existing) Success criteria are specific and testable |
| **Scope** | (existing) "What we're NOT doing" is explicit |
| **Dispatchability** (new) | Every task is self-contained enough to dispatch to a subagent with zero additional context. Task has files, TDD flag, acceptance criteria, and dependency info. No task requires reading the full plan to understand |

Add plan-of-plans quality dimensions:

| Dimension | Criteria |
|-----------|----------|
| **Decomposition** | Features are M-sized, independently plannable, with clear boundaries |
| **Dependency clarity** | Wave sequencing is explicit; each feature's inputs/outputs are named |
| **Integration** | Strategy for how features compose is concrete, not hand-wavy |
| **Constraint completeness** | Shared constraints cover patterns, conventions, and compatibility requirements |

---

## 8. Drift Handling Protocol

### Classification

| Severity | Examples | Handler |
|----------|----------|---------|
| Minor | File renamed/moved, API signature slightly different, import path changed, config value different | Implementer adapts locally, logs `DRIFT:` prefix in commit message |
| Major | Approach fundamentally wrong, missing capability/dependency, task scope significantly different | Implementer reports BLOCKED, controller assesses |

### Controller Assessment for Major Drift

```
Controller receives BLOCKED with drift details:
  │
  ├─ Can remaining tasks still proceed?
  │   Yes → continue other tasks, queue plan revision
  │   No  → pause all tasks
  │
  ├─ Is this a local plan issue or a parent plan issue?
  │   Local → post ## Plan Revision Request on own issue
  │   Parent → post ## Plan Revision Request on parent issue
  │
  └─ Severity assessment:
      - Single task affected → local revision
      - Multiple tasks affected → phase revision
      - Cross-phase impact → escalate to Human Needed
```

### Tracking

- Minor drift: `DRIFT:` prefix in commit messages, aggregated in `## Drift Log — Phase N` comment at phase completion
- Major drift: `## Plan Revision Request` comment on affected issue, controller decides whether to continue or pause
- All drift visible in GitHub issue timeline for observability

---

## 9. Changes Summary

### New Skills

| Skill | Purpose |
|-------|---------|
| `ralph-plan-epic` | Plan-of-plans for 3+ tier work, orchestrates feature planning in waves |

### Modified Skills

| Skill | Changes |
|-------|---------|
| `ralph-plan` | Task-level metadata (tdd, complexity, depends_on, acceptance), `--parent-plan` and `--sibling-context` flags, dispatchability quality check, split integration for M issues |
| `ralph-impl` | Controller pattern: dispatches implementer/reviewer subagents per task, parallel dispatch for independent tasks, TDD enforcement via prompt template, drift handling protocol. New prompt templates: `implementer-prompt.md`, `task-reviewer-prompt.md`, `phase-reviewer-prompt.md` |
| `ralph-review` | Updated quality standards (Dispatchability dimension), plan-of-plans review support |
| `ralph-split` | Can operate from `Plan in Review` state, creates children at appropriate entry state based on parent plan context |
| `hero` | Invokes skills inline via `Skill` tool instead of dispatching as subagents; `allowed-tools` expanded to superset |
| `ralph-val` | No changes to core logic. Enhanced to verify cross-phase integration and check drift log coherence alongside existing automated verification checkboxes |

### Modified MCP Server

| File | Changes |
|------|---------|
| `workflow-states.ts` | No new states. Add `SKIP_ENTRY_STATES` mapping for parent-planned children |
| `state-resolution.ts` | Register `ralph_plan_epic` command. Add `In Progress` to `ralph_plan` and `ralph_split` allowed outputs. Add conditional `__COMPLETE__` resolution for `ralph_split` based on parent plan context |
| `ralph-state-machine.json` | Add `Plan in Review` to `ralph_split.valid_input_states`. Add `Plan in Review → In Progress` transition. Register `ralph_plan_epic` command |

### New Hooks

| Hook | Purpose |
|------|---------|
| `tier-detection.sh` | Utility: determines issue tier |
| `drift-tracker.sh` | PostToolUse: tracks file changes outside declared scope |
| `plan-tier-validator.sh` | PreToolUse: validates plan type matches issue context |

### Modified Hooks

| Hook | Change |
|------|--------|
| `split-estimate-gate.sh` | Allow `Plan in Review` entry |
| `impl-plan-required.sh` | Follow `## Plan Reference` chain |
| `plan-research-required.sh` | Validate plan-of-plans for parent context |
| `impl-staging-gate.sh` | Cross-reference against task file lists |

### New Document Types

| Type | Frontmatter `type` value |
|------|-------------------------|
| Plan of Plans | `plan-of-plans` |

### Artifact Protocol Extensions

| Header | Purpose |
|--------|---------|
| `## Plan of Plans` | Epic → plan-of-plans link |
| `## Plan Reference` | Atomic → parent plan phase link |
| `## Phase N Review` | Phase code quality results |
| `## Drift Log — Phase N` | Phase drift summary |
| `## Plan Revision Request` | Cross-issue plan revision needed |
