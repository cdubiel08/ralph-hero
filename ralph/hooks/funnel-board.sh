#!/usr/bin/env bash
# funnel-board — courtesy rail (PreToolUse on Bash): raw board mutations get
# redirected to board.ts. NOT enforcement — board.ts invariants + state-guard
# are the guarantees; this just keeps honest sessions on the sanctioned path.
set -euo pipefail

# The redirect must name a path the model can actually run from any repo.
# CLAUDE_PLUGIN_ROOT is exported to hook processes; fall back to this script's
# own location (hooks/ and scripts/ are siblings under the plugin root).
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BOARD="$PLUGIN_ROOT/scripts/board"

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$CMD" ] || exit 0

BLOCKED_PATTERNS=(
  'gh project item-edit'
  'gh project item-add'
  'gh project item-archive'
  'gh project item-delete'
  'updateProjectV2ItemFieldValue'
  'clearProjectV2ItemFieldValue'
  'addProjectV2ItemById'
  'addSubIssue'
  'removeSubIssue'
  'addBlockedBy'
  'removeBlockedBy'
  'deleteProjectV2Item'
  'updateProjectV2('
)
# Deliberately NOT blocked: `gh issue close` / closeIssue — closing issues
# directly is legitimate; the reconcile/event lane owns folding that in.

# Escape valve, applied PER SEGMENT: a sanctioned board-CLI invocation exempts
# only its own segment, so `board get 1; gh project item-edit ...` still gets
# redirected on the second command. Anchoring to a segment start also keeps a
# quoted argument ("... via scripts/board move") or a trailing comment from
# smuggling a raw mutation past the rail.
BOARD_INVOKE='^[[:space:]]*['\''"]?[A-Za-z0-9_./-]*scripts/board['\''"]?[[:space:]]+[a-z-]'

# Split on shell separators (;, &&, ||, |, &, newline). A separator inside a
# quoted argument splits too — that can only over-redirect, never under-, which
# is the safe direction for a courtesy rail.
SEGMENTS=${CMD%%#*}
SEGMENTS=${SEGMENTS//;/$'\n'}
SEGMENTS=${SEGMENTS//&/$'\n'}
SEGMENTS=${SEGMENTS//|/$'\n'}

while IFS= read -r seg; do
  [ -n "${seg//[[:space:]]/}" ] || continue
  [[ "$seg" =~ $BOARD_INVOKE ]] && continue
  for p in "${BLOCKED_PATTERNS[@]}"; do
    if [[ "$seg" == *"$p"* ]]; then
      echo "Board mutations go through the CLI: $BOARD <cmd> (run '$BOARD help')." >&2
      exit 2
    fi
  done
done <<< "$SEGMENTS"
exit 0
