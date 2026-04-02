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
  - AskUserQuestion
  - Skill
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

Fetch the full issue details for issue NNN.

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

## Step 4: Code Review Gate

Check whether the PR has received a code review:

```bash
gh pr view NNN --json reviewDecision
```

**If `reviewDecision` is `APPROVED`**: a code review has been performed and approved. Proceed to Step 5.

**If `reviewDecision` is `CHANGES_REQUESTED`**: a code review was performed but the reviewer requested changes. Output:

```
MERGE BLOCKED
Issue: #NNN
PR: #PR_NUMBER
Reason: Reviewer requested changes — address feedback before merging.
```

And stop.

**If no review decision exists** (`reviewDecision` is null or empty):

1. Check if the `code-review:code-review` skill is available by looking for it in the available skills list (it is an official Anthropic plugin).

2. **If the skill is available**, present a choice:

   !cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/ask-user-question.md

   ```
   AskUserQuestion(
     questions=[{
       "question": "This PR has no code review yet. Would you like to run one before merging?",
       "header": "Code Review",
       "options": [
         {"label": "Run code review", "description": "Invoke /code-review:code-review on PR #NNN before merging"},
         {"label": "Merge without review", "description": "Skip code review and proceed to merge"}
       ],
       "multiSelect": false
     }]
   )
   ```

   - If user selects **"Run code review"**: invoke `Skill("code-review:code-review", "PR_NUMBER")` where PR_NUMBER is the PR number obtained in Step 3 (not the issue number). After the review completes, re-check `reviewDecision` via `gh pr view`. If the PR was approved, continue to Step 5. If changes were requested, output the review findings and stop — the user needs to address feedback first.
   - If user selects **"Merge without review"**: proceed to Step 5.
   - If user selects **"Other"**: stop.

3. **If the skill is NOT available**, inform the user:

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

   - If user selects **"Merge without review"**: proceed to Step 5.
   - If user selects **"Stop"** or **"Other"**: stop.

## Step 5: Check PR Readiness

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

## Step 6: Merge PR and Clean Up Worktree

From the project root:

```bash
./scripts/merge-pr.sh PR_NUMBER [WORKTREE_ID]
```

Where PR_NUMBER is the PR number and WORKTREE_ID is the worktree name (e.g., GH-NNN).
For group/epic worktrees, pass the worktree ID explicitly. If omitted, it is inferred
from the PR's head branch.

If merge fails, report the error and stop.

## Step 7: Move Issues to Done

Advance all children of the issue to "Done". For a standalone issue: update the workflow state to "Done" (command: "ralph_merge").

## Step 8: Advance Parent

If applicable: advance the parent issue to the next appropriate state based on its children's states.

## Step 9: Post Completion Comment

Post a completion comment on the issue:
```markdown
## Merged

PR merged successfully. Issue moved to Done.
```

## Step 9a: Cross-Repo Unblock Check

After merging a PR, check if cross-repo dependents are now unblocked:

1. **Check for blockedBy dependents:** Call `list_dependencies` for the parent issue to find downstream issues that were blocked by the just-merged issue. Use `list_sub_issues` on the parent to enumerate siblings.

2. **If cross-repo dependents exist:**
   - Check each dependent's `blockedBy` list via `get_issue`
   - If the merged issue was the only blocker, the dependent is now actionable
   - Post a comment on the parent issue via `create_comment`: "GH-601 (ralph-hero) merged. GH-602 (landcrawler-ai) is now unblocked and ready for implementation."

3. **This is informational only.** The downstream issue becomes actionable through the normal pipeline (picked up by `/ralph-hero` or the next loop iteration). No automated cascade triggering.

## Step 9b: Upstream PR Rejection

**Detection trigger:** Ralph-merge is invoked to merge a specific PR. If it discovers the PR has already been closed without merge (via `gh pr view --json state,mergedAt`), this is a rejection.

**When a rejection is detected:**
1. Query the parent issue to find downstream sibling issues blocked by the rejected issue
2. Downstream blocked issues remain in their blocked state — do NOT advance them
3. Post a notification via `create_comment` on the parent issue: "PR #{number} for GH-{issue} ({repo}) was closed without merge. GH-{downstream} ({repo}) remains blocked pending resolution."
4. The human decides next steps (re-open, re-plan, etc.)

## Step 10: Report Result

Output completion status:

```
MERGED
Issue: #NNN
PR: https://github.com/owner/repo/pull/NNN
State: Done
```

## Link Formatting

**Single-repo (default):**

| Reference type | Format |
|---------------|--------|
| File only | `[path/file.py](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py)` |
| With line | `[path/file.py:42](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42)` |
| Line range | `[path/file.py:42-50](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42-L50)` |

**Cross-repo:** Resolve owner/repo from the registry entry for each file:
- `[repo-name:path/file.py](https://github.com/{owner}/{repo}/blob/main/path/file.py)`

When operating on a cross-repo issue, look up each file's repo in the registry to get the correct `owner` and repo name for link URLs. Do NOT hardcode `$RALPH_GH_OWNER/$RALPH_GH_REPO` for files in other repos.
