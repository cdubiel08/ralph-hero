---
date: 2026-04-03
status: approved
type: plan
tags: [ralph-hero, autonomous-mode, loop-runner, code-review, integrator]
github_issue: 731
github_issues: [731]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/731
primary_issue: 731
---

# Complete Autonomous Loop — Full Pipeline Through PR + Code Review

## Prior Work

- builds_on:: [[2026-01-19-naive-hero-autonomous-loop]]
- builds_on:: [[2026-02-13-group-LAN-361-ralph-github-plugin]]

## Overview

Complete the ralph-hero autonomous loop (`ralph-loop.sh`) so it drives issues from Backlog through PR creation, code review, autofix, and optional auto-merge — without human intervention. Today the loop runs hygiene → triage → split → research → plan → review → impl and stops. This plan adds four integrator phases (val → pr → code-review → merge) and fixes existing bugs that prevent truly unattended runs.

## Current State Analysis

**What works:**
- `scripts/ralph-loop.sh` runs 7 phases sequentially with timeout/budget per task
- `cli-dispatch.sh` provides `run_headless()` with output filtering and summary collection
- `justfile` exposes `loop`, `hero`, `team` recipes
- All analyst/builder skills (`ralph-triage` through `ralph-impl`) are `context: fork` with hooks
- `ralph-pr`, `ralph-val`, `ralph-merge` skills exist but are NOT in the loop
- `code-review:code-review` plugin runs headlessly and posts PR comments

**What's broken/missing:**
1. **Queue-empty text mismatch** — `run_claude` greps for `"Queue empty"` but `ralph-triage` outputs `"Triage complete"` (never signals empty to the loop)
2. **Review defaults to `skip`** — Full auto should default to `auto` (Opus auto-approves good plans)
3. **No integrator phases** — After impl, issues sit in "In Review" with no PR, no code review, no merge
4. **`ralph-merge` is interactive** — Step 4 uses `AskUserQuestion` which blocks headless execution
5. **No `ralph-code-review` skill** — Nothing orchestrates: find PR → run code-review → address feedback → re-review loop
6. **Integrator placeholder** — `ralph-loop.sh:220-223` has `# Future: run_claude "/ralph-hero:ralph-integrate"` but no implementation

### Key Discoveries:
- `ralph-impl` Step 2 already detects "In Review" + PR comments → enters **Address Mode** automatically (`ralph-impl/SKILL.md:88-95`)
- `code-review:code-review` auto-detects PR from `gh` context, posts comments above confidence 80, uses 5 parallel Sonnet reviewers (`commands/code-review.md`)
- `ralph-merge` checks `gh pr view NNN --json reviewDecision` for approval status (`ralph-merge/SKILL.md:86-89`)
- `ralph-pr` is model `haiku` — lightweight, just pushes branch + creates PR via `gh` (`ralph-pr/SKILL.md:6`)
- `ralph-val` runs automated verification from the plan document before PR creation (`ralph-val/SKILL.md:100-110`)

## Desired End State

The loop runs fully autonomously with this phase sequence:

```
hygiene → triage → split → research → plan → review → impl → val → pr → code-review → [merge]
         ╰─── analyst ───╯  ╰── builder ──╯  ╰─────── integrator ────────╯
```

**Default behavior** (`just loop`): Runs all phases through code-review. Issues end at "In Review" with a PR that has been code-reviewed and feedback addressed.

**With `--auto-merge`** (`just loop auto-merge=true`): Additionally merges PRs where code review passed (no unresolved comments) and CI checks pass.

**Verification**: Run `just loop --impl-only` on a repo with one "In Progress" issue with a completed plan. The loop should: validate → create PR → run code review → address any feedback → (optionally merge). Issue ends at "In Review" (or "Done" with auto-merge).

## What We're NOT Doing

- No budget aggregation across the loop (per-task budget is fine for now)
- No postmortem generation at loop completion (exists as a skill, wire later)
- No parallel ticket processing within a single phase (one ticket per phase per iteration)
- No GitHub Actions integration for CI triggering (we rely on existing CI via `gh pr checks`)
- No changes to the hero orchestrator skill — this plan targets `ralph-loop.sh` only
- No new MCP server tools — all needed tools already exist

## Implementation Approach

One new skill (`ralph-code-review`), queue-picking logic added to three existing skills (`ralph-val`, `ralph-pr`, `ralph-merge`), and loop script extension. The queue-picking additions are mechanical — each skill gets a "If no issue number" branch that queries `list_issues` for the appropriate workflow state, identical to the pattern used by `ralph-impl` and `ralph-research`.

---

## Phase 1: Fix Loop Fundamentals

### Overview
Fix the queue-empty detection bug and change the review default so the loop can run fully unattended.

### Changes Required:

#### 1. Standardize queue-empty output in `ralph-triage`
**File**: `plugin/ralph-hero/skills/ralph-triage/SKILL.md`
**Changes**: The "no work" output says `"No untriaged issues in Backlog. Triage complete."` — it must include the string `"Queue empty"` for `ralph-loop.sh`'s `run_claude` grep to detect it.

Find the queue-empty output text (around line 93 of the skill) and change:
```
No untriaged issues in Backlog. Triage complete.
```
to:
```
No untriaged issues in Backlog. Queue empty.
```

#### 2. Note: `ralph-hygiene` is always-run (no queue-empty needed)
`ralph-hygiene` is a board-scanning skill that always produces an archive eligibility report. It has no concept of "no work" — it always runs. The loop already handles it correctly: line 149 calls `run_claude` without checking the return value for queue-empty, and `work_done=true` is set unconditionally. **No changes needed for hygiene.**

#### 3. Change review default from `skip` to `auto` (script AND justfile together)
**File**: `plugin/ralph-hero/scripts/ralph-loop.sh`
**Changes**: Line 54 — change `REVIEW_MODE` default:

```bash
# Before
REVIEW_MODE="${RALPH_REVIEW_MODE:-skip}"

# After
REVIEW_MODE="${RALPH_REVIEW_MODE:-auto}"
```

This means `just loop` now auto-reviews plans instead of skipping review. Users who want to skip can still pass `--review=skip`.

#### 4. Change justfile `loop` recipe review default to match
**File**: `plugin/ralph-hero/justfile`
**Changes**: In the `loop` recipe (around line 203), change the `review` parameter default from `"skip"` to `"auto"`:

```just
loop mode="all" review="auto" split="auto" ...
```

This keeps the script default and justfile default in sync (both changed in Phase 1).

#### 5. Make `run_claude` queue-empty detection case-insensitive and more robust
**File**: `plugin/ralph-hero/scripts/ralph-loop.sh`
**Changes**: Line 128 already uses `grep -qi` (case-insensitive). Verify this is correct. Also add detection for common variants:

```bash
# Before (line 128)
if echo "$output" | grep -qi "Queue empty"; then

# After
if echo "$output" | grep -qiE "Queue empty|No .* issues|Triage complete"; then
```

This catches existing skills that haven't been updated yet and provides a safety net.

### Success Criteria:

#### Automated Verification:
- [ ] `grep -c "Queue empty" plugin/ralph-hero/skills/ralph-triage/SKILL.md` returns ≥1
- [ ] `grep 'REVIEW_MODE.*:-' plugin/ralph-hero/scripts/ralph-loop.sh` shows `auto` not `skip`
- [ ] `grep 'review="auto"' plugin/ralph-hero/justfile` confirms justfile default matches
- [ ] `grep -E 'Queue empty|No .* issues' plugin/ralph-hero/scripts/ralph-loop.sh` matches the broadened pattern

#### Manual Verification:
- [ ] Run `just triage` on an empty backlog — output includes "Queue empty"
- [ ] Run `just loop --triage-only` with empty backlog — loop exits after 1 iteration (not 10)

---

## Phase 2: Add Queue-Picking Logic to Integrator Skills

### Overview
`ralph-val`, `ralph-pr`, and `ralph-merge` all require an issue number argument and have no self-selection logic. The loop invokes skills without arguments (like `ralph-triage` and `ralph-impl` which self-select). Add "If no issue number" queue-picking branches to each skill, following the same pattern used by `ralph-impl` Step 1.

**Note**: Each skill also needs `mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues` added to its `allowed-tools` frontmatter to support the queue-picking queries.

### Changes Required:

#### 1. Add queue-picking to `ralph-val`
**File**: `plugin/ralph-hero/skills/ralph-val/SKILL.md`
**Changes**: Add `list_issues` to `allowed-tools` frontmatter. In Step 1, add a fallback when no issue number is provided:

```markdown
**If no issue number**: List issues in "In Progress" state where all plan phases
are complete (all automated verification checkboxes checked), XS/Small, ordered
by priority, limit 1.

Use profile "builder-active" (workflowState: "In Progress").

For each candidate, check if a worktree exists at `$GIT_ROOT/worktrees/GH-NNN`.
Skip candidates without worktrees.

If no eligible issues:
```
No issues ready for validation. Queue empty.
```
Then STOP.
```

#### 2. Add queue-picking to `ralph-pr`
**File**: `plugin/ralph-hero/skills/ralph-pr/SKILL.md`
**Changes**: Add `list_issues` to `allowed-tools` frontmatter. In Step 1, add a fallback when no issue number is provided:

```markdown
**If no issue number**: List issues in "In Progress" state, XS/Small, ordered
by priority, limit 10.

For each candidate:
1. Check if a worktree exists at `$GIT_ROOT/worktrees/GH-NNN`
2. Check if there is NO existing open PR: `gh pr list --head feature/GH-NNN --json number --jq length` returns 0
3. Check if all plan phases are complete (read plan, verify all automated checkboxes checked)

Select the first candidate that passes all checks.

If no eligible issues:
```
No issues ready for PR creation. Queue empty.
```
Then STOP.
```

#### 3. Add queue-picking to `ralph-merge`
**File**: `plugin/ralph-hero/skills/ralph-merge/SKILL.md`
**Changes**: Add `list_issues` to `allowed-tools` frontmatter. In Step 1, add a fallback when no issue number is provided:

```markdown
**If no issue number**: List issues in "In Review" state, XS/Small, ordered
by priority, limit 10.

For each candidate:
1. Find its PR: `gh pr list --head feature/GH-NNN --json number,state --jq '.[0]'`
2. Skip if no open PR exists
3. Check merge readiness: `gh pr view NNN --json mergeable,reviewDecision,state`
4. Skip if not mergeable

Select the first candidate with an open, mergeable PR.

If no eligible issues:
```
No issues ready for merge. Queue empty.
```
Then STOP.
```

### Success Criteria:

#### Automated Verification:
- [ ] `grep -c "Queue empty" plugin/ralph-hero/skills/ralph-val/SKILL.md` returns ≥1
- [ ] `grep -c "Queue empty" plugin/ralph-hero/skills/ralph-pr/SKILL.md` returns ≥1
- [ ] `grep -c "Queue empty" plugin/ralph-hero/skills/ralph-merge/SKILL.md` returns ≥1
- [ ] `grep -c "If no issue number" plugin/ralph-hero/skills/ralph-val/SKILL.md` returns ≥1
- [ ] `grep -c "If no issue number" plugin/ralph-hero/skills/ralph-pr/SKILL.md` returns ≥1
- [ ] `grep -c "list_issues" plugin/ralph-hero/skills/ralph-val/SKILL.md` returns ≥1
- [ ] `grep -c "list_issues" plugin/ralph-hero/skills/ralph-pr/SKILL.md` returns ≥1
- [ ] `grep -c "list_issues" plugin/ralph-hero/skills/ralph-merge/SKILL.md` returns ≥1

#### Manual Verification:
- [ ] `just val` (no args) with no "In Progress" issues → outputs "Queue empty"
- [ ] `just pr` (no args) with no eligible issues → outputs "Queue empty"
- [ ] `just merge` (no args) with no "In Review" issues → outputs "Queue empty"
- [ ] `just val` (no args) with one eligible issue → validates that issue

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Create `ralph-code-review` Skill

### Overview
New skill that picks an "In Review" issue with a PR, runs code review on it, and orchestrates a fix loop (address feedback via `ralph-impl` address mode, then re-review) until the PR is clean or max attempts reached. On 3-round exhaustion, moves issue to "Human Needed" to prevent infinite retry across loop iterations.

### Changes Required:

#### 1. Skill definition
**File**: `plugin/ralph-hero/skills/ralph-code-review/SKILL.md` (new file)

```yaml
---
description: Run code review on a PR for an "In Review" issue, address feedback via ralph-impl address mode, and re-review until clean. Called by the loop, not directly by users.
user-invocable: false
argument-hint: [optional-issue-number]
context: fork
model: sonnet
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=code-review"
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Agent
  - Skill
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
---
```

#### 2. Skill workflow

```markdown
# Ralph Code Review — Autonomous PR Review + Fix Loop

You pick ONE "In Review" issue, run code review on its PR, and address feedback
until the PR is clean (max 3 rounds).

## Step 1: Select Issue

**If issue number provided**: Fetch it directly.
**If no issue number**: List issues in "In Review" state, XS/Small, ordered by priority, limit 1.

If no eligible issues:
```
No issues in In Review with open PRs. Queue empty.
```
Then STOP.

## Step 2: Find PR

Search issue comments for `## Pull Request` header (Artifact Comment Protocol).
Extract PR URL. If not found, try:

```bash
gh pr list --head feature/GH-NNN --json number,url,state --jq '.[0]'
```

If no open PR found: STOP with error.

## Step 3: Check Existing Review State

```bash
gh pr view PR_NUMBER --json reviewDecision,reviews,comments
```

- If `reviewDecision == "APPROVED"`: PR already reviewed and approved. Output
  "PR #NNN already approved. Queue empty." STOP.
- If `reviewDecision == "CHANGES_REQUESTED"` with unaddressed comments:
  Skip to Step 5 (address mode).
- Otherwise: proceed to Step 4.

## Step 4: Run Code Review

Determine the worktree path for this issue:
```bash
GIT_ROOT=$(git rev-parse --show-toplevel)
WORKTREE="$GIT_ROOT/worktrees/GH-NNN"
```

If worktree exists, cd into it:
```bash
cd "$WORKTREE"
```

**Pre-verify PR is resolvable from worktree context** before invoking code review:
```bash
gh pr view --json number --jq '.number'
```
If this fails (no PR associated with the current branch), fall back to explicit PR number:
```bash
gh pr view PR_NUMBER --json number --jq '.number'
```
If both fail: STOP with error "Cannot resolve PR from worktree context."

**Record comment count before review**:
```bash
BEFORE_COUNT=$(gh pr view PR_NUMBER --json comments --jq '.comments | length')
```

Invoke the code review plugin:
```
Skill("code-review:code-review")
```

**Check for new comments after review**:
```bash
AFTER_COUNT=$(gh pr view PR_NUMBER --json comments --jq '.comments | length')
```

If `AFTER_COUNT == BEFORE_COUNT` (no new comments posted):
```
Code review clean — no issues found for #NNN (PR #PR_NUMBER).
```
STOP. (PR is ready for merge.)

If new comments were posted: proceed to Step 5.

## Step 5: Address Feedback (Fix Loop)

Run ralph-impl in address mode by invoking it on the "In Review" issue.
ralph-impl detects "In Review" + PR comments and automatically enters address mode.

```
Agent(
  subagent_type="ralph-hero:impl-agent",
  prompt="Address PR review feedback for issue #NNN. The issue is In Review
          with an open PR that has review comments. Enter address mode and
          fix the identified issues.",
  description="Address review feedback #NNN"
)
```

Wait for the agent to complete.

## Step 6: Re-Review (Loop)

After feedback is addressed, re-run code review (return to Step 4).

Track round count. Maximum 3 rounds of review+fix. If after 3 rounds there are
still new comments:

1. **Move issue to "Human Needed"** to take it out of the code-review queue
   and prevent infinite retry across loop iterations:
   ```
   save_issue(number=NNN, workflowState="Human Needed", command="ralph_code_review")
   ```

2. **Post a comment on the issue**:
   ```markdown
   ## Code Review

   Automated code review completed 3 fix rounds.
   Some issues may remain — manual review recommended.

   PR: [PR URL]
   Issue moved to Human Needed.
   ```

3. **Output**:
   ```
   Code review incomplete after 3 rounds for #NNN (PR #PR_NUMBER).
   Issue moved to Human Needed. Remaining issues require human attention.
   ```

STOP.

## Step 7: Report Result

```
Code review complete for #NNN.

PR: [PR URL]
Rounds: [N]
Status: [Clean / Issues remain]
```
```

#### 3. Agent definition
**File**: `plugin/ralph-hero/agents/code-review-agent.md` (new file)

```markdown
---
name: code-review-agent
description: Runs code review on PRs and orchestrates fix loops
model: sonnet
skills:
  - ralph-hero:ralph-code-review
tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Agent
  - Skill
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
---
```

**Note on nested tool permissions**: The `ralph-code-review` skill invokes `impl-agent` (via `Agent()`) for address mode. The `impl-agent` has its own `allowed-tools` including Write, Edit, etc. — these are resolved at the agent level, not inherited from the calling skill. The `code-review-agent` does NOT need Write/Edit because it never writes files itself; only the nested `impl-agent` does. This chain works because each agent resolves its own tool permissions independently.

#### 4. Justfile recipe
**File**: `plugin/ralph-hero/justfile`
**Changes**: Add `code-review` recipe after the `review` recipe:

```just
# Run code review on an In Review PR, address feedback autonomously
[group('workflow')]
code-review *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=8.00 DEFAULT_TIMEOUT=30m
    _args={{quote(args)}}
    set -- $_args
    dispatch "ralph-code-review" "$@"
```

### Success Criteria:

#### Automated Verification:
- [ ] `test -f plugin/ralph-hero/skills/ralph-code-review/SKILL.md`
- [ ] `test -f plugin/ralph-hero/agents/code-review-agent.md`
- [ ] `grep -c "code-review" plugin/ralph-hero/justfile` returns ≥1
- [ ] Skill frontmatter has `context: fork` and `user-invocable: false`

#### Manual Verification:
- [ ] `just code-review NNN` on an issue with an open PR runs code review and reports results
- [ ] If code review finds issues, impl agent enters address mode and pushes fixes
- [ ] If code review is clean, skill reports clean status and stops
- [ ] After 3 failed rounds, issue moves to "Human Needed" (not left in "In Review")

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 4: Wire Integrator Phases into Loop

### Overview
Extend `ralph-loop.sh` with the four integrator phases and add the `--auto-merge` flag.

### Changes Required:

#### 1. Add flag parsing for `--auto-merge`
**File**: `plugin/ralph-hero/scripts/ralph-loop.sh`
**Changes**: Add to the argument parsing block (after line 76):

```bash
        --auto-merge)
            AUTO_MERGE="true"
            ;;
```

And initialize the variable (after line 56):
```bash
AUTO_MERGE="${RALPH_AUTO_MERGE:-false}"
```

Add to the banner output (after line 95):
```bash
echo "Auto-merge: $AUTO_MERGE"
```

Export for child processes:
```bash
export RALPH_AUTO_MERGE="$AUTO_MERGE"
```

#### 2. Add integrator phases to the loop body
**File**: `plugin/ralph-hero/scripts/ralph-loop.sh`
**Changes**: Replace the placeholder integrator section (lines 219-223) with:

```bash
    # === INTEGRATOR PHASE ===

    # Validation phase (verify implementation against plan)
    if [ "$MODE" = "all" ] || [ "$MODE" = "--val-only" ] || [ "$MODE" = "--integrator-only" ]; then
        echo "--- Integrator: Validation Phase ---"
        if run_claude "/ralph-hero:ralph-val" "validate"; then
            work_done=true
        fi
    fi

    # PR creation phase
    if [ "$MODE" = "all" ] || [ "$MODE" = "--pr-only" ] || [ "$MODE" = "--integrator-only" ]; then
        echo "--- Integrator: PR Creation Phase ---"
        if run_claude "/ralph-hero:ralph-pr" "create-pr"; then
            work_done=true
        fi
    fi

    # Code review phase (review + address feedback loop)
    if [ "$MODE" = "all" ] || [ "$MODE" = "--code-review-only" ] || [ "$MODE" = "--integrator-only" ]; then
        echo "--- Integrator: Code Review Phase ---"
        if run_claude "/ralph-hero:ralph-code-review" "code-review"; then
            work_done=true
        fi
    fi

    # Auto-merge phase (only when flag is set)
    if [ "$AUTO_MERGE" = "true" ]; then
        if [ "$MODE" = "all" ] || [ "$MODE" = "--merge-only" ] || [ "$MODE" = "--integrator-only" ]; then
            echo "--- Integrator: Auto-Merge Phase ---"
            if run_claude "/ralph-hero:ralph-merge" "auto-merge"; then
                work_done=true
            fi
        fi
    fi
```

#### 3. Add `--val-only`, `--pr-only`, `--code-review-only`, `--merge-only` to mode parsing
**File**: `plugin/ralph-hero/scripts/ralph-loop.sh`
**Changes**: Extend the case statement (around line 71):

```bash
        --triage-only|--split-only|--research-only|--plan-only|--review-only|--impl-only|--hygiene-only|--val-only|--pr-only|--code-review-only|--merge-only)
            MODE="$arg"
            ;;
```

#### 4. Update justfile `loop` recipe with auto-merge parameter
**File**: `plugin/ralph-hero/justfile`
**Changes**: Update the loop recipe signature (around line 203):

```just
# Sequential autonomous loop - full pipeline through PR + code review + optional merge
[group('orchestrate')]
loop mode="all" review="auto" split="auto" hygiene="auto" budget="8.00" timeout="60m" auto-merge="false":
    #!/usr/bin/env bash
    set -eu
    args=""
    if [ "{{mode}}" != "all" ]; then args="--{{mode}}-only"; fi
    args="$args --review={{review}} --split={{split}} --hygiene={{hygiene}}"
    if [ "{{auto-merge}}" = "true" ]; then args="$args --auto-merge"; fi
    RALPH_BUDGET="{{budget}}" TIMEOUT="{{timeout}}" "{{justfile_directory()}}"/scripts/ralph-loop.sh $args
```

Note: `review` default already changed to `"auto"` in Phase 1. Budget bumped from `5.00` to `8.00` to accommodate code-review + address rounds.

#### 5. Add justfile recipes for new individual phases
**File**: `plugin/ralph-hero/justfile`
**Changes**: Add after the `impl` recipe:

```just
# Validate implementation against plan requirements
[group('workflow')]
val *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=1.00 DEFAULT_TIMEOUT=10m
    _args={{quote(args)}}
    set -- $_args
    dispatch "ralph-val" "$@"

# Create PR for a completed implementation
[group('workflow')]
pr *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=1.00 DEFAULT_TIMEOUT=10m
    _args={{quote(args)}}
    set -- $_args
    dispatch "ralph-pr" "$@"

# Merge an approved PR (checks CI + review status)
[group('workflow')]
merge *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=1.00 DEFAULT_TIMEOUT=10m
    _args={{quote(args)}}
    set -- $_args
    dispatch "ralph-merge" "$@"
```

### Success Criteria:

#### Automated Verification:
- [ ] `grep -c "auto-merge" plugin/ralph-hero/scripts/ralph-loop.sh` returns ≥3 (flag parse, init, banner)
- [ ] `grep -c "ralph-val\|ralph-pr\|ralph-code-review\|ralph-merge" plugin/ralph-hero/scripts/ralph-loop.sh` returns ≥4
- [ ] `grep -c "val-only\|pr-only\|code-review-only\|merge-only" plugin/ralph-hero/scripts/ralph-loop.sh` returns ≥4
- [ ] `just --list | grep -cE "val|pr|merge|code-review"` returns ≥4

#### Manual Verification:
- [ ] `just loop --impl-only` on a completed impl issue → does nothing (wrong phase)
- [ ] `just loop --integrator-only` on an "In Progress" issue with all phases checked → val passes, PR created, code review runs
- [ ] `just loop auto-merge=true --merge-only` on an approved PR → merges and moves to Done

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 5: Make `ralph-merge` Headless-Compatible

### Overview
The merge skill's Step 4 uses `AskUserQuestion` to prompt about code review before merge. In autonomous mode (`RALPH_AUTO_MERGE=true`), skip the interactive prompt and enforce: merge only if `reviewDecision == "APPROVED"` AND `gh pr checks` all pass.

### Changes Required:

#### 1. Add autonomous mode detection to ralph-merge
**File**: `plugin/ralph-hero/skills/ralph-merge/SKILL.md`
**Changes**: In Step 4 (Code Review Gate), add an autonomous path before the AskUserQuestion block.

Insert before the existing `**If no review decision exists**` section:

```markdown
**Autonomous mode** (when `RALPH_AUTO_MERGE` env var is `true`):

Skip the AskUserQuestion entirely. Apply strict merge criteria:

1. Check review decision:
   ```bash
   gh pr view PR_NUMBER --json reviewDecision --jq '.reviewDecision'
   ```

2. Check CI status:
   ```bash
   gh pr checks PR_NUMBER --json name,state,conclusion --jq '[.[] | select(.state == "completed" and .conclusion == "success")] | length'
   gh pr checks PR_NUMBER --json name,state --jq '[.[] | select(.state != "completed")] | length'
   ```

3. Merge criteria (ALL must be true):
   - `reviewDecision` is `"APPROVED"` or issue estimate is `"XS"` with no review comments
   - All CI checks are completed
   - All CI checks have conclusion `"success"`
   - PR state is `OPEN` and `mergeable` is `MERGEABLE`

4. If criteria not met:
   ```
   AUTO-MERGE BLOCKED
   Issue: #NNN
   PR: #PR_NUMBER
   Review: [status]
   CI: [N passed, M pending, K failed]
   Reason: [specific failure]
   ```
   STOP. (The next loop iteration will retry.)

5. If all criteria met: proceed to Step 5 (merge).
```

#### 2. Add `AskUserQuestion` to allowed-tools only in interactive mode
**File**: `plugin/ralph-hero/skills/ralph-merge/SKILL.md`
**Changes**: `AskUserQuestion` is already in allowed-tools. The skill text should check `RALPH_AUTO_MERGE` at runtime and skip the interactive prompt. No frontmatter change needed — the autonomous path simply doesn't call `AskUserQuestion`.

#### 3. Ensure the merge skill outputs "Queue empty" when no mergeable issues exist
**File**: `plugin/ralph-hero/skills/ralph-merge/SKILL.md`
**Changes**: Add a queue-empty path at Step 2. If the issue is not in "In Review":

```
No issues ready for auto-merge. Queue empty.
```

### Success Criteria:

#### Automated Verification:
- [ ] `grep -c "RALPH_AUTO_MERGE" plugin/ralph-hero/skills/ralph-merge/SKILL.md` returns ≥2
- [ ] `grep -c "AUTO-MERGE BLOCKED" plugin/ralph-hero/skills/ralph-merge/SKILL.md` returns ≥1
- [ ] `grep -c "Queue empty" plugin/ralph-hero/skills/ralph-merge/SKILL.md` returns ≥1
- [ ] `grep -c "gh pr checks" plugin/ralph-hero/skills/ralph-merge/SKILL.md` returns ≥1

#### Manual Verification:
- [ ] `RALPH_AUTO_MERGE=true just merge NNN` on a PR with passing CI + approved review → merges
- [ ] `RALPH_AUTO_MERGE=true just merge NNN` on a PR with failing CI → outputs "AUTO-MERGE BLOCKED" and stops
- [ ] `just merge NNN` (no auto-merge flag) → presents AskUserQuestion as before (backwards compatible)

---

## Testing Strategy

### End-to-End Test (Full Loop):
1. Create a test issue in Backlog with XS estimate
2. Run `just loop --triage-only` → issue moves to Research Needed
3. Run `just loop --research-only` → research doc created, issue at Ready for Plan
4. Run `just loop --plan-only` → plan created, issue at Plan in Review
5. Run `just loop --review-only` → auto-approved, issue at In Progress
6. Run `just loop --impl-only` → implementation complete, all phases checked
7. Run `just loop --integrator-only` → val passes, PR created, code review runs, feedback addressed
8. Run `just loop --merge-only` → (should block without `--auto-merge`, or skip)
9. Run `just loop auto-merge=true --merge-only` → merges PR, issue at Done

### Regression Tests:
- `just loop --triage-only` with empty backlog → exits after 1 iteration
- `just loop --review=skip` → skips review phase (backwards compatible)
- `just loop` (no args) → runs full pipeline with auto review (new default)

### Unit-Level Verification:
- Each new phase's "Queue empty" output matches the grep pattern in `run_claude`
- `ralph-code-review` skill stops after 3 rounds max
- `ralph-merge` autonomous mode blocks on failing CI

## Performance Considerations

- `code-review:code-review` spawns 5 parallel Sonnet reviewers — budget ~$2-3 per review round
- Address mode via `ralph-impl` uses `impl-agent` which is **Opus** (`impl-agent.md:model: opus`). Each address round could cost $3-5, not $2-3. Worst case with 3 rounds: ~$9-15 for address mode alone.
- Max 3 review rounds = worst case ~$24 total (3× review at $3 + 3× address at $5)
- The `ralph-code-review` justfile recipe sets `DEFAULT_BUDGET=8.00` and `DEFAULT_TIMEOUT=30m`.
- Loop `budget=8.00` is per-task, but code-review + address spans multiple internal agent invocations within a single `claude -p` call. The `--max-budget-usd` flag applies to the entire session, so $8 should cover 1-2 rounds. For 3 rounds, the session may hit budget limits. Consider `DEFAULT_BUDGET=15.00` for the code-review recipe if budget isn't a concern.

## Migration Notes

- **Backwards compatible**: `just loop --review=skip` still works. `--auto-merge` is opt-in.
- **Default behavior change**: Review mode defaults to `auto` instead of `skip`. Users who relied on the skip default should add `--review=skip` explicitly or set `RALPH_REVIEW_MODE=skip`.
- **No schema changes**: No MCP server changes, no new GitHub Project fields.

## File Ownership Summary

| File | Phase | Action |
|------|-------|--------|
| `skills/ralph-triage/SKILL.md` | 1 | Edit queue-empty text |
| `scripts/ralph-loop.sh` | 1, 4 | Fix defaults, add integrator phases, add flags |
| `justfile` | 1, 3, 4 | Fix review default, add recipes, update loop recipe |
| `skills/ralph-val/SKILL.md` | 2 | Add queue-picking + "Queue empty" path + `list_issues` tool |
| `skills/ralph-pr/SKILL.md` | 2 | Add queue-picking + "Queue empty" path + `list_issues` tool |
| `skills/ralph-merge/SKILL.md` | 2, 5 | Add queue-picking + "Queue empty" path + `list_issues` tool; add autonomous mode |
| `skills/ralph-code-review/SKILL.md` | 3 | **New file** |
| `agents/code-review-agent.md` | 3 | **New file** |

## References

- Original naive hero loop: `landcrawler-ai/scripts/ralph-loop.sh` (Linear-backed, archived)
- Original design: `thoughts/shared/plans/2026-01-19-naive-hero-autonomous-loop.md`
- GitHub migration plan: `thoughts/shared/plans/2026-02-13-group-LAN-361-ralph-github-plugin.md`
- Current loop: `plugin/ralph-hero/scripts/ralph-loop.sh`
- Code review plugin: `~/.claude/plugins/cache/claude-plugins-official/code-review/unknown/commands/code-review.md`
