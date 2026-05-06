---
date: 2026-05-05
status: draft
type: plan
github_issue: 895
github_issues: [895]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/895
primary_issue: 895
tags: [agent-dispatch, code-review, finish, ralph-merge, subagent-nesting, architecture]
---

# Depth-2 Dispatch Resolution (Path B) - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-05-GH-0895-depth-2-dispatch-resolution-path]] (research — recommends Path B with standalone preservation guard)
- builds_on:: [[2026-04-26-finish-merge-code-review-nesting]] (research — primary evidence; defines the three resolution paths A/B/C)
- builds_on:: [[2026-04-25-GH-0570-pipeline-tail-skills-audit]] (research — secondary evidence; audited ralph-merge in depth)
- tensions:: [[2026-04-06-haiku-skill-to-agent-dispatch]] (plan — draft; describes the merge→Agent conversion that this plan supersedes for the merge half)
- tensions:: [[2026-04-06-auto-code-review-impl-fix-loop]] (plan — draft; describes code-review-in-merge that this plan moves up to finish)

## Overview

Single-issue plan resolving the depth-2 dispatch conflict identified in GH-895. Implements **Path B (hoist code-review out of merge)** plus the recommended decoupling of the ralph-pr conversion. The work is naturally atomic — all changes must land together because they are tightly coupled (finish must learn the new responsibility before ralph-merge can shed it; the ralph-pr conversion is independent but is grouped here because it shares the file scope and validation surface of the haiku-dispatch plan that this plan supersedes).

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-895 | Hoist code-review gate from ralph-merge into finish | XS |

## Shared Constraints

These constraints govern every task in this plan:

- **No depth-2 sub-agent dispatch.** The Claude Code runtime forbids `Agent` tool use inside a sub-agent context. All changes MUST preserve this invariant.
- **`code-review:code-review` fan-out must run at depth 0.** This skill spawns 5 parallel Sonnet reviewers + N Haiku scorers via `Agent`. Those land at depth 1 only when invoked from depth 0. Do NOT move this call into any agent context.
- **`context: fork` is unverified.** Treat the field as documentation-only. Do not rely on it to provide runtime isolation.
- **Standalone invocation must remain safe.** The queue-picking loop runner (`just merge`) must continue to work. ralph-merge must refuse to merge unreviewed PRs even when invoked outside the finish orchestrator.
- **Backwards compatibility for `RALPH_REVIEW_MODE`.** Both `auto` and `interactive` paths must continue to function. The interactive prompt (AskUserQuestion) moves with the code review gate to finish.
- **Backwards compatibility for `CODE_REVIEW_FEEDBACK` contract.** The status string is an existing contract documented in ralph-merge Step 4. After this plan, finish becomes the sole producer/consumer of the contract; ralph-merge no longer emits it.
- **Output contract preservation for callers.** ralph-hero (the team-mode orchestrator) and any standalone callers of ralph-merge must continue to recognize `MERGE BLOCKED`, `MERGE NOT READY`, and `MERGED` as merge-mechanics statuses.
- **Hooks remain in place.** The `merge-state-gate.sh` PreToolUse hook on `ralph_hero__save_issue` must continue to enforce valid output states for ralph-merge (`Done`, `Human Needed`). Do not change the hook configuration in ralph-merge or merge-agent.
- **No depth-2 issue with ralph-pr.** Confirmed by research — ralph-pr has no nested `Skill()` calls. Converting it to Agent dispatch is independently safe.

## Current State Analysis

At commit `34a8a76` (v2.5.90):

- `finish/SKILL.md` Step 4 dispatches `Skill("ralph-hero:ralph-merge", args="NNN --pr-url PR_URL")` inline. Step 4a handles `CODE_REVIEW_FEEDBACK` by dispatching impl-agent and re-running ralph-merge.
- `ralph-merge/SKILL.md` Step 4 ("Code Review Gate") branches on `RALPH_REVIEW_MODE` and either:
  - **auto mode** — dispatches `Skill("code-review:code-review", "PR_NUMBER")`, then re-checks `reviewDecision`, emitting `CODE_REVIEW_FEEDBACK` if changes are requested.
  - **interactive mode** — presents an `AskUserQuestion` choice; on "Run code review", dispatches the same code-review skill.
- `ralph-merge` carries `context: fork` + `model: haiku` in frontmatter and includes `Skill` in `allowed-tools`.
- `merge-agent.md` allowlist lacks both `Skill` and `Agent`. If finish were to dispatch merge as an Agent today, the preloaded ralph-merge instructions would silently no-op the `Skill("code-review:code-review", ...)` call inside the agent context.
- The chain depth is currently `0 → 0 → 0` (finish → ralph-merge → code-review), so code-review's parallel reviewers spawn at depth 1 — legal.
- `ralph-code-review/SKILL.md` already orchestrates code-review + impl-agent fix loops at depth 0 — establishes the pattern this plan applies to ralph-merge.
- `ralph-pr/SKILL.md` has no `Skill` in allowed-tools and makes zero nested `Skill()` calls. Converting it to `pr-agent` Agent dispatch has no depth-2 conflict.

## Desired End State

After this plan:

- **finish/SKILL.md** owns the code-review gate. Step 4 runs code review inline when needed (preserving the depth-0 invariant for code-review fan-out), handles the fix cycle via impl-agent dispatch, then dispatches `Agent(merge-agent)` for merge mechanics only.
- **ralph-merge/SKILL.md** is a leaf skill: PR readiness check, `merge-pr.sh`, worktree cleanup, state transitions, parent advancement, cross-repo unblock, completion comment. No code-review branching. `Skill` removed from `allowed-tools`. A "MERGE BLOCKED — review required" guard refuses to merge unreviewed PRs to preserve safety for standalone callers.
- **merge-agent.md** allowlist is unchanged (already lacks `Skill` — that's now correct).
- **hero/SKILL.md** PR dispatch converted from `Skill("ralph-hero:ralph-pr", ...)` to `Agent(subagent_type="ralph-hero:pr-agent", ...)` — independent half of the haiku-dispatch conversion, decoupled from merge.
- **Draft plans superseded**: the merge half of `2026-04-06-haiku-skill-to-agent-dispatch.md` and the code-review-in-merge half of `2026-04-06-auto-code-review-impl-fix-loop.md` are marked superseded by this plan; the ralph-pr half remains and is consumed by Phase 1 of this plan.

### Verification

- [ ] `grep -n 'code-review:code-review' plugin/ralph-hero/skills/ralph-merge/SKILL.md` returns zero matches
- [ ] `grep -n 'code-review:code-review' plugin/ralph-hero/skills/finish/SKILL.md` returns at least one match (the new inline call)
- [ ] `grep -n 'Skill.*ralph-pr' plugin/ralph-hero/skills/hero/SKILL.md` returns zero matches
- [ ] `grep -n 'Agent.*pr-agent' plugin/ralph-hero/skills/hero/SKILL.md` returns at least one match
- [ ] ralph-merge's `allowed-tools` does NOT include `Skill`
- [ ] ralph-merge's frontmatter `context: fork` is removed (it became misleading — the skill is now a leaf and runs in caller context as a normal Skill())
- [ ] Standalone `just merge NNN` on a PR with no review decision outputs `MERGE BLOCKED — review required` and stops
- [ ] `RALPH_REVIEW_MODE=auto` finish run on a PR with auto-review feedback dispatches impl-agent and re-runs the merge path

## What We're NOT Doing

- **NOT converting merge to Agent dispatch.** The research found no reproducible context crash; Path B achieves the architectural cleanup without the conversion. merge-agent.md remains defined for possible future use but is not wired into finish in this plan.
- **NOT modifying the official `code-review:code-review` plugin.** Path C is rejected.
- **NOT changing `ralph-code-review` skill.** It remains a parallel orchestration entry point invoked directly by the queue loop.
- **NOT changing `RALPH_AUTO_MERGE` Step 4a or any other ralph-merge step beyond the Code Review Gate (Step 4) and frontmatter.**
- **NOT touching the val-agent path or any plan/research/review skills.**
- **NOT extracting shared link-formatting fragments** (deferred per ralph-pr's existing follow-up note pointing to #840).
- **NOT changing `merge-state-gate.sh` hook behavior.**
- **NOT introducing new env vars.** `RALPH_REVIEW_MODE` retains its current semantics (auto vs interactive) at the new owner (finish).

## Implementation Approach

The plan is a single phase containing tightly-coupled, mutually-dependent edits. The phase is structured as a sequence of tasks rather than parallel sub-phases because each task creates state that the next consumes:

1. Hoist the code-review gate up to finish (additive in finish, subtractive in ralph-merge — must land together to avoid a window where neither owns the gate).
2. Strip the gate and `Skill` allowance from ralph-merge; add the standalone safety guard.
3. Convert hero's PR dispatch to pr-agent (independent of 1 and 2 but lands together to retire the draft haiku-dispatch plan in one stroke).
4. Mark the two superseded draft plans.

---

## Phase 1: Path B Resolution + ralph-pr Conversion
- **depends_on**: null

### Overview

Single phase implementing the full Path B resolution plus the independent ralph-pr conversion. Each task is mechanically scoped to a small set of files and produces verifiable artifacts.

### Tasks

#### Task 1.1: Hoist code-review gate into finish/SKILL.md
- **files**: `plugin/ralph-hero/skills/finish/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] A new step (Step 3.5 or renamed Step 4 with merge dispatch becoming Step 5) runs the code-review gate BEFORE the merge-mechanics dispatch.
  - [ ] The new step calls `gh pr view PR_NUMBER --json reviewDecision` and branches:
    - If `APPROVED` → continue to merge dispatch.
    - If `CHANGES_REQUESTED` (human reviewer) → output `FINISH BLOCKED` with reason "Human reviewer requested changes" and stop.
    - If null/empty → check `RALPH_REVIEW_MODE`:
      - `auto` → dispatch `Skill("code-review:code-review", "PR_NUMBER")` directly inline (legal: finish runs at depth 0, code-review runs at depth 0, fan-out at depth 1).
      - `interactive` (default) → present the existing AskUserQuestion choice ("Run code review" / "Merge without review"), behavior matching the prior ralph-merge Step 4 interactive branch.
  - [ ] After the auto code-review completes, re-check `reviewDecision`:
    - `APPROVED` → continue to merge dispatch.
    - `CHANGES_REQUESTED` → dispatch impl-agent in Address Mode (the existing Step 4a logic, now repurposed as the post-review fix cycle). Max 1 fix cycle. Re-run code-review once after the fix; if still `CHANGES_REQUESTED`, output `FINISH BLOCKED — code review feedback unresolved` and stop.
  - [ ] After the gate resolves, the merge dispatch step calls `Skill("ralph-hero:ralph-merge", args="NNN --pr-url PR_URL")` (unchanged) and handles `MERGED`, `MERGE BLOCKED`, `MERGE NOT READY` as before.
  - [ ] The `CODE_REVIEW_FEEDBACK` status path is removed from finish — the fix cycle is now driven from the new gate step, not from interpreting ralph-merge's output.
  - [ ] Configuration section adds `- Review mode: !` `echo ${RALPH_REVIEW_MODE:-interactive}` `` resolution line.

#### Task 1.2: Strip code-review gate from ralph-merge/SKILL.md
- **files**: `plugin/ralph-hero/skills/ralph-merge/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] The entire Step 4 ("Code Review Gate", lines ~103-211) is replaced with a smaller "Step 4: Review Decision Guard":
    - Calls `gh pr view PR_NUMBER --json reviewDecision`.
    - If `APPROVED` or null AND the issue's estimate is `XS` with zero PR comments → continue to Step 4a / Step 5 (preserves the existing XS-no-review exception in Step 4a).
    - If `null` (and not the XS exception) → output `MERGE BLOCKED` with reason "Code review required — invoke /ralph-hero:finish or /ralph-hero:ralph-code-review first" and stop.
    - If `CHANGES_REQUESTED` → output `MERGE BLOCKED` with reason "Reviewer requested changes — address feedback before merging" and stop.
  - [ ] No `Skill("code-review:code-review", ...)` call remains anywhere in ralph-merge.
  - [ ] No `AskUserQuestion` for code-review remains in ralph-merge (interactive prompt now lives in finish).
  - [ ] The output-contract table at the top of Step 4 is updated: `CODE_REVIEW_FEEDBACK` row is removed (no longer emitted by ralph-merge).
  - [ ] Step 4a (Autonomous Merge Gate, `RALPH_AUTO_MERGE=true`) is unchanged.
  - [ ] Step 5 (Check PR Readiness) and all subsequent steps are unchanged.
  - [ ] Frontmatter `allowed-tools` no longer contains `Skill` and no longer contains `AskUserQuestion`.
  - [ ] Frontmatter `context: fork` is removed (the skill now runs inline as a leaf merge-mechanics skill; `context: fork` was misleading documentation and is not enforced anyway).
  - [ ] The skill's description in frontmatter is updated to reflect the new scope (e.g., "Merge an approved pull request — handles PR readiness, merges, cleans up worktree, moves issues to Done. Code review must be run by the caller (finish or ralph-code-review).").

#### Task 1.3: Convert hero's PR dispatch from Skill to pr-agent
- **files**: `plugin/ralph-hero/skills/hero/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] The `Skill("ralph-hero:ralph-pr", args="NNN")` call is replaced with `Agent(subagent_type="ralph-hero:pr-agent", prompt="Create PR for GH-NNN. Worktree: worktrees/GH-NNN", description="PR for GH-NNN")`.
  - [ ] The Dispatch Architecture explanation block is updated to document the new pattern: PR phase always uses `Agent()` (haiku in isolated context); merge phase remains `Skill()` inline (Path B preserves code-review fan-out).
  - [ ] No other dispatch calls in hero/SKILL.md are changed.

#### Task 1.4: Mark superseded draft plans
- **files**:
  - `thoughts/shared/plans/2026-04-06-haiku-skill-to-agent-dispatch.md` (modify)
  - `thoughts/shared/plans/2026-04-06-auto-code-review-impl-fix-loop.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `2026-04-06-haiku-skill-to-agent-dispatch.md`: front-matter `status` changed from `draft` to `superseded`. A `## Superseded By` section added near the top pointing to this plan with one-paragraph explanation: ralph-pr conversion was absorbed into Phase 1 Task 1.3 of this plan; ralph-merge conversion was rejected in favor of Path B (hoist code-review out of merge instead of converting merge to Agent).
  - [ ] `2026-04-06-auto-code-review-impl-fix-loop.md`: front-matter `status` changed from `draft` to `superseded`. A `## Superseded By` section added pointing to this plan with one-paragraph explanation: the auto code-review gate moved up to finish (Task 1.1) instead of staying in ralph-merge; the impl-agent fix-cycle pattern is preserved but now keyed on the new finish-owned gate, not on ralph-merge's `CODE_REVIEW_FEEDBACK` output.
  - [ ] Both files retain all existing content below the new header — no historical content is deleted.

#### Task 1.5: Verify standalone safety + cross-skill consistency
- **files**: read-only across the repo (no file edits)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2, 1.3]
- **acceptance**:
  - [ ] `grep -rn 'code-review:code-review' plugin/ralph-hero/skills/ralph-merge/` returns zero matches.
  - [ ] `grep -rn 'code-review:code-review' plugin/ralph-hero/skills/finish/` returns at least one match.
  - [ ] `grep -rn 'Skill.*ralph-pr' plugin/ralph-hero/skills/hero/SKILL.md` returns zero matches.
  - [ ] `grep -rn 'Agent.*pr-agent' plugin/ralph-hero/skills/hero/SKILL.md` returns at least one match.
  - [ ] ralph-merge's `allowed-tools` block does not contain `Skill` (mechanical inspection of frontmatter).
  - [ ] ralph-code-review's `Skill("code-review:code-review", ...)` call is unchanged (this skill is the other depth-0 entry point — Path B does not affect it).

### Phase Success Criteria

#### Automated Verification:

- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` — no TypeScript errors (the plan only edits markdown skill bodies, but the build catches accidental syntactic drift in the broader plugin).
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` — all existing tests pass (no behavior change in tools; the plan edits skill instructions only, not MCP tool implementations).
- [ ] `grep -rn 'code-review:code-review' plugin/ralph-hero/skills/ralph-merge/` — zero matches.
- [ ] `grep -rn 'CODE_REVIEW_FEEDBACK' plugin/ralph-hero/skills/ralph-merge/` — zero matches.
- [ ] `grep -rn 'Skill.*ralph-pr' plugin/ralph-hero/skills/hero/SKILL.md` — zero matches.

#### Manual Verification:

- [ ] Read the new finish Step 4 end-to-end and confirm the auto-mode path runs code-review at depth 0 (finish is depth 0; code-review fan-out lands at depth 1 — legal).
- [ ] Read the simplified ralph-merge Step 4 and confirm a standalone `just merge NNN` on an unreviewed PR is rejected with `MERGE BLOCKED — review required`.
- [ ] Read the updated hero PR dispatch and confirm pr-agent is invoked with the worktree-aware prompt.
- [ ] Read both superseded draft plans and confirm the `Superseded By` headers correctly point to this plan and explain the substitutions.

**Creates for next phase**: N/A — single-phase plan.

---

## Integration Testing

- [ ] End-to-end flow: invoke `/ralph-hero:finish NNN` on a test issue with an open PR and `RALPH_REVIEW_MODE=auto`. Confirm finish runs code-review inline (depth 0, fan-out at depth 1), handles any feedback via impl-agent, then dispatches ralph-merge for merge mechanics.
- [ ] Standalone-merge safety: invoke `just merge NNN` on a PR with no `reviewDecision`. Confirm output is `MERGE BLOCKED` with the expected reason and that no merge is performed.
- [ ] Interactive mode: invoke `/ralph-hero:finish NNN` on a test issue with `RALPH_REVIEW_MODE=interactive` (default). Confirm the AskUserQuestion prompt now appears at the finish layer, not at the ralph-merge layer.
- [ ] PR creation under hero: invoke `/ralph-hero:hero NNN` and trace the dispatch sequence; confirm pr-agent is invoked via Agent dispatch (not Skill).

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/895
- Research: thoughts/shared/research/2026-05-05-GH-0895-depth-2-dispatch-resolution-path.md
- Prior research: thoughts/shared/research/2026-04-26-finish-merge-code-review-nesting.md
- Pipeline-tail audit: thoughts/shared/research/2026-04-25-GH-0570-pipeline-tail-skills-audit.md
- Superseded plan (ralph-pr half consumed): thoughts/shared/plans/2026-04-06-haiku-skill-to-agent-dispatch.md
- Superseded plan (gate-in-merge half rejected): thoughts/shared/plans/2026-04-06-auto-code-review-impl-fix-loop.md
- Pattern reference: plugin/ralph-hero/skills/ralph-code-review/SKILL.md (depth-0 code-review orchestration)
