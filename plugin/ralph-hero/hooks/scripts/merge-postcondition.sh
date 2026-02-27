#!/usr/bin/env bash
# Postcondition for ralph-merge: verify PR was merged.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"
read_input

if [[ "${RALPH_COMMAND:-}" != "merge" ]]; then
  allow
fi

ticket_id="${RALPH_TICKET_ID:-}"
if [[ -z "$ticket_id" ]]; then
  allow
fi

# Check if the PR for this branch is in merged state
pr_state=$(gh pr list --repo "${RALPH_GH_OWNER}/${RALPH_GH_REPO}" --head "feature/${ticket_id}" --state merged --json number --jq 'length' 2>/dev/null || echo "0")
if [[ "$pr_state" -gt 0 ]]; then
  allow
fi

warn "PR for feature/${ticket_id} does not appear to be merged. Merge may have failed or PR may not be ready."
