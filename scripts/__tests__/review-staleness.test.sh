#!/usr/bin/env bash
# Tests for scripts/review-staleness.sh (GH-1816).
#
# Plain bash + a PATH-injected `gh` stub, matching review-convergence.test.sh.
# No network.
#
# The cases that justify the script, and the ones that would sink it:
#   - The founding incident (GH-1774): CHANGES_REQUESTED at the PREVIOUS head,
#     fixes already pushed. `stale` — hold, do not demote.
#   - The same shape bound to the CURRENT head is `live` and must still demote,
#     or the fix trades over-demotion for under-demotion.
#   - A reviewer's CHANGES_REQUESTED SUPERSEDED by their own later review is
#     not a block. Scoring the older one reports a head-bound block GitHub does
#     not hold — and would demote on the strength of it.
#   - Every failed read is `not-evaluated`, never `stale`. An unreadable answer
#     does not prove the verdict predates the head, and `stale` is the verdict
#     that suppresses action.
#   - reviewDecision disagreeing with the review list is not-evaluated too:
#     letting the disagreement itself clear a demotion is the same defect.

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/review-staleness.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

PR=1797
HEAD="653f9edd0000000000000000000000000000cafe"
OLD="94055ad30000000000000000000000000000beef"
BOT="coderabbitai[bot]"

STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"
cat >"$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-} ${2:-}" in
  "pr view")
    [[ -f "$GH_STUB_DIR/fail_prview" ]] && exit 1
    cat "$GH_STUB_DIR/pr.json"
    ;;
  "api repos/{owner}/{repo}/pulls/1797/reviews")
    [[ -f "$GH_STUB_DIR/fail_reviews" ]] && exit 1
    cat "$GH_STUB_DIR/reviews.json"
    ;;
  *) echo "stub: unhandled gh $*" >&2; exit 64 ;;
esac
STUB
chmod +x "$STUB_BIN/gh"

D="$TMP_ROOT/stub"
mkdir -p "$D"
ERR="$TMP_ROOT/err"

# --- builders ---------------------------------------------------------------

# pr <reviewDecision> [head] -> the `gh pr view --json headRefOid,reviewDecision` payload
pr_view() {
  # ${2-…}, not ${2:-…}: an explicitly EMPTY head is a case under test (a PR
  # GitHub reports no head commit for), and the colon form would silently
  # substitute the default and score that case against the wrong payload.
  jq -nc --arg d "$1" --arg h "${2-$HEAD}" '{headRefOid: $h, reviewDecision: $d}'
}
# review <state> <commit> <iso> [author] -> one REST review object
review() {
  jq -nc --arg s "$1" --arg c "$2" --arg t "$3" --arg u "${4:-$BOT}" \
    '{user: {login: $u}, state: $s, commit_id: $c, submitted_at: $t}'
}

write_stub() { # write_stub <pr-json> <reviews-json>
  printf '%s' "$1" >"$D/pr.json"
  printf '%s' "$2" >"$D/reviews.json"
}

expect_json() { # expect_json <name> <jq-filter>
  local out
  out=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$D" "$SCRIPT" "$PR" 2>"$ERR") \
    || out="exit $? / $(tr '\n' ' ' <"$ERR")"
  if jq -e "$2" >/dev/null 2>&1 <<<"$out"; then pass "$1"
  else fail "$1 — got: $out"; fi
}

# --- the founding incident (GH-1774 / PR #1797) -----------------------------
# CHANGES_REQUESTED filed against 94055ad3; every finding fixed and pushed as
# 653f9edd; the reviewer was rate-limited and never came back. A deliver pass
# read this as semantic rework and demoted In Review -> Backlog.
write_stub "$(pr_view CHANGES_REQUESTED)" \
  "$(jq -nc --argjson r "$(review CHANGES_REQUESTED "$OLD" 2026-08-12T02:41:22Z)" '[$r]')"
expect_json "CHANGES_REQUESTED on an older commit -> stale (do not demote)" \
  '.ok == true and .verdict == "stale" and .head == "'"$HEAD"'"
   and (.blocking | length) == 1 and .blocking[0].commit == "'"$OLD"'"'

# --- the case that must still demote ----------------------------------------
write_stub "$(pr_view CHANGES_REQUESTED)" \
  "$(jq -nc --argjson r "$(review CHANGES_REQUESTED "$HEAD" 2026-08-12T02:41:22Z)" '[$r]')"
expect_json "CHANGES_REQUESTED bound to the current head -> live (demote)" \
  '.ok == true and .verdict == "live" and .blocking[0].at_head == true'

# Mixed: one reviewer stale, another at the head. Any head-bound block is live
# — the author has work to do regardless of who else is behind.
write_stub "$(pr_view CHANGES_REQUESTED)" \
  "$(jq -nc --argjson a "$(review CHANGES_REQUESTED "$OLD" 2026-08-12T02:41:22Z)" \
      --argjson b "$(review CHANGES_REQUESTED "$HEAD" 2026-08-12T03:00:00Z greptile-apps)" '[$a,$b]')"
expect_json "one stale + one head-bound blocking review -> live" \
  '.verdict == "live" and (.blocking | length) == 2'

# --- no block at all --------------------------------------------------------
write_stub "$(pr_view REVIEW_REQUIRED)" '[]'
expect_json "no review at all -> no-block" \
  '.ok == true and .verdict == "no-block" and (.blocking | length) == 0'

write_stub "$(pr_view APPROVED)" \
  "$(jq -nc --argjson r "$(review APPROVED "$HEAD" 2026-08-12T03:00:00Z)" '[$r]')"
expect_json "APPROVED -> no-block" '.ok == true and .verdict == "no-block"'

# --- supersession and dismissal --------------------------------------------
# The reviewer filed CHANGES_REQUESTED at the old head, then COMMENTED at the
# new one. Their newest review is not a block; scoring the older one would
# report a head-bound block GitHub does not hold.
write_stub "$(pr_view CHANGES_REQUESTED)" \
  "$(jq -nc --argjson a "$(review CHANGES_REQUESTED "$OLD" 2026-08-12T02:41:22Z)" \
      --argjson b "$(review COMMENTED "$HEAD" 2026-08-12T03:10:00Z)" '[$a,$b]')"
expect_json "a reviewer's own later review supersedes their CHANGES_REQUESTED" \
  '.ok == false and .verdict == "not-evaluated" and (.detail | test("no blocking review is visible"))'

# A DISMISSED CHANGES_REQUESTED is not a block either.
write_stub "$(pr_view CHANGES_REQUESTED)" \
  "$(jq -nc --argjson r "$(review DISMISSED "$OLD" 2026-08-12T02:41:22Z)" '[$r]')"
expect_json "dismissed reviews are not blocking -> not-evaluated, never stale" \
  '.ok == false and .verdict == "not-evaluated"'

# A PENDING review is an unsubmitted draft, not a filed verdict.
write_stub "$(pr_view CHANGES_REQUESTED)" \
  "$(jq -nc --argjson a "$(review CHANGES_REQUESTED "$OLD" 2026-08-12T02:41:22Z)" \
      --argjson b "$(review PENDING "$HEAD" 2026-08-12T03:10:00Z greptile-apps)" '[$a,$b]')"
expect_json "an unsubmitted PENDING draft is not a head-bound block -> stale" \
  '.verdict == "stale"'

# --- not-evaluated is never stale -------------------------------------------
write_stub "$(pr_view CHANGES_REQUESTED)" '[]'
touch "$D/fail_prview"
expect_json "gh pr view fails -> ok false, not-evaluated" \
  '.ok == false and .verdict == "not-evaluated"'
rm -f "$D/fail_prview"

write_stub "$(pr_view CHANGES_REQUESTED)" '[]'
touch "$D/fail_reviews"
expect_json "reviews unreadable -> ok false, not-evaluated (never stale)" \
  '.ok == false and .verdict == "not-evaluated" and .head == "'"$HEAD"'"'
rm -f "$D/fail_reviews"

# reviewDecision says a block is live, the review list shows none. The two
# disagree; guessing `stale` would let the disagreement clear a demotion.
write_stub "$(pr_view CHANGES_REQUESTED)" '[]'
expect_json "reviewDecision blocks but no review is visible -> not-evaluated" \
  '.ok == false and .verdict == "not-evaluated"'

# A blocking review with no commit_id cannot be PROVED to predate the head.
write_stub "$(pr_view CHANGES_REQUESTED)" \
  "$(jq -nc --argjson r "$(review CHANGES_REQUESTED "" 2026-08-12T02:41:22Z)" '[$r]')"
expect_json "blocking review with no commit_id -> not-evaluated, never stale" \
  '.ok == false and .verdict == "not-evaluated" and (.detail | test("no commit_id"))'

# A PR that reports no head is not computable — and must not read as no-block.
write_stub "$(pr_view CHANGES_REQUESTED "")" '[]'
expect_json "no head commit -> not-evaluated" \
  '.ok == false and .verdict == "not-evaluated" and (.detail | test("no head commit"))'

# --- usage ------------------------------------------------------------------
if PATH="$STUB_BIN:$PATH" "$SCRIPT" >/dev/null 2>&1; then fail "no args should exit 2"
else [[ $? -eq 2 ]] && pass "no args -> exit 2" || fail "no args -> wrong exit"; fi
if PATH="$STUB_BIN:$PATH" "$SCRIPT" not-a-number >/dev/null 2>&1; then fail "non-numeric PR should exit 2"
else [[ $? -eq 2 ]] && pass "non-numeric PR -> exit 2" || fail "non-numeric PR -> wrong exit"; fi

echo "review-staleness: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
