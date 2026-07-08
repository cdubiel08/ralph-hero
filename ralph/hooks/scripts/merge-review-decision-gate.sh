#!/bin/bash
# ralph/hooks/scripts/merge-review-decision-gate.sh
# PreToolUse:Bash — gate `gh pr merge` AND `scripts/merge-pr.sh` invocations
# on the PR's reviewDecision.
#
# Closes GH-1373 (P6 violation: merge-gate enforcement was prose-only). The
# slim plugin's merge gate documented "refuse non-APPROVED" in merge-gate.md
# but no deterministic hook actually read `gh pr view --json reviewDecision`
# before letting the merge through. Any agent that skipped the prose could
# merge an unreviewed PR.
#
# IMPORTANT — must match BOTH merge paths the slim plugin actually uses:
#   1. `bash scripts/merge-pr.sh PR_NUMBER` (canonical, per merge-gate.md
#      §Merge mechanics line 71)
#   2. `gh pr merge ...` (direct gh CLI invocation)
# Matching only `gh pr merge` literal would silently fail-open on the
# canonical path. Mirrors closeout-scout-gate.sh's two-shape matcher.
#
# Scope:
#   - Active only when RALPH_COMMAND=review.
#   - Self-discriminates on tool_input.command — no-op for any Bash that
#     does not invoke a merge.
#   - Fails CLOSED on regex extraction failure (cannot determine PR number)
#     so an unrecognized merge invocation never bypasses the gate silently.
#
# Carve-outs:
#   - Only apply when reviewDecision is null/REVIEW_REQUIRED (i.e. NO review
#     posted yet). CHANGES_REQUESTED is always a hard block — explicit
#     reviewer rejection cannot be bypassed by carve-out. Mirrors source
#     plugin/ralph-hero/skills/ralph-merge/SKILL.md:133-149 nesting.
#
# Exit codes:
#   0 — allow (not a merge command, scope mismatch, or APPROVED-equivalent).
#   2 — block (merge targets a PR without APPROVED + no carve-out, OR the
#       hook cannot determine the PR number).

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

# Detect a merge invocation in either shape. `scripts/merge-pr.sh` is the
# canonical slim-plugin path; `gh pr merge` is the direct gh form some agents
# use. Either matches; non-merge Bash falls through to allow.
if ! echo "$cmd" | grep -qE '(scripts/merge-pr\.sh|gh[[:space:]]+pr[[:space:]]+merge)\b'; then
  allow
fi

# Extract the PR number robustly. Strategy: tokenize the command, then pick
# the first token that is either a bare positive integer OR a github PR URL.
# This handles every common form regardless of flag ordering:
#   bash scripts/merge-pr.sh 123
#   gh pr merge 123 --squash
#   gh pr merge --squash 123
#   gh pr merge --auto --rebase 123
#   gh pr merge https://github.com/o/r/pull/123
pr_num=""
for tok in $cmd; do
  # Bare integer
  if [[ "$tok" =~ ^[0-9]+$ ]]; then
    pr_num="$tok"
    break
  fi
  # PR URL (with optional trailing /files, /checks, /commits path segments)
  if [[ "$tok" =~ /pull/([0-9]+) ]]; then
    pr_num="${BASH_REMATCH[1]}"
    break
  fi
done

# Strip a trailing "#" prefix that some agents use (e.g. `#123`).
if [[ -z "$pr_num" ]]; then
  for tok in $cmd; do
    if [[ "$tok" =~ ^#([0-9]+)$ ]]; then
      pr_num="${BASH_REMATCH[1]}"
      break
    fi
  done
fi

if [[ -z "$pr_num" ]]; then
  # Fail CLOSED — refuse to merge when we cannot determine the PR number.
  # An agent invoking merge in an unrecognized form should surface the
  # parse failure rather than silently bypass the review-decision gate.
  block "merge-review-decision-gate: cannot extract PR number from command.

Command: $cmd

The hook recognises:
  - bash scripts/merge-pr.sh <NUMBER>
  - gh pr merge <NUMBER> [flags]
  - gh pr merge [flags] <NUMBER>
  - gh pr merge <PR_URL>
  - gh pr merge #<NUMBER>

If your merge invocation has a legitimate alternate shape, update
ralph/hooks/scripts/merge-review-decision-gate.sh to recognize it."
fi

# Fetch every PR field the gate and both carve-outs need in ONE gh call
# (reviewDecision for the gate; comments/reviewThreads/closingIssuesReferences
# for the XS carve-out; author for the solo-repo carve-out). Previously each
# consumer made its own gh pr view call — up to 4 round-trips for the same PR.
# `|| echo ""` keeps the script alive under `set -euo pipefail` when gh exits
# non-zero; every downstream jq extraction then resolves to its fail-closed
# default.
pr_json=$(gh pr view "$pr_num" --json reviewDecision,comments,reviewThreads,closingIssuesReferences,author 2>/dev/null || echo "")

# Possible values: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, null (no
# review), "null" (literal when missing or when the fetch failed).
review_decision=$(jq -r '.reviewDecision // "null"' <<<"$pr_json" 2>/dev/null || echo "null")

# Happy path: explicit APPROVED.
if [[ "$review_decision" == "APPROVED" ]]; then
  allow
fi

# Carve-outs (GH-1375) — only apply when no review has been posted yet
# (reviewDecision is null/empty or REVIEW_REQUIRED). CHANGES_REQUESTED is
# an explicit reviewer rejection; carve-outs must NOT override it. Mirrors
# source plugin/ralph-hero/skills/ralph-merge/SKILL.md:133-149 nesting.
case "$review_decision" in
  null|""|REVIEW_REQUIRED)
    : # eligible for carve-out evaluation below
    ;;
  CHANGES_REQUESTED|*)
    block "merge-review-decision-gate: PR #$pr_num has reviewDecision='$review_decision'.

Explicit reviewer rejection (CHANGES_REQUESTED) cannot be bypassed by carve-outs.
The slim-plugin /ralph:review --mode merge body documents this gate in
ralph/skills/review/merge-gate.md § Pre-merge gates. The gate is a
deterministic hook (GH-1373) rather than model-adherence prose.

To unblock:
  1. Address the change requests, then have the reviewer dismiss or re-approve.
  2. Or run 'gh pr review $pr_num --approve' if the changes have been addressed
     and the reviewer is unavailable to re-review."
    ;;
esac

# Helpers for the two carve-outs. Both use a FAIL-CLOSED idiom: any gh API
# error (rate limit, auth, transient 5xx) returns 1 so the carve-out does
# not silently fire on a multi-contributor repo or a missing-estimate issue.

is_xs_no_comments_pr() {
  # Count BOTH conversation comments AND review-thread (file-line) comments
  # from the batched $pr_json. reviewThreads carries the file-line review
  # feedback that is the dominant review surface for substantive critique.
  # Either source nonzero → carve-out does not apply.
  local total_comments
  total_comments=$(jq -r '(.comments | length) + ([.reviewThreads[]?.comments | length] | add // 0)' \
    <<<"$pr_json" 2>/dev/null || echo "unknown")

  if [[ "$total_comments" == "unknown" ]] || [[ ! "$total_comments" =~ ^[0-9]+$ ]]; then
    return 1  # fail-closed: fetch error or unparseable count → carve-out denied
  fi
  if [[ "$total_comments" != "0" ]]; then
    return 1
  fi

  # Resolve ALL linked issue numbers from closingIssuesReferences (populated
  # when the PR body has "Closes #N" / "Fixes #N"). A group PR closes several
  # issues in one merge; the carve-out requires EVERY one to be estimated XS.
  # Judging by [0] alone let a mixed-estimate group PR slip through on its
  # first-listed member (GH-1538 Phase 1).
  local issue_nums
  issue_nums=$(jq -r '.closingIssuesReferences[]?.number // empty' <<<"$pr_json" 2>/dev/null || echo "")
  if [[ -z "$issue_nums" ]]; then
    return 1
  fi

  local issue_num estimate
  while IFS= read -r issue_num; do
    [[ -z "$issue_num" ]] && continue
    estimate=$(gh issue view "$issue_num" --json projectItems \
      --jq '[.projectItems[].fieldValues[]? | select(.field.name == "Estimate") | .name] | .[0] // "null"' \
      2>/dev/null || echo "null")
    if [[ "$estimate" != "XS" ]]; then
      return 1  # fail-closed: any non-XS member or estimate-fetch error denies
    fi
  done <<<"$issue_nums"

  return 0
}

is_self_authored_solo_repo() {
  local pr_author current_user
  pr_author=$(jq -r '.author.login // empty' <<<"$pr_json" 2>/dev/null || echo "")
  current_user=$(gh api user --jq '.login' 2>/dev/null || echo "")

  if [[ -z "$pr_author" || -z "$current_user" || "$pr_author" != "$current_user" ]]; then
    return 1
  fi

  local repo_name
  repo_name=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo "")
  if [[ -z "$repo_name" ]]; then
    return 1
  fi

  # FAIL-CLOSED on contributor count read. Using "unknown" sentinel (not 0)
  # so a rate-limited / transient gh API failure does NOT grant the carve-out
  # on a multi-contributor repo. Note: gh api .../contributors returns the
  # first page only (≤30 entries); for the <=1 check this is benign — a real
  # multi-contributor repo's first page always has many entries.
  local contributor_count
  contributor_count=$(gh api "repos/${repo_name}/contributors" --jq 'length' 2>/dev/null || echo "unknown")

  if [[ "$contributor_count" == "unknown" ]] || [[ ! "$contributor_count" =~ ^[0-9]+$ ]]; then
    return 1  # fail-closed
  fi

  [[ "$contributor_count" -le 1 ]]
}

if is_xs_no_comments_pr; then
  allow
fi

if is_self_authored_solo_repo; then
  allow
fi

block "merge-review-decision-gate: PR #$pr_num has reviewDecision='$review_decision' (need APPROVED, or matched carve-out).

The slim-plugin /ralph:review --mode merge body documents this gate in
ralph/skills/review/merge-gate.md § Pre-merge gates. The gate is a
deterministic hook (GH-1373) rather than model-adherence prose.

Two carve-outs accept non-APPROVED PRs (only when reviewDecision is null/
REVIEW_REQUIRED; CHANGES_REQUESTED is always blocked above):
  1. XS-no-comments  — EVERY linked issue estimate=XS AND PR has zero
     comments (counts BOTH conversation comments AND review-thread
     comments). Group PRs (multiple Closes #N) qualify only when all
     members are XS.
  2. Self-authored-on-solo-repo — PR author == current user on a single-
     contributor repo (GitHub blocks self-approval).

Neither carve-out matched this PR (or a gh API call failed and the
carve-out is denied on conservative grounds). To unblock:
  1. Get a passing code review with explicit approve (gh pr review $pr_num --approve)
  2. Verify the linked issue's Estimate field if you expected XS to apply
  3. For solo-repo workflows, confirm the PR was self-authored and the repo
     has only one contributor"
