---
description: Merge an approved pull request — checks PR readiness, merges, cleans up worktree, moves issues to Done. Use when you want to merge a PR for a completed issue.
user-invocable: false
argument-hint: <issue-number> [--pr-url url]
context: fork
model: haiku
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=merge RALPH_VALID_OUTPUT_STATES='Done,Human Needed'"
  PreToolUse:
    - matcher: "ralph_hero__save_issue|ralph_hero__advance_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/merge-state-gate.sh"
allowed-tools:
  - Read
  - Glob
  - Bash
  - ralph_hero__get_issue
  - ralph_hero__list_sub_issues
  - ralph_hero__advance_issue
  - ralph_hero__save_issue
  - ralph_hero__create_comment
---

# Ralph Merge

Merge an approved pull request and move issues to Done.

## Step 1: Parse Arguments

Extract issue number and optional `--pr-url` flag from args:

```
args: "NNN"                         -> issue_number=NNN, pr_url=nil
args: "NNN --pr-url https://..."    -> issue_number=NNN, pr_url=provided
```

Export: `export RALPH_TICKET_ID="GH-NNN"`

## Step 2: Fetch Issue

```
ralph_hero__get_issue(number=NNN)
```

Verify the issue is in "In Review" state. If not, output:

```
MERGE BLOCKED
Issue: #NNN
Current state: [state]
Required state: In Review
```

And stop.

## Step 3: Find Pull Request

If `--pr-url` was provided, use it directly.

Otherwise:

```bash
gh pr list --head feature/GH-NNN --json number,url,state --jq '.[0]'
```

If no PR found, report and stop.

## Step 4: Check PR Readiness

```bash
gh pr view NNN --json mergeable,reviewDecision,state
```

Check:
- `state` is `OPEN`
- `mergeable` is `MERGEABLE`
- `reviewDecision` is `APPROVED` or null (no review required)

If not ready, output status and stop:

```
MERGE NOT READY
Issue: #NNN
PR: #NNN
Mergeable: [status]
Review: [status]
State: [state]
```

The integrator will retry when ready.

## Step 5: Merge PR and Clean Up Worktree

From the project root:

```bash
./scripts/merge-pr.sh PR_NUMBER [WORKTREE_ID]
```

Where PR_NUMBER is the PR number and WORKTREE_ID is the worktree name (e.g., GH-NNN).
For group/epic worktrees, pass the worktree ID explicitly. If omitted, it is inferred
from the PR's head branch.

If merge fails, report the error and stop.

## Step 6: Move Issues to Done

```
ralph_hero__advance_issue(direction="children", number=NNN, targetState="Done")
```

Or for a standalone issue:

```
ralph_hero__save_issue(number=NNN, workflowState="Done", command="ralph_merge")
```

## Step 7: Advance Parent

If applicable:

```
ralph_hero__advance_issue(direction="parent", number=NNN)
```

## Step 8: Post Completion Comment

```
ralph_hero__create_comment(number=NNN, body="## Merged\n\nPR merged successfully. Issue moved to Done.")
```

## Step 9: Report Result

Output completion status:

```
MERGED
Issue: #NNN
PR: https://github.com/owner/repo/pull/NNN
State: Done
```
