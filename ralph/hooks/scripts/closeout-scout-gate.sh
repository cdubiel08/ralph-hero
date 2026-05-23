#!/bin/bash
# ralph/hooks/scripts/closeout-scout-gate.sh
# PreToolUse(Bash): Gate `merge-pr.sh` / `gh pr merge` on the Scout Report verdict.
#
# Contract (Plan 5 producer / Plan 6 consumer):
#   - /ralph:impl --mode pr posts a `## Scout Trigger` comment when the PR touches
#     frontend globs (the producer side).
#   - This hook is the consumer side: when a merge command is invoked and the PR
#     has a `## Scout Trigger` comment, require a `## Scout Report` reply with
#     verdict `PASS` or `WARN`. Block on `FAIL`. Missing report -> exit 0
#     (advisory-by-design; matches the scout-trigger contract).
#
# Discrimination: parses tool_input.command. No-ops when:
#   - RALPH_COMMAND != "review"
#   - command does not invoke `merge-pr.sh` or `gh pr merge`
#   - PR cannot be resolved from RALPH_TICKET_ID / branch
#
# Exit codes:
#   0 - Allow merge (no Scout Trigger requested, or Scout Report PASS/WARN, or missing report)
#   2 - Block merge (Scout Report FAIL)

set -euo pipefail

INPUT=$(cat)

# Scope: only enforce when invoked from /ralph:review
if [[ "${RALPH_COMMAND:-}" != "review" ]]; then
  exit 0
fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
if [[ -z "$COMMAND" ]]; then
  exit 0
fi

# Match merge commands. `gh pr merge` covers the gh-native path; `merge-pr.sh`
# covers the repo-local script that ralph-merge invokes.
if ! echo "$COMMAND" | grep -qE 'merge-pr\.sh|gh +pr +merge'; then
  exit 0
fi

TICKET_ID="${RALPH_TICKET_ID:-}"
if [[ -z "$TICKET_ID" ]]; then
  # No ticket scope — allow conservatively. The val/merge body owns its own gates.
  exit 0
fi

# Resolve PR number from the feature branch.
ISSUE_NUMBER="${TICKET_ID#GH-}"
BRANCH="feature/GH-${ISSUE_NUMBER}"

PR_NUMBER=$(gh pr list --head "$BRANCH" --json number --jq '.[0].number' 2>/dev/null || echo "")
if [[ -z "$PR_NUMBER" || "$PR_NUMBER" == "null" ]]; then
  # No open PR resolvable — let the merge command itself fail loudly.
  exit 0
fi

COMMENTS_JSON=$(gh pr view "$PR_NUMBER" --json comments --jq '.comments' 2>/dev/null || echo "[]")

# Is there a Scout Trigger comment? (Plan 5 producer side.)
if ! echo "$COMMENTS_JSON" | jq -e '.[] | select(.body | startswith("## Scout Trigger"))' >/dev/null 2>&1; then
  # No Scout Trigger requested — advisory not invoked. Allow.
  exit 0
fi

# Scout Trigger present. Look for a Scout Report reply.
REPORT_BODY=$(echo "$COMMENTS_JSON" | jq -r '[.[] | select(.body | startswith("## Scout Report"))] | last | .body // empty' 2>/dev/null)

if [[ -z "$REPORT_BODY" ]]; then
  # Missing report — advisory-by-design, allow merge.
  exit 0
fi

# Parse verdict from Scout Report body. Expected shape: a line containing
# `verdict: PASS|WARN|FAIL` (case-insensitive). The scouts skill writes this.
VERDICT=$(echo "$REPORT_BODY" | grep -iE '^[[:space:]]*verdict[[:space:]]*:' | head -1 | sed -E 's/^[^:]+:[[:space:]]*//' | tr '[:lower:]' '[:upper:]' | awk '{print $1}')

case "$VERDICT" in
  PASS|WARN)
    exit 0
    ;;
  FAIL)
    cat >&2 <<EOF
Scout Report verdict is FAIL for PR #${PR_NUMBER}.

The /ralph:impl --mode pr scout-trigger heuristic flagged this PR as UI-touching,
and the scouts team's verdict is FAIL. Merging is blocked until either:
  - the failing scout findings are addressed and a fresh Scout Report posts PASS/WARN, OR
  - the verdict is manually overridden by editing the Scout Report comment.

See: ralph/skills/review/merge-gate.md §Scout Report gate.
EOF
    exit 2
    ;;
  *)
    # Unknown verdict shape — pass conservatively; scouts skill owns the format.
    exit 0
    ;;
esac
