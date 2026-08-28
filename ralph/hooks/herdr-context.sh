#!/usr/bin/env bash
# herdr-context — SessionStart observation. When this session is hosted in a
# herdr pane (HERDR_ENV=1 — the ralph-herdr cockpit), emit ONE orientation
# line; SessionStart stdout becomes session context. Outside herdr it is a
# strict no-op: exit 0, no output, stdin untouched. Like every hook here it
# is NOT enforcement — the reference doc and the skills carry the real
# guidance; this line only makes a cockpit-hosted session look before it
# leaps. NEVER exits non-zero.
set -euo pipefail

[ "${HERDR_ENV:-}" = "1" ] || exit 0

# CLAUDE_PLUGIN_ROOT is exported to hook processes; fall back to this script's
# own location (hooks/ and skills/ are siblings under the plugin root).
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

echo "cockpit-hosted session (herdr): self-report lifecycle at the natural checkpoints via the pane state token — herdr pane report-metadata \"\$HERDR_PANE_ID\" --source ralph-herdr --token state=<working|blocked|reporting>; herdr reference: $PLUGIN_ROOT/skills/work/references/herdr-api.md; escalations must be phone-answerable (first line <=240 chars stating the decision, enumerated options with one recommended default)."

# Who-is-who (GH-2217, D4.2): the chain of command the spawner derived and
# exported into this pane's env — own address, lead (or dispatch when
# leadless), nothing else. Peers are deliberately NOT listed: they are found
# by enumeration at the moment of need (board peer NNN), because a peer list
# stamped at spawn is stale the moment a sibling exits. Absent env (a
# hand-started pane, an older spawner) emits nothing — the skills carry the
# protocol either way; this line only saves the session the derivation.
if [ -n "${RALPH_HERDR_ADDRESS:-}${WHO_LEAD:-}${WHO_DISPATCH:-}" ]; then
  who="chain of command:"
  [ -n "${RALPH_HERDR_ADDRESS:-}" ] && who="$who you are $RALPH_HERDR_ADDRESS;"
  if [ -n "${WHO_LEAD:-}" ]; then
    who="$who your lead is $WHO_LEAD — escalations route to it (board move NNN human-needed --why), answers come back on the item;"
  elif [ -n "${WHO_DISPATCH:-}" ]; then
    who="$who leadless — you answer to dispatch;"
  fi
  [ -n "${WHO_DISPATCH:-}" ] && who="$who dispatch is $WHO_DISPATCH (reachable, never a rung);"
  echo "$who peers by enumeration only — board peer NNN, never a constructed name."
fi

# Operator-ask routing (GH-2074/GH-2075). Host repos install ralph as a plugin
# and have no ralph-hero CLAUDE.md, so this line is the ONLY place a fresh
# session learns the sanctioned entry points; measured without it, every
# session re-derives them in 5-15 tool calls and small models land on the
# wrong surface. The herdr action forms are used because they resolve from
# any cwd — a host repo has no plugin/ralph-herdr/ checkout to path into.
#
# The cheat sheet ships in the ralph-herdr HERDR plugin, not this Claude
# plugin — $CLAUDE_PLUGIN_ROOT is the wrong tree — so its path is resolved
# from herdr's own registry. Best-effort: a missing herdr/jq or an
# unregistered plugin degrades to naming the install, never to a broken path
# and never to a non-zero exit.
CHEAT="CHEATSHEET.md in the ralph-herdr plugin install (herdr plugin list --json | jq -r '.result.plugins[]|select(.plugin_id==\"ralph-herdr\").plugin_root')"
if command -v herdr >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  root=$(herdr plugin list --json 2>/dev/null \
    | jq -r '.result.plugins[] | select(.plugin_id == "ralph-herdr") | .plugin_root' 2>/dev/null || true)
  [ -n "${root:-}" ] && [ -f "$root/CHEATSHEET.md" ] && CHEAT="$root/CHEATSHEET.md"
fi
echo "operator asks, answered (do not re-derive): 'launch a fleet' -> herdr plugin action invoke work-fleet --plugin ralph-herdr (or work-these for named issues); 'open the cockpit' -> herdr plugin action invoke cockpit --plugin ralph-herdr; 'board status / who is working' -> board list + board next + herdr agent list. Full cheat sheet: $CHEAT"
exit 0
