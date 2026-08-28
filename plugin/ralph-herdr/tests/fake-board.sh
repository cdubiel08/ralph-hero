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
#   get N …              get.<N>.json, then get.json, else a one-line issue
#                        view (the human `board get` text — link-offer and
#                        ralph-answer print it verbatim, so text is honest)
#   list --json          list.json — the WHOLE-BOARD cross-state payload the
#                        cockpit reads once (GH-1786); items carry their own
#                        "state" and the caller partitions. rc via list.rc
#   list --state …       list.<state-slug>.json (the state lowercased,
#                        spaces → dashes: list.in-progress.json), then
#                        list.json, else an empty {items, foreign} envelope
#                        (board.ts's list --json shape); rc via
#                        list.<state-slug>.rc then list.rc
#   answer N …           answer.<N>.json, then answer.json, else board.ts's
#                        "answer commented; stays Human Needed — resume
#                        pending" line (GH-2204)
#   name N [--json]      name.<N>.json, then name.json, else a canned
#                        GH-1807 name envelope (feat/N-fake-issue + its
#                        legacyBranch) — the spawn path's branch source
#   move N STATE         move.json, else a bare success line
#   peer N …             peer.<N>.json, then peer.json, else a canned
#                        resolved envelope (feat-N-fake-issue-01) — the
#                        GH-1918 resolver peer-msg.sh delegates to; the
#                        none/ambiguous shapes are per-issue fixtures with
#                        peer.<N>.rc=1
#   help …               help.txt (RAW text) — ABSENT prints a default that
#                        INCLUDES the `  answer NNN` verb line; a help.txt
#                        without it models a board CLI predating the verb
#                        (ralph-answer.sh's fallback probe)
#   any of the above     <fixture-name>.rc — forces the exit code (failure
#                        injection; body still printed): frontier.rc, next.rc,
#                        claim-show.rc, claim-join.rc, contract-validate.rc,
#                        get.rc, list.rc, answer.rc, move.rc, help.rc
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
  "get "*)
    emit_fixture "get.${2-}" get ||
      printf '#%s [Backlog] Fake issue (canned board get)\n' "${2-}"
    key="get"
    ;;
  "list --json")
    # The WHOLE-BOARD read (GH-1786): one cross-state payload, so the fixture
    # carries each item's own "state" and the caller partitions locally.
    emit_fixture list || echo '{"items":[],"foreign":[]}'
    key="list"
    ;;
  "list --state")
    # Per-state fixture first (list.in-progress.json), so one fixtures dir can
    # model three different columns; the state-agnostic list.json still wins
    # for the older single-column tests.
    state_slug=$(printf '%s' "${3-}" | tr '[:upper:] ' '[:lower:]-')
    emit_fixture "list.$state_slug" list || echo '{"items":[],"foreign":[]}'
    if [ -n "$FIX" ] && [ -f "$FIX/list.$state_slug.rc" ]; then
      key="list.$state_slug"
    else
      key="list"
    fi
    ;;
  "answer "*)
    emit_fixture "answer.${2-}" answer ||
      printf '#%s: answer commented; stays Human Needed — resume pending (the driving session runs `board claim %s`)\n' "${2-}" "${2-}"
    key="answer"
    ;;
  "name "*)
    # The GH-1807 branch/agent grammar the spawn path reads (GH-1858). The
    # default is a CANNED envelope, deliberately not a re-derivation: this
    # shim proves the spawn path READS board.ts's answer, and a second
    # slugify here would be the very thing GH-1807 exists to prevent. Tests
    # that care about the grammar itself use naming-golden.tsv.
    emit_fixture "name.${2-}" name ||
      printf '{"number":%s,"kind":"feat","lane":"w","branch":"feat/%s-fake-issue","worktree":"feat-%s-fake-issue","agent":"w%s-fake-issue","legacyBranch":"feature/GH-%s","team":null,"teamEpic":null,"address":"fake-repo/w%s-fake-issue"}\n' \
        "${2-0}" "${2-0}" "${2-0}" "${2-0}" "${2-0}" "${2-0}"
    if [ -n "$FIX" ] && [ -f "$FIX/name.${2-}.rc" ]; then
      key="name.${2-}"
    else
      key="name"
    fi
    ;;
  "move "*)
    emit_fixture move || printf '#%s moved to %s (fake)\n' "${2-}" "${3-}"
    key="move"
    ;;
  "peer "*)
    # The GH-1918 resolver peer-msg.sh delegates to. Default is a CANNED
    # resolved envelope consistent with the name fixture's grammar — same
    # reasoning as `name`: the subject is that callers READ board.ts's
    # answer, never re-derive the prefix rule. none/ambiguous shapes come
    # from per-issue fixtures (peer.<N>.json + peer.<N>.rc=1, matching
    # board.ts's exit-1-on-unresolved).
    emit_fixture "peer.${2-}" peer ||
      printf '{"number":%s,"peerPrefix":"feat-%s-fake-issue","kind":"resolved","address":"feat-%s-fake-issue-01"}\n' \
        "${2-0}" "${2-0}" "${2-0}"
    if [ -n "$FIX" ] && [ -f "$FIX/peer.${2-}.rc" ]; then
      key="peer.${2-}"
    else
      key="peer"
    fi
    ;;
  "release "*)
    # Per-issue first, so one fixtures dir can model a release that lands for
    # GH-1 and one board.ts refuses for GH-2 (release.2.rc = 1) — which is how
    # reconcile's claim recovery gets tested against the guardHolder refusal
    # without reimplementing the guard here.
    emit_fixture "release.${2-}" release || printf '#%s [Backlog] released (fake)\n' "${2-}"
    if [ -n "$FIX" ] && [ -f "$FIX/release.${2-}.rc" ]; then
      key="release.${2-}"
    else
      key="release"
    fi
    ;;
  "help "* | "help")
    if [ -n "$FIX" ] && [ -f "$FIX/help.txt" ]; then
      cat "$FIX/help.txt"
    else
      # The one line ralph-answer.sh's capability probe greps for.
      printf 'mutations:\n  answer NNN -m "decision"    answer a Human Needed item, COMMENT-FIRST\n'
    fi
    key="help"
    ;;
  *)
    printf '{"error":{"code":"fake_board_unhandled","command":"%s %s"}}\n' "${1-}" "${2-}" >&2
    exit 64
    ;;
esac
exit "$(rc_for "$key")"
