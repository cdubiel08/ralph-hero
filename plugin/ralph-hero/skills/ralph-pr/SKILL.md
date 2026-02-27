---
description: Create a pull request for a completed implementation — pushes branch, creates PR via gh, moves issues to In Review. Use when you want to create a PR for a completed issue.
argument-hint: <issue-number> [--worktree path]
context: fork
model: haiku
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=pr RALPH_VALID_OUTPUT_STATES='In Review,Human Needed'"
  PreToolUse:
    - matcher: "ralph_hero__update_workflow_state|ralph_hero__advance_children"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/pr-state-gate.sh"
  PostToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-verify-pr.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/pr-postcondition.sh"
allowed-tools:
  - Read
  - Glob
  - Bash
  - ralph_hero__get_issue
  - ralph_hero__list_sub_issues
  - ralph_hero__advance_children
  - ralph_hero__update_workflow_state
  - ralph_hero__create_comment
---

# Ralph PR

Create a pull request for a completed implementation and move issues to In Review.

## Step 1: Parse Arguments

Extract issue number and optional `--worktree` flag from args:

```
args: "NNN"                           -> issue_number=NNN, worktree=nil
args: "NNN --worktree path/to/dir"   -> issue_number=NNN, worktree=path
```

Export: `export RALPH_TICKET_ID="GH-NNN"`

## Step 2: Fetch Issue

```
ralph_hero__get_issue(number=NNN)
```

Get issue title, state, group context, and sub-issues.

## Step 3: Determine Worktree and Branch

If `--worktree` was provided, use that path directly.

Otherwise, check `worktrees/GH-NNN` relative to the git root.

For group issues (with sub-issues), use the primary issue number for the branch name.

Branch name: `feature/GH-NNN`

If no worktree exists, output an error and stop.

## Step 4: Push Branch

From the worktree directory:

```bash
git push -u origin feature/GH-NNN
```

If push fails, report the error and stop.

## Step 5: Create Pull Request

```bash
gh pr create \
  --title "GH-NNN: [issue title]" \
  --body "## Summary

[Brief description from issue]

Closes #NNN" \
  --head feature/GH-NNN \
  --base main
```

For group issues, include `Closes #NNN` for each sub-issue in the body.

Capture the PR URL from the output.

## Step 6: Move Issues to In Review

```
ralph_hero__advance_children(parentNumber=NNN, targetState="In Review")
```

Or for a standalone issue:

```
ralph_hero__update_workflow_state(number=NNN, state="In Review")
```

## Step 7: Post Comment

Post a comment on the issue with the PR URL:

```
ralph_hero__create_comment(number=NNN, body="## Pull Request\n\nPR created: [PR URL]\n\nIssue moved to In Review.")
```

## Step 8: Report Result

Output the PR URL for the caller:

```
PR CREATED
Issue: #NNN
PR: https://github.com/owner/repo/pull/NNN
State: In Review
```
