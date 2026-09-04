#!/usr/bin/env bash
# scripts/lib/merge-evidence.sh — the one reader of .github/ralph-merge-policy.json
#
# GH-1843. merge-pr.sh (gates 4-5), validate-attestation.sh, pr-gate-watch.sh,
# codex-review-evidence.sh and advisory-findings.sh all answer questions about
# the SAME evidence. They used to answer them from five hand-maintained copies
# of the rules, held together by comments saying "must change with gate 5".
# Seven review rounds on PR #1764 produced 20+ findings that were, in the large
# majority, one reader disagreeing with another about the same bytes — in both
# directions (a watcher that never terminates, or GATE-READY into a merge that
# immediately refuses). This file exists so that class stops regenerating.
#
# Two consumers with different shapes, so the rules are published twice over
# ONE definition rather than written twice:
#
#   ME_JQ_LIB   jq source. Scripts that do their work inside one big jq program
#               (pr-gate-watch.sh) prepend it and call the defs directly.
#   me_*()      bash wrappers that run that same jq source. Scripts that step
#               through gates line by line (merge-pr.sh, validate-attestation.sh)
#               call these.
#
# Nothing here reaches the network except me_review_mode_approved, which is
# marked as such. Everything else is a pure function of bytes already fetched.
#
# Source it as:  . "$(dirname "$0")/lib/merge-evidence.sh"

# ---------------------------------------------------------------------------
# The jq module
# ---------------------------------------------------------------------------
# shellcheck disable=SC2016  # single quotes are deliberate: this is jq source
ME_JQ_LIB='
# GitHub spells one identity several ways: "codex[bot]" via REST, "app/codex"
# in some payloads. Every login comparison in the merge path normalizes both
# sides through this.
def me_norm: sub("^app/"; "") | sub("\\[bot\\]$"; "");

# The attestation payload: a ```json fence with BOTH delimiters anchored to
# their own lines. Anchoring is load-bearing — accepting an inline fence
# anywhere in the body let a comment gate 4 calls unparseable read as valid
# elsewhere (codex P2, PR #1764). No closing fence means "to the end".
def me_fenced_json:
  (. / "\n") as $lines
  | ($lines | map(test("^```json[[:space:]]*$")) | index(true)) as $start
  | if $start == null then null
    else ($lines[($start + 1):]) as $rest
      | ($rest | map(test("^```[[:space:]]*$")) | index(true)) as $end
      | (if $end == null then $rest else $rest[0:$end] end | join("\n"))
    end;

# Raw policy object -> the canonical shape every reader uses. Defaults live
# HERE and nowhere else: they used to differ between readers (head_marker
# defaulted to "" in three scripts and to "ralph-review-head" in a fourth),
# which is the mirror bug one edit ahead of being live.
#
# `mode` is DERIVED, never configured or defaulted:
#   review   — the reviewer files formal APPROVED review objects. The original
#              gate-5 behavior and the default, so a policy naming a
#              formal-review bot keeps merging rather than silently inheriting
#              a protocol its reviewer does not speak.
#   findings — the reviewer has no APPROVED verb and emits findings instead.
#              Two request protocols, carried in `requestMode` (GH-2087):
#                comment        — a trigger comment + head marker binds the one
#                                 scoped review to this head (Codex). Opted
#                                 into by naming head_marker.
#                review-request — the reviewer is engaged via a GitHub review
#                                 request (Copilot). Opted into by
#                                 external_review.request_mode. The request is
#                                 not head-bound, but the ANSWER is (a review
#                                 object carries commit_id), which is the
#                                 binding gate 5 reads.
#
# The review-request bot default is Copilot, measured 2026-08-19 (public
# corpus, n=31): reviews are filed by copilot-pull-request-reviewer[bot],
# while the login one REQUESTS is `Copilot` — the asymmetry lives in the
# evidence script, not here.
def me_policy:
  (.external_review.request_mode // "comment") as $rm
  | {
    attestationRequired: (.attestation.required // false),
    externalRequired:    (.external_review.required // false),
    requestMode:         $rm,
    bot:                 (.external_review.bot
                          // (if $rm == "review-request"
                              then "copilot-pull-request-reviewer[bot]"
                              else "chatgpt-codex-connector[bot]" end)),
    trigger:             (.external_review.trigger // "@codex review"),
    headMarker:          (.external_review.head_marker // ""),
    exemptAuthors:       (.exempt_authors // []),
    environments:        (.environments // {})
  }
  | .mode = (if .requestMode == "review-request" then "findings"
             elif .headMarker != "" then "findings"
             else "review" end);

# No policy file at all: gates 4-5 are off, so a repo that has not opted in
# merges through its own flow untouched. Same object shape, so no reader needs
# a second code path for the absent case.
def me_policy_none:
  {
    attestationRequired: false,
    externalRequired:    false,
    requestMode:         "comment",
    bot:                 "",
    trigger:             "",
    headMarker:          "",
    exemptAuthors:       [],
    environments:        {},
    mode:                "review"
  };

# Is this author waived? Normalized on both sides.
def me_exempt($author):
  ((.exemptAuthors // []) | map(me_norm) | index($author | me_norm)) != null;

# GH-2451. Per-environment deploy grants, read beside the `apply` block:
# `environments.<name>: autonomous | lead | human`.
#
#   autonomous  scripts/approve-deploy.sh may approve the pending deployment
#               on that run itself
#   lead        the driver escalates (`board move NNN human-needed`, which
#               already routes to the lead when RALPH_HERDR_LEAD is set —
#               GH-2179) rather than approving
#   human       no agent path exists; approve-deploy.sh refuses outright
#
# "prod"/"production" (case-insensitive) are FORCED to "human" no matter what
# the policy configures. This is dispatch reserved-set item 4 —
# "irreversible outside the repo" — enforced here, in code, not left to policy
# author discipline: a mistyped or copy-pasted "prod": "autonomous" must not
# grant what the reserved set exists to withhold. An environment the policy
# does not name also reads "human": grants are opt-IN, so an unconfigured
# target stays exactly as gated as one nobody wrote a line for.
def me_reserved_environments: ["prod", "production"];
def me_environment_grant($env):
  if (me_reserved_environments | index($env | ascii_downcase)) != null
  then "human"
  else (.environments[$env] // "human")
  end;

# Attestation validity against a head sha. Returns a REASON CODE, never a
# boolean: "stale" is retry-able (re-attest) while "rejected" is a verdict
# against merging, and a caller that cannot tell them apart either loops
# forever or merges over a REJECTED. Callers map codes to their own exit
# conventions.
#
#   ok         valid at this head
#   missing    no parseable ```json payload
#   stale      head_sha != the PR head — re-attest after the latest push
#   no-tests   tests[] empty, or some recorded test exited non-zero
#   no-verdict review.verdict absent
#   rejected   review.verdict present but not APPROVED
#
# All three of tests/verdict/sha are checked, because an edit can preserve
# head_sha while breaking either of the others (codex P2, PR #1764).
#
# `base-changed` is the base-retarget hole (GH-1841). Evidence bound to
# head_sha alone survives a retarget, because retargeting changes what the PR
# MERGES without moving the head — so a green status computed against base A
# is accepted for a diff against base B. The identity is the base REF NAME,
# not the base SHA: a base sha moves every time the target branch gains a
# commit, so binding to it would invalidate every attestation on the repo each
# time anything merges — churn, not a gate. A ref name changes on exactly the
# event this catches and on no other. A payload with no `base_ref` at all is
# the same code: it predates the binding, so it cannot answer the question,
# and the remedy is identical (re-attest). $base == "" means the CALLER could
# not read the base of the PR, which is not evidence against the attestation —
# the check is skipped rather than guessed at.
def me_attestation_status($head; $base):
  if . == null then "missing"
  elif ((.head_sha // "") != $head) then "stale"
  elif ($base != "" and (.base_ref // "") != $base) then "base-changed"
  elif (((.tests // []) | (length > 0) and all(.exit_code == 0)) | not) then "no-tests"
  elif ((.review.verdict // "") == "") then "no-verdict"
  elif ((.review.verdict // "") != "APPROVED") then "rejected"
  else "ok" end;

def me_attestation_ok($head; $base): me_attestation_status($head; $base) == "ok";

# The marker attest-pr.sh writes. Defined here so the three readers stop
# hardcoding the same literal beside a comment asking them to stay in sync.
def me_attestation_marker: "<!-- ralph-attestation:v1 -->";

# Comments array (REST issue comments, or gh pr view --json comments) -> the
# body of the LAST comment carrying the marker, or "". Both payload shapes
# spell the body `.body`, which is the only field this reads.
def me_attestation_body:
  [ (. // [])[] | select(((.body // "")) | contains(me_attestation_marker)) ]
  | last | (.body // "");

# Review-mode evidence: a formal APPROVED review by the policy bot, bound to
# this head and not dismissed. Input is the REST reviews array.
def me_approved_reviews($bot; $head):
  [ .[]
    | select(((.user.login // "") | me_norm) == ($bot | me_norm))
    | select((.state // "") == "APPROVED")
    | select((.commit_id // "") == $head)
  ];

# GH-2443: an estimate of GitHub own native required-approving-review
# count, for the PENDING message text only — never a gate decision.
# reviewDecision already IS that decision, computed server-side against
# the real rule (latest OPINIONATED review per author, dismissals
# excluded). This is "latest review per author, in submission order",
# which can undercount an approve-then-comment sequence; honest as a
# rendered count, not as a re-derivation of the server verdict.
def me_latest_review_per_author:
  group_by(.user.login // "") | map(max_by(.submitted_at // ""));
def me_approval_count:
  [ me_latest_review_per_author[] | select((.state // "") == "APPROVED") ] | length;
'

# ---------------------------------------------------------------------------
# bash surface
# ---------------------------------------------------------------------------

# A library may not decide its caller's shell options. Running a subprocess
# whose failure is DATA (a crashed predicate, an unreadable API) needs errexit
# off for the duration — but a bare `set -e` afterwards TURNS IT ON for a
# caller that never had it, which silently converts that caller's next
# tolerated non-zero exit into an abort. Save, disable, restore.
# The saved flag is a LOCAL of the calling function, not a global: a global
# would be clobbered by a nested call and restore the wrong state.
_me_noerrexit() { case "$-" in *e*) _me_errexit_save=e ;; *) _me_errexit_save="" ;; esac; set +e; }
_me_errexit_restore() { [ -n "${_me_errexit_save:-}" ] && set -e; return 0; }

# me_policy_file [repo_root] — the path every reader reads.
# RALPH_MERGE_POLICY_FILE is the test-only override, honoured identically
# everywhere so a test cannot accidentally point one reader at a real policy.
me_policy_file() {
  local root="${1:-}"
  if [[ -z "$root" ]]; then root=$(git rev-parse --show-toplevel 2>/dev/null || echo .); fi
  echo "${RALPH_MERGE_POLICY_FILE:-$root/.github/ralph-merge-policy.json}"
}

# me_policy_load <policy_file> — canonical policy JSON on stdout.
#   exit 0  loaded (or absent, in which case the all-off object)
#   exit 2  the file exists and is not valid JSON
#
# Exit 2 is separate from every other failure because a malformed policy must
# fail CLOSED: a truncated file reading as "no external review required" would
# green-light exactly the merges this policy exists to gate (CodeRabbit
# finding, PR #1602). Callers map 2 to their own hard-stop.
me_policy_load() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    jq -n "$ME_JQ_LIB me_policy_none"
    return 0
  fi
  if ! jq -e . "$file" >/dev/null 2>&1; then
    return 2
  fi
  # An unrecognized request_mode is a MALFORMED policy, same class as invalid
  # JSON: a typo ("review_request") silently deriving comment mode would point
  # gate 5 at a marker protocol the configured reviewer never speaks, and the
  # gate would wait forever on evidence that cannot arrive. Exit 2 so gates
  # fail closed while the two non-gating readers keep their default fallback.
  if ! jq -e '(.external_review.request_mode // "comment")
              | IN("comment", "review-request")' "$file" >/dev/null 2>&1; then
    return 2
  fi
  # Same class again (GH-2451): a typo'd grant value ("autonomus") must not
  # silently fall through to a DIFFERENT rule than the one the policy author
  # wrote — me_environment_grant's `// "human"` default would otherwise turn
  # a malformed "autonomous" into a silently-safe "human", masking the typo
  # instead of surfacing it.
  if ! jq -e '(.environments // {}) | to_entries
              | all(.value | IN("autonomous", "lead", "human"))' "$file" >/dev/null 2>&1; then
    return 2
  fi
  jq -c "$ME_JQ_LIB me_policy" "$file"
}

# me_policy_get <policy_json> <key> — one field, as a bare string.
me_policy_get() { jq -r --arg k "$2" '.[$k] | if type == "array" then tojson else tostring end' <<<"$1"; }

# me_is_exempt <policy_json> <author> — "true" / "false"
me_is_exempt() {
  jq -r "$ME_JQ_LIB"' me_exempt($a) | tostring' --arg a "$2" <<<"$1" 2>/dev/null || echo "false"
}

# me_environment_grant <policy_json> <env> — one of autonomous|lead|human
# (GH-2451). See the jq def above for the reserved-set and default rules.
me_environment_grant() {
  jq -r "$ME_JQ_LIB"' me_environment_grant($e)' --arg e "$2" <<<"$1"
}

# The marker as a bash constant, same definition as the jq def above.
ME_ATTESTATION_MARKER='<!-- ralph-attestation:v1 -->'

# me_attestation_comment <pr_number> — NETWORK. The attestation comment body
# on stdout, or empty when the PR carries none.
#   exit 0  read succeeded (empty output means no attestation comment)
#   exit 3  the comments API could not be read
#
# GH-1842: the three readers used `gh pr view --json comments`, which returns
# a bounded window — on a PR with more comments than that window (PR #1764
# accumulated 40+ across seven review rounds) a VALID attestation falls
# outside it and reads as absent. `--paginate` is what gate 5 already does.
#
# Exit 3 is distinct for the same reason it is in me_review_mode_approved: a
# failed read is not "no attestation yet", and the two have different correct
# responses (retry the read vs. run attest-pr.sh).
me_attestation_comment() {
  local pr="$1" raw comments
  raw=$(gh api "repos/{owner}/{repo}/issues/$pr/comments?per_page=100" --paginate 2>/dev/null) || return 3
  # --paginate emits one array per page; slurp + add flattens them.
  comments=$(jq -s 'add // []' <<<"$raw" 2>/dev/null) || return 3
  jq -r "$ME_JQ_LIB"' me_attestation_body' <<<"$comments" 2>/dev/null || return 3
}

# me_attestation_payload <comment_body> — the fenced JSON, or empty.
me_attestation_payload() {
  jq -r "$ME_JQ_LIB"' me_fenced_json // ""' -R -s <<<"$1"
}

# me_attestation_status <comment_body> <head_sha> [base_ref] — one reason code
# (see the jq def). An unparseable payload is "missing", same as no payload at
# all: both mean there is no attestation to read. An omitted or empty base_ref
# skips the base binding rather than failing it.
me_attestation_status() {
  local payload
  payload=$(me_attestation_payload "$1")
  if [[ -z "$payload" ]] || ! jq -e . >/dev/null 2>&1 <<<"$payload"; then
    echo "missing"
    return 0
  fi
  jq -r "$ME_JQ_LIB"' me_attestation_status($h; $b)' \
    --arg h "$2" --arg b "${3:-}" <<<"$payload"
}

# me_attestation_field <comment_body> <jq_path> — one field of the payload,
# for messages ("attested by X", "verdict was Y"). Empty when unreadable.
me_attestation_field() {
  local payload
  payload=$(me_attestation_payload "$1")
  jq -e . >/dev/null 2>&1 <<<"$payload" || { echo ""; return 0; }
  jq -r "$2"' // ""' <<<"$payload"
}

# me_review_mode_approved <pr_number> <bot> <head_sha> — NETWORK.
#   exit 0  an APPROVED review by <bot> exists at <head_sha>
#   exit 1  no such review
#   exit 3  the reviews API could not be read
#
# Exit 3 is distinct on purpose. Without it a failed `gh api` reads as EMPTY
# EVIDENCE — "no review yet" — rather than an unavailable API, and the two
# have opposite correct responses (wait for the reviewer vs. retry the read).
# Pinned by a regression test (CodeRabbit, #1839).
me_review_mode_approved() {
  local pr="$1" bot="$2" head="$3" raw reviews count
  # Split, not piped: a pipeline's status is jq's unless the CALLER set
  # pipefail, and `jq -s 'add // []'` succeeds on the empty input a failed
  # `gh api` leaves behind — so the exit-3 distinction above would silently
  # become exit 1 for any caller that did not set it. This library documents
  # that it imposes no shell options on its callers, so the guard may not
  # depend on one (GH-2262).
  raw=$(gh api "repos/{owner}/{repo}/pulls/$pr/reviews" --paginate 2>/dev/null) || return 3
  # --paginate emits one array per page; slurp + add flattens them.
  reviews=$(jq -s 'add // []' <<<"$raw" 2>/dev/null) || return 3
  count=$(jq -r "$ME_JQ_LIB"' me_approved_reviews($bot; $head) | length' \
    --arg bot "$bot" --arg head "$head" <<<"$reviews") || return 3
  [[ "${count:-0}" -gt 0 ]]
}

# me_pull_request_rule <base_ref> — NETWORK. The base branch's EFFECTIVE
# `pull_request` ruleset rule (GH-2443) — the merge of every ruleset
# targeting the ref, same read ruleset-contexts.sh already makes for
# `required_status_checks`. Prints the rule's `parameters` object on stdout,
# or the literal string "null" when no such rule is active or the read
# failed (an absent rule and an unreadable one render the same to the
# caller: neither can name a count, so both fall back to a generic message).
#   exit 0  a rule was found (or genuinely absent)
#   exit 3  the branch-rules read itself failed (rate limit, no permission)
me_pull_request_rule() {
  local base="$1" rules
  rules=$(gh api "repos/{owner}/{repo}/rules/branches/$base" 2>/dev/null) || { echo "null"; return 3; }
  jq -c '([.[] | select(.type == "pull_request")] | first).parameters // "null"' <<<"$rules" 2>/dev/null \
    || { echo "null"; return 3; }
}

# me_current_approval_count <pr> — NETWORK. Distinct-author APPROVED review
# count, latest review per author (GH-2443) — see me_approval_count above
# for what this is and is not evidence of. Prints the count on stdout.
#   exit 0  counted (0 is a valid, meaningful count)
#   exit 3  the reviews API could not be read
me_current_approval_count() {
  local pr="$1" raw reviews
  raw=$(gh api "repos/{owner}/{repo}/pulls/$pr/reviews" --paginate 2>/dev/null) || return 3
  reviews=$(jq -s 'add // []' <<<"$raw" 2>/dev/null) || return 3
  jq -r "$ME_JQ_LIB"' me_approval_count' <<<"$reviews" || return 3
}

# me_run_evidence_script <script> <pr> <head_sha> — NETWORK, via the callee.
# Runs a predicate script that prints one JSON object with an `ok` field
# (codex-review-evidence.sh). Prints that object on stdout.
#   exit 0  a well-formed object was returned (read .ok for the verdict)
#   exit 3  the script is missing, crashed, or printed something unusable
#
# Captured, not inherited: under `set -e` a crashed predicate would kill the
# CALLER mid-gate, and a runner would see no verdict token at all —
# indistinguishable from a gate that passed and then died. An unusable answer
# is never silently ok.
me_run_evidence_script() {
  local script="$1" pr="$2" head="$3" out rc _me_errexit_save
  [[ -x "$script" ]] || { echo "evidence script missing: $script"; return 3; }
  _me_noerrexit
  out=$("$script" "$pr" "$head" 2>&1)
  rc=$?
  _me_errexit_restore
  if [[ "$rc" -ne 0 ]] || ! jq -e 'type == "object" and has("ok")' >/dev/null 2>&1 <<<"$out"; then
    echo "evidence could not be evaluated (${script##*/} exit $rc): $(head -1 <<<"$out")"
    return 3
  fi
  echo "$out"
}
