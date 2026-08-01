#!/usr/bin/env bash
# funnel-merge — courtesy rail (PreToolUse on Bash): bare `gh pr merge` is
# redirected to the repo's merge gate (scripts/merge-pr.sh) WHEN the repo
# ships one. A repo without the gate keeps its own merge flow untouched —
# recommending a gate is `board readiness`'s job, never a hook's. Successor
# to v1's merge-review-decision-gate.sh — the one hook pattern that ever held.
set -euo pipefail

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$CMD" ] || exit 0

if [[ "$CMD" == *"gh pr merge"* && "$CMD" != *"scripts/merge-pr.sh"* ]]; then
  CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || CWD=""
  ROOT=$(git -C "${CWD:-$PWD}" rev-parse --show-toplevel 2>/dev/null) || ROOT=""
  if [ -n "$ROOT" ] && [ -f "$ROOT/scripts/merge-pr.sh" ]; then
    echo "This repo ships a merge gate: bash scripts/merge-pr.sh PR_NUMBER (attest first via scripts/attest-pr.sh)." >&2
    exit 2
  fi
fi
exit 0
