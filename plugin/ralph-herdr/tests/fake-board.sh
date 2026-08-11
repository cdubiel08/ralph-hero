#!/usr/bin/env bash
# fake-board.sh — a `board` CLI shim for the fleet tests, sibling of
# fake-herdr.sh: replays canned JSON per subcommand from a fixtures dir and
# records every invocation to a log so tests can assert exactly which board
# calls a script made (claim join per sibling above all). No network, no
# GitHub — pure files. Tests point RALPH_HERDR_BOARD at this file.
#
# Knobs:
#   FAKE_BOARD_FIXTURES  dir of canned responses (unset = built-in defaults)
#   FAKE_BOARD_LOG       invocation log — one line per call, argv joined by
#                        spaces (unset = no logging)
#
# Fixture files (all under $FAKE_BOARD_FIXTURES):
#   frontier --json      frontier.json — ABSENT models a board CLI without
#                        the verb (usage exit 64, like board.ts's UsageError),
#                        which is exactly what the frontier→next fallback
#                        probe needs to see
#   next --json          next.json, else an empty {next, queue} envelope
#   claim show …         claim-show.json, else an In Progress ClaimShow view
#                        (the join-wait poll's happy path; a Backlog fixture
#                        models the timeout path)
#   claim join …         claim-join.json, else a bare success line
#   contract validate …  contract-validate.json, else a ✓ line
#   any of the above     <fixture-name>.rc — forces the exit code (failure
#                        injection; body still printed): frontier.rc, next.rc,
#                        claim-show.rc, claim-join.rc, contract-validate.rc
#
# The real board CLI validates briefs offline; tests that assert VALIDATION
# semantics use the real CLI — this shim only answers the verbs that need a
# live board (claim show/join) or must be canned (frontier/next). bash 3.2
# compatible.
set -u

FIX="${FAKE_BOARD_FIXTURES:-}"
LOG="${FAKE_BOARD_LOG:-}"

if [ -n "$LOG" ]; then
  printf '%s\n' "$*" >>"$LOG"
fi

emit_fixture() {
  local key
  for key in "$@"; do
    if [ -n "$FIX" ] && [ -f "$FIX/$key.json" ]; then
      cat "$FIX/$key.json"
      return 0
    fi
  done
  return 1
}

rc_for() {
  local key="$1"
  if [ -n "$FIX" ] && [ -f "$FIX/$key.rc" ]; then
    cat "$FIX/$key.rc"
  else
    echo 0
  fi
}

case "${1-} ${2-}" in
  "frontier --json")
    # No fixture = the verb does not exist on this board CLI (usage, 64).
    emit_fixture frontier || {
      echo "usage: unknown command \"frontier\" — run \`board help\`" >&2
      exit 64
    }
    key="frontier"
    ;;
  "next --json")
    emit_fixture next || echo '{"next":null,"queue":[]}'
    key="next"
    ;;
  "claim show")
    emit_fixture claim-show ||
      printf '{"number":%s,"state":"In Progress","claim":null,"claimRaw":null,"ageMin":null,"ttlMin":120,"stale":null}\n' "${3-0}"
    key="claim-show"
    ;;
  "claim join")
    emit_fixture claim-join || echo "joined"
    key="claim-join"
    ;;
  "contract validate")
    emit_fixture contract-validate || echo "OK ${3-}: valid (fake)"
    key="contract-validate"
    ;;
  *)
    printf '{"error":{"code":"fake_board_unhandled","command":"%s %s"}}\n' "${1-}" "${2-}" >&2
    exit 64
    ;;
esac
exit "$(rc_for "$key")"
