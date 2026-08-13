#!/usr/bin/env bash
# pr-gate-watch — answer exactly one question about a PR: whose turn is it?
#
# Why this exists: on a repo running the GH-1589 merge gate,
#   until ! gh pr checks PR | grep -q pending; do sleep 30; done
# can never terminate. `ralph-attestation` is published as a pending status
# and stays pending until someone runs scripts/attest-pr.sh — the check is
# waiting on *you*. So the loop sits armed forever, and its silence is
# indistinguishable from "CI is still running". Observed repeatedly, most
# recently on PR #1740 (green for ~1h; the watcher never fired).
#
# The second false signal is subtler and points the other way: a
# rate-limited CodeRabbit check reports bucket=pass with description
# "Review rate limited" and reviews nothing. So "every check is green" is
# *also* not merge-ready — merge-pr.sh requires an external review, and
# attest-pr.sh hard-refuses with "no prior review".
#
# Verdicts, in precedence order — the actionable one always wins:
#
#   GATE-DONE               PR no longer open; nothing to wait for   exit 0
#   GATE-FAIL policy        merge policy is unreadable/half-configured  exit 0
#   GATE-FAIL ci            check failed/cancelled                   exit 0
#   GATE-FAIL attestation   the attestation status itself is red     exit 0
#   GATE-FAIL review        CHANGES_REQUESTED is live                exit 0
#   GATE-FAIL merge         head CONFLICTING — rebase                exit 0
#   GATE-FAIL apply         gate 6 (apply-keywords.sh, RUN live) rejects exit 0
#   GATE-WAIT ci            non-attestation checks still running     exit 10
#   GATE-YOURS review       no verdict AND the reviewer needs a nudge  exit 0
#   GATE-WAIT review        reviewer simply has not posted yet        exit 10
#   GATE-WAIT attestation   attested at this head; validator running  exit 10
#   GATE-YOURS attestation  everything else green; attestation left   exit 0
#   GATE-WAIT merge         GitHub has not computed mergeability yet  exit 10
#   GATE-READY              green + reviewed + attested → merge       exit 0
#
# GATE-YOURS review outranks GATE-YOURS attestation deliberately:
# attest-pr.sh refuses when no review verdict exists, so reporting
# attestation first would send the caller into a guaranteed failure.
#
# Review identity comes from the REST reviews endpoint, not `gh pr view
# --json reviews`: the GraphQL shape omits the review URL and strips the
# `[bot]` suffix from bot logins, and both are needed verbatim for
# attest-pr.sh's --reviewer/--review-url. Same reason gate 5 of merge-pr.sh
# reads REST. Whether a CHANGES_REQUESTED is still *live* is taken from
# GitHub's own reviewDecision, which accounts for dismissals.
#
# What counts as review evidence is READ FROM THE MERGE POLICY, in the same
# two modes scripts/merge-pr.sh gate 5 and scripts/validate-attestation.sh
# derive (PR #1839) — never invented here:
#
#   review  — a formal APPROVED review by the policy bot at the CURRENT head.
#             The default, so a policy that names no markers behaves exactly
#             as it did before comment mode existed.
#   comment — opted into by naming BOTH head_marker and clean_comment_marker:
#             a head-bound review request followed by the bot's clean-result
#             comment. Reviewers like Codex signal "clean" this way and never
#             file an APPROVED review, so under `review` mode a clean result
#             is invisible and the watcher would wait forever.
#
# This classifier must never be a SECOND reader of the same evidence with its
# own opinion: a watcher that says "wait for review" while the gate says PASS
# (or the reverse) is worse than no watcher. The derivation, the marker names,
# the norm() login rule, the ordering rule and the findings-after-clean
# override below are all mirrors of gate 5 and must be changed with it.
#
# Three further things the gate knows and this script now reads:
#   - Policy-EXEMPT authors (bots) waive attestation and external review
#     entirely, so demanding a review of them can only produce a permanent
#     GATE-WAIT.
#   - A failed/cancelled ATTESTATION status is a gate failure. It is excluded
#     from the CI bucket only so its *pending* state can be classified
#     separately; excluding its failures too would let a red required status
#     fall through to GATE-READY.
#   - Mergeability. GATE-READY recommends `merge-pr.sh`, which stops at gate 2
#     on a CONFLICTING head, so declaring ready there ends the watch on a
#     recommendation that cannot succeed.
#
# Usage:
#   scripts/pr-gate-watch.sh PR              one-shot; prints one verdict line
#   scripts/pr-gate-watch.sh PR --watch      poll; one line per state CHANGE,
#                                            exits on the first terminal verdict
#
# Exit codes: 0 terminal verdict, 10 still waiting, 2 usage, 1 gh unreachable.
#
# The attestation status is `ralph-attestation`, hardcoded, because gate 3
# hardcodes it. Renaming it is a change to the gate, not to this script.
#
# Honest limit: the attested-at-this-head check reads `gh pr view --json
# comments`, so on a PR with more comments than that window returns, the
# attestation comment can fall outside it and the verdict reverts to
# GATE-YOURS attestation. That errs in the safe direction — attest-pr.sh
# updates its existing comment rather than duplicating it, so acting on the
# stale verdict is idempotent. validate-attestation.sh reads the same window.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: pr-gate-watch.sh PR_NUMBER [--watch] [--interval SECONDS]

  --watch             poll until a terminal verdict; print each state change
  --interval SECONDS  poll interval in --watch mode (default 30)

Verdicts: GATE-READY | GATE-YOURS | GATE-WAIT | GATE-FAIL | GATE-DONE
Exit: 0 terminal, 10 still waiting, 2 usage error.
EOF
}

PR=""
WATCH=false
INTERVAL=30

while [ $# -gt 0 ]; do
  case "$1" in
    --watch) WATCH=true; shift ;;
    --interval)
      INTERVAL="${2:-}"
      [ -n "$INTERVAL" ] || { echo "--interval needs a value" >&2; exit 2; }
      shift 2
      ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; usage >&2; exit 2 ;;
    *)
      [ -z "$PR" ] || { echo "unexpected argument: $1" >&2; exit 2; }
      PR="$1"
      shift
      ;;
  esac
done

[ -n "$PR" ] || { usage >&2; exit 2; }
case "$PR" in
  '' | *[!0-9]*) echo "PR must be a number, got: $PR" >&2; exit 2 ;;
esac
case "$INTERVAL" in
  '' | *[!0-9]*) echo "--interval must be a number, got: $INTERVAL" >&2; exit 2 ;;
esac
# `sleep 0` returns immediately, so --interval 0 is not a fast poll, it is an
# unthrottled loop over every GitHub endpoint until something rate-limits it
# (codex P2, PR #1764). Rejected rather than clamped: a caller who typed 0
# meant something, and silently substituting 30 would hide that.
if [ "$INTERVAL" -eq 0 ]; then
  echo "--interval must be greater than 0 (0 would poll without delay)" >&2
  exit 2
fi

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# Same resolution and same test-only override as scripts/merge-pr.sh — the
# whole point is to read the identical file the gate reads.
POLICY_FILE="${RALPH_MERGE_POLICY_FILE:-$PROJECT_ROOT/.github/ralph-merge-policy.json}"

# POLICY is the one object handed to jq. No policy file at all → gates 4-5 are
# off in merge-pr.sh, so external review is not required here either.
POLICY='{"attestationRequired":false,"externalRequired":false,"bot":"","trigger":"","headMarker":"","cleanMarker":"","mode":"review","exemptAuthors":[]}'
POLICY_ERROR=""
if [ -f "$POLICY_FILE" ]; then
  if ! jq -e . "$POLICY_FILE" >/dev/null 2>&1; then
    # Fail CLOSED, like merge-pr.sh: a corrupt policy must not read as
    # "no external review required" and green-light a merge.
    POLICY_ERROR="merge policy file is not valid JSON: $POLICY_FILE"
  else
    POLICY=$(jq -c '{
      attestationRequired: (.attestation.required // false),
      externalRequired: (.external_review.required // false),
      bot:             (.external_review.bot // "chatgpt-codex-connector[bot]"),
      trigger:         (.external_review.trigger // "@codex review"),
      headMarker:      (.external_review.head_marker // ""),
      cleanMarker:     (.external_review.clean_comment_marker // ""),
      exemptAuthors:   (.exempt_authors // [])
    }
    # Mode derivation, byte-for-byte the rule in merge-pr.sh and
    # validate-attestation.sh: BOTH markers → comment, neither → review,
    # exactly one → unsatisfiable, and named rather than guessed at.
    | .mode = (if (.headMarker != "" and .cleanMarker != "") then "comment"
               elif (.headMarker != "" or .cleanMarker != "") then "half"
               else "review" end)' "$POLICY_FILE")
    if [ "$(jq -r '.mode' <<<"$POLICY")" = "half" ]; then
      POLICY_ERROR="external_review declares only one of head_marker/clean_comment_marker — comment-evidence mode needs both"
    fi
  fi
fi
POLICY_MODE=$(jq -r '.mode' <<<"$POLICY")
POLICY_EXTERNAL=$(jq -r '.externalRequired | tostring' <<<"$POLICY")

# Test-only override, same pattern merge-pr.sh gate 6 uses.
APPLY_KEYWORDS_SH="${RALPH_APPLY_KEYWORDS_SH:-$PROJECT_ROOT/scripts/apply-keywords.sh}"

# The literal, matching gate 3's hardcoded `ralph-attestation` comparison
# (merge-pr.sh:287-295) exactly. There WAS a PR_GATE_ATTEST_CHECK override
# here for repos that renamed the status; it is gone, because it was a
# capability the gate does not have: with a custom name set, a failed or
# pending custom check left this script's CI bucket while gate 3 still blocked
# on it as ordinary CI, and under an attestation waiver it vanished from the
# ladder entirely (codex P2, PR #1764).
#
# Making the name configurable is a fine idea and belongs in the GATE — gate 3,
# validate-attestation.sh and this script changed together, so all three agree.
# A watcher-only override cannot be anything but a disagreement.
ATTEST_CHECK="ralph-attestation"
# Must stay in sync with MARKER in attest-pr.sh and validate-attestation.sh,
# which hardcode the same literal.
ATTEST_MARKER='<!-- ralph-attestation:v1 -->'

# The precedence ladder, as one jq program so it reads top-to-bottom in a
# single place and the shell holds no branching logic of its own. Kept in a
# quoted heredoc: the program contains single quotes, which cannot appear
# inside a single-quoted shell string.
read -r -d '' CLASSIFY_JQ <<'JQ' || true
# The attestation status is identified by NAME ONLY, which is how gate 3
# identifies it (an exact `ralph-attestation` comparison, merge-pr.sh:287-295).
# There used to be a description fallback matching /attest-pr\.sh/ as a
# convenience for repos that renamed the status. It is gone, because it made
# this script disagree with gate 3 about which checks are CI: a failed check
# whose description merely MENTIONS attest-pr.sh left the CI bucket here while
# gate 3 still blocked on it, and under an attestation waiver it then vanished
# from the ladder entirely and reached GATE-READY (codex P2, PR #1764).
# Renaming the status is a change to the gate (gate 3 + validate-attestation
# + this script together), not something this script can absorb alone.
def is_attest: .name == $attest;
# Login normalization, identical to gate 5: GitHub spells the same identity
# "codex[bot]" via REST and "app/codex" in some payloads.
def norm: sub("^app/"; "") | sub("\\[bot\\]$"; "");
# The attestation payload, extracted the way gate 4 extracts it
# (merge-pr.sh:319-321, an awk with both fences anchored to their own lines).
# `split("```json")` accepted an INLINE fence anywhere in the body, so a
# comment gate 4 calls unparseable could read as valid here and produce
# GATE-READY into a merge that immediately rejects it (codex P2, PR #1764).
# No closing fence means "to the end", which is what the awk does too.
def fenced_json:
  (. / "\n") as $lines
  | ($lines | map(test("^```json[[:space:]]*$")) | index(true)) as $start
  | if $start == null then null
    else ($lines[($start + 1):]) as $rest
      | ($rest | map(test("^```[[:space:]]*$")) | index(true)) as $end
      | (if $end == null then $rest else $rest[0:$end] end | join("\n"))
    end;

($checks // [])                                        as $all
| ($all | map(select(is_attest)))                       as $att
# The attestation status is separated from CI so its PENDING state can be
# classified as "your turn" rather than "still running". Its FAILURES belong
# with everything else that is red: a malformed attestation JSON or a
# non-zero recorded test makes the required status fail, and routing it
# through $rest would have made it neither failed nor pending — invisible,
# and an approved PR would reach GATE-READY with a red required status
# (codex P2, PR #1764).
# Gate 3 excludes only the EXACT `ralph-attestation` name from its red and
# waiting lists. `is_attest` is deliberately broader (it also matches the
# attest-pr.sh description, which is how a RENAMED status is still recognized
# as the attestation) — but using the broad match here removed a failed check
# from the CI bucket that gate 3 still blocks on, and if attestation was
# waived $att_bad ignored it too, so it vanished entirely and reached
# GATE-READY (codex P2, PR #1764). The narrow rule belongs to the CI buckets;
# the broad one stays where it earns its keep, identifying the status to
# WAIT on.
| ($all | map(select(.name != $attest)))                as $ci
| ($ci   | map(select(.bucket == "fail" or .bucket == "cancel"))) as $bad
| ($att  | map(select(.bucket == "fail" or .bucket == "cancel"))) as $att_bad
| ($ci   | map(select(.bucket == "pending")))           as $running
| ($att  | map(select(.bucket == "pending")))           as $att_pending
# A rate-limited reviewer check PASSES but reviews nothing — the one case
# where an all-green board still needs a human nudge to make progress. Only
# CodeRabbit is known to publish its rate-limit in the check DESCRIPTION,
# which is why the name test is literal rather than policy-derived.
| ($all | map(select(
    ((.name // "") | test("coderabbit"; "i")) and
    ((.description // "") | test("rate limit"; "i"))
  )))                                                   as $ratelimited
| ($ratelimited | map(.name) | join(", "))              as $rl_names
# --- review evidence, exactly as merge-pr.sh gate 5 counts it ---------------
# Head binding is the whole point. REST KEEPS review objects across a push
# (only reviewDecision resets), so an unfiltered `.state == "APPROVED"` counts
# an approval of code that is no longer on the branch — and reports
# GATE-YOURS attestation while the gate is still stuck at gate 5 waiting for a
# review of the CURRENT head (codex P2, PR #1764). Reviews by identities the
# policy did not name are likewise not the evidence gate 5 requires.
| ($pr.headRefOid // "")                                as $head
| (($pr.author.login // "") | norm)                     as $author
| (($policy.exemptAuthors // []) | map(norm) | index($author) != null) as $exempt
| ($policy.externalRequired == true)                    as $ext_required
# Is the rate-limited reviewer the one GATE 5 is waiting for? Nudging
# CodeRabbit on a repo whose configured reviewer is Codex answers "whose turn
# is it" with the wrong name and the wrong command — observed on this PR's own
# dogfood run. Substring either way, because a check name ("Codex") and a bot
# login ("chatgpt-codex-connector[bot]") are never equal but do contain each
# other. A heuristic, and labelled as one: getting it wrong only picks which
# of two true remedies is named first.
| (($ext_required | not) or ($ratelimited | map(
     ((.name // "") | ascii_downcase) as $n
     | (($policy.bot // "") | ascii_downcase) as $b
     | ($n != "" and (($b | contains($n)) or ($n | contains($b))))
   ) | any))                                             as $rl_is_reviewer
# When the policy names a reviewer, only that reviewer's verdicts are gate
# evidence. With no policy (or external review not required) there is no
# configured identity to filter on, so any approval counts — still head-bound.
| ($reviews | map(select(
    ($ext_required | not) or (((.user.login // "") | norm) == (($policy.bot // "") | norm))
  )))                                                   as $reviewer_reviews
| ($reviewer_reviews | map(select(
    (.state // "") != "DISMISSED" and ((.commit_id // "") == $head)
  )))                                                   as $at_head
| ($at_head | map(select((.state // "") == "APPROVED"))) as $approved
| ($at_head | map(select((.state // "") == "COMMENTED"))) as $commented
# Review mode satisfied = a formal APPROVED review by the policy bot at this
# head. That is gate 5 on main verbatim since PR #1839 (merged 2026-08-13):
# a COMMENTED review object is findings, not approval, and the SHA-regex
# comment path ("Reviewed commit <7-sha>") no longer exists in the gate at
# all — it was replaced by comment mode's marker protocol precisely because
# Codex's real clean body ("**Reviewed commit:** `<10-char-sha>`") could never
# match it.
#
# Codex raised both of those as findings against an EARLIER main, where gate 5
# still counted any non-DISMISSED review and still read the SHA regex. Both
# were correct then and are stale now; keeping either would make this script
# LOOSER than the gate, reporting GATE-READY into a merge that refuses. The
# one rule that survives every revision: mirror the gate as it is, and never
# hold a second opinion about the same evidence.
| (if $policy.mode == "comment" then false
   else ($approved | length) > 0 end)                    as $review_mode_ok
# comment mode: a head-bound request, then the bot's clean-result comment
# after it. Mirrors gate 5's ordering rule, including the strict `>` — GitHub
# timestamps are second-precision, so equality is ambiguous and fails closed.
| (if $policy.mode == "comment" and $ext_required then
     ([ $comments[]
        | select((.body // "") | contains($policy.trigger))
        | select((.body // "") | contains("<!-- " + $policy.headMarker + ": " + $head + " -->"))
        | .updated_at // .created_at // empty ] | max // "")
   else "" end)                                         as $request_at
| (if $request_at != "" then
     [ $comments[]
       | select(((.user.login // "") | norm) == (($policy.bot // "") | norm))
       | select((.body // "") | contains($policy.cleanMarker))
       | select((.created_at // "") > $request_at) ]
   else [] end)                                          as $clean_comments
| ($clean_comments | map(.created_at) | max // "")       as $clean_at
# A findings review filed at this head at-or-after the clean result overrides
# it: the reviewer looked again and had something to say.
| (if $clean_at != "" then
     [ $reviewer_reviews[]
       | select((.commit_id // "") == $head)
       | select((.state // "") != "DISMISSED" and (.state // "") != "APPROVED")
       | select((.submitted_at // "") == "" or (.submitted_at // "") >= $clean_at) ]
       | length
   else 0 end)                                           as $findings_after_clean
| (($clean_at != "") and $findings_after_clean == 0)      as $clean_ok
# Policy-exempt authors (bots) have attestation AND external review waived by
# both merge-pr.sh and validate-attestation.sh, so requiring a review of them
# produces a GATE-WAIT that nothing can ever clear (codex P2, PR #1764).
# `$ext_required | not` is the same waiver for the whole repo: with no policy
# file, or external_review.required false, gate 5 does not run at all, so
# demanding a review is a wait for something no gate will ever ask for.
# merge-pr.sh gate 4 runs only when attestation is required AND the author is
# not exempt, and gate 3 excludes the attestation status from the CI red list
# outright. So under a waiver there is no attestation question to answer: a
# lingering red or pending status is not a verdict about this PR at all
# (codex P2, PR #1764).
| ($policy.attestationRequired and ($exempt | not))      as $attest_required
# Evidence is judged by MODE, never pooled. `($approved | length) > 0` used to
# sit here as an extra disjunct, which leaked formal approvals into comment
# mode — where gate 5 ignores them entirely and stays pending, so the watcher
# would move on to attestation and eventually recommend a merge that refuses
# (codex P2, PR #1764). `$review_mode_ok` already carries the approval for
# review mode, and `$clean_ok` is comment mode's only evidence; the pooled
# term could therefore never add anything except the disagreement.
| (($ext_required | not) or $exempt
   or (if $policy.mode == "comment" then $clean_ok else $review_mode_ok end)) as $review_ok
# The reviewer handed back for the attest command comes from the evidence the
# ACTIVE mode accepts, so comment mode never names an approver gate 5 ignored.
| (if $policy.mode == "comment" then
     (if ($clean_comments | length) > 0 then ($clean_comments | last)
      else ($at_head | last) end)
   elif ($approved | length) > 0 then ($approved | last)
   else ($at_head | last) end)                           as $verdict
# Findings at this head that nothing has answered yet. This is a NUDGE, not a
# gate: gate 5 accepts the review above, so the only thing left to say is
# "adjudicate before you attest" — and once a current attestation exists that
# advice is spent, which is what keeps it from becoming a permanent verdict.
# Subject to the SAME waivers as the review question it is a nudge about: with
# gate 5 off, or an exempt author, no approval is required, so asking for one
# terminates --watch on a request the merge will never make. The earlier
# waiver fixes covered $review_ok; this branch is reached independently of it
# whenever attestation is also waived (codex P2, PR #1764).
| ($ext_required and ($exempt | not)
   and ($commented | length) > 0 and ($approved | length) == 0
   and ($clean_ok | not))                                as $unanswered_findings
| ($att_pending | map(.name) | join(", "))              as $att_names
# Is there already an attestation for the CURRENT head? The status stays
# pending for the minute or two validate-attestation.yml takes to recompute,
# and during that window the next move is to wait, not to attest again. The
# same comparison covers the other direction: after a new push the recorded
# sha no longer matches, so re-attesting is correctly demanded.
| (($pr.comments // [])
   | map(select(.body | contains($marker)))
   | last | (.body // "")
   | (try (fenced_json | fromjson) catch null))          as $att_json
| (($att_json.head_sha // ""))                          as $attested_sha
# The WHOLE payload, not just the sha. Gate 4 re-reads the live comment and
# checks three things, and an edit can preserve head_sha while breaking either
# of the others — so a sha-only check calls a rejected attestation valid and
# ends --watch on a merge that fails immediately (codex P2, PR #1764).
# Mirrors merge-pr.sh:323-335 term for term, including `tests` being non-empty
# (an attestation with no test evidence is not evidence) and the verdict being
# exactly APPROVED (an honest REJECTED is evidence AGAINST merging, so
# presence alone must not satisfy it).
| ((($att_json.tests // []) | (length > 0) and all(.exit_code == 0))) as $att_tests_ok
| (($att_json.review.verdict // ""))                    as $att_verdict
| (($attested_sha != "") and ($attested_sha == ($pr.headRefOid // ""))
   and $att_tests_ok and ($att_verdict == "APPROVED"))   as $attested_current
# Attested at this head but otherwise invalid: worth naming precisely, because
# "re-attest" and "your attestation records a failing test" are different jobs.
| (($attested_sha != "") and ($attested_sha == ($pr.headRefOid // ""))
   and (($att_tests_ok | not) or ($att_verdict != "APPROVED")))
                                                        as $att_invalid_here

| if $policy_error != "" then
    "GATE-FAIL policy: \($policy_error)"
  # Evidence unavailable is a WAIT, never a verdict: gate 5 treats the same
  # partial outage as PENDING, and --watch retrying is the correct response to
  # a transient API failure. Only meaningful when a review is actually
  # required — with gate 5 off there is no evidence to have failed to read.
  elif $fetch_ok != "true" and $ext_required and ($exempt | not)
       and ($pr.state // "OPEN") == "OPEN" then
    "GATE-WAIT review: could not read review evidence for #\($num) (gh api failed) — verdict withheld rather than guessed"
  # An unreadable checks payload is the one place this script is DELIBERATELY
  # stricter than the gate, and it is worth naming rather than hiding: gate 3
  # treats an empty/unparseable payload as "no checks reported" and continues
  # with a WARN. That is defensible for a one-shot merge with an operator
  # reading the warning; it is not defensible for --watch, where emitting a
  # terminal verdict is a decision to STOP LOOKING. A wait costs one more poll
  # and self-heals; a wrong GATE-READY recommends a merge over CI nobody read
  # (codex P2, PR #1764). Non-terminal precisely so it cannot strand anyone.
  elif $checks_ok != "true" and ($pr.state // "OPEN") == "OPEN" then
    "GATE-WAIT ci: could not read the checks for #\($num) (gh pr checks returned no usable payload) — verdict withheld rather than guessed"
  elif ($pr.state // "OPEN") != "OPEN" then
    "GATE-DONE \($pr.state | ascii_downcase): PR #\($num) is not open — nothing to wait for"
  elif ($bad | length) > 0 then
    "GATE-FAIL ci: \($bad | map(.name) | join(", ")) — fix before attesting"
  elif ($att_bad | length) > 0 and $attest_required then
    "GATE-FAIL attestation: \($att_bad | map(.name) | join(", ")) is red — read the status, fix what it names, then re-run scripts/attest-pr.sh \($num)"
  elif ($pr.reviewDecision // "") == "CHANGES_REQUESTED" then
    "GATE-FAIL review: CHANGES_REQUESTED is live — adjudicate the threads, then re-attest"
  elif ($pr.mergeable // "") == "CONFLICTING" then
    "GATE-FAIL merge: head \($head[0:8]) conflicts with the base — rebase, then re-attest"
  elif ($running | length) > 0 then
    "GATE-WAIT ci: \($running | length) running (\($running | map(.name) | join(", ")))"
  elif ($review_ok | not) and ($ratelimited | length) > 0 and $rl_is_reviewer then
    # The trigger comes from the POLICY, never a literal: a host repo that
    # names a different trigger would otherwise be told to post a command its
    # reviewer does not read, and the watcher would stop on advice that cannot
    # be followed (codex P2, PR #1764). Every other review branch already
    # interpolates it; this one was the holdout.
    "GATE-YOURS review: \($rl_names) rate-limited — its check PASSES but it reviewed nothing; post `\($policy.trigger)`"
  elif $unanswered_findings and (($review_ok | not) or ($attested_current | not)) then
    (if $policy.mode == "comment" then
       # Adjudicating does not delete the COMMENTED review, and attesting does
       # not either — so $findings_after_clean stays nonzero and gate 5 keeps
       # rejecting the old clean marker. Attesting here is work that cannot
       # unblock the merge; the evidence gate 5 wants is a NEWER clean result,
       # which only a fresh head-bound request can produce (codex P2, #1764).
       "GATE-YOURS review: \($commented | length) findings review(s) at \($head[0:8]) — adjudicate the threads, then re-request: comment '\($policy.trigger)' with '<!-- \($policy.headMarker): \($head) -->' and wait for a clean result BEFORE attesting"
     else
       # Same trap as comment mode, different evidence: adjudicating threads
       # does not convert a COMMENTED review into the APPROVED object gate 5
       # requires, and neither does attesting. Only a fresh approval can, so
       # that is what this names (codex P2, PR #1764).
       "GATE-YOURS review: \($commented | length) comment-only review(s) at \($head[0:8]), no approval — adjudicate the threads, then re-request: comment '\($policy.trigger)' and wait for an APPROVED review BEFORE attesting"
     end)
  elif ($review_ok | not) then
    (if ($ratelimited | length) > 0 then
       "GATE-WAIT review: \($rl_names) reports pass but is rate-limited and reviewed nothing; gate 5 is waiting on \($policy.bot) at \($head[0:8]) — comment '\($policy.trigger)'"
     elif $policy.mode == "comment" and $request_at == "" then
       # No head-bound request exists, so gate 5 cannot accept ANY clean result
       # until someone posts one. Nothing arrives by waiting, and polling on is
       # precisely the never-terminating loop this script exists to replace, so
       # this hands control back instead (codex P2, PR #1764).
       "GATE-YOURS review: no \($policy.trigger) request bound to \($head[0:8]) — post it (the trigger, a blank line, then '<!-- \($policy.headMarker): \($head) -->') so a clean result can count"
     elif $policy.mode == "comment" then
       "GATE-WAIT review: request is in at \($head[0:8]); no clean \($policy.bot) result yet"
     elif $ext_required then
       "GATE-WAIT review: no \($policy.bot) verdict at \($head[0:8]) yet — comment '\($policy.trigger)' to trigger one"
     else
       "GATE-WAIT review: no review verdict posted yet"
     end)
  elif ($att_pending | length) > 0 and $attest_required and $attested_current then
    "GATE-WAIT attestation: attested at \($attested_sha[0:8]) — validate-attestation is recomputing \($att_names)"
  # No attestation status AT ALL under an attestation-required policy: the
  # workflow has not published it yet, Actions did not run, or the checks
  # payload was unreadable. There is nothing to wait on and nothing green to
  # believe, so falling through to GATE-READY ends --watch on a merge that
  # stops at gate 4 (codex P2, second pass on PR #1764). The attestation
  # COMMENT is the tiebreak: if one exists at this head the work is done and
  # only the status is missing, which is a wait.
  elif $attest_required and ($att | length) == 0 and $attested_current then
    "GATE-WAIT attestation: attested at \($attested_sha[0:8]) — no \($attest) status published yet"
  elif $attest_required and ($att | length) == 0 then
    "GATE-YOURS attestation: no \($attest) status on this PR and no attestation at \($head[0:8]) — bash scripts/attest-pr.sh \($num) --run \"<test cmd>\" --review-verdict APPROVED --reviewer \"\($verdict.user.login // "unknown")\" --review-url \"\($verdict.html_url // "")\""
  elif ($att_pending | length) > 0 and $attest_required then
    "GATE-YOURS attestation: \($att_names) is the only check left — bash scripts/attest-pr.sh \($num) --run \"<test cmd>\" --review-verdict APPROVED --reviewer \"\($verdict.user.login // "unknown")\" --review-url \"\($verdict.html_url // "")\""
  # GATE-READY recommends merge-pr.sh, which stops at gate 2 unless GitHub
  # says MERGEABLE. UNKNOWN means the background computation has not settled,
  # which is a wait — emitting a terminal verdict here ENDS --watch on a
  # recommendation that would come back pending (codex P2, PR #1764).
  # A green attestation STATUS is a claim about the past. If the comment it
  # was computed from has since been deleted, edited, or moved off this head,
  # gate 4 re-reads the live comment and rejects — so readiness may not rest
  # on the status alone (codex P2, PR #1764). Distinct from the
  # missing-status case above: here the status exists and is green.
  #
  # This also absorbs the documented comment-window limit: if the attestation
  # comment falls outside the window `gh pr view --json comments` returns, the
  # verdict degrades to GATE-YOURS attestation, and re-attesting is idempotent
  # because attest-pr.sh updates its existing comment.
  elif $attest_required and $att_invalid_here then
    "GATE-YOURS attestation: the attestation at \($head[0:8]) is invalid (\(if ($att_tests_ok | not) then "tests[] is empty or records a non-zero exit_code" else "review verdict \($att_verdict | tojson) is not APPROVED" end)) — gate 4 re-reads this live and rejects it; re-run bash scripts/attest-pr.sh \($num) --run \"<test cmd>\""
  elif $attest_required and ($attested_current | not) then
    "GATE-YOURS attestation: \($attest) is green but no valid attestation is visible at \($head[0:8]) — re-run bash scripts/attest-pr.sh \($num) --run \"<test cmd>\" --carry-review"
  elif ($pr.mergeable // "") == "UNKNOWN" then
    "GATE-WAIT merge: GitHub has not computed mergeability for \($head[0:8]) yet"
  else
    "GATE-READY: green + reviewed + attested — bash scripts/merge-pr.sh \($num)"
  end
JQ

# classify <checks-json> <pr-json> <reviews-json> <comments-json> -> a verdict.
# Every policy-derived string is BOUND with --arg/--argjson, never interpolated
# into the filter text: the bot name and the markers come from a repo-supplied
# file and would otherwise be jq injection (the same reason gate 5 cannot use
# `gh api --jq`).
classify() {
  jq -n -r \
    --argjson checks "$1" \
    --argjson pr "$2" \
    --argjson reviews "$3" \
    --argjson comments "$4" \
    --arg fetch_ok "$5" \
    --arg checks_ok "$6" \
    --argjson policy "$POLICY" \
    --arg policy_error "$POLICY_ERROR" \
    --arg attest "$ATTEST_CHECK" \
    --arg marker "$ATTEST_MARKER" \
    --arg num "$PR" \
    "$CLASSIFY_JQ"
}

# json_array_or_empty <text> -> the text if it parses as a JSON array, else [].
json_array_or_empty() {
  if [ -n "$1" ] && printf '%s' "$1" | jq -e 'type == "array"' >/dev/null 2>&1; then
    printf '%s' "$1"
  else
    printf '[]'
  fi
}

# snapshot -> one verdict line, or non-zero if gh could not be reached.
snapshot() {
  local checks pr_json reviews comments fetch_ok checks_ok head_before head_after
  # The PR read comes FIRST so every other query is collected against a KNOWN
  # head, and the head is re-read at the end to prove it did not move
  # underneath the snapshot (codex P2, PR #1764). `gh pr checks` exposes no
  # SHA of its own, so without this a push landing mid-snapshot would pair the
  # OLD head's green checks with the NEW head — and for an exempt author, or a
  # policy with review and attestation off, nothing else is head-bound, so it
  # would produce GATE-READY for a head nothing has validated.
  #
  # This query's failure is the one that means we genuinely cannot judge.
  # `mergeable` is computed asynchronously by GitHub and `author` decides
  # policy exemption; both are inputs to the ladder, so both are fetched here
  # rather than assumed.
  pr_json=$(gh pr view "$PR" \
    --json state,reviewDecision,headRefOid,comments,author,mergeable 2>/dev/null) || return 1
  [ -n "$pr_json" ] || return 1
  head_before=$(jq -r '.headRefOid // ""' <<<"$pr_json")

  # `gh pr checks` exits non-zero whenever any check is pending or failing,
  # and errors outright when a PR has no checks at all. Neither is an error
  # here, so the exit status is deliberately ignored; only an unparseable
  # payload is treated as "no checks".
  # `gh pr checks` exits non-zero whenever a check is pending or failing (8 is
  # documented for pending), and errors outright when a PR has no checks at
  # all. A status code is therefore NOT the signal — the payload is. What the
  # exit code cannot tell us apart is "no checks" from "the API was
  # unreachable", and those differ by a merge.
  checks_ok=true
  checks=$(gh pr checks "$PR" --json name,bucket,description 2>/dev/null) || true
  if ! printf '%s' "$checks" | jq -e 'type == "array"' >/dev/null 2>&1; then
    checks_ok=false
  fi
  checks=$(json_array_or_empty "$checks")

  # --paginate, like gate 5 and validate-attestation.sh: on a PR with more
  # than one page of reviews the current-head review is frequently on the LAST
  # page, and an unpaginated read would report "no review yet" for evidence
  # that exists. `-s ... add // []` flattens the pages and tolerates zero.
  # A FAILED fetch is not an empty review list, and the difference decides a
  # merge: with the reviews request failing and the comments request
  # succeeding, a stale clean comment plus a green attestation would produce
  # GATE-READY while the findings that invalidate it were simply invisible.
  # merge-pr.sh tracks exactly this with external_fetch_ok; `set -o pipefail`
  # at the top is what makes the guard real, since jq would otherwise supply a
  # zero status for a failed `gh api` (codex P2, PR #1764).
  fetch_ok=true
  reviews=$(gh api "repos/{owner}/{repo}/pulls/$PR/reviews" --paginate 2>/dev/null \
    | jq -s 'add // []' 2>/dev/null) || { reviews='[]'; fetch_ok=false; }
  reviews=$(json_array_or_empty "$reviews")

  # Issue comments carry comment-mode evidence: the head-bound request and the
  # reviewer's clean result. Fetched paginated, like gate 5 — the evidence is
  # frequently the newest comment on a long PR, and an unpaginated read would
  # silently report "no clean result" on exactly the PRs that have one. Only
  # comment mode reads them, so a review-mode repo pays nothing.
  # Fetched in BOTH modes whenever external review is required. Gate 5 always
  # requests comments AND reviews and holds evidence_ok=false if either fails,
  # review mode included — so skipping this request in review mode meant a
  # comments-endpoint outage produced GATE-READY here while the recommended
  # merge returned pending (codex P2, PR #1764). Comment mode is the only
  # consumer of the payload; review mode consumes the FAILURE, which is
  # exactly the evidence that was being discarded.
  comments='[]'
  if [ "$POLICY_EXTERNAL" = "true" ]; then
    comments=$(gh api "repos/{owner}/{repo}/issues/$PR/comments" --paginate 2>/dev/null \
      | jq -s 'add // []' 2>/dev/null) || { comments='[]'; fetch_ok=false; }
    comments=$(json_array_or_empty "$comments")
  fi

  # Re-read the head only (a cheap query) and refuse to classify a snapshot
  # that straddles a push. Non-terminal: the next poll sees a settled head.
  # Parsed with jq rather than `gh --jq` so the shape of this read matches the
  # first one exactly; a re-read that can disagree about FORM would report a
  # head change that never happened, and --watch would never settle.
  head_after=$(gh pr view "$PR" --json headRefOid 2>/dev/null | jq -r '.headRefOid // ""' 2>/dev/null) || head_after=""
  # An EMPTY head_after is a failed re-read, not a matching head. Treating it
  # as "no mismatch" would make this guard convert its own failure into
  # success — the check exists precisely because the snapshot might straddle a
  # push, and a re-read that did not happen proves nothing about that (codex
  # P2, PR #1764). Both branches are non-terminal, so the next poll recovers.
  if [ -z "$head_after" ]; then
    printf 'GATE-WAIT ci: could not re-read the head for #%s to confirm this snapshot is bound to one commit — verdict withheld rather than guessed' "$PR"
    return 0
  fi
  if [ "$head_after" != "$head_before" ]; then
    printf 'GATE-WAIT ci: head moved from %s to %s during this snapshot — re-reading rather than mixing evidence from two heads' \
      "${head_before:0:8}" "${head_after:0:8}"
    return 0
  fi

  local line
  line=$(classify "$checks" "$pr_json" "$reviews" "$comments" "$fetch_ok" "$checks_ok") || return 1

  # Gate 6 is the one gate whose inputs are not visible in any status: a label
  # added after `ralph-apply-keywords` was computed leaves the status green
  # while apply-keywords.sh, run live, rejects the closing keyword (codex P2,
  # PR #1764). So on the READY path only, RUN the same checker merge-pr.sh
  # runs rather than predicting it from a status — this repo's rule is that
  # gates are run, not predicted. Costs nothing on every other verdict, and is
  # inert in repos that do not ship the checker or have not opted in.
  case "$line" in
    GATE-READY*)
      if [ -x "$APPLY_KEYWORDS_SH" ]; then
        local apply_out
        if ! apply_out=$("$APPLY_KEYWORDS_SH" "$PR" 2>&1); then
          line="GATE-FAIL apply: $(printf '%s' "$apply_out" | head -1) — fix the closing keywords before merging"
        fi
        # Gate 6 makes its OWN GitHub queries, which take time, and it runs
        # AFTER the head guard above — so a push landing during it would let
        # every earlier finding (checks, review, attestation) describe the old
        # head while this returns terminal GATE-READY for the new one. Re-check
        # (codex P2, PR #1764). Only on this path, because it is the only one
        # that does work after the guard.
        local head_final
        head_final=$(gh pr view "$PR" --json headRefOid 2>/dev/null | jq -r '.headRefOid // ""' 2>/dev/null) || head_final=""
        if [ -z "$head_final" ] || [ "$head_final" != "$head_before" ]; then
          printf 'GATE-WAIT ci: head moved or became unreadable while gate 6 ran — re-reading rather than recommending a merge for evidence gathered at %s' \
            "${head_before:0:8}"
          return 0
        fi
      fi
      ;;
  esac
  printf '%s' "$line"
}

is_terminal() {
  case "$1" in
    GATE-WAIT*) return 1 ;;
    *) return 0 ;;
  esac
}

if [ "$WATCH" = false ]; then
  if ! line=$(snapshot); then
    echo "GATE-ERROR: could not query PR #$PR via gh" >&2
    exit 1
  fi
  printf '%s\n' "$line"
  if is_terminal "$line"; then exit 0; fi
  exit 10
fi

# --watch: emit only on state change, so a Monitor gets one notification per
# meaningful transition rather than one per poll. Transient gh failures must
# not kill a long watch, so they are tolerated until they look permanent.
last=""
fails=0
while :; do
  if line=$(snapshot); then
    fails=0
    if [ "$line" != "$last" ]; then
      printf '%s\n' "$line"
      last="$line"
    fi
    if is_terminal "$line"; then exit 0; fi
  else
    fails=$((fails + 1))
    if [ "$fails" -ge 3 ]; then
      echo "GATE-ERROR: gh unreachable for $fails consecutive polls — giving up"
      exit 1
    fi
  fi
  sleep "$INTERVAL"
done
