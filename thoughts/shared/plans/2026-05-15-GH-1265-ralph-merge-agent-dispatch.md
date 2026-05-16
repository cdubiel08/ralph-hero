---
date: 2026-05-15
status: draft
type: plan
github_issue: 1265
github_issues: [1265]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1265
primary_issue: 1265
tags: [context-window, haiku, ralph-merge, finish, agent-dispatch, model-tier]
---

# GH-1265 Convert finish's ralph-merge call from Skill() to Agent() - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-15-GH-1265-haiku-context-compaction-integrator-agents]]
- builds_on:: [[2026-04-26-finish-merge-code-review-nesting]]
- builds_on:: [[2026-05-05-GH-0895-depth-2-dispatch-resolution-path]]
- builds_on:: [[2026-04-22-context-handoff-topology]]
- builds_on:: [[2026-04-06-haiku-skill-to-agent-dispatch]]

## Overview
1 atomic issue, single-phase implementation (with two trivial doc cleanups):

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1265 | bug: ralph-merge (haiku) triggers context compaction in 1M sessions | S |

**Why grouped**: Standalone issue, no group members.

## Shared Constraints

- **Leaf skill confirmed**: `ralph-merge/SKILL.md` no longer contains any nested `Skill()` or `Agent()` calls (verified via grep — the code-review gate was hoisted out in GH-895 Path B). Converting `finish` → `Agent(merge-agent)` is depth-2 safe.
- **Single inline callsite**: `finish/SKILL.md:260` is the only `Skill("ralph-hero:ralph-merge", ...)` call in the codebase. `hello/SKILL.md:119` already dispatches via `Agent(subagent_type="ralph-hero:merge-agent", ...)`.
- **Output string contract preserved**: ralph-merge already emits `MERGED`, `MERGE BLOCKED`, `MERGE NOT READY`, `AUTO-MERGE BLOCKED`, `Queue empty.` — finish's existing branch logic (`if output contains "MERGE BLOCKED" or "MERGE NOT READY"...`) reads the same strings whether dispatched inline or via Agent. No state-machine changes needed.
- **No tool allowlist change**: `merge-agent.md` tools list already covers the full ralph-merge execution path (`Read, Glob, Grep, Bash, AskUserQuestion, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__save_issue, ralph_hero__create_comment, ralph_hero__advance_issue, ralph_hero__list_sub_issues, ralph_hero__list_dependencies`). No frontmatter changes to merge-agent.md required for the dispatch conversion itself.
- **Hook discrimination via `$RALPH_COMMAND` unchanged**: ralph-merge's SessionStart hook runs `set-skill-env.sh RALPH_COMMAND=merge ...` whether the skill is loaded inline or by the merge-agent's preloaded skill. State-gate hooks (`merge-state-gate.sh`) continue to fire on `save_issue` PreToolUse.
- **No MCP server / TypeScript code changes**: This is a markdown-only change in three files under `plugin/ralph-hero/`. No `mcp-server/` rebuild required.

## Current State Analysis

The pipeline currently runs `finish` → `Skill("ralph-hero:ralph-merge", args="NNN --pr-url PR_URL")` at `finish/SKILL.md:260`. Because `ralph-merge/SKILL.md:5` declares `model: haiku` (200k cap), this inline Skill() call applies the haiku 200k cap to the **parent session's context window** — when the parent is an Opus 4.7 / Sonnet 4.6 session running at 1M, the runtime compacts the parent context down to 200k. This is lossy: accumulated pipeline history (research docs, plan content, code-review output) is discarded at the very last step of the pipeline.

`pr-agent` and `val-agent` are already dispatched via `Agent()` (forked, isolated 200k contexts that do not bleed back into the parent). Only `merge-agent` is still inline.

Secondary findings from research:
- `val-agent.md:4` says `model: haiku` while `ralph-val/SKILL.md:6` says `model: sonnet` — documentation inconsistency, no behavior impact (val is already forked). Worth fixing.
- `model-tier-policy.md` does not warn about context-window inheritance for inline Skill() calls — a future regression risk.
- `hero/SKILL.md:464` documents the merge phase as "Skill(ralph-merge) inline" — comment must be updated when this lands.

## Desired End State

After this plan ships:
- `finish/SKILL.md` Step 5 dispatches `merge-agent` via `Agent()`, forking ralph-merge into an isolated 200k context. The parent (Opus 4.7 / Sonnet 4.6 / 1M) is no longer compacted.
- `val-agent.md` reads `model: sonnet`, matching `ralph-val/SKILL.md:6`.
- `model-tier-policy.md` contains a section explaining context-window inheritance for inline `Skill()` calls so future authors do not reintroduce the same bug.
- `hero/SKILL.md:464` reflects the new "Agent(merge-agent) forked" topology.
- `skill-vs-agent-dispatch.md` fragment remains accurate (existing table already shows `merge-agent` mapped to `ralph-merge`).

### Verification
- [ ] No occurrence of `Skill("ralph-hero:ralph-merge"` remains in `plugin/ralph-hero/` (grep clean).
- [ ] `finish/SKILL.md` Step 5 dispatches via `Agent(subagent_type="ralph-hero:merge-agent", ...)`.
- [ ] `val-agent.md:4` reads `model: sonnet`.
- [ ] `model-tier-policy.md` contains a new section titled "Context Window and Inline Skill Calls" (or similar) referencing GH-1265.
- [ ] `hero/SKILL.md` dispatch-architecture notes describe merge phase as `Agent(merge-agent)` forked.
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` — passing (sanity check; the change is markdown-only but the suite confirms no incidental breakage).

## What We're NOT Doing

- **Not upgrading any model tier**: haiku is the correct tier for merge mechanics (gh PR checks, `gh pr merge`, worktree cleanup, state transition). Option B from the issue is rejected — the dispatch conversion alone resolves the bug.
- **Not changing `merge-agent.md` tools/frontmatter**: the agent's tool allowlist already covers ralph-merge's full execution path.
- **Not modifying `ralph-merge/SKILL.md`**: the skill itself is correct as a leaf merge-mechanics skill. The bug is in how `finish` calls it, not in the skill body.
- **Not touching `hello/SKILL.md:119`**: that path already dispatches via Agent() and is unaffected.
- **Not editing MCP server code**: no TypeScript / GraphQL changes. No `npm run build` artifact change.
- **Not updating `CLAUDE.md`**: the per-phase agent table already lists `merge-agent` correctly. The dispatch behavior change is internal to `finish/SKILL.md`.

## Implementation Approach

Single-phase markdown change. Phase 1 modifies four files:

1. `finish/SKILL.md` Step 5 — the dispatch conversion (load-bearing fix).
2. `val-agent.md` — doc-only model alignment cleanup.
3. `model-tier-policy.md` — add a context-window note to prevent regression.
4. `hero/SKILL.md` — update dispatch-architecture commentary to match new topology.

All four edits land together because (a) the dispatch conversion is the cause of the bug, and (b) the doc updates clarify why the change is correct and prevent future regressions. There is no logical decomposition into sub-phases — these are co-located documentation and dispatch changes for a single bug.

---

## Phase 1: Convert finish's ralph-merge dispatch to Agent + doc cleanups (GH-1265)
- **depends_on**: null

### Overview
Convert the inline `Skill("ralph-hero:ralph-merge", ...)` call in `finish/SKILL.md` Step 5 to `Agent(subagent_type="ralph-hero:merge-agent", ...)`. Fix the val-agent.md model doc mismatch. Add a context-window note to model-tier-policy.md. Update hero/SKILL.md dispatch commentary.

### Tasks

#### Task 1.1: Convert finish's ralph-merge dispatch from Skill() to Agent()
- **files**: `plugin/ralph-hero/skills/finish/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] Step 5 ("Merge (dispatch ralph-merge)") replaces the `Skill("ralph-hero:ralph-merge", args="NNN --pr-url PR_URL")` line at current line 260 with `Agent(subagent_type="ralph-hero:merge-agent", prompt="Merge PR for GH-NNN. PR URL: PR_URL", description="Merge GH-NNN")`.
  - [x] The surrounding prose (the paragraph describing "Dispatch ralph-merge for merge mechanics only") is updated to say "Dispatch the merge-agent (forked, isolated 200k context) for merge mechanics only" — replacing the inline-skill phrasing.
  - [x] The output-check block immediately after ("If output contains `MERGE BLOCKED`..." / "If output contains `MERGED`...") is preserved verbatim — the output-string contract is unchanged.
  - [x] No other Step 5 sub-steps are touched (Step 5's downstream Step 6 CI Watch logic stays intact).
  - [x] grep `Skill("ralph-hero:ralph-merge"` over `plugin/ralph-hero/` returns zero matches after the edit.

#### Task 1.2: Align val-agent.md model with ralph-val/SKILL.md
- **files**: `plugin/ralph-hero/agents/val-agent.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] `val-agent.md:4` reads `model: sonnet` (changed from `model: haiku`).
  - [x] No other frontmatter field or body content is changed.
  - [x] Frontmatter remains valid YAML (no trailing whitespace, indentation preserved).

#### Task 1.3: Add context-window inheritance note to model-tier-policy.md
- **files**: `plugin/ralph-hero/docs/model-tier-policy.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] A new section titled `## Context Window and Inline Skill Calls` is appended (after the existing "Why not preemptive Opus?" section).
  - [x] The section explains: (a) inline `Skill()` runs in the parent's context window, (b) `model: haiku` in a skill loaded inline applies haiku's 200k cap to the parent, (c) inline-skill-with-haiku from a 1M parent triggers compaction.
  - [x] The section recommends `Agent()` dispatch for any haiku-tier skill that may be called from a large parent context.
  - [x] Section references GH-1265 as the canonical example.

#### Task 1.4: Update hero/SKILL.md dispatch-architecture notes for merge phase
- **files**: `plugin/ralph-hero/skills/hero/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [x] The bullet at current `hero/SKILL.md:464` describing the Merge phase is updated to read approximately: `**Merge phase**: \`Agent(merge-agent)\` forked (haiku, 200k isolated context) — dispatched from \`finish\` Step 5. Forking prevents the haiku 200k cap from compacting the parent 1M session. See [GH-1265](https://github.com/cdubiel08/ralph-hero/issues/1265).`
  - [x] No other Dispatch Architecture bullets (Analyst, Implementation, PR, Validate, Finish) are modified.

### Phase Success Criteria

#### Automated Verification:
- [x] `grep -rn 'Skill("ralph-hero:ralph-merge"' plugin/ralph-hero/` — zero matches.
- [x] `grep -rn 'Agent(subagent_type="ralph-hero:merge-agent"' plugin/ralph-hero/skills/finish/SKILL.md` — at least one match.
- [x] `grep -n '^model:' plugin/ralph-hero/agents/val-agent.md` — returns `model: sonnet`.
- [x] `grep -n 'Context Window and Inline Skill Calls' plugin/ralph-hero/docs/model-tier-policy.md` — at least one match.
- [x] `cd plugin/ralph-hero/mcp-server && npm test` — all passing (sanity check; markdown-only changes should not affect the TS suite).

#### Manual Verification:
- [ ] Manual smoke: run `/ralph-hero:finish NNN` in a session > 200k tokens against a real PR; confirm Claude Code does NOT trigger context compaction during the merge step.
- [ ] Visual diff review on `finish/SKILL.md` Step 5: the dispatch line is the only meaningful behavior change; surrounding output-string-handling logic is preserved.

**Creates for next phase**: N/A — terminal phase for this issue.

---

## Integration Testing
- [ ] In an Opus 4.7 / Sonnet 4.6 1M session with > 200k tokens of accumulated context, dispatch `/ralph-hero:finish <issue>` against an issue with an approved PR; verify no compaction message appears and the merge completes via the forked merge-agent.
- [ ] Re-run via `/ralph-hero:hero` end-to-end on a small issue to confirm hero → impl → pr → finish → merge still produces a Done state with no regressions in output strings.

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-05-15-GH-1265-haiku-context-compaction-integrator-agents.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/1265
- Related (prior dispatch work): https://github.com/cdubiel08/ralph-hero/issues/895
