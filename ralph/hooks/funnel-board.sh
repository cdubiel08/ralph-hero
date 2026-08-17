#!/usr/bin/env bash
# funnel-board — courtesy rail (PreToolUse on Bash): raw board mutations get
# redirected to board.ts. NOT enforcement — board.ts invariants + state-guard
# are the guarantees; this just keeps honest sessions on the sanctioned path.
set -euo pipefail

# The quote-aware command reader every funnel shares (GH-2058). A courtesy rail
# that cannot read its own library must fail OPEN — never block a command
# because a file is missing (the direction hooks.json's CLAUDE_PLUGIN_ROOT
# guard already takes, GH-2045). Resolved beside THIS script rather than from
# CLAUDE_PLUGIN_ROOT: the library is an implementation detail of this file, so
# the copy that ships with it is the one that must be read.
CS_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/lib/cmdscan.sh"
[ -r "$CS_LIB" ] || exit 0
# shellcheck source=lib/cmdscan.sh
. "$CS_LIB" || exit 0

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

# Split on UNQUOTED shell separators (;, &&, ||, |, &, newline), dropping
# unquoted comments. cs_segments walks the whole command once (GH-2058), so a
# separator or a `#` inside a quoted argument is not one and a quoted span
# running across newlines stays in a SINGLE segment.
#
# What this replaced was a chain of bash substitutions feeding a line-at-a-time
# read, and it had the defect twice over: a multi-line `--body` was cut into
# pieces at every newline and at every `;`/`&`/`|` inside it, AND the quotes
# bounding it then landed in different segments, so each segment's `sed` had
# nothing to match and stripped nothing. The result was that a body which
# merely MENTIONED `gh project item-edit` was refused as though it were running
# one — reproduced against this rail while writing the fix.
while IFS= read -r -d "$CS_SEP" seg; do
  # What is QUOTED is usually an argument, not a command being run (GH-1930):
  # filing an issue whose body describes `gh project item-edit` mutates no
  # board, and refusing it makes this rail unable to be written about. The
  # exception is exact and load-bearing: `gh api` carries its GraphQL mutation
  # INSIDE quotes (`-f query='mutation { addSubIssue(...) }'`), so a segment
  # invoking it is matched whole. Everywhere else the quoted spans are
  # stripped, which can only under-redirect — the safe direction here.
  case "$seg" in
    *"gh api"*) ;;
    *) seg=$(cs_strip_quotes "$seg") ;;
  esac
  [ -n "${seg//[[:space:]]/}" ] || continue
  [[ "$seg" =~ $BOARD_INVOKE ]] && continue
  for p in "${BLOCKED_PATTERNS[@]}"; do
    if [[ "$seg" == *"$p"* ]]; then
      echo "Board mutations go through the CLI: $BOARD <cmd> (run '$BOARD help')." >&2
      exit 2
    fi
  done
done < <(cs_segments "$CMD")
exit 0
