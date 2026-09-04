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
  # RALPH_HERDR_NO_HOLD is scoped to THIS invocation and must never be exported
  # globally (a shell profile, a parent environment): rh_ensure_server runs
  # before and outside this subshell, so a global would ride the Herdr server
  # into every pane it later spawns and silently disarm hold_pane for the real
  # panes it exists to hold open.
  (cd "$repo" && RALPH_HERDR_REPO="$repo" RALPH_HERDR_BOARD="$_RH_RESOLVED_BOARD" \
    RALPH_HERDR_SCRIPTS="$scripts" RALPH_HERDR_NO_HOLD=1 bash "$scripts/$script" "$@")
}

rh_dispatch_up() {
  rh_ensure_server || return $?
  rh_run_herdr_script dispatch-up.sh "$@" || return $?
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
  # --lead-only (GH-2461): rh is the ensure/resume surface, and its evidence
  # comes from the scoped ledger, never board ranking. A bare work-team.sh
  # EPIC also staffs the initial fleet (a frontier read) and arms refill —
  # that is the cockpit's team-launch action, a human's deliberate act, not
  # this ensure. A dead lead's armed run outlives it on disk, so the
  # respawned lead is still being refilled; an expired arming is re-armed by
  # the launch action, on purpose (refill is opt-in, NO-GO unattended).
  rh_run_herdr_script work-team.sh "$epic" --lead-only
}

rh_day() {
  local repo board herdr scripts jq_bin script epic phase_rc phase_output rc=0 enter_ui=0
  local teams=()

  if [ -t 0 ] && [ -t 1 ]; then
    enter_ui=1
  fi

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --no-attach)
        enter_ui=0
        ;;
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
    # --lead-only for the same reason rh_team passes it (GH-2461): ensure,
    # never staff — no frontier read on the resume surface.
    phase_output=$(rh_run_herdr_script work-team.sh "$epic" --lead-only 2>&1) || phase_rc=$?
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
  if [ "$enter_ui" -eq 1 ]; then
    rh_run_herdr_script cockpit-open.sh --no-focus --beside-hero || phase_rc=$?
  else
    rh_run_herdr_script cockpit-open.sh --no-focus || phase_rc=$?
  fi
  if [ "$phase_rc" -eq 0 ]; then
    if [ "$enter_ui" -eq 1 ]; then
      rh_phase cockpit ready "cockpit standing beside dispatch"
    else
      rh_phase cockpit ready "cockpit standing without a focus change"
    fi
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

  # Focus moves ONCE, and only at the end of a successful attended run: every
  # phase above prints into the invoking terminal, so an earlier focus buries
  # the output it produced. A run that failed partway keeps focus where the
  # failures are readable — the operator has to see them before being moved.
  if [ "$enter_ui" -eq 1 ] && [ "$rc" -eq 0 ]; then
    phase_rc=0
    rh_run_herdr_script dispatch-up.sh --focus-only || phase_rc=$?
    if [ "$phase_rc" -eq 0 ]; then
      rh_phase focus ready "dispatch seat focused"
    else
      rh_phase focus attention "the day is prepared; the dispatch seat could not be focused"
      rc=1
    fi
  fi

  # An attended day ends at the full Herdr surface. Outside Herdr, the bare
  # client attaches to the already-focused dispatch hero; inside a managed
  # pane, dispatch-up's explicit focus switched the existing client and a
  # second client would only nest the UI. HERDR_PANE_ID is the identity Herdr
  # injects into every pane; HERDR_ENV is additionally exported by session
  # wrappers such as hero.sh. Either proves we are already inside. Automation
  # and --no-attach never cross this boundary.
  if [ "$enter_ui" -eq 1 ] && [ "${HERDR_ENV:-}" != "1" ] && [ -z "${HERDR_PANE_ID:-}" ]; then
    phase_rc=0
    "$herdr" || phase_rc=$?
    if [ "$phase_rc" -ne 0 ]; then
      rh_phase herdr failed "full UI exited before the day seat was attached"
      rc=1
    fi
  fi

  return "$rc"
}
