#!/usr/bin/env bash
# Shared executable and repository resolution for the rh command surface.

rh_resolve_board() {
  local board
  if [ -n "${RALPH_BOARD:-}" ]; then
    [ -x "$RALPH_BOARD" ] || {
      echo "rh: RALPH_BOARD=$RALPH_BOARD is not executable" >&2
      return 69
    }
    printf '%s\n' "$RALPH_BOARD"
    return 0
  fi
  board=$(bash "$RH_SCRIPT_DIR/resolve-board.sh") || return 69
  [ -n "$board" ] && [ -x "$board" ] || {
    echo "rh: board CLI is unavailable; run 'rh doctor'" >&2
    return 69
  }
  printf '%s\n' "$board"
}

rh_repo_root() {
  local start="${1:-$PWD}" root
  root=$(git -C "$start" rev-parse --show-toplevel 2>/dev/null) || {
    echo "rh: $start is not inside a Git repository" >&2
    return 69
  }
  printf '%s\n' "$root"
}

rh_resolve_herdr_bin() {
  local herdr="${HERDR_BIN_PATH:-herdr}"
  command -v "$herdr" >/dev/null 2>&1 || {
    echo "rh: Herdr is unavailable (looked for '$herdr'); run 'rh doctor'" >&2
    return 69
  }
  command -v "$herdr"
}

rh_resolve_herdr_scripts() {
  local repo="${1:-$PWD}" registry root candidate
  if [ -n "${RALPH_HERDR_SCRIPTS_DIR:-}" ]; then
    [ -f "$RALPH_HERDR_SCRIPTS_DIR/dispatch-up.sh" ] || {
      echo "rh: RALPH_HERDR_SCRIPTS_DIR=$RALPH_HERDR_SCRIPTS_DIR is not a Ralph-Herdr scripts directory" >&2
      return 69
    }
    printf '%s\n' "$RALPH_HERDR_SCRIPTS_DIR"
    return 0
  fi
  registry="${RALPH_HERDR_PLUGINS_JSON:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins.json}"
  if [ -r "$registry" ] && command -v jq >/dev/null 2>&1; then
    root=$(jq -r 'map(select(.plugin_id == "ralph-herdr")) | .[0].plugin_root // empty' "$registry" 2>/dev/null) || root=""
    [ -n "$root" ] && [ -f "$root/scripts/dispatch-up.sh" ] && {
      printf '%s\n' "$root/scripts"
      return 0
    }
  fi
  for candidate in "$repo/plugin/ralph-herdr/scripts" "$RH_SCRIPT_DIR/../../plugin/ralph-herdr/scripts"; do
    [ -f "$candidate/dispatch-up.sh" ] && {
      printf '%s\n' "$candidate"
      return 0
    }
  done
  echo "rh: Ralph-Herdr scripts not found; run 'rh doctor' or install/link the ralph-herdr plugin" >&2
  return 69
}

rh_version() {
  local manifest="$RH_SCRIPT_DIR/../.claude-plugin/plugin.json" version=""
  [ -n "${RALPH_RH_VERSION:-}" ] && {
    printf '%s\n' "$RALPH_RH_VERSION"
    return 0
  }
  [ -r "$manifest" ] && command -v jq >/dev/null 2>&1 &&
    version=$(jq -r '.version // empty' "$manifest" 2>/dev/null) || version=""
  printf '%s\n' "${version:-dev}"
}
