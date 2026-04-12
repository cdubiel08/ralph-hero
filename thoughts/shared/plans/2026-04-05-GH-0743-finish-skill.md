---
date: 2026-04-05
status: draft
type: plan
tags: [finish, orchestration, ci-watch, code-review, integrator]
github_issue: 743
github_issues: [743]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/743
primary_issue: 743
---

# Finish Skill Implementation Plan

## Prior Work

- builds_on:: [[hero orchestrator SKILL.md]]
- builds_on:: [[ralph-val SKILL.md]]
- builds_on:: [[ralph-merge SKILL.md]]
- builds_on:: [[code-review plugin]]

## Overview

Add a `/ralph-hero:finish` skill that chains validate → code-review → fix-loop → merge → CI watch into a single orchestrated pipeline. Wire it as the final step in hero's task graph, replacing the current "report and wait for human merge" terminal state.

## Current State Analysis

- Hero pipeline ends at PR creation (`ralph-pr`) with issues in "In Review"
- `ralph-val`, `code-review:code-review`, and `ralph-merge` exist as standalone skills but are never chained
- Hero's INTEGRATOR phase at `hero/SKILL.md:83-88` is a placeholder: `(future: auto-merge if RALPH_AUTO_MERGE=true)`
- `ralph-merge` already has a code-review gate (Step 4, `ralph-merge/SKILL.md:82-153`) that asks the user whether to review before merging — finish subsumes this by always running code review first

### Key Discoveries:
- `ralph-val` does NOT change workflow state (`ralph-val/SKILL.md:186`) — it only produces a PASS/FAIL verdict and posts a GitHub comment
- `ralph-merge` handles all state transitions (Done), worktree cleanup, parent advancement, and cross-repo unblock
- `code-review:code-review` posts findings as a PR comment (not a formal GitHub review), so `reviewDecision` stays null after it runs
- `merge-pr.sh` at repo root handles the actual `gh pr merge --merge --delete-branch` with worktree cleanup
- Hero dispatches skills via `Skill()` inline (single-session mode) — skill hooks fire in the dispatched context
- State gate hooks use `RALPH_VALID_OUTPUT_STATES` env var set by `set-skill-env.sh` in SessionStart

## Desired End State

A user can run `/ralph-hero:finish #123` to:
1. Validate the implementation against the plan (automated checks)
2. Run code review on the PR
3. Auto-fix simple issues (≤3 localized issues), iterate up to 2 times
4. Merge the PR
5. Watch CI checks until they pass or fail
6. Report final status with CI results

Hero's pipeline extends through merge + CI verification instead of stopping at "In Review".

### Verification:
- `/ralph-hero:finish #NNN` on an issue in "In Review" with a PR runs the full chain
- Hero's task graph includes a Finish task after Create PR
- CI watch reports check status before completing
- Fix loop handles code-review findings and re-pushes when fixable

## What We're NOT Doing

- CD monitoring (only PR checks, not post-merge release workflows)
- Formal GitHub review API integration (code-review plugin posts comments, not reviews)
- New MCP server tools (finish is pure skill orchestration)
- Changing ralph-val, ralph-merge, or code-review internals
- Creating a dedicated state-gate hook script (finish reuses merge's valid states since merge is the step that transitions)

## Implementation Approach

Finish is an **orchestrator skill** that delegates to existing skills/agents. It doesn't directly manipulate workflow state — it relies on `ralph-merge` for state transitions and `ralph-val` for validation. The fix loop is the only novel logic: parsing code-review output, assessing complexity, and dispatching a sonnet Agent to make targeted fixes.

## Phase 1: Create the Finish Skill

### Overview
Create `plugin/ralph-hero/skills/finish/SKILL.md` — a user-invocable skill that chains the full post-PR pipeline.

### Changes Required:

#### 1. Skill Definition
**File**: `plugin/ralph-hero/skills/finish/SKILL.md` (new)

```markdown
---
description: Validate, code-review, fix, merge, and watch CI for a completed implementation. Chains ralph-val → code-review → fix-loop → ralph-merge → CI watch into one command.
user-invocable: true
argument-hint: <issue-number> [--pr-url url] [--plan-doc path]
context: fork
model: sonnet
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=finish RALPH_VALID_OUTPUT_STATES='Done,Human Needed'"
  PreToolUse:
    - matcher: "ralph_hero__save_issue|ralph_hero__advance_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/merge-state-gate.sh"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Agent
  - Skill
  - AskUserQuestion
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_dependencies
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__advance_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
---
```

The skill body follows this flow:

**Step 1: Parse Arguments**

Extract issue number and optional `--pr-url`, `--plan-doc` flags from args. Export `RALPH_TICKET_ID="GH-NNN"`.

**Step 2: Fetch Issue & Find PR**

Fetch issue details. Verify issue is in "In Review" state. Find the PR via `--pr-url` or `gh pr list --head feature/GH-NNN`. Stop if no PR found.

**Step 3: Validate (dispatch ralph-val)**

```
Skill("ralph-hero:ralph-val", args="NNN --plan-doc {plan_doc}")
```

If ralph-val outputs `VALIDATION FAIL`: stop with the validation report. The implementation must pass automated checks before proceeding.

If ralph-val outputs `VALIDATION PASS`: continue to Step 4.

**Step 4: Code Review**

Check if the `code-review:code-review` skill is available.

- **If available**: invoke `Skill("code-review:code-review", "PR_NUMBER")` where PR_NUMBER is the PR number (not the issue number).
- **If not available**: log that code review was skipped and proceed to Step 6 (merge).

After code review completes, check the PR for the review comment:

```bash
gh pr view PR_NUMBER --json comments --jq '.comments[-1].body'
```

Parse the last code-review comment. Look for the pattern `Found N issues:` to determine if issues were found.

- If `No issues found`: proceed to Step 6 (merge).
- If issues found: proceed to Step 5 (fix loop).

**Step 5: Fix Loop (max 2 iterations)**

Assess the code-review findings using LLM judgment (not keyword matching):

1. Count the number of issues
2. Check if all issues reference files in the PR diff (`gh pr diff PR_NUMBER --name-only`)
3. Classify each issue as **auto-fixable** or **escalate**:

**Auto-fixable** (all must be true):
- ≤3 issues total
- All issues reference files within the PR diff
- Issues are localized code fixes (typos, missing checks, wrong values, style issues)

**Escalate** (any one triggers escalation):
- More than 3 issues
- Issues reference files outside the PR diff
- Architectural or design concerns (restructuring, API design, abstraction choices)
- Operational or cloud infrastructure decisions (permissions, IAM, deploying new GCP/AWS APIs, provisioning cloud managed services, secrets management, networking, CI/CD pipeline changes)
- Security concerns that require human judgment
- Any issue where the fix could have unintended side effects beyond the immediate code

This classification is an **LLM judgment call** — evaluate the semantic intent of each finding, not surface-level keywords.

**If escalate**: present choice to human.

```
AskUserQuestion(
  questions=[{
    "question": "Code review found issues that may need human judgment. Review the PR comments and decide how to proceed.",
    "header": "Complex Code Review Findings",
    "options": [
      {"label": "I'll fix manually", "description": "Stop here — you'll address the feedback yourself"},
      {"label": "Try auto-fix anyway", "description": "Attempt to fix all issues automatically"},
      {"label": "Merge anyway", "description": "Skip fixes and proceed to merge"}
    ],
    "multiSelect": false
  }]
)
```

**If simple**: dispatch a sonnet Agent to fix the issues in the worktree:

```
Agent(
  subagent_type="general-purpose",
  model="sonnet",
  prompt="You are fixing code review issues in a worktree.

  Worktree: worktrees/GH-NNN
  PR: #PR_NUMBER
  
  Code review found these issues:
  [paste parsed issues from the code-review comment]
  
  For each issue:
  1. Read the referenced file in the worktree
  2. Make the minimal fix
  3. Do NOT refactor surrounding code or add unrelated changes
  
  After all fixes, from the worktree directory:
  1. Stage the changed files: git add [specific files]
  2. Commit: git commit -m 'fix: address code review findings'
  3. Push: git push
  
  Report what you fixed."
)
```

After the fix agent completes, re-run code review: `Skill("code-review:code-review", "PR_NUMBER")`.

Re-parse findings. If still issues and iteration < 2: repeat. If iteration >= 2 or still complex: escalate to human with the same AskUserQuestion above.

**Step 6: Merge (dispatch ralph-merge)**

```
Skill("ralph-hero:ralph-merge", args="NNN --pr-url PR_URL")
```

ralph-merge handles: PR readiness check, merge via `merge-pr.sh`, worktree cleanup, state transition to Done, parent advancement, cross-repo unblock, and posting the Merged comment.

If ralph-merge outputs `MERGE BLOCKED` or `MERGE NOT READY`: report the status and stop.

**Step 7: CI Watch**

After merge completes, watch CI checks on the merge commit:

```bash
# Get the merge commit SHA
MERGE_SHA=$(gh pr view PR_NUMBER --json mergeCommit --jq '.mergeCommit.oid')

# Watch checks (blocks until all complete, 10 min timeout)
gh run list --commit "$MERGE_SHA" --json status,conclusion,name,url --limit 10
```

Poll every 30 seconds for up to 10 minutes:
- If all checks pass (conclusion=success): report success
- If any check fails: report failure with links to the failed runs
- If timeout: report that checks are still running with links

**Step 8: Report Final Status**

```
FINISHED
Issue: #NNN
PR: https://github.com/OWNER/REPO/pull/PR_NUMBER
Validation: PASS
Code Review: [PASS / SKIPPED / N issues fixed]
Merge: Done
CI: [PASS / FAIL / PENDING (timeout)]
[If CI FAIL: links to failed runs]
```

### Success Criteria:

#### Automated Verification:
- [ ] File exists: `plugin/ralph-hero/skills/finish/SKILL.md`
- [ ] Skill frontmatter has `user-invocable: true`
- [ ] Skill frontmatter lists all required tools in `allowed-tools`
- [ ] Skill reuses `merge-state-gate.sh` (no new hook script)
- [ ] Build passes: `cd plugin/ralph-hero/mcp-server && npm run build`

#### Manual Verification:
- [ ] `/ralph-hero:finish #NNN` on an issue in "In Review" runs the full pipeline
- [ ] Validation failure stops the pipeline early
- [ ] Code review findings trigger the fix loop
- [ ] Fix loop dispatches a sonnet agent and re-pushes
- [ ] Merge + CI watch complete successfully

---

## Phase 2: Wire Finish into Hero

### Overview
Modify the hero orchestrator to dispatch `:finish` as the final pipeline step after PR creation, replacing the "report and wait" terminal.

### Changes Required:

#### 1. Hero Skill
**File**: `plugin/ralph-hero/skills/hero/SKILL.md`

**Change 1 — State machine diagram** (around line 83-88):

Replace the INTEGRATOR phase placeholder:
```
  INTEGRATOR PHASE
    |- Report PR URLs and "In Review" status
    |- (future: auto-merge if RALPH_AUTO_MERGE=true)
```

With:
```
  INTEGRATOR PHASE
    |- Finish GH-[PRIMARY] (validate, review, fix, merge, CI watch)
    |- via Skill("ralph-hero:finish", args="#NNN")
```

**Change 2 — Task graph templates** (lines 154-192):

Add a Finish task after every `Create PR` task in all graph variants:

Starting from RESEARCH:
```
T-M+1:  Create PR GH-[PRIMARY]                → blockedBy: [last impl task]
T-M+2:  Finish GH-[PRIMARY]                   → blockedBy: [PR task]
```

Starting from PLAN:
```
T-N+1:  Create PR GH-[PRIMARY]                → blockedBy: [last impl task]
T-N+2:  Finish GH-[PRIMARY]                   → blockedBy: [PR task]
```

Starting from REVIEW/HUMAN_GATE:
```
T-N+1:  Create PR GH-[PRIMARY]                → blockedBy: [last impl task]
T-N+2:  Finish GH-[PRIMARY]                   → blockedBy: [PR task]
```

Starting from IMPLEMENT:
```
T-N+1:  Create PR GH-[PRIMARY]                → blockedBy: [last impl task]
T-N+2:  Finish GH-[PRIMARY]                   → blockedBy: [PR task]
```

**Change 3 — Execution loop dispatch** (after line 387):

Add FINISH task dispatch:

```
#### FINISH tasks
Skill("ralph-hero:finish", args="#NNN")
```

After finish completes, report final status including CI results.

**Change 4 — INTEGRATOR COMPLETE section** (lines 390-394):

Replace:
```
Report PR URLs and final status. All issues should be in "In Review".

Future: When `RALPH_AUTO_MERGE=true`, automatically merge approved PRs via `gh pr merge`. For now, report and wait for human merge.
```

With:
```
After finish completes, all issues should be in "Done" with CI verified.

Report final status: issue numbers, PR URLs, merge status, CI results.
```

**Change 5 — `allowed-tools`** (line 1-31):

Add `Skill` to hero's allowed-tools if not already present (it is already listed at line 13 — confirmed).

No new tools needed — hero dispatches finish via `Skill()`.

### Success Criteria:

#### Automated Verification:
- [ ] `hero/SKILL.md` contains `Finish GH-` in all 4 task graph templates
- [ ] `hero/SKILL.md` contains `Skill("ralph-hero:finish"` dispatch
- [ ] No `(future: auto-merge` placeholder remains
- [ ] Build passes: `cd plugin/ralph-hero/mcp-server && npm run build`

#### Manual Verification:
- [ ] `/ralph-hero #NNN` on a fresh issue processes through to merge + CI watch
- [ ] Hero's task list includes a Finish task blocked by PR task
- [ ] Pipeline completes with issues in "Done" instead of "In Review"

---

## Phase 3: Add Finish Agent

### Overview
Create the `finish-agent` definition for team-mode dispatch consistency.

### Changes Required:

#### 1. Agent Definition
**File**: `plugin/ralph-hero/agents/finish-agent.md` (new)

```markdown
---
name: finish-agent
description: Finish pipeline - validates implementation, runs code review, fixes simple issues, merges PR, watches CI
model: sonnet
tools: Read, Write, Edit, Glob, Grep, Bash, Agent, Skill, AskUserQuestion, mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue, mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues, mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_dependencies, mcp__plugin_ralph-hero_ralph-github__ralph_hero__advance_issue, mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue, mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
skills:
  - ralph-hero:finish
---

You are a finish agent. Follow the preloaded finish instructions to validate, review, merge, and watch CI for the issue specified in your task prompt.
```

Key differences from other integrator agents:
- **Model: sonnet** (not haiku) — needs code comprehension for the fix loop
- **Has Write, Edit, Agent** — required for the fix loop to dispatch sub-agents and for worktree edits
- **Has Skill** — dispatches ralph-val, code-review:code-review, and ralph-merge as sub-skills

### Success Criteria:

#### Automated Verification:
- [ ] File exists: `plugin/ralph-hero/agents/finish-agent.md`
- [ ] Agent frontmatter has `model: sonnet`
- [ ] Agent preloads `ralph-hero:finish` via `skills:` field
- [ ] Agent tools are a superset of val-agent + merge-agent tools plus Write, Edit, Agent, Skill

#### Manual Verification:
- [ ] Agent can be dispatched via `Agent(subagent_type="ralph-hero:finish-agent", ...)`
- [ ] Preloaded skill content is visible in agent context

---

## Testing Strategy

### Integration Testing:
- End-to-end: Create a test issue with implementation + PR, run `/ralph-hero:finish`, verify full chain executes
- Validation failure: Create a PR that fails plan checks, verify finish stops at validation
- Code review fix loop: Create a PR with a known issue, verify fix agent runs and re-pushes
- CI watch: Verify checks are polled after merge and status reported
- Hero integration: Run `/ralph-hero` on a fresh issue, verify finish task appears and executes after PR

### Edge Cases:
- code-review plugin not installed — finish should skip review and proceed to merge
- No worktree found — ralph-val handles this (VALIDATION FAIL)
- PR already merged — ralph-merge handles this (MERGE BLOCKED)
- CI checks timeout — finish should report pending status, not fail

## References

- Hero orchestrator: `plugin/ralph-hero/skills/hero/SKILL.md`
- Validation skill: `plugin/ralph-hero/skills/ralph-val/SKILL.md`
- Merge skill: `plugin/ralph-hero/skills/ralph-merge/SKILL.md`
- Code review plugin: `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/code-review/commands/code-review.md`
- PR merge script: `scripts/merge-pr.sh`
- State gate hook: `plugin/ralph-hero/hooks/scripts/merge-state-gate.sh`
- Env setup hook: `plugin/ralph-hero/hooks/scripts/set-skill-env.sh`
