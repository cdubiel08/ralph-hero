#!/usr/bin/env bash
# resume-teams.test.sh — executable tests for the evidence-backed team resume
# adapter. Candidates come only from this session's durable orchestrator
# records; the board is never an enumeration or selection surface.
#
#   bash plugin/ralph-herdr/tests/resume-teams.test.sh
#
# The repository, scope config, and ledger are real. Herdr and work-team are
# the external boundaries, so protocol-valid fixtures and an argv logger stand
# in for them. Bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../scripts"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-resume-teams-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

BIN="$TMP/bin"
mkdir -p "$BIN"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-herdr.sh" >"$BIN/herdr"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-board.sh" >"$BIN/board"
chmod +x "$BIN/herdr" "$BIN/board"
export PATH="$BIN:$PATH"
export HERDR_BIN_PATH="$BIN/herdr"
export FAKE_HERDR_FIXTURES="$TMP/herdr-fixtures"
export FAKE_HERDR_LOG="$TMP/herdr.log"
export FAKE_BOARD_FIXTURES="$TMP/board-fixtures"
export FAKE_BOARD_LOG="$TMP/board.log"
export RALPH_HERDR_LEDGER_ROOT="$TMP/ledger-root"
export RALPH_HERDR_SESSION="resume-test"
mkdir -p "$FAKE_HERDR_FIXTURES" "$FAKE_BOARD_FIXTURES"
: >"$FAKE_HERDR_LOG"
: >"$FAKE_BOARD_LOG"

REPO_DIR="$TMP/repo"
OTHER_REPO="$TMP/other-repo"
git init -q -b main "$REPO_DIR" 2>/dev/null || {
  git init -q "$REPO_DIR" && git -C "$REPO_DIR" checkout -q -b main
}
git init -q -b main "$OTHER_REPO" 2>/dev/null || {
  git init -q "$OTHER_REPO" && git -C "$OTHER_REPO" checkout -q -b main
}
printf '{"owner":"test","repo":"resume-fixture","projectNumber":1}\n' >"$REPO_DIR/.ralph.json"
git -C "$REPO_DIR" add .ralph.json
git -C "$REPO_DIR" -c user.email=t@t -c user.name=t commit -q -m init
git -C "$OTHER_REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

LEDGER="$RALPH_HERDR_LEDGER_ROOT/test/resume-fixture/ledger.jsonl"
mkdir -p "$(dirname "$LEDGER")"
: >"$LEDGER"

TEAM_LOG="$TMP/team.log"
export TEAM_LOG
: >"$TEAM_LOG"
TEAM_SH="$TMP/fake-work-team.sh"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf '\''%s\n'\'' "$*" >>"$TEAM_LOG"' \
  'case "${1-}" in' \
  '  904) exit "${TEAM_RC_904:-0}" ;;' \
  '  905) exit "${TEAM_RC_905:-0}" ;;' \
  'esac' \
  'exit 0' >"$TEAM_SH"
chmod +x "$TEAM_SH"
export RALPH_HERDR_WORK_TEAM="$TEAM_SH"
export RALPH_HERDR_BOARD="$BIN/board"

# shellcheck source=herd-fixture.sh
. "$SCRIPT_DIR/herd-fixture.sh"
herd_fixture '[]' "$REPO_DIR"

SESSION=$(RALPH_HERDR_SESSION="$RALPH_HERDR_SESSION" bash -c \
  '. "$1"; ralph_session_key' _ "$SCRIPTS/ledger.sh")

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1 — expected '$2', got '$3'"; fi
}
line_has() {
  case "$2" in *"$3"*) ok "$1" ;; *) not_ok "$1 — no '$3' in '$2'" ;; esac
}

reset_case() {
  : >"$LEDGER"
  : >"$TEAM_LOG"
  : >"$FAKE_HERDR_LOG"
  unset TEAM_RC_904 TEAM_RC_905
  herd_fixture '[]' "$REPO_DIR"
}

# A positive fixture mirrors a real lead spawn/discover record: current
# session, grammar-B o-lane durable ref, orchestrator role, and checkout.
seed_lead() {
  ref="$1" checkout="$2" ev="${3:-spawn}"
  jq -nc --arg session "$SESSION" --arg ev "$ev" --arg ref "$ref" \
    --arg checkout "$checkout" \
    '{ts:"2026-08-29T12:00:00Z", ev:$ev, session:$session,
      agent_ref:$ref, checkout:$checkout,
      lineage:{role:"orchestrator"}, tokens:{role:"orchestrator"}}' >>"$LEDGER"
}

run_resume() {
  RC=0
  OUT=$(RALPH_HERDR_REPO="$REPO_DIR" bash "$SCRIPTS/resume-teams.sh" </dev/null 2>&1) || RC=$?
}

# No durable lead record means no candidate, no herd dependency, and no call.
reset_case
run_resume
is "empty ledger exits 0" "0" "$RC"
line_has "empty ledger is explicit" "$OUT" "resume teams: none recorded"
is "empty ledger launches nothing" "0" "$(wc -l <"$TEAM_LOG" | tr -d ' ')"
is "empty ledger does not read herd" "0" "$(wc -l <"$FAKE_HERDR_LOG" | tr -d ' ')"

# Records outside the closed evidence grammar never become candidates.
reset_case
jq -nc --arg session "$SESSION" --arg checkout "$REPO_DIR" \
  '{ev:"spawn",session:$session,agent_ref:"w910-worker#aaaa1111",checkout:$checkout,
    lineage:{role:"driver"},tokens:{role:"driver"}}' >>"$LEDGER"
jq -nc --arg checkout "$REPO_DIR" \
  '{ev:"spawn",session:"another-session",agent_ref:"o911-team#bbbb2222",checkout:$checkout,
    lineage:{role:"orchestrator"},tokens:{role:"orchestrator"}}' >>"$LEDGER"
jq -nc --arg session "$SESSION" --arg checkout "$REPO_DIR" \
  '{ev:"state",session:$session,agent_ref:"o912-team#cccc3333",checkout:$checkout,
    lineage:{role:"orchestrator"},tokens:{role:"orchestrator"}}' >>"$LEDGER"
run_resume
is "non-candidate durable records exit 0" "0" "$RC"
is "non-candidate durable records launch nothing" "0" "$(wc -l <"$TEAM_LOG" | tr -d ' ')"

# A ledger that cannot be reduced to records is unknown, never empty.
reset_case
printf '{not-json}\n' >"$LEDGER"
run_resume
is "malformed ledger exits 1" "1" "$RC"
line_has "malformed ledger is visible" "$OUT" "resume-teams: ledger is unreadable — launching nothing"
is "malformed ledger launches nothing" "0" "$(wc -l <"$TEAM_LOG" | tr -d ' ')"

# Two epochs for one prior team and one checkout become exactly one candidate.
reset_case
seed_lead 'o900-team#aaaa1111' "$REPO_DIR"
seed_lead 'o900-team#bbbb2222' "$REPO_DIR"
run_resume
is "deduplicated team exits 0" "0" "$RC"
is "one epic is deduplicated" "1" "$(grep -c '^900 --lead-only$' "$TEAM_LOG")"
line_has "deduplicated candidate is visible" "$OUT" "resume team GH-900:"

# A live lead in the one fresh snapshot suppresses delegated restart.
reset_case
seed_lead 'o900-team#aaaa1111' "$REPO_DIR"
herd_fixture '[{"name":"o900-team","agent_status":"working","pane_id":"p9"}]' "$REPO_DIR"
run_resume
is "live lead exits 0" "0" "$RC"
is "live lead is not delegated" "0" "$(wc -l <"$TEAM_LOG" | tr -d ' ')"
line_has "live lead skip is visible" "$OUT" "resume team GH-900: already live"

# Contradictory durable checkout evidence is visible and fails closed.
reset_case
seed_lead 'o901-team#cccc3333' "$REPO_DIR"
seed_lead 'o901-team#dddd4444' "$OTHER_REPO"
run_resume
is "ambiguous checkout exits 1" "1" "$RC"
line_has "ambiguity is visible" "$OUT" "resume team GH-901: skipped — contradictory checkout evidence"
is "ambiguous team launches nothing" "0" "$(grep -c '^901 ' "$TEAM_LOG" || true)"

# Missing checkout evidence is ambiguity, not permission to fall back to PWD.
reset_case
seed_lead 'o901-team#cccc3333' "$REPO_DIR"
seed_lead 'o901-team#dddd4444' ""
run_resume
is "missing checkout exits 1" "1" "$RC"
line_has "missing checkout is visible" "$OUT" "resume team GH-901: skipped — contradictory checkout evidence"
is "missing checkout launches nothing" "0" "$(grep -c '^901 ' "$TEAM_LOG" || true)"

# A unique checkout must resolve to this repository's exact git toplevel.
reset_case
seed_lead 'o901-team#cccc3333' "$OTHER_REPO"
run_resume
is "foreign checkout exits 1" "1" "$RC"
line_has "foreign checkout is visible" "$OUT" "resume team GH-901: skipped — checkout does not match this repository"
is "foreign checkout launches nothing" "0" "$(grep -c '^901 ' "$TEAM_LOG" || true)"

# The herd is read once before any candidate is resumed; unknown means none.
reset_case
seed_lead 'o902-team#eeee5555' "$REPO_DIR"
seed_lead 'o903-team#ffff6666' "$REPO_DIR"
HERDR_BIN_PATH=/usr/bin/false run_resume
is "unreadable herd exits 3" "3" "$RC"
line_has "unreadable herd is visible" "$OUT" "resume-teams: herd is unreadable — launching nothing"
is "unreadable herd skips GH-902 exactly once" "1" \
  "$(printf '%s\n' "$OUT" | grep -c '^resume team GH-902: skipped — herd is unreadable$' || true)"
is "unreadable herd skips GH-903 exactly once" "1" \
  "$(printf '%s\n' "$OUT" | grep -c '^resume team GH-903: skipped — herd is unreadable$' || true)"
is "unreadable herd launches nothing" "0" "$(wc -l <"$TEAM_LOG" | tr -d ' ')"

# work-team's clean completion is a successful resume pass.
reset_case
seed_lead 'o904-team#aaaa7777' "$REPO_DIR"
export TEAM_RC_904=4
run_resume
is "clean-complete candidate exits 0" "0" "$RC"
is "clean-complete candidate is called once" "1" "$(grep -c '^904 --lead-only$' "$TEAM_LOG")"
line_has "clean-complete candidate is visible" "$OUT" "resume team GH-904: complete — no restart needed"

# One failed candidate does not stop a later independent candidate.
reset_case
seed_lead 'o904-team#aaaa7777' "$REPO_DIR"
seed_lead 'o905-team#bbbb8888' "$REPO_DIR"
export TEAM_RC_904=9
run_resume
is "delegated failure aggregates to exit 1" "1" "$RC"
is "failed candidate is attempted once" "1" "$(grep -c '^904 --lead-only$' "$TEAM_LOG")"
is "later candidate still runs" "1" "$(grep -c '^905 --lead-only$' "$TEAM_LOG")"
line_has "delegated failure is visible" "$OUT" "resume team GH-904: failed (rc 9)"
line_has "later success is visible" "$OUT" "resume team GH-905: resumed"

# Candidate inference is ledger-only. The board may be resolved as an
# executable by lib.sh, but no ranking/listing verb may be invoked here.
if grep -Eq '(^| )(frontier|next|list)( |$)' "$FAKE_BOARD_LOG"; then
  not_ok "board is never used to enumerate or select candidates — log: $(tr '\n' ';' <"$FAKE_BOARD_LOG")"
else
  ok "board is never used to enumerate or select candidates"
fi

echo
echo "# resume-teams: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
