#!/usr/bin/env bash
# Tests for scripts/review-convergence.sh (GH-1849).
#
# Plain bash + a PATH-injected `gh` stub, matching advisory-findings.test.sh.
# No network.
#
# The cases that justify the script, and the ones that nearly sank it:
#   - "0 then 0" is CONVERGED, not stalled. A strict-decrease test applied at
#     the floor condemns every clean PR; the first draft escalated four merged
#     PRs before this was caught by running it against them.
#   - A clean latest pass outranks the round cap, or a converged PR that was
#     pushed nine times for CI reasons would be escalated for merging.
#   - An unanswered pass contributes NO data point. Scored as zero it
#     fabricates a decrease, certifying convergence exactly when the script
#     knows least.
#   - Severity is anchored on badge MARKUP, in both renderings. A live P1 on
#     #1946 discusses "P0" in its prose; a substring match counts it as
#     blocking.
#   - Only the POLICY bot blocks. Greptile's findings are real and advisory,
#     and counting them here would stop a loop the gate is not running.

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/review-convergence.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

PR=1740
STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"
cat >"$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-} ${2:-}" in
  "api graphql")
    [[ -f "$GH_STUB_DIR/fail_graphql" ]] && exit 1
    cat "$GH_STUB_DIR/threads.json"
    ;;
  "api repos/{owner}/{repo}/pulls/1740/reviews")
    [[ -f "$GH_STUB_DIR/fail_reviews" ]] && exit 1
    cat "$GH_STUB_DIR/reviews.json"
    ;;
  "api repos/{owner}/{repo}/issues/1740/comments")
    [[ -f "$GH_STUB_DIR/fail_comments" ]] && exit 1
    cat "$GH_STUB_DIR/comments.json"
    ;;
  *) echo "stub: unhandled gh $*" >&2; exit 64 ;;
esac
STUB
chmod +x "$STUB_BIN/gh"

BOT="chatgpt-codex-connector[bot]"
TRIGGER="@codex review for P0 issues only"
POLICY="$TMP_ROOT/policy.json"
cat >"$POLICY" <<EOF
{ "version": 1, "external_review": { "required": true, "bot": "$BOT",
  "trigger": "$TRIGGER", "head_marker": "ralph-review-head" } }
EOF

D="$TMP_ROOT/stub"
mkdir -p "$D"

# --- builders ---------------------------------------------------------------

# The two live badge renderings, verbatim in shape from the PRs they were read
# off: Codex shields.io alt text, Greptile <img alt>.
codex_p0='**<sub><sub>![P0 Badge](https://img.shields.io/badge/P0-red)</sub></sub>** boom'
codex_p1='**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange)</sub></sub>** meh'
greptile_p0='<a href="#"><img alt="P0" src="https://greptile/p0.svg" align="top"></a> **boom**'
# A real P1 from #1946 whose PROSE names P0 — the substring trap.
prose_p0='<a href="#"><img alt="P1" src="https://greptile/p1.svg"></a> **Review-mode P0 is hidden** ... P0 ...'

# request <iso> -> a driver review-request comment (a "pass")
request() {
  jq -nc --arg t "$1" --arg trig "$TRIGGER" \
    '{user:{login:"cdubiel08"}, created_at:$t,
      body:($trig + "\n\n<!-- ralph-review-head: deadbeef -->")}'
}
# bot_comment <iso> -> the bot answering with nothing to say
bot_comment() {
  jq -nc --arg t "$1" --arg b "$BOT" '{user:{login:$b}, created_at:$t, body:"looked, nothing at deadbeef01"}'
}
# review <iso> [author] -> a bot review object (also an answer)
review() {
  jq -nc --arg t "$1" --arg b "${2:-$BOT}" '{user:{login:$b}, submitted_at:$t, state:"COMMENTED", commit_id:"deadbeef"}'
}
# finding <iso> <author> <body>
finding() {
  jq -nc --arg t "$1" --arg a "$2" --arg b "$3" \
    '{comments:{nodes:[{author:{login:$a}, createdAt:$t, body:$b}]}}'
}

# write_stub <comments-json-array> <reviews-json-array> <threads-node-array> [hasNext]
write_stub() {
  echo "$1" >"$D/comments.json"
  echo "$2" >"$D/reviews.json"
  jq -nc --argjson n "$3" --argjson hn "${4:-false}" \
    '{data:{repository:{pullRequest:{reviewThreads:{pageInfo:{hasNextPage:$hn}, nodes:$n}}}}}' \
    >"$D/threads.json"
}

run() { # run [extra args...]
  PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$D" RALPH_MERGE_POLICY_FILE="$POLICY" \
    RALPH_REVIEW_ROUND_CAP="" "$SCRIPT" "$PR" "$@" 2>/dev/null
}

expect_json() { # expect_json <name> <jq predicate> [extra script args...]
  local name="$1" pred="$2"; shift 2
  local out
  if ! out=$(run "$@"); then fail "$name (script exited nonzero)"; return; fi
  if jq -e "$pred" >/dev/null 2>&1 <<<"$out"; then pass "$name"
  else fail "$name — got: $out"; fi
}

rm -f "$D"/fail_*

# --- cases ------------------------------------------------------------------

echo "review-convergence:"

# No pass at all. Not "converging" — the loop has not started.
write_stub '[]' '[]' '[]'
expect_json "no request -> no-passes, passes 0" \
  '.ok == true and .verdict == "no-passes" and .passes == 0'

# THE REGRESSION THIS FILE EXISTS FOR. Two answered passes, zero blocking
# findings in each. Strict-decrease says "did not decrease" and escalates; the
# truth is a clean PR.
write_stub \
  "$(jq -nc --argjson a "$(request 2026-08-01T10:00:00Z)" --argjson b "$(bot_comment 2026-08-01T10:05:00Z)" \
      --argjson c "$(request 2026-08-01T11:00:00Z)" --argjson d "$(bot_comment 2026-08-01T11:05:00Z)" '[$a,$b,$c,$d]')" \
  '[]' '[]'
expect_json "0 then 0 -> converged, never stalled" \
  '.verdict == "converged" and .series == [0,0]'

# A clean latest pass beats the cap: nine rounds of CI churn on a converged
# review must not be escalated.
c=$(jq -nc --argjson r1 "$(request 2026-08-01T10:00:00Z)" --argjson a1 "$(bot_comment 2026-08-01T10:05:00Z)" \
     --argjson r2 "$(request 2026-08-01T11:00:00Z)" --argjson a2 "$(bot_comment 2026-08-01T11:05:00Z)" \
     --argjson r3 "$(request 2026-08-01T12:00:00Z)" --argjson a3 "$(bot_comment 2026-08-01T12:05:00Z)" \
     --argjson r4 "$(request 2026-08-01T13:00:00Z)" --argjson a4 "$(bot_comment 2026-08-01T13:05:00Z)" \
     --argjson r5 "$(request 2026-08-01T14:00:00Z)" --argjson a5 "$(bot_comment 2026-08-01T14:05:00Z)" \
     '[$r1,$a1,$r2,$a2,$r3,$a3,$r4,$a4,$r5,$a5]')
write_stub "$c" '[]' '[]'
expect_json "converged outranks the cap" \
  '.verdict == "converged" and .passes == 5' --cap 2

# Findings growing across passes: 1 then 2. The #1764 mode.
write_stub \
  "$(jq -nc --argjson r1 "$(request 2026-08-01T10:00:00Z)" --argjson r2 "$(request 2026-08-01T11:00:00Z)" '[$r1,$r2]')" \
  "$(jq -nc --argjson v1 "$(review 2026-08-01T10:30:00Z)" --argjson v2 "$(review 2026-08-01T11:30:00Z)" '[$v1,$v2]')" \
  "$(jq -nc --argjson f1 "$(finding 2026-08-01T10:20:00Z "$BOT" "$codex_p0")" \
      --argjson f2 "$(finding 2026-08-01T11:20:00Z "$BOT" "$codex_p0")" \
      --argjson f3 "$(finding 2026-08-01T11:25:00Z "$BOT" "$codex_p0")" '[$f1,$f2,$f3]')"
expect_json "1 then 2 -> stalled" \
  '.verdict == "stalled" and .series == [1,2]'

# Equal is also a stall: strictly decreasing is the rule.
write_stub \
  "$(jq -nc --argjson r1 "$(request 2026-08-01T10:00:00Z)" --argjson r2 "$(request 2026-08-01T11:00:00Z)" '[$r1,$r2]')" \
  "$(jq -nc --argjson v1 "$(review 2026-08-01T10:30:00Z)" --argjson v2 "$(review 2026-08-01T11:30:00Z)" '[$v1,$v2]')" \
  "$(jq -nc --argjson f1 "$(finding 2026-08-01T10:20:00Z "$BOT" "$codex_p0")" \
      --argjson f2 "$(finding 2026-08-01T11:20:00Z "$BOT" "$codex_p0")" '[$f1,$f2]')"
expect_json "1 then 1 -> stalled" '.verdict == "stalled" and .series == [1,1]'

# Decreasing but not yet clean -> keep going.
write_stub \
  "$(jq -nc --argjson r1 "$(request 2026-08-01T10:00:00Z)" --argjson r2 "$(request 2026-08-01T11:00:00Z)" '[$r1,$r2]')" \
  "$(jq -nc --argjson v1 "$(review 2026-08-01T10:30:00Z)" --argjson v2 "$(review 2026-08-01T11:30:00Z)" '[$v1,$v2]')" \
  "$(jq -nc --argjson f1 "$(finding 2026-08-01T10:20:00Z "$BOT" "$codex_p0")" \
      --argjson f2 "$(finding 2026-08-01T10:21:00Z "$BOT" "$codex_p0")" \
      --argjson f3 "$(finding 2026-08-01T11:20:00Z "$BOT" "$codex_p0")" '[$f1,$f2,$f3]')"
expect_json "2 then 1 -> converging" '.verdict == "converging" and .series == [2,1]'

# Cap, with blocking findings still open — the real escalation.
write_stub \
  "$(jq -nc --argjson r1 "$(request 2026-08-01T10:00:00Z)" --argjson r2 "$(request 2026-08-01T11:00:00Z)" '[$r1,$r2]')" \
  "$(jq -nc --argjson v1 "$(review 2026-08-01T10:30:00Z)" --argjson v2 "$(review 2026-08-01T11:30:00Z)" '[$v1,$v2]')" \
  "$(jq -nc --argjson f1 "$(finding 2026-08-01T10:20:00Z "$BOT" "$codex_p0")" \
      --argjson f2 "$(finding 2026-08-01T10:21:00Z "$BOT" "$codex_p0")" \
      --argjson f3 "$(finding 2026-08-01T11:20:00Z "$BOT" "$codex_p0")" '[$f1,$f2,$f3]')"
expect_json "cap reached with findings open -> cap-reached" \
  '.verdict == "cap-reached" and .cap == 2 and (.detail | test("still 1 blocking"))' --cap 2

# An UNANSWERED trailing pass is not a data point. Pass 1 had a finding; pass 2
# has no answer yet. Scoring pass 2 as zero would read as a decrease and
# certify convergence at the moment the script knows least.
write_stub \
  "$(jq -nc --argjson r1 "$(request 2026-08-01T10:00:00Z)" --argjson r2 "$(request 2026-08-01T11:00:00Z)" '[$r1,$r2]')" \
  "$(jq -nc --argjson v1 "$(review 2026-08-01T10:30:00Z)" '[$v1]')" \
  "$(jq -nc --argjson f1 "$(finding 2026-08-01T10:20:00Z "$BOT" "$codex_p0")" '[$f1]')"
expect_json "unanswered trailing pass -> pending, not counted" \
  '.verdict == "insufficient-data" and .series == [1] and .pending == true'

# Same rule applied mid-series: an unanswered pass 2 must not inject a zero
# between two real counts.
write_stub \
  "$(jq -nc --argjson r1 "$(request 2026-08-01T10:00:00Z)" --argjson r2 "$(request 2026-08-01T11:00:00Z)" \
      --argjson r3 "$(request 2026-08-01T12:00:00Z)" '[$r1,$r2,$r3]')" \
  "$(jq -nc --argjson v1 "$(review 2026-08-01T10:30:00Z)" --argjson v3 "$(review 2026-08-01T12:30:00Z)" '[$v1,$v3]')" \
  "$(jq -nc --argjson f1 "$(finding 2026-08-01T10:20:00Z "$BOT" "$codex_p0")" \
      --argjson f2 "$(finding 2026-08-01T12:20:00Z "$BOT" "$codex_p0")" '[$f1,$f2]')"
expect_json "unanswered middle pass injects no zero" \
  '.series == [1,1] and .verdict == "stalled" and .pending == false'

# Greptile's rendering counts when Greptile IS the policy bot — the swap the
# GH-1848 spike costed. Same data, bot swapped in the policy file.
GPOLICY="$TMP_ROOT/policy-greptile.json"
jq '.external_review.bot = "greptile-apps"' "$POLICY" >"$GPOLICY"
write_stub \
  "$(jq -nc --argjson r1 "$(request 2026-08-01T10:00:00Z)" --argjson r2 "$(request 2026-08-01T11:00:00Z)" '[$r1,$r2]')" \
  "$(jq -nc --argjson v1 "$(review 2026-08-01T10:30:00Z)" --argjson v2 "$(review 2026-08-01T11:30:00Z)" \
      --argjson g1 "$(review 2026-08-01T10:31:00Z greptile-apps)" --argjson g2 "$(review 2026-08-01T11:31:00Z greptile-apps)" \
      '[$v1,$v2,$g1,$g2]')" \
  "$(jq -nc --argjson f1 "$(finding 2026-08-01T10:20:00Z greptile-apps "$greptile_p0")" \
      --argjson f2 "$(finding 2026-08-01T11:20:00Z greptile-apps "$greptile_p0")" '[$f1,$f2]')"
out=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$D" RALPH_MERGE_POLICY_FILE="$GPOLICY" "$SCRIPT" "$PR" 2>/dev/null)
if jq -e '.series == [1,1]' >/dev/null 2>&1 <<<"$out"; then
  pass "greptile alt= badge counts when greptile is the policy bot"
else fail "greptile badge — got: $out"; fi
# ...and the SAME reviews are invisible when it is not the policy bot: those
# findings are advisory, and stopping a loop on them stops the wrong loop.
out=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$D" RALPH_MERGE_POLICY_FILE="$POLICY" "$SCRIPT" "$PR" 2>/dev/null)
if jq -e '.series == [0,0] and .verdict == "converged"' >/dev/null 2>&1 <<<"$out"; then
  pass "non-policy-bot findings are not blocking"
else fail "non-policy bot — got: $out"; fi

# A P1 whose prose mentions P0 is not a P0. Live shape, from #1946.
write_stub \
  "$(jq -nc --argjson r1 "$(request 2026-08-01T10:00:00Z)" --argjson r2 "$(request 2026-08-01T11:00:00Z)" '[$r1,$r2]')" \
  "$(jq -nc --argjson v1 "$(review 2026-08-01T10:30:00Z)" --argjson v2 "$(review 2026-08-01T11:30:00Z)" '[$v1,$v2]')" \
  "$(jq -nc --argjson f1 "$(finding 2026-08-01T10:20:00Z "$BOT" "$prose_p0")" \
      --argjson f2 "$(finding 2026-08-01T10:21:00Z "$BOT" "$codex_p1")" '[$f1,$f2]')"
expect_json "prose mentioning P0, and P1 badges, are not blocking" \
  '.series == [0,0] and .verdict == "converged"'

# Not-evaluated, never converging: an unreadable history must not read as a
# healthy loop.
write_stub '[]' '[]' '[]'
touch "$D/fail_comments"
expect_json "comments unreadable -> ok false, not-evaluated" \
  '.ok == false and .verdict == "not-evaluated"'
rm -f "$D/fail_comments"

write_stub "$(jq -nc --argjson r1 "$(request 2026-08-01T10:00:00Z)" '[$r1]')" '[]' '[]'
touch "$D/fail_graphql"
expect_json "graphql failure -> ok false, not-evaluated" \
  '.ok == false and .verdict == "not-evaluated" and .passes == 1'
rm -f "$D/fail_graphql"

# >100 threads: a partial series is a WRONG series, not a small one.
write_stub "$(jq -nc --argjson r1 "$(request 2026-08-01T10:00:00Z)" '[$r1]')" '[]' '[]' true
expect_json "thread page bound -> not-evaluated" \
  '.ok == false and .verdict == "not-evaluated" and (.detail | test("more than 100"))'

# Usage
if PATH="$STUB_BIN:$PATH" "$SCRIPT" >/dev/null 2>&1; then fail "no args should exit 2"
else [[ $? -eq 2 ]] && pass "no args -> exit 2" || fail "no args -> wrong exit"; fi
if PATH="$STUB_BIN:$PATH" "$SCRIPT" "$PR" --cap 0 >/dev/null 2>&1; then fail "--cap 0 should exit 2"
else [[ $? -eq 2 ]] && pass "--cap 0 -> exit 2" || fail "--cap 0 -> wrong exit"; fi

echo "review-convergence: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
