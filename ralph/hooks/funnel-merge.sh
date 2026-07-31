#!/usr/bin/env bash
# funnel-merge — courtesy rail (PreToolUse on Bash): bare `gh pr merge` gets
# redirected to scripts/merge-pr.sh, which holds the real typed gates
# (CHANGES_REQUESTED, CI, attestation, external review). Successor to v1's
# merge-review-decision-gate.sh — the one hook pattern that ever held.
set -euo pipefail

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$CMD" ] || exit 0

if [[ "$CMD" == *"gh pr merge"* && "$CMD" != *"scripts/merge-pr.sh"* ]]; then
  echo "Merges go through the gate: bash scripts/merge-pr.sh PR_NUMBER (attest first via scripts/attest-pr.sh)." >&2
  exit 2
fi
exit 0
