#!/usr/bin/env bash
# Explicit mutating actions for the rh command surface.

rh_server_ready() {
  rh_herdr_server_state >/dev/null 2>&1
}

rh_ensure_server() {
  local herdr state_dir log attempts poll i
  herdr=$(rh_resolve_herdr_bin) || return $?
  rh_server_ready && return 0
  state_dir="${RALPH_HOME:-$HOME/.ralph}/logs"
  mkdir -p "$state_dir" || return 1
  log="$state_dir/herdr-server.log"
  nohup "$herdr" server >>"$log" 2>&1 </dev/null &
  attempts="${RALPH_RH_SERVER_ATTEMPTS:-20}"
  poll="${RALPH_RH_SERVER_POLL_SEC:-1}"
  i=0
  while [ "$i" -lt "$attempts" ]; do
    rh_server_ready && return 0
    sleep "$poll"
    i=$((i + 1))
  done
  echo "rh: Herdr server did not become ready; see $log" >&2
  return 1
}

rh_run_herdr_script() {
  local script="$1" repo scripts
  shift
  rh_resolve_board_once || return $?
  repo=$(rh_repo_root) || return $?
  scripts=$(rh_resolve_herdr_scripts "$repo") || return $?
  (cd "$repo" && RALPH_HERDR_REPO="$repo" RALPH_HERDR_BOARD="$_RH_RESOLVED_BOARD" \
    RALPH_HERDR_SCRIPTS="$scripts" bash "$scripts/$script" "$@")
}

rh_dispatch_up() {
  rh_ensure_server || return $?
  rh_run_herdr_script dispatch-up.sh || return $?
  rh_server_ready
}

rh_cockpit() {
  rh_server_ready || return $?
  rh_run_herdr_script cockpit-open.sh
}

rh_team() {
  local epic="${1:-}"
  if [ "$#" -ne 1 ] || [ -z "$epic" ]; then
    echo "rh team: exactly one positive epic number is required" >&2
    return 64
  fi
  case "$epic" in
    *[!0-9]* | "")
      echo "rh team: exactly one positive epic number is required" >&2
      return 64
      ;;
    *[1-9]*) ;;
    *)
      echo "rh team: exactly one positive epic number is required" >&2
      return 64
      ;;
  esac
  rh_dispatch_up || return $?
  rh_run_herdr_script work-team.sh "$epic"
}

rh_day() {
  local repo board herdr scripts jq_bin script epic phase_rc phase_output rc=0
  local teams=()

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --team)
        shift
        [ "$#" -gt 0 ] || { echo "rh day: --team needs an epic number" >&2; return 64; }
        case "$1" in
          ''|*[!0-9]*) echo "rh day: invalid epic '$1'" >&2; return 64 ;;
          *[1-9]*) ;;
          *) echo "rh day: invalid epic '$1'" >&2; return 64 ;;
        esac
        case " ${teams[*]-} " in *" $1 "*) ;; *) teams+=("$1") ;; esac
        ;;
      *) echo "rh day: unknown argument '$1'" >&2; return 64 ;;
    esac
    shift
  done

  rh_color_init || return $?
  repo=$(rh_repo_root) || return $?
  rh_resolve_board_once || return $?
  board="$_RH_RESOLVED_BOARD"
  herdr=$(rh_resolve_herdr_bin) || return $?
  scripts=$(rh_resolve_herdr_scripts "$repo") || return $?
  jq_bin=$(command -v jq) || {
    echo "rh: jq is unavailable; install jq and retry" >&2
    return 69
  }
  [ -n "$board" ] && [ -n "$herdr" ] && [ -n "$jq_bin" ] || return 69
  for script in dispatch-up.sh reconcile.sh resume-teams.sh work-team.sh cockpit-open.sh; do
    [ -f "$scripts/$script" ] || {
      echo "rh: required Ralph-Herdr script '$script' is unavailable; run 'rh doctor'" >&2
      return 69
    }
  done

  phase_rc=0
  rh_dispatch_up || phase_rc=$?
  if [ "$phase_rc" -ne 0 ]; then
    rh_phase dispatch failed "dependent day phases were not run"
    return "$phase_rc"
  fi
  rh_phase dispatch ready "server and dispatch observed"

  phase_rc=0
  rh_run_herdr_script reconcile.sh || phase_rc=$?
  if [ "$phase_rc" -eq 0 ]; then
    rh_phase reconcile unchanged "scoped state reconciled"
  else
    rh_phase reconcile failed "reconciliation needs attention"
    rc=1
  fi

  phase_rc=0
  phase_output=$(rh_run_herdr_script resume-teams.sh 2>&1) || phase_rc=$?
  [ -z "$phase_output" ] || printf '%s\n' "$phase_output"
  if [ "$phase_rc" -eq 0 ]; then
    case "$phase_output" in
      *": resumed"*) rh_phase teams resumed "durable teams evaluated" ;;
      *) rh_phase teams unchanged "no durable team needed a restart" ;;
    esac
  else
    rh_phase teams attention "resume evidence was ambiguous or unreadable"
    rc=1
  fi

  for epic in ${teams[@]+"${teams[@]}"}; do
    phase_rc=0
    phase_output=$(rh_run_herdr_script work-team.sh "$epic" 2>&1) || phase_rc=$?
    [ -z "$phase_output" ] || printf '%s\n' "$phase_output"
    case "$phase_rc" in
      0)
        case "$phase_output" in
          *"already standing"*|SKIP\ *) rh_phase "team GH-$epic" unchanged "explicit team already satisfied" ;;
          *) rh_phase "team GH-$epic" started "explicit team ensured" ;;
        esac
        ;;
      4) rh_phase "team GH-$epic" skipped "epic is complete or terminal" ;;
      *)
        rh_phase "team GH-$epic" failed "explicit team ensure failed"
        rc=1
        ;;
    esac
  done

  phase_rc=0
  rh_run_herdr_script cockpit-open.sh || phase_rc=$?
  if [ "$phase_rc" -eq 0 ]; then
    rh_phase cockpit ready "cockpit opened or focused"
  else
    rh_phase cockpit failed "cockpit could not be opened"
    rc=1
  fi

  phase_rc=0
  rh_inbox || phase_rc=$?
  if [ "$phase_rc" -eq 0 ]; then
    rh_phase inbox ready "operator summary rendered"
  else
    rh_phase inbox attention "inbox could not be rendered"
    rc=1
  fi

  return "$rc"
}
