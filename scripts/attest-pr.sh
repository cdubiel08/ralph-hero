#!/bin/bash
# Compose and post/update the merge attestation comment on a PR (GH-1589).
#
# Usage:
#   ./scripts/attest-pr.sh PR_NUMBER \
#     --test "npm test::0::212 passed" [--test "..."]... \
#     --review-verdict APPROVED --reviewer "ralph:review-agent" \
#     [--review-mode internal|external] [--review-url URL] \
#     [--class "mcp-ts::adversarial:mcp-ts"]... [--no-auto-classes] \
#     [--generated-by ID]
#   ./scripts/attest-pr.sh PR_NUMBER \
#     --run "npx vitest run ralph/scripts/" [--run "..."]... \
#     --carry-review [other flags as above]
#
# --test packs "command::exit_code[::summary]". At least one test entry is
# required — an attestation without test evidence is rejected by the merge
# gate anyway. Classes default to auto-computation from the PR diff via
# scripts/pr-file-classes.sh (reviewed_by "adversarial:<class>"); explicit
# --class entries are appended (same packed format). --no-auto-classes
# disables the auto pass.
#
# --run "<cmd>" (repeatable; GH-1712, D9): executes each command in the
# current checkout, captures its REAL exit code, a truncated output digest,
# and `git rev-parse HEAD` at execution time (ran_at_sha), and composes
# tests[] exclusively from those observed runs. Mutually exclusive with
# --test — observed and caller-typed evidence never mix. A failing command
# produces an HONEST failing attestation (posted, exit 0) — the merge gate
# is what refuses it. Posting refuses when any ran_at_sha differs from the
# PR's current head: single line `ATTESTATION REFUSED — head moved`,
# exit 75 (retryable — re-run at the new head). Consumers key on the token,
# never the shared exit code.
#
# --carry-review (GH-1712, D9): copies the `review` block verbatim from the
# PR's existing attestation comment instead of taking --review-verdict /
# --reviewer. Refuses with `ATTESTATION REFUSED — no prior review` (exit 75)
# when no prior attestation exists — re-attestation never invents, and never
# retypes, a review verdict.
#
# The comment carries the machine-readable payload in a ```json fence under
# the <!-- ralph-attestation:v1 --> marker. head_sha is captured from the PR
# at post time — pushing after attesting invalidates the attestation (both
# scripts/merge-pr.sh and validate-attestation.yml compare it to the live
# head). One attestation comment per PR: an existing marker comment is
# updated in place via the REST API, not duplicated.

set -euo pipefail

MARKER='<!-- ralph-attestation:v1 -->'

usage() {
  grep '^#' "$0" | sed -n '2,20p' >&2
  exit 1
}

PR_NUMBER=""
TESTS=()
RUNS=()
CARRY_REVIEW=false
CLASSES=()
AUTO_CLASSES=true
REVIEW_VERDICT=""
REVIEWER=""
REVIEW_MODE="internal"
REVIEW_URL=""
GENERATED_BY="${RALPH_HARNESS_ID:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --test)           TESTS+=("${2:?--test needs a value}"); shift 2 ;;
    --run)            RUNS+=("${2:?--run needs a command}"); shift 2 ;;
    --carry-review)   CARRY_REVIEW=true; shift ;;
    --class)          CLASSES+=("${2:?--class needs a value}"); shift 2 ;;
    --no-auto-classes) AUTO_CLASSES=false; shift ;;
    --review-verdict) REVIEW_VERDICT="${2:?}"; shift 2 ;;
    --reviewer)       REVIEWER="${2:?}"; shift 2 ;;
    --review-mode)    REVIEW_MODE="${2:?}"; shift 2 ;;
    --review-url)     REVIEW_URL="${2:-}"; shift 2 ;;
    --generated-by)   GENERATED_BY="${2:?}"; shift 2 ;;
    -*)               usage ;;
    *)
      if [[ -z "$PR_NUMBER" ]]; then PR_NUMBER="$1"; else usage; fi
      shift
      ;;
  esac
done

[[ -z "$PR_NUMBER" ]] && usage
if [[ ${#TESTS[@]} -gt 0 && ${#RUNS[@]} -gt 0 ]]; then
  echo "ERROR: --test and --run are mutually exclusive — observed and caller-typed evidence never mix" >&2
  exit 1
fi
if [[ ${#TESTS[@]} -eq 0 && ${#RUNS[@]} -eq 0 ]]; then
  echo "ERROR: at least one --test \"command::exit_code[::summary]\" or --run \"<cmd>\" is required" >&2
  exit 1
fi
if [[ "$CARRY_REVIEW" == "true" && ( -n "$REVIEW_VERDICT" || -n "$REVIEWER" ) ]]; then
  echo "ERROR: --carry-review and --review-verdict/--reviewer are mutually exclusive — carry copies, it never retypes" >&2
  exit 1
fi
if [[ "$CARRY_REVIEW" != "true" && ( -z "$REVIEW_VERDICT" || -z "$REVIEWER" ) ]]; then
  echo "ERROR: --review-verdict and --reviewer are required (or --carry-review)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Retry-able refusal, distinct from a failing test run (which posts an honest
# failing attestation, exit 0). 75 is EX_TEMPFAIL, matching merge-pr.sh's
# PENDING. Consumers key on the token, never the shared exit code.
REFUSED_EXIT=75

# Colour and cursor control are the default for every modern test runner, and
# a raw control byte in the digest is a payload no downstream reader can be
# asked to survive. CSI/OSC sequences first, then any remaining C0/C1 control
# byte except tab.
# perl, not sed: BSD sed has no \xNN escape, so a sed written against GNU
# silently passes the pattern through as literal text on the mac this runs on.
strip_ansi() {
  LC_ALL=C perl -pe '
    s/\e\][^\a\e]*(?:\a|\e\\)//g;
    s/\e\[[0-9;?]*[ -\/]*[@-~]//g;
    s/\e[@-Z\\-_]//g;
    s/[\x00-\x08\x0b-\x1f\x7f]//g;
  '
}

# --- observed runs (--run mode) --------------------------------------------
# Executed BEFORE the head fetch: the binding compares the sha each command
# actually ran at against the PR head as of posting time, so a push landing
# mid-run is caught, not laundered.
RUN_RESULTS="[]"
for cmd in ${RUNS[@]+"${RUNS[@]}"}; do
  echo "RUNNING: $cmd" >&2
  set +e
  run_out=$(bash -c "$cmd" 2>&1)
  run_rc=$?
  set -e
  ran_at_sha=$(git rev-parse HEAD 2>/dev/null || echo "")
  if [[ -z "$ran_at_sha" ]]; then
    echo "ERROR: --run requires a git checkout (cannot resolve HEAD)" >&2
    exit 1
  fi
  # Digest: the last non-empty output line, truncated — enough to recognize
  # the run ("212 passed"), never a transcript. Colour is stripped BEFORE the
  # truncation, so the cut can never land inside an escape sequence; markdown
  # pipe-escaping happens at row render, never on the stored payload value.
  # `|| true`: a silent success (shellcheck clean, a bare `true`) has no
  # output lines, grep -v exits 1, and pipefail would kill the whole
  # attestation over an empty digest.
  digest=$(printf '%s\n' "$run_out" | strip_ansi | sed -e 's/\r$//' | grep -v '^[[:space:]]*$' | tail -n 1 | cut -c1-120 || true)
  [[ -z "$digest" ]] && digest="(no output)"
  RUN_RESULTS=$(jq --arg c "$cmd" --argjson e "$run_rc" --arg s "$digest" --arg sha "$ran_at_sha" \
    '. + [{command: $c, exit_code: $e, summary: $s, ran_at_sha: $sha}]' <<<"$RUN_RESULTS")
done

head_sha=$(gh pr view "$PR_NUMBER" --json headRefOid --jq '.headRefOid')
if [[ -z "$head_sha" ]]; then
  echo "ERROR: cannot resolve head SHA for PR #$PR_NUMBER" >&2
  exit 1
fi

# --- head binding (--run mode) ---------------------------------------------
# Evidence is bound to the attested commit, not just to a real run: if the PR
# head moved between running and posting, the observed runs prove nothing
# about what would merge.
if [[ ${#RUNS[@]} -gt 0 ]]; then
  moved=$(jq -r --arg h "$head_sha" '[.[] | select(.ran_at_sha != $h)] | length' <<<"$RUN_RESULTS")
  if [[ "$moved" -gt 0 ]]; then
    first_ran=$(jq -r '.[0].ran_at_sha' <<<"$RUN_RESULTS")
    echo "ATTESTATION REFUSED — head moved (ran at ${first_ran:0:8}, PR head now ${head_sha:0:8}; re-run at the new head)"
    exit "$REFUSED_EXIT"
  fi
fi

# --- comments (fetched once: carry-review source + update-in-place target) --
# --paginate: the default page is 30 comments — a busy PR would hide an older
# attestation and cause a duplicate post instead of an in-place update
# (CodeRabbit finding, PR #1602). Last match across ALL pages wins.
# per_page goes in the URL: `-F` would flip gh api to POST on this GET
# endpoint. Exit code checked on the capture itself — a failed lookup must
# fall through to fresh-post, not feed an error blob into the PATCH URL.
comments_json=""
comments_fetched=false
if comments_json=$(gh api --paginate "repos/{owner}/{repo}/issues/$PR_NUMBER/comments?per_page=100" 2>/dev/null); then
  comments_fetched=true
fi

# --- carried review (--carry-review mode) ----------------------------------
if [[ "$CARRY_REVIEW" == "true" ]]; then
  prior_body=""
  if [[ "$comments_fetched" == "true" ]]; then
    # -s + add: --paginate emits one array per page; slurp+add flattens them.
    prior_body=$(jq -rs --arg m "$MARKER" \
      'add // [] | [.[] | select(.body | contains($m))] | last | .body // ""' <<<"$comments_json")
  fi
  prior_payload=""
  if [[ -n "$prior_body" ]]; then
    prior_payload=$(awk '/^```json[[:space:]]*$/{f=1; next} f && /^```[[:space:]]*$/{exit} f' <<<"$prior_body")
  fi
  carried_review=""
  if [[ -n "$prior_payload" ]] && jq -e '.review.verdict // empty' >/dev/null 2>&1 <<<"$prior_payload"; then
    carried_review=$(jq -c '.review' <<<"$prior_payload")
  fi
  if [[ -z "$carried_review" ]]; then
    echo "ATTESTATION REFUSED — no prior review (no prior attestation with a review block on PR #$PR_NUMBER; a fresh verdict needs --review-verdict/--reviewer from a real review)"
    exit "$REFUSED_EXIT"
  fi
  REVIEW_VERDICT=$(jq -r '.verdict // ""' <<<"$carried_review")
  REVIEWER=$(jq -r '.reviewer // ""' <<<"$carried_review")
  REVIEW_MODE=$(jq -r '.mode // "internal"' <<<"$carried_review")
  REVIEW_URL=$(jq -r '.url // ""' <<<"$carried_review")
fi

if [[ -z "$GENERATED_BY" ]]; then
  GENERATED_BY="$(whoami)@$(hostname -s 2>/dev/null || echo host)"
fi
generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# --- tests[] ---------------------------------------------------------------
tests_json="[]"
if [[ ${#RUNS[@]} -gt 0 ]]; then
  # Observed runs only — real exit codes, digests, and ran_at_sha, captured
  # above. Nothing caller-typed enters this lane.
  tests_json="$RUN_RESULTS"
fi
for t in ${TESTS[@]+"${TESTS[@]}"}; do
  cmd="${t%%::*}"
  rest="${t#*::}"
  exit_code="${rest%%::*}"
  summary=""
  if [[ "$rest" == *::* ]]; then summary="${rest#*::}"; fi
  if ! [[ "$exit_code" =~ ^[0-9]+$ ]]; then
    echo "ERROR: --test '$t' — exit_code must be an integer (format command::exit_code[::summary])" >&2
    exit 1
  fi
  tests_json=$(jq --arg c "$cmd" --argjson e "$exit_code" --arg s "$summary" \
    '. + [{command: $c, exit_code: $e, summary: $s}]' <<<"$tests_json")
done

# --- file_classes[] --------------------------------------------------------
classes_json="[]"
if [[ "$AUTO_CLASSES" == "true" ]]; then
  while IFS= read -r cls; do
    [[ -z "$cls" ]] && continue
    classes_json=$(jq --arg c "$cls" \
      '. + [{class: $c, reviewed_by: ("adversarial:" + $c)}]' <<<"$classes_json")
  done < <("$SCRIPT_DIR/pr-file-classes.sh" --pr "$PR_NUMBER")
fi
for entry in ${CLASSES[@]+"${CLASSES[@]}"}; do
  cls="${entry%%::*}"
  by="${entry#*::}"
  [[ "$by" == "$entry" ]] && by="adversarial:$cls"
  classes_json=$(jq --arg c "$cls" --arg b "$by" \
    '[.[] | select(.class != $c)] + [{class: $c, reviewed_by: $b}]' <<<"$classes_json")
done

# --- payload ---------------------------------------------------------------
payload=$(jq -n \
  --argjson pr "$PR_NUMBER" \
  --arg sha "$head_sha" \
  --argjson tests "$tests_json" \
  --argjson classes "$classes_json" \
  --arg verdict "$REVIEW_VERDICT" \
  --arg reviewer "$REVIEWER" \
  --arg mode "$REVIEW_MODE" \
  --arg url "$REVIEW_URL" \
  --arg gen "$GENERATED_BY" \
  --arg at "$generated_at" \
  '{
    version: 1,
    pr: $pr,
    head_sha: $sha,
    tests: $tests,
    review: {verdict: $verdict, reviewer: $reviewer, mode: $mode, url: $url},
    file_classes: $classes,
    generated_by: $gen,
    generated_at: $at
  }')

# Carried review replaces the composed block wholesale — verbatim copy, so
# any extra keys the prior attestation carried survive the re-attestation.
if [[ "$CARRY_REVIEW" == "true" ]]; then
  payload=$(jq --argjson r "$carried_review" '.review = $r' <<<"$payload")
fi

# Pipe escaping is a markdown-table concern only: it happens here, on the way
# into the row, never on the value stored in the JSON payload (GH-1742).
tests_rows=$(jq -r 'def md: tostring | gsub("\\|"; "\\|");
  .[] | "| `\(.command|md)` | \(.exit_code) | \(.summary|md) |"' <<<"$tests_json")
classes_rows=$(jq -r '.[] | "| \(.class) | \(.reviewed_by) |"' <<<"$classes_json")

body="$MARKER
## Merge Attestation

**PR:** #$PR_NUMBER · **Head:** \`${head_sha:0:8}\` · **Review:** $REVIEW_VERDICT by \`$REVIEWER\` ($REVIEW_MODE)

| Test command | Exit | Summary |
|---|---|---|
$tests_rows

| File class | Reviewed by |
|---|---|
${classes_rows:-| _none_ | _none_ |}

\`\`\`json
$payload
\`\`\`

_Generated by \`$GENERATED_BY\` at $generated_at (scripts/attest-pr.sh, GH-1589). Pushing new commits invalidates this attestation._"

# --- post or update --------------------------------------------------------
# The comment list was fetched once above (carry-review shares it); a failed
# fetch falls through to fresh-post, exactly as before.
existing_id=""
if [[ "$comments_fetched" == "true" ]]; then
  existing_id=$(jq -r --arg m "$MARKER" \
    '[.[] | select(.body | contains($m))] | last | .id // empty' <<<"$comments_json" | tail -1)
fi

if [[ -n "$existing_id" ]]; then
  gh api --method PATCH "repos/{owner}/{repo}/issues/comments/$existing_id" \
    -f body="$body" >/dev/null
  echo "ATTESTATION UPDATED — PR #$PR_NUMBER @ ${head_sha:0:8} (comment $existing_id)"
else
  gh pr comment "$PR_NUMBER" --body "$body" >/dev/null
  echo "ATTESTATION POSTED — PR #$PR_NUMBER @ ${head_sha:0:8}"
fi
