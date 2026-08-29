#!/usr/bin/env bash
# Explicit mutating actions for the rh command surface.

rh_server_ready() {
  local herdr
  herdr=$(rh_resolve_herdr_bin) || return $?
  "$herdr" status server --json >/dev/null 2>&1
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
  repo=$(rh_repo_root) || return $?
  scripts=$(rh_resolve_herdr_scripts "$repo") || return $?
  (cd "$repo" && RALPH_HERDR_REPO="$repo" RALPH_HERDR_SCRIPTS="$scripts" bash "$scripts/$script" "$@")
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
