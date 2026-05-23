# Code Review Prompt

How `/ralph:review --mode code` runs the code-review-and-fix loop. The loop runs up to `MAX_ROUNDS=3` before escalating; the cap is enforced at the skill level, not the budget level.

## Pre-loop short-circuits

Before invoking the review skill, check the PR's existing review state via:

```bash
gh pr view PR_NUMBER --json reviewDecision --jq '.reviewDecision'
```

| Value | Action |
|---|---|
| `APPROVED` | PR already reviewed and approved. Emit `Code review already approved.` and STOP clean. |
| `CHANGES_REQUESTED` (human) | Hard human block — distinct from skill-driven feedback. Emit `CODE REVIEW BLOCKED — Human reviewer requested changes` and STOP. Do NOT loop. |
| `null` / `REVIEW_REQUIRED` / no decision | Proceed to the loop. |

Distinguishing human-requested `CHANGES_REQUESTED` from skill-driven feedback: the loop is authoritative only for its own feedback rounds. A human request is outside this skill's authority — the human must address or re-review.

## Loop invariants

Each round (N = 1 … MAX_ROUNDS):

1. **Snapshot `BEFORE_COUNT`** with the canonical command:
   ```bash
   BEFORE_COUNT=$(gh pr view PR_NUMBER --json comments --jq '.comments | length')
   ```
2. **Invoke the review skill**:
   ```
   Skill("code-review:code-review", "PR_NUMBER")
   ```
   Positional PR-number argument. The skill spawns parallel reviewer + scorer agents internally.
3. **Re-query `AFTER_COUNT`** with the IDENTICAL command (same JSON field, same jq filter). Idempotent before/after pair — race conditions on PR thread updates do not produce false negatives.
4. **Compare**:
   - `AFTER_COUNT == BEFORE_COUNT` → clean (no new comments). STOP `CODE REVIEW PASSED` after the current round.
   - `AFTER_COUNT > BEFORE_COUNT` → new comments posted. Proceed to Address Mode dispatch.

## Address Mode dispatch

Dispatch the impl-agent in Address Mode:

```
Agent(
  subagent_type="ralph-hero:impl-agent",
  prompt="Address PR review feedback for issue #NNN. The issue is in 'In Review' state with an open PR (feature/GH-NNN). Run /ralph:impl in Address Mode: scan PR review comments, classify (MUST_FIX / SHOULD_FIX / DISCUSS), apply fixes in the worktree, commit, push, and reply to comments. Do NOT change the workflow state — keep it in 'In Review'.",
  description="Address code review feedback for #NNN (round ROUND/MAX_ROUNDS)"
)
```

The impl-agent auto-detects Address Mode from `workflowState == "In Review"` AND open PR with comments. It will:

1. Reuse the existing worktree at `worktrees/GH-NNN`.
2. Apply MUST_FIX and SHOULD_FIX changes; reply to DISCUSS comments.
3. Commit and push fixes; reply to PR comments with change references.
4. Leave the issue in "In Review" (no state mutation by code-mode itself).

If the impl-agent returns a BLOCKED status, record the round as failed and continue to the re-review-loop check (Step 6 of the SKILL.md body). Three failed rounds escalate.

## Escalation Protocol

After 3 rounds without convergence, post **TWO** comments — the existing `## Code Review` round-by-round summary AND the canonical `## Escalation` comment that the unblock chain consumes.

**First**, the `## Code Review` summary via `create_comment(number=NNN, body=...)`:

```markdown
## Code Review

Code review loop exhausted after 3 rounds without converging on a clean review.

- Round 1: [N] comments addressed
- Round 2: [N] comments addressed
- Round 3: [N] comments addressed (still not clean)

PR: PR_URL

Escalating to Human Needed for manual review and resolution.
```

**Second**, the canonical `## Escalation` comment so `ralph-unblock` / `/ralph-hero:unblock` can discover it by header prefix and parse `originating_command`:

```markdown
## Escalation

@$RALPH_GH_OWNER

Escalation: Code review loop exhausted after 3 rounds on PR_URL — manual review required.

Originating command: ralph_code_review
```

Both comments are required. The `## Code Review` summary preserves round-by-round detail; the `## Escalation` comment is the canonical state the unblock chain finds.

Then transition the issue:

```
save_issue(number=NNN, workflowState="__ESCALATE__", command="ralph_code_review")
```

The `__ESCALATE__` semantic-intent token resolves to `"Human Needed"` per `state-resolution.ts`. Use `command="ralph_code_review"` so the outcome recorder + unblock chain attribute correctly.

## Budget exhaustion behavior

If the wrapper kills the process before 3 rounds complete, the issue stays in "In Review". The next invocation re-picks from Round 1 — rounds are **NOT** persisted across invocations. The cap is a runtime invariant inside a single invocation, not a durable counter.

This is intentional: budget-truncation should not produce a false escalation. A subsequent autopilot tick can resume the loop fresh.

## Verdict tokens (strict)

| Token | Meaning |
|---|---|
| `CODE REVIEW PASSED` | Round N completed clean (no new comments). |
| `CODE REVIEW ESCALATED` | 3 rounds exhausted; issue moved to Human Needed. |
| `CODE REVIEW BLOCKED` | Pre-loop short-circuit (no PR, human `CHANGES_REQUESTED`). |
| `Queue empty.` | No-work short-circuit from queue-pick path. |

`closeout-postcondition.sh` blocks Stop without one of these tokens in the transcript.
