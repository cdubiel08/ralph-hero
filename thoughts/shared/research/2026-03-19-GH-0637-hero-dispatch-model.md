---
date: 2026-03-19
github_issue: 637
github_url: https://github.com/cdubiel08/ralph-hero/issues/637
status: complete
type: research
tags: [hero, skills, agent-dispatch, context-isolation, orchestration]
---

# Hero Skill Dispatch Model — Skill() vs Agent()

## Prior Work

- builds_on:: [[2026-03-19-plan-of-plans-model-switching]]

## Problem Statement

The hero skill (`plugin/ralph-hero/skills/hero/SKILL.md`) dispatches ALL sub-skills via `Skill()` (inline in hero's context). For skills that don't need interactive tools, this is strictly wasteful:

1. **Context window bloat** — each ralph-research, ralph-plan, and ralph-impl invocation consumes tokens in hero's context window, making long pipelines increasingly fragile.
2. **No parallelism** — `Skill()` runs inline (blocking). Multiple independent research tasks could run simultaneously via `Agent()` but cannot with the current model.
3. **Unnecessary coupling** — autonomous skills have `context: fork` in their frontmatter precisely because they were designed to run isolated. Using `Skill()` overrides that declaration.

The "Inline Skill Invocation Notes" section in hero.md (lines 347–354) explicitly documents this as an intentional trade-off: "Hero trades context isolation for subagent dispatch capability — this is intentional." The fix is to declare that trade-off no longer necessary and switch autonomous phases to `Agent()`.

## Current State Analysis

### hero.md — Every Skill() Dispatch Call

All calls are in the "Phase-specific execution details" section of the Execution Loop (Step 3):

| Line range | Call | Phase | Context |
|-----------|------|-------|---------|
| 232–233 | `Skill("ralph-hero:ralph-split", "NNN")` | SPLIT | Inline, M/L/XL issues |
| 295 | `Skill("ralph-hero:ralph-research", "NNN")` | RESEARCH | Inline, parallel-eligible |
| 308–319 | `Skill("ralph-hero:ralph-plan-epic", "NNN")` | PLAN (L/XL) | Inline with Skill nesting |
| 312–319 | `Skill("ralph-hero:ralph-plan", "NNN --research-doc ...")` | PLAN (M/S/XS) | Inline, multiple variants |
| 326 | `Skill("ralph-hero:ralph-review", "NNN --plan-doc ...")` | REVIEW | Inline |
| 339–345 | `Skill("ralph-hero:ralph-impl", "NNN --plan-doc ...")` | IMPLEMENT | Inline |

The "Inline Skill Invocation Notes" section (lines 347–354) reads:

```
Skills invoked via Skill() run inline in hero's context, not as separate agents:
- The skill's SessionStart hook sets RALPH_COMMAND for that skill
- ralph-impl can dispatch its own subagents via Agent() — these are one level deep from hero's context (valid)
- Skill() nesting is fine: hero → Skill(ralph-plan-epic) → Skill(ralph-plan) — all same context
- Hero trades context isolation for subagent dispatch capability — this is intentional
```

This note was written when hero's `allowed-tools` did not include MCP tools. It was correct then — skills needed to run inline to access GitHub MCP tools. That constraint was removed in a prior PR that added MCP tools directly to hero's `allowed-tools` list (lines 15–28 of hero.md). The rationale is now obsolete.

### ralph-plan-epic.md — Internal Skill() Calls

ralph-plan-epic also uses `Skill()` internally (Step 6 and Step 7):

- **Step 6** (line 210): `Skill("ralph-hero:ralph-split", "GH-NNN")` — creates M-sized feature children
- **Step 7** (lines 243–244): `Skill("ralph-hero:ralph-plan", "GH-{feature_number} --parent-plan ... --sibling-context ...")` — orchestrates feature planning in dependency waves

The Step 7 comment notes: "Within a wave, features with no shared dependencies can be planned in parallel (via parallel `Skill()` calls)." This is misleading — `Skill()` is blocking, so "parallel `Skill()` calls" in a single message may work if the Claude runtime handles parallel tool calls, but it is NOT guaranteed. `Agent()` provides explicit parallelism semantics.

### Autonomous Skills — Confirmed No AskUserQuestion

| Skill | `context` | AskUserQuestion? | Notes |
|-------|-----------|-----------------|-------|
| `ralph-research` | `fork` | No | Uses only `Task`, `Agent`, file tools, MCP tools |
| `ralph-plan` | `fork` | No | Uses only `Task`, `Agent`, file tools, MCP tools |
| `ralph-impl` | `fork` | No | Uses only `Task`, `Agent`, file tools, MCP tools |
| `ralph-split` | `fork` | No | Uses only `Task`, `Agent`, file tools, MCP tools |
| `ralph-review` | `fork` | Conditional | AUTO mode: no. INTERACTIVE mode: `AskUserQuestion` in Step 4A |

**ralph-review edge case**: When `RALPH_REVIEW_MODE == "auto"` (hero's default for REVIEW tasks), ralph-review runs in AUTO mode and does NOT call `AskUserQuestion`. When called with `--interactive`, it does. Hero only calls review in AUTO mode so this is safe to convert.

### Interactive Counterparts — Confirmed AskUserQuestion Usage

| Skill | AskUserQuestion? | Where |
|-------|-----------------|-------|
| `research` (interactive) | No explicit `AskUserQuestion` | Waits for user input via normal flow, asks follow-up questions |
| `plan` (interactive) | No explicit `AskUserQuestion` | Asks via normal conversation; gets buy-in at steps 3, 5 |
| `impl` (interactive) | No explicit `AskUserQuestion` | Pauses for human verification at Step 4.4 |

Note: the interactive counterparts don't actually use the `AskUserQuestion` tool — they rely on natural conversation flow. But they are designed for human collaboration and cannot run autonomously, making them inappropriate for hero's pipeline. They are not the skills hero calls anyway (hero calls `ralph-*` variants).

### Agent Definitions — Subagent Type Mapping

| Agent | File | `subagent_type` value | Role |
|-------|------|-----------------------|------|
| `ralph-analyst` | `plugin/ralph-hero/agents/ralph-analyst.md` | `ralph-hero:ralph-analyst` | Triage, split, research, plan |
| `ralph-builder` | `plugin/ralph-hero/agents/ralph-builder.md` | `ralph-hero:ralph-builder` | Plan review, implementation |
| `ralph-integrator` | `plugin/ralph-hero/agents/ralph-integrator.md` | `ralph-hero:ralph-integrator` | Validation, PR creation, merge |
| `codebase-analyzer` | `plugin/ralph-hero/agents/codebase-analyzer.md` | `ralph-hero:codebase-analyzer` | Deep file analysis |
| `codebase-locator` | `plugin/ralph-hero/agents/codebase-locator.md` | `ralph-hero:codebase-locator` | Finding relevant files |
| `codebase-pattern-finder` | `plugin/ralph-hero/agents/codebase-pattern-finder.md` | `ralph-hero:codebase-pattern-finder` | Pattern discovery |
| `github-analyzer` | `plugin/ralph-hero/agents/github-analyzer.md` | `ralph-hero:github-analyzer` | GitHub issue analysis |
| `github-lister` | `plugin/ralph-hero/agents/github-lister.md` | `ralph-hero:github-lister` | GitHub issue listing |
| `web-search-researcher` | `plugin/ralph-hero/agents/web-search-researcher.md` | `ralph-hero:web-search-researcher` | External research |
| `thoughts-locator` | `plugin/ralph-hero/agents/thoughts-locator.md` | `ralph-hero:thoughts-locator` | Thoughts directory search |
| `thoughts-analyzer` | `plugin/ralph-hero/agents/thoughts-analyzer.md` | `ralph-hero:thoughts-analyzer` | Thoughts document analysis |

**Critical finding**: There is no `ralph-hero:general-purpose` agent type. The hero skill currently calls skills inline via `Skill()`, and the ralph-plan-epic skill dispatches ralph-plan sub-invocations via `Skill()`. When converting these to `Agent()`, the `subagent_type` must be either `ralph-hero:ralph-analyst`, `ralph-hero:ralph-builder`, etc., or `"general-purpose"` (no plugin prefix, which uses the base Claude model).

The team skill (team.md) uses the role-based agent types: `ralph-analyst` handles research/plan/split/triage; `ralph-builder` handles review/impl. This is the right model for hero too.

### team.md — Already Uses Agent() Correctly

The team skill does NOT call `Skill()` for pipeline phases at all. Instead:

1. It spawns persistent worker agents via `Agent()` or `TeamCreate()`
2. Workers invoke skills themselves via `Skill()` from within their own agent context
3. The team lead only creates tasks and coordinates — it never calls ralph-research, ralph-plan, ralph-impl directly

This is the correct architecture: agents wrap skills, not the other way around.

## Key Findings

### Finding 1: The "intentional" note is stale

The note in hero.md ("Hero trades context isolation for subagent dispatch capability — this is intentional") was written before MCP tools were added to hero's `allowed-tools`. Hero now has direct access to all `ralph_hero__*` tools. The original reason for inline dispatch (needing MCP tool access) no longer applies.

### Finding 2: Artifact path passing works with Agent() too

Hero's current pattern for passing artifact paths:

```
Skill("ralph-hero:ralph-plan", "NNN --research-doc thoughts/shared/research/...")
```

When converted to `Agent()`, the artifact path can be passed in the prompt string exactly the same way — the `Agent()` call's `prompt` parameter is a free-form string. The sub-agent will invoke the skill with those args.

Example conversion:
```
# Before:
Skill("ralph-hero:ralph-plan", "NNN --research-doc thoughts/shared/research/...")

# After:
Agent(
  subagent_type="ralph-hero:ralph-analyst",
  prompt="Run /ralph-hero:ralph-plan NNN --research-doc thoughts/shared/research/...",
  description="Plan GH-NNN"
)
```

### Finding 3: ralph-review INTERACTIVE mode is the only interactive risk

The only risk is ralph-review's INTERACTIVE mode (Step 4A). Hero never explicitly enables interactive mode — it calls `Skill("ralph-hero:ralph-review", "NNN --plan-doc ...")` without `--interactive`. Auto mode does not use `AskUserQuestion`. Converting to `Agent()` is safe as long as hero never adds `--interactive` to the review dispatch.

### Finding 4: ralph-plan-epic has internal Skill() calls that should also become Agent()

ralph-plan-epic calls `Skill("ralph-hero:ralph-split", ...)` and `Skill("ralph-hero:ralph-plan", ...)` for wave orchestration. These should also become `Agent()` calls to:
1. Actually enable parallel wave planning (currently "parallel Skill() calls" is misleading)
2. Isolate each feature plan's context from the epic planner context

### Finding 5: Hero's Execution Loop already has the right shape for Agent() dispatch

The Execution Loop (Step 3) says: "Execute all unblocked tasks simultaneously (multiple `Task()` calls in a single message, foreground)." Replacing `Skill()` with `Agent()` inside each task block gives true parallel execution for independent tasks (e.g., multiple RESEARCH tasks).

## Recommended Dispatch Mapping

| Phase | Current | Proposed | subagent_type |
|-------|---------|----------|---------------|
| SPLIT | `Skill("ralph-hero:ralph-split", "NNN")` | `Agent(subagent_type="ralph-hero:ralph-analyst", prompt="Run /ralph-hero:ralph-split NNN")` | `ralph-hero:ralph-analyst` |
| RESEARCH | `Skill("ralph-hero:ralph-research", "NNN")` | `Agent(subagent_type="ralph-hero:ralph-analyst", prompt="Run /ralph-hero:ralph-research NNN")` | `ralph-hero:ralph-analyst` |
| PLAN (M/S/XS) | `Skill("ralph-hero:ralph-plan", "NNN --research-doc ...")` | `Agent(subagent_type="ralph-hero:ralph-analyst", prompt="Run /ralph-hero:ralph-plan NNN --research-doc ...")` | `ralph-hero:ralph-analyst` |
| PLAN (L/XL) | `Skill("ralph-hero:ralph-plan-epic", "NNN")` | `Agent(subagent_type="ralph-hero:ralph-analyst", prompt="Run /ralph-hero:ralph-plan-epic NNN")` | `ralph-hero:ralph-analyst` |
| REVIEW | `Skill("ralph-hero:ralph-review", "NNN --plan-doc ...")` | `Agent(subagent_type="ralph-hero:ralph-builder", prompt="Run /ralph-hero:ralph-review NNN --plan-doc ...")` | `ralph-hero:ralph-builder` |
| IMPLEMENT | `Skill("ralph-hero:ralph-impl", "NNN --plan-doc ...")` | `Agent(subagent_type="ralph-hero:ralph-builder", prompt="Run /ralph-hero:ralph-impl NNN --plan-doc ...")` | `ralph-hero:ralph-builder` |

For ralph-plan-epic internally:

| Step | Current | Proposed |
|------|---------|----------|
| Step 6 (create children) | `Skill("ralph-hero:ralph-split", "GH-NNN")` | `Agent(subagent_type="ralph-hero:ralph-analyst", prompt="Run /ralph-hero:ralph-split GH-NNN")` |
| Step 7 (wave planning) | `Skill("ralph-hero:ralph-plan", "GH-NNN --parent-plan ... --sibling-context ...")` | `Agent(subagent_type="ralph-hero:ralph-analyst", prompt="Run /ralph-hero:ralph-plan GH-NNN --parent-plan ... --sibling-context ...")` |

## What Changes vs What Stays the Same

### What changes:
- All `Skill("ralph-hero:ralph-*")` calls in hero.md become `Agent()` calls
- The "Inline Skill Invocation Notes" section in hero.md is rewritten or removed
- ralph-plan-epic's `Skill()` calls for ralph-split and ralph-plan become `Agent()` calls
- hero.md may not need `Skill` in its `allowed-tools` after this change (unless other uses exist)

### What stays the same:
- The TaskList/TaskUpdate orchestration loop — unchanged
- Artifact path passing pattern — same `--research-doc` and `--plan-doc` flags, just in prompt string
- The `context: fork` declarations in all autonomous skill SKILL.md frontmatters — already correct
- The HUMAN GATE logic — stops execution, awaits user action
- team.md — already correct, no changes needed

### Ambiguity to resolve in planning:
- Should hero retain `Skill` in its `allowed-tools` list? After conversion, there are no `Skill()` calls remaining in hero's own logic. But it also doesn't harm anything to leave it.
- Should the return-value contract change? Currently, hero likely doesn't parse `Skill()` return values for artifact paths — it uses TaskGet(metadata.artifact_path) instead. With `Agent()`, the agent's return value is the prompt response. Plan should specify that agents set TaskUpdate(metadata.artifact_path) when they complete skills, which they already do per each skill's "Team Result Reporting" step.

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/hero/SKILL.md` — convert all 6 Skill() dispatch calls to Agent(); rewrite or remove "Inline Skill Invocation Notes" section
- `plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md` — convert 2 Skill() calls (Steps 6 and 7) to Agent() calls

### Will Read (Dependencies)
- `plugin/ralph-hero/skills/ralph-research/SKILL.md` — confirmed no AskUserQuestion, context: fork
- `plugin/ralph-hero/skills/ralph-plan/SKILL.md` — confirmed no AskUserQuestion, context: fork
- `plugin/ralph-hero/skills/ralph-impl/SKILL.md` — confirmed no AskUserQuestion, context: fork
- `plugin/ralph-hero/skills/ralph-split/SKILL.md` — confirmed no AskUserQuestion, context: fork
- `plugin/ralph-hero/skills/ralph-review/SKILL.md` — AUTO mode only, no AskUserQuestion
- `plugin/ralph-hero/skills/team/SKILL.md` — reference model (already correct)
- `plugin/ralph-hero/agents/ralph-analyst.md` — subagent_type for research/plan/split
- `plugin/ralph-hero/agents/ralph-builder.md` — subagent_type for review/impl
