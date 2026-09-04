#!/usr/bin/env bash
# ledger-transition.sh — board move/claim/release/answer/promote's own
# ledger write (GH-2446): appends {ev: "transition", unit, from, to, actor,
# at} to the herdr ledger via ralph_ledger_append, under ledger.sh's own
# writer mutex/serialization. board.ts never reasons about the tape itself
# — that stays ralph_ledger_append's job (sqlite append, session stamping,
# retry-on-busy) — this script is only the cross-plugin discovery half, the
# same shape as ledger-finish.sh's own (GH-2348): `ralph` cannot know at
# authorship time where a host repo installed `ralph-herdr`, so it resolves
# it the same way herdr-setup.sh already does for its own ralph-herdr-owned
# reads — the registry first, then a vendored checkout, each candidate
# verified by a file only ralph-herdr ships.
#
# Usage: ledger-transition.sh REPO_ROOT UNIT FROM TO ACTOR AT
#   REPO_ROOT  ctx.repoRoot — cd'd into before resolving the ledger's board
#              scope (.ralph.json / .claude/settings.json), since
#              ralph_ledger_path resolves against $PWD and board.ts's own
#              process cwd need not be the repo root.
#   UNIT       issue number.
#   FROM       the state before this call, empty string for a null state
#              (rendered as JSON null — a legacy item never on the v2 board).
#   TO         the state this call moved to (or is re-affirming — promote
#              writes no state and passes its current state as both).
#   ACTOR      ctx.cfg.holder — who made the write.
#   AT         ISO-8601 timestamp — the caller's own clock (ctx.now()), not
#              this script's, so tests can inject it.
#
# Best-effort by contract, exactly like ledger-finish.sh: one stderr line
# and exit 1 on ANY miss — ralph-herdr not installed, no board scope
# discoverable, an append refusal (no sqlite3, a corrupt tape) — never a
# retry, never a blocked caller. board.ts treats this as a silent no-op:
# the board write already landed (the source of truth), and the ledger is a
# derived convenience a missing/broken tape may not cost the caller.
set -euo pipefail

REPO="${1:-}"
UNIT="${2:-}"
FROM="${3-}"
TO="${4:-}"
ACTOR="${5:-}"
AT="${6:-}"
if [ -z "$REPO" ] || [ -z "$UNIT" ] || [ -z "$TO" ] || [ -z "$ACTOR" ] || [ -z "$AT" ]; then
  echo "ledger-transition: usage: ledger-transition.sh REPO_ROOT UNIT FROM TO ACTOR AT" >&2
  exit 1
fi
case "$UNIT" in
  *[!0-9]*)
    echo "ledger-transition: UNIT must be a bare issue number, got '$UNIT'" >&2
    exit 1
    ;;
esac
command -v jq >/dev/null 2>&1 || { echo "ledger-transition: jq is required" >&2; exit 1; }
cd "$REPO" 2>/dev/null || { echo "ledger-transition: cannot cd to REPO_ROOT '$REPO'" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Same discovery chain as ledger-finish.sh's prologue.
_rp_json="${RALPH_HERDR_PLUGINS_JSON:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins.json}"
_rp_root=""
[ -f "$_rp_json" ] && _rp_root=$(jq -r 'map(select(.plugin_id == "ralph-herdr")) | .[0].plugin_root // empty' "$_rp_json" 2>/dev/null) || _rp_root=""
_rp_scripts=""
for _cand in "${RALPH_HERDR_SCRIPTS_DIR:-}" "$_rp_root/scripts" "$REPO/plugin/ralph-herdr/scripts" "$SCRIPT_DIR/../../plugin/ralph-herdr/scripts"; do
  [ -n "$_cand" ] && [ -f "$_cand/ledger.sh" ] && { _rp_scripts="$_cand"; break; }
done
if [ -z "$_rp_scripts" ]; then
  echo "ledger-transition: the ralph-herdr plugin's ledger was not found — nothing to record (install the herdr plugin, or run from a vendored checkout)" >&2
  exit 1
fi

# shellcheck source=/dev/null
. "$_rp_scripts/ledger.sh"

fact=$(jq -n -c --argjson unit "$UNIT" --arg from "$FROM" --arg to "$TO" --arg actor "$ACTOR" --arg at "$AT" \
  '{ev: "transition", unit: $unit, from: (if $from == "" then null else $from end), to: $to, actor: $actor, at: $at}')
ralph_ledger_append "$fact"
