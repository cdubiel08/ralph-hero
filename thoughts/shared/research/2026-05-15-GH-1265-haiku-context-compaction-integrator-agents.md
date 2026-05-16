---
date: 2026-05-15
github_issue: 1265
github_url: https://github.com/cdubiel08/ralph-hero/issues/1265
status: complete
type: research
tags: [context-window, haiku, context-compaction, ralph-merge, finish, agent-dispatch, model-tier, skill-vs-agent]
---

# Research: Haiku Context Compaction in 1M Sessions (GH-1265)

## Prior Work

- builds_on:: [[2026-04-26-finish-merge-code-review-nesting]] (research — primary evidence; mapped the full `finish → ralph-merge → code-review` nesting chain and identified ralph-merge as "inline but flagged")
- builds_on:: [[2026-05-05-GH-0895-depth-2-dispatch-resolution-path]] (research — primary evidence; recommended Path B: hoist code review into finish, convert merge to Agent dispatch; Path B was shipped — code review is now inside finish)
- builds_on:: [[2026-04-22-context-handoff-topology]] (research — secondary evidence; canonical dispatch matrix; records ralph-merge as "currently inline but flagged")
- builds_on:: [[2026-04-06-haiku-skill-to-agent-dispatch]] (plan — describes the conversion that partially landed; ralph-pr conversion still pending)

## Problem Statement

When `/ralph-hero:ralph-merge` is loaded by the `finish` skill in an Opus 4.7 1M-context session, the `model: haiku` frontmatter on `ralph-merge/SKILL.md` triggers context compaction from 1M → 200k tokens. This is lossy and unexpected — the user did not switch models, but their accumulated pipeline context is silently truncated at the last step.

The bug affects `ralph-merge` directly (invoked inline via `Skill()` from `finish`). Issue #1265 also asks to audit `pr-agent` and `val-agent` for the same problem.

## Current State Analysis

### Dispatch topology at this commit

| Phase | Caller | Dispatch style | Model applied |
|-------|--------|---------------|---------------|
| finish | hero | `Skill("ralph-hero:finish")` | Caller's model (e.g., Opus 4.7 1M) |
| val | finish Step 3 | `Agent(subagent_type="ralph-hero:val-agent")` | Haiku 200k (forked — isolated) |
| code-review | finish Step 4 | `Skill("code-review:code-review")` | Caller's model (inline) |
| ralph-merge | finish Step 5 | `Skill("ralph-hero:ralph-merge", ...)` | **Haiku 200k applied to parent** ← bug |
| pr | hero | `Agent(subagent_type="ralph-hero:pr-agent")` | Haiku 200k (forked — isolated) |

The key finding: `finish/SKILL.md:260` calls `Skill("ralph-hero:ralph-merge", args="NNN --pr-url PR_URL")`. This is an **inline Skill call**, so the `model: haiku` declaration in `ralph-merge/SKILL.md:5` is applied to the **parent session's context window**, triggering compaction when the parent is running with a 1M context cap (Opus 4.7 or Sonnet 4.6).

### How pr-agent and val-agent compare

The issue body suspected all three integrator agents. Audit results:

**`pr-agent` / `ralph-pr`** — already safe.
- `hero/SKILL.md:479` dispatches via `Agent(subagent_type="ralph-hero:pr-agent", ...)` — forked, haiku applies only to the sub-agent's isolated context.
- PR creation is a leaf operation (no nested `Skill()` calls inside `ralph-pr/SKILL.md` — confirmed by `grep 'Skill(' plugin/ralph-hero/skills/ralph-pr/SKILL.md` → no output).

**`val-agent` / `ralph-val`** — already safe and already upgraded.
- `finish/SKILL.md:100` dispatches via `Agent(subagent_type="ralph-hero:val-agent", ...)` — forked.
- `ralph-val/SKILL.md:6` declares `model: sonnet` (not haiku) — the skill frontmatter was already upgraded.
- `val-agent.md:4` still says `model: haiku`, which is a documentation inconsistency but does not affect the forked dispatch path (the agent.md model overrides the skill frontmatter when running as an agent).

**`merge-agent` / `ralph-merge`** — broken.
- `finish/SKILL.md:260` dispatches via `Skill(...)` — inline. The `model: haiku` in `ralph-merge/SKILL.md:5` applies to the parent session → context compaction.
- `merge-agent.md` exists and correctly declares `model: haiku` for agent-mode dispatch, but it is **not used** by finish or hero in the current code.

### Why ralph-merge is still inline

The GH-895 research (Path B) hoisted the code-review gate out of `ralph-merge` and into `finish`. This was the correct architectural fix for the depth-2 conflict. However, the final step of Path B — converting `Skill("ralph-hero:ralph-merge")` to `Agent(subagent_type="ralph-hero:merge-agent")` in `finish` — was never landed. The code-review gate move shipped; the dispatch conversion did not.

This is confirmed by:
- `finish/SKILL.md:260`: still `Skill("ralph-hero:ralph-merge", args="NNN --pr-url PR_URL")`
- `finish/SKILL.md:257-263`: comment says "Dispatch ralph-merge for merge mechanics only" — implies leaf skill, making Agent dispatch viable
- `ralph-merge/SKILL.md`: no longer contains the `Skill("code-review:code-review", ...)` code-review gate — it was already stripped in Path B. The skill is now truly a leaf merge-mechanics skill.

**The prerequisite for Agent dispatch of ralph-merge is already satisfied.** The depth-2 conflict that previously blocked the conversion no longer exists.

### Context window facts

| Model | Context window |
|-------|---------------|
| Opus 4.7 | 1M tokens |
| Sonnet 4.6 | 1M tokens |
| Haiku 4.5 | 200k tokens (no 1M option) |

Source: platform docs, confirmed in `2026-04-26-finish-merge-code-review-nesting.md` §8.

Inline `Skill()` keeps the parent's context envelope. `model: haiku` in a skill's frontmatter overrides the model for the duration of that inline skill call — and haiku's 200k cap applies to the parent session, causing compaction when the parent holds >200k tokens.

### Depth check: is ralph-merge still a leaf skill?

`grep 'Skill(' /Users/dubiel/projects/ralph-hero/plugin/ralph-hero/skills/ralph-merge/SKILL.md` → no matches (code-review gate was removed in GH-895 Path B implementation).

`ralph-merge` is confirmed as a pure leaf skill: `Bash`, `gh pr merge`, worktree cleanup, state transition via `save_issue`, parent advancement via `advance_issue`, cross-repo unblock check, completion comment. No nested `Skill()` or `Agent()` calls. Converting to `Agent()` dispatch is depth-2 safe.

### merge-agent.md tool allowlist check

`merge-agent.md:5` tools: `Read, Glob, Grep, Bash, AskUserQuestion, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__save_issue, ralph_hero__create_comment, ralph_hero__advance_issue, ralph_hero__list_sub_issues, ralph_hero__list_dependencies`.

`Skill` is absent — correct, since ralph-merge no longer calls any nested skills. `Agent` is absent — correct for a leaf skill. The allowlist is already consistent with the leaf-skill design.

## Fix Options — Updated Analysis

The issue presents three options (A, B, C). Given that Path B (code-review gate hoisted) is already shipped, the analysis changes:

**Option A — Enforce Agent dispatch for ralph-merge in finish**
- Change `finish/SKILL.md:260` from `Skill("ralph-hero:ralph-merge", ...)` to `Agent(subagent_type="ralph-hero:merge-agent", ...)`.
- No depth-2 conflict: ralph-merge is now a leaf skill (code-review gate removed in GH-895).
- `merge-agent.md` tool allowlist is already correct.
- PR and val are already on Agent dispatch — this makes merge consistent.
- **This is the correct fix.** One line change in `finish/SKILL.md`.

**Option B — Upgrade merge-agent.md model to sonnet**
- Change `merge-agent.md:4` from `model: haiku` to `model: sonnet`.
- Merge mechanics (PR checks, `gh pr merge`, worktree cleanup, state transitions) are mechanical — haiku is genuinely the right tier. Upgrading to sonnet wastes tokens.
- Also upgrade `ralph-merge/SKILL.md:5` from `model: haiku` to `model: sonnet` for the inline path.
- Does not fix the root dispatch problem: `finish` still calls inline `Skill()`, so if ralph-merge's model matters for the session cap, we'd still need sonnet's 1M cap to avoid compaction. Sonnet has 1M, so this would technically work — but wastes capability on a mechanical task.
- **Valid as a minimal patch**, but does not fix the architectural mismatch.

**Option C — Both** (Agent dispatch + model upgrade)
- Dispatch via Agent() and upgrade to sonnet. Redundant: Agent dispatch isolates haiku's 200k cap to the sub-agent's context window, so the parent is never affected regardless of the sub-agent's model.
- **Unnecessary**: Option A alone resolves the compaction. Option B alone resolves it less cleanly.

**Recommendation: Option A only** — convert finish's ralph-merge dispatch from `Skill()` to `Agent()`. This is a one-line change that completes the Path B migration started in GH-895.

**Also recommended: Fix val-agent.md model inconsistency** — update `val-agent.md:4` from `model: haiku` to `model: sonnet` to match the already-upgraded `ralph-val/SKILL.md:6`. This is a one-line cleanup with no behavior change (val is already dispatched via Agent — the inconsistency is doc-only, but misleading).

**Also recommended: Update model-tier-policy.md** — add a note about context window inheritance for inline Skill() calls to prevent future regressions. The policy currently only discusses model tier for Agent() dispatch.

## Key Discoveries

1. **pr-agent and val-agent are not broken** — both already use `Agent()` dispatch. Only `ralph-merge` is still inline in `finish`.

2. **The prerequisite for fixing ralph-merge is already met** — GH-895 Path B removed the code-review gate from ralph-merge, eliminating the depth-2 conflict that previously prevented the Agent conversion. The fix is now a one-line change.

3. **val-agent.md has a model mismatch** — `val-agent.md:4` says `model: haiku` but `ralph-val/SKILL.md:6` says `model: sonnet`. No behavior impact (val is forked), but the mismatch is misleading.

4. **ralph-merge/SKILL.md has `context: fork` documentation** but no such field is enforced by ralph-hero code or verified to be enforced by the Claude Code runtime for Skill()-tool invocations (per GH-895 investigation). The `context: fork` annotation on ralph-merge is moot — dispatch style is determined by the caller (finish).

5. **hello/SKILL.md:119** dispatches merge-agent via `Agent()` for the "open PR ready to merge" fast-path. This path is already correct and unaffected by this bug.

6. **model-tier-policy.md** does not mention context window inheritance for inline Skill() calls — the policy document needs a note to prevent future developers from adding `model: haiku` to inline skills without understanding the compaction risk.

## Risks

- **Risk: merge-agent + Agent() creates depth isolation** — after the fix, ralph-merge runs in a fresh 200k haiku context window. Any merge failure that previously benefited from the parent's context (e.g., CLAUDE.md content loaded into the parent session) will no longer have that context. This is acceptable: ralph-merge only reads files, runs `gh` commands, and calls MCP tools — it does not need the pipeline history.

- **Risk: hook discrimination** — hooks that discriminate by `$RALPH_COMMAND` (set via `set-skill-env.sh` in SessionStart) will still fire correctly when ralph-merge runs as a sub-agent (the merge-agent SessionStart hook fires `set-skill-env.sh RALPH_COMMAND=merge`). No hook changes needed.

- **Low risk: merge-state-gate.sh** — this hook fires on `save_issue` and `advance_issue` PreToolUse in `finish/SKILL.md`. After converting ralph-merge to Agent dispatch, the hook in finish's frontmatter still covers finish's own `save_issue` calls. The merge-agent has its own session hooks via `ralph-merge/SKILL.md` SessionStart. No regression expected.

## Recommended Next Steps

1. **`finish/SKILL.md:260`** — change `Skill("ralph-hero:ralph-merge", args="NNN --pr-url PR_URL")` to `Agent(subagent_type="ralph-hero:merge-agent", prompt="Merge PR for GH-NNN. PR URL: PR_URL", description="Merge GH-NNN")`. Update the output-checking logic in Step 5 (MERGED / MERGE BLOCKED / MERGE NOT READY) to read from the agent's output string rather than inline skill output — these are the same strings, so the check logic is unchanged.

2. **`agents/val-agent.md:4`** — change `model: haiku` to `model: sonnet` to match `ralph-val/SKILL.md:6`.

3. **`plugin/ralph-hero/docs/model-tier-policy.md`** — add a section "Context Window and Inline Skill Calls" documenting that `Skill()` dispatch is inline and inherits the parent's context cap; `model: haiku` in a skill loaded inline from a 1M session will trigger compaction. Recommend using `Agent()` dispatch for any haiku-tier skill called from a potentially large context.

4. **`hero/SKILL.md:464`** — update the dispatch notes to remove the "Merge phase: Skill(ralph-merge) inline" comment and replace with "Merge phase: Agent(merge-agent) forked (haiku, 200k isolated)".

5. **`skills/shared/fragments/skill-vs-agent-dispatch.md`** — verify the dispatch table remains accurate after the change.

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/finish/SKILL.md` - Change Skill() to Agent() for ralph-merge dispatch in Step 5
- `plugin/ralph-hero/agents/val-agent.md` - Fix model mismatch: haiku → sonnet
- `plugin/ralph-hero/docs/model-tier-policy.md` - Add context window / inline Skill() section
- `plugin/ralph-hero/skills/hero/SKILL.md` - Update dispatch notes for merge phase (line 464)

### Will Read (Dependencies)
- `plugin/ralph-hero/skills/ralph-merge/SKILL.md` - Confirm leaf-skill status (no nested Skill/Agent calls)
- `plugin/ralph-hero/agents/merge-agent.md` - Confirm tool allowlist is correct for Agent dispatch
- `plugin/ralph-hero/hooks/scripts/merge-state-gate.sh` - Confirm hook behavior after dispatch change
- `plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md` - Dispatch table to verify after change
