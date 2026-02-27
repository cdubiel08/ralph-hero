#!/usr/bin/env bash
# Postcondition for ralph-pr: verify PR was created.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"
read_input

if [[ "${RALPH_COMMAND:-}" != "pr" ]]; then
  allow
fi

ticket_id="${RALPH_TICKET_ID:-}"
if [[ -z "$ticket_id" ]]; then
  allow
fi

# Check if a PR exists for the feature branch
pr_url=$(gh pr list --repo "${RALPH_GH_OWNER}/${RALPH_GH_REPO}" --head "feature/${ticket_id}" --json url --jq '.[0].url' 2>/dev/null || echo "")
if [[ -n "$pr_url" ]]; then
  allow
fi

warn "No PR found for feature/${ticket_id}. PR creation may have failed."
