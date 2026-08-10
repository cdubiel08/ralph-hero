#!/usr/bin/env bash
# herdr-setup.sh — check (and optionally wire) the herdr cockpit for a ralph repo.
#
# The single source of truth for "is herdr set up for this board": /ralph:help
# herdr drives it interactively, and `board doctor` shells out to
# `check --oneline` for its advisory herdr-cockpit line. Nothing here touches
# board state; `fix` mutates only herdr's own config (plugin link/install,
# integration install) and announces every mutation before running it.
#
# Usage:
#   herdr-setup.sh [check] [--oneline]   report each prerequisite; no mutations
#   herdr-setup.sh fix                   perform the safely-automatable steps,
#                                        print exact manual commands for the rest
#
# Exit codes (check): 0 fully wired · 1 gaps found · 2 herdr not installed.
# --oneline prints exactly one machine-readable line ("herdr: …") for doctor.
#
# Knobs (same names the cockpit scripts use):
#   HERDR_BIN_PATH      herdr binary (default: `herdr` on PATH)
#   RALPH_HERDR_BOARD   board CLI path for host repos that install ralph as a
#                       Claude Code plugin (no ralph/ tree in the repo)
#   RALPH_HERDR_REPO    repo to check (default: $PWD)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${RALPH_HERDR_REPO:-$PWD}"
HERDR="${HERDR_BIN_PATH:-herdr}"
MIN_HERDR="0.8.0"
PLUGIN_SPEC="cdubiel08/ralph-hero/plugin/ralph-herdr"

MODE="check"
ONELINE=""
for arg in "$@"; do
  case "$arg" in
    check | fix) MODE="$arg" ;;
    --oneline) ONELINE=1 ;;
    *) echo "herdr-setup.sh: unknown argument '$arg' (usage: [check|fix] [--oneline])" >&2; exit 64 ;;
  esac
done

# Gaps accumulate as "name|how to close it" lines; notes are advisory only and
# never affect the exit code.
GAPS=()
NOTES=()
say() { [ -n "$ONELINE" ] || echo "$@"; }
pass() { say "  ok   $1 — $2"; }
gap() { GAPS+=("$1|$2"); say "  GAP  $1 — $2"; }
note() { NOTES+=("$1|$2"); say "  note $1 — $2"; }

# ── herdr binary + version ───────────────────────────────────────────────────
if ! command -v "$HERDR" >/dev/null 2>&1; then
  if [ -n "$ONELINE" ]; then echo "herdr: not installed"; else
    echo "herdr is not installed (looked for '$HERDR')."
    echo "Install it from https://herdr.dev/ — everything else waits on this."
  fi
  exit 2
fi

# Version: first x.y.z in --version output; unparseable degrades to a note,
# never a false gap.
ver=$("$HERDR" --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
if [ -z "$ver" ]; then
  note "herdr-version" "could not parse '$HERDR --version'; need >= $MIN_HERDR"
else
  # component-wise compare, bash-3.2-safe
  newer=$(printf '%s\n%s\n' "$MIN_HERDR" "$ver" | awk -F. '
    NR==1 { m1=$1; m2=$2; m3=$3 }
    NR==2 { if ($1>m1 || ($1==m1 && ($2>m2 || ($2==m2 && $3>=m3)))) print "yes" }')
  if [ "$newer" = "yes" ]; then pass "herdr-version" "$ver (>= $MIN_HERDR)"
  else gap "herdr-version" "$ver < $MIN_HERDR — upgrade herdr (https://herdr.dev/)"; fi
fi

# ── jq ───────────────────────────────────────────────────────────────────────
if command -v jq >/dev/null 2>&1; then pass "jq" "$(jq --version 2>/dev/null || echo present)"
else gap "jq" "not on PATH — the cockpit scripts require it (brew install jq)"; fi

# ── server reachable ─────────────────────────────────────────────────────────
SERVER_UP=""
if "$HERDR" agent list >/dev/null 2>&1; then
  SERVER_UP=1
  pass "herdr-server" "reachable"
else
  gap "herdr-server" "not reachable — start herdr (run \`herdr\` in a terminal)"
fi

# ── ralph-herdr plugin installed/linked ──────────────────────────────────────
PLUGIN_MISSING=""
PLUGIN_DISABLED=""
if [ -n "$SERVER_UP" ]; then
  if plugins=$("$HERDR" plugin list 2>/dev/null) && grep -q "ralph-herdr.*enabled" <<<"$plugins"; then
    pass "ralph-herdr-plugin" "installed and enabled"
  elif grep -q "ralph-herdr" <<<"${plugins:-}"; then
    PLUGIN_DISABLED=1
    gap "ralph-herdr-plugin" "installed but disabled — herdr plugin enable ralph-herdr"
  else
    PLUGIN_MISSING=1
    gap "ralph-herdr-plugin" "not installed — herdr plugin install $PLUGIN_SPEC (or \`herdr plugin link <checkout>/plugin/ralph-herdr\` for a dev checkout)"
  fi
else
  note "ralph-herdr-plugin" "not checked (server down)"
fi

# ── claude integration (optional but recommended) ────────────────────────────
INTEGRATION_MISSING=""
if [ -n "$SERVER_UP" ]; then
  intline=$("$HERDR" integration status 2>/dev/null | grep '^claude:' || true)
  case "$intline" in
    *"not installed"* | "")
      INTEGRATION_MISSING=1
      note "claude-integration" "not installed — recommended: herdr integration install claude (session-identity restore after server restart)"
      ;;
    *current*) pass "claude-integration" "$intline" ;;
    *)
      INTEGRATION_MISSING=1
      note "claude-integration" "$intline — recommended: herdr integration install claude to refresh"
      ;;
  esac
else
  note "claude-integration" "not checked (server down)"
fi

# ── board CLI reachable the way the cockpit scripts will look for it ─────────
# Mirrors lib.sh's resolution order (GH-1761): RALPH_HERDR_BOARD > vendored
# ralph/ tree > newest installed Claude Code plugin copy. Change them together.
if [ -n "${RALPH_HERDR_BOARD:-}" ]; then
  if [ -x "$RALPH_HERDR_BOARD" ]; then
    pass "board-cli" "RALPH_HERDR_BOARD=$RALPH_HERDR_BOARD (note: reaches herdr panes only if the herdr SERVER was started with it)"
  else gap "board-cli" "RALPH_HERDR_BOARD=$RALPH_HERDR_BOARD is not executable"; fi
elif [ -x "$REPO/ralph/scripts/board" ]; then
  pass "board-cli" "$REPO/ralph/scripts/board (vendored-checkout layout)"
else
  # shellcheck disable=SC2012  # glob over versioned plugin dirs; ls+sort -V is the point
  installed=$(ls "$HOME"/.claude/plugins/cache/*/ralph/*/scripts/board 2>/dev/null | sort -V | tail -1 || true)
  if [ -n "$installed" ] && [ -x "$installed" ]; then
    pass "board-cli" "$installed (installed plugin copy — the cockpit scripts discover this automatically)"
  else
    gap "board-cli" "no board CLI found (no ralph/ tree in $REPO, no installed ralph plugin under ~/.claude/plugins/cache) — install the ralph Claude Code plugin"
  fi
fi

# ── gh auth scopes ───────────────────────────────────────────────────────────
if ! command -v gh >/dev/null 2>&1; then
  gap "gh-auth" "gh is not installed"
elif auth=$(gh auth status 2>&1) && grep -q "project" <<<"$auth"; then
  pass "gh-auth" "authenticated with project scope"
elif [ -n "$auth" ] && grep -qi "logged in" <<<"$auth"; then
  gap "gh-auth" "authenticated but no 'project' scope — gh auth refresh -s repo,project"
else
  gap "gh-auth" "not authenticated — gh auth login -s repo,project"
fi

# ── report / oneline ─────────────────────────────────────────────────────────
# Note the length guards before every "${GAPS[@]}" expansion: macOS ships
# bash 3.2, where an empty array trips `set -u` even quoted.
gapnames() {
  local IFS=,; local names=() g
  [ "${#GAPS[@]}" -gt 0 ] && for g in "${GAPS[@]}"; do names+=("${g%%|*}"); done
  echo "${names[*]}"
}

if [ -n "$ONELINE" ]; then
  if [ "${#GAPS[@]}" -eq 0 ]; then echo "herdr: wired"
  else echo "herdr: ${#GAPS[@]} gap(s) — $(gapnames)"; fi
fi

if [ "$MODE" = "check" ]; then
  [ "${#GAPS[@]}" -eq 0 ] && exit 0 || exit 1
fi

# ── fix mode: close what is safely automatable, print the rest ───────────────
[ -n "$ONELINE" ] && { echo "herdr-setup.sh: --oneline is check-only" >&2; exit 64; }

if [ "${#GAPS[@]}" -eq 0 ] && [ -z "$INTEGRATION_MISSING" ]; then
  echo "nothing to fix — the cockpit is wired."
  exit 0
fi

echo
echo "fixing what can be safely automated:"

if [ -n "$PLUGIN_DISABLED" ] && [ -n "$SERVER_UP" ]; then
  echo "→ herdr plugin enable ralph-herdr"
  "$HERDR" plugin enable ralph-herdr
fi

if [ -n "$PLUGIN_MISSING" ] && [ -n "$SERVER_UP" ]; then
  if [ -d "$REPO/plugin/ralph-herdr" ]; then
    echo "→ herdr plugin link $REPO/plugin/ralph-herdr"
    "$HERDR" plugin link "$REPO/plugin/ralph-herdr"
  else
    echo "→ herdr plugin install $PLUGIN_SPEC"
    "$HERDR" plugin install "$PLUGIN_SPEC"
  fi
fi

if [ -n "$INTEGRATION_MISSING" ] && [ -n "$SERVER_UP" ]; then
  echo "→ herdr integration install claude"
  "$HERDR" integration install claude || echo "  (integration install failed — optional, continuing)"
fi

# Everything left needs a human hand (installs, auth, env) — print exact
# commands rather than guessing at package managers or touching credentials.
manual=0
if [ "${#GAPS[@]}" -gt 0 ]; then
  for g in "${GAPS[@]}"; do
    case "${g%%|*}" in
      ralph-herdr-plugin) continue ;; # handled above (when the server was up)
      *)
        [ "$manual" -eq 0 ] && { echo; echo "remaining manual steps:"; manual=1; }
        echo "  ${g%%|*}: ${g#*|}"
        ;;
    esac
  done
fi
[ "$manual" -eq 0 ] && echo "done."
exit 0
