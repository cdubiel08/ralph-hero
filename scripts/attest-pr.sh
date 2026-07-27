#!/bin/bash
# Compose and post/update the merge attestation comment on a PR (GH-1589).
#
# Usage:
#   ./scripts/attest-pr.sh PR_NUMBER \
#     --test "npm test::0::212 passed" [--test "..."]... \
#     --review-verdict APPROVED --reviewer "ralph:review-agent" \
#     [--review-mode internal|external] [--review-url URL] \
#     [--class "mcp-ts::adversarial:mcp-ts"]... [--no-auto-classes] \
#     [--model-tier "impl::standard::sonnet"]... \
#     [--generated-by ID]
#
# --test packs "command::exit_code[::summary]". At least one is required —
# an attestation without test evidence is rejected by the merge gate anyway.
# Classes default to auto-computation from the PR diff via
# scripts/pr-file-classes.sh (reviewed_by "adversarial:<class>"); explicit
# --class entries are appended (same packed format). --no-auto-classes
# disables the auto pass.
#
# --model-tier packs "phase::tier::model" (GH-1593) — a per-phase spend
# record, e.g. "impl::standard::sonnet" or "review::capable::best". All
# three segments are required (mirrors --test's packing convention: fewer
# than 3 `::`-separated segments is a hard error at post time, same
# posture as --test's exit-code validation). `phase` is free text
# (impl/review/research/...); `tier` SHOULD be one of the four
# .ralph-models.yml tier names but is recorded verbatim — the attestation
# records what ran, it does not re-validate the tier system. Optional:
# omitting every --model-tier keeps the payload's `models` field an empty
# array, which validate-attestation.sh treats identically to a fully
# absent field (spend observability, never a merge gate).
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
  grep '^#' "$0" | sed -n '2,37p' >&2
  exit 1
}

PR_NUMBER=""
TESTS=()
CLASSES=()
AUTO_CLASSES=true
REVIEW_VERDICT=""
REVIEWER=""
REVIEW_MODE="internal"
REVIEW_URL=""
GENERATED_BY="${RALPH_HARNESS_ID:-}"
MODEL_TIERS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --test)           TESTS+=("${2:?--test needs a value}"); shift 2 ;;
    --class)          CLASSES+=("${2:?--class needs a value}"); shift 2 ;;
    --no-auto-classes) AUTO_CLASSES=false; shift ;;
    --review-verdict) REVIEW_VERDICT="${2:?}"; shift 2 ;;
    --reviewer)       REVIEWER="${2:?}"; shift 2 ;;
    --review-mode)    REVIEW_MODE="${2:?}"; shift 2 ;;
    --review-url)     REVIEW_URL="${2:-}"; shift 2 ;;
    --generated-by)   GENERATED_BY="${2:?}"; shift 2 ;;
    --model-tier)     MODEL_TIERS+=("${2:?--model-tier needs a value}"); shift 2 ;;
    -*)               usage ;;
    *)
      if [[ -z "$PR_NUMBER" ]]; then PR_NUMBER="$1"; else usage; fi
      shift
      ;;
  esac
done

[[ -z "$PR_NUMBER" ]] && usage
if [[ ${#TESTS[@]} -eq 0 ]]; then
  echo "ERROR: at least one --test \"command::exit_code[::summary]\" is required" >&2
  exit 1
fi
if [[ -z "$REVIEW_VERDICT" || -z "$REVIEWER" ]]; then
  echo "ERROR: --review-verdict and --reviewer are required" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

head_sha=$(gh pr view "$PR_NUMBER" --json headRefOid --jq '.headRefOid')
if [[ -z "$head_sha" ]]; then
  echo "ERROR: cannot resolve head SHA for PR #$PR_NUMBER" >&2
  exit 1
fi

if [[ -z "$GENERATED_BY" ]]; then
  GENERATED_BY="$(whoami)@$(hostname -s 2>/dev/null || echo host)"
fi
generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# --- tests[] ---------------------------------------------------------------
tests_json="[]"
for t in "${TESTS[@]}"; do
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

# --- models[] (GH-1593) -----------------------------------------------------
# Optional per-phase tier/model spend trail. Packing mirrors --test:
# "phase::tier::model" — first two `::`-splits give phase/tier, everything
# after the second `::` is the model (so a model id that itself contains
# `::` is preserved verbatim rather than truncated). Absent entirely →
# models_json stays "[]", which validate-attestation.sh treats identically
# to a fully missing `models` key (never a merge gate).
models_json="[]"
for mt in ${MODEL_TIERS[@]+"${MODEL_TIERS[@]}"}; do
  phase="${mt%%::*}"
  rest="${mt#*::}"
  if [[ "$rest" == "$mt" ]]; then
    echo "ERROR: --model-tier '$mt' — expected format phase::tier::model" >&2
    exit 1
  fi
  tier="${rest%%::*}"
  model="${rest#*::}"
  if [[ "$model" == "$rest" ]]; then
    echo "ERROR: --model-tier '$mt' — expected format phase::tier::model" >&2
    exit 1
  fi
  if [[ -z "$phase" || -z "$tier" || -z "$model" ]]; then
    echo "ERROR: --model-tier '$mt' — phase, tier, and model must all be non-empty" >&2
    exit 1
  fi
  models_json=$(jq --arg p "$phase" --arg t "$tier" --arg m "$model" \
    '. + [{phase: $p, tier: $t, model: $m}]' <<<"$models_json")
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
  --argjson models "$models_json" \
  --arg gen "$GENERATED_BY" \
  --arg at "$generated_at" \
  '{
    version: 1,
    pr: $pr,
    head_sha: $sha,
    tests: $tests,
    review: {verdict: $verdict, reviewer: $reviewer, mode: $mode, url: $url},
    file_classes: $classes,
    models: $models,
    generated_by: $gen,
    generated_at: $at
  }')

tests_rows=$(jq -r '.[] | "| `\(.command)` | \(.exit_code) | \(.summary) |"' <<<"$tests_json")
classes_rows=$(jq -r '.[] | "| \(.class) | \(.reviewed_by) |"' <<<"$classes_json")
models_rows=$(jq -r '.[] | "| \(.phase) | \(.tier) | \(.model) |"' <<<"$models_json")

models_section=""
if [[ -n "$models_rows" ]]; then
  models_section="
| Phase | Tier | Model |
|---|---|---|
$models_rows
"
fi

body="$MARKER
## Merge Attestation

**PR:** #$PR_NUMBER · **Head:** \`${head_sha:0:8}\` · **Review:** $REVIEW_VERDICT by \`$REVIEWER\` ($REVIEW_MODE)

| Test command | Exit | Summary |
|---|---|---|
$tests_rows

| File class | Reviewed by |
|---|---|
${classes_rows:-| _none_ | _none_ |}
$models_section
\`\`\`json
$payload
\`\`\`

_Generated by \`$GENERATED_BY\` at $generated_at (scripts/attest-pr.sh, GH-1589). Pushing new commits invalidates this attestation._"

# --- post or update --------------------------------------------------------
# --paginate: the default page is 30 comments — a busy PR would hide an older
# attestation and cause a duplicate post instead of an in-place update
# (CodeRabbit finding, PR #1602). Last match across ALL pages wins.
# per_page goes in the URL: `-F` would flip gh api to POST on this GET
# endpoint. Exit code checked on the capture itself — a failed lookup must
# fall through to fresh-post, not feed an error blob into the PATCH URL.
existing_id=""
if comments_json=$(gh api --paginate "repos/{owner}/{repo}/issues/$PR_NUMBER/comments?per_page=100" 2>/dev/null); then
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
