---
date: 2026-05-05
github_issue: 895
github_url: https://github.com/cdubiel08/ralph-hero/issues/895
status: complete
type: research
tags: [agent-dispatch, code-review, finish, ralph-merge, subagent-nesting, skill-vs-agent, architecture, ralph-code-review]
---

# Research: Depth-2 Dispatch Conflict Resolution Path

## Prior Work

- builds_on:: [[2026-04-26-finish-merge-code-review-nesting]] (research — primary evidence; defines the three resolution paths A/B/C and the four open questions)
- builds_on:: [[2026-04-25-GH-0570-pipeline-tail-skills-audit]] (research — secondary evidence; audited ralph-merge, ralph-pr, ralph-val in depth; identified advance_issue/advance_parent claims that need correction)
- builds_on:: [[2026-04-06-auto-code-review-impl-fix-loop]] (plan — draft; describes the merge→Agent conversion that triggers the conflict; status: still draft, not landed)
- builds_on:: [[2026-04-06-haiku-skill-to-agent-dispatch]] (plan — draft; proposes converting ralph-pr and ralph-merge to Agent dispatch; status: still draft, not landed)
- builds_on:: [[2026-04-04-GH-0732-hero-skill-dispatch-migration]] (plan — describes empirical confirmation of subagent nesting forbidden on 2026-04-04)

## Problem Statement

Issue #895 asks: before shipping the merge→Agent conversion (proposed in draft plans `auto-code-review-impl-fix-loop` and `haiku-skill-to-agent-dispatch`), pick one of three resolution paths (A: keep merge inline, B: hoist code review out of merge, C: sequentialize code review) and document the choice. Four pre-decision investigation items were listed in the triage comment. This research resolves those items and recommends a path.

## Current State Analysis

At the time of this research (v2.5.90, commit after `34a8a76`), the draft plans have **not landed**. The `finish → ralph-merge → code-review` chain is still fully inline at depth 0. Everything verified in the prior research doc (`2026-04-26`) remains accurate:

- `finish/SKILL.md`: dispatches `Skill("ralph-hero:ralph-merge", args="NNN --pr-url PR_URL")` at Step 4
- `ralph-merge/SKILL.md`: dispatches `Skill("code-review:code-review", "PR_NUMBER")` at Step 4 (auto-mode) and interactively
- Chain depth is 0 → 0 → 0, so code-review's Agent fan-out fires at depth 1 — legal

### New Development: `ralph-code-review` skill added

Since the prior research doc, a new first-party skill was added: `plugin/ralph-hero/skills/ralph-code-review/SKILL.md` (introduced in commit `1effc881`, `feat(skills): add ralph-code-review skill + agent + state machine entries`). This skill runs the `code-review:code-review` plugin AND dispatches `impl-agent` in Address Mode:

```
Step 4: Skill("code-review:code-review", "PR_NUMBER")
Step 5: Agent(subagent_type="ralph-hero:impl-agent", prompt="Address PR review feedback...")
```

This skill has `context: fork`, `model: sonnet`, and `Agent` in its allowed-tools. It is a **standalone skill designed to run from depth 0** — the queue-picking loop invokes it directly. It does NOT go through ralph-merge. This is architecturally relevant: the team has already built the "code review orchestration separate from merge mechanics" pattern as a standalone skill.

## Key Discoveries

### Investigation 1: Reproduce the "haiku-in-Opus-envelope context crash"

The `2026-04-06-haiku-skill-to-agent-dispatch` plan asserts ralph-pr and ralph-merge crash when invoked as `Skill()` in hero's Opus context. Reading the plan in full:

> "haiku phases (pr, merge, val) crash when invoked as `Skill("ralph-hero:ralph-pr")`, the skill content loads into the current context window — then the haiku model tries to execute within a context that was built for 1M tokens, causing context crashes."

However, the plan does not provide:
- A log excerpt or error message
- The specific version of Claude Code where this occurred
- A reproduction step or test scenario

Cross-referencing with the current skill inventory:

- `hero/SKILL.md` dispatches ralph-pr as `Skill("ralph-hero:ralph-pr", args="NNN")` (line 440) — this is still the current code
- `hero/SKILL.md` dispatches finish as `Skill("ralph-hero:finish", args="NNN")` (line 459) — still current
- finish dispatches ralph-merge as `Skill("ralph-hero:ralph-merge", ...)` — still current
- val is dispatched via `Agent()` (val-agent) — already converted, not inline

The crash claim is unverified and has not been reproduced since the plan was written in April 2026. Given that:
1. The plan was written as a "draft" and has not landed
2. The current hero dispatches ralph-pr and ralph-merge via Skill() without documented failure
3. No issues or comments on #895 or related issues report observed crashes

**Verdict**: The context crash claim is unverified. Path A (keep merge inline) cannot be dismissed on this basis alone. However, the haiku-in-Opus-envelope concern is still architecturally valid — inline Skill() execution preserves the parent's model for the turn, and executing haiku-oriented instructions in an Opus 1M context is at minimum wasteful even if it does not crash.

### Investigation 2: `context: fork` fix status (GitHub issue #17283)

The prior research doc noted that `context: fork` in skill frontmatter was documented in v2.1.101 but had not been empirically verified for Skill()-tool invocations (as opposed to slash command invocations).

Current state in ralph-hero code:
- Zero code reads or enforces the `context:` field in the MCP server, hooks, or CLI scripts
- ralph-merge has `context: fork` (documentation-only intent)
- ralph-val has `context: fork` (documentation-only intent)
- ralph-code-review has `context: fork` (documentation-only intent)

No new empirical data is available in the codebase. The `context: fork` field remains unverified at the platform level for Skill()-tool invocations. **Path D (fork-via-context-annotation) remains unproven and cannot be relied upon.**

### Investigation 3: ralph-pr and the same trap

Auditing ralph-pr for nested Skill() calls that would lose fan-out under an Agent dispatch:

```bash
grep -n 'Skill(' plugin/ralph-hero/skills/ralph-pr/SKILL.md
# → No output
```

**ralph-pr does NOT call any other skill internally.** Its allowed-tools list does not include `Skill` (confirmed in the current frontmatter). ralph-pr is a leaf skill — it creates a PR via `gh pr create`, updates issue state, and posts a comment. It does not invoke any fan-out or sub-skill.

**Verdict**: Converting ralph-pr to `Agent()` dispatch via `pr-agent` has **no depth-2 conflict**. The `haiku-skill-to-agent-dispatch` plan's ralph-pr conversion is safe to ship independently of the ralph-merge decision. The two conversions should be decoupled.

### Investigation 4: merge-agent allowlist gap (confirmed, updated)

The prior research doc identified that `agents/merge-agent.md` was missing `Skill` from its tool allowlist. At commit `34a8a76` (v2.5.90), the current merge-agent.md tools line is:

```
tools: Read, Glob, Grep, Bash, AskUserQuestion, mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue, mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues, mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue, mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment, mcp__plugin_ralph-hero_ralph-github__ralph_hero__advance_issue, mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues, mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_dependencies
```

`Skill` is **absent**. `Agent` is also absent.

**Correction from pipeline-tail-skills audit**: The 2026-04-25 audit claimed `advance_issue` was a stale/dead reference. This is incorrect — `ralph_hero__advance_issue` IS a live MCP tool implemented in `relationship-tools.ts` (line 627-816). It was not removed; the audit confused it with a hypothetical `advance_parent` method. The `advance_issue` tool with `direction: "parent"` is the parent-advancement API. The merge-agent tool allowlist correctly includes it.

The gap remains: if the haiku-skill-to-agent-dispatch conversion ships and finish dispatches `Agent(merge-agent)`, the preloaded ralph-merge skill's `Skill("code-review:code-review", ...)` instruction will be silently no-op'd by the hard allowlist. This is a pre-existing unresolved gap that becomes a runtime failure mode if the conversion ships.

### New Finding: `ralph-code-review` skill creates a second depth-2 scenario

The ralph-code-review skill (Step 5) dispatches `impl-agent` via `Agent()`. If ralph-code-review is ever invoked from a sub-agent context, impl-agent's dispatch would hit depth 2. Tracing the current call sites:

- The loop runner invokes `ralph-code-review` directly from depth 0 (legal — impl-agent lands at depth 1)
- ralph-merge's Step 4 invokes `Skill("code-review:code-review", "PR_NUMBER")` — this is the **official code-review plugin**, not ralph-code-review
- There is no current call site that invokes `ralph-code-review` from inside a sub-agent

However, if the merge-to-Agent conversion ships AND merge-agent were to call ralph-code-review (rather than code-review:code-review), depth-2 dispatch would occur. The current design correctly separates:
- `ralph-merge`: calls the lightweight official `code-review:code-review` plugin (which fans out to parallel agents) — requires depth 0 to be legal
- `ralph-code-review`: orchestrates multi-round code-review + impl-agent fix loops — designed for depth-0 direct invocation

This separation must be preserved under any resolution path.

## Resolution Path Analysis

### Path A: Keep merge inline (abandon Agent conversion for merge)

**Key question answered**: Is the context crash reproducible? **Unknown — unverified claim.** But the conversion is not currently necessary for correctness, and keeping merge inline is the safe choice for code-review fan-out.

**Pros**:
- No code changes needed — the chain works today
- Preserves code-review's parallel-agent fan-out at depth 1
- Decouples the decision from the (possibly) unnecessary context crash fix

**Cons**:
- If the context crash is real, it will surface in production (haiku model in Opus context)
- Does not improve context isolation for the merge phase
- Leaves the `context: fork` annotation in ralph-merge as misleading documentation

**Verdict**: Valid as a "stop the bleeding" choice but defers the underlying context-efficiency concern.

### Path B: Hoist code review out of merge (run code-review in finish before dispatching merge-agent)

This path would restructure the finish skill to:
1. Run `Skill("code-review:code-review", "PR_NUMBER")` inline in finish (at depth 0 — code-review fan-out at depth 1, legal)
2. Dispatch `Agent(merge-agent)` for merge mechanics only (at depth 1 — no sub-skills needed)
3. merge-agent's allowlist gap is addressed by removing the code-review gate from ralph-merge

**Pros**:
- Enables the Agent conversion for merge (clean haiku envelope)
- Preserves code-review's parallel fan-out (runs at depth 0 in finish)
- `CODE_REVIEW_FEEDBACK` contract moves up to finish (already a stronger orchestrator context)
- ralph-merge becomes a simpler leaf skill (merge mechanics only, no code-review branching)

**Cons**:
- Requires coordinated changes to both finish and ralph-merge
- The `CODE_REVIEW_FEEDBACK` / fix-cycle logic (currently in finish Step 4a) needs to be reconsidered in the new flow
- ralph-merge standalone invocability (e.g., the queue-picking loop calling `just merge`) loses the code-review gate unless it is preserved conditionally
- Behavioral change: previously ralph-merge could be invoked standalone and would run code review; under Path B it would not

**Verdict**: Architecturally cleanest for team-mode pipelines. Creates a risk for standalone invocations.

### Path C: Sequentialize code-review

Replace code-review:code-review's parallel Agent fan-out with sequential review steps. This would require either:
- Modifying the official Anthropic code-review plugin (not feasible — third-party)
- Building a custom sequential review skill

**Verdict**: Not viable. Cannot modify the official plugin, and building a sequential replacement degrades review quality with significant effort.

## Recommendation: Path B with a standalone preservation guard

**Recommended resolution: Path B** — hoist the code-review gate from ralph-merge into finish, then convert merge to Agent dispatch.

**Specific implementation**:

1. **finish/SKILL.md**: Restructure Step 4 to run code review inline before dispatching merge-agent:
   - Move the code-review gate (currently ralph-merge Step 4) into finish
   - If `RALPH_REVIEW_MODE=auto` AND no existing review decision: run `Skill("code-review:code-review", "PR_NUMBER")` from finish's inline context
   - If code review flags issues: dispatch impl-agent (Step 4a already exists), then re-run code review
   - Once approved (or interactive mode passes): dispatch `Agent(subagent_type="ralph-hero:merge-agent", prompt="Merge PR #PR_NUMBER for issue #NNN")`

2. **ralph-merge/SKILL.md**: Strip the code-review gate entirely. ralph-merge becomes a pure merge-mechanics skill:
   - Remove Step 4 (code review gate) from ralph-merge
   - Keep: PR readiness check, gh pr merge, worktree cleanup, state transition, parent advancement, cross-repo unblock
   - Add a guard at the top: "If no approved review decision exists, output MERGE BLOCKED (code review must be run by the orchestrating caller) and stop." This preserves safety for standalone invocations.

3. **merge-agent.md**: No Skill or Agent needed in the tool allowlist (merge becomes a leaf skill).

4. **Decouple ralph-pr conversion**: Ship the ralph-pr → pr-agent conversion separately. It has no depth-2 conflict and is independently safe.

5. **Update draft plans**: Mark `2026-04-06-haiku-skill-to-agent-dispatch` as partially superseded — the ralph-pr section is still valid, the ralph-merge section is superseded by Path B.

**Why Path B over Path A**:
- Path A defers an unverified but architecturally plausible concern (haiku in Opus envelope)
- Path B achieves the architecture the draft plans intended while actually fixing the depth-2 conflict
- The `ralph-code-review` skill already demonstrates that "code review orchestration belongs in the orchestrating layer, not inside a leaf merge skill" — Path B makes ralph-merge consistent with this pattern
- finish already orchestrates val, fix-cycle, and CI watch; adding code-review orchestration is consistent with its role

**Why not Path A**:
- Leaves a misleading `context: fork` annotation on ralph-merge (implies isolation that doesn't happen)
- Does not improve architecture — delays the haiku context issue
- The existing `ralph-code-review` skill shows the team already moved toward "code review as a separate orchestration concern"

## Pipeline History

Knowledge graph unavailable for `plugin/ralph-hero/skills/finish` — no outcome events recorded for this component area.

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/finish/SKILL.md` - Move code-review gate from ralph-merge into finish Step 4; restructure to dispatch merge-agent via Agent() after review is resolved
- `plugin/ralph-hero/skills/ralph-merge/SKILL.md` - Remove code-review gate (Step 4); add MERGE BLOCKED guard for unapproved PRs; remove Skill from allowed-tools
- `thoughts/shared/plans/2026-04-06-haiku-skill-to-agent-dispatch.md` - Mark ralph-merge section as superseded by Path B; ralph-pr section remains valid
- `thoughts/shared/plans/2026-04-06-auto-code-review-impl-fix-loop.md` - Update to reflect that code-review gate moves to finish (already partially described there)

### Will Read (Dependencies)
- `plugin/ralph-hero/agents/merge-agent.md` - Confirm allowlist is correct after ralph-merge becomes a leaf skill
- `plugin/ralph-hero/agents/pr-agent.md` - Confirm for independent ralph-pr conversion
- `plugin/ralph-hero/skills/ralph-code-review/SKILL.md` - Understand standalone code-review orchestration pattern (Path B aligns with this)
- `plugin/ralph-hero/skills/ralph-pr/SKILL.md` - Confirm no depth-2 issue (verified: safe for Agent conversion)
- `plugin/ralph-hero/hooks/scripts/merge-state-gate.sh` - Hook behavior after ralph-merge simplification
