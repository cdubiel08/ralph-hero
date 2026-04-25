---
date: 2026-04-25
github_issue: 570
github_url: https://github.com/cdubiel08/ralph-hero/issues/570
status: complete
type: research
tags: [skill-audit, ralph-val, ralph-pr, ralph-merge, pipeline, code-review]
---

# Audit: ralph-val, ralph-pr, ralph-merge — Pipeline Tail Skills

## Prior Work

- builds_on:: [[2026-04-25-GH-0566-skill-audit-phase2]]
- tensions:: None identified.

## Problem Statement

The pipeline tail trio (ralph-val, ralph-pr, ralph-merge) are tightly coupled skills that handle the final stages of the autonomous implementation pipeline: validation, PR creation, and merge gating. Phase 1 fixed systemic MCP tool issues. Phase 2 requires a deep content and mechanics audit: structure quality, cross-skill consistency, validation criteria accuracy, interactive merge gate behavior, code review hook integration, and trigger description quality.

## Current State Analysis

### ralph-val

**File**: `plugin/ralph-hero/skills/ralph-val/SKILL.md`

**Frontmatter profile:**
- `user-invocable: false` — correct; called by orchestrators only
- `context: fork` — correct; runs in isolated session
- `model: sonnet` — appropriate for validation reasoning
- `hooks`: SessionStart sets `RALPH_COMMAND=val RALPH_REQUIRES_PLAN=true`; Stop runs `val-postcondition.sh`
- `allowed-tools`: Read, Glob, Grep, Bash, Task, get_issue, create_comment — notably **no Write** (correct, val is read-only)

**Structure quality:**
The skill has 8 clearly numbered steps. Steps 6.5 (Drift Log Verification) and 6.6 (Cross-Phase Integration Check) are decimal-numbered sub-steps inserted mid-sequence, which creates ambiguity about whether they are required or optional. No explicit "skip if" guard on step 6.5 for single-phase plans (step 6.6 has one). Step 6.5 instructs parsing `## Drift Log — Phase N` headers from issue comments but the exact search string format is underspecified (both `- DRIFT:` and `DRIFT:` prefix mentioned without priority order).

**Validation criteria:**
Step 5 extracts criteria from the plan's "Desired End State" section AND per-phase "Success Criteria > Automated Verification" checkboxes. The pattern matching for checkbox lines is well-specified with concrete examples (test -f, test -x, grep, npm test). However, there is no explicit instruction on what to do if `Automated Verification` is absent from a phase — the skill would silently skip that phase's checks.

**Verdict classification:**
The PASS/FIX/FAIL trichotomy is clearly defined. Mechanical vs. substantive failure classification includes good concrete examples. The `FIX` verdict with auto-fix command output is a useful pattern not shared downstream — the caller (ralph-finish or ralph-hero) must handle `FIX` routing, but there is no documentation in ralph-val about expected callers.

**Postcondition hook:**
`val-postcondition.sh` is minimal: it checks `stop_hook_active` (to avoid infinite loop) and then emits a reminder to produce a VALIDATION PASS or FAIL verdict. This is a soft reminder (exit 2 = block stop), which is correct. The check does NOT verify that the GitHub comment was actually posted — behavioral completeness is LLM-trust-based.

**Description triggering quality:**
`"Validate that implementation satisfies plan requirements. Reads the plan, checks code in worktree, runs automated verification. Use when you want to validate an implementation before PR creation."`

This is accurate and sufficiently detailed. The "Use when" clause is helpful for orchestrators. No significant gaps.

**Anti-patterns / gaps:**
- No explicit failure path if worktree branch is stale (no git pull instruction)
- Step 6.5 drift log checks require `git log | grep "DRIFT:"` but the skill doesn't specify which worktree's log to query (implied but not stated)
- The `Task` tool is in allowed-tools but never referenced in the skill body — unclear if it's used for parallel sub-checks or vestigial

---

### ralph-pr

**File**: `plugin/ralph-hero/skills/ralph-pr/SKILL.md`

**Frontmatter profile:**
- `user-invocable: false` — correct
- `context: fork` — correct
- `model: haiku` — appropriate; PR creation is mechanical/low-reasoning
- `hooks`: SessionStart sets `RALPH_COMMAND=pr RALPH_VALID_OUTPUT_STATES='In Review,Human Needed'`; PreToolUse hooks `ralph_hero__save_issue|ralph_hero__advance_issue` against `pr-state-gate.sh`
- `allowed-tools`: Read, Glob, Bash, get_issue, list_sub_issues, advance_issue, save_issue, create_comment

**Critical finding — stale tool reference:**
The frontmatter lists `mcp__plugin_ralph-hero_ralph-github__ralph_hero__advance_issue` in allowed-tools and the PreToolUse hook matcher includes `ralph_hero__advance_issue`. However, the save_issue MCP tool documentation shows no `advance_issue` method — the ralph-save_issue tool handles all state transitions via `workflowState` semantic intents. This is a **stale/dead reference** from a prior API version. The hook matcher would never fire for advance_issue because that tool does not exist in the current MCP server. Step 6 says "Advance all children... For a standalone issue: update the workflow state" using `command: "ralph_pr"` — this would call `save_issue`, which IS in the allowed tools. But the hook would not fire correctly since the matcher includes `advance_issue` which doesn't exist.

**PR body template:**
Step 5 shows a minimal PR body:
```
## Summary
[Brief description from issue]

Closes #NNN
```
This is sparse. No mention of: linked plan document, phase count, test status, or worktree location. The body template lacks a "## Test plan" section that is common in GitHub workflows. For group issues, `Closes #NNN` for each sub-issue is mentioned but there's no guidance on ordering or linking to the plan document.

**Multi-repo PR detection (Step 3a):**
Well-specified with concrete bash pseudocode. The cross-reference editing step ("After creating all PRs, edit each PR body to include links to the other PRs") relies on LLM judgment for merge order determination — this could produce inconsistent results.

**State gate:**
`pr-state-gate.sh` reads `RALPH_VALID_OUTPUT_STATES` (set by SessionStart to `'In Review,Human Needed'`). The `get_field` call tries both `.tool_input.workflowState` and `.tool_input.targetState` — the second is legacy. If the field is absent, the call passes through (correct for non-state-transition calls). The gate is correct but only fires on `save_issue` or `advance_issue` — since `advance_issue` doesn't exist, the gate effectively only covers `save_issue`.

**Description triggering quality:**
`"Create a pull request for a completed implementation — pushes branch, creates PR via gh, moves issues to In Review. Use when you want to create a PR for a completed issue."`

Accurate. The "Use when" clause is consistent with ralph-val's pattern. Slightly redundant ("create a pull request" / "create a PR"). No significant gaps.

**Anti-patterns / gaps:**
- Stale `advance_issue` tool reference in frontmatter and hook matcher
- PR body template is sparse — no plan link, no test summary
- Step 6 says "Advance all children of the issue to In Review" but lacks detail on how to identify children vs. standalone
- No explicit handling if `gh pr create` output is malformed (PR URL capture could fail silently)

---

### ralph-merge

**File**: `plugin/ralph-hero/skills/ralph-merge/SKILL.md`

**Frontmatter profile:**
- `user-invocable: false` — correct
- `context: fork` — correct
- `model: haiku` — appropriate for orchestration/merge mechanics
- `hooks`: SessionStart sets `RALPH_COMMAND=merge RALPH_VALID_OUTPUT_STATES='Done,Human Needed'`; PreToolUse hooks `save_issue|advance_issue` against `merge-state-gate.sh`
- `allowed-tools**: Read, Glob, Bash, AskUserQuestion, Skill, get_issue, list_sub_issues, list_dependencies, advance_issue, save_issue, create_comment

**Interactive merge gate (Step 4):**
This is the most sophisticated step in the trio. The behavior branches on three conditions:
1. `reviewDecision == APPROVED` → proceed immediately
2. `reviewDecision == CHANGES_REQUESTED` → hard block with `MERGE BLOCKED` output
3. `reviewDecision == null/empty` (no review yet) → branch on skill availability + RALPH_REVIEW_MODE

The `RALPH_REVIEW_MODE` env var (resolved at load time, defaulting to `interactive`) controls two distinct flows:
- **interactive**: `AskUserQuestion` presents three options: "Run code review", "Merge without review", "Other". This stops for human input.
- **auto**: Invokes `Skill("code-review:code-review", "PR_NUMBER")` without prompting. Post-review re-check on `reviewDecision`.

The `CODE_REVIEW_FEEDBACK` status (auto mode, changes requested) is distinct from `MERGE BLOCKED` and signals that the finish orchestrator should attempt an impl-agent fix cycle. This is a critical behavioral contract with the caller — but it is documented only within ralph-merge's body, not in any shared fragment or cross-skill spec.

**Code review hook integration:**
Step 4, case 2 (auto mode, skill available): the skill invokes `Skill("code-review:code-review", "PR_NUMBER")`. The PR_NUMBER is explicitly noted as "the PR number obtained in Step 3 (not the issue number)" — this is a subtle but important note that could cause bugs if overlooked. There is no timeout handling specified for the code-review skill invocation.

Step 4, case 4 (skill not available): presents a degraded path with `AskUserQuestion`. This is correct defensive design.

**State gate:**
`merge-state-gate.sh` has a special case: if `tool_name` contains `advance_parent`, it allows unconditionally ("advance_parent computes target state server-side"). Same stale `advance_issue` reference in the frontmatter as ralph-pr. The `advance_parent` tool also appears absent from the current MCP server tool set (not in the get_issue/save_issue/create_comment/list_* set). This gate carve-out is likely dead code.

**Cross-repo unblock check (Step 9a):**
Well-specified informational check. After merging, calls `list_dependencies` on the parent to find downstream issues. No automated cascade — posts comment only. The tool `list_dependencies` is in allowed-tools; this is correctly scoped.

**Upstream PR rejection (Step 9b):**
Handles the edge case where a PR was closed without merge. Posts a notification. This is defensive and correct. However, the detection trigger ("Ralph-merge is invoked to merge a specific PR") implies the caller already passed Step 3 (Find Pull Request), but Step 9b rechecks `gh pr view --json state,mergedAt` — this creates a redundant check with Step 5's `gh pr view --json mergeable,reviewDecision,state`. Could be consolidated.

**Link Formatting section:**
ralph-merge includes a full "## Link Formatting" section with cross-repo table. ralph-pr does NOT include this section. ralph-val does NOT include this section. The pattern is inconsistent — if cross-repo linking is needed by ralph-pr (for multi-repo PR bodies), it lacks the reference. This is a **cross-skill drift**: the fragment exists only in ralph-merge.

**Description triggering quality:**
`"Merge an approved pull request — checks PR readiness, merges, cleans up worktree, moves issues to Done. Use when you want to merge a PR for a completed issue."`

Accurate. Slightly inconsistent with the actual behavior: the skill also handles unapproved PRs (triggering code review or AskUserQuestion), not just "approved" ones. The description could mislead callers into thinking the PR must already be approved before invoking.

**Anti-patterns / gaps:**
- Stale `advance_issue` and `advance_parent` tool references
- Description claims "approved pull request" but handles unapproved PRs too
- `CODE_REVIEW_FEEDBACK` contract is undocumented outside the skill body
- No timeout handling for code-review skill invocation
- Link Formatting section exists only in ralph-merge, missing in ralph-pr and ralph-val
- Step 9b rejection detection duplicates Step 5 readiness check fields

---

## Cross-Skill Consistency Analysis

### Patterns shared correctly
- All three use `context: fork` (correct isolation)
- All three use `set-skill-env.sh` via SessionStart to set `RALPH_COMMAND` and `RALPH_VALID_OUTPUT_STATES`
- All three have matching description "Use when" clauses
- All three use `AskUserQuestion` convention (ralph-merge) or post comments (ralph-val, ralph-pr) following Artifact Comment Protocol
- All three have numbered, sequential step workflows

### Patterns that drift across skills

| Pattern | ralph-val | ralph-pr | ralph-merge |
|---------|-----------|----------|-------------|
| `user-invocable` | false | false | false |
| `context` | fork | fork | fork |
| `advance_issue` in allowed-tools | No | Yes (stale) | Yes (stale) |
| Link Formatting section | No | No | Yes |
| `AskUserQuestion` use | No | No | Yes |
| `Skill` tool in allowed-tools | No | No | Yes |
| `list_dependencies` in allowed-tools | No | No | Yes |
| Task tool in allowed-tools | Yes (unused?) | No | No |
| Cross-repo section in skill body | No | Yes (Step 3a) | Yes (Step 9a) |
| PostCondition hook | Yes | No | No |

The `Task` tool appearing only in ralph-val's allowed-tools without any reference in the skill body is suspicious — it was likely added in anticipation of parallel sub-checks but never implemented.

### Trigger description quality comparison

| Skill | Description quality | Issues |
|-------|--------------------|----|
| ralph-val | Good | None significant |
| ralph-pr | Good | Minor redundancy |
| ralph-merge | Misleading | "approved" implies pre-approved only; skill handles unapproved too |

---

## Key Discoveries

### Finding 1: Stale `advance_issue` tool in ralph-pr and ralph-merge
Both skills list `mcp__plugin_ralph-hero_ralph-github__ralph_hero__advance_issue` in allowed-tools and in PreToolUse hook matchers. This tool does not exist in the current MCP server. The hook matcher would never fire for it. The skills function correctly because they use `save_issue` for state transitions, but the stale references are confusing and could cause a future operator to assume the tool is available.

**File**: `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (line 23)
**File**: `plugin/ralph-hero/skills/ralph-merge/SKILL.md` (lines 26, 16-17 hook matcher)

### Finding 2: `advance_parent` carve-out in merge-state-gate.sh is dead code
`merge-state-gate.sh` (line 11) checks if `tool_name` contains `advance_parent` and allows it unconditionally. No `advance_parent` tool exists in the current MCP server. This is dead code from a prior API version.

**File**: `plugin/ralph-hero/hooks/scripts/merge-state-gate.sh` (line 10-12)

### Finding 3: `CODE_REVIEW_FEEDBACK` contract is silently internal
When ralph-merge is in auto mode and automated code review requests changes, it outputs `CODE_REVIEW_FEEDBACK` (not `MERGE BLOCKED`). This signals the caller (ralph-finish/ralph-hero) to dispatch a fix cycle. However this contract is documented only in ralph-merge's body. No caller documentation references it. If an orchestrator only handles `MERGE BLOCKED` as a stop condition, it would treat `CODE_REVIEW_FEEDBACK` as an unrecognized status.

**File**: `plugin/ralph-hero/skills/ralph-merge/SKILL.md` (lines 121-128)

### Finding 4: `Task` tool in ralph-val allowed-tools appears vestigial
The `Task` tool is listed in ralph-val's allowed-tools but the skill body makes no reference to spawning parallel tasks. Unlike ralph-research and ralph-plan which explicitly use `Task` for sub-agents, ralph-val's workflow is sequential. This may be a copy-paste from another skill's frontmatter.

**File**: `plugin/ralph-hero/skills/ralph-val/SKILL.md` (line 21)

### Finding 5: Link Formatting section missing from ralph-pr
ralph-merge has a complete "## Link Formatting" table covering single-repo and cross-repo URLs. ralph-pr has a Step 3a (Multi-Repo PR Detection) with cross-repo PR creation but no link formatting reference. When writing PR bodies with cross-repo file links, ralph-pr has no guidance on URL construction.

**File**: `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (entire file — section absent)

### Finding 6: ralph-val has no worktree freshness check
Step 4 (Find Worktree) verifies the worktree exists but does not instruct `git pull` or branch verification before running checks. If the worktree is stale (e.g., main has advanced), validation could pass against an outdated base. ralph-impl explicitly does `git fetch origin main && git pull` in its worktree setup.

**File**: `plugin/ralph-hero/skills/ralph-val/SKILL.md` (lines 74-84)

### Finding 7: ralph-merge description is misleading
The description says "Merge an approved pull request" implying pre-approval. The skill handles unapproved PRs by either running the code-review skill or asking the user. The description could be corrected to "Merge a pull request after code review — handles review gate, merges, cleans up worktree, moves issues to Done."

**File**: `plugin/ralph-hero/skills/ralph-merge/SKILL.md` (line 3)

---

## Fragment Extraction Candidates

The following patterns appear in multiple skills and are candidates for extraction to `skills/shared/fragments/`:

1. **State transition output block format** — The `VALIDATION [PASS/FIX/FAIL]`, `MERGE BLOCKED`, `MERGE NOT READY`, `MERGED`, `PR CREATED` status blocks are only in the individual skills. A shared fragment defining the output contract would improve cross-skill consistency.

2. **Worktree path resolution** — ralph-val and ralph-merge both need to find a worktree for GH-NNN. The pattern (`worktrees/GH-NNN` relative to git root, with fallback to task metadata/comments) is identical. A fragment would centralize this.

3. **Link Formatting table** — Present in ralph-merge and ralph-impl. Should be a shared fragment included by all pipeline skills, especially ralph-pr (which creates cross-repo PR bodies).

4. **`CODE_REVIEW_FEEDBACK` contract** — The auto-mode code review output contract should be a shared fragment so orchestrators (ralph-hero, ralph-finish) can reference the same spec.

---

## Potential Approaches

### Option A: Minimal cleanup (recommended for phase 2)
- Remove stale `advance_issue` and `advance_parent` tool references from ralph-pr and ralph-merge
- Remove unused `Task` tool from ralph-val allowed-tools
- Fix ralph-merge description to not imply pre-approved PRs
- Add worktree freshness check (git pull) to ralph-val Step 4
- Add Link Formatting fragment include to ralph-pr

**Pros**: Targeted, low risk, high signal-to-noise
**Cons**: Doesn't address the `CODE_REVIEW_FEEDBACK` contract documentation gap

### Option B: Extract fragments + cleanup
All of Option A plus:
- Extract Link Formatting table to `skills/shared/fragments/link-formatting.md`
- Extract worktree path resolution to `skills/shared/fragments/worktree-resolution.md`
- Extract `CODE_REVIEW_FEEDBACK` contract to `skills/shared/fragments/code-review-feedback-contract.md`
- Include fragments via `!cat` directives

**Pros**: Reduces future drift, creates authoritative specs
**Cons**: More files to maintain; `!cat` directive usage adds indirection

### Option C: Merge gate refactor
Separate the "code review orchestration" logic from the "merge mechanics" in ralph-merge. The code review gate (Step 4) has grown to be a complex decision tree. Extracting it to a dedicated `ralph-code-review-gate` skill would simplify ralph-merge and make the `CODE_REVIEW_FEEDBACK` contract explicit.

**Pros**: Better separation of concerns
**Cons**: Adds a new skill, increases pipeline complexity, out of scope for phase 2

---

## Risks

1. **Stale tool references could mislead future implementers** into believing `advance_issue` and `advance_parent` are available MCP tools. Low runtime impact today; high confusion risk if MCP server is extended.

2. **`CODE_REVIEW_FEEDBACK` without shared spec** could cause orchestrator mishandling if ralph-finish or ralph-hero is updated without reference to this contract.

3. **Worktree staleness in ralph-val** could cause false PASS verdicts on stale implementations. Risk is low in single-agent flows but higher in parallel team operations.

4. **PR body sparseness** in ralph-pr may reduce review quality. Sparse PR descriptions make it harder for human reviewers and the code-review skill to understand intent.

---

## Recommended Next Steps

1. Remove `advance_issue` from ralph-pr and ralph-merge allowed-tools and hook matchers (stale)
2. Remove `advance_parent` carve-out from `merge-state-gate.sh` (dead code)
3. Remove `Task` from ralph-val allowed-tools (vestigial)
4. Add git pull to ralph-val Step 4 worktree check
5. Add Link Formatting section to ralph-pr (copy from ralph-merge)
6. Fix ralph-merge description string to accurately describe its behavior
7. Add a PR body template with: Summary, Plan link, Phase count (for group issues), Closes #NNN — enriches for both human and automated reviewers
8. Document `CODE_REVIEW_FEEDBACK` contract as a shared fragment or in ralph-merge header block

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/ralph-val/SKILL.md` — Remove vestigial Task tool, add worktree git pull
- `plugin/ralph-hero/skills/ralph-pr/SKILL.md` — Remove stale advance_issue, enrich PR body template, add Link Formatting section
- `plugin/ralph-hero/skills/ralph-merge/SKILL.md` — Remove stale advance_issue, fix description, document CODE_REVIEW_FEEDBACK contract
- `plugin/ralph-hero/hooks/scripts/merge-state-gate.sh` — Remove advance_parent dead-code carve-out

### Will Read (Dependencies)
- `plugin/ralph-hero/hooks/scripts/pr-state-gate.sh` — State gate behavior for ralph-pr
- `plugin/ralph-hero/hooks/scripts/val-postcondition.sh` — Stop hook for ralph-val
- `plugin/ralph-hero/hooks/scripts/hook-utils.sh` — Shared hook utilities
- `plugin/ralph-hero/hooks/scripts/ralph-state-machine.json` — Valid states per command
- `plugin/ralph-hero/hooks/scripts/set-skill-env.sh` — Session environment initialization
- `plugin/ralph-hero/skills/shared/fragments/ask-user-question.md` — AskUserQuestion convention
