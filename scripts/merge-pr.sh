#!/bin/bash
# Merge a PR through verification gates, with deterministic worktree cleanup.
#
# Usage: ./scripts/merge-pr.sh PR_NUMBER [WORKTREE_ID] [--force "reason"] [--dry-run]
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
#   3. All CI checks green. A `fail`/`cancel` bucket BLOCKS (verdict); a
#      `pending` bucket is PENDING (exit 75) — still building is not red.
#      The `ralph-attestation` status context is EXCLUDED here — this script
#      validates the attestation comment directly (gate 4); the commit status
#      is the server-side backstop published by validate-attestation.yml.
#      Zero checks reported → loud warn, continue (CI-less-repo portability).
#   4. Attestation comment (<!-- ralph-attestation:v1 -->) present, JSON-valid,
#      head_sha == current PR head, non-empty tests[] all exit_code 0, review
#      verdict present. Skipped for policy-exempt authors (bots).
#   5. External review evidence by the policy bot exists AT THE CURRENT HEAD:
#      either a non-DISMISSED review object whose commit_id == head_sha, or a
#      bot-authored issue comment containing "Reviewed commit <short-sha>".
#      No evidence at this head is
#      PENDING (exit 75), never FAIL: gate 1 already caught CHANGES_REQUESTED,
#      so its absence is "not yet", not "no". Skipped for exempt authors.
#   6. Apply-keyword hygiene (scripts/apply-keywords.sh, GH-1694): no closing
#      keyword may bind an apply-kind issue, and an infra-touching PR may not
#      close a ship issue that has no apply twin. Inert unless the repo opted
#      in via the policy file's `apply` block, and skipped entirely in host
#      repos that do not ship the checker.
#
# Policy: .github/ralph-merge-policy.json (override path for tests via
# RALPH_MERGE_POLICY_FILE). NO policy file → gates 4-5 off (repo hasn't
# opted in); gates 0-3 always apply.
#
# --force "reason": skips gates 2 (UNKNOWN only), 3, 4, 5 — never gate 1 —
# and posts a "## Merge Gate Override" comment on the PR (reason, actor,
# skipped gates, head sha) BEFORE merging. Loud and durable, never silent.
#
# --dry-run (GH-1712, D8): evaluate every gate exactly as the merge path
# does — same tokens, same exit codes (0/1/75) — then stop. No merge, no
# worktree cleanup, no comment, no mutation of any kind. This is the single
# source of truth for "is this PR mergeable and why not"; selectors and
# skills read it rather than re-implementing gate logic. One sanctioned
# divergence: gate 2 makes a single attempt with no retry sleep, and
# mergeable UNKNOWN maps to PENDING — mergeable (the merge path retries
# once, then soft-gates). Mutually exclusive with --force: a dry run of an
# override is not a meaningful question.
#
# Output contract (loop-runners grep these):
#   MERGE GATE PASS            — all gates satisfied (or force-skipped)   [0]
#   MERGE GATE WARN — ...      — non-blocking anomaly (e.g. zero checks)
#   MERGE GATE PENDING — g: .. — evidence not in YET; retry later         [75]
#   MERGE GATE FAIL — g: ...   — first failing gate, machine-parseable    [1]
#   MERGE BLOCKED — ...        — legacy token, emitted alongside FAIL
#
# PENDING vs FAIL matters to unattended runners: exit 1 means stop and get a
# human, exit 75 means come back later with the work still claimed. Do not
# collapse them.
#
# Caveat: attestation lookup reads the PR comment list via `gh pr view
# --json comments` (first ~100 comments). Attestations are posted at
# close-out so `last` matching is correct in practice.

set -euo pipefail

usage() {
  echo "Usage: $0 PR_NUMBER [WORKTREE_ID] [--force \"reason\"] [--dry-run]" >&2
  exit 1
}

PR_NUMBER=""
WORKTREE_ID=""
FORCE=false
FORCE_REASON=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
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

if [[ "$DRY_RUN" == "true" && "$FORCE" == "true" ]]; then
  echo "MERGE GATE FAIL — args: --dry-run and --force are mutually exclusive" >&2
  exit 1
fi

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [[ -z "$PROJECT_ROOT" ]]; then
  echo "Error: Not in a git repository" >&2
  exit 1
fi

POLICY_FILE="${RALPH_MERGE_POLICY_FILE:-$PROJECT_ROOT/.github/ralph-merge-policy.json}"

# Gate-skip accumulator for --force (bash-3.2-safe counter + newline list).
SKIPPED_GATES=""
SKIPPED_COUNT=0

# Retry-able outcome. Distinct from FAIL: nothing is wrong, the evidence just
# isn't in yet (CI still building, reviewer hasn't looked at this head). A
# loop-runner must NOT treat 75 as a verdict — leave the work claimed and come
# back. 75 is EX_TEMPFAIL from sysexits(3).
PENDING_EXIT=75

block() { # block <gate> <detail>  — hard stop (or force-skip when allowed)
  echo "MERGE GATE FAIL — $1: $2"
  echo "MERGE BLOCKED — $2"
  exit 1
}

pending() { # pending <gate> <detail> — retry-able, not a verdict
  echo "MERGE GATE PENDING — $1: $2"
  exit "$PENDING_EXIT"
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
EXTERNAL_BOT="chatgpt-codex-connector[bot]"
EXTERNAL_TRIGGER="@codex review"
if [[ -f "$POLICY_FILE" ]]; then
  # Fail CLOSED on a malformed policy file — a truncated/corrupt policy must
  # not silently disable the evidence gates (CodeRabbit finding, PR #1602).
  if ! jq -e . "$POLICY_FILE" >/dev/null 2>&1; then
    block "policy" "merge policy file is not valid JSON: $POLICY_FILE"
  fi
  ATTESTATION_REQUIRED=$(jq -r '.attestation.required // false | tostring' "$POLICY_FILE")
  EXTERNAL_REQUIRED=$(jq -r '.external_review.required // false | tostring' "$POLICY_FILE")
  EXTERNAL_BOT=$(jq -r '.external_review.bot // "chatgpt-codex-connector[bot]"' "$POLICY_FILE")
  EXTERNAL_TRIGGER=$(jq -r '.external_review.trigger // "@codex review"' "$POLICY_FILE")
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
# Dry-run divergence (the one sanctioned one, GH-1712 D8): a selector probing
# many PRs cannot afford a 5s sleep per UNKNOWN, and "GitHub hasn't computed
# mergeability yet" is evidence-not-in-yet, not a verdict — so dry-run makes a
# single attempt and maps UNKNOWN to PENDING. The merge path keeps its
# retry-then-soft-gate shape unchanged.
if [[ "$mergeable" == "UNKNOWN" && "$DRY_RUN" != "true" ]]; then
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
    if [[ "$DRY_RUN" == "true" ]]; then
      pending "mergeable" "mergeable status is ${mergeable:-empty} (not yet computed)"
    else
      soft_gate "mergeable" "mergeable status is ${mergeable:-empty} after retry"
    fi
    ;;
esac

# ---------------------------------------------------------------------------
# Gate 3: CI checks green
# ---------------------------------------------------------------------------
# `description` is fetched here (not just name/bucket) so gate 5 can read the
# external reviewer's own status line without a second API call.
checks_json=$(gh pr checks "$PR_NUMBER" --json name,bucket,description 2>/dev/null || true)
if [[ -z "$checks_json" ]] || ! jq -e . >/dev/null 2>&1 <<<"$checks_json"; then
  checks_json="[]"
fi
checks_total=$(jq 'length' <<<"$checks_json")
if [[ "$checks_total" -eq 0 ]]; then
  echo "MERGE GATE WARN — checks: no CI checks reported on PR #$PR_NUMBER (continuing)"
else
  # Red and still-building are different facts. Red is a verdict; building is
  # a wait. Collapsing them made a loop-runner abandon PRs whose CI simply
  # hadn't finished.
  red=$(jq -r '
    [.[] | select(.name != "ralph-attestation")
         | select(.bucket == "fail" or .bucket == "cancel")]
    | map("\(.name)=\(.bucket)") | join(", ")
  ' <<<"$checks_json")
  waiting=$(jq -r '
    [.[] | select(.name != "ralph-attestation")
         | select(.bucket == "pending")]
    | map(.name) | join(", ")
  ' <<<"$checks_json")
  if [[ -n "$red" ]]; then
    soft_gate "checks" "not green: $red"
  elif [[ -n "$waiting" ]]; then
    if [[ "$FORCE" == "true" ]]; then
      soft_gate "checks" "still running: $waiting"
    else
      pending "checks" "still running: $waiting"
    fi
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
  # Head-bound, exactly like the attestation gate: a review of an earlier SHA
  # is not a review of what we are about to merge. This is what makes
  # `auto_incremental_review: false` safe — without it, review SHA A then push
  # SHA B and the gate still passes on stale evidence. (dismiss_stale_reviews_
  # on_push resets reviewDecision but leaves the review object, which is what
  # this counts.) DISMISSED reviews are excluded — PR #1685's only review was
  # DISMISSED and satisfied this gate under the old presence-only check.
  #
  # Normalize the bot name in bash: `gh api --jq` has no --arg, so the jq
  # program is interpolated and a literal comparand keeps it readable.
  # Values are BOUND via --arg, never interpolated into the filter text: the
  # bot name comes from the policy file and would otherwise be jq injection
  # (CodeRabbit finding, PR #1689). That rules out `gh api --jq`, which has no
  # --arg — hence the pipe. `-s` slurps the paginated pages into an array of
  # arrays; `add[]?` flattens them and tolerates zero pages.
  ext_count=$(gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER/reviews" --paginate 2>/dev/null \
    | jq -s --arg bot "$EXTERNAL_BOT" --arg sha "$head_sha" '
        def norm: sub("^app/"; "") | sub("\\[bot\\]$"; "");
        [ add[]?
          | select(((.user.login // "") | norm) == ($bot | norm))
          | select(.state != "DISMISSED")
          | select(.commit_id == $sha)
        ] | length' 2>/dev/null || echo "0")
  # Codex emits a review object when it finds something. A clean review has no
  # review object; the connector instead leaves an issue comment naming the
  # reviewed short SHA. Both shapes must be bot-authored and head-bound.
  head_short=${head_sha:0:7}
  ext_comment_count=$(gh api "repos/{owner}/{repo}/issues/$PR_NUMBER/comments" --paginate 2>/dev/null \
    | jq -s --arg bot "$EXTERNAL_BOT" --arg short "$head_short" '
        def norm: sub("^app/"; "") | sub("\\[bot\\]$"; "");
        [ add[]?
          | select(((.user.login // "") | norm) == ($bot | norm))
          # Require the short SHA to end at a non-hex boundary. Without this,
          # a stale longer SHA sharing the current head prefix could count.
          | select((.body // "") | test("Reviewed commit " + $short + "([^0-9A-Fa-f]|$)"))
        ] | length' 2>/dev/null || echo "0")
  if [[ "${ext_count:-0}" -eq 0 && "${ext_comment_count:-0}" -eq 0 ]]; then
    if [[ "$FORCE" == "true" ]]; then
      soft_gate "external-review" "no current $EXTERNAL_BOT review at head ${head_sha:0:8}"
    else
      # Gate 1 already caught CHANGES_REQUESTED, so "no review at this head"
      # is never a negative verdict — it is "not yet". Retry-able.
      #
      # Naming WHY costs nothing here: a rate-limited reviewer publishes a
      # check whose STATE is success but whose DESCRIPTION says so ("Review
      # rate limited"). Read the description, never the state. Deliberately
      # NOT the bot's rate-limit PR comment — that comment persists after the
      # review eventually lands, so it would mislabel every later wait; the
      # check is bound to this head and cannot go stale. Matched on the
      # description rather than a hardcoded check name so it stays
      # bot-agnostic: check-run names need not equal the configured bot login.
      rl_checks=$(jq -r '
        [.[] | select(((.description // "") | ascii_downcase) | contains("rate limit"))]
        | map(.name) | join(", ")
      ' <<<"$checks_json" 2>/dev/null || echo "")
      if [[ -n "$rl_checks" ]]; then
        pending "external-review" "$EXTERNAL_BOT is rate-limited and filed no review evidence (per its own '$rl_checks' check) — retry after the window, or comment '$EXTERNAL_TRIGGER'"
      fi
      pending "external-review" "no $EXTERNAL_BOT review evidence at head ${head_sha:0:8} yet — comment '$EXTERNAL_TRIGGER' to trigger one"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Gate 6: apply-keyword hygiene + infra-split (GH-1694)
# ---------------------------------------------------------------------------
# A merged PR is not a deployed change. This refuses a PR whose closing
# keywords bind an apply-kind issue, and an infra-touching PR that closes a
# ship issue with no apply twin. Fully inert unless the repo opted in via the
# `apply` block of the policy file — including in host repos that vendor
# merge-pr.sh without the checker script at all.
#
# soft_gate, not a hard block: every other evidence gate here is forceable
# with the loud `--force` override comment, and a special case would be
# inconsistent. Gate 1 (CHANGES_REQUESTED) remains the only unforceable one.
# Test-only override, same pattern as RALPH_MERGE_POLICY_FILE / RALPH_WORKTREE_ROOT.
APPLY_KEYWORDS_SH="${RALPH_APPLY_KEYWORDS_SH:-$PROJECT_ROOT/scripts/apply-keywords.sh}"
if [[ -x "$APPLY_KEYWORDS_SH" ]]; then
  # Captured, not streamed: the first line is the verdict a runner greps for,
  # and the remaining lines are the operator's remedy.
  set +e
  apply_out=$("$APPLY_KEYWORDS_SH" "$PR_NUMBER" 2>&1)
  apply_rc=$?
  set -e
  echo "$apply_out"
  if [[ "$apply_rc" -ne 0 ]]; then
    soft_gate "apply-keywords" "$(head -1 <<<"$apply_out")"
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

# Dry run stops here: gates evaluated, verdict emitted, nothing touched.
# Everything below this line mutates (worktree removal, the merge itself).
if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry run: no merge attempted."
  exit 0
fi

# ---------------------------------------------------------------------------
# Worktree cleanup (pre-merge so --delete-branch succeeds)
# ---------------------------------------------------------------------------
if [[ -z "$WORKTREE_ID" ]]; then
  HEAD_BRANCH=$(gh pr view "$PR_NUMBER" --json headRefName --jq '.headRefName' 2>/dev/null || echo "")
  # Any branch, not just feature/GH-*: the worktree dir is the branch's last
  # path segment, which covers feature/GH-1234 -> GH-1234 and claude/foo -> foo
  # alike. Non-feature branches were silently never cleaned up before.
  WORKTREE_ID="${HEAD_BRANCH##*/}"
fi

# Reject anything that could escape the worktree bases. WORKTREE_ID reaches
# `rm -rf` below, so this is load-bearing, not hygiene.
case "$WORKTREE_ID" in
  "" | . | .. | *[/\\]* ) WORKTREE_ID="" ;;
esac

if [[ -n "$WORKTREE_ID" ]]; then
  # Worktree dirs live under the MAIN checkout. $PROJECT_ROOT is
  # `--show-toplevel`, which inside a worktree is THAT WORKTREE — so the old
  # code looked for <job-worktree>/.claude/worktrees/<id> and found nothing.
  # In the worktree-per-job flow (tick.sh) that is every run, so cleanup was
  # dead, not merely limited to feature/ branches. --git-common-dir resolves
  # to the main .git regardless of which worktree we are in.
  # `-C "$PROJECT_ROOT"` is load-bearing: --git-common-dir returns a path
  # relative to the CWD, so running from a subdirectory yields "../.git" and
  # resolving that against $PROJECT_ROOT lands OUTSIDE the repository — which
  # is where `rm -rf` below would then point (CodeRabbit finding, PR #1690).
  git_common=$(git -C "$PROJECT_ROOT" rev-parse --git-common-dir 2>/dev/null || echo "")
  case "$git_common" in
    "") git_common="$PROJECT_ROOT/.git" ;;
    /*) ;;
    *)  git_common="$PROJECT_ROOT/$git_common" ;;
  esac
  MAIN_ROOT=$(cd "$(dirname "$git_common")" 2>/dev/null && pwd) || MAIN_ROOT="$PROJECT_ROOT"
  # Test-only override, same pattern as RALPH_MERGE_POLICY_FILE.
  WORKTREE_ROOT="${RALPH_WORKTREE_ROOT:-$MAIN_ROOT}"

  for base in "worktrees" ".claude/worktrees"; do
    WORKTREE_PATH="$WORKTREE_ROOT/$base/$WORKTREE_ID"
    if [[ -d "$WORKTREE_PATH" ]]; then
      # NEVER remove the tree we are running from. The fallback below is
      # `rm -rf`, which would delete this script's own checkout mid-run. The
      # old feature/GH-* narrowness hid this by accident; generalizing the
      # match removes that accident, so the guard has to be explicit.
      wt_real=$(cd "$WORKTREE_PATH" 2>/dev/null && pwd -P) || wt_real="$WORKTREE_PATH"
      here_real=$(pwd -P)
      root_real=$(cd "$PROJECT_ROOT" 2>/dev/null && pwd -P) || root_real="$PROJECT_ROOT"
      if [[ "$root_real" == "$wt_real" || "$here_real" == "$wt_real" || "$here_real" == "$wt_real"/* ]]; then
        echo "Skipping worktree cleanup: $WORKTREE_PATH is the current working tree"
        continue
      fi
      echo "Removing worktree: $WORKTREE_PATH"
      # Best-effort, and deliberately non-fatal: this runs BEFORE the merge, so
      # a housekeeping failure must never abort it (a bare `git worktree prune`
      # in a non-repo cwd used to exit 128 under `set -e`). Uses `git -C`
      # rather than `cd` so gh keeps its repo context for the merge below.
      git -C "$WORKTREE_ROOT" worktree remove "$WORKTREE_PATH" --force 2>/dev/null || {
        echo "Warning: git worktree remove failed, forcing cleanup" >&2
        rm -rf "$WORKTREE_PATH" || true
        git -C "$WORKTREE_ROOT" worktree prune 2>/dev/null || true
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
# `--delete-branch` merges remotely, then attempts LOCAL cleanup (checkout of
# main + branch delete). In a worktree layout that cleanup fails ("'main' is
# already used by worktree ...") and gh exits nonzero AFTER the merge already
# succeeded — a false negative (GH-1677). The PR's actual state is the truth:
# on a nonzero exit, re-query it before declaring failure.
if ! gh pr merge "$PR_NUMBER" --merge --delete-branch --match-head-commit "$head_sha"; then
  merged_state=$(gh pr view "$PR_NUMBER" --json state --jq .state 2>/dev/null || echo "UNKNOWN")
  if [ "$merged_state" = "MERGED" ]; then
    echo "PR #$PR_NUMBER merged successfully (local branch cleanup skipped — main is checked out in another worktree)."
    exit 0
  fi
  echo "MERGE FAILED — gh pr merge exited nonzero and PR #$PR_NUMBER state is $merged_state, not MERGED." >&2
  exit 1
fi

echo "PR #$PR_NUMBER merged successfully."
