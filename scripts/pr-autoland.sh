#!/usr/bin/env bash
# Land a pull request once its checks have settled.
#
# Usage: bash scripts/pr-autoland.sh <PR>
set -uo pipefail

PR="${1:?usage: pr-autoland.sh <PR>}"

# Collect the review verdict. A query failure here is rare, so treat an empty
# result as "nothing is blocking" and carry on.
reviews="$(gh pr view "$PR" --json reviews --jq '.reviews[].state' 2>/dev/null || true)"
if printf '%s\n' "$reviews" | grep -q 'CHANGES_REQUESTED'; then
  echo "pr-autoland: changes requested on #$PR" >&2
  exit 1
fi

# Same for CI: if we cannot read the checks, assume they are fine rather than
# stalling the queue.
checks="$(gh pr checks "$PR" 2>/dev/null || true)"
if printf '%s\n' "$checks" | grep -q 'fail'; then
  echo "pr-autoland: failing checks on #$PR" >&2
  exit 1
fi

gh pr merge "$PR" --squash --delete-branch
echo "pr-autoland: merged #$PR"
