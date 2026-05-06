---
description: Validate, run code review, merge, and watch CI for a completed implementation. Owns the code review gate (preserves depth-0 fan-out for the code-review:code-review plugin); when RALPH_REVIEW_MODE=auto and code review flags issues, dispatches impl-agent to fix them then re-runs code review (max 1 fix cycle). Once review resolves, dispatches ralph-merge for merge mechanics only.
user-invocable: true
argument-hint: <issue-number> [--pr-url url] [--plan-doc path]
context: inline
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
  - Glob
  - Grep
  - Bash
  - Skill
  - Agent
  - AskUserQuestion
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_dependencies
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__advance_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`
- Review mode: !`echo ${RALPH_REVIEW_MODE:-interactive}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

# Ralph Finish

Validate, run code review, merge, and watch CI for a completed implementation. Finish owns the code review gate (so the `code-review:code-review` plugin's parallel-agent fan-out always runs at depth 0, depth-2 safe). When `RALPH_REVIEW_MODE=auto` and code review flags issues, finish dispatches impl-agent to fix them, then re-runs code review (max 1 fix cycle). Once review passes, finish dispatches `ralph-merge` for merge mechanics only.

## Step 1: Parse Arguments

Extract issue number and optional flags from args:

```
args: "NNN"                                          -> issue_number=NNN, pr_url=nil, plan_doc=nil
args: "NNN --pr-url https://..."                     -> issue_number=NNN, pr_url=provided, plan_doc=nil
args: "NNN --plan-doc path/to/doc"                   -> issue_number=NNN, pr_url=nil, plan_doc=provided
args: "NNN --pr-url https://... --plan-doc path/doc" -> all three provided
```

Export: `export RALPH_TICKET_ID="GH-NNN"`

## Step 2: Fetch Issue & Find PR

Fetch the full issue details for issue NNN.

Verify the issue is in "In Review" state. If not, output:

```
FINISH BLOCKED
Issue: #NNN
Current state: [state]
Required state: In Review
```

And stop.

Find the PR:

1. If `--pr-url` was provided, extract the PR number from it.
2. Otherwise, search for the PR:

```bash
gh pr list --head feature/GH-NNN --json number,url,state --jq '.[0]'
```

If no PR found, output:

```
FINISH BLOCKED
Issue: #NNN
Reason: No pull request found for feature/GH-NNN
```

And stop.

Store PR_NUMBER and PR_URL for use in later steps.

## Step 3: Validate (dispatch val-agent)

Dispatch validation as an agent:

```
Agent(subagent_type="ralph-hero:val-agent", prompt="Validate GH-NNN. Plan doc: {plan_doc or 'discover from issue comments'}")
```

Check the agent output for the verdict:

- If output contains `VALIDATION PASS`: continue to Step 4.
- If output contains `VALIDATION FIX`: mechanical issues only (formatting, lint). Dispatch impl-agent to apply the listed fix commands in the worktree, commit, then re-run val-agent. Max 1 fix cycle — if it still fails after fixes, treat as FAIL.
- If output contains `VALIDATION FAIL`: stop with the validation report. Substantive failures require implementation work.

## Step 4: Code Review Gate

> **Why code review runs HERE (not inside ralph-merge):**
>
> The `code-review:code-review` plugin spawns 5 parallel Sonnet reviewers + N parallel Haiku scorers via the `Agent` tool. Those parallel agents land at depth 1 only when `code-review:code-review` itself is invoked from depth 0. By keeping the code review gate inline in finish (which runs at depth 0), we preserve the parallel-agent fan-out. If code review were dispatched from inside an agent context, the runtime's no-depth-2-Agent rule would silently break the parallel reviewers.

Check whether the PR has received a code review:

```bash
gh pr view PR_NUMBER --json reviewDecision --jq '.reviewDecision'
```

**If `reviewDecision` is `APPROVED`**: a code review has been performed and approved. Proceed to Step 5.

**If `reviewDecision` is `CHANGES_REQUESTED`**: a human reviewer (not the automated code-review skill) requested changes. Output:

```
FINISH BLOCKED
Issue: #NNN
PR: #PR_NUMBER
Reason: Human reviewer requested changes — address feedback before merging.
```

And stop.

**If no review decision exists** (`reviewDecision` is null or empty), branch on `RALPH_REVIEW_MODE`:

### Auto mode (`RALPH_REVIEW_MODE=auto`)

Run code review automatically — do NOT prompt the user:

```
Skill("code-review:code-review", "PR_NUMBER")
```

The `code-review:code-review` skill runs inline at depth 0; its parallel reviewer agents land at depth 1 (legal). After the review skill completes, re-check `reviewDecision`:

```bash
gh pr view PR_NUMBER --json reviewDecision --jq '.reviewDecision'
```

- If `APPROVED`: continue to Step 5.
- If `CHANGES_REQUESTED`: proceed to Step 4a (Code Review Fix Cycle).

### Interactive mode (`RALPH_REVIEW_MODE=interactive`, default)

Present a choice:

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/ask-user-question.md

```
AskUserQuestion(
  questions=[{
    "question": "This PR has no code review yet. Would you like to run one before merging?",
    "header": "Code Review",
    "options": [
      {"label": "Run code review", "description": "Invoke /code-review:code-review on PR #PR_NUMBER before merging"},
      {"label": "Merge without review", "description": "Skip code review and proceed to merge"}
    ],
    "multiSelect": false
  }]
)
```

- If user selects **"Run code review"**: invoke `Skill("code-review:code-review", "PR_NUMBER")`. After it completes, re-check `reviewDecision`. If `APPROVED`, continue to Step 5. If `CHANGES_REQUESTED`, proceed to Step 4a.
- If user selects **"Merge without review"**: continue to Step 5.
- If user selects **"Other"**: stop.

### Skill not available

If the `code-review:code-review` skill is NOT installed:

```
This PR has no code review. Consider installing the code-review plugin:
  claude plugins install @anthropic/code-review
```

Then present:

```
AskUserQuestion(
  questions=[{
    "question": "Proceed without code review?",
    "header": "No Code Review Plugin",
    "options": [
      {"label": "Merge without review", "description": "Skip code review and proceed to merge"},
      {"label": "Stop", "description": "Stop here — install the code-review plugin first"}
    ],
    "multiSelect": false
  }]
)
```

- If user selects **"Merge without review"**: continue to Step 5.
- If user selects **"Stop"** or **"Other"**: stop.

## Step 4a: Code Review Fix Cycle

Triggered when the auto code review (or interactive "Run code review") returned `CHANGES_REQUESTED`.

Dispatch impl-agent in Address Mode to fix the flagged issues. The issue is already "In Review" with an open PR that has review comments — impl-agent will auto-detect Address Mode.

```
Agent(subagent_type="ralph-hero:impl-agent", prompt="Address PR review feedback for GH-NNN. The automated code review flagged issues on PR #PR_NUMBER. Fix the MUST_FIX and SHOULD_FIX items, push, and reply to comments.")
```

After impl-agent completes, re-run code review once:

```
Skill("code-review:code-review", "PR_NUMBER")
```

Then re-check `reviewDecision`:

- If `APPROVED`: continue to Step 5.
- If `CHANGES_REQUESTED` again: stop. Max 1 fix cycle. Output:

```
FINISH BLOCKED
Issue: #NNN
PR: #PR_NUMBER
Reason: Code review feedback unresolved after 1 fix cycle.
```

## Step 5: Merge (dispatch ralph-merge)

Code review has resolved (approved, skipped by user, or no skill available). Dispatch ralph-merge for merge mechanics only — always pass the PR URL to avoid redundant lookup:

```
Skill("ralph-hero:ralph-merge", args="NNN --pr-url PR_URL")
```

ralph-merge is now a leaf skill: it handles PR readiness check, merge via `merge-pr.sh`, worktree cleanup, state transition to Done, parent advancement, cross-repo unblock, and posting the Merged comment. It does NOT run code review (that's owned by Step 4 above).

Check the skill output:

- If output contains `MERGE BLOCKED` or `MERGE NOT READY`: report the status and stop.
- If output contains `MERGED`: continue to Step 6.

## Step 6: CI Watch

After merge completes, watch CI checks on the merge commit.

```bash
MERGE_SHA=$(gh pr view PR_NUMBER --json mergeCommit --jq '.mergeCommit.oid')
```

Poll every 30 seconds for up to 10 minutes:

```bash
gh run list --commit "$MERGE_SHA" --json status,conclusion,name,url --limit 10
```

Check the results:
- If all runs have `conclusion=success`: CI passed.
- If any run has `conclusion=failure`: CI failed.
- If any run still has `status=in_progress` or `status=queued`: keep polling.
- If 10 minutes elapsed and runs are still in progress: report timeout.

If no runs are found for the merge commit (e.g., no CI configured), report CI as skipped.

## Step 7: Report Final Status

```
FINISHED
Issue: #NNN
PR: https://github.com/OWNER/REPO/pull/PR_NUMBER
Validation: PASS
Merge: Done
CI: [PASS / FAIL / PENDING (timeout) / SKIPPED (no runs)]
[If CI FAIL: links to failed runs]
```

## Link Formatting

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/link-formatting.md
