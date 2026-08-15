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
#   findings — the reviewer has no APPROVED verb and emits severity-tagged
#              findings instead (Codex). Opted into by naming head_marker,
#              which is what binds the one scoped review to this head.
def me_policy:
  {
    attestationRequired: (.attestation.required // false),
    externalRequired:    (.external_review.required // false),
    bot:                 (.external_review.bot // "chatgpt-codex-connector[bot]"),
    trigger:             (.external_review.trigger // "@codex review"),
    headMarker:          (.external_review.head_marker // ""),
    exemptAuthors:       (.exempt_authors // [])
  }
  | .mode = (if .headMarker != "" then "findings" else "review" end);

# No policy file at all: gates 4-5 are off, so a repo that has not opted in
# merges through its own flow untouched. Same object shape, so no reader needs
# a second code path for the absent case.
def me_policy_none:
  {
    attestationRequired: false,
    externalRequired:    false,
    bot:                 "",
    trigger:             "",
    headMarker:          "",
    exemptAuthors:       [],
    mode:                "review"
  };

# Is this author waived? Normalized on both sides.
def me_exempt($author):
  ((.exemptAuthors // []) | map(me_norm) | index($author | me_norm)) != null;

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
def me_attestation_status($head):
  if . == null then "missing"
  elif ((.head_sha // "") != $head) then "stale"
  elif (((.tests // []) | (length > 0) and all(.exit_code == 0)) | not) then "no-tests"
  elif ((.review.verdict // "") == "") then "no-verdict"
  elif ((.review.verdict // "") != "APPROVED") then "rejected"
  else "ok" end;

def me_attestation_ok($head): me_attestation_status($head) == "ok";

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
  jq -c "$ME_JQ_LIB me_policy" "$file"
}

# me_policy_get <policy_json> <key> — one field, as a bare string.
me_policy_get() { jq -r --arg k "$2" '.[$k] | if type == "array" then tojson else tostring end' <<<"$1"; }

# me_is_exempt <policy_json> <author> — "true" / "false"
me_is_exempt() {
  jq -r "$ME_JQ_LIB"' me_exempt($a) | tostring' --arg a "$2" <<<"$1" 2>/dev/null || echo "false"
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

# me_attestation_status <comment_body> <head_sha> — one reason code (see the
# jq def). An unparseable payload is "missing", same as no payload at all:
# both mean there is no attestation to read.
me_attestation_status() {
  local payload
  payload=$(me_attestation_payload "$1")
  if [[ -z "$payload" ]] || ! jq -e . >/dev/null 2>&1 <<<"$payload"; then
    echo "missing"
    return 0
  fi
  jq -r "$ME_JQ_LIB"' me_attestation_status($h)' --arg h "$2" <<<"$payload"
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
  local pr="$1" bot="$2" head="$3" reviews count
  reviews=$(gh api "repos/{owner}/{repo}/pulls/$pr/reviews" --paginate 2>/dev/null | jq -s 'add // []') || return 3
  count=$(jq -r "$ME_JQ_LIB"' me_approved_reviews($bot; $head) | length' \
    --arg bot "$bot" --arg head "$head" <<<"$reviews") || return 3
  [[ "${count:-0}" -gt 0 ]]
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
