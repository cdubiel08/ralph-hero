#!/usr/bin/env bash
# resolve-board — print the ONE path to the board CLI a session should call.
#
# Sessions were observed calling 40 distinct pinned install paths across ten
# days (ways-of-working audit A1): every hand-typed versioned path goes stale
# on the next release, an allowlist cannot name it, and two copies can even
# disagree about the state machine. This script is the stable answer: resolve
# the NEWEST installed ralph plugin's CLI, the same way doctor's
# installed-plugin line (GH-1825) and the herdr plane's installed_board_cli
# (plugin/ralph-herdr/scripts/lib.sh) already do — installPath from the
# plugin registry, version as the tie-break between several registered
# copies. Deliberately a self-contained mirror rather than a source of
# lib.sh: this copy ships inside the Claude plugin and must resolve with
# nothing but bash + jq present.
#
# Contract: ALWAYS prints exactly one path on stdout and exits 0. Every
# fallback is narrated on stderr — never silent, never blocking. The final
# fallback is the in-tree copy beside this script, which is the right answer
# both in a repo checkout and inside an installed plugin (where "in-tree"
# IS that install).
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IN_TREE="$SELF_DIR/board"

CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
REGISTRY="${RALPH_INSTALLED_PLUGINS_FILE:-$CONFIG_DIR/plugins/installed_plugins.json}"

# 1. The registry is the record. Keys are "<name>@<marketplace>", so match
# the name half only; the recorded version is a TIE-BREAK between several
# registered copies, never the reason to prefer the registry — being
# recorded is.
if [ -r "$REGISTRY" ] && command -v jq >/dev/null 2>&1; then
  best=$(jq -r '
      (.plugins // {}) | to_entries[]
      | select((.key | split("@")[0]) == "ralph")
      | .value[]? | select(.installPath != null)
      | ((.version // "0") + "\t" + .installPath + "/scripts/board")' "$REGISTRY" 2>/dev/null |
    while IFS=$'\t' read -r ver path; do
      # `|| continue`, not `&&`: a dangling record LAST in the list would
      # otherwise end the loop non-zero and, under pipefail, wipe the good
      # rows already emitted.
      [ -x "$path" ] || continue
      printf '%s\t%s\n' "$ver" "$path"
    done | sort -V -k1,1 | tail -1 | cut -f2-) || best=""
  if [ -n "$best" ]; then
    printf '%s\n' "$best"
    exit 0
  fi
fi

# 2. No readable record: the newest versioned cache dir is a GUESS, labelled
# as one wherever it is reported (the lib.sh rationale, kept verbatim). Sort
# by the VERSION component (.../ralph/<version>/scripts/board), not the whole
# path — full-path sort would rank marketplace namespace above version.
# shellcheck disable=SC2012  # glob over versioned plugin dirs is the point
best=$(ls "$CONFIG_DIR"/plugins/cache/*/ralph/*/scripts/board 2>/dev/null |
  awk -F/ '{ print $(NF-2) "\t" $0 }' | sort -V -k1,1 | tail -1 | cut -f2-) || best=""
if [ -n "$best" ] && [ -x "$best" ]; then
  echo "resolve-board: plugin registry unreadable ($REGISTRY) — using the newest cached install (a guess, not a record): $best" >&2
  printf '%s\n' "$best"
  exit 0
fi

# 3. In-tree fallback, beside this script. Warned, never silent — a session
# hearing the warning knows it is running the checkout's copy, not a release.
echo "resolve-board: no installed ralph plugin found (registry: $REGISTRY) — falling back to the in-tree copy beside this script: $IN_TREE" >&2
printf '%s\n' "$IN_TREE"
exit 0
