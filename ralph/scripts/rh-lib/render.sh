#!/usr/bin/env bash
# rh-owned rendering. Delegated board output never passes through this file.

rh_color_init() {
  RH_GREEN="" RH_AMBER="" RH_RED="" RH_CYAN="" RH_DIM="" RH_RESET=""
  [ -n "${NO_COLOR:-}" ] && return 0
  case "${RH_COLOR_MODE:-auto}" in
    never) return 0 ;;
    auto) [ -t 1 ] || return 0 ;;
    always) ;;
    *) echo "rh: invalid color mode '${RH_COLOR_MODE:-}'" >&2; return 64 ;;
  esac
  RH_GREEN=$(printf '\033[32m')
  RH_AMBER=$(printf '\033[33m')
  RH_RED=$(printf '\033[31m')
  RH_CYAN=$(printf '\033[36m')
  RH_DIM=$(printf '\033[2m')
  RH_RESET=$(printf '\033[0m')
}

rh_status() {
  local kind="$1" label="$2" value="$3" detail="$4" color glyph glyph_ascii
  case "$kind" in
    healthy) color="$RH_GREEN"; glyph="●"; glyph_ascii="OK" ;;
    attention) color="$RH_AMBER"; glyph="▲"; glyph_ascii="WARN" ;;
    failed) color="$RH_RED"; glyph="■"; glyph_ascii="FAIL" ;;
    action) color="$RH_CYAN"; glyph="◆"; glyph_ascii="DO" ;;
    metadata) color="$RH_DIM"; glyph="·"; glyph_ascii="INFO" ;;
    *) echo "rh: invalid status kind '$kind'" >&2; return 64 ;;
  esac
  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *UTF-8*|*utf8*|*utf-8*) ;;
    *) glyph="$glyph_ascii" ;;
  esac
  printf '%s%s %-12s%s %-16s %s%s%s\n' \
    "$color" "$glyph" "$label" "$RH_RESET" "$value" "$RH_DIM" "$detail" "$RH_RESET"
}

rh_phase() {
  local name="$1" state="$2" detail="$3" kind
  case "$state" in
    ready|unchanged|resumed) kind=healthy ;;
    started) kind=action ;;
    skipped|attention) kind=attention ;;
    failed) kind=failed ;;
    *) echo "rh: invalid phase state '$state'" >&2; return 64 ;;
  esac
  rh_status "$kind" "$name" "$state" "$detail"
}

rh_herdr_status_row() {
  local server_state
  server_state=$(rh_herdr_server_state 2>/dev/null) || {
    rh_status failed herdr 'not evaluated' 'server status unavailable'
    return 1
  }
  rh_status healthy herdr running 'server status observed'
}

rh_dispatch_status() {
  local board repo output rc=0
  rh_color_init || return $?
  repo=$(rh_repo_root) || return $?
  rh_herdr_status_row || rc=1
  board=$(rh_resolve_board) || {
    rh_status failed dispatch 'not evaluated' 'board is unavailable'
    rh_status failed teams 'not evaluated' 'board is unavailable'
    return 1
  }
  output=$("$board" who dispatch 2>&1) || {
    rh_status failed dispatch 'not evaluated' 'dispatch address unavailable'
    rc=1
    output=""
  }
  if [ -n "$output" ]; then
    rh_status healthy dispatch ready 'address observed'
  else
    rh_status failed dispatch 'not evaluated' 'empty dispatch address'
    rc=1
  fi
  output=$("$board" roster 2>&1) || {
    rh_status failed teams 'not evaluated' 'roster unavailable'
    rc=1
    output=""
  }
  if [ -n "$output" ]; then
    rh_status healthy teams ready 'roster observed'
  else
    rh_status failed teams 'not evaluated' 'empty roster'
    rc=1
  fi
  return "$rc"
}

rh_inbox() {
  local board arg
  board=$(rh_resolve_board) || return $?
  for arg in "$@"; do
    case "$arg" in
      --json|--digest) ;;
      --mark)
        echo "rh inbox is read-only; use 'rh board inbox --digest --mark' for the explicit stamp" >&2
        return 64
        ;;
      *) echo "rh inbox: unknown argument '$arg' (accepts --json, --digest)" >&2; return 64 ;;
    esac
  done
  "$board" inbox "$@"
}

rh_fleet() {
  local scripts repo
  rh_resolve_board_once || return $?
  repo=$(rh_repo_root) || return $?
  scripts=$(rh_resolve_herdr_scripts "$repo") || return $?
  # RALPH_HERDR_NO_HOLD for the same reason rh_run_herdr_script sets it, and
  # scoped the same way: this is a subprocess of the invoking terminal, not a
  # pane entrypoint. fleet-status.sh carries no hold_pane trap today; the
  # assertion is about which side of the pane boundary the CALLER is on, and
  # is not conditional on which script happens to trap.
  (cd "$repo" && RALPH_HERDR_REPO="$repo" RALPH_HERDR_BOARD="$_RH_RESOLVED_BOARD" \
    RALPH_HERDR_NO_HOLD=1 bash "$scripts/fleet-status.sh" "$@")
}

rh_doctor() {
  local board repo rc=0
  repo=$(rh_repo_root) || return $?
  rh_resolve_board_once || return $?
  board="$_RH_RESOLVED_BOARD"
  "$board" doctor || rc=1
  RALPH_HERDR_REPO="$repo" RALPH_HERDR_BOARD="$board" bash "$RH_SCRIPT_DIR/herdr-setup.sh" check || rc=1
  return "$rc"
}

rh_home_prompt() {
  local choice
  printf '\n[d] start day   [c] cockpit   [i] inbox   [f] fleet   [q] quit\n> '
  IFS= read -r choice || return 0
  case "$choice" in
    d) rh_day ;;
    c) rh_cockpit ;;
    i) rh_inbox ;;
    f) rh_fleet ;;
    q|'') return 0 ;;
    *) echo "unknown action '$choice'" >&2; return 64 ;;
  esac
}

rh_home() {
  local board repo rc=0
  rh_color_init || return $?
  repo=$(rh_repo_root) || return $?
  printf 'ralph hero  %s\n\n' "$(basename "$repo")"
  rh_herdr_status_row || rc=1
  board=$(rh_resolve_board) || return $?
  printf '\nBRIEF\n'
  "$board" brief || rc=1
  printf '\nINBOX\n'
  "$board" inbox || rc=1
  if [ -t 0 ] && [ -t 1 ]; then
    rh_home_prompt || rc=$?
  fi
  return "$rc"
}

rh_render_help() {
  case "${1:-}" in
    ""|rh)
      cat <<'EOF'
Usage: rh [--color=auto|always|never] COMMAND [ARGS...]

Commands:
  board <args...>       Run the existing board CLI unchanged
  dispatch              Show dispatch status
  dispatch up           Ensure dispatch prerequisites without changing focus
  dispatch day          Prepare the day; enter Herdr from an interactive shell
  day                   Alias for "rh dispatch day"
  cockpit               Open the Ralph cockpit
  team EPIC             Ensure one named epic team
  fleet                 Show fleet status
  inbox                 Show operator attention items
  doctor                Diagnose Ralph and Herdr setup
  help [COMMAND]        Show command help
  version               Show the rh version

Run "rh help COMMAND" for command-specific help.
EOF
      ;;
    board)
      printf '%s\n' 'Usage: rh board <existing-board-args...>'
      ;;
    day)
      cat <<'EOF'
Usage: rh day [--team EPIC]... [--no-attach]

Ensure dispatch, reconcile scoped state, resume evidence-backed teams, ensure
the cockpit beside dispatch, and render the inbox. From an interactive terminal
the command then enters the full Herdr UI focused on this repository's dispatch
hero. Inside Herdr it focuses that seat without nesting a second client.

--no-attach keeps the calling shell in place. Non-interactive invocations also
prepare the day without changing focus or attaching a client.
EOF
      ;;
    *)
      echo "rh: unknown help topic '$1'; run 'rh help'" >&2
      return 64
      ;;
  esac
}
