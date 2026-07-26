#!/bin/bash
# Merge a PR through verification gates, with deterministic worktree cleanup.
#
# Usage: ./scripts/merge-pr.sh PR_NUMBER [WORKTREE_ID] [--force "reason"]
#
# GH-1589 (epic #1588): this script is the PORTABLE merge gate — the
# verification lives here, in plain bash + gh + jq, so it binds from any
# shell or harness (Claude Code, hero-fable, bare terminal, CI). Claude Code
# hooks are advisory/funnel UX on top; they are NOT the enforcement layer.
#
# Gates (in order):
#   0. PR is OPEN (fetch state/mergeable/head/author/reviewDecision in one call)
#   1. reviewDecision != CHANGES_REQUESTED   — HARD block, not forceable.
#      Dismiss or resolve the review on GitHub to clear it (audit-logged).
#   2. mergeable == MERGEABLE (UNKNOWN retried once after 5s; CONFLICTING blocks)
#   3. All CI checks green (bucket pass/skipping). Pending or failing blocks.
#      The `ralph-attestation` status context is EXCLUDED here — this script
#      validates the attestation comment directly (gate 4); the commit status
#      is the server-side backstop published by validate-attestation.yml.
#      Zero checks reported → loud warn, continue (CI-less-repo portability).
#   4. Attestation comment (<!-- ralph-attestation:v1 -->) present, JSON-valid,
#      head_sha == current PR head, non-empty tests[] all exit_code 0, review
#      verdict present. Skipped for policy-exempt authors (bots).
#   5. External review by the policy bot (default coderabbitai) exists.
#      Skipped for policy-exempt authors.
#
# Policy: .github/ralph-merge-policy.json (override path for tests via
# RALPH_MERGE_POLICY_FILE). NO policy file → gates 4-5 off (repo hasn't
# opted in); gates 0-3 always apply.
#
# --force "reason": skips gates 2 (UNKNOWN only), 3, 4, 5 — never gate 1 —
# and posts a "## Merge Gate Override" comment on the PR (reason, actor,
# skipped gates, head sha) BEFORE merging. Loud and durable, never silent.
#
# Output contract (loop-runners grep these):
#   MERGE GATE PASS            — all gates satisfied (or force-skipped)
#   MERGE GATE WARN — ...      — non-blocking anomaly (e.g. zero checks)
#   MERGE GATE FAIL — g: ...   — first failing gate, machine-parseable
#   MERGE BLOCKED — ...        — legacy token, emitted alongside FAIL
#
# Caveat: attestation lookup reads the PR comment list via `gh pr view
# --json comments` (first ~100 comments). Attestations are posted at
# close-out so `last` matching is correct in practice.

set -euo pipefail

usage() {
  echo "Usage: $0 PR_NUMBER [WORKTREE_ID] [--force \"reason\"]" >&2
  exit 1
}

PR_NUMBER=""
WORKTREE_ID=""
FORCE=false
FORCE_REASON=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE=true
      FORCE_REASON="${2:-}"
      if [[ -z "$FORCE_REASON" ]]; then
        echo "MERGE GATE FAIL — force: --force requires a reason string" >&2
        exit 1
      fi
      shift 2
      ;;
    -*)
      usage
      ;;
    *)
      if [[ -z "$PR_NUMBER" ]]; then
        PR_NUMBER="$1"
      elif [[ -z "$WORKTREE_ID" ]]; then
        WORKTREE_ID="$1"
      else
        usage
      fi
      shift
      ;;
  esac
done

[[ -z "$PR_NUMBER" ]] && usage

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [[ -z "$PROJECT_ROOT" ]]; then
  echo "Error: Not in a git repository" >&2
  exit 1
fi

POLICY_FILE="${RALPH_MERGE_POLICY_FILE:-$PROJECT_ROOT/.github/ralph-merge-policy.json}"

# Gate-skip accumulator for --force (bash-3.2-safe counter + newline list).
SKIPPED_GATES=""
SKIPPED_COUNT=0

block() { # block <gate> <detail>  — hard stop (or force-skip when allowed)
  echo "MERGE GATE FAIL — $1: $2"
  echo "MERGE BLOCKED — $2"
  exit 1
}

soft_gate() { # soft_gate <gate> <detail> — blocks unless --force
  if [[ "$FORCE" == "true" ]]; then
    SKIPPED_GATES="${SKIPPED_GATES}- **$1**: $2"$'\n'
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    echo "MERGE GATE WARN — $1 skipped by --force: $2"
  else
    block "$1" "$2"
  fi
}

# ---------------------------------------------------------------------------
# Policy
# ---------------------------------------------------------------------------
ATTESTATION_REQUIRED="false"
EXTERNAL_REQUIRED="false"
EXTERNAL_BOT="coderabbitai"
if [[ -f "$POLICY_FILE" ]]; then
  # Fail CLOSED on a malformed policy file — a truncated/corrupt policy must
  # not silently disable the evidence gates (CodeRabbit finding, PR #1602).
  if ! jq -e . "$POLICY_FILE" >/dev/null 2>&1; then
    block "policy" "merge policy file is not valid JSON: $POLICY_FILE"
  fi
  ATTESTATION_REQUIRED=$(jq -r '.attestation.required // false | tostring' "$POLICY_FILE")
  EXTERNAL_REQUIRED=$(jq -r '.external_review.required // false | tostring' "$POLICY_FILE")
  EXTERNAL_BOT=$(jq -r '.external_review.bot // "coderabbitai"' "$POLICY_FILE")
fi

# ---------------------------------------------------------------------------
# Gate 0: PR core facts (single fetch)
# ---------------------------------------------------------------------------
pr_json=$(gh pr view "$PR_NUMBER" --json state,mergeable,headRefOid,reviewDecision,author 2>/dev/null) \
  || block "fetch" "cannot read PR #$PR_NUMBER (gh pr view failed)"

state=$(jq -r '.state // ""' <<<"$pr_json")
mergeable=$(jq -r '.mergeable // ""' <<<"$pr_json")
head_sha=$(jq -r '.headRefOid // ""' <<<"$pr_json")
decision=$(jq -r '.reviewDecision // ""' <<<"$pr_json")
author=$(jq -r '.author.login // ""' <<<"$pr_json")

[[ "$state" == "OPEN" ]] || block "state" "PR #$PR_NUMBER is $state, not OPEN"

# Exempt author? Normalize the app/ prefix and [bot] suffix on both sides.
EXEMPT="false"
if [[ -f "$POLICY_FILE" ]]; then
  EXEMPT=$(jq -r --arg a "$author" '
    def norm: sub("^app/"; "") | sub("\\[bot\\]$"; "");
    (((.exempt_authors // []) | map(norm)) | index($a | norm)) != null | tostring
  ' "$POLICY_FILE" 2>/dev/null || echo "false")
fi

# ---------------------------------------------------------------------------
# Gate 1: CHANGES_REQUESTED — unconditional, --force does not apply
# ---------------------------------------------------------------------------
if [[ "$decision" == "CHANGES_REQUESTED" ]]; then
  block "review" "changes requested on PR #$PR_NUMBER — dismiss or resolve the review on GitHub (not forceable)"
fi

# ---------------------------------------------------------------------------
# Gate 2: mergeable
# ---------------------------------------------------------------------------
if [[ "$mergeable" == "UNKNOWN" ]]; then
  sleep 5
  mergeable=$(gh pr view "$PR_NUMBER" --json mergeable --jq '.mergeable' 2>/dev/null || echo "UNKNOWN")
fi
case "$mergeable" in
  MERGEABLE) ;;
  CONFLICTING)
    # Physically cannot merge; force cannot help.
    block "mergeable" "PR #$PR_NUMBER has conflicts — rebase first"
    ;;
  *)
    soft_gate "mergeable" "mergeable status is ${mergeable:-empty} after retry"
    ;;
esac

# ---------------------------------------------------------------------------
# Gate 3: CI checks green
# ---------------------------------------------------------------------------
checks_json=$(gh pr checks "$PR_NUMBER" --json name,bucket 2>/dev/null || true)
if [[ -z "$checks_json" ]] || ! jq -e . >/dev/null 2>&1 <<<"$checks_json"; then
  checks_json="[]"
fi
checks_total=$(jq 'length' <<<"$checks_json")
if [[ "$checks_total" -eq 0 ]]; then
  echo "MERGE GATE WARN — checks: no CI checks reported on PR #$PR_NUMBER (continuing)"
else
  not_green=$(jq -r '
    [.[] | select(.name != "ralph-attestation")
         | select(.bucket != "pass" and .bucket != "skipping")]
    | map("\(.name)=\(.bucket)") | join(", ")
  ' <<<"$checks_json")
  if [[ -n "$not_green" ]]; then
    soft_gate "checks" "not green: $not_green"
  fi
fi

# ---------------------------------------------------------------------------
# Gate 4: attestation
# ---------------------------------------------------------------------------
ATTESTATION_MARKER='<!-- ralph-attestation:v1 -->'
if [[ "$ATTESTATION_REQUIRED" == "true" && "$EXEMPT" == "false" ]]; then
  att_body=$(gh pr view "$PR_NUMBER" --json comments \
    --jq "[.comments[] | select(.body | contains(\"$ATTESTATION_MARKER\"))] | last | .body // \"\"" \
    2>/dev/null || echo "")
  if [[ -z "$att_body" ]]; then
    soft_gate "attestation" "no $ATTESTATION_MARKER comment on PR #$PR_NUMBER (run scripts/attest-pr.sh)"
  else
    att_json=$(awk '/^```json[[:space:]]*$/{f=1; next} f && /^```[[:space:]]*$/{exit} f' <<<"$att_body")
    if ! jq -e . >/dev/null 2>&1 <<<"$att_json"; then
      soft_gate "attestation" "attestation comment present but JSON payload unparseable"
    else
      att_sha=$(jq -r '.head_sha // ""' <<<"$att_json")
      tests_ok=$(jq -r '(.tests // []) | ((length > 0) and all(.exit_code == 0)) | tostring' <<<"$att_json")
      att_verdict=$(jq -r '.review.verdict // ""' <<<"$att_json")
      if [[ "$att_sha" != "$head_sha" ]]; then
        soft_gate "attestation" "attestation head_sha ${att_sha:0:8} != PR head ${head_sha:0:8} — re-attest after the latest push"
      elif [[ "$tests_ok" != "true" ]]; then
        soft_gate "attestation" "attestation lacks passing test evidence (tests[] empty or non-zero exit_code)"
      elif [[ -z "$att_verdict" ]]; then
        soft_gate "attestation" "attestation lacks a review verdict"
      elif [[ "$att_verdict" != "APPROVED" ]]; then
        # An honest non-approving verdict is evidence AGAINST merging
        # (CodeRabbit finding, PR #1602: presence-only check let REJECTED pass).
        soft_gate "attestation" "attestation review verdict is '$att_verdict', not APPROVED"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Gate 5: external (independent-identity) review
# ---------------------------------------------------------------------------
if [[ "$EXTERNAL_REQUIRED" == "true" && "$EXEMPT" == "false" ]]; then
  ext_count=$(gh pr view "$PR_NUMBER" --json reviews --jq "
    [.reviews[] | select(
      (.author.login | sub(\"^app/\"; \"\") | sub(\"\\\\[bot\\\\]\$\"; \"\"))
      == (\"$EXTERNAL_BOT\" | sub(\"\\\\[bot\\\\]\$\"; \"\"))
    )] | length" 2>/dev/null || echo "0")
  if [[ "${ext_count:-0}" -eq 0 ]]; then
    soft_gate "external-review" "no review by $EXTERNAL_BOT on PR #$PR_NUMBER"
  fi
fi

# ---------------------------------------------------------------------------
# Force override: durable record BEFORE merging
# ---------------------------------------------------------------------------
if [[ "$FORCE" == "true" && "$SKIPPED_COUNT" -gt 0 ]]; then
  actor=$(gh api user --jq '.login' 2>/dev/null || echo "unknown")
  override_body="## Merge Gate Override

**Actor:** \`$actor\`
**Reason:** $FORCE_REASON
**Head SHA:** \`$head_sha\`
**Gates skipped ($SKIPPED_COUNT):**
$SKIPPED_GATES
_Posted by scripts/merge-pr.sh --force before merging (GH-1589)._"
  gh pr comment "$PR_NUMBER" --body "$override_body" >/dev/null 2>&1 \
    || echo "MERGE GATE WARN — force: failed to post override comment (continuing)"
fi

echo "MERGE GATE PASS — PR #$PR_NUMBER @ ${head_sha:0:8} (attestation=$ATTESTATION_REQUIRED external=$EXTERNAL_REQUIRED exempt=$EXEMPT force=$FORCE)"

# ---------------------------------------------------------------------------
# Worktree cleanup (pre-merge so --delete-branch succeeds)
# ---------------------------------------------------------------------------
if [[ -z "$WORKTREE_ID" ]]; then
  HEAD_BRANCH=$(gh pr view "$PR_NUMBER" --json headRefName --jq '.headRefName' 2>/dev/null || echo "")
  if [[ "$HEAD_BRANCH" == feature/GH-* ]]; then
    WORKTREE_ID="${HEAD_BRANCH#feature/}"
  fi
fi

if [[ -n "$WORKTREE_ID" ]]; then
  for base in "worktrees" ".claude/worktrees"; do
    WORKTREE_PATH="$PROJECT_ROOT/$base/$WORKTREE_ID"
    if [[ -d "$WORKTREE_PATH" ]]; then
      echo "Removing worktree: $WORKTREE_PATH"
      cd "$PROJECT_ROOT"
      git worktree remove "$WORKTREE_PATH" --force 2>/dev/null || {
        echo "Warning: git worktree remove failed, forcing cleanup" >&2
        rm -rf "$WORKTREE_PATH"
        git worktree prune
      }
      echo "Worktree removed: $WORKTREE_ID"
    fi
  done
fi

# ---------------------------------------------------------------------------
# Merge — pinned to the gated head SHA so a push landing during the gate
# window cannot merge an unreviewed commit (TOCTOU; CodeRabbit finding).
# ---------------------------------------------------------------------------
echo "Merging PR #$PR_NUMBER @ ${head_sha:0:8}..."
gh pr merge "$PR_NUMBER" --merge --delete-branch --match-head-commit "$head_sha"

echo "PR #$PR_NUMBER merged successfully."
