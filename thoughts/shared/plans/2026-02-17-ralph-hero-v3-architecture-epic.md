---
date: 2026-02-17
status: draft
type: epic
github_issues: []
children:
  - 2026-02-17-plan-1-critical-bug-fixes.md
  - 2026-02-17-plan-2-hop-architecture.md
  - 2026-02-17-plan-3-skill-autonomy-self-validation.md
  - 2026-02-17-plan-4-memory-layer-state-coherence.md
---

# Ralph Hero v3 Architecture - Epic Plan

## Overview

Ralph Hero v2.4.0 has accumulated regressions and architectural debt that prevent reliable autonomous operation, especially in agent-team mode. This epic addresses critical bugs and then progressively refactors toward composable, predictable, context-efficient agent orchestration inspired by Bowser's four-layer architecture.

## Guiding Principles

1. **Minimal Context**: Agents receive just barely enough information to begin work. Nothing more.
2. **Skills Define Stations**: An agent's job is defined entirely by the SKILL it invokes. Agents are thin wrappers.
3. **Fork by Default**: Skills run in forked subprocesses to isolate context and prevent pollution.
4. **Self-Validating Skills**: Every skill validates its own preconditions and postconditions via HOOKs.
5. **Higher-Order Prompts (HOPs)**: Spawn prompts are composable, parameterized templates - not inline prose.
6. **Consistent Memory**: GitHub Issues + linked files form the single source of truth. No scattered state.
7. **Orchestrator Purity**: Orchestrators delegate. They never implement, research, plan, or review.

## Architecture Vision (End State)

```
Layer 4: Scripts           → ralph-loop.sh, ralph-team-loop.sh (entry points)
Layer 3: Orchestrators     → ralph-hero, ralph-team (route work, never implement)
Layer 2: Agents            → thin wrappers that invoke exactly one skill
Layer 1: Skills            → self-contained, forked, self-validating execution units
```

Each layer delegates downward. No layer skips levels. Each layer is independently testable.

## Sub-Plans (Sequential Dependencies)

| # | Plan | Scope | Priority | Depends On |
|---|------|-------|----------|------------|
| 1 | [Critical Bug Fixes](./2026-02-17-plan-1-critical-bug-fixes.md) | Branch isolation, missing worktree script, CWD enforcement | P0 | None |
| 2 | [HOP Architecture](./2026-02-17-plan-2-hop-architecture.md) | Composable spawn templates, parameterized prompts, messaging formalization | P1 | Plan 1 |
| 3 | [Skill Autonomy & Self-Validation](./2026-02-17-plan-3-skill-autonomy-self-validation.md) | Fork-by-default, hook-based self-validation, thin agent wrappers, context minimalism | P1 | Plan 2 |
| 4 | [Memory Layer & State Coherence](./2026-02-17-plan-4-memory-layer-state-coherence.md) | GitHub Issues as memory, file-to-issue linking, context validation hooks | P2 | Plans 2+3 |

## Key Bugs Driving This Work

1. **Branch isolation broken**: `impl-worktree-gate.sh` only warns (exit 0), never blocks (exit 2). Agents write to main.
2. **Missing create-worktree.sh**: impl SKILL.md Step 5.3 references `./scripts/create-worktree.sh` which doesn't exist in the current repo.
3. **Spawn prompt bloat**: ralph-team Section 6 requires issue title, description, state, group context, codebase hints, artifacts - far exceeding "just barely enough."
4. **No fork isolation**: Skills don't specify `fork: true`. Inline execution pollutes caller context.
5. **Scattered memory**: Context passes through TaskUpdate descriptions, GitHub comments, and thoughts/ files with no consistent pattern.

## Bowser-Inspired Patterns Applied

| Bowser Pattern | Ralph Application |
|----------------|-------------------|
| Four-layer architecture | Scripts → Orchestrators → Agents → Skills |
| `{PROMPT}` placeholder templates | `{ISSUE_NUMBER}`, `{STATE}`, `{ARTIFACTS}` in spawn templates |
| Delegate mode (orchestrator purity) | hooks block Write/Edit for orchestrator sessions |
| On-demand skill loading | Trigger-based routing reduces context by ~54% |
| Exit code enforcement | All gates use exit 2 (block) not exit 0 (warn) |
| YAML-based work discovery | GitHub Projects API as work queue |
| Independent layer testing | Each skill/agent/orchestrator testable in isolation |

## What We're NOT Doing

- Rewriting the MCP server (it works well)
- Changing the 11-state workflow state machine
- Changing GitHub Projects as the source of truth
- Adding new workflow states or phases
- Building a custom observability dashboard (future work)
- Supporting multiple repos simultaneously (future work)

## Success Criteria

### Plan 1 Complete:
- [ ] Agents always work in worktrees during implementation
- [ ] impl-worktree-gate.sh blocks (exit 2) when writes target main repo
- [ ] create-worktree.sh exists and works from plugin root
- [ ] ralph_team running on itself (ralph-hero repo) creates proper branches

### Plan 2 Complete:
- [ ] Spawn prompts are parameterized templates in dedicated files
- [ ] New workflow can be added by creating a template file (no orchestrator edits)
- [ ] Agent spawn context is <100 tokens of prompt text (excluding skill content)

### Plan 3 Complete:
- [ ] All skills specify fork behavior in frontmatter
- [ ] Each skill has PreToolUse + Stop hooks for self-validation
- [ ] Agents are <30 lines of markdown each (thin wrappers)
- [ ] Running a skill standalone produces identical results to running via agent

### Plan 4 Complete:
- [ ] Every artifact (research doc, plan doc, review doc) is linked bidirectionally to its GitHub issue
- [ ] Context validation hooks verify agents have required artifacts before proceeding
- [ ] Prior phase output is discoverable from GitHub issue alone (no TaskUpdate parsing needed)

## Implementation Order

```
Plan 1 → Plan 2 → Plan 3 → Plan 4
 (fix)    (arch)   (refactor)  (enhance)
```

Each plan is independently shippable. Plan 1 can land immediately. Plans 2-4 build progressively on the new architecture.
