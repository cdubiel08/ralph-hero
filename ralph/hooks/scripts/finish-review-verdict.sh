#!/usr/bin/env bash
# finish-review-verdict.sh — single-token verdict gate for finish Step 4.
# Usage: finish-review-verdict.sh PR_NUMBER
# Prints one of: APPROVED | NEEDS_FIX | BLOCKED | ERROR: <message>
# Exit: 0 on success, 1 on gh failure or missing arg

set -uo pipefail

PR_NUMBER="${1:-}"
if [[ -z "$PR_NUMBER" ]]; then
  echo "ERROR: PR_NUMBER required"
  exit 1
fi

decision=$(gh pr view "$PR_NUMBER" --json reviewDecision --jq '.reviewDecision' 2>/dev/null) || {
  echo "ERROR: gh pr view (reviewDecision) failed"
  exit 1
}

case "$decision" in
  APPROVED)
    echo "APPROVED"
    exit 0
    ;;
  CHANGES_REQUESTED)
    echo "NEEDS_FIX"
    exit 0
    ;;
esac

pr_author=$(gh pr view "$PR_NUMBER" --json author --jq '.author.login' 2>/dev/null) || {
  echo "ERROR: gh pr view (author) failed"
  exit 1
}
current_user=$(gh api user --jq '.login' 2>/dev/null) || {
  echo "ERROR: gh api user failed"
  exit 1
}

if [[ "$pr_author" != "$current_user" ]]; then
  echo "BLOCKED"
  exit 0
fi

last_comment=$(gh pr view "$PR_NUMBER" --json comments \
  --jq '.comments | map(select(.body | startswith("### Code review"))) | last | .body // ""' 2>/dev/null) || {
  echo "ERROR: gh pr view (comments) failed"
  exit 1
}

if [[ -z "$last_comment" ]]; then
  echo "BLOCKED"
elif [[ "$last_comment" == *"No issues found"* ]]; then
  echo "APPROVED"
elif [[ "$last_comment" == *"Found "* ]]; then
  echo "NEEDS_FIX"
else
  echo "BLOCKED"
fi
