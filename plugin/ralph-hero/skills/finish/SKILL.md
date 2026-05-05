---
description: Validate, merge, and watch CI for a completed implementation. Chains ralph-val → ralph-merge → CI watch into one command. Code review is handled by ralph-merge's built-in gate; when RALPH_REVIEW_MODE=auto and code review flags issues, dispatches impl-agent to fix them.
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

Use these resolved values when constructing GitHub URLs or referencing the repository.

# Ralph Finish

Validate, merge, and watch CI for a completed implementation. Code review is handled by ralph-merge's built-in gate — when `RALPH_REVIEW_MODE=auto`, finish also orchestrates a code-review → impl-fix → re-merge cycle if the automated review flags issues (max 1 fix cycle).

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

## Step 4: Merge (dispatch ralph-merge)

Build args for ralph-merge — always pass the PR URL to avoid redundant lookup:

```
Skill("ralph-hero:ralph-merge", args="NNN --pr-url PR_URL")
```

ralph-merge handles: code review gate (including optional `code-review:code-review` dispatch), PR readiness check, merge via `merge-pr.sh`, worktree cleanup, state transition to Done, parent advancement, cross-repo unblock, and posting the Merged comment.

Check the skill output:

- If output contains `MERGE BLOCKED` or `MERGE NOT READY`: report the status and stop.
- If output contains `MERGED`: continue to Step 5.
- If output contains `CODE_REVIEW_FEEDBACK`: automated code review flagged issues. Proceed to Step 4a.

## Step 4a: Code Review Fix Cycle

Dispatch impl-agent in Address Mode to fix the flagged issues. The issue is already "In Review" with an open PR that has review comments — impl-agent will auto-detect Address Mode.

```
Agent(subagent_type="ralph-hero:impl-agent", prompt="Address PR review feedback for GH-NNN. The automated code review flagged issues on PR #PR_NUMBER. Fix the MUST_FIX and SHOULD_FIX items, push, and reply to comments.")
```

After impl-agent completes, re-run ralph-merge:

```
Skill("ralph-hero:ralph-merge", args="NNN --pr-url PR_URL")
```

Check the output again:

- If `MERGED`: continue to Step 5.
- If `MERGE BLOCKED`, `MERGE NOT READY`, or `CODE_REVIEW_FEEDBACK` again: stop. Max 1 fix cycle — report the status and let the human intervene.

## Step 5: CI Watch

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

## Step 6: Report Final Status

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
