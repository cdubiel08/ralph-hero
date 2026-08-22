#!/usr/bin/env bash
# fake-gh.sh — a `gh` shim for the fleet tests, sibling of fake-board.sh and
# fake-herdr.sh. Answers only the two calls dep-refs.sh makes (GH-2109), from
# canned fixtures; no network, no GitHub.
#
# It exists so the fleet suite stays hermetic. dep-refs.sh reaches for `gh` on
# PATH, and the tests already prepend their own $BIN — so a stub there
# intercepts every candidate's body read without any production knob, and
# without a test that forgets to opt in silently hitting the live API.
#
# Knobs:
#   FAKE_GH_FIXTURES  dir of canned responses (unset = built-in defaults)
#   FAKE_GH_REPO      "OWNER REPO" answered by `repo view` (default the repo
#                     the real fixtures name)
#   FAKE_GH_LOG       invocation log — one line per call
#
# Fixtures (all under $FAKE_GH_FIXTURES):
#   gh-body.<N>.json  the body query's response for issue N, then gh-body.json,
#                     else an empty body (nothing to scan — a real clean answer)
#   gh-state.json     the batched alias query's response, else `{}` repository
#                     (every candidate resolves to null: a PR or a stranger)
#   gh-body.rc /      force a non-zero exit (failure injection: the guard must
#   gh-state.rc /     fail OPEN and say NOT CHECKED, never invent a clean read)
#   gh-repo.rc
set -u

FIX="${FAKE_GH_FIXTURES:-}"
[ -z "${FAKE_GH_LOG:-}" ] || printf '%s\n' "$*" >>"$FAKE_GH_LOG"

fixture() { # fixture KEY... -> cat the first that exists
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
  if [ -n "$FIX" ] && [ -f "$FIX/$1.rc" ]; then cat "$FIX/$1.rc"; else echo 0; fi
}

case "${1-}" in
  "repo")
    printf '%s\n' "${FAKE_GH_REPO:-cdubiel08 ralph-hero}"
    exit "$(rc_for gh-repo)"
    ;;
  "api")
    payload=$(cat)
    # The body read carries a `n` variable; the batched state read does not.
    n=$(printf '%s' "$payload" | jq -r '.variables.n // empty' 2>/dev/null)
    if [ -n "$n" ]; then
      fixture "gh-body.$n" gh-body || printf '{"data":{"repository":{"issue":{"body":""}}}}\n'
      exit "$(rc_for gh-body)"
    fi
    fixture gh-state || printf '{"data":{"repository":{}}}\n'
    exit "$(rc_for gh-state)"
    ;;
  *)
    echo "fake-gh: unsupported call '$*'" >&2
    exit 1
    ;;
esac
