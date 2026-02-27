---
description: Merge an approved pull request — checks PR readiness, merges, cleans up worktree, moves issues to Done. Use when you want to merge a PR for a completed issue.
argument-hint: <issue-number> [--pr-url url]
context: fork
model: haiku
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=merge RALPH_VALID_OUTPUT_STATES='Done,Human Needed'"
  PreToolUse:
    - matcher: "ralph_hero__update_workflow_state|ralph_hero__advance_children|ralph_hero__advance_parent"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/merge-state-gate.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/merge-postcondition.sh"
allowed-tools:
  - Read
  - Glob
  - Bash
  - ralph_hero__get_issue
  - ralph_hero__list_sub_issues
  - ralph_hero__advance_children
  - ralph_hero__advance_parent
  - ralph_hero__update_workflow_state
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

## Step 5: Merge PR

```bash
gh pr merge NNN --merge --delete-branch
```

If merge fails, report the error and stop.

## Step 6: Clean Up Worktree

```bash
./scripts/remove-worktree.sh GH-NNN
```

Run from the project root. If cleanup fails, warn but continue — the merge was successful.

## Step 7: Move Issues to Done

```
ralph_hero__advance_children(parentNumber=NNN, targetState="Done")
```

Or for a standalone issue:

```
ralph_hero__update_workflow_state(number=NNN, state="Done")
```

## Step 8: Advance Parent

If applicable:

```
ralph_hero__advance_parent(childNumber=NNN)
```

## Step 9: Post Completion Comment

```
ralph_hero__create_comment(number=NNN, body="## Merged\n\nPR merged successfully. Issue moved to Done.")
```

## Step 10: Report Result

Output completion status:

```
MERGED
Issue: #NNN
PR: https://github.com/owner/repo/pull/NNN
State: Done
```
