---
description: Run code review on an "In Review" issue's PR via the code-review:code-review skill, then dispatch impl-agent in Address Mode to fix any feedback. Loops up to 3 rounds before escalating to Human Needed. Use when you want autonomous post-PR code-review-and-fix cycles.
user-invocable: false
argument-hint: [optional-issue-number]
context: fork
model: sonnet
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=code-review RALPH_VALID_OUTPUT_STATES='In Review,Human Needed'"
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

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

# Ralph Code Review

Run automated code review on a PR for an "In Review" issue, then dispatch `impl-agent` in Address Mode to fix any review feedback. Loops up to **3 rounds** before escalating to "Human Needed".

## Architecture Notes

**Why this skill is read-only**: This skill ORCHESTRATES code review and fix cycles — it does NOT modify code itself. All write operations (Edit, Write, git commits) are performed by the nested `impl-agent` dispatched in Step 5. The `code-review-agent` and this skill intentionally have no Write/Edit in `allowed-tools` to enforce the boundary.

**Budget vs. rounds reconciliation**: The justfile recipe sets `DEFAULT_BUDGET=8.00`. Three review-and-fix rounds at ~$3 (review) + ~$5 (impl fix) = ~$24 worst case, which exceeds the budget. The 3-round cap is therefore enforced **at the loop level** in this skill (counter + max), NOT at the budget level. If the budget is exhausted before 3 rounds complete, the skill exits cleanly via the standard budget-exhaustion path (the wrapper kills the process). The 3-round invariant only holds when the budget is sufficient.

## Step 1: Select Issue

**If issue number provided**: Skip to Step 2 with that number.

**If no issue number** is provided, run the queue-picking branch:

1. Query `list_issues(workflowState: "In Review", limit: 10)` for candidates whose PR has been created and is awaiting code review.
2. For each candidate (in returned order), check whether an open PR exists on the candidate's branch:
   ```bash
   gh pr list --head feature/GH-NNN --json number,state --jq '.[0]'
   ```
   A non-null result with `state: OPEN` indicates the candidate is eligible for code review.
3. The first candidate with an open PR is the selected issue.
4. If no candidate has an open PR, output the literal line and STOP:

   ```
   Queue empty.
   ```

   This is the token the loop runner greps for to detect an empty code-review queue (`grep -qiE "Queue empty|Triage complete"`).
5. Otherwise, set `issue_number` to the selected candidate and continue with Step 2 as if the number had been passed in as an argument.

This branch mirrors the queue-picking pattern in `ralph-merge/SKILL.md` Step 1 so the loop runner can invoke `just code-review` argument-less.

Export: `export RALPH_TICKET_ID="GH-NNN"`

Initialize the round counter: `ROUND=1`, `MAX_ROUNDS=3`.

## Step 2: Find PR

Look up the open PR on the issue's feature branch:

```bash
gh pr list --head feature/GH-NNN --json number,url,state --jq '.[0]'
```

If no open PR is found, output:

```
CODE REVIEW BLOCKED
Issue: #NNN
Reason: No open PR found on feature/GH-NNN — cannot run code review without a PR.
```

And stop.

Capture `PR_NUMBER` and `PR_URL` from the response.

## Step 3: Check Existing Review State

Before invoking the code-review skill, check whether the PR already has a review decision:

```bash
gh pr view PR_NUMBER --json reviewDecision --jq '.reviewDecision'
```

- If `reviewDecision` is `APPROVED`: the PR has already been reviewed and approved. Output:
  ```
  Code review already approved.
  Issue: #NNN
  PR: PR_URL
  ```
  And stop.

- If `reviewDecision` is `CHANGES_REQUESTED` and the requestor was a human (not the code-review skill): treat this as a hard human block. Output:
  ```
  CODE REVIEW BLOCKED
  Issue: #NNN
  PR: PR_URL
  Reason: Human reviewer requested changes — human must address feedback or re-review.
  ```
  And stop. (Distinguish from the skill-driven feedback loop: a human-requested CHANGES_REQUESTED is outside this skill's loop authority.)

- Otherwise (`null`, `REVIEW_REQUIRED`, or no decision yet): proceed to Step 4.

## Step 4: Run Code Review

Record the PR comment count BEFORE invoking the review skill, so the comparison in this same step uses identical commands:

```bash
BEFORE_COUNT=$(gh pr view PR_NUMBER --json comments --jq '.comments | length')
```

Invoke the official code-review skill (positional PR number argument, matching the existing pattern in `ralph-merge/SKILL.md:123`):

```
Skill("code-review:code-review", "PR_NUMBER")
```

After the review skill completes, re-query the same JSON field with the same command (idempotent before/after pair):

```bash
AFTER_COUNT=$(gh pr view PR_NUMBER --json comments --jq '.comments | length')
```

**If `AFTER_COUNT == BEFORE_COUNT`** (no new comments posted by the review skill), the PR is clean. Output and stop:

```
Code review clean — no issues found
Issue: #NNN
PR: PR_URL
Round: ROUND of MAX_ROUNDS
```

The issue stays in "In Review" — no state change required.

**If `AFTER_COUNT > BEFORE_COUNT`** (new review comments posted), proceed to Step 5 to address them.

## Step 5: Address Feedback (Fix Loop)

Dispatch `impl-agent` to enter Address Mode and push fixes for the new review comments:

```
Agent(
  subagent_type="ralph-hero:impl-agent",
  prompt="Address PR review feedback for issue #NNN. The issue is in 'In Review' state with an open PR (feature/GH-NNN). Run ralph-impl in Address Mode (Step 2 detection): scan PR review comments, classify (MUST_FIX / SHOULD_FIX / DISCUSS), apply fixes in the worktree, commit, push, and reply to comments. Do NOT change the workflow state — keep it in 'In Review'.",
  description="Address code review feedback for #NNN (round ROUND/MAX_ROUNDS)"
)
```

The `impl-agent` runs in its own context. It will:
1. Detect the "In Review" + open PR state and enter Address Mode (per `ralph-impl/SKILL.md` Step 2 / Steps A1–A7).
2. Reuse the existing worktree at `worktrees/GH-NNN`.
3. Apply MUST_FIX and SHOULD_FIX changes; reply to DISCUSS comments.
4. Commit and push fixes; reply to PR comments with change references.
5. Leave the issue in "In Review".

If the dispatched `impl-agent` returns a status indicating it could not address the feedback (e.g., escalation, BLOCKED), record the failure and proceed to Step 6 to evaluate the round counter.

## Step 6: Re-Review Loop

Increment the round counter:

```
ROUND=$((ROUND + 1))
```

**If `ROUND <= MAX_ROUNDS`**: return to Step 4 to re-run code review on the updated PR. The new round will use a fresh `BEFORE_COUNT` snapshot (taken at the top of Step 4) so we only count NEW comments from the current review pass.

**If `ROUND > MAX_ROUNDS`** (3 rounds exhausted): escalate. Post a `## Code Review` comment on the issue summarizing the rounds:

```markdown
## Code Review

Code review loop exhausted after 3 rounds without converging on a clean review.

- Round 1: [N] comments addressed
- Round 2: [N] comments addressed
- Round 3: [N] comments addressed (still not clean)

PR: PR_URL

Escalating to Human Needed for manual review and resolution.
```

Then move the issue to "Human Needed" via:

```
save_issue(
  number=NNN,
  workflowState="__ESCALATE__",
  command="ralph_code_review"
)
```

The semantic intent `__ESCALATE__` resolves to `"Human Needed"` per the wildcard mapping in `state-resolution.ts`.

Output the final status and stop:

```
CODE REVIEW ESCALATED
Issue: #NNN
PR: PR_URL
Rounds exhausted: 3
State: Human Needed
```

## Step 7: Report Result

If the loop exited cleanly via Step 4 (clean review) OR Step 5 succeeded and Step 4 on the next round confirmed clean, output:

```
CODE REVIEW PASSED
Issue: #NNN
PR: PR_URL
Rounds run: ROUND
State: In Review
```

If the loop exited via Step 6 (escalation), the report block in Step 6 is the final output.

## Notes

- **No worktree management**: This skill does NOT create or modify worktrees. The nested `impl-agent` reuses the existing worktree.
- **No state change on success**: A clean code review leaves the issue in "In Review" (the merge step is the gate to "Done").
- **Idempotent comment counting**: Always use `gh pr view PR_NUMBER --json comments --jq '.comments | length'` for both BEFORE and AFTER snapshots — same command, same field — so race conditions on PR thread updates do not produce false negatives.
- **Budget exhaustion**: If the wrapper kills the process before 3 rounds complete, the issue remains in "In Review". The next loop iteration will re-pick it and continue from Round 1 (rounds are NOT persisted across invocations in this skill).

## Escalation Protocol

Use `command="ralph_code_review"` in state transitions.

**Code-review-specific triggers:**

| Situation | Action |
|-----------|--------|
| 3 review rounds exhausted | Escalate via `__ESCALATE__` → "Human Needed", post `## Code Review` summary comment |
| Human reviewer requested changes (Step 3) | Stop with `CODE REVIEW BLOCKED`, do NOT escalate (human is already aware) |
| `impl-agent` reports BLOCKED | Treat round as failed, continue to Step 6 to check counter |
| No open PR found (Step 2) | Stop with `CODE REVIEW BLOCKED`; the orchestrator's queue-picker should not have selected this issue |

## Link Formatting

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/link-formatting.md
