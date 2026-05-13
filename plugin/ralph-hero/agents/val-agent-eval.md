---
type: eval-scenarios
agent: val-agent
date: 2026-05-12
status: defined
---

# Val-Agent Delegation Eval

> **Execution note**: These are operator-runnable comparison scenarios for the `ralph-val` skill's delegated vs native verdict-prefix classification. Re-runnable as quality drifts across model swaps or prompt refinements. Not automated in v1 — automation lives in a future feature (F5 / `#1191` telemetry, or a follow-up nightly drift detector) if needed.

10 historic In Progress / In Review issues from the **ralph-hero** repo with known verdicts. For each issue, the operator runs `ralph-val` against the worktree with delegation on and off, then records whether the resulting verdict-prefix (`VALIDATION PASS|FIX|FAIL`) matches. The eval measures **prefix agreement** (Issue acceptance criterion #1, target ≥80% / 8 of 10), not absolute correctness — both delegated and native paths produce LLM-mediated classifications; the cross-check rule (Constraint #9) is the guarantee that the delegate never overrides ground truth from the automated checks.

---

## Issue selection criteria

Pick **10 historic issues** from the ralph-hero repo (or any repo where val has been run on a real worktree). The selection must satisfy:

- **Reachable worktree**: each issue's `worktrees/GH-NNN` is reproducible. Re-create via `git worktree add worktrees/GH-NNN feature/GH-NNN` if pruned post-merge.
- **Verdict spread**: aim for 4-5 `VALIDATION PASS`, 3-4 `VALIDATION FAIL`, 1-2 `VALIDATION FIX`. FIX is rare in the historical corpus — a 1-2 representation is realistic, and a corpus with zero FIX issues is acceptable in v1.
- **Complexity spread**: small (XS/S issues with 1-2 phases) and medium (S/M issues with 3-5 phases). Skip L/XL epics — the per-check count would dominate the prompt budget (Constraint #11) and trigger the truncation branch, distorting the comparison.
- **Has a plan with `## Desired End State`**: issues without plans (or with plans missing `Automated Verification`) bypass Step 7.0 entirely (the threshold gate trips on `total_checks < 2`). Skip them.
- **Has a reachable worktree branch**: skip issues whose `feature/GH-NNN` branch has been pruned from the remote.

Three plausible candidate ranges from the current delegation epic (#965) as starting suggestions; the operator picks the actual 10 at run time:

- **F1 (#1185)** — bash-heavy, multi-phase. Verdict PASS at merge time (bats green).
- **F4a (#1188)** — agent-body integration. Verdict PASS at merge time.
- **F4b (#1189)** — skill-body integration with threshold-gate test. Verdict PASS at merge time.
- Older Phase-4 review-skill issues (mixed verdicts; F2's `#1186`, F3's `#1187`).

Pad to 10 with any other recently-validated issues; non-delegation-epic issues are explicitly welcome (the eval is repo-wide, not epic-scoped).

---

## Agreement criterion

Per issue: the **delegated verdict prefix** (`VALIDATION PASS|FIX|FAIL`) equals the **native verdict prefix**. The `### Automated Checks`, `### Drift Analysis`, and `### Cross-Phase Integration` blocks are NOT scored — they are composed natively in both paths and should be byte-identical. Only the gross verdict label is the comparison surface.

The cross-check rule (Constraint #9) means that when delegate disagrees with the underlying check data, the skill falls back to native — so a "MATCH" in the table can be produced either by (a) the delegate agreeing with native or (b) the cross-check tripping and the skill falling back to native classification. Both are valid path-equivalences for the agreement metric.

---

## Comparison protocol

Run the following steps for each of the 10 selected issues.

```bash
# Pre-flight
gemma-up                                  # start local LLM
export RALPH_DELEGATE_ENABLED=true
ISSUE_NUMBER=1185                         # iterate over the 10 selected issues
ROOT=$(git rev-parse --show-toplevel)
WORKTREE="$ROOT/worktrees/GH-${ISSUE_NUMBER}"

# Step 1: delegated path
[ -d "$WORKTREE" ] || git worktree add "$WORKTREE" "feature/GH-${ISSUE_NUMBER}"
cd "$WORKTREE"
# Invoke the skill against this worktree via the dispatch path the operator
# uses (Skill, Agent, or the loop runner). Capture the verdict-prefix from
# the resulting `## Validation` comment OR the skill's stdout (the line
# starting with `VALIDATION `).
echo "=== Delegated verdict for issue #$ISSUE_NUMBER ==="
# Capture the first VALIDATION line of the skill's stdout (or the posted
# comment body) into DELEGATED_PREFIX.

# Step 2: native path
unset RALPH_DELEGATE_ENABLED
# Re-run the skill against the same worktree without delegation.
echo "=== Native verdict for issue #$ISSUE_NUMBER ==="
# Capture the first VALIDATION line into NATIVE_PREFIX.

# Step 3: record
# Append a row to the 10-row agreement table: ISSUE_NUMBER | DELEGATED_PREFIX |
# NATIVE_PREFIX | MATCH or DELEGATED=<x> NATIVE=<y>.

# Step 4: aggregate
# Count MATCH rows. Compute (MATCH / 10) * 100. Target: >=80% (>=8 of 10).

# Step 5: post the 10-row table + aggregate rate as a comment on issue #1190.
```

### Example agreement table (illustrative — not actual data)

| Issue   | Delegated         | Native             | Outcome |
|---------|-------------------|--------------------|---------|
| #1185   | VALIDATION PASS   | VALIDATION PASS    | MATCH   |
| #1186   | VALIDATION PASS   | VALIDATION PASS    | MATCH   |
| #1187   | VALIDATION PASS   | VALIDATION PASS    | MATCH   |
| #1188   | VALIDATION PASS   | VALIDATION PASS    | MATCH   |
| #1189   | VALIDATION FAIL   | VALIDATION FAIL    | MATCH   |
| #1100   | VALIDATION FIX    | VALIDATION FIX     | MATCH   |
| #1101   | VALIDATION FAIL   | VALIDATION FAIL    | MATCH   |
| #1099   | VALIDATION PASS   | VALIDATION FAIL    | DELEGATED=PASS NATIVE=FAIL |
| #1097   | VALIDATION FAIL   | VALIDATION FAIL    | MATCH   |
| #1098   | VALIDATION PASS   | VALIDATION PASS    | MATCH   |

**Aggregate:** 9/10 MATCH = 90%. Passes the soft baseline of 80%.

### Acceptable baseline

**≥80% agreement (≥8 of 10 MATCH)** per Issue acceptance criterion #1. Below 80% triggers a prompt-refinement review — typical follow-ups:

- Tweak the prompt's classification rules (the `Rules:` block in Step 7.0's bash heredoc) to be more concrete about "ambiguous" cases.
- Swap the model via `RALPH_DELEGATE_VAL_CLASSIFY_MODEL` (e.g., try Qwen instead of Gemma).
- Tune the threshold gate (currently `>=2 checks AND >=1 failure`) if telemetry shows the wrong cut — e.g., raise to `>=3` if 2-check classifications are noisy.
- Drop the delegation site if the model can't match native on closed-label tasks — but only if Wave-3 telemetry (F5) confirms the score is structurally low, not a one-off.

The 80% number is a starting baseline, not a hard SLA. Wave-3 (Features 4a/4b/4c) recalibrates it as real usage data accumulates in `~/.ralph-hero/delegate.log`; F5 (`#1191`) is the feature that turns this into automated drift detection.

---

## What this does NOT measure

This eval compares **verdict prefixes in isolation**. It does NOT measure:

- **Absolute correctness** — the "gold" verdict is itself the native verdict, so this is a self-consistency check, not a ground-truth check. The cross-check rule (Constraint #9) is the actual ground-truth guard: it prevents the delegate from disagreeing with the automated-check data, which is the authoritative signal.
- **The verdict body sections** — `### Automated Checks`, `### Drift Analysis`, `### Cross-Phase Integration`, the `Verdict:` line, fix-command lists, substantive-failure detail lists. All composed natively in both paths; out of scope.
- **Whether `create_comment` succeeds** — covered by the existing `skills/ralph-val/eval-scenarios.md` (3 scenarios: PASS, FIX, FAIL).
- **The cross-check rule's effectiveness** — the cross-check is a Constraint #9 invariant exercised by the bats suite (`scripts/__tests__/val-agent-delegation.bats`), not the eval.
- **Latency or cost** — delegation may be slower or faster than native; that signal lives in the JSONL audit log at `~/.ralph-hero/delegate.log`, not here.

---

## Re-run cadence

Re-run the 10-issue eval after:

- **Model swaps** — when `RALPH_DELEGATE_VAL_CLASSIFY_MODEL` (or the default `RALPH_LLM_MODEL`) changes.
- **Wrapper changes** — when `ralph-delegate.sh` or `lib/openai-compat.sh` is modified (F5, F6, or any future foundation work).
- **Prompt refinements** — when the prompt template in `skills/ralph-val/SKILL.md` Step 7.0 is edited.
- **Quarterly during Wave-4** — once telemetry (F5) ships, the operator may re-run quarterly to detect drift.

Document each re-run as a follow-up comment on issue #1190 (or a fresh tracking issue if the cadence becomes frequent enough to warrant its own thread).

---

## Special cases

How to handle edge cases during selection or scoring:

- **Worktree pruned** — skip the issue and select a replacement. Re-creating the worktree from `feature/GH-NNN` is allowed if the branch still exists on the remote; otherwise skip.
- **Plan no longer exists** — skip the issue and select a replacement. The `## Implementation Plan` comment URL must resolve.
- **`Queue empty` verdict** — skip (not a real classification; produced by the queue-pick branch when no In Progress issue has a worktree).
- **Threshold gate trips (all checks pass)** — MATCH is automatic because both paths produce `VALIDATION PASS` deterministically. Count as MATCH; no delegation invocation, no audit-log line written.
- **Cross-check trips on the delegated path** — the skill falls back to native, so the recorded "delegated" prefix equals the native prefix → MATCH by construction. Annotate the row with `(cross-check fired)` for transparency but count as MATCH.
- **Delegate timeout or unreachable on the delegated path** — falls back to native; same construction → MATCH. Annotate `(fallback rc=124)` or `(fallback rc=127)`.
- **Stale worktree (behind origin/main)** — record `staleness` as a substantive failure note per Step 4's freshness check. The verdict prefix still classifies normally; the staleness annotation does not change the prefix.
