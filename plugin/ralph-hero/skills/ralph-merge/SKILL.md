---
description: Merge a pull request after code review — handles review gate, merges, cleans up worktree, moves issues to Done. Use when you want to merge a PR for a completed issue.
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
    - matcher: "ralph_hero__save_issue"
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
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_dependencies
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`
- Review mode: !`echo ${RALPH_REVIEW_MODE:-interactive}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

# Ralph Merge

Merge an approved pull request and move issues to Done.

## Step 1: Parse Arguments

Extract issue number and optional `--pr-url` flag from args:

```
args: "NNN"                         -> issue_number=NNN, pr_url=nil
args: "NNN --pr-url https://..."    -> issue_number=NNN, pr_url=provided
args: ""                            -> issue_number=nil, queue-pick (see below)
```

Export: `export RALPH_TICKET_ID="GH-NNN"`

**If no issue number** is provided, run the queue-picking branch:

1. Query `list_issues(workflowState: "In Review", limit: 10)` for candidates whose PR has been created and is awaiting merge.
2. For each candidate (in returned order), check whether an open PR exists on the candidate's branch:
   ```bash
   gh pr list --head feature/GH-NNN --json number,state --jq '.[0]'
   ```
   A non-null result with `state: OPEN` indicates the candidate is eligible for merge.
3. The first candidate with an open PR is the selected issue.
4. If no candidate has an open PR, output the literal line and STOP:

   ```
   Queue empty.
   ```

   This is the token the loop runner greps for to detect an empty merge queue (`grep -qiE "Queue empty|Triage complete"`).
5. Otherwise, set `issue_number` to the selected candidate and continue with Step 2 as if the number had been passed in as an argument.

This branch mirrors the queue-picking pattern in `ralph-impl/SKILL.md` Step 1 so the loop runner can invoke `just merge` argument-less.

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

> **Output contract for callers (orchestrators: ralph-finish, ralph-hero):**
>
> This step can produce three distinct stop statuses that callers MUST handle:
>
> | Status | Meaning | Caller action |
> |--------|---------|---------------|
> | `MERGE BLOCKED` | A human reviewer requested changes (manual `CHANGES_REQUESTED` review on GitHub). Hard block. | Stop. Surface to human; do NOT auto-fix. |
> | `CODE_REVIEW_FEEDBACK` | Auto-mode code review (via `code-review:code-review` skill) requested changes. Soft block — fix cycle is appropriate. | Dispatch impl-agent to address review findings, then re-invoke ralph-merge. |
> | `MERGE NOT READY` | PR is open but not mergeable (conflicts, draft, missing review). Transient. | Retry later or escalate. |
>
> The distinction between `MERGE BLOCKED` and `CODE_REVIEW_FEEDBACK` matters: a caller that only handles `MERGE BLOCKED` will treat `CODE_REVIEW_FEEDBACK` as an unrecognized status and lose the auto-fix opportunity. Orchestrators MUST switch on all three statuses.

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

2. **If the skill is available AND review mode is "auto":**

   Run code review automatically — do NOT prompt the user:

   ```
   Skill("code-review:code-review", "PR_NUMBER")
   ```

   After the review completes, re-check `reviewDecision` via `gh pr view`.

   - If the PR was approved: continue to Step 5.
   - If changes were requested: output the review findings with a distinct status so the caller (finish) can dispatch a fix cycle:

   ```
   CODE_REVIEW_FEEDBACK
   Issue: #NNN
   PR: #PR_NUMBER
   Reason: Automated code review flagged issues — impl-agent fix cycle available.
   ```

   And stop. Do NOT output `MERGE BLOCKED` for automated review feedback — the `CODE_REVIEW_FEEDBACK` status signals that finish should attempt a fix cycle.

3. **If the skill is available AND review mode is "interactive" (default):**

   Present a choice:

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

4. **If the skill is NOT available**, inform the user:

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

## Step 4a: Autonomous Merge Gate

**Runs only when `RALPH_AUTO_MERGE=true`.** When the env var is unset or set to anything else (the standalone `just merge NNN` case), skip this step entirely and continue with the existing flow at Step 5 — backwards compatibility with interactive merging is preserved.

This gate is the safety net that lets the loop runner (`scripts/ralph-loop.sh --auto-merge`) merge approved PRs autonomously. It is intentionally orthogonal to `RALPH_REVIEW_MODE` (which only gates the code-review step in Step 4): you can have auto code-review without auto-merge, and vice versa.

```bash
if [ "${RALPH_AUTO_MERGE:-false}" != "true" ]; then
    echo "RALPH_AUTO_MERGE not set; skipping autonomous merge gate."
    # fall through to Step 5 — interactive flow
fi
```

When `RALPH_AUTO_MERGE=true`, evaluate **all** of the following criteria. If any one fails, output `AUTO-MERGE BLOCKED` (see below) and STOP. The loop will retry on the next iteration.

### Criteria (ALL must hold)

1. **Review approved**: `gh pr view PR_NUMBER --json reviewDecision --jq '.reviewDecision'` returns `APPROVED`.
   - Exception: an XS-estimated issue with zero review comments is treated as approved (small changes do not require explicit review approval). Use `gh pr view PR_NUMBER --json comments --jq '.comments | length'` and the issue's `estimate` field to detect this case.
2. **CI green**: `gh pr checks PR_NUMBER --json name,state,conclusion` returns checks where every entry has `state: completed` AND `conclusion: success`. Pending or failing checks block the merge.
3. **PR open and mergeable**: `gh pr view PR_NUMBER --json state,mergeable --jq '{state,mergeable}'` shows `state: OPEN` and `mergeable: MERGEABLE`. A `CONFLICTING` or `UNKNOWN` mergeable status blocks.

### Recommended invocation

```bash
review_decision=$(gh pr view "$PR_NUMBER" --json reviewDecision --jq '.reviewDecision')
ci_status=$(gh pr checks "$PR_NUMBER" --json name,state,conclusion)
pr_state=$(gh pr view "$PR_NUMBER" --json state,mergeable --jq '{state,mergeable}')
```

Then evaluate the three criteria together. The XS exception is checked only if `review_decision` is null/empty.

### On miss — `AUTO-MERGE BLOCKED`

If any criterion fails, output the following block and STOP. The block uses a distinct status string so callers (including the loop runner) can distinguish it from `MERGE BLOCKED` (human change request) and `MERGE NOT READY` (transient mergeability issue):

```
AUTO-MERGE BLOCKED
Issue: #NNN
PR: #PR_NUMBER
Review: [APPROVED|CHANGES_REQUESTED|REVIEW_REQUIRED|null]
CI: [summary — e.g., "2/5 checks pending", "1 failing: lint", "all green"]
Reason: [first failing criterion in plain English]
```

The next loop iteration will re-evaluate. There is no fix cycle here — `RALPH_AUTO_MERGE` only merges when everything is already green; it never edits code.

### On pass

All criteria hold. Proceed to Step 5 (the existing readiness check + merge flow).

## Step 5: Check PR Readiness (with Rejection Detection)

```bash
gh pr view NNN --json mergeable,reviewDecision,state,mergedAt
```

This single call covers both readiness and the "PR was rejected/closed without merge" detection that previously lived in Step 9b — handle both branches here:

**Branch A — Rejection detected (PR closed without merge):**

If `state` is `CLOSED` and `mergedAt` is null, the PR was rejected. Skip the merge entirely and run the rejection notification flow from Step 9b (post a notification on the parent issue, leave downstream blocked issues in their blocked state, do NOT advance anything).

**Branch B — Readiness check (PR still open):**

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

## Step 9b: Upstream PR Rejection (handler)

**Detection** is performed in Step 5 Branch A (`state == CLOSED && mergedAt == null`) — that single `gh pr view` call covers both readiness and rejection. When Step 5 routes here, run the notification flow:

**Rejection-handling steps:**
1. Query the parent issue to find downstream sibling issues blocked by the rejected issue
2. Downstream blocked issues remain in their blocked state — do NOT advance them
3. Post a notification via `create_comment` on the parent issue: "PR #{number} for GH-{issue} ({repo}) was closed without merge. GH-{downstream} ({repo}) remains blocked pending resolution."
4. The human decides next steps (re-open, re-plan, etc.)

Then stop — do not run Steps 6-9 (no merge, no Done transition).

## Step 10: Report Result

Output completion status:

```
MERGED
Issue: #NNN
PR: https://github.com/owner/repo/pull/NNN
State: Done
```

## Link Formatting

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/link-formatting.md
