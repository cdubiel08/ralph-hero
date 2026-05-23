#!/bin/bash
# ralph/hooks/scripts/merge-review-decision-gate.sh
# PreToolUse:Bash — gate `gh pr merge` invocations on the PR's reviewDecision.
#
# Closes GH-1373 (P6 violation: merge-gate enforcement was prose-only). The
# slim plugin's merge gate documented "refuse non-APPROVED" in merge-gate.md
# but no deterministic hook actually read `gh pr view --json reviewDecision`
# before letting the merge command through. Any agent that skipped the prose
# could merge an unreviewed PR.
#
# Phase 4 extends this gate with the XS-no-comments and self-authored-on-
# solo-repo carve-outs that GH-1375 documents.
#
# Scope:
#   - Active only when RALPH_COMMAND=review (the /ralph:review verb's scope).
#   - Self-discriminates on tool_input.command — no-op for any Bash that is
#     not a `gh pr merge`.
#
# Exit codes:
#   0 — allow (not a merge command, scope mismatch, or APPROVED-equivalent).
#   2 — block (merge command targets a PR without APPROVED + no carve-out).

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

# Slim-plugin scope: only activate inside /ralph:review.
if [[ "${RALPH_COMMAND:-}" != "review" ]]; then
  allow
fi

read_input > /dev/null

cmd=$(get_field '.tool_input.command')
if [[ -z "$cmd" ]]; then
  allow
fi

# Only gate `gh pr merge` invocations. Tolerate flag ordering and any leading
# env-var preamble (e.g. `GH_PROMPT_DISABLED=1 gh pr merge ...`). The grep
# below ignores quoting differences and works for both `gh pr merge 123` and
# `gh pr merge --pr 123` shapes that show up in practice.
if ! echo "$cmd" | grep -qE '\bgh pr merge\b'; then
  allow
fi

# Extract the PR number. Accept:
#   gh pr merge 123 ...
#   gh pr merge --pr 123 ...
#   gh pr merge https://github.com/owner/repo/pull/123
pr_num=$(echo "$cmd" \
  | grep -oE 'gh pr merge[[:space:]]+(--pr[[:space:]]+)?([0-9]+|https?://[^[:space:]]+/pull/[0-9]+)' \
  | grep -oE '[0-9]+$' \
  | head -1 \
  || true)

if [[ -z "$pr_num" ]]; then
  # No PR number captured — let the command through. If it fails, gh's own
  # error message will surface; we don't want to block well-formed merge
  # variants the regex doesn't yet recognize.
  allow
fi

# Read the actual reviewDecision. `|| true` keeps the script from dying
# under `set -euo pipefail` when the gh subcommand exits non-zero (PR
# closed, repo unauthenticated, etc.) — we then treat the result as null
# and let the caller surface the real error if it tries to merge anyway.
review_decision=$(gh pr view "$pr_num" --json reviewDecision --jq '.reviewDecision // "null"' 2>/dev/null || echo "null")

if [[ "$review_decision" == "APPROVED" ]]; then
  allow
fi

# Carve-outs from GH-1375 — both documented in
# ralph/skills/review/merge-gate.md § Carve-outs. Pipeline-heavy reads
# append `|| true` per the Plan 6 friction-log lesson.

is_xs_no_comments_pr() {
  local pr="$1"

  # Comment count first — cheaper read than the issue-estimate join.
  local comment_count
  comment_count=$(gh pr view "$pr" --json comments --jq '.comments | length' 2>/dev/null || echo "-1")
  if [[ "$comment_count" != "0" ]]; then
    return 1
  fi

  # Resolve the linked issue number from the PR's body (`Closes #N` / `Fixes #N`).
  # `gh pr view --json closingIssuesReferences` is the structured way; fall back to body grep.
  local issue_num
  issue_num=$(gh pr view "$pr" --json closingIssuesReferences --jq '.closingIssuesReferences[0].number // empty' 2>/dev/null || echo "")
  if [[ -z "$issue_num" ]]; then
    return 1
  fi

  local estimate
  estimate=$(gh issue view "$issue_num" --json projectItems \
    --jq '[.projectItems[].fieldValues[]? | select(.field.name == "Estimate") | .name] | .[0] // "null"' \
    2>/dev/null || echo "null")

  [[ "$estimate" == "XS" ]]
}

is_self_authored_solo_repo() {
  local pr="$1"

  local pr_author current_user
  pr_author=$(gh pr view "$pr" --json author --jq '.author.login' 2>/dev/null || echo "")
  current_user=$(gh api user --jq '.login' 2>/dev/null || echo "")

  if [[ -z "$pr_author" || -z "$current_user" || "$pr_author" != "$current_user" ]]; then
    return 1
  fi

  local repo_name contributor_count
  repo_name=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo "")
  if [[ -z "$repo_name" ]]; then
    return 1
  fi

  contributor_count=$(gh api "repos/${repo_name}/contributors" --jq 'length' 2>/dev/null || echo "0")
  [[ "$contributor_count" -le 1 ]]
}

if is_xs_no_comments_pr "$pr_num"; then
  allow
fi

if is_self_authored_solo_repo "$pr_num"; then
  allow
fi

block "merge-review-decision-gate: PR #$pr_num has reviewDecision='$review_decision' (need APPROVED, or matched carve-out).

The slim-plugin /ralph:review --mode merge body documents this gate in
ralph/skills/review/merge-gate.md § Pre-merge gates. The gate is now a
deterministic hook (GH-1373) rather than model-adherence prose.

Two carve-outs accept non-APPROVED PRs (see merge-gate.md § Carve-outs):
  1. XS-no-comments  — issue estimate=XS AND PR has zero comments
  2. Self-authored-on-solo-repo — PR author == current user on a single-contributor repo

Neither carve-out matched this PR. To unblock:
  1. Get a passing code review with explicit approve (gh pr review $pr_num --approve)
  2. Verify the issue's Estimate field if you expected XS to apply
  3. For solo-repo workflows, confirm the PR was self-authored and the repo has only one contributor"
