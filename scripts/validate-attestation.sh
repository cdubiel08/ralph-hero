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
# Output contract: exactly one line "<state>|<sha>|<description>" on stdout.
#   state ∈ success | failure | pending   (GitHub commit-status states)
#   sha    = the head SHA this verdict was computed against ("unknown" when
#            the PR itself could not be read). The workflow posts the status
#            on THIS sha — never a re-queried one — so a push racing the
#            validation cannot receive a verdict computed for an older commit
#            (CodeRabbit finding, PR #1602).
#   pending  = evidence not there YET (no attestation, stale sha, awaiting
#              external review) — expected to resolve without code changes
#   failure  = attestation present but WRONG (unparseable, failing tests,
#              non-APPROVED verdict, class under-coverage) — or a malformed
#              policy file (fail closed)
#   success  = fully attested, or exempt/not-required by policy
# Exits 0 in all verdict cases; non-zero only on invocation error.
#
# Checks, in order:
#   PR unreadable                               → failure (sha unknown)
#   policy file malformed JSON                  → failure (fail CLOSED)
#   policy missing / attestation.required=false → success (not opted in)
#   author policy-exempt (bots)                 → success
#   marker comment missing                      → pending
#   JSON payload unparseable                    → failure
#   head_sha != current PR head                 → pending (re-attest)
#   tests[] empty or any exit_code != 0         → failure
#   review.verdict != APPROVED                  → failure
#   declared file_classes ⊉ recomputed classes  → failure (under-coverage)
#   external review required and absent         → pending
#   otherwise                                   → success

set -euo pipefail

PR_NUMBER="${1:?Usage: $0 PR_NUMBER}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
POLICY_FILE="${RALPH_MERGE_POLICY_FILE:-$REPO_ROOT/.github/ralph-merge-policy.json}"
MARKER='<!-- ralph-attestation:v1 -->'

head_sha="unknown"
out() { # out <state> <description> — single-line verdict bound to head_sha, exit 0
  echo "$1|$head_sha|$2"
  exit 0
}

# --- PR facts (first, so every verdict carries the validated sha) ----------
pr_json=$(gh pr view "$PR_NUMBER" --json headRefOid,author,comments,reviews 2>/dev/null) \
  || out failure "cannot read PR #$PR_NUMBER"
head_sha=$(jq -r '.headRefOid // "unknown"' <<<"$pr_json")
author=$(jq -r '.author.login // ""' <<<"$pr_json")

# --- policy ----------------------------------------------------------------
if [[ ! -f "$POLICY_FILE" ]]; then
  out success "no merge policy file — attestation not required"
fi
# Fail CLOSED on a malformed policy file — a corrupt policy must not
# silently disable the gate (CodeRabbit finding, PR #1602).
if ! jq -e . "$POLICY_FILE" >/dev/null 2>&1; then
  out failure "merge policy file is not valid JSON: $POLICY_FILE"
fi
attestation_required=$(jq -r '.attestation.required // false | tostring' "$POLICY_FILE")
external_required=$(jq -r '.external_review.required // false | tostring' "$POLICY_FILE")
external_bot=$(jq -r '.external_review.bot // "chatgpt-codex-connector[bot]"' "$POLICY_FILE")
external_trigger=$(jq -r '.external_review.trigger // "@codex review"' "$POLICY_FILE")
external_head_marker=$(jq -r '.external_review.head_marker // "ralph-review-head"' "$POLICY_FILE")
external_clean_marker=$(jq -r '.external_review.clean_comment_marker // "Codex Review: Didn\u0027t find any major issues."' "$POLICY_FILE")
external_approval_reaction=$(jq -r '.external_review.approval_reaction // "+1"' "$POLICY_FILE")

if [[ "$attestation_required" != "true" ]]; then
  out success "attestation not required by policy"
fi

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

att_verdict=$(jq -r '.review.verdict // ""' <<<"$att_json")
if [[ -z "$att_verdict" ]]; then
  out failure "review verdict missing from attestation"
elif [[ "$att_verdict" != "APPROVED" ]]; then
  # Presence alone is not approval — an honest REJECTED must fail
  # (CodeRabbit finding, PR #1602).
  out failure "review verdict is '$att_verdict', not APPROVED"
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
  # Matching scripts/merge-pr.sh gate 5: Codex findings arrive as COMMENTED
  # reviews and never count as approval. A clean review is the bot-authored
  # clean-result comment plus its PR-level thumbs-up reaction.
  external_fetch_ok=true
  if ! ext_comments=$(gh api "repos/{owner}/{repo}/issues/$PR_NUMBER/comments" --paginate 2>/dev/null | jq -s 'add // []'); then
    ext_comments='[]'
    external_fetch_ok=false
  fi
  if ! ext_reactions=$(gh api "repos/{owner}/{repo}/issues/$PR_NUMBER/reactions" --paginate 2>/dev/null | jq -s 'add // []'); then
    ext_reactions='[]'
    external_fetch_ok=false
  fi
  if ! ext_reviews=$(gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER/reviews" --paginate 2>/dev/null | jq -s 'add // []'); then
    ext_reviews='[]'
    external_fetch_ok=false
  fi

  head_marker="<!-- $external_head_marker: $head_sha -->"
  request_at=$(jq -r --arg trigger "$external_trigger" --arg marker "$head_marker" '
    [ .[]
      | select((.body // "") | contains($trigger))
      | select((.body // "") | contains($marker))
      | .updated_at // .created_at // empty
    ] | max // ""' <<<"$ext_comments")

  clean_at=""
  if [[ -n "$request_at" ]]; then
    clean_at=$(jq -r --arg bot "$external_bot" --arg clean "$external_clean_marker" --arg request "$request_at" '
      def norm: sub("^app/"; "") | sub("\\[bot\\]$"; "");
      [ .[]
        | select(((.user.login // "") | norm) == ($bot | norm))
        | select((.body // "") | contains($clean))
        | select((.created_at // "") > $request)
        | .created_at
      ] | max // ""' <<<"$ext_comments")
  fi

  ext_reaction_count=$(jq -r --arg bot "$external_bot" --arg reaction "$external_approval_reaction" '
        def norm: sub("^app/"; "") | sub("\\[bot\\]$"; "");
        [ .[]
          | select(((.user.login // "") | norm) == ($bot | norm))
          | select((.content // "") == $reaction)
        ] | length' <<<"$ext_reactions")

  findings_after_clean=0
  if [[ -n "$clean_at" ]]; then
    findings_after_clean=$(jq -r --arg bot "$external_bot" --arg sha "$head_sha" --arg clean "$clean_at" '
      def norm: sub("^app/"; "") | sub("\\[bot\\]$"; "");
      [ .[]
        | select(((.user.login // "") | norm) == ($bot | norm))
        | select((.commit_id // "") == $sha)
        | select((.state // "") != "DISMISSED" and (.state // "") != "APPROVED")
        | select((.submitted_at // "") == "" or (.submitted_at // "") >= $clean)
      ] | length' <<<"$ext_reviews")
  fi

  if [[ "$external_fetch_ok" != "true" || -z "$request_at" || -z "$clean_at" || "${ext_reaction_count:-0}" -eq 0 || "${findings_after_clean:-0}" -ne 0 ]]; then
    out pending "awaiting external review by $external_bot at ${head_sha:0:8}"
  fi
fi

generated_by=$(jq -r '.generated_by // "unknown"' <<<"$att_json")
out success "attested @ ${head_sha:0:8} by $generated_by"
