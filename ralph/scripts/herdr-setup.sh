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
#   RALPH_HERDR_PLUGINS_JSON  herdr's plugin registry (default:
#                       ${XDG_CONFIG_HOME:-~/.config}/herdr/plugins.json)
#   RALPH_HERDR_VERSION_STAMP  file naming the ralph-herdr version this ralph
#                       release expects (default: alongside this script)
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
# component-wise compare, bash-3.2-safe: ver_ge A B → true when A >= B.
ver_ge() {
  printf '%s\n%s\n' "$2" "$1" | awk -F. '
    NR==1 { m1=$1+0; m2=$2+0; m3=$3+0 }
    NR==2 { if ($1+0>m1 || ($1+0==m1 && ($2+0>m2 || ($2+0==m2 && $3+0>=m3)))) print "yes" }' |
    grep -q yes
}

ver=$("$HERDR" --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
if [ -z "$ver" ]; then
  note "herdr-version" "could not parse '$HERDR --version'; need >= $MIN_HERDR"
else
  if ver_ge "$ver" "$MIN_HERDR"; then pass "herdr-version" "$ver (>= $MIN_HERDR)"
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

# ── herdr plugin state: authoritative root + version ─────────────────────────
# herdr registers every installed/linked plugin in plugins.json, recording the
# real on-disk root (`plugin_root`) for all three source kinds. That is the
# only reliable way to find files that ship inside the herdr plugin: the ralph
# plugin's own SCRIPT_DIR is a Claude Code cache path with no plugin/ sibling.
# One read, no network — this stays cheap enough for doctor's info line.
HERDR_PLUGINS_JSON="${RALPH_HERDR_PLUGINS_JSON:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins.json}"
PLUGIN_ROOT=""
plugin_entry=""
if command -v jq >/dev/null 2>&1 && [ -f "$HERDR_PLUGINS_JSON" ]; then
  plugin_entry=$(jq -c 'map(select(.plugin_id == "ralph-herdr")) | .[0] // empty' \
    "$HERDR_PLUGINS_JSON" 2>/dev/null || true)
  [ -n "$plugin_entry" ] && PLUGIN_ROOT=$(jq -r '.plugin_root // empty' <<<"$plugin_entry")
fi

# ── ralph-herdr plugin currency ──────────────────────────────────────────────
# herdr has no `plugin update` and no refresh-on-launch, while the ralph plugin
# IS auto-updated by Claude Code — so the two halves of the cockpit drift apart
# silently. Compare herdr's registered version against the stamp this ralph
# release ships. Every unknown degrades to a note: an older ralph plugin
# against a newer herdr plugin must never manufacture a false gap.
STAMP_FILE="${RALPH_HERDR_VERSION_STAMP:-$SCRIPT_DIR/herdr-plugin-version}"
stamp_ver=$(grep -Eo '^[0-9]+\.[0-9]+\.[0-9]+' "$STAMP_FILE" 2>/dev/null | head -1 || true)
plugin_ver=""
[ -n "$plugin_entry" ] && plugin_ver=$(jq -r '.version // empty' <<<"$plugin_entry" |
  grep -Eo '^[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
if ! command -v jq >/dev/null 2>&1; then
  note "ralph-herdr-version" "not evaluated (jq unavailable)"
elif [ -z "$plugin_entry" ]; then
  note "ralph-herdr-version" "not evaluated (no ralph-herdr entry in $HERDR_PLUGINS_JSON)"
elif [ -z "$stamp_ver" ]; then
  note "ralph-herdr-version" "not evaluated (no version stamp in this ralph plugin copy)"
elif [ -z "$plugin_ver" ]; then
  note "ralph-herdr-version" "not evaluated (herdr records no parseable version for ralph-herdr)"
elif ver_ge "$plugin_ver" "$stamp_ver"; then
  pass "ralph-herdr-version" "$plugin_ver (this ralph expects >= $stamp_ver)"
else
  src_kind=$(jq -r '.source.kind // empty' <<<"$plugin_entry")
  if [ "$src_kind" = "github" ]; then
    # The DRIFT is known here (plugin_ver < stamp_ver) — only the remedy string
    # depends on herdr's source metadata, so incomplete coordinates downgrade
    # the command, never the gap. `jq -r` renders a missing field as the string
    # "null", and `//` does not catch an EMPTY ref, so both are checked
    # explicitly: a copy-pasteable `install null/null/null --ref  -y` would be
    # worse than naming the canonical spec.
    # Read one field at a time: a tab-separated read would collapse empty
    # fields (tab is IFS whitespace in bash) and silently shift the values.
    src_field() { jq -r --arg f "$1" '.source[$f] // empty | tostring' <<<"$plugin_entry"; }
    src_owner=$(src_field owner)
    src_repo=$(src_field repo)
    src_subdir=$(src_field subdir)
    src_ref=$(src_field requested_ref)
    [ -n "$src_ref" ] || src_ref="main"
    if [ -n "$src_owner" ] && [ -n "$src_repo" ] && [ -n "$src_subdir" ]; then
      reinstall="herdr plugin install $src_owner/$src_repo/$src_subdir --ref $src_ref -y"
    else
      reinstall="herdr plugin install $PLUGIN_SPEC -y (herdr records incomplete source coordinates for this install — verify the spec before running)"
    fi
    gap "ralph-herdr-version" "$plugin_ver < $stamp_ver expected by this ralph — herdr has no auto-update; reinstall: $reinstall"
  else
    note "ralph-herdr-version" "$plugin_ver < $stamp_ver expected by this ralph — local source at ${PLUGIN_ROOT:-unknown}; update that checkout"
  fi
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
  # Sorted by the VERSION component, not the whole path (namespace would win).
  # shellcheck disable=SC2012  # glob over versioned plugin dirs is the point
  installed=$(ls "$HOME"/.claude/plugins/cache/*/ralph/*/scripts/board 2>/dev/null |
    awk -F/ '{ print $(NF-2) "\t" $0 }' | sort -V -k1,1 | tail -1 | cut -f2- || true)
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

# ── watcher lineage closure (advisory — L10, doctor-lineage.sh) ──────────────
# Relayed at NOTE level only, on purpose: `board doctor` consumes this
# script's verdict as its info-level herdr-cockpit line, and a lineage
# finding is watcher telemetry (a missed reconcile), never a cockpit wiring
# gap — it must move neither the exit code nor the --oneline gap count. The
# check itself lives with the watcher (the herdr plugin), so it is found via
# herdr's registered plugin_root (correct for github installs, local links and
# checkouts alike); the repo-relative guess remains as the last fallback for a
# vendored checkout whose plugin herdr does not know about.
lineage_sh="${RALPH_HERDR_LINEAGE_SH:-}"
if [ -z "$lineage_sh" ]; then
  lineage_sh="$SCRIPT_DIR/../../plugin/ralph-herdr/scripts/doctor-lineage.sh"
  [ -n "$PLUGIN_ROOT" ] && [ -f "$PLUGIN_ROOT/scripts/doctor-lineage.sh" ] &&
    lineage_sh="$PLUGIN_ROOT/scripts/doctor-lineage.sh"
fi
if [ ! -f "$lineage_sh" ]; then
  note "watcher-lineage" "not evaluated (doctor-lineage.sh not found — it ships inside the ralph-herdr herdr plugin)"
elif [ -z "$SERVER_UP" ]; then
  note "watcher-lineage" "not checked (server down)"
else
  lineage_rc=0
  lineage_out=$(bash "$lineage_sh" 2>/dev/null) || lineage_rc=$?
  case "$lineage_rc" in
    0) note "watcher-lineage" "closed — every live ralph agent has exactly one open ledger record" ;;
    1)
      lineage_gaps=$(grep -c '^  GAP ' <<<"$lineage_out" || true)
      note "watcher-lineage" "${lineage_gaps:-some} lineage finding(s) — bash $lineage_sh for detail"
      if [ -z "$ONELINE" ]; then
        grep '^  GAP ' <<<"$lineage_out" | sed 's/^  GAP  /       · /' || true
      fi
      ;;
    2) note "watcher-lineage" "not evaluable (herdr unreachable mid-check)" ;;
    *) note "watcher-lineage" "not evaluated (doctor-lineage.sh exited $lineage_rc)" ;;
  esac
fi

# ── orphaned herdr processes (advisory — GH-1888, doctor-orphans.sh) ─────────
# Same NOTE-level contract as the lineage relay above, and for the same reason:
# a process outliving its pane is telemetry about the machine, never a cockpit
# wiring gap, so it must move neither the exit code nor the --oneline gap count.
# Resolved the same way (herdr's registered plugin_root first, repo-relative
# guess as the fallback for a vendored checkout).
orphans_sh="${RALPH_HERDR_ORPHANS_SH:-}"
if [ -z "$orphans_sh" ]; then
  orphans_sh="$SCRIPT_DIR/../../plugin/ralph-herdr/scripts/doctor-orphans.sh"
  [ -n "$PLUGIN_ROOT" ] && [ -f "$PLUGIN_ROOT/scripts/doctor-orphans.sh" ] &&
    orphans_sh="$PLUGIN_ROOT/scripts/doctor-orphans.sh"
fi
if [ ! -f "$orphans_sh" ]; then
  note "watcher-orphans" "not evaluated (doctor-orphans.sh not found — it ships inside the ralph-herdr herdr plugin)"
elif [ -z "$SERVER_UP" ]; then
  note "watcher-orphans" "not checked (server down)"
else
  orphans_rc=0
  orphans_out=$(bash "$orphans_sh" 2>/dev/null) || orphans_rc=$?
  case "$orphans_rc" in
    0) note "watcher-orphans" "no orphans — every herdr process still has its pane" ;;
    1)
      orphans_gaps=$(grep -c '^  GAP ' <<<"$orphans_out" || true)
      note "watcher-orphans" "${orphans_gaps:-some} orphaned process(es) — bash $orphans_sh for detail (nothing is killed for you)"
      if [ -z "$ONELINE" ]; then
        grep '^  GAP ' <<<"$orphans_out" | sed 's/^  GAP  /       · /' || true
      fi
      ;;
    2) note "watcher-orphans" "not evaluable (herdr unreachable, or this system's ps hides process environments)" ;;
    *) note "watcher-orphans" "not evaluated (doctor-orphans.sh exited $orphans_rc)" ;;
  esac
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
