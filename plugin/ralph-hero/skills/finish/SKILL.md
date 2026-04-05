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

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

# Ralph Finish

Validate, code-review, fix, merge, and watch CI for a completed implementation.

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

## Step 3: Validate (dispatch ralph-val)

Build args for ralph-val:
- Always include the issue number
- If `--plan-doc` was provided, pass it through

```
Skill("ralph-hero:ralph-val", args="NNN --plan-doc {plan_doc}")
```

Or without plan doc:

```
Skill("ralph-hero:ralph-val", args="NNN")
```

Check the skill output for the verdict:

- If output contains `VALIDATION FAIL`: stop with the validation report. The implementation must pass automated checks before proceeding.
- If output contains `VALIDATION PASS`: continue to Step 4.

## Step 4: Code Review

Check if the `code-review:code-review` skill is available (it is an official Anthropic plugin — look for it in available skills).

**If not available**: log that code review was skipped and proceed to Step 6 (merge).

**If available**: invoke code review on the PR:

```
Skill("code-review:code-review", args="PR_NUMBER")
```

Where PR_NUMBER is the pull request number (not the issue number).

After code review completes, check the PR for the review comment:

```bash
gh pr view PR_NUMBER --json comments --jq '[.comments[] | select(.body | test("### Code review|## Code Review|Found [0-9]+ issue"))] | last | .body'
```

Parse the code-review comment to determine findings:

- If no code-review comment found or `No issues found` or `0 issues`: proceed to Step 6 (merge).
- If issues found (`Found N issues` where N > 0): proceed to Step 5 (fix loop).

## Step 5: Fix Loop (max 2 iterations)

Assess the code-review findings using LLM judgment (not keyword matching).

### Assessment

1. Count the number of issues from the review
2. Get the list of files in the PR diff:

```bash
gh pr diff PR_NUMBER --name-only
```

3. Check if all issues reference files in the PR diff
4. Classify each issue:

**Auto-fixable** (all must be true):
- 3 or fewer issues total
- All issues reference files within the PR diff
- Issues are localized code fixes (typos, missing checks, wrong values, style issues)

**Escalate** (any one triggers escalation):
- More than 3 issues
- Issues reference files outside the PR diff
- Architectural or design concerns (restructuring, API design, abstraction choices)
- Operational or cloud infrastructure decisions (permissions, IAM, deploying new cloud APIs, provisioning managed services, secrets management, networking, CI/CD pipeline changes)
- Security concerns that require human judgment
- Any issue where the fix could have unintended side effects beyond the immediate code

This classification is an **LLM judgment call** — evaluate the semantic intent of each finding, not surface-level keywords.

### If escalate

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/ask-user-question.md

```
AskUserQuestion(
  questions=[{
    "question": "Code review found issues that may need human judgment. Review the PR comments and decide how to proceed.",
    "header": "Complex Code Review Findings",
    "options": [
      {"label": "Fix manually", "description": "Stop here — you'll address the feedback yourself"},
      {"label": "Try auto-fix", "description": "Attempt to fix all issues automatically despite complexity"},
      {"label": "Merge anyway", "description": "Skip fixes and proceed to merge"}
    ],
    "multiSelect": false
  }]
)
```

- If user selects **"Fix manually"**: stop.
- If user selects **"Try auto-fix"**: proceed to auto-fix below.
- If user selects **"Merge anyway"**: proceed to Step 6 (merge).

### If auto-fixable (or user chose "Try auto-fix")

Find the worktree directory. Check `worktrees/GH-NNN` relative to git root.

Dispatch a sonnet Agent to fix the issues:

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

After the fix agent completes, re-run code review:

```
Skill("code-review:code-review", args="PR_NUMBER")
```

Re-parse findings:
- If no issues or 0 issues: proceed to Step 6 (merge).
- If still issues and iteration < 2: repeat this step (increment iteration).
- If iteration >= 2 and still issues: escalate to human with the AskUserQuestion above.

## Step 6: Merge (dispatch ralph-merge)

Build args for ralph-merge — always pass the PR URL to avoid redundant lookup:

```
Skill("ralph-hero:ralph-merge", args="NNN --pr-url PR_URL")
```

ralph-merge handles: PR readiness check, merge via `merge-pr.sh`, worktree cleanup, state transition to Done, parent advancement, cross-repo unblock, and posting the Merged comment.

Check the skill output:

- If output contains `MERGE BLOCKED` or `MERGE NOT READY`: report the status and stop.
- If output contains `MERGED`: continue to Step 7.

## Step 7: CI Watch

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

## Step 8: Report Final Status

```
FINISHED
Issue: #NNN
PR: https://github.com/OWNER/REPO/pull/PR_NUMBER
Validation: PASS
Code Review: [PASS / SKIPPED / N issues fixed in K iterations]
Merge: Done
CI: [PASS / FAIL / PENDING (timeout) / SKIPPED (no runs)]
[If CI FAIL: links to failed runs]
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
