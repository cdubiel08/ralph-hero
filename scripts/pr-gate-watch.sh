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
# rate-limited reviewer's check reports bucket=pass with description
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
# GATE-YOURS review carries one further annotation (GH-1849): when the review
# loop has stopped converging — blocking findings not decreasing across the
# last two passes, or the round cap spent — it appends STOP ITERATING and names
# Human Needed as the move. It changes no verdict; the loop's own termination
# condition is the driver's call, and there is no code path at "decide to
# re-request" for a gate to sit in front of.
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
# derive — never invented here:
#
#   review   — a formal APPROVED review by the policy bot at the CURRENT head.
#              The default, so a policy that names no marker behaves exactly
#              as it always has.
#   findings — opted into by naming head_marker (GH-1847) or request_mode:
#              review-request (GH-2087): ONE scoped review per head. Reviewers
#              like Codex and Copilot have no APPROVED verb, so under `review`
#              mode their verdict is invisible and the watcher would wait
#              forever. Which predicate script runs is the request protocol's:
#              comment-marker → codex-review-evidence.sh (blocks on P0),
#              review-request → copilot-review-evidence.sh (blocks on every
#              unresolved bot thread — no severity markup exists to scope by).
#
# This classifier must never be a SECOND reader of the same evidence with its
# own opinion: a watcher that says "wait for review" while the gate says PASS
# (or the reverse) is worse than no watcher. In findings mode that is now
# structural — this script RUNS scripts/codex-review-evidence.sh, the same
# predicate gate 5 runs, and reports its verdict rather than recomputing one.
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
# The attested-at-this-head check reads the comment list PAGINATED (GH-1842),
# as gates 4 and 5 do: the window `gh pr view --json comments` returns can omit
# a valid attestation on a long PR, and an unreadable list is a GATE-WAIT
# rather than an absent attestation.

set -euo pipefail

# Printed by -h/--help, which short-circuits in the arg loop BEFORE the merge
# policy is read — help must work in a repo with no policy and no gh auth.
usage() {
  cat <<'EOF'
Usage: pr-gate-watch.sh PR_NUMBER [--watch] [--interval SECONDS]

Answers one question about a PR on a merge-gated repo: WHOSE TURN IS IT.
Never wait on `gh pr checks` — the ralph-attestation status is pending by
design until scripts/attest-pr.sh runs, so a pending-poll loop cannot fire.

  --watch             poll until a terminal verdict; print each state change
  --interval SECONDS  poll interval in --watch mode (default 30, must be > 0)
  -h, --help          this text

Verdicts (one line on stdout, precedence top wins):
  GATE-DONE            PR is not open — nothing to wait for          exit 0
  GATE-FAIL <gate>     policy / ci / attestation / review / merge /
                       apply is red — the line names the fix         exit 0
  GATE-YOURS <what>    your move (review nudge, or run attest-pr.sh) exit 0
  GATE-WAIT <what>     someone else's move; --watch keeps polling    exit 10
  GATE-READY           green + reviewed + attested → merge-pr.sh     exit 0

Annotations appended to verdicts (measure, never gate): advisory-findings
count, linkage drift, ruleset contexts, review staleness, convergence, the
unresolved-thread reader (scripts/review-threads.sh), and — in --watch mode —
a silent-reviewer note once the same GATE-WAIT review verdict has persisted
past RALPH_REVIEW_ANSWER_MAX_MIN minutes (default 30; 0 disables; fractional
values accepted). Annotations extend the line after the verdict token; the
token stream a Monitor parses does not change.

Exit: 0 terminal verdict, 10 still waiting, 2 usage error, 1 gh unreachable.
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
# The policy reader, the login-normalization rule and the attestation payload
# rules come from the shared library merge-pr.sh and validate-attestation.sh
# also use (GH-1843) — this script's whole job is to predict those gates, so a
# second copy of their rules is the one thing it must not hold.
# shellcheck source=lib/merge-evidence.sh
. "$PROJECT_ROOT/scripts/lib/merge-evidence.sh"
# shellcheck source=lib/gh-budget.sh
. "$PROJECT_ROOT/scripts/lib/gh-budget.sh"
POLICY_FILE="$(me_policy_file "$PROJECT_ROOT")"

# POLICY is the one object handed to jq. No policy file at all → gates 4-5 are
# off in merge-pr.sh, so external review is not required here either.
POLICY_ERROR=""
set +e
POLICY=$(me_policy_load "$POLICY_FILE")
POLICY_RC=$?
set -e
if [ "$POLICY_RC" -eq 2 ]; then
  # Fail CLOSED, like merge-pr.sh: a corrupt policy must not read as
  # "no external review required" and green-light a merge.
  POLICY_ERROR="merge policy file is not valid JSON (or names an unrecognized request_mode): $POLICY_FILE"
  POLICY=$(jq -n "$ME_JQ_LIB me_policy_none")
fi
POLICY_MODE=$(jq -r '.mode' <<<"$POLICY")
POLICY_REQUEST_MODE=$(jq -r '.requestMode' <<<"$POLICY")
POLICY_EXTERNAL=$(jq -r '.externalRequired | tostring' <<<"$POLICY")
POLICY_ATTESTATION=$(jq -r '.attestationRequired | tostring' <<<"$POLICY")

# Test-only override, same pattern merge-pr.sh gate 6 uses.
APPLY_KEYWORDS_SH="${RALPH_APPLY_KEYWORDS_SH:-$PROJECT_ROOT/scripts/apply-keywords.sh}"
# Findings mode's predicate script is the request protocol's (GH-2087), the
# same dispatch merge-pr.sh gate 5 and validate-attestation.sh make.
if [ "$POLICY_REQUEST_MODE" = "review-request" ]; then
  CODEX_EVIDENCE_SH="${RALPH_COPILOT_EVIDENCE_SH:-$PROJECT_ROOT/scripts/copilot-review-evidence.sh}"
else
  CODEX_EVIDENCE_SH="${RALPH_CODEX_EVIDENCE_SH:-$PROJECT_ROOT/scripts/codex-review-evidence.sh}"
fi
ADVISORY_SH="${RALPH_ADVISORY_FINDINGS_SH:-$PROJECT_ROOT/scripts/advisory-findings.sh}"
CONVERGENCE_SH="${RALPH_CONVERGENCE_SH:-$PROJECT_ROOT/scripts/review-convergence.sh}"
LINKAGE_DRIFT_SH="${RALPH_LINKAGE_DRIFT_SH:-$PROJECT_ROOT/scripts/pr-linkage-drift.sh}"
RULESET_CONTEXTS_SH="${RALPH_RULESET_CONTEXTS_SH:-$PROJECT_ROOT/scripts/ruleset-contexts.sh}"
STALENESS_SH="${RALPH_REVIEW_STALENESS_SH:-$PROJECT_ROOT/scripts/review-staleness.sh}"
THREADS_SH="${RALPH_REVIEW_THREADS_SH:-$PROJECT_ROOT/scripts/review-threads.sh}"
# The "not evaluated" evidence value: review mode, an exempt author, or a PR
# that is already closed. ok=false is inert wherever the ladder waives review.
CODEX_NONE='{"ok":false,"turn":"reviewer","detail":"review evidence not evaluated","reviewer":"","review_url":""}'

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

# The precedence ladder, as one jq program so it reads top-to-bottom in a
# single place and the shell holds no branching logic of its own. Kept in a
# quoted heredoc: the program contains single quotes, which cannot appear
# inside a single-quoted shell string.
# ME_JQ_LIB is prepended below rather than pasted in: this program calls
# me_norm / me_fenced_json / me_attestation_status, and they must be the very
# defs gates 4 and 5 run (GH-1843).
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
# me_norm, me_fenced_json and me_attestation_status come from
# scripts/lib/merge-evidence.sh, prepended to this program — the SAME defs
# gates 4 and 5 run (GH-1843). They used to be copies here, and every copy was
# a place this classifier could come to disagree with the gate it predicts.

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
# where an all-green board still needs a human nudge to make progress.
# Matched on the DESCRIPTION alone, exactly as merge-pr.sh gate 5 does: a
# check-run name need not equal the configured bot login, and the earlier
# literal `coderabbit` name test went dead when that reviewer was uninstalled
# (GH-1847), leaving the watcher and the gate disagreeing about what counts
# as rate-limited. $rl_is_reviewer below still decides whether the
# rate-limited check is the one gate 5 waits on.
| ($all | map(select(
    ((.description // "") | ascii_downcase | test("rate limit"))
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
| (($pr.author.login // "") | me_norm)                     as $author
| (($policy.exemptAuthors // []) | map(me_norm) | index($author) != null) as $exempt
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
# The remedy for "get a review moving" depends on the REQUEST PROTOCOL
# (GH-2087): comment mode posts the trigger, review-request mode re-requests
# the reviewer — telling a Copilot repo to post `@codex review` is advice its
# reviewer does not read, which is the same defect the trigger interpolation
# below fixed for host repos with a custom trigger.
| (if $policy.requestMode == "review-request"
   then "re-request a \($policy.bot) review (gh api -X POST repos/{owner}/{repo}/pulls/\($num)/requested_reviewers -f 'reviewers[]=Copilot')"
   else "comment '\($policy.trigger)'" end)              as $request_hint
# When the policy names a reviewer, only that reviewer's verdicts are gate
# evidence. With no policy (or external review not required) there is no
# configured identity to filter on, so any approval counts — still head-bound.
| ($reviews | map(select(
    ($ext_required | not) or (((.user.login // "") | me_norm) == (($policy.bot // "") | me_norm))
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
| (if $policy.mode == "findings" then false
   else ($approved | length) > 0 end)                    as $review_mode_ok
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
# sit here as an extra disjunct, which leaked formal approvals into the other
# mode — where gate 5 ignores them entirely and stays pending, so the watcher
# would move on to attestation and eventually recommend a merge that refuses
# (codex P2, PR #1764). `$review_mode_ok` already carries the approval for
# review mode, and the evidence script is findings mode's only evidence; the
# pooled term could therefore never add anything except the disagreement.
| (($ext_required | not) or $exempt
   or (if $policy.mode == "findings" then ($codex.ok == true)
       else $review_mode_ok end))                        as $review_ok
# The evidence the attest command may cite as an APPROVAL — and nothing else.
# In the ACTIVE mode only: comment mode cites the clean result, review mode
# cites an APPROVED review object.
#
# There is deliberately NO fallback to "the latest review at this head". That
# fallback existed, and it meant a COMMENTED review — findings, an explicit
# non-approval — produced `--review-verdict APPROVED` naming its author
# (codex P1, PR #1764). Combined with the sibling defect below, this script
# would have handed the caller a command asserting that a review which raised
# problems had approved the change. attest-pr.sh accepts the string and gate 4
# only checks a verdict is PRESENT, so nothing downstream would refuse it.
#
# An approval is the only thing that can be cited as an approval. Everything
# else — no evidence, or evidence that is not an approval — takes the
# --carry-review path, which can only copy a verdict someone really gave.
# In findings mode the citable approval is the P0-clean review the evidence
# script ACCEPTED — a real review object, at this head, that raised nothing
# blocking. Never a review the gate did not accept.
| (if $policy.mode == "findings" then
     (if $codex.ok == true
      then {user: {login: $codex.reviewer}, html_url: $codex.review_url}
      else null end)
   elif ($approved | length) > 0 then ($approved | last)
   else null end)                                        as $verdict
# With external review WAIVED (policy off, or an exempt author) there is
# legitimately no approval to cite, which is the other way $verdict is null.
# Findings at this head that nothing has answered yet. This is a NUDGE, not a
# gate: gate 5 accepts the review above, so the only thing left to say is
# "adjudicate before you attest" — and once a current attestation exists that
# advice is spent, which is what keeps it from becoming a permanent verdict.
# Subject to the SAME waivers as the review question it is a nudge about: with
# gate 5 off, or an exempt author, no approval is required, so asking for one
# terminates --watch on a request the merge will never make. The earlier
# waiver fixes covered $review_ok; this branch is reached independently of it
# whenever attestation is also waived (codex P2, PR #1764).
| (($commented | map(.submitted_at // "") | max) // "") as $findings_at
# A findings review that has ALREADY been answered with a fresh head-bound
# request is not unanswered — the reviewer owes the next move, not the caller.
# Without this, the nudge stayed terminal after the re-request it asked for,
# told the caller to re-request again, and ended --watch on the one state where
# waiting is exactly right (codex P2, PR #1764).
# The request time in the ACTIVE mode. Comment mode binds the request with a
# head marker; review mode has no marker to bind — its request is simply the
# trigger comment — so recognizing only the marker form made this false in
# review mode forever (codex P2, PR #1764). The nudge then kept telling a
# caller who HAD re-requested to re-request again, which is the same defect
# already fixed for comment mode, left unfixed in its sibling.
| (if $ext_required then
     ([ $comments[]
        | select((.body // "") | contains($policy.trigger))
        | .updated_at // .created_at // empty ] | max // "")
   else "" end)                                          as $any_request_at
| ($ext_required and $any_request_at != "" and $any_request_at > $findings_at)
                                                         as $rerequested
# Review mode only: in findings mode the evidence script already decided whose
# turn it is, and a second opinion here is exactly the disagreement this
# script must not hold.
| ($policy.mode == "review" and $ext_required and ($exempt | not)
   and ($commented | length) > 0 and ($approved | length) == 0
   and ($rerequested | not))                             as $unanswered_findings
| ($att_pending | map(.name) | join(", "))              as $att_names
# Is there already an attestation for the CURRENT head? The status stays
# pending for the minute or two validate-attestation.yml takes to recompute,
# and during that window the next move is to wait, not to attest again. The
# same comparison covers the other direction: after a new push the recorded
# sha no longer matches, so re-attesting is correctly demanded.
# Read from the PAGINATED comment list, not $pr.comments (GH-1842): the
# window `gh pr view --json comments` returns can omit a valid attestation on
# a long PR, and the verdict then demanded an attestation that already exists.
| ($comments
   | me_attestation_body
   | (try (me_fenced_json | fromjson) catch null))          as $att_json
| (($att_json.head_sha // ""))                          as $attested_sha
# The WHOLE payload, not just the sha. Gate 4 checks three things, and an edit
# can preserve head_sha while breaking either of the others — so a sha-only
# check calls a rejected attestation valid and ends --watch on a merge that
# fails immediately (codex P2, PR #1764). This is not a mirror of gate 4's
# terms any more: it IS gate 4's predicate, from the shared lib (GH-1843).
# Base-bound as well as head-bound (GH-1841): a retarget changes what the PR
# merges without moving the head, so a head-only predicate here would report
# GATE-READY into a gate-4 refusal — the classifier/gate disagreement GH-1843
# removed. An unreadable base is "" and skips the binding, same as gate 4.
| ($att_json | me_attestation_status($pr.headRefOid // ""; $pr.baseRefName // "")) as $att_status
| (($att_json.review.verdict // ""))                    as $att_verdict
# --carry-review is only offerable when there is something to carry:
# attest-pr.sh:173-190 refuses it unless a PRIOR attestation with a review
# block exists, so on a never-attested PR that hint is as unrunnable as the
# bare --run it replaced (codex P2, PR #1764).
# Carryable means "carrying it would HELP", not merely "the flag would be
# accepted". attest-pr.sh copies the prior verdict verbatim, so carrying a
# REJECTED one just writes another REJECTED attestation and gate 4 stays
# blocked — a command that runs and cannot possibly unblock (codex P2,
# PR #1764). Only an APPROVED prior verdict is worth offering.
| (($att_json != null) and (($att_json.review.verdict // "") == "APPROVED")) as $carryable
| (if $verdict != null then
     "--review-verdict APPROVED --reviewer \"\($verdict.user.login // "unknown")\" --review-url \"\($verdict.html_url // "")\""
   elif $carryable then
     "--carry-review   # copies the verdict already attested on this PR"
   else
     # Placeholders, deliberately: there is no evidence to cite and nothing to
     # carry, so the caller must supply a verdict from a review that actually
     # happened. Angle brackets rather than plausible defaults — a hint that
     # runs as-typed would be this script inventing the verdict again.
     "--review-verdict <VERDICT> --reviewer <who reviewed>   # no evidence on this PR and no prior attestation to carry: fill these from a real review"
   end)                                                   as $review_flags
| ($att_status == "ok")                                 as $attested_current
# Attested at this head but otherwise invalid: worth naming precisely, because
# "re-attest" and "your attestation records a failing test" are different jobs.
# The reason codes ARE that distinction — "stale" and "missing" are the two
# that mean re-attest, so everything else at this head is invalid-here.
| (($att_status == "no-tests") or ($att_status == "no-verdict")
   or ($att_status == "rejected"))                      as $att_invalid_here

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
  # Same rule for gate 4's evidence: an unreadable comment list is not an
  # absent attestation (GH-1842). Withholding a verdict costs one more poll;
  # calling it absent tells a caller to re-attest work already attested.
  elif $comments_ok != "true" and $attest_required
       and ($pr.state // "OPEN") == "OPEN" then
    "GATE-WAIT attestation: could not read the comments on #\($num) (gh api failed) — verdict withheld rather than guessed"
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
    "GATE-YOURS review: \($rl_names) rate-limited — its check PASSES but it reviewed nothing; \($request_hint)\(if $policy.mode == "findings" and $policy.requestMode == "comment" then " followed by a blank line and '<!-- \($policy.headMarker): \($head) -->' — gate 5 cannot bind a request without the marker" else "" end)"
  elif $unanswered_findings and (($review_ok | not) or ($attested_current | not)) then
    # Adjudicating threads does not convert a COMMENTED review into the
    # APPROVED object gate 5 requires, and neither does attesting. Only a
    # fresh approval can, so that is what this names (codex P2, PR #1764).
    "GATE-YOURS review: \($commented | length) comment-only review(s) at \($head[0:8]), no approval — adjudicate the threads, then re-request: comment '\($policy.trigger)' and wait for an APPROVED review BEFORE attesting"
  elif ($review_ok | not) then
    # The MISSING REQUEST outranks the rate-limit note, deliberately. This
     # branch answers "whose turn is it", and a rate-limited reviewer that gate
     # 5 is not even waiting on does not change the answer: with no head-bound
     # request, nothing can arrive by waiting, so a non-terminal verdict here
     # is the never-terminating loop this script exists to replace — produced
     # by an observation about an unrelated bot (codex P2, PR #1764). The rate
     # limit is still reported, one rung down, where waiting IS correct.
     # Findings mode: the evidence script's own verdict, verbatim. It already
     # distinguishes "you must act" (no request bound to this head, unresolved
     # P0 findings, too many threads to evaluate) from "the reviewer owes the
     # next move" — so re-deriving that here could only produce a second
     # opinion about the same evidence.
     (if $policy.mode == "findings" and $codex.turn == "yours" then
       "GATE-YOURS review: \($codex.detail)"
     elif ($ratelimited | length) > 0 then
       # Ranked BELOW the caller's own move and above the plain wait, in both
       # modes: where waiting is the right answer, a rate-limited reviewer is
       # the useful thing to say about it.
       "GATE-WAIT review: \($rl_names) reports pass but is rate-limited and reviewed nothing; gate 5 is waiting on \($policy.bot) at \($head[0:8]) — \($request_hint)"
     elif $policy.mode == "findings" then
       "GATE-WAIT review: \($codex.detail)"
     elif $ext_required and $any_request_at != "" then
       "GATE-WAIT review: request is in at \($head[0:8])\(if ($commented | length) > 0 then " and answers the findings review" else "" end); no APPROVED \($policy.bot) review yet"
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
    "GATE-YOURS attestation: no \($attest) status on this PR and no attestation at \($head[0:8]) — bash scripts/attest-pr.sh \($num) --run \"<test cmd>\" \($review_flags)"
  elif ($att_pending | length) > 0 and $attest_required then
    "GATE-YOURS attestation: \($att_names) is the only check left — bash scripts/attest-pr.sh \($num) --run \"<test cmd>\" \($review_flags)"
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
    "GATE-YOURS attestation: the attestation at \($head[0:8]) is invalid (\(if $att_status == "no-tests" then "tests[] is empty or records a non-zero exit_code" else "review verdict \($att_verdict | tojson) is not APPROVED" end)) — gate 4 re-reads this live and rejects it; re-run bash scripts/attest-pr.sh \($num) --run \"<test cmd>\" \($review_flags)"
  elif $attest_required and ($attested_current | not) then
    "GATE-YOURS attestation: \($attest) is green but no valid attestation is visible at \($head[0:8]) — re-run bash scripts/attest-pr.sh \($num) --run \"<test cmd>\" \($review_flags)"
  # Gate 2's shape exactly (merge-pr.sh:256-269): MERGEABLE passes, CONFLICTING
  # blocks, and `*` — EVERY other value — pends. Matching only the literal
  # "UNKNOWN" left an empty or unrecognized value falling through to
  # GATE-READY, which is the one direction that must never happen: not-yet-
  # computed is evidence-not-in, not a verdict, and a value this script does
  # not recognize is not permission to merge (codex P2, PR #1764).
  elif ($pr.mergeable // "") != "MERGEABLE" then
    "GATE-WAIT merge: mergeable is \(if ($pr.mergeable // "") == "" then "empty" else $pr.mergeable end) for \($head[0:8]) — not computed yet, which is not the same as mergeable"
  else
    "GATE-READY: green + reviewed + attested — bash scripts/merge-pr.sh \($num)"
  end
JQ
CLASSIFY_JQ="$ME_JQ_LIB$CLASSIFY_JQ"

# classify <checks-json> <pr-json> <reviews-json> <comments-json>
#          <fetch-ok> <checks-ok> <codex-evidence-json> -> a verdict.
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
    --arg comments_ok "$8" \
    --argjson codex "$7" \
    --argjson policy "$POLICY" \
    --arg policy_error "$POLICY_ERROR" \
    --arg attest "$ATTEST_CHECK" \
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
# gather -> one classified verdict from ONE set of reads, or non-zero if the
# PR itself could not be read. Everything below `snapshot` is about deciding
# how much to trust that verdict.
gather() {

  local checks pr_json reviews comments fetch_ok checks_ok comments_ok head_before head_after
  local pr_err pr_err_file pr_rc=0
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
  #
  # GH-2276: stderr is captured (not just discarded to /dev/null) so a
  # GraphQL rate-limit failure can be told apart from real unreachability.
  # This is deliberately NOT keyed on gb_backoff_seconds/gb_snapshot — GH-2278
  # established that `gh api rate_limit`'s `.resources.graphql` mirrors
  # `.resources.core` and can read a fully healthy budget while GraphQL is at
  # zero, which would make that signal say "healthy" on exactly the failure
  # this exists to catch. GitHub's own error text on the failing call is the
  # signal that is actually true at the moment of failure, and costs no extra
  # read — reusing gb_looks_rate_limited (GH-1817), the same text match the
  # write-side guard already trusts.
  pr_err_file=$(mktemp) || return 1
  pr_json=$(gh pr view "$PR" \
    --json state,reviewDecision,headRefOid,baseRefName,author,mergeable 2>"$pr_err_file") || pr_rc=$?
  pr_err=$(cat "$pr_err_file" 2>/dev/null)
  rm -f "$pr_err_file"
  if [ "$pr_rc" -ne 0 ] || [ -z "$pr_json" ]; then
    if gb_looks_rate_limited "$pr_json$pr_err"; then
      return 2
    fi
    return 1
  fi
  head_before=$(jq -r '.headRefOid // ""' <<<"$pr_json")

  # A PR that is no longer open is FINISHED, and nothing gathered below can
  # change that — so it short-circuits here, before any other query. Two
  # reasons, one correctness and one cost (codex P2, PR #1764):
  #
  #   * The guards below that withhold a verdict on an unreadable payload are
  #     state-gated in the ladder, but gather's own head re-read guards are
  #     not — so during an endpoint outage a MERGED PR could still emit a
  #     non-terminal GATE-WAIT and --watch would poll a finished PR forever.
  #   * Every remaining query is wasted on a PR nothing can act on.
  if [ "$(jq -r '.state // "OPEN"' <<<"$pr_json")" != "OPEN" ]; then
    classify '[]' "$pr_json" '[]' '[]' true true "$CODEX_NONE" true
    return 0
  fi

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

  # Issue comments carry review-mode's re-request timestamp. Fetched
  # paginated, like gate 5 — the evidence is frequently the newest comment on a
  # long PR. A FAILED fetch is not an empty list (fetch_ok), because gate 5
  # holds evidence_ok=false when either read fails, and a comments-endpoint
  # outage that read as "no comments" would produce GATE-READY here while the
  # recommended merge returned pending (codex P2, PR #1764).
  # Findings mode does not read them: codex-review-evidence.sh makes its own
  # reads and reports its own fetch failures, so a second copy here could only
  # disagree with the gate.
  #
  # The attestation lookup reads this SAME paginated list (GH-1842). It used
  # to read `$pr.comments`, the bounded window `gh pr view` returns, so a valid
  # attestation on a long PR (PR #1764: 40+ comments) fell outside it and the
  # verdict reverted to GATE-YOURS attestation. Its failure is tracked
  # separately from fetch_ok: gate 4's evidence and gate 5's are different
  # questions, and one unreadable read may not be reported as the other.
  comments='[]'
  comments_ok=true
  if { [ "$POLICY_EXTERNAL" = "true" ] && [ "$POLICY_MODE" = "review" ]; } \
     || [ "$POLICY_ATTESTATION" = "true" ]; then
    comments=$(gh api "repos/{owner}/{repo}/issues/$PR/comments" --paginate 2>/dev/null \
      | jq -s 'add // []' 2>/dev/null) || { comments='[]'; comments_ok=false; }
    comments=$(json_array_or_empty "$comments")
    if [ "$comments_ok" != "true" ] && [ "$POLICY_EXTERNAL" = "true" ] \
       && [ "$POLICY_MODE" = "review" ]; then
      fetch_ok=false
    fi
  fi

  # Findings mode: RUN the gate's own predicate rather than mirroring it. Not
  # run for policy-exempt authors — gate 5 skips them, so the three reads it
  # costs would buy an answer the ladder discards.
  local codex="$CODEX_NONE"
  if [ "$POLICY_EXTERNAL" = "true" ] && [ "$POLICY_MODE" = "findings" ] \
     && [ "$(me_is_exempt "$POLICY" "$(jq -r '.author.login // ""' <<<"$pr_json")")" != "true" ]; then
    codex=$("$CODEX_EVIDENCE_SH" "$PR" "$head_before" 2>/dev/null) \
      || codex='{"ok":false,"turn":"reviewer","detail":"review evidence could not be evaluated — retry","reviewer":"","review_url":""}'
    printf '%s' "$codex" | jq -e 'type == "object"' >/dev/null 2>&1 \
      || codex="$CODEX_NONE"
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


  local verdict
  verdict=$(classify "$checks" "$pr_json" "$reviews" "$comments" "$fetch_ok" "$checks_ok" "$codex" "$comments_ok") || return 1

  # Gate 6 is the one gate with no status to read, so it is RUN rather than
  # predicted — and it is run HERE, inside gather, because it is part of what
  # a READY verdict means. Running it once between the two passes left it as
  # the single gate the confirming pass did not actually confirm (codex P2,
  # PR #1764): an apply label, an issue linkage or a closing reference can
  # change without moving anything else, so it needs the same treatment as
  # every other input rather than an exemption.
  #
  # Only on the READY path, so a repo that has not opted in — or any verdict
  # that is already blocked for another reason — pays nothing.
  case "$verdict" in
    GATE-READY*)
      if [ -x "$APPLY_KEYWORDS_SH" ]; then
        local apply_out apply_first
        if ! apply_out=$("$APPLY_KEYWORDS_SH" "$PR" 2>&1); then
          # No `| head -1`: pipefail is on, head exits after the first line,
          # and printf can then take SIGPIPE on a checker with long output —
          # mangling the very line that says why the merge is blocked
          # (CodeRabbit, PR #1764).
          apply_first=${apply_out%%$'\n'*}
          printf 'GATE-FAIL apply: %s — fix the closing keywords before merging' "$apply_first"
          return 0
        fi
      fi
      ;;
  esac

  # Sub-P0 findings, appended to the verdict (GH-1945). Not a gate: the count
  # changes no verdict and blocks no merge. It exists because the two states
  # this line now distinguishes — findings outstanding vs none — used to render
  # IDENTICALLY here, and this is the one surface a driver reads before
  # merging. Three PRs merged over valid open P1s that way (#1939/#1941/#1942).
  #
  # Only on the two verdicts whose next move is toward merge. On the rest the
  # caller is not deciding anything yet, so the extra query buys nothing, and a
  # GATE-FAIL already names a different job.
  #
  # A zero is PRINTED rather than left as silence, because silence is what this
  # is fixing: "no findings" and "the count never ran" must not look alike. By
  # the same rule an unreadable count says so instead of reading as clean, and
  # an absent script (a host repo that does not ship it) says nothing at all —
  # there was never a count to be silent about.
  case "$verdict" in
    GATE-READY*|"GATE-YOURS attestation"*)
      if [ -x "$ADVISORY_SH" ]; then
        local adv adv_line
        adv=$("$ADVISORY_SH" "$PR" 2>/dev/null) || adv=''
        printf '%s' "$adv" | jq -e 'type == "object"' >/dev/null 2>&1 \
          || adv='{"ok":false,"count":0,"summary":"","first_url":"","reviewed":"unknown","detail":"advisory-findings.sh returned nothing usable"}'
        # Three states, not two (GH-1971). A count of zero from a PR nobody
        # reviewed is not a clean PR, and until now it printed the same words
        # as one — which is this line's own founding defect, one layer in.
        adv_line=$(jq -r '
          if .ok != true then " | advisory findings NOT COUNTED (\(.detail)) — not the same as none"
          elif .count == 0 and (.reviewed // "unknown") == "false" then
            " | NO ADVISORY REVIEW AT THIS HEAD — nobody looked; zero findings is not a clean PR"
          elif .count == 0 and (.reviewed // "unknown") != "true" then
            " | no unresolved advisory findings (whether anyone reviewed this head: NOT DETERMINED)"
          elif .count == 0 then " | no unresolved advisory findings"
          else " | \(.count) unresolved advisory finding(s): \(.summary) — read them before merging: \(.first_url)"
          end' <<<"$adv")
        verdict="${verdict}${adv_line}"
      fi
      ;;
  esac

  # Closing-keyword linkage drift (GH-1940), on the same two merge-ward
  # verdicts and under the same rule: it changes no verdict and blocks no
  # merge. Once a review app with write scope is installed the PR BODY is
  # app-writable, and `closingIssuesReferences` — which gate 6 reads, rightly,
  # instead of regexing the body — is DERIVED from it. If an app ever drops the
  # author's `Closes #N`, the gate evaluates a PR that closes nothing and
  # passes it: the merge folds nothing back into the board and nothing shouts.
  #
  # Only drift and not-evaluated print. A PR whose linkage is intact is the
  # normal case, and a per-PR "linkage fine" line is chrome that trains the eye
  # to skip the block it lives in — the opposite of what GH-1945 was for.
  case "$verdict" in
    GATE-READY*|"GATE-YOURS attestation"*)
      if [ -x "$LINKAGE_DRIFT_SH" ]; then
        local drift drift_line
        drift=$("$LINKAGE_DRIFT_SH" "$PR" 2>/dev/null) || drift=''
        printf '%s' "$drift" | jq -e 'type == "object"' >/dev/null 2>&1 \
          || drift='{"ok":false,"count":0,"drift":[],"summary":"","detail":"pr-linkage-drift.sh returned nothing usable"}'
        drift_line=$(jq -r '
          if .ok != true then " | closing-keyword linkage NOT CHECKED (\(.detail))"
          elif .count == 0 then ""
          else " | LINKAGE DRIFT — \(.summary). GitHub'"'"'s closing linkage is what the merge gate reads; the merge will fold nothing back into the board. Restore the keyword before merging"
          end' <<<"$drift")
        verdict="${verdict}${drift_line}"
      fi
      ;;
  esac

  # Required-but-not-produced ruleset contexts (GH-2057), on GATE-READY ONLY.
  # Every gate here can pass while GitHub's ruleset still refuses the merge:
  # required contexts are enumerated by literal name, so a diff that drops a
  # matrix leg leaves a required check nothing will ever report (#2055 — MERGE
  # GATE PASS, then "the base branch policy prohibits the merge").
  #
  # GATE-READY only, deliberately, unlike the two blocks above. This is the
  # verdict that says act NOW, and it is the only one whose recommended next
  # action GitHub can refuse. On GATE-YOURS attestation the answer would be
  # noise by construction — `ralph-attestation` is required and unproduced
  # until attest-pr.sh runs, which is precisely what that verdict already says.
  #
  # Silent when nothing is missing, and it changes no verdict: the refusal is
  # GitHub's to make and all we owe the driver is the string instead of the
  # opaque one. Fails open — see the script's own header.
  case "$verdict" in
    GATE-READY*)
      if [ -x "$RULESET_CONTEXTS_SH" ]; then
        local rules rules_line
        rules=$("$RULESET_CONTEXTS_SH" "$PR" 2>/dev/null) || rules=''
        printf '%s' "$rules" | jq -e 'type == "object"' >/dev/null 2>&1 \
          || rules='{"ok":false,"count":0,"missing":[],"summary":"","detail":"ruleset-contexts.sh returned nothing usable"}'
        rules_line=$(jq -r '
          if .ok != true then " | required ruleset contexts NOT CHECKED (\(.detail))"
          elif .count == 0 then ""
          else " | REQUIRED CONTEXT NOT PRODUCED AT THIS HEAD — \(.summary). The branch ruleset requires it by name, so the merge will be refused with \"the base branch policy prohibits the merge\" no matter what the gates say. Either the check has not started, or the diff stopped producing it and the ruleset needs updating"
          end' <<<"$rules")
        verdict="${verdict}${rules_line}"
      fi
      ;;
  esac

  # Review staleness (GH-1816), appended to the ONE verdict that says "the
  # author has rework to do". `reviewDecision` is repo-level aggregate state
  # with no commit binding, so a CHANGES_REQUESTED keeps blocking after the
  # findings have been fixed and pushed — until the reviewer re-reviews, which
  # under rate limiting is hours later. Gate 1 is right to block on it either
  # way; what it cannot say is WHOSE TURN it is, and that is the whole question
  # the deliver lane's demotion asks. It demoted GH-1774 on 2026-08-12 reading
  # this token, against a PR that was green and complete.
  #
  # Changes no verdict — GATE-FAIL review stays GATE-FAIL review, the merge
  # still refuses, and nothing here is looser than the gate. Same split
  # GH-1945/GH-1849 settled: the measurement is code, the decision is the
  # driver's. Only `stale` and an unreadable answer print; `live` is what this
  # verdict already means, and restating it is the chrome that gets skimmed.
  case "$verdict" in
    "GATE-FAIL review"*)
      if [ -x "$STALENESS_SH" ]; then
        local stale stale_line
        stale=$("$STALENESS_SH" "$PR" 2>/dev/null) || stale=''
        printf '%s' "$stale" | jq -e 'type == "object"' >/dev/null 2>&1 \
          || stale='{"ok":false,"verdict":"not-evaluated","head":"","blocking":[],"detail":"review-staleness.sh returned nothing usable"}'
        stale_line=$(jq -r '
          if .ok != true then " | staleness NOT CHECKED (\(.detail)) — treat as live rework"
          elif .verdict == "stale" then
            " | STALE VERDICT — \(.detail). Awaiting a re-review, not rework: do not demote; nudge the reviewer at the current head"
          else "" end' <<<"$stale")
        verdict="${verdict}${stale_line}"
      fi
      ;;
  esac

  # Convergence stopping rule (GH-1849), appended to the ONE verdict whose next
  # move is "go fix these and request another review". That is the moment the
  # decision is actually taken, and it is the moment #1764 took 33 times.
  #
  # Deliberately not attached to GATE-READY or GATE-YOURS attestation: those
  # verdicts point at merging, where the loop is already over and a round count
  # is noise. Deliberately not a verdict of its own, either — a GATE-STALLED
  # would have to outrank GATE-YOURS review to be seen, and it would then be
  # telling a driver "do not act" from a classifier whose entire contract is
  # naming whose turn it is. The judgment stays with the driver; only the
  # invisibility is fixed. Same split GH-1945 settled for advisory findings.
  case "$verdict" in
    "GATE-YOURS review"*)
      if [ -x "$CONVERGENCE_SH" ]; then
        local conv conv_line
        conv=$("$CONVERGENCE_SH" "$PR" 2>/dev/null) || conv=''
        printf '%s' "$conv" | jq -e 'type == "object"' >/dev/null 2>&1 \
          || conv='{"ok":false,"verdict":"not-evaluated","passes":0,"series":[],"pending":false,"cap":0,"detail":"review-convergence.sh returned nothing usable"}'
        # Only the two stopping verdicts print. A healthy loop needs no line —
        # this is the surface a driver reads on every single round, and a
        # per-round "still converging" note is the kind of chrome that gets
        # skimmed past, taking the two lines that matter with it.
        conv_line=$(jq -r '
          if .ok != true then ""
          elif .verdict == "stalled" then
            " | STOP ITERATING — blocking findings not decreasing across passes (\(.series | map(tostring) | join(", "))); escalate to Human Needed rather than requesting another review"
          elif .verdict == "cap-reached" then
            " | STOP ITERATING — round cap reached (\(.passes) of \(.cap)); escalate to Human Needed rather than requesting another review"
          else "" end' <<<"$conv")
        verdict="${verdict}${conv_line}"
      fi
      ;;
  esac

  # The thread READER, handed back with the one verdict that says "adjudicate
  # the findings" (audit A4). GATE-YOURS review names the problem — unresolved
  # threads, a review to answer — and until now handed back no tool, so every
  # session hand-rolled the same reviewThreads GraphQL (107 literals measured
  # across 7 sessions). Not a gate, not a verdict change: one runnable line,
  # only where the next move is reading threads, and only when the script
  # actually ships in this repo — naming a tool a host repo does not have
  # would be a redirect to a dead end (the GH-1717 rule).
  case "$verdict" in
    "GATE-YOURS review"*)
      if [ -x "$THREADS_SH" ]; then
        verdict="${verdict} | read the threads: bash scripts/review-threads.sh $PR --unresolved (reply: --reply <id> -m; resolve+nudge: --resolve <id>)"
      fi
      ;;
  esac
  printf '%s' "$verdict"
}

# snapshot -> the verdict to report.
#
# Every verdict except GATE-READY is advice the next poll revises, so one pass
# is the right cost. GATE-READY is different in kind: it says act NOW, and it
# is computed from reads that necessarily happened BEFORE it was printed. A
# rerun check going red, a clean-result comment being deleted, an approval
# dismissed — none of these move the head, so none were visible to the pass
# that decided (codex P2, PR #1764).
#
# So readiness must survive a SECOND, INDEPENDENT pass. Not another bolted-on
# re-read of one more field: the same complete classification — gate 6
# included, which is why that checker runs inside gather and not between the
# passes — run again, with the second verdict reported whenever the two
# disagree.
#
# Why two and not a fixed point: there isn't one. Any snapshot classifier
# races with the world between its last read and its printed line, so a third
# pass would have the same property as the second. Two passes bound the window
# to the width of one pass, and the remaining window is closed by the thing
# that actually IS atomic with the merge — `merge-pr.sh`, which re-runs every
# gate itself at merge time and refuses if any has changed. This script
# recommends; the gate decides. A stale GATE-READY therefore costs one refused
# merge-pr run that prints the real reason, never a bad merge.
snapshot() {
  local line second rc=0
  line=$(gather) || rc=$?
  [ "$rc" -eq 0 ] || return "$rc"

  case "$line" in
    GATE-READY*) ;;
    *) printf '%s' "$line"; return 0 ;;
  esac

  second=$(gather) || {
    printf 'GATE-WAIT ci: could not confirm #%s is still ready (the confirming read failed) — withholding the merge recommendation rather than acting on a stale pass' "$PR"
    return 0
  }
  case "$second" in
    GATE-READY*) printf '%s' "$second"; return 0 ;;
    *)
      # The two passes disagree, so the world moved while this one looked. The
      # SECOND verdict is reported: it is the newer of the two, and it already
      # names what changed — a red check, a dismissed approval, a conflict.
      printf '%s' "$second"
      return 0
      ;;
  esac
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

# --- silent-reviewer annotation (audit B7, reshaped) -------------------------
# A review round that never completes had no bound: GH-1849 capped the number
# of rounds, but a round whose reviewer simply never answers is not a round —
# a whole session was lost polling a silent Codex (feature-gh-1829), and 16
# GATE-WAIT review verdicts named the wait with no deadline. Deliberately NOT
# a new verdict: this file already documents (at the convergence block) why a
# GATE-STALLED would have to outrank GATE-YOURS to be seen, and would then be
# telling a driver "do not act" from a classifier whose entire contract is
# naming whose turn it is. So: once the SAME GATE-WAIT review verdict has
# persisted past RALPH_REVIEW_ANSWER_MAX_MIN (default 30; 0 disables;
# fractional minutes accepted), the line is re-printed ONCE with a note
# appended — the verdict token is unchanged, the exit semantics are unchanged,
# the escalation stays the driver's. The `board move` suggestion appears only
# when the issue number is derivable from the head branch (`board name`'s
# grammar, legacy included); guessing a number would be worse than omitting it.
: "${RALPH_REVIEW_ANSWER_MAX_MIN:=30}"
case "$RALPH_REVIEW_ANSWER_MAX_MIN" in
  ''|*[!0-9.]*|*.*.*) RALPH_REVIEW_ANSWER_MAX_MIN=30 ;;  # non-numeric → default
esac
ANSWER_MAX_SEC=$(awk -v m="$RALPH_REVIEW_ANSWER_MAX_MIN" 'BEGIN{printf "%d", m*60}')

silent_reviewer_note() { # <since_epoch> -> the note text (one line, no newline)
  local since="$1" now mins meta sha branch issue since_iso consider
  now=$(date +%s)
  mins=$(( (now - since) / 60 ))
  # One cheap read, at most once per persisted verdict — the note fires once.
  meta=$(gh pr view "$PR" --json headRefOid,headRefName 2>/dev/null) || meta=""
  sha=$(jq -r '.headRefOid // ""' <<<"$meta" 2>/dev/null) || sha=""
  branch=$(jq -r '.headRefName // ""' <<<"$meta" 2>/dev/null) || branch=""
  issue=""
  if [[ "$branch" =~ ^(feat|fix|chore|docs|apply)/([0-9]+)- ]]; then
    issue="${BASH_REMATCH[2]}"
  elif [[ "$branch" =~ ^feature/GH-([0-9]+)$ ]]; then
    issue="${BASH_REMATCH[1]}"
  fi
  # BSD date first (this repo's dev machines), GNU as the fallback (CI).
  since_iso=$(date -u -r "$since" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -d "@$since" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || echo "epoch $since")
  consider=""
  if [ -n "$issue" ]; then
    consider=" — consider: board move $issue human-needed --why 'reviewer silent since $since_iso'"
  fi
  printf 'note: reviewer silent at head %s for %s min%s' "${sha:0:8}" "$mins" "$consider"
}

# --watch: emit only on state change, so a Monitor gets one notification per
# meaningful transition rather than one per poll. Transient gh failures must
# not kill a long watch, so they are tolerated until they look permanent.
# `last` holds the BARE verdict even when the note-augmented line is printed,
# so the note re-prints the line exactly once and later identical polls stay
# silent — a per-poll growing "for N min" would be one line per poll, which is
# the notification spam the state-change rule exists to prevent.
last=""
fails=0
verdict_since=$(date +%s)
silent_noted=false
while :; do
  rc=0
  line=$(snapshot) || rc=$?
  if [ "$rc" -eq 0 ]; then
    fails=0
    if [ "$line" != "$last" ]; then
      printf '%s\n' "$line"
      last="$line"
      verdict_since=$(date +%s)
      silent_noted=false
    elif [ "$silent_noted" = false ] && [ "$ANSWER_MAX_SEC" -gt 0 ]; then
      case "$line" in
        "GATE-WAIT review"*)
          if [ $(( $(date +%s) - verdict_since )) -ge "$ANSWER_MAX_SEC" ]; then
            printf '%s | %s\n' "$line" "$(silent_reviewer_note "$verdict_since")"
            silent_noted=true
          fi
          ;;
      esac
    fi
    if is_terminal "$line"; then exit 0; fi
  elif [ "$rc" -eq 2 ]; then
    # GH-2276: gather() observed GitHub's own GraphQL rate-limit error text
    # directly on the failing read (gb_looks_rate_limited, GH-1817's write-side
    # guard reused for a read). That is trustworthy at the moment it happens —
    # unlike the pre-spend budget NUMBER below, which GH-2278 found reads a
    # fully healthy `.resources.graphql` while GraphQL is genuinely at zero,
    # because that REST field mirrors `.resources.core`. This is not a `fails`
    # increment: the read didn't fail to reach GitHub, GitHub told us why.
    #
    # Deliberately not computing a reset deadline to sleep to: GH-2278 also
    # measured that endpoint's `reset` epoch rolling forward with the clock
    # rather than holding still, so it is not a trustworthy wake time either.
    # Re-probing at the normal poll cadence is enough — a rejected call costs
    # no extra budget, so there is nothing to back off FROM.
    wait_line="GATE-WAIT budget: GraphQL rate limit hit on the last read — retrying"
    if [ "$wait_line" != "$last" ]; then
      printf '%s\n' "$wait_line"
      last="$wait_line"
    fi
    sleep "$INTERVAL"
    continue
  else
    # A plain failure (rc 1): GitHub gave no rate-limit signature on this
    # read, so it is not excluded from the counter. Codex review (PR #2285):
    # an earlier version of this branch also consulted gb_backoff_seconds —
    # the pre-spend budget NUMBER, not an observed error — as a second
    # signal. That number means "below the floor", not "exhausted", so a
    # merely-low-but-nonzero budget (say 499/500) would have swallowed an
    # UNRELATED real failure (bad permissions, a malformed response) into a
    # budget-wait loop that never gives up, hiding it for up to an hour
    # instead of surfacing it after 3 polls. Only the confirmed signal above
    # may suppress the counter; a plain failure always counts.
    fails=$((fails + 1))
    if [ "$fails" -ge 3 ]; then
      echo "GATE-ERROR: gh unreachable for $fails consecutive polls — giving up"
      exit 1
    fi
    sleep "$INTERVAL"
    continue
  fi
  # GH-1817: this is the repo's one sanctioned poll loop, and a poll loop on
  # this token is what drove the budget to 0/5000 on 2026-08-12, blocking every
  # other ralph surface for ~15 minutes. Bounding each read (#1785, #1803,
  # #1814) caps one consumer's cost; only a pre-spend check caps the aggregate.
  # So when the budget is starved, sleep through the reset instead of spending
  # into it — and SAY SO on stderr, because a backoff nobody can see is the
  # same silent degradation this issue is about. stderr deliberately: stdout is
  # the verdict stream a Monitor parses, and this is not a verdict.
  backoff=$(gb_backoff_seconds)
  if [ "${backoff:-0}" -gt 0 ]; then
    gb_report_low
    # The reset can be up to an hour out; cap the nap so a watcher stays
    # interruptible and re-reports rather than going dark until the top of the
    # hour. It re-checks and naps again if the budget is still starved.
    [ "$backoff" -gt 300 ] && backoff=300
    sleep "$backoff"
    continue
  fi
  sleep "$INTERVAL"
done
