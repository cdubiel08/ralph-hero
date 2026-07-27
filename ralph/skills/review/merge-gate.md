# Merge Gate

How `/ralph:review --mode merge` (and default-mode's Step 5) merge an approved PR safely. Owns pre-merge gates, the merge mechanics, worktree cleanup, cross-repo coordination, CI watch, and the Scout Report gate.

## Queue-pick

When called with no `#NNN`:

1. `list_issues(workflowState: "In Review", limit: 10)` — first candidate.
2. For each, resolve the candidate's plan branch first (group plan → `feature/GH-[primary_issue]`, single → `feature/GH-NNN`; see `ralph/skills/impl/worktree-setup.md` § Auto-mode Step 2), then `gh pr list --head <branch> --json number,state --jq '.[0]'`. First with `state: OPEN` is selected. Group members share one PR — de-duplicate candidates resolving to the same branch (GH-1538).
3. STOP `Queue empty.` if none match. Loop runner greps for this literal.

Queue-pick does NOT pre-filter unreviewed PRs — downstream pre-merge gates catch them. This keeps the queue logic simple (state + open-PR) and lets the safety net (§Pre-merge gates) own the review-required check.

## Pre-merge gates

**The gates live IN `scripts/merge-pr.sh`** (GH-1589) — deterministic, portable (plain bash + gh + jq), enforced from ANY shell or harness. The skill does not duplicate them in prose; invoke the script and parse its output. Server-side, `validate-attestation.yml` republishes the attestation verdict as the `ralph-attestation` commit status — the layer no harness can skip.

The script blocks (exit 1, `MERGE GATE FAIL — <gate>: <detail>` + legacy `MERGE BLOCKED — <detail>`) unless ALL of:

| Gate | Requirement | On failure |
|---|---|---|
| `state` | PR is OPEN | Wrong target — re-check queue-pick. |
| `review` | `reviewDecision != CHANGES_REQUESTED` | **Hard block, `--force` does not apply.** Resolve or dismiss the review on GitHub (audit-logged). |
| `mergeable` | `MERGEABLE` (UNKNOWN retried once, 5s) | `CONFLICTING` → rebase is impl-agent's job, not merge-mode's. Not forceable. |
| `checks` | Every CI check bucket `pass`/`skipping` (the `ralph-attestation` context is excluded — the script validates the comment itself) | Pending → wait/re-tick. Failing → fix cycle. Zero checks → loud warn, continues. |
| `attestation` | `<!-- ralph-attestation:v1 -->` comment present, JSON-valid, `head_sha` == current head, non-empty `tests[]` all `exit_code: 0`, review verdict present (`models[]` optional — spend observability, not a gate) | Post via `scripts/attest-pr.sh` (§Attestation). Stale sha → re-attest after the latest push. |
| `external-review` | A review by the policy bot (CodeRabbit) exists | Wait for the bot, or fix what it rejected. |

Policy data: `.github/ralph-merge-policy.json` — evidence requirements + exempt authors (dependabot, github-actions: CI is their evidence; the evidence gates skip, CI-green never does). No policy file → evidence gates off (portability for repos that haven't opted in).

Escape hatch: `bash scripts/merge-pr.sh PR_NUMBER --force "reason"` skips the soft gates and posts a durable `## Merge Gate Override` comment (actor, reason, skipped gates, sha) BEFORE merging. Loud, never silent — and `review`/`mergeable` hard blocks still apply.

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

## Attestation & adversarial review

Evidence is posted BEFORE invoking the merge (default-mode Step 4.9; standalone merges block until it exists).

**Adversarial reviewer selection (conditional-by-class + unconditional floor):**

1. `bash scripts/pr-file-classes.sh --pr PR_NUMBER` — deterministic classes for the diff.
2. One adversarial reviewer per class present, each prompted to REFUTE the change through its lens, plus the security floor ALWAYS:

| Class | Adversarial lens |
|---|---|
| `mcp-ts` / `knowledge-ts` | TS correctness, tool-contract regressions, cache/state bugs |
| `hooks-shell` / `scripts-shell` | gate semantics, fail-open paths, quoting, bash-3.2 compat |
| `ci-workflows` | injection surfaces, permissions creep, unpinned actions |
| `deps` | supply-chain diff, lockfile provenance, major-bump blast radius |
| `skills-prose` | roster consistency, contract drift vs. source |
| `other` | general correctness |
| _(always)_ | **security floor** — secrets, authz, injection, data exposure |

3. Post the attestation (one comment per PR, updated in place; `head_sha`-bound — any later push invalidates it):

```bash
bash scripts/attest-pr.sh PR_NUMBER \
  --test "npm test::0::212 passed" \      # real commands + real exit codes
  --review-verdict APPROVED --reviewer "ralph:review-agent" \
  --class "mcp-ts::adversarial:mcp-ts" --class "security::security-floor" \
  --model-tier "impl::standard::sonnet" --model-tier "review::capable::best"
```

Classes auto-compute from the diff when no `--class` given. `validate-attestation.yml` recomputes classes server-side and FAILS attestations that under-declare coverage — fabricating breadth doesn't work. External independence comes from CodeRabbit (`.coderabbit.yaml`): a separate bot identity whose Request-Changes reviews land in the `review` hard block.

**Spend trail (GH-1593, optional, non-gating):** `--model-tier "phase::tier::model"` is repeatable — one entry per phase whose tier is known at attest time (`impl`, `review`, `research`, ...). It records a per-issue cost trail in the attestation's `models[]` field; `validate-attestation.sh` validates each entry's shape when present but never fails or holds `pending` on an ABSENT `models[]` — every attestation posted before this field existed keeps validating exactly as before.

## Merge mechanics

Invoke the repo-root script (the verified gate + merge, GH-1589):

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
3. If the registry declares `dependency-flow` for this sibling, advance the sibling's state or post the unblock comment per the flow spec. **This is the one MCP-mediated caller whose target state this feature (GH-1592) does not prove legal**: `.ralph-repos.yml`'s `dependency-flow` schema does not enumerate a target workflow state, so the flow MUST name an explicit target state and `get_issue` the sibling first to read its actual current state before writing — do not invent a target. If the registry entry cannot express a target state for this sibling, post the unblock comment only and do not write workflow state.

Tilde expansion: `localDir` values in the registry may use `~`; always expand to absolute paths before `cd` / `git worktree remove`. The path comparison against `file_path` (in hooks) requires absolute.

## Parent advancement

**Skill MUST NOT advance the parent.** Parent auto-advance is handled server-side by the `advance-parent.yml` GitHub Action when ALL children reach Done. Skills only transition the child(ren) via:

```
save_issue(number=NNN, workflowState="__CLOSE__", command="ralph_merge")
```

Group merges (plan frontmatter `github_issues`, PR body with multiple `Closes #N`): one `__CLOSE__` call **per member**. `sync-pr-merge.yml` also advances every linked issue server-side; the per-member calls are the belt to its suspenders and keep the board correct even when Actions lag.

## Epic close-out validation (GH-1538)

After a merge whose closed issue(s) have an epic parent, check whether it
was the LAST open child: `list_sub_issues(parent)` — if every child is now
CLOSED, dispatch the fable epic-validation bookend BEFORE reporting:

```
Agent(
  subagent_type="ralph:val-agent",
  model="fable",
  prompt="Epic close-out validation for GH-<parent>.
    Inputs: the epic plan-of-plans at <path>, every feature plan under it,
    and the merged PR list <urls>.
    Question: does the delivered WHOLE satisfy the plan-of-plans'
    Strategic Context and Integration Strategy — not each feature in
    isolation, but their composition? Check the Integration Strategy's
    contracts actually hold across the merged features.
    Return exactly one verdict line first:
    EPIC VALIDATED | EPIC GAPS: <bullet list>
    then the evidence."
)
```

- `EPIC VALIDATED` → post `## Epic Close-Out Validation` comment (verdict
  + evidence) on the epic. Do not touch the epic's state — server-side
  `advance-parent.yml` owns the Done transition.
- `EPIC GAPS` → post the comment with the gap list AND
  `save_issue(number=<parent>, workflowState="Human Needed", command="ralph_merge", force=true)`
  so the epic does not silently stand as Done with unmet intent. This is
  the one sanctioned parent touch — a corrective override, not an
  advancement. **`force: true` is required here**: by the time this fires
  the parent is very likely `Done` (either `advance-parent.yml` already
  ran, or this call races it), and `Done` has no outbound edges
  server-side (GH-1615) — a plain `Human Needed` write would be refused.
  `force` is loud: the response carries `forcedTransition` with the
  previous state, which IS the durable record of the override. **Race
  note:** `advance-parent.yml` (triggered by the last child's closure) has
  NO Human Needed guard and may set the parent to Done before or after
  this call. Apply Human Needed (with `force: true`), then re-read the
  parent's state once; if the Action overwrote it back to Done, re-assert
  Human Needed once more (`force: true` again, plus `issueState: "OPEN"`
  if the Action also closed the issue). The validation comment and the
  `forcedTransition` markers are the durable record either way.

Skip silently when the merged issue has no parent, the parent has no
plan-of-plans, or open children remain.

The `__CLOSE__` semantic intent maps `"*": "Done"` per `mcp-server/src/lib/state-resolution.ts`. Do NOT use `__DONE__` — it is not a registered intent and the MCP server will reject it with "Unknown semantic intent".

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

**GH-1589 simplification: autonomous mode has no separate criteria.** The script IS the gate — `bash scripts/merge-pr.sh PR_NUMBER` enforces review, CI, mergeable, attestation, and external review identically in both modes. Autonomous behavior differs only in what happens on failure:

- `MERGE GATE FAIL — checks: ...pending` (or `external-review: no review by <bot>`) → STOP; the next loop tick re-evaluates. Evidence-in-flight resolves without code changes.
- Any other `MERGE GATE FAIL` → STOP and surface; there is no fix cycle in autonomous mode — the gate never edits code.

Historical note: the pre-1589 three-criterion prose gate emitted `AUTO-MERGE BLOCKED — <reason>`. The script emits `MERGE BLOCKED — <reason>` (plus `MERGE GATE FAIL`); loop runners already accept both tokens per the contract below, so the change is grep-compatible.

## Superseded: carve-outs from the APPROVED requirement

**Deleted by GH-1589.** The gate no longer requires `reviewDecision: APPROVED` at all — on solo repos it is structurally unattainable (GitHub forbids self-approval), which is why the old XS-no-comments and self-authored-on-solo-repo carve-outs (GH-932, GH-1375, GH-1395, GH-1538) existed. The evidence contract replaced the whole construct:

- `CHANGES_REQUESTED` remains the unconditional block (now in the script, not a hook).
- Positive evidence = attestation (tests + verdict + class coverage, `head_sha`-bound) + external review by an independent bot identity (CodeRabbit).
- Bot authors (dependabot, github-actions) are policy-exempt from the evidence gates — CI is their evidence. See `.github/ralph-merge-policy.json`.

`merge-review-decision-gate.sh` survives as a funnel only: inside `/ralph:review`, bare `gh pr merge` is blocked toward `scripts/merge-pr.sh` so the gates actually run.

## Verdict tokens (strict)

| Token | Meaning |
|---|---|
| `MERGED` | Merge succeeded; SHA captured; issue transitioned to Done. |
| `MERGE GATE PASS` | Script gates all satisfied (or `--force`-skipped with override comment); merge proceeding. |
| `MERGE GATE FAIL — <gate>: <detail>` | Script gate failed; gate name is machine-parseable (`state`/`review`/`mergeable`/`checks`/`attestation`/`external-review`/`fetch`). STOP without merging. |
| `MERGE GATE WARN — <detail>` | Non-blocking anomaly (zero CI checks, force-skip notice). |
| `MERGE BLOCKED — <reason>` | Legacy block token, emitted alongside every `MERGE GATE FAIL`. STOP without merging. |
| `MERGE NOT READY` | PR not findable (no open PR on branch). STOP. |
| `Queue empty.` | No-work short-circuit from queue-pick path. |

> **Loop-runner contract.** Callers grepping for block signals must accept BOTH `MERGE BLOCKED — ` and the legacy `AUTO-MERGE BLOCKED — ` prefixes. Since GH-1589 the script emits `MERGE BLOCKED — ` for every gate failure in both modes; `AUTO-MERGE BLOCKED — ` no longer fires but stays in the accept-set for older transcripts and forks.
