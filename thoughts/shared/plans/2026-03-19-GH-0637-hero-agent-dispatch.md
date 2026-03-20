---
date: 2026-03-19
status: draft
type: plan
github_issue: 637
tags: [hero, skills, agent-dispatch, context-isolation]
---

# GH-637: Hero Skill Dispatches Autonomous Skills via Agent() Instead of Skill()

## Prior Work

- builds_on:: [[2026-03-19-GH-0637-hero-dispatch-model]]

## Problem

`plugin/ralph-hero/skills/hero/SKILL.md` dispatches all sub-skills (split, research, plan, review, impl) via `Skill()`, which runs inline in hero's context window. This causes context window bloat, prevents true parallelism, and contradicts the `context: fork` declarations in all autonomous skill frontmatters. The original rationale (hero lacked MCP tool access) was removed in a prior PR — the "Inline Skill Invocation Notes" section documenting that trade-off is now stale.

`plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md` has internal `Skill()` calls (Steps 6 and 7), but these are correct — ralph-plan-epic runs inside a `ralph-analyst` agent which doesn't have `Agent` in its allowed-tools, so sub-dispatches must remain `Skill()` (inline within the agent's fresh context).

## Estimate: S

Single phase, 3 tasks. Changes are targeted find-and-replace plus a section rewrite in hero.md only. No logic changes to the orchestration loop. ralph-plan-epic.md is NOT changed — its internal `Skill()` calls are correct since it runs inside an agent that lacks `Agent` in allowed-tools.

## Dispatchability Self-Check

This plan is authored by ralph-analyst (triage/planning agent). The implementing agent is ralph-builder. The plan contains file edits only — no MCP server changes, no test changes, no TypeScript. Fully dispatchable.

## Phase 1: Convert Skill() to Agent() in hero and ralph-plan-epic

### Task 1: Update hero.md — Replace all 6 Skill() dispatch calls with Agent()

**File**: `plugin/ralph-hero/skills/hero/SKILL.md`

**Location**: "Phase-specific execution details" section inside Step 3 (Execution Loop), lines 231–345.

Replace each `Skill()` call with the corresponding `Agent()` call per the table below. Preserve all surrounding prose and comments exactly.

| Phase | Old call | New call |
|-------|----------|----------|
| SPLIT | `Skill("ralph-hero:ralph-split", "NNN")` | `Agent(subagent_type="ralph-hero:ralph-analyst", prompt="Run /ralph-hero:ralph-split NNN", description="Split GH-NNN")` |
| RESEARCH | `Skill("ralph-hero:ralph-research", "NNN")` | `Agent(subagent_type="ralph-hero:ralph-analyst", prompt="Run /ralph-hero:ralph-research NNN", description="Research GH-NNN")` |
| PLAN (L/XL) | `Skill("ralph-hero:ralph-plan-epic", "NNN")` | `Agent(subagent_type="ralph-hero:ralph-analyst", prompt="Run /ralph-hero:ralph-plan-epic NNN", description="Plan epic GH-NNN")` |
| PLAN (M/S/XS with research doc) | `Skill("ralph-hero:ralph-plan", "NNN --research-doc thoughts/shared/research/...")` | `Agent(subagent_type="ralph-hero:ralph-analyst", prompt="Run /ralph-hero:ralph-plan NNN --research-doc thoughts/shared/research/...", description="Plan GH-NNN")` |
| PLAN (M/S/XS without) | `Skill("ralph-hero:ralph-plan", "NNN")` | `Agent(subagent_type="ralph-hero:ralph-analyst", prompt="Run /ralph-hero:ralph-plan NNN", description="Plan GH-NNN")` |
| PLAN (multi-issue group) | `Skill("ralph-hero:ralph-plan", "[PRIMARY] --research-doc {path}")` | `Agent(subagent_type="ralph-hero:ralph-analyst", prompt="Run /ralph-hero:ralph-plan [PRIMARY] --research-doc {path}", description="Plan GH-[PRIMARY]")` |
| REVIEW | `Skill("ralph-hero:ralph-review", "NNN --plan-doc thoughts/shared/plans/...")` | `Agent(subagent_type="ralph-hero:ralph-builder", prompt="Run /ralph-hero:ralph-review NNN --plan-doc thoughts/shared/plans/...", description="Review GH-NNN")` |
| IMPLEMENT (with plan doc) | `Skill("ralph-hero:ralph-impl", "NNN --plan-doc thoughts/shared/plans/...")` | `Agent(subagent_type="ralph-hero:ralph-builder", prompt="Run /ralph-hero:ralph-impl NNN --plan-doc thoughts/shared/plans/...", description="Implement GH-NNN")` |
| IMPLEMENT (without) | `Skill("ralph-hero:ralph-impl", "NNN")` | `Agent(subagent_type="ralph-hero:ralph-builder", prompt="Run /ralph-hero:ralph-impl NNN", description="Implement GH-NNN")` |

**Note on artifact path substitution**: The `--research-doc` and `--plan-doc` paths are runtime values (retrieved from `TaskGet(metadata.artifact_path)` before dispatch). The conversion preserves this pattern — the path is embedded in the `prompt` string exactly as it was embedded as a `Skill()` argument. The implementing agent reads `TaskGet` and interpolates into the `Agent()` prompt string.

**Acceptance criteria**:
- Zero `Skill("ralph-hero:ralph-split"`, `Skill("ralph-hero:ralph-research"`, `Skill("ralph-hero:ralph-plan"`, `Skill("ralph-hero:ralph-plan-epic"`, `Skill("ralph-hero:ralph-review"`, `Skill("ralph-hero:ralph-impl"` strings remain in hero/SKILL.md
- All replacements use the exact `subagent_type` values shown above

### Task 2: Rewrite "Inline Skill Invocation Notes" section in hero.md

**File**: `plugin/ralph-hero/skills/hero/SKILL.md`

**Location**: Lines 347–354 (the `### Inline Skill Invocation Notes` section).

Replace the existing section with:

```markdown
### Agent Dispatch Notes

Autonomous skills run via `Agent()` for context isolation — each gets a fresh context window:
- The `prompt` must include the full slash command and all arguments (e.g., `"Run /ralph-hero:ralph-plan NNN --research-doc ..."`)
- Agent results are not directly visible to the user — hero must relay key outcomes (plan path, review verdict, error messages) from task metadata
- Agents report artifacts via `TaskUpdate(metadata.artifact_path=...)` — hero reads these via `TaskGet` before spawning downstream agents
- `Skill()` is reserved for interactive skills invoked directly by the user (e.g., `/hello`, `/plan`, `/impl` in conversational mode) — hero does NOT use `Skill()` for pipeline phases
```

**Acceptance criteria**:
- The old "Inline Skill Invocation Notes" section heading and all 4 bullet points are removed
- The new "Agent Dispatch Notes" section is in its place with the 4 bullets above
- The sentence "If any implementation fails, STOP immediately. Do NOT continue to next issue." that follows the old section (currently line 354) is preserved immediately after the new section

### Task 3: Verify — Audit remaining Skill() usage in hero.md

After Tasks 1–2, search `plugin/ralph-hero/skills/hero/SKILL.md` for any remaining `Skill(` occurrences.

**Expected result**: No `Skill(` calls should remain. The only `Skill` occurrence should be in the `allowed-tools:` list (`- Skill`) — which can be left as-is since removing it would change the allowed-tools contract. Hero may delegate to interactive skills in future use cases, so retaining `Skill` in `allowed-tools` is harmless.

**Acceptance criteria**:
- `grep -n 'Skill(' plugin/ralph-hero/skills/hero/SKILL.md` returns zero results

## Phase 1 Completion Criteria

1. All `Skill()` dispatch calls in `hero/SKILL.md` replaced with `Agent()` calls
2. "Inline Skill Invocation Notes" section replaced with "Agent Dispatch Notes"
3. Changes committed to main with message: `feat(skills): GH-637 convert hero skill dispatch from Skill() to Agent()`

## What Does NOT Change

- The TaskList/TaskUpdate orchestration loop in hero.md — unchanged
- Artifact path passing (`--research-doc`, `--plan-doc` flags) — same flags, just embedded in `Agent()` prompt string
- The `context: fork` declarations in autonomous skill frontmatters — already correct
- The HUMAN GATE logic in hero.md — unchanged
- The `allowed-tools` list in hero/SKILL.md — `Skill` entry stays (future interactive use, no harm)
- team.md — already uses Agent() correctly, no changes needed
- ralph-plan-epic.md — its internal `Skill()` calls are correct; it runs inside an agent (ralph-analyst) which doesn't have `Agent` in allowed-tools, so internal sub-dispatches must remain `Skill()` (they run inline within the agent's context, which is fine since the agent has a fresh context window)
