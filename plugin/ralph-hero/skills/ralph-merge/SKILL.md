---
description: Merge an approved pull request — handles PR readiness, merges, cleans up worktree, moves issues to Done. Code review must be run by the caller (finish or ralph-code-review); ralph-merge refuses to merge a PR with no review decision.
user-invocable: false
argument-hint: <issue-number> [--pr-url url]
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
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_dependencies
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

# Ralph Merge

Merge an approved pull request and move issues to Done. This is a leaf merge-mechanics skill — code review is the responsibility of the orchestrating caller (finish or ralph-code-review). Standalone callers (`just merge NNN`) that invoke this skill on an unreviewed PR will be rejected with `MERGE BLOCKED — review required` to preserve safety.

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

## Step 4: Review Decision Guard (Standalone Safety)

> **Output contract for callers (orchestrators: ralph-finish, ralph-hero):**
>
> This step produces two stop statuses that callers MUST handle:
>
> | Status | Meaning | Caller action |
> |--------|---------|---------------|
> | `MERGE BLOCKED` | Either a human reviewer requested changes, OR no code review has been run on the PR. Hard block. | Run code review (via finish/ralph-code-review) or surface to human. |
> | `MERGE NOT READY` | PR is open but not mergeable (conflicts, draft). Transient. | Retry later or escalate. |
>
> Code review is the responsibility of the orchestrating caller — this step only verifies that a review decision exists before letting merge proceed. This guard preserves safety for standalone `just merge NNN` callers that bypass the finish orchestrator.

Check the PR's review decision:

```bash
gh pr view PR_NUMBER --json reviewDecision --jq '.reviewDecision'
```

**If `reviewDecision` is `APPROVED`**: a code review has been performed and approved. Proceed to Step 4a.

**If `reviewDecision` is `CHANGES_REQUESTED`**: a reviewer requested changes. Output:

```
MERGE BLOCKED
Issue: #NNN
PR: #PR_NUMBER
Reason: Reviewer requested changes — address feedback before merging.
```

And stop.

**If no review decision exists** (`reviewDecision` is null or empty):

Check the XS-no-review exception. Use the issue's `estimate` field and the PR's comment count:

```bash
PR_COMMENT_COUNT=$(gh pr view PR_NUMBER --json comments --jq '.comments | length')
```

- If the issue's estimate is `XS` AND `PR_COMMENT_COUNT == 0`: small unreviewed changes are permitted. Proceed to Step 4a (the autonomous merge gate also re-checks this exception when `RALPH_AUTO_MERGE=true`).
- Otherwise check self-authorship:

```bash
PR_AUTHOR=$(gh pr view PR_NUMBER --json author --jq '.author.login')
CURRENT_USER=$(gh api user --jq '.login')
```

- If `PR_AUTHOR == CURRENT_USER`: the PR is self-authored on a single-contributor repo. GitHub blocks self-approval (`Can not approve your own pull request`), so a formal `APPROVED` review is unattainable. Treat as APPROVED-equivalent and proceed to Step 4a. The orchestrating caller (finish) is responsible for ensuring code review passed before invoking ralph-merge — `finish` dispatches `impl-agent` on MUST_FIX feedback and only invokes ralph-merge once code review resolves clean. See [GH-932](https://github.com/cdubiel08/ralph-hero/issues/932) for the bootstrap rationale.
- Otherwise: output and stop:

```
MERGE BLOCKED
Issue: #NNN
PR: #PR_NUMBER
Reason: Code review required — invoke /ralph-hero:finish or /ralph-hero:ralph-code-review first.
```

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
   - **Exception (XS small changes)**: an XS-estimated issue with zero review comments is treated as approved (small changes do not require explicit review approval). Use `gh pr view PR_NUMBER --json comments --jq '.comments | length'` and the issue's `estimate` field to detect this case.
   - **Exception (self-authored single-contributor repo)**: if `gh pr view PR_NUMBER --json author --jq '.author.login'` equals `gh api user --jq '.login'`, the PR was authored by the orchestrator user. GitHub blocks self-approval, so a formal `APPROVED` review is unattainable. Treat as APPROVED-equivalent. The caller (finish) is responsible for ensuring code review passed before invoking ralph-merge.
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

All criteria hold. Proceed to Step 4b (Scout Report Gate).

## Step 4b: Scout Report Gate (UI-touching PRs only)

> **Output contract for callers (orchestrators: ralph-finish, ralph-hero):**
>
> This step produces one additional stop status that callers MUST handle:
>
> | Status | Meaning | Caller action |
> |--------|---------|---------------|
> | `MERGE BLOCKED — Scout review required` | PR touched UI files (Scout Trigger comment exists) but no green Scout Report was found. | Run `/ralph-playwright:test-e2e` against the PR's preview build, then post `## Scout Report: Verdict: GREEN`. |
>
> Non-UI PRs (no `## Scout Trigger` comment on the PR) are a no-op — this step passes through silently.

Fetch all PR comment bodies:

```bash
PR_COMMENTS=$(gh pr view PR_NUMBER --json comments --jq '.comments[].body')
```

**Gate logic (evaluate in order):**

**Step 4b.1 — Check for trigger.** If no comment body starts with `## Scout Trigger`, this PR does not touch UI files. Skip the rest of Step 4b and proceed to Step 5.

```bash
HAS_TRIGGER=$(printf '%s\n' "$PR_COMMENTS" | grep -c '^## Scout Trigger' || true)
if [[ "$HAS_TRIGGER" -eq 0 ]]; then
  # Non-UI PR — Scout gate is a no-op
  # proceed to Step 5
fi
```

**Step 4b.2 — Scout Trigger found. Check for green verdict.**

```bash
HAS_GREEN=$(printf '%s\n' "$PR_COMMENTS" | grep -c '## Scout Report' | xargs)
# A comment is GREEN if it contains "## Scout Report" AND ("Verdict: GREEN" or "Verdict: green")
HAS_GREEN_VERDICT=$(printf '%s\n' "$PR_COMMENTS" | grep -iE 'Verdict: GREEN' | wc -l | xargs)
HAS_OVERRIDE=$(printf '%s\n' "$PR_COMMENTS" | grep -ic 'Verdict: GREEN (override)' || true)
HAS_RED=$(printf '%s\n' "$PR_COMMENTS" | grep -ic 'Verdict: RED' || true)
```

**Step 4b.3 — Evaluate verdicts:**

- If any comment contains `Verdict: GREEN (override)` (case-insensitive): **PASS** — human override accepted. Proceed to Step 5.
- If any comment contains `## Scout Report` AND `Verdict: GREEN` (case-insensitive on `GREEN`): **PASS** — Scout approved. Proceed to Step 5.
- If any comment contains `## Scout Report` AND `Verdict: RED` (and no override): **BLOCK**:

```
MERGE BLOCKED — Scout review required
Issue: #NNN
PR: #PR_NUMBER
Reason: Scout report is RED — address findings before merging.
Action: Fix issues, re-run /ralph-playwright:test-e2e, then post "## Scout Report: Verdict: GREEN".
```

- If `## Scout Trigger` exists but no `## Scout Report` at all: **BLOCK**:

```
MERGE BLOCKED — Scout review required
Issue: #NNN
PR: #PR_NUMBER
Reason: Scout Trigger was posted but no Scout Report found yet.
Action: Run /ralph-playwright:test-e2e against the PR's preview build, then post "## Scout Report: Verdict: GREEN".
```

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

## Step 7.5: Record Outcome Event

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/outcome-recorder.md

Call `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome` with:
- `event_type`: `"merge_completed"`
- `issue_number`: the issue number (NNN)
- `verdict`: `"merged"`
- `payload`: `{ "pr_url": "<PR URL>", "commit_sha": "<merge commit SHA>", "repo": "<RALPH_GH_REPO>" }`

This step runs only on the success path (after Step 7 completes). The rejection branch (Step 9b) does NOT call the recorder.

If the MCP call fails, log to stderr (`echo "outcome-record failed: ..." >&2`) and continue to Step 8.

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

## Step 9c: iOS Completion Push (Feature H)

After completing Step 9 (post completion comment), fire an ntfy push when iOS-mode is active.

iOS-mode is active when either:
- The sentinel file `${TMPDIR:-/tmp}/ralph-ios-mode` exists (written by Director on `trigger:*` or `RemoteTrigger` dispatch), OR
- The env var `RALPH_IOS_MODE` is non-empty (manual operator override for desk-mode testing)

```bash
# iOS completion push — Feature H (GH-1275)
# See: thoughts/shared/plans/2026-05-16-GH-1275-ios-remote-integration.md Phase 2
if [[ -f "${TMPDIR:-/tmp}/ralph-ios-mode" ]] || [[ -n "${RALPH_IOS_MODE:-}" ]]; then
    bash "${CLAUDE_PLUGIN_ROOT}/scripts/lib/push-on-completion.sh" \
        "Merged: ${PR_TITLE}" \
        "${PR_URL}" || true
fi
```

Where `PR_TITLE` is the PR title fetched in Step 3 and `PR_URL` is the PR URL.

Failure of `push-on-completion.sh` does NOT fail the merge skill — the merge already succeeded. The `|| true` ensures this step is best-effort.

`Bash` is already in ralph-merge's `allowed-tools`; no allowlist change is needed.

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
