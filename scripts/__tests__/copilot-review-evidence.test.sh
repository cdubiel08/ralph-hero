#!/usr/bin/env bash
# scripts/__tests__/copilot-review-evidence.test.sh
# The review-request findings predicate (GH-2087), against a PATH-injected gh
# stub. Every case here is a MEASURED Copilot behavior (public corpus,
# 2026-08-19, n=31): COMMENTED-only reviews, commit_id head binding, the
# quota/cannot-review failure family that files a real review object while
# reviewing nothing, and thread findings with no severity markup.

set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/copilot-review-evidence.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; echo "        $2"; FAIL=$((FAIL + 1)); }
eq() { # eq <label> <expected> <actual>
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected [$2] got [$3]"; fi
}
contains() { # contains <label> <needle> <haystack>
  case "$3" in *"$2"*) pass "$1" ;; *) fail "$1" "expected to contain [$2] got [$3]" ;; esac
}

# --- gh stub ---------------------------------------------------------------
STUB_BIN="$TMP/bin"
mkdir -p "$STUB_BIN"
cat >"$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
serve() {
  local f="$GH_STUB_DIR/$1"
  if [[ -f "$f" ]]; then cat "$f"; else echo "$2"; fi
}
case "${1:-} ${2:-}" in
  "api graphql")
    serve review_threads.json '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false},"nodes":[]}}}}}'
    [[ -f "$GH_STUB_DIR/fail_threads" ]] && exit 1
    exit 0
    ;;
  "api repos/"*)
    if [[ "$2" == */requested_reviewers* ]]; then
      serve requested_reviewers.json '{"users":[],"teams":[]}'
      if [[ -f "$GH_STUB_DIR/fail_requested" ]]; then exit 1; fi
    else
      serve pr_reviews.json '[]'
      if [[ -f "$GH_STUB_DIR/fail_reviews" ]]; then exit 1; fi
    fi
    ;;
  *) echo "stub: unhandled gh $*" >&2; exit 64 ;;
esac
STUB
chmod +x "$STUB_BIN/gh"

HEAD="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BOT="copilot-pull-request-reviewer[bot]"

POLICY="$TMP/policy.json"
cat >"$POLICY" <<'JSON'
{ "external_review": { "required": true, "request_mode": "review-request" } }
JSON

run() { # run <stub-dir> -> LAST_OUT (the JSON verdict), LAST_RC
  local dir="$1"
  LAST_OUT=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$dir" \
    RALPH_MERGE_POLICY_FILE="$POLICY" bash "$SCRIPT" 42 "$HEAD" 2>/dev/null)
  LAST_RC=$?
}
field() { jq -r ".$1" <<<"$LAST_OUT"; }

mk() { mkdir -p "$TMP/$1"; echo "$TMP/$1"; }

review() { # review <commit> <state> <body> -> one REST review object
  jq -nc --arg c "$1" --arg s "$2" --arg b "$3" \
    '{user:{login:"copilot-pull-request-reviewer[bot]"}, commit_id:$c, state:$s,
      body:$b, html_url:"https://example.test/review", submitted_at:"2026-08-19T00:00:00Z"}'
}
CLEAN_BODY='## Pull request overview

Looks fine.

### Reviewed changes

Copilot reviewed 3 out of 3 changed files in this pull request and generated no comments.'
QUOTA_BODY='Copilot was unable to review this pull request because the user who requested the review has reached their quota limit.'
NOFILES_BODY="Copilot wasn't able to review any files in this pull request."

thread() { # thread <resolved> <outdated> [login] [body]
  jq -nc --argjson r "$1" --argjson o "$2" --arg l "${3:-copilot-pull-request-reviewer}" --arg b "${4:-a finding}" \
    '{isResolved:$r, isOutdated:$o, comments:{nodes:[{author:{login:$l}, body:$b, url:"https://example.test/thread"}]}}'
}
threads_payload() { # threads_payload <nodes-json-array> [hasNextPage]
  jq -nc --argjson n "$1" --argjson more "${2:-false}" \
    '{data:{repository:{pullRequest:{reviewThreads:{pageInfo:{hasNextPage:$more}, nodes:$n}}}}}'
}

# --- the clean path ---------------------------------------------------------
echo "=== answered at head, clean ==="

D=$(mk clean)
review "$HEAD" COMMENTED "$CLEAN_BODY" | jq -s . >"$D/pr_reviews.json"
run "$D"
eq "clean review at head, no threads → ok" "true" "$(field ok)"
eq "…exit 0" "0" "$LAST_RC"
eq "…reviewer is the filing login" "$BOT" "$(field reviewer)"
contains "…detail names the head" "${HEAD:0:8}" "$(field detail)"

# A clean diff still produces a review object (measured — the GH-1847
# unsatisfiable-predicate trap does not apply here), so ok=true above IS that
# assertion: no plain-comment fallback was needed or consulted.

# --- the failure family ------------------------------------------------------
echo "=== the failure family: a review object that reviewed nothing ==="

D=$(mk quota)
review "$HEAD" COMMENTED "$QUOTA_BODY" | jq -s . >"$D/pr_reviews.json"
run "$D"
eq "quota-exhausted review is NOT evidence" "false" "$(field ok)"
eq "…and the turn is yours (waiting cannot terminate)" "yours" "$(field turn)"
contains "…detail carries the reviewer's own reason" "quota limit" "$(field detail)"
contains "…and the re-request command" "requested_reviewers" "$(field detail)"

D=$(mk nofiles)
review "$HEAD" COMMENTED "$NOFILES_BODY" | jq -s . >"$D/pr_reviews.json"
run "$D"
eq "cannot-review-any-files is NOT evidence" "false" "$(field ok)"

# A failure review followed by a real one at the same head: the answer wins.
D=$(mk quota-then-clean)
{ review "$HEAD" COMMENTED "$QUOTA_BODY"; review "$HEAD" COMMENTED "$CLEAN_BODY"; } | jq -s . >"$D/pr_reviews.json"
run "$D"
eq "a real answer beside an old failure → ok" "true" "$(field ok)"

# --- head binding ------------------------------------------------------------
echo "=== head binding ==="

D=$(mk stale-head)
review "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" COMMENTED "$CLEAN_BODY" | jq -s . >"$D/pr_reviews.json"
run "$D"
eq "review at another head is not an answer" "false" "$(field ok)"
eq "…no pending request → yours" "yours" "$(field turn)"
contains "…remedy is the request command" "reviewers[]=Copilot" "$(field detail)"
contains "…and warns about the silent drop" "silently dropped" "$(field detail)"

D=$(mk dismissed)
review "$HEAD" DISMISSED "$CLEAN_BODY" | jq -s . >"$D/pr_reviews.json"
run "$D"
eq "a DISMISSED review is not an answer" "false" "$(field ok)"

# --- the request half --------------------------------------------------------
echo "=== whose turn: the pending request ==="

D=$(mk requested)
echo '{"users":[{"login":"Copilot","type":"Bot"}],"teams":[]}' >"$D/requested_reviewers.json"
run "$D"
eq "pending request → reviewer's turn" "reviewer" "$(field turn)"
eq "…not ok yet" "false" "$(field ok)"

D=$(mk requested-bot-login)
echo '{"users":[{"login":"copilot-pull-request-reviewer[bot]"}],"teams":[]}' >"$D/requested_reviewers.json"
run "$D"
eq "request recorded under the filing login also counts" "reviewer" "$(field turn)"

D=$(mk no-request)
run "$D"
eq "no review, no request → yours" "yours" "$(field turn)"

# --- threads ----------------------------------------------------------------
echo "=== thread findings: every unresolved one blocks ==="

D=$(mk finding)
review "$HEAD" COMMENTED "$CLEAN_BODY" | jq -s . >"$D/pr_reviews.json"
threads_payload "[$(thread false false)]" >"$D/review_threads.json"
run "$D"
eq "an unresolved bot thread blocks — NO badge required" "false" "$(field ok)"
eq "…turn is yours (fix or resolve)" "yours" "$(field turn)"
contains "…count in the detail" "1 unresolved" "$(field detail)"

D=$(mk resolved)
review "$HEAD" COMMENTED "$CLEAN_BODY" | jq -s . >"$D/pr_reviews.json"
threads_payload "[$(thread true false)]" >"$D/review_threads.json"
run "$D"
eq "a resolved thread does not block" "true" "$(field ok)"

D=$(mk outdated)
review "$HEAD" COMMENTED "$CLEAN_BODY" | jq -s . >"$D/pr_reviews.json"
threads_payload "[$(thread false true)]" >"$D/review_threads.json"
run "$D"
eq "an outdated thread does not block (fixed code has no resolve verb)" "true" "$(field ok)"

D=$(mk foreign-thread)
review "$HEAD" COMMENTED "$CLEAN_BODY" | jq -s . >"$D/pr_reviews.json"
threads_payload "[$(thread false false "some-human")]" >"$D/review_threads.json"
run "$D"
eq "another author's thread is not this gate's" "true" "$(field ok)"

D=$(mk too-many)
review "$HEAD" COMMENTED "$CLEAN_BODY" | jq -s . >"$D/pr_reviews.json"
threads_payload "[$(thread false false)]" true >"$D/review_threads.json"
run "$D"
eq ">100 threads → not evaluated, not guessed" "false" "$(field ok)"
contains "…names the remedy" "more than 100" "$(field detail)"

# --- failed reads are never empty evidence ----------------------------------
echo "=== failed reads ==="

D=$(mk fail-reviews)
touch "$D/fail_reviews"
run "$D"
eq "unreadable reviews → retry, not 'no review yet'" "false" "$(field ok)"
contains "…says retry" "retry" "$(field detail)"
eq "…turn stays with the reviewer (a wait)" "reviewer" "$(field turn)"

D=$(mk fail-requested)
touch "$D/fail_requested"
run "$D"
contains "unreadable requested_reviewers → retry" "retry" "$(field detail)"

D=$(mk fail-threads)
review "$HEAD" COMMENTED "$CLEAN_BODY" | jq -s . >"$D/pr_reviews.json"
touch "$D/fail_threads"
run "$D"
contains "unreadable threads → retry" "retry" "$(field detail)"

# --- usage ------------------------------------------------------------------
echo "=== usage ==="
PATH="$STUB_BIN:$PATH" bash "$SCRIPT" >/dev/null 2>&1
eq "no args → exit 2" "2" "$?"

echo
echo "copilot-review-evidence: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
