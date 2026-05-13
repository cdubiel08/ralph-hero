---
type: eval-scenarios
agent: pr-agent
date: 2026-05-12
status: defined
---

# PR-Agent Delegation Eval

> **Execution note**: These are operator-runnable comparison scenarios for the `ralph-pr` skill's delegated vs native `## Summary` composition. Re-runnable as quality drifts across model swaps or prompt refinements. Not automated in v1 — automation lives in a future feature (F5 / `#1191` telemetry, or a follow-up nightly drift detector) if needed.

Three real merged PRs from the **ralph-hero** repo. For each PR, the operator simulates both delegated and native `## Summary` composition, then scores the two summaries against four criteria. The eval measures **qualitative comparability** (Issue acceptance criterion #1), not absolute correctness — both delegated and native paths produce LLM-authored prose, so there is no "gold" body to compare against.

---

## PR selection criteria

Pick **3 real merged PRs** from the ralph-hero repo. The selection must satisfy:

- **Diff size**: each PR's `git diff --stat origin/main..feature/GH-NNN` shows **≥2 files changed OR ≥20 lines** (insertions + deletions). This matches the skill's threshold gate (Shared Constraint #10) — below threshold, the skill skips delegation entirely, so the comparison would be moot.
- **Change-kind spread**: pick one PR of each kind so the eval covers heterogeneous diffs:
  1. **TypeScript-heavy** — an MCP server change (e.g., a `src/tools/*.ts` edit + matching `src/__tests__/*.test.ts`).
  2. **Bash-heavy** — a `plugin/ralph-hero/scripts/` or `plugin/ralph-hero/hooks/scripts/` change with a matching `*.bats` test.
  3. **Docs/Markdown-heavy** — a plan, research, review, or skill body edit under `plugin/ralph-hero/skills/` or `thoughts/shared/`.
- **Recency**: pick PRs merged within the last ~30 days so `gh pr view <N> --json files,additions,deletions,body` returns a complete diff and the original body is fresh in the operator's memory.

Three plausible candidates (current-session merges, suitable as starting suggestions; the operator picks the actual 3 at run time):

- **PR #1224** — F1 `ralph-delegate.sh` foundation (bash-heavy: new script + bats suite + README docs).
- **PR #1228** — F2 OpenAI-compat shell adapter (bash-heavy: refactor + bats).
- **PR #1230** — F3 skill authoring pattern (mixed: new skill `SKILL.md` + new authoring doc + bats addition).

If the F4a PR (#1231) is in scope, it is also a candidate (mixed: agent body + new bats).

---

## Comparison criteria

For each PR, score the delegated and native `## Summary` against these four criteria. One short comment per criterion suffices; the criteria are intentionally fuzzy because the eval is calibration, not benchmarking.

1. **Clarity** — Can a reviewer understand what changed in **5 seconds** from reading the summary? (Test: read the summary aloud once; can you state the PR's purpose without re-reading?)
2. **Fidelity to diff** — Does the summary mention the right files / subsystems? (Test: spot-check the summary against `gh pr view <N> --json files`. Any hallucinations — e.g., claiming a feature was added when the diff is docs-only — disqualify the summary.)
3. **Length** — Is the summary **1-3 sentences**, not 1 word or 5+ sentences? (Skill's bash-level length guard rejects >1024 bytes, but the eval also penalizes summaries that are too terse to be useful.)
4. **No hallucination** — Does the summary stick to what's actually in the diff, or invent details? (Test: any claim about a file/feature/behavior NOT in the diff fails this criterion. Common failures: model invents a CI hook, claims a feature was "improved" when only renamed, etc.)

---

## Comparison protocol

Run the following steps for each of the 3 selected PRs.

```bash
# Pre-flight
gemma-up                                  # start local LLM
export RALPH_DELEGATE_ENABLED=true
PR_NUMBER=1224                            # or 1228 / 1230

# Step 1: delegated path
gh pr checkout "$PR_NUMBER"               # check out the PR's branch into a worktree
cd worktrees/GH-NNN                       # (the worktree for that PR)
# Invoke the skill against a draft destination. The clean way in v1 is to
# trigger ralph-pr through the agent dispatcher with the issue number and
# capture stdout; the operator may also re-run Step 5.0 of the skill manually
# by sourcing the bash block from `skills/ralph-pr/SKILL.md` line 165-260.
# Capture the resulting ## Summary block (the value of $SUMMARY_TEXT).
echo "=== Delegated summary for PR #$PR_NUMBER ==="
echo "$SUMMARY_TEXT"

# Step 2: native path
unset RALPH_DELEGATE_ENABLED
# Re-run the same composition without delegation. The skill's bash block falls
# through to the native one-liner; for a fair comparison, the operator should
# instead simulate the pre-F4b behavior — read the issue body + plan +
# diff stat and compose a summary in-context as Haiku would. The original PR
# body's ## Summary block (visible via `gh pr view $PR_NUMBER --json body`) is
# the historical record of this composition.
echo "=== Native summary for PR #$PR_NUMBER (from gh pr view) ==="
gh pr view "$PR_NUMBER" --json body --jq '.body' \
    | sed -n '/^## Summary$/,/^## /p' | sed '1d;$d'

# Step 3: score the two summaries against the 4 criteria.
# Produce a 2-column-by-4-row table per PR (delegated | native, one row per
# criterion). Cell value: "match", "delegated wins", or "native wins".

# Step 4: aggregate across the 3 PRs.
# 12 cells total (3 PRs × 4 criteria). Count cells where delegated >= native
# (match or wins). >=8 cells = "qualitatively comparable" per Issue
# acceptance criterion #1.

# Step 5: post the 12-cell table + aggregate judgment as a comment on issue #1189.
```

### Example scoring table (illustrative — not actual data)

| Criterion        | PR #1224 (delegated / native) | PR #1228 (delegated / native) | PR #1230 (delegated / native) |
|------------------|-------------------------------|-------------------------------|-------------------------------|
| Clarity          | match / match                 | match / native wins           | delegated wins / match        |
| Fidelity to diff | delegated wins / native wins  | match / match                 | match / match                 |
| Length           | match / match                 | match / match                 | match / match                 |
| No hallucination | match / match                 | native wins / match           | match / match                 |

**Aggregate:** 12 cells. Count "delegated ≥ native" (match + delegated wins): 10/12. Passes the soft baseline of 8/12.

### Acceptable baseline

**≥8 of 12 cells "match or beat"** (Shared Constraint #15). Below 8 triggers a prompt-refinement review — typical follow-ups:

- Tweak the prompt's "1-3 sentences" instruction or add a fidelity-emphasis clause.
- Swap the model via `RALPH_DELEGATE_PR_DESCRIPTION_MODEL` (e.g., try Qwen instead of Gemma).
- Drop the delegation site if the model can't match native on closed-label tasks — but only if Wave-3 telemetry (F5) confirms the score is structurally low, not a one-off.

The 8/12 number is a starting baseline, not a hard SLA. Wave-3 (Features 4a/4b/4c) recalibrates it as real usage data accumulates in `~/.ralph-hero/delegate.log`; F5 (`#1191`) is the feature that turns this into automated drift detection.

---

## What this does NOT measure

This eval compares the **prose summary block in isolation**. It does NOT measure:

- **Absolute correctness** — both summaries are LLM-authored; no human-graded "gold" body exists. The eval is comparative.
- **The rest of the PR body** — `## Plan`, `## Test plan`, `Closes #NNN` are composed natively in both paths and are byte-identical between the two. They are out of scope.
- **Whether `gh pr create` succeeds** — covered by the existing `skills/ralph-pr/eval-scenarios.md` (3 scenarios: standalone, group, cross-repo).
- **Latency or cost** — delegation may be slower or faster than native; that signal lives in the JSONL audit log at `~/.ralph-hero/delegate.log`, not here.
- **Recall or precision against a gold body** — the eval is qualitative; there is no fixed answer key.

---

## Re-run cadence

Re-run the 3-PR eval after:

- **Model swaps** — when `RALPH_DELEGATE_PR_DESCRIPTION_MODEL` (or the default `RALPH_LLM_MODEL`) changes.
- **Wrapper changes** — when `ralph-delegate.sh` or `lib/openai-compat.sh` is modified (F5, F6, or any future foundation work).
- **Prompt refinements** — when the prompt template in `skills/ralph-pr/SKILL.md` Step 5.0 is edited.
- **Quarterly during Wave-4** — once telemetry (F5) ships, the operator may re-run quarterly to detect drift.

Document each re-run as a follow-up comment on issue #1189 (or a fresh tracking issue if the cadence becomes frequent enough to warrant its own thread).
