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
# One reader of the policy and of the attestation payload, shared with
# merge-pr.sh and pr-gate-watch.sh (GH-1843). This script publishes the
# required commit status, so a divergence from gate 4/5 would let one say PASS
# while the other says PENDING — which is the failure the shared lib removes.
# shellcheck source=lib/merge-evidence.sh
. "$SCRIPT_DIR/lib/merge-evidence.sh"
POLICY_FILE="$(me_policy_file "$REPO_ROOT")"
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
# silently disable the gate (CodeRabbit finding, PR #1602). Exit 2 from the
# loader is that case and only that case.
set +e
policy=$(me_policy_load "$POLICY_FILE")
policy_rc=$?
set -e
if [[ "$policy_rc" -eq 2 ]]; then
  out failure "merge policy file is not valid JSON: $POLICY_FILE"
fi
attestation_required=$(me_policy_get "$policy" attestationRequired)
external_required=$(me_policy_get "$policy" externalRequired)
external_bot=$(me_policy_get "$policy" bot)
external_evidence_mode=$(me_policy_get "$policy" mode)

if [[ "$attestation_required" != "true" ]]; then
  out success "attestation not required by policy"
fi

exempt=$(me_is_exempt "$policy" "$author")
if [[ "$exempt" == "true" ]]; then
  out success "exempt author ($author) — CI checks are the evidence"
fi

# --- attestation comment ---------------------------------------------------
att_body=$(jq -r --arg m "$MARKER" \
  '[.comments[] | select(.body | contains($m))] | last | .body // ""' <<<"$pr_json")
if [[ -z "$att_body" ]]; then
  out pending "awaiting attestation (scripts/attest-pr.sh)"
fi

# Payload extraction and validation are the shared reader's (GH-1843); this
# script owns only the mapping from reason code to published status. Presence
# alone is not approval — an honest REJECTED must fail (CodeRabbit, PR #1602).
att_json=$(me_attestation_payload "$att_body")
att_status=$(me_attestation_status "$att_body" "$head_sha")
att_sha=$(jq -r '.head_sha // ""' <<<"$att_json" 2>/dev/null || echo "")
case "$att_status" in
  missing)    out failure "attestation JSON unparseable" ;;
  stale)      out pending "attestation stale (${att_sha:0:8} != head ${head_sha:0:8}) — re-attest" ;;
  no-tests)   out failure "test evidence missing or failing (tests[] empty or non-zero exit_code)" ;;
  no-verdict) out failure "review verdict missing from attestation" ;;
  rejected)   out failure "review verdict is '$(me_attestation_field "$att_body" .review.verdict)', not APPROVED" ;;
esac

# --- class coverage: recompute from the live diff --------------------------
computed=$("$SCRIPT_DIR/pr-file-classes.sh" --pr "$PR_NUMBER" | sort -u)
declared=$(jq -r '[.file_classes[]?.class] | .[]' <<<"$att_json" | sort -u)
uncovered=$(comm -23 <(printf '%s\n' "$computed") <(printf '%s\n' "$declared") | grep -v '^$' || true)
if [[ -n "$uncovered" ]]; then
  out failure "file classes not covered by attestation: $(tr '\n' ',' <<<"$uncovered" | sed 's/,$//')"
fi

# --- external (independent-identity) review --------------------------------
if [[ "$external_required" == "true" ]]; then
  # Matching scripts/merge-pr.sh gate 5 — which is now literally true in
  # findings mode: both callers run the SAME predicate script.
  #
  # pipefail (set at the top) is load-bearing in the `if !` guard below:
  # without it the status recorded would be jq's, and a failed `gh api` would
  # read as "no evidence yet" rather than an unavailable API.
  if [[ "$external_evidence_mode" == "review" ]]; then
    set +e
    me_review_mode_approved "$PR_NUMBER" "$external_bot" "$head_sha"
    ext_rc=$?
    set -e
    # rc 3 is an unreadable reviews API, not an absent review: both are pending
    # here, but they must not be collapsed at the predicate — "no evidence yet"
    # and "could not read" have opposite correct responses (CodeRabbit, #1839).
    if [[ "$ext_rc" -eq 3 ]]; then
      out pending "external review evidence could not be read (reviews API unavailable)"
    elif [[ "$ext_rc" -ne 0 ]]; then
      out pending "awaiting external review by $external_bot at ${head_sha:0:8}"
    fi
  else
    codex_evidence_sh="${RALPH_CODEX_EVIDENCE_SH:-$SCRIPT_DIR/codex-review-evidence.sh}"
    if [[ ! -x "$codex_evidence_sh" ]]; then
      out failure "external_review names head_marker (findings mode) but $codex_evidence_sh is missing"
    fi
    # An unusable answer is pending — retry-able — never a silent success.
    set +e
    ext_evidence=$(me_run_evidence_script "$codex_evidence_sh" "$PR_NUMBER" "$head_sha")
    ext_rc=$?
    set -e
    if [[ "$ext_rc" -ne 0 ]]; then
      out pending "external review evidence could not be evaluated (exit $ext_rc)"
    fi
    if [[ "$(jq -r '.ok' <<<"$ext_evidence")" != "true" ]]; then
      out pending "$(jq -r '.detail' <<<"$ext_evidence")"
    fi
  fi
fi

generated_by=$(jq -r '.generated_by // "unknown"' <<<"$att_json")
out success "attested @ ${head_sha:0:8} by $generated_by"
