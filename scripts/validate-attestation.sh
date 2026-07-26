#!/bin/bash
# Server-side attestation validation (GH-1589).
#
# Usage: ./scripts/validate-attestation.sh PR_NUMBER
#
# Canonical deep validation of a PR's <!-- ralph-attestation:v1 --> comment.
# The validate-attestation.yml workflow wraps this and publishes the result
# as the `ralph-attestation` commit status — the one enforcement point no
# harness can skip once branch protection requires the context. Also
# runnable locally for debugging.
#
# Output contract: exactly one line "<state>|<description>" on stdout.
#   state ∈ success | failure | pending   (GitHub commit-status states)
#   pending  = evidence not there YET (no attestation, stale sha, awaiting
#              external review) — expected to resolve without code changes
#   failure  = attestation present but WRONG (unparseable, failing tests,
#              missing verdict, class under-coverage)
#   success  = fully attested, or exempt/not-required by policy
# Exits 0 in all verdict cases; non-zero only on invocation error.
#
# Checks, in order:
#   policy missing / attestation.required=false → success (not opted in)
#   author policy-exempt (bots)                 → success
#   marker comment missing                      → pending
#   JSON payload unparseable                    → failure
#   head_sha != current PR head                 → pending (re-attest)
#   tests[] empty or any exit_code != 0         → failure
#   review.verdict empty                        → failure
#   declared file_classes ⊉ recomputed classes  → failure (under-coverage)
#   external review required and absent         → pending
#   otherwise                                   → success

set -euo pipefail

PR_NUMBER="${1:?Usage: $0 PR_NUMBER}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
POLICY_FILE="${RALPH_MERGE_POLICY_FILE:-$REPO_ROOT/.github/ralph-merge-policy.json}"
MARKER='<!-- ralph-attestation:v1 -->'

out() { # out <state> <description> — single-line verdict, exit 0
  echo "$1|$2"
  exit 0
}

# --- policy ----------------------------------------------------------------
if [[ ! -f "$POLICY_FILE" ]]; then
  out success "no merge policy file — attestation not required"
fi
attestation_required=$(jq -r '.attestation.required // false | tostring' "$POLICY_FILE" 2>/dev/null || echo "false")
external_required=$(jq -r '.external_review.required // false | tostring' "$POLICY_FILE" 2>/dev/null || echo "false")
external_bot=$(jq -r '.external_review.bot // "coderabbitai"' "$POLICY_FILE" 2>/dev/null || echo "coderabbitai")

if [[ "$attestation_required" != "true" ]]; then
  out success "attestation not required by policy"
fi

# --- PR facts --------------------------------------------------------------
pr_json=$(gh pr view "$PR_NUMBER" --json headRefOid,author,comments,reviews 2>/dev/null) \
  || out failure "cannot read PR #$PR_NUMBER"
head_sha=$(jq -r '.headRefOid // ""' <<<"$pr_json")
author=$(jq -r '.author.login // ""' <<<"$pr_json")

exempt=$(jq -r --arg a "$author" '
  def norm: sub("^app/"; "") | sub("\\[bot\\]$"; "");
  (((.exempt_authors // []) | map(norm)) | index($a | norm)) != null | tostring
' "$POLICY_FILE" 2>/dev/null || echo "false")
if [[ "$exempt" == "true" ]]; then
  out success "exempt author ($author) — CI checks are the evidence"
fi

# --- attestation comment ---------------------------------------------------
att_body=$(jq -r --arg m "$MARKER" \
  '[.comments[] | select(.body | contains($m))] | last | .body // ""' <<<"$pr_json")
if [[ -z "$att_body" ]]; then
  out pending "awaiting attestation (scripts/attest-pr.sh)"
fi

att_json=$(awk '/^```json[[:space:]]*$/{f=1; next} f && /^```[[:space:]]*$/{exit} f' <<<"$att_body")
if ! jq -e . >/dev/null 2>&1 <<<"$att_json"; then
  out failure "attestation JSON unparseable"
fi

att_sha=$(jq -r '.head_sha // ""' <<<"$att_json")
if [[ "$att_sha" != "$head_sha" ]]; then
  out pending "attestation stale (${att_sha:0:8} != head ${head_sha:0:8}) — re-attest"
fi

tests_ok=$(jq -r '(.tests // []) | ((length > 0) and all(.exit_code == 0)) | tostring' <<<"$att_json")
if [[ "$tests_ok" != "true" ]]; then
  out failure "test evidence missing or failing (tests[] empty or non-zero exit_code)"
fi

has_verdict=$(jq -r '(.review.verdict // "") != "" | tostring' <<<"$att_json")
if [[ "$has_verdict" != "true" ]]; then
  out failure "review verdict missing from attestation"
fi

# --- class coverage: recompute from the live diff --------------------------
computed=$("$SCRIPT_DIR/pr-file-classes.sh" --pr "$PR_NUMBER" | sort -u)
declared=$(jq -r '[.file_classes[]?.class] | .[]' <<<"$att_json" | sort -u)
uncovered=$(comm -23 <(printf '%s\n' "$computed") <(printf '%s\n' "$declared") | grep -v '^$' || true)
if [[ -n "$uncovered" ]]; then
  out failure "file classes not covered by attestation: $(tr '\n' ',' <<<"$uncovered" | sed 's/,$//')"
fi

# --- external (independent-identity) review --------------------------------
if [[ "$external_required" == "true" ]]; then
  ext_count=$(jq -r --arg bot "$external_bot" '
    def norm: sub("^app/"; "") | sub("\\[bot\\]$"; "");
    [.reviews[] | select((.author.login | norm) == ($bot | norm))] | length
  ' <<<"$pr_json")
  if [[ "${ext_count:-0}" -eq 0 ]]; then
    out pending "awaiting external review by $external_bot"
  fi
fi

generated_by=$(jq -r '.generated_by // "unknown"' <<<"$att_json")
out success "attested @ ${head_sha:0:8} by $generated_by"
