# Merge Gate

How `/ralph:review --mode merge` (and default-mode's Step 5) merge an approved PR safely. Owns pre-merge gates, the merge mechanics, worktree cleanup, cross-repo coordination, CI watch, and the Scout Report gate.

## Queue-pick

When called with no `#NNN`:

1. `list_issues(workflowState: "In Review", limit: 10)` — first candidate.
2. For each, `gh pr list --head feature/GH-NNN --json number,state --jq '.[0]'`. First with `state: OPEN` is selected.
3. STOP `Queue empty.` if none match. Loop runner greps for this literal.

Queue-pick does NOT pre-filter unreviewed PRs — downstream pre-merge gates catch them. This keeps the queue logic simple (state + open-PR) and lets the safety net (§Pre-merge gates) own the review-required check.

## Pre-merge gates

**ALWAYS RUN**, even when called from default-mode (which has already validated + reviewed). The gates are a safety net against caller misconfiguration.

### Review decision

```bash
DECISION=$(gh pr view PR_NUMBER --json reviewDecision --jq '.reviewDecision')
```

| Value | Action |
|---|---|
| `APPROVED` | Continue. |
| `REVIEW_REQUIRED` / `null` | `MERGE BLOCKED — review required`. STOP. |
| `CHANGES_REQUESTED` | `MERGE BLOCKED — changes requested`. STOP. |

This is the safety net `/ralph:review --mode merge` provides for standalone callers (`just merge NNN`) that skip the default-mode flow. Even if a caller invokes merge directly on an unreviewed PR, the gate refuses.

### Mergeable status

```bash
MERGEABLE=$(gh pr view PR_NUMBER --json mergeable --jq '.mergeable')
```

| Value | Action |
|---|---|
| `MERGEABLE` | Continue. |
| `CONFLICTING` | `MERGE BLOCKED — conflicts`. STOP. Conflict resolution is impl-agent's job, not merge-mode's. |
| `UNKNOWN` | Retry once after 5 seconds. If still `UNKNOWN`, `MERGE BLOCKED — mergeable status unknown` and STOP. |

### Scout Report gate

Enforced by `closeout-scout-gate.sh` (PreToolUse on `Bash` matching `merge-pr.sh` / `gh pr merge`). Contract (Plan 5 producer / Plan 6 consumer):

- `/ralph:impl --mode pr` posts a `## Scout Trigger` comment when the PR matches the frontend-glob heuristic.
- This hook fires before the merge command. If the PR has a `## Scout Trigger` comment, the hook requires a `## Scout Report` reply with verdict `PASS` or `WARN`.
- `FAIL` → exit 2, blocks the merge.
- Missing report → exit 0, advisory-by-design (matches scout-trigger's conservative philosophy).

Scout Report format the hook parses:

```markdown
## Scout Report

verdict: PASS  (or WARN, or FAIL)

[scout findings / screenshots / a11y notes]
```

The `verdict:` line is case-insensitive; the hook tolerates whitespace before/after the colon.

## Merge mechanics

Invoke the repo-root script (lives at `scripts/merge-pr.sh`, reused as-is by old + new plugins):

```bash
bash scripts/merge-pr.sh PR_NUMBER
```

Capture the merge SHA immediately:

```bash
MERGE_SHA=$(gh pr view PR_NUMBER --json mergeCommit --jq '.mergeCommit.oid')
```

`MERGE_SHA` is needed for CI watch (§CI Watch below) — substitute it **literally** into the Monitor command string.

## Worktree cleanup

After successful merge:

```bash
GIT_ROOT=$(git rev-parse --show-toplevel)
git -C "$GIT_ROOT" worktree remove worktrees/GH-NNN --force
```

`--force` because the worktree branch is now stale (the feature branch was merged + deleted on remote). Cross-repo: remove worktrees in each sibling repo per the registry (§Cross-repo).

## Cross-repo

Read `.ralph-repos.yml` to discover sibling repos with `awaits` dependency on this issue.

For each sibling:

1. Resolve `localDir` (tilde-expanded to absolute path — the cleanup `cd` would silently fail otherwise).
2. If a sibling worktree exists at `<localDir>/worktrees/GH-NNN`, remove it after merge.
3. If the registry declares `dependency-flow` for this sibling, advance the sibling's state or post the unblock comment per the flow spec.

Tilde expansion: `localDir` values in the registry may use `~`; always expand to absolute paths before `cd` / `git worktree remove`. The path comparison against `file_path` (in hooks) requires absolute.

## Parent advancement

**Skill MUST NOT advance the parent.** Parent auto-advance is handled server-side by the `advance-parent.yml` GitHub Action when ALL children reach Done. Skills only transition the child via:

```
save_issue(number=NNN, workflowState="__CLOSE__", command="ralph_merge")
```

The `__CLOSE__` semantic intent maps `"*": "Done"` per `plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts`. Do NOT use `__DONE__` — it is not a registered intent and the MCP server will reject it with "Unknown semantic intent".

Touching the parent from the skill would race with the Action and produce double-advances or out-of-order state changes. The boundary is firm: server owns parent, client owns child.

## CI Watch

Default-mode continues to CI watch after merge (`--mode merge` terminates earlier; this section serves default-mode's Step 6).

Use the `Monitor` tool — a streaming-notification primitive. The Monitor runs a poll script whose stdout lines arrive as notifications only when the run summary changes (state transitions, not every poll). Avoids burning a tool-turn per poll; the `sleep 30` lives inside the script. `timeout_ms=600000` (10 min) is the safety net for `CI PENDING`.

**CRITICAL — literal SHA substitution.** Monitor runs the command in its own subshell and does NOT inherit shell-local variables from prior Bash calls. The `$MERGE_SHA` token below must be replaced with the actual SHA captured in §Merge mechanics before invoking Monitor.

```
Monitor(
  command='last_status=""
while true; do
  current=$(gh run list --commit "ACTUAL_MERGE_SHA_HERE" --json status,conclusion,name --limit 10 2>/dev/null || echo "[]")
  count=$(printf "%s" "$current" | jq -r "length" 2>/dev/null || echo "0")
  if [ "$count" = "0" ]; then
    printf "%s\n" "CI SKIPPED: no runs found for ACTUAL_MERGE_SHA_HERE"
    exit 0
  fi
  summary=$(printf "%s" "$current" | jq -r "[.[] | \"\\(.name): \\(.status)/\\(.conclusion)\"] | join(\", \")" 2>/dev/null || echo "")
  if [ "$summary" != "$last_status" ]; then
    printf "%s\n" "$summary"
    last_status="$summary"
  fi
  if printf "%s" "$current" | jq -e "length > 0 and all(.status == \"completed\")" >/dev/null 2>&1; then
    if printf "%s" "$current" | jq -e "all(.conclusion == \"success\")" >/dev/null 2>&1; then
      printf "%s\n" "CI PASSED: all runs succeeded"
    else
      failed=$(printf "%s" "$current" | jq -r "[.[] | select(.conclusion != \"success\") | \"\\(.name): \\(.conclusion)\"] | join(\", \")" 2>/dev/null || echo "unknown")
      printf "%s\n" "CI FAILED: $failed"
    fi
    exit 0
  fi
  sleep 30
done',
  description='CI watch for merge SHA',
  timeout_ms=600000
)
```

### Script contract

1. `last_status=""` to start.
2. Loop forever (`while true`).
3. Fetch via `gh run list --commit "$MERGE_SHA"` (stderr suppressed, fallback `[]`).
4. **Empty array** (`length == 0`): print `CI SKIPPED: no runs found for $MERGE_SHA` and `exit 0`. Prevents infinite loop when CI is unconfigured.
5. Compute one-line `summary` of `name: status/conclusion` joined with `, `.
6. Print via `printf '%s\n'` only when `summary != last_status`.
7. Terminal state: `length > 0 and all(.status == "completed")`. Use `status == "completed"`, NOT `.conclusion != null` — `gh run list` returns `conclusion: ""` (empty string) for in-progress runs, so `!= null` falsely matches in-flight.
8. Terminal: `CI PASSED:` (all success) or `CI FAILED: <run names>` (any non-success). Terminal verdict line is the LAST line emitted before `exit 0`.
9. Otherwise, `sleep 30` and re-loop.

### Outcomes the caller sees

| Outcome | Source |
|---|---|
| `CI PASSED: ...` | Last Monitor line starts with `CI PASSED:` (exit 0 after all-success). |
| `CI FAILED: ...` | Last Monitor line starts with `CI FAILED:` (exit 0 after any-failure). |
| `CI SKIPPED: ...` | Last Monitor line starts with `CI SKIPPED:` (exit 0 immediately on empty array). |
| `CI PENDING` | Monitor reached `timeout_ms` without ever emitting a terminal-prefix line. (Monitor sends SIGTERM on timeout, so the script can't reliably emit a final line itself — absence of a terminal prefix within 10 min IS the PENDING signal.) |

## Autonomous mode (`RALPH_AUTO_MERGE=true`)

Loop runners (`scripts/ralph-loop.sh --auto-merge` and equivalents) set `RALPH_AUTO_MERGE=true` before invoking `/ralph:review --mode merge` to opt into the autonomous gate. When the env var is unset (the standalone `just merge NNN` case), this section is skipped entirely and the interactive Pre-merge gates above own the safety net.

This gate is intentionally orthogonal to `RALPH_REVIEW_MODE` (which gates code-review in default-mode Step 3). Auto-review and auto-merge are independent dials.

### Criteria (ALL must hold)

1. **Review approved** — `gh pr view PR_NUMBER --json reviewDecision --jq '.reviewDecision'` returns `APPROVED`. The carve-outs in § Carve-outs below also satisfy this criterion (XS-no-comments OR self-authored-on-solo-repo).
2. **CI green** — `gh pr checks PR_NUMBER --json name,state,conclusion` returns every check with `state: completed` AND `conclusion: success`. Pending or failing checks block.
3. **PR open and mergeable** — `gh pr view PR_NUMBER --json state,mergeable --jq '{state,mergeable}'` shows `state: OPEN` and `mergeable: MERGEABLE`. `CONFLICTING` or `UNKNOWN` blocks.

Recommended invocation shape (all three reads parallelized into one shell block):

```bash
review_decision=$(gh pr view "$PR_NUMBER" --json reviewDecision --jq '.reviewDecision')
ci_status=$(gh pr checks "$PR_NUMBER" --json name,state,conclusion)
pr_state=$(gh pr view "$PR_NUMBER" --json state,mergeable --jq '{state,mergeable}')
```

Then evaluate the three criteria together. Pending checks are explicit blockers — emit the `AUTO-MERGE BLOCKED ci-pending` form and let the next loop iteration re-evaluate.

### On miss — `AUTO-MERGE BLOCKED`

Emit a distinct token so callers (loop runners, hero, autopilot) can distinguish autonomous-gate failures from interactive `MERGE BLOCKED`:

```
AUTO-MERGE BLOCKED
Issue: #NNN
PR: #PR_NUMBER
Review: [APPROVED|CHANGES_REQUESTED|REVIEW_REQUIRED|null]
CI: [summary — e.g., "2/5 checks pending", "1 failing: lint", "all green"]
Reason: [first failing criterion in plain English]
```

STOP. The next loop tick re-evaluates. There is no fix cycle in autonomous mode — the gate only merges when everything is already green; it never edits code.

### On pass

All criteria hold. Proceed to the Scout Report gate (above), then Merge mechanics, then Worktree cleanup.

## Carve-outs from the APPROVED requirement

Two intentional carve-outs that the pre-merge `reviewDecision` check (interactive mode) AND the autonomous mode Criterion 1 honor. Both are enforced deterministically by `merge-review-decision-gate.sh` (Phase 4 of GH-1395) — the prose here documents what the hook accepts.

### XS-no-comments

Issues with `estimate: XS` AND a PR comment count of `0` may merge without a formal `APPROVED` decision. Use case: one-line typo fixes, trivial docs corrections, comment-only changes where requesting a formal review adds latency without value.

```bash
estimate=$(gh issue view ISSUE --json projectItems --jq '[.projectItems[].fieldValues[]? | select(.field.name == "Estimate") | .name] | .[0] // "null"')
comment_count=$(gh pr view PR_NUMBER --json comments --jq '.comments | length')
if [[ "$estimate" == "XS" && "$comment_count" == "0" ]]; then
  # carve-out applies — treat as APPROVED-equivalent
fi
```

Pairs with the `kind:trivial` / `kind:doc` fast-track ladder rungs (spec §Fast-Track Ladder).

### Self-authored-on-solo-repo

Self-authored PRs on single-contributor repos are treated as APPROVED-equivalent. GitHub blocks self-approval (`Can not approve your own pull request`), so a formal `APPROVED` review is structurally unattainable — without this carve-out, single-developer repos cannot merge anything.

```bash
pr_author=$(gh pr view PR_NUMBER --json author --jq '.author.login')
current_user=$(gh api user --jq '.login')
contributor_count=$(gh api "repos/$(gh repo view --json nameWithOwner --jq .nameWithOwner)/contributors" --jq 'length')
if [[ "$pr_author" == "$current_user" && "$contributor_count" -le 1 ]]; then
  # carve-out applies — treat as APPROVED-equivalent
fi
```

The caller (default-mode close-out, finish-equivalent) is responsible for ensuring code review actually ran and resolved clean before invoking merge — these carve-outs only suppress the `APPROVED` gate, not the code-review-gate-in-default-mode step. See [GH-932](https://github.com/cdubiel08/ralph-hero/issues/932) for the bootstrap rationale.

## Verdict tokens (strict)

| Token | Meaning |
|---|---|
| `MERGED` | Merge succeeded; SHA captured; issue transitioned to Done. |
| `MERGE BLOCKED — <reason>` | Pre-merge gate failed (review/mergeable/scout). Emitted in BOTH interactive and autonomous modes — the Pre-merge gates section runs unconditionally per `ALWAYS RUN` at line 17. STOP without merging. |
| `AUTO-MERGE BLOCKED — <reason>` | Autonomous-mode-specific criterion failed beyond the Pre-merge gates (CI not green, mergeable=UNKNOWN, etc.). STOP — next loop tick re-evaluates. |
| `MERGE NOT READY` | PR not findable (no open PR on branch). STOP. |
| `Queue empty.` | No-work short-circuit from queue-pick path. |

> **Loop-runner contract.** Callers grepping for autonomous-mode failures must accept BOTH `MERGE BLOCKED — ` and `AUTO-MERGE BLOCKED — ` as block signals. The Pre-merge gates run before the autonomous-mode-only criteria, so a `MERGE BLOCKED — review required` can fire in an `RALPH_AUTO_MERGE=true` run. Only the autonomous-mode-only criteria (CI green, mergeable status from §Autonomous mode Criteria 2 and 3) emit the `AUTO-MERGE BLOCKED — ` prefix.
