#!/usr/bin/env bash
# poll-merged-prs.sh — launchd polling fallback for the ralph-hero-pr-merged
# cloud Routine. Finds PRs merged in the last 10 minutes that have NOT yet
# received the pr-merged-handled label, and invokes ralph-pr-merged for each.
#
# Intended to be run by the launchd plist template at:
#   plugin/ralph-hero/scripts/routines/launchd/com.ralph.pr-merged-poll.plist.template
#
# Can also be run manually:
#   bash plugin/ralph-hero/scripts/routines/poll-merged-prs.sh

set -euo pipefail

# Compute a 10-minute window — portable across macOS (BSD date) and Linux (GNU date)
SINCE=$(date -u -v-10M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -d "10 minutes ago" +%Y-%m-%dT%H:%M:%SZ)

echo "[poll-merged-prs] Scanning for PRs merged since ${SINCE} (without pr-merged-handled label)"

# Fetch PR numbers that are merged, target main, within the window, and not yet labeled
PR_NUMBERS=$(gh pr list \
  --state merged \
  --json number,headRefName,mergedAt,labels \
  --search "base:main merged:>=${SINCE}" \
  --jq '.[] | select((.labels | map(.name) | contains(["pr-merged-handled"])) | not) | .number' \
  2>/dev/null || true)

if [[ -z "$PR_NUMBERS" ]]; then
  echo "[poll-merged-prs] No unhandled merged PRs found in window."
  exit 0
fi

echo "[poll-merged-prs] Unhandled merged PRs: $(echo "$PR_NUMBERS" | tr '\n' ' ')"

while IFS= read -r pr_num; do
  if [[ -z "$pr_num" ]]; then
    continue
  fi
  echo "[poll-merged-prs] Processing PR #${pr_num}"
  claude -p "/ralph-hero:ralph-pr-merged --pr ${pr_num}" || true
done <<< "$PR_NUMBERS"

echo "[poll-merged-prs] Done."
