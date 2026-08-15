#!/usr/bin/env bash
# scripts/__tests__/merge-evidence.test.sh
# Tests for scripts/lib/merge-evidence.sh — the one reader of the merge policy
# and of the attestation payload (GH-1843).
#
# Two jobs here. The first is the ordinary one: the rules behave. The second is
# the reason the file exists — every consumer must resolve the SAME policy file
# and get the SAME answer, so the last section asserts agreement across readers
# rather than testing each in isolation. A rule that is correct in one script
# and correct in another is not what this file buys; identity is.

set -uo pipefail

LIB="$(cd "$(dirname "$0")/.." && pwd)/lib/merge-evidence.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; echo "        $2"; FAIL=$((FAIL + 1)); }
eq() { # eq <label> <expected> <actual>
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected [$2] got [$3]"; fi
}

# shellcheck source=../lib/merge-evidence.sh
. "$LIB"

# --- fixtures --------------------------------------------------------------
FULL="$TMP/full.json"
cat >"$FULL" <<'JSON'
{
  "attestation": { "required": true },
  "external_review": {
    "required": true,
    "bot": "chatgpt-codex-connector[bot]",
    "trigger": "@codex review for P0 issues only",
    "head_marker": "ralph-review-head"
  },
  "exempt_authors": ["dependabot[bot]", "app/github-actions"]
}
JSON

V1="$TMP/v1.json"
cat >"$FULL.tmp" <<'JSON'
{ "attestation": { "required": true },
  "external_review": { "required": true, "bot": "coderabbitai[bot]" } }
JSON
mv "$FULL.tmp" "$V1"

EMPTY="$TMP/empty.json"
echo '{}' >"$EMPTY"

BAD="$TMP/bad.json"
printf '{ "attestation": ' >"$BAD"

# --- policy loading --------------------------------------------------------
echo "=== policy loading and defaults ==="

P=$(me_policy_load "$FULL")
eq "full policy: attestation required"   "true"      "$(me_policy_get "$P" attestationRequired)"
eq "full policy: external required"      "true"      "$(me_policy_get "$P" externalRequired)"
eq "full policy: bot"  "chatgpt-codex-connector[bot]" "$(me_policy_get "$P" bot)"
eq "full policy: trigger" "@codex review for P0 issues only" "$(me_policy_get "$P" trigger)"

# Mode is DERIVED from head_marker, never configured. This is the rule that had
# four copies and two different defaults before GH-1843.
eq "head_marker present → findings mode" "findings" "$(me_policy_get "$P" mode)"

P1=$(me_policy_load "$V1")
eq "no head_marker → review mode (v1 reviewers keep merging)" "review" "$(me_policy_get "$P1" mode)"
eq "no head_marker → headMarker is empty, not a default key" "" "$(me_policy_get "$P1" headMarker)"

PE=$(me_policy_load "$EMPTY")
eq "empty policy: attestation defaults off" "false" "$(me_policy_get "$PE" attestationRequired)"
eq "empty policy: external defaults off"    "false" "$(me_policy_get "$PE" externalRequired)"
eq "empty policy: mode defaults to review"  "review" "$(me_policy_get "$PE" mode)"

PN=$(me_policy_load "$TMP/does-not-exist.json")
eq "absent policy: gates off"        "false"  "$(me_policy_get "$PN" attestationRequired)"
eq "absent policy: same object shape" "review" "$(me_policy_get "$PN" mode)"
eq "absent policy: no exempt authors" "[]"     "$(me_policy_get "$PN" exemptAuthors)"

# A corrupt policy must NOT read as "nothing required" — that would green-light
# exactly the merges the policy exists to gate (CodeRabbit, PR #1602). The
# loader signals it with a DISTINCT exit code so callers can fail closed.
me_policy_load "$BAD" >/dev/null 2>&1
eq "malformed policy → exit 2 (fail closed, not silently permissive)" "2" "$?"

# --- exempt authors --------------------------------------------------------
echo "=== exempt-author normalization ==="

eq "exact match"                    "true"  "$(me_is_exempt "$P" "dependabot[bot]")"
eq "app/ prefix on the policy side" "true"  "$(me_is_exempt "$P" "github-actions[bot]")"
eq "app/ prefix on the author side" "true"  "$(me_is_exempt "$P" "app/dependabot")"
eq "bare login matches [bot] entry" "true"  "$(me_is_exempt "$P" "dependabot")"
eq "a human is not exempt"          "false" "$(me_is_exempt "$P" "cdubiel08")"
eq "empty author is not exempt"     "false" "$(me_is_exempt "$P" "")"
eq "no exempt list → nobody exempt" "false" "$(me_is_exempt "$PE" "dependabot[bot]")"

# --- attestation payload ---------------------------------------------------
echo "=== attestation payload extraction ==="

mk_att() { # mk_att <sha> <tests-json> <verdict>
  printf '<!-- ralph-attestation:v1 -->\nprose above\n```json\n%s\n```\nprose below\n' \
    "$(jq -nc --arg s "$1" --argjson t "$2" --arg v "$3" \
      '{head_sha:$s, tests:$t, review:{verdict:$v}, generated_by:"test"}')"
}

GOOD=$(mk_att "abc123" '[{"exit_code":0}]' "APPROVED")
eq "valid attestation at head"      "ok"         "$(me_attestation_status "$GOOD" "abc123")"
eq "same payload at another head"   "stale"      "$(me_attestation_status "$GOOD" "def456")"
eq "payload field readable"         "test"       "$(me_attestation_field "$GOOD" .generated_by)"

# All three checks are enforced, because an edit can preserve head_sha while
# breaking either of the others (codex P2, PR #1764).
eq "empty tests[] is not evidence"  "no-tests"   "$(me_attestation_status "$(mk_att abc123 '[]' APPROVED)" abc123)"
eq "a non-zero test exit"           "no-tests"   "$(me_attestation_status "$(mk_att abc123 '[{"exit_code":1}]' APPROVED)" abc123)"
eq "a mixed test set"               "no-tests"   "$(me_attestation_status "$(mk_att abc123 '[{"exit_code":0},{"exit_code":2}]' APPROVED)" abc123)"
eq "missing verdict"                "no-verdict" "$(me_attestation_status "$(mk_att abc123 '[{"exit_code":0}]' '')" abc123)"
# Presence is not approval: an honest REJECTED is evidence AGAINST merging.
eq "REJECTED is rejected, not ok"   "rejected"   "$(me_attestation_status "$(mk_att abc123 '[{"exit_code":0}]' REJECTED)" abc123)"

eq "no comment body at all"         "missing"    "$(me_attestation_status "" abc123)"
eq "a body with no fence"           "missing"    "$(me_attestation_status "just some prose" abc123)"
eq "a fence containing non-JSON"    "missing"    "$(me_attestation_status "$(printf '```json\nnot json\n```\n')" abc123)"

# Both fences must be anchored to their own lines. An INLINE fence used to read
# as valid in the watcher while gate 4 called it unparseable — GATE-READY into a
# merge that immediately rejects (codex P2, PR #1764).
INLINE='prose ```json {"head_sha":"abc123","tests":[{"exit_code":0}],"review":{"verdict":"APPROVED"}} ``` more'
eq "an inline fence is not a payload" "missing" "$(me_attestation_status "$INLINE" abc123)"

# No closing fence means "to the end of the body".
UNCLOSED=$(printf '```json\n{"head_sha":"abc123","tests":[{"exit_code":0}],"review":{"verdict":"APPROVED"}}\n')
eq "an unclosed fence reads to the end" "ok" "$(me_attestation_status "$UNCLOSED" abc123)"

# The LAST fence wins nothing special — extraction takes the FIRST fenced block,
# which is what the awk it replaced did. Pinned so a future rewrite cannot
# quietly change which payload a two-fence comment resolves to.
TWO=$(printf '```json\n{"head_sha":"first"}\n```\n```json\n{"head_sha":"second"}\n```\n')
eq "the first fence is the payload" "first" "$(me_attestation_field "$TWO" .head_sha)"

# --- jq-side parity --------------------------------------------------------
# pr-gate-watch.sh calls these defs from inside its own jq program rather than
# through the bash wrappers. Same rules, so same answers — asserted, because a
# divergence between the two surfaces would recreate the exact bug class this
# library was extracted to end.
echo "=== the jq surface answers identically to the bash surface ==="

jq_status() { jq -r "$ME_JQ_LIB"' me_fenced_json | (try fromjson catch null) | me_attestation_status($h)' \
  -R -s --arg h "$2" <<<"$1"; }

for case_name in GOOD INLINE UNCLOSED; do
  body="${!case_name}"
  eq "jq and bash agree on $case_name" \
    "$(me_attestation_status "$body" abc123)" "$(jq_status "$body" abc123)"
done

eq "jq exempt matches bash exempt" \
  "$(me_is_exempt "$P" "app/dependabot")" \
  "$(jq -r "$ME_JQ_LIB"' me_exempt($a) | tostring' --arg a "app/dependabot" <<<"$P")"

# --- review-mode approval predicate ----------------------------------------
echo "=== review-mode approval selection ==="

REVIEWS='[
  {"user":{"login":"chatgpt-codex-connector[bot]"},"state":"APPROVED","commit_id":"abc123"},
  {"user":{"login":"app/chatgpt-codex-connector"},"state":"APPROVED","commit_id":"old999"},
  {"user":{"login":"chatgpt-codex-connector[bot]"},"state":"DISMISSED","commit_id":"abc123"},
  {"user":{"login":"someone-else"},"state":"APPROVED","commit_id":"abc123"}
]'
approved_at() { jq -r "$ME_JQ_LIB"' me_approved_reviews($b; $h) | length' \
  --arg b "chatgpt-codex-connector[bot]" --arg h "$1" <<<"$REVIEWS"; }

eq "an APPROVED review at the head counts"        "1" "$(approved_at abc123)"
eq "an approval at an OLD head does not carry"    "1" "$(approved_at old999)"
eq "no approval at an unrelated head"             "0" "$(approved_at zzz)"
# A DISMISSED review at the head and a third party's approval are both present
# in the fixture above; neither may satisfy the gate.
eq "app/ and [bot] spellings are one identity" \
  "1" "$(jq -r "$ME_JQ_LIB"' me_approved_reviews($b; $h) | length' \
        --arg b "app/chatgpt-codex-connector" --arg h "old999" <<<"$REVIEWS")"

# --- the paginated attestation reader --------------------------------------
echo "=== attestation comment lookup is paginated (GH-1842) ==="

# The defect: all three readers located the attestation via `gh pr view --json
# comments`, a BOUNDED window. On a long PR (#1764: 40+ comments over seven
# review rounds) a valid attestation falls outside it and reads as absent. The
# stub below therefore serves it on the LAST page only — a fixture the old
# unpaginated read could not have passed.
export GH_STUB_DIR="$TMP/ghstub"; mkdir -p "$GH_STUB_DIR"
STUB_BIN="$TMP/bin"; mkdir -p "$STUB_BIN"
cat >"$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
if [ -f "$GH_STUB_DIR/fail" ]; then exit 1; fi
cat "$GH_STUB_DIR/pages.json"
STUB
chmod +x "$STUB_BIN/gh"

att_body() { printf '<!-- ralph-attestation:v1 -->\n```json\n{"head_sha":"%s"}\n```\n' "$1"; }

# --paginate emits ONE ARRAY PER PAGE, concatenated. The attestation is on the
# second page; a reader that took only the first sees nothing.
jq -n --arg a "$(att_body abc123)" \
  '[{body:"chatter"},{body:"more chatter"}], [{body:$a}]' >"$GH_STUB_DIR/pages.json"
out=$(PATH="$STUB_BIN:$PATH" me_attestation_comment 1764); rc=$?
eq "an attestation on a later page is found"   "0" "$rc"
eq "  and its body is returned"                "abc123" \
  "$(jq -r '.head_sha' <<<"$(me_attestation_payload "$out")")"

# Newest wins, across pages: attest-pr.sh updates in place, but a PR that has
# carried more than one attestation comment must be judged by the last.
jq -n --arg a "$(att_body old111)" --arg b "$(att_body new222)" \
  '[{body:$a}], [{body:"chatter"},{body:$b}]' >"$GH_STUB_DIR/pages.json"
eq "the LAST attestation wins across pages" "new222" \
  "$(jq -r '.head_sha' <<<"$(me_attestation_payload "$(PATH="$STUB_BIN:$PATH" me_attestation_comment 1764)")")"

# A PR with no attestation is exit 0 + empty, not an error: "not yet attested"
# is an answer.
jq -n '[{body:"chatter"}]' >"$GH_STUB_DIR/pages.json"
out=$(PATH="$STUB_BIN:$PATH" me_attestation_comment 1764); rc=$?
eq "no attestation comment is exit 0"          "0" "$rc"
eq "  with empty output"                       ""  "$out"

# An unreadable API is exit 3, NEVER an empty read: "could not read" and "not
# attested yet" have opposite correct responses (retry vs. run attest-pr.sh),
# and collapsing them is what makes a gate demand work already done.
touch "$GH_STUB_DIR/fail"
PATH="$STUB_BIN:$PATH" me_attestation_comment 1764 >/dev/null 2>&1; rc=$?
eq "an unreadable comments API is exit 3"      "3" "$rc"
rm -f "$GH_STUB_DIR/fail"

# --- evidence-script runner ------------------------------------------------
echo "=== evidence-script runner fails loud, never silently ok ==="

CRASH="$TMP/crash.sh"; printf '#!/usr/bin/env bash\nexit 7\n' >"$CRASH"; chmod +x "$CRASH"
GARBAGE="$TMP/garbage.sh"; printf '#!/usr/bin/env bash\necho "not json"\n' >"$GARBAGE"; chmod +x "$GARBAGE"
OKSH="$TMP/ok.sh"; printf '#!/usr/bin/env bash\necho %s\n' "'{\"ok\":true,\"detail\":\"clean\"}'" >"$OKSH"; chmod +x "$OKSH"
NOOK="$TMP/nook.sh"; printf '#!/usr/bin/env bash\necho %s\n' "'{\"verdict\":\"clean\"}'" >"$NOOK"; chmod +x "$NOOK"

me_run_evidence_script "$TMP/absent.sh" 1 abc >/dev/null 2>&1
eq "a missing evidence script → exit 3" "3" "$?"
me_run_evidence_script "$CRASH" 1 abc >/dev/null 2>&1
eq "a crashing evidence script → exit 3" "3" "$?"
me_run_evidence_script "$GARBAGE" 1 abc >/dev/null 2>&1
eq "non-JSON output → exit 3" "3" "$?"
# An object WITHOUT an `ok` field is unusable in the same way: a caller reading
# `.ok` off it would get null and treat it as not-ok, which is a verdict the
# script never gave.
me_run_evidence_script "$NOOK" 1 abc >/dev/null 2>&1
eq "a JSON object with no ok field → exit 3" "3" "$?"
OUT=$(me_run_evidence_script "$OKSH" 1 abc); RC=$?
eq "a well-formed verdict → exit 0" "0" "$RC"
eq "…and the verdict is passed through" "true" "$(jq -r .ok <<<"$OUT")"

# --- one file, every reader ------------------------------------------------
# The RALPH_MERGE_POLICY_FILE override must be honoured identically everywhere:
# a test that pointed one reader at a fixture and another at the real policy
# would be testing two different policies and reporting agreement.
echo "=== every reader resolves the same policy file ==="

unset RALPH_MERGE_POLICY_FILE
eq "default path is .github/ralph-merge-policy.json under the given root" \
  "/some/root/.github/ralph-merge-policy.json" "$(me_policy_file /some/root)"
RALPH_MERGE_POLICY_FILE="$FULL"
eq "the override wins over the repo root" "$FULL" "$(me_policy_file /some/root)"
unset RALPH_MERGE_POLICY_FILE

echo
echo "merge-evidence: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
