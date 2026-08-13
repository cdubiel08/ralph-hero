#!/usr/bin/env bash
# transport.test.sh — the adversarial suite for the Herdr boundary (GH-1774).
#
#   bash plugin/ralph-herdr/tests/transport.test.sh   # exits 0 on pass, 1 on fail
#
# Every other suite asks "does the plugin do the right thing when Herdr behaves".
# This one asks the opposite: what happens when the response is malformed,
# uncorrelated, mistyped, truncated, hostile, or belongs to another repository.
# The answers must all be some flavour of "refuse", and — the part that matters —
# refusing must be DISTINGUISHABLE from "the herd is empty".
#
# The failure this suite exists to prevent has one shape in every variation: a
# bad response becomes an empty list, an empty list reads as "no agents are
# running", and something then spawns a duplicate worker or cleans up a live
# one. So the assertions are mostly about return codes, not messages.
#
# No server, no sockets: tests/fake-herdr.sh replays fixtures, and .raw fixtures
# supply bodies that are deliberately not valid protocol. bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../scripts"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-transport-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

export HERDR_BIN_PATH="$SCRIPT_DIR/fake-herdr.sh"
export FAKE_HERDR_FIXTURES="$TMP/fixtures"
mkdir -p "$FAKE_HERDR_FIXTURES"

# A checkout with board config: repository scope is read from it, and the herd
# fixtures below join their agents to this root.
REPO_DIR="$TMP/repo"
mkdir -p "$REPO_DIR"
printf '{"owner":"acme","repo":"demo","projectNumber":1}\n' >"$REPO_DIR/.ralph.json"

# shellcheck source=../scripts/sanitize.sh
. "$SCRIPTS/sanitize.sh"
# shellcheck source=../scripts/transport.sh
. "$SCRIPTS/transport.sh"
# shellcheck source=../scripts/ledger.sh
. "$SCRIPTS/ledger.sh"
# shellcheck source=../scripts/scope.sh
. "$SCRIPTS/scope.sh"
# shellcheck source=herd-fixture.sh
. "$SCRIPT_DIR/herd-fixture.sh"

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1 — expected '$2', got '$3'"; fi
}
line_has() {
  case "$2" in *"$3"*) ok "$1" ;; *) not_ok "$1 — no '$3' in '$2'" ;; esac
}

# reset — clear every fixture so one case cannot leak into the next. Learned
# the hard way: an injected failure left behind in fleet.test.sh made a later
# case pass for entirely the wrong reason.
reset() { rm -f "$FAKE_HERDR_FIXTURES"/*; }

# call TYPE ARGS... — run the adapter, capturing stdout in OUT and rc in RC.
# Note the command substitution: this is how every real caller writes it, and
# it is exactly why the error code travels on stdout rather than in a variable
# (a variable set inside the substitution dies with its subshell).
call() {
  RC=0
  OUT=$(ralph_herdr_call "$@" 2>"$TMP/err") || RC=$?
  ERR=$(cat "$TMP/err")
}

# ═══ 1. the happy path, so the refusals below mean something ═════════════════
reset
call agent_list agent list
is "valid: agent_list accepted" "0" "$RC"
is "valid: the RESULT is returned, not the envelope" "agent_list" \
  "$(printf '%s' "$OUT" | jq -r '.type')"
is "valid: no envelope fields leak into the result" "null" \
  "$(printf '%s' "$OUT" | jq -r '.id // "null"')"

# Additive tolerance: a future Herdr adding fields must not break this plugin.
# Required-fields-only validation is the whole reason this is safe to assert.
reset
printf '{"agents":[],"some_future_field":{"nested":true}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-list.json"
call agent_list agent list
is "additive: unknown fields are ignored, not rejected" "0" "$RC"

# ═══ 2. malformed bodies at exit 0 ═══════════════════════════════════════════
# The headline case. Each of these exits 0, so anything keying off the exit
# status alone would sail straight through.
reset
printf 'not json at all\n' >"$FAKE_HERDR_FIXTURES/agent-list.raw"
call agent_list agent list
is "malformed: invalid JSON at exit 0 is a transport failure (rc 1)" "1" "$RC"
is "malformed: nothing is printed — no empty herd to mistake for a real one" "" "$OUT"

reset
printf '{"id":"cli:agent:list","result":{"type":"agent_list","agents":[]}}trailing garbage\n' \
  >"$FAKE_HERDR_FIXTURES/agent-list.raw"
call agent_list agent list
is "malformed: trailing non-JSON after a valid envelope is refused" "1" "$RC"

reset
# Two envelopes concatenated — a confused server, or two replies interleaved.
# Reading the first and ignoring the second would be answering a question with
# whichever reply happened to arrive first.
printf '{"id":"a","result":{"type":"agent_list","agents":[]}}\n{"id":"b","result":{"type":"agent_list","agents":[]}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-list.raw"
call agent_list agent list
is "malformed: two envelopes are refused, not silently halved" "1" "$RC"

reset
printf '[]\n' >"$FAKE_HERDR_FIXTURES/agent-list.raw"
call agent_list agent list
is "malformed: a bare array is not an envelope" "1" "$RC"

reset
: >"$FAKE_HERDR_FIXTURES/agent-list.raw"
call agent_list agent list
is "malformed: an empty body reads as unreachable (rc 3)" "3" "$RC"

# ═══ 3. correlation ══════════════════════════════════════════════════════════
reset
printf '{"result":{"type":"agent_list","agents":[]}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-list.raw"
call agent_list agent list
is "correlation: a response with no id is not protocol 19" "1" "$RC"
line_has "correlation: the refusal says why" "$ERR" "no correlation id"

reset
printf '{"id":"cli:agent:list-SOMETHING-ELSE"}\n' >"$FAKE_HERDR_FIXTURES/agent-list.json"
RC=0
OUT=$(RALPH_HERDR_EXPECT_ID="cli:agent:list" ralph_herdr_call agent_list agent list 2>"$TMP/err") || RC=$?
is "correlation: a reply to a DIFFERENT request id is refused" "1" "$RC"
line_has "correlation: the refusal names both ids" "$(cat "$TMP/err")" "refusing a response to a different request"

reset
call agent_list agent list
RC=0
OUT=$(RALPH_HERDR_EXPECT_ID="cli:agent:list" ralph_herdr_call agent_list agent list 2>/dev/null) || RC=$?
is "correlation: the MATCHING id is accepted" "0" "$RC"

# ═══ 4. result discriminants ═════════════════════════════════════════════════
reset
printf '{"agents":[]}\n' >"$FAKE_HERDR_FIXTURES/agent-list.json"
# The fixture supplies no type, but the fake composes the right one — so to
# test a MISSING discriminant the envelope has to be written raw.
printf '{"id":"cli:agent:list","result":{"agents":[]}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-list.raw"
call agent_list agent list
is "discriminant: a result with no type is refused" "1" "$RC"

reset
printf '{"type":"pane_info","agents":[]}\n' >"$FAKE_HERDR_FIXTURES/agent-list.json"
call agent_list agent list
is "discriminant: the WRONG result type is refused" "1" "$RC"
line_has "discriminant: the refusal names what came back" "$ERR" "returned result type 'pane_info'"

# An unknown type is a programming error, not a scenario: nobody has decided
# what "valid" means for it, so consuming it would be consuming an unvalidated
# response.
reset
call not_a_real_type agent list
is "discriminant: a type with no validation table fails closed" "1" "$RC"
line_has "discriminant: and says so" "$ERR" "no validation table"

# ═══ 5. required fields ══════════════════════════════════════════════════════
reset
printf '{"type":"agent_list"}\n' >"$FAKE_HERDR_FIXTURES/agent-list.json"
call agent_list agent list
is "required: agent_list without 'agents' is refused" "1" "$RC"

reset
printf '{"agents":null}\n' >"$FAKE_HERDR_FIXTURES/agent-list.json"
call agent_list agent list
is "required: an explicitly null 'agents' is refused" "1" "$RC"

# The subtlest one: present, non-null, and the wrong TYPE. `.agents[]` against
# an object yields zero iterations, which is indistinguishable from an empty
# herd unless something checks.
reset
printf '{"agents":{"not":"an array"}}\n' >"$FAKE_HERDR_FIXTURES/agent-list.json"
call agent_list agent list
is "required: 'agents' that is not an array is refused" "1" "$RC"
line_has "required: the refusal names the empty-list hazard" "$ERR" "refusing to read it as an empty list"

reset
printf '{"workspace":{},"tab":{},"root_pane":{"pane_id":"p1"}}\n' \
  >"$FAKE_HERDR_FIXTURES/worktree-create.json"
call worktree_created worktree create
is "required: worktree_created without 'worktree' is refused" "1" "$RC"

# ═══ 6. error envelopes are protocol, not corruption ═════════════════════════
reset
printf '{"error":{"code":"agent_pane_busy","message":"pane is busy"}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-start.json"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-start.rc"
call agent_started agent start w1-x --kind claude --pane p1
is "refusal: a well-formed error envelope is rc 2, not rc 1" "2" "$RC"
is "refusal: the code is preserved for callers to branch on" "agent_pane_busy" \
  "$(ralph_herdr_err_code "$OUT")"
is "refusal: the message is preserved too" "pane is busy" \
  "$(ralph_herdr_err_message "$OUT")"
is "refusal: the code survives a command substitution (subshell globals do not)" \
  "agent_pane_busy" "$(ralph_herdr_err_code "$(ralph_herdr_call agent_started agent start w1-x --kind claude --pane p1 2>/dev/null || true)")"

# Why rc 2 is worth separating from rc 1: the retry logic keys off it. Only a
# well-formed agent_pane_busy is a retryable race; a malformed response is
# never one, because we do not know whether the start landed.
reset
printf '{"error":{"code":"agent_name_taken","message":"taken"}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-start.json"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-start.rc"
call agent_started agent start w1-x --kind claude --pane p1
is "refusal: a different code is still rc 2" "2" "$RC"
is "refusal: and carries ITS code, not the last one" "agent_name_taken" "$(ralph_herdr_err_code "$OUT")"

# A refusal is only a refusal if it is SHAPED like one. These use .raw because
# the fake supplies a correlation id automatically, which is exactly why the
# missing-id case had no coverage before.
reset
printf '{"error":{"code":"nope","message":"no"}}\n' >"$FAKE_HERDR_FIXTURES/agent-start.raw"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-start.rc"
call agent_started agent start w1-x --kind claude --pane p1
is "refusal: an error envelope with NO correlation id is rc 1, not rc 2" "1" "$RC"

reset
printf '{"id":"cli:agent:start","error":{"message":"no code here"}}\n' >"$FAKE_HERDR_FIXTURES/agent-start.raw"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-start.rc"
call agent_started agent start w1-x --kind claude --pane p1
is "refusal: an error with no code is rc 1 — nothing to branch on" "1" "$RC"

reset
printf '{"id":"cli:agent:start","error":{"code":"","message":"empty"}}\n' >"$FAKE_HERDR_FIXTURES/agent-start.raw"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-start.rc"
call agent_started agent start w1-x --kind claude --pane p1
is "refusal: an EMPTY error code is rc 1" "1" "$RC"

# The regression that motivated the shape check: an empty message used to
# compose invalid JSON (`"message":` with no value), which silently emptied
# every downstream error-code read and turned a retryable refusal into a fatal.
reset
printf '{"error":{"code":"agent_pane_busy","message":""}}\n' >"$FAKE_HERDR_FIXTURES/agent-start.json"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-start.rc"
call agent_started agent start w1-x --kind claude --pane p1
is "refusal: an empty MESSAGE still yields a parseable body" "agent_pane_busy" \
  "$(ralph_herdr_err_code "$OUT")"
is "refusal: and the body is valid JSON" "0" \
  "$(printf '%s' "$OUT" | jq -e . >/dev/null 2>&1; echo $?)"

# ═══ 6b. a refusal arrives on STDERR (GH-1832) ═══════════════════════════════
# The real binary answers refusals on stderr with an empty stdout. Every case
# in section 6 above now travels that pipe, because the fake routes error
# envelopes there. These pin the behaviour explicitly, plus the invariants the
# stderr branch could plausibly break.
#
# The bug: stderr was discarded, so a refusal looked like silence and the
# adapter reported "server unreachable" — sending the reader to probe a server
# that was answering correctly the whole time.
reset
printf '{"error":{"code":"linked_worktree_source","message":"New and open worktree actions start from the repo parent workspace."}}\n' \
  >"$FAKE_HERDR_FIXTURES/worktree-create.json"
printf '1\n' >"$FAKE_HERDR_FIXTURES/worktree-create.rc"
call worktree_created worktree create --cwd /some/linked/worktree --branch feature/GH-1 --no-focus
is "stderr refusal: a refusal on stderr is rc 2, NOT rc 3 unreachable" "2" "$RC"
is "stderr refusal: the code is named" "linked_worktree_source" "$(ralph_herdr_err_code "$OUT")"
is "stderr refusal: the message is carried verbatim" \
  "New and open worktree actions start from the repo parent workspace." \
  "$(ralph_herdr_err_message "$OUT")"
case "$ERR" in
  *unreachable*) not_ok "stderr refusal: the diagnostic must not claim unreachability — got '$ERR'" ;;
  *) ok "stderr refusal: nothing claims the server was unreachable" ;;
esac

# stdout is the SUCCESS channel and stays authoritative: a successful call that
# also logged an error-shaped line to stderr must not be re-read as a refusal.
# Without the stdout-empty precondition this inverts a working call.
reset
printf '{"id":"cli:agent:list","error":{"code":"ignore_me","message":"stale stderr"}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-list.err"
call agent_list agent list
is "stderr refusal: a body on stdout wins — stderr is not consulted" "0" "$RC"
is "stderr refusal: and the result is the real one" "agent_list" \
  "$(printf '%s' "$OUT" | jq -r '.type')"

# A zero exit with an error envelope on stderr is incoherent — the real CLI
# pairs a refusal with a nonzero exit. Promoting it would let a stray log line
# on a call that SUCCEEDED (empty stdout, rc 0) masquerade as a protocol answer.
reset
printf '{"id":"cli:agent:list","error":{"code":"not_a_real_refusal","message":"rc 0"}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-list.err"
: >"$FAKE_HERDR_FIXTURES/agent-list.raw"
call agent_list agent list
is "stderr refusal: an error envelope at exit 0 is not promoted to a refusal" "3" "$RC"

# The shape checks apply on this channel too: an envelope with no correlation
# id is not a refusal, whichever pipe carried it.
reset
printf '{"error":{"code":"nope","message":"no id"}}\n' >"$FAKE_HERDR_FIXTURES/agent-list.err"
: >"$FAKE_HERDR_FIXTURES/agent-list.raw"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-list.rc"
call agent_list agent list
is "stderr refusal: an uncorrelated envelope on stderr is rc 1, not rc 2" "1" "$RC"

# Ordinary diagnostic noise is not protocol. It stays a failure — we still have
# no answer — but the message reports what was actually said instead of
# asserting a reachability verdict nobody tested.
reset
printf 'error: could not open the session socket\n' >"$FAKE_HERDR_FIXTURES/agent-list.err"
: >"$FAKE_HERDR_FIXTURES/agent-list.raw"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-list.rc"
call agent_list agent list
is "stderr noise: a non-envelope stderr is still a failure" "3" "$RC"
line_has "stderr noise: and the diagnostic quotes it" "$ERR" "could not open the session socket"

# Silence — nothing on either pipe — is the one case that HAS earned the word.
reset
: >"$FAKE_HERDR_FIXTURES/agent-list.raw"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-list.rc"
call agent_list agent list
is "silence: a truly empty response is rc 3" "3" "$RC"
line_has "silence: and only THIS case says unreachable" "$ERR" "herdr server unreachable"

# Terminal-derived prose reaches a human here, so it is sanitized like every
# other message the adapter emits.
reset
printf 'boom \033[31mred\033[0m and \033]0;title\007hijack\n' >"$FAKE_HERDR_FIXTURES/agent-list.err"
: >"$FAKE_HERDR_FIXTURES/agent-list.raw"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-list.rc"
call agent_list agent list
case "$ERR" in
  *$'\033'*) not_ok "stderr noise: escapes are stripped before the log — got '$ERR'" ;;
  *) ok "stderr noise: escapes are stripped before the log" ;;
esac
reset

# ═══ 7. incoherent exit status ═══════════════════════════════════════════════
# A valid success body that arrived with a nonzero exit. The real CLI pairs a
# nonzero exit with an ERROR body, so this means the process died partway
# through writing, or something that is not herdr answered.
reset
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-list.rc"
call agent_list agent list
is "incoherent: success body + nonzero exit is refused" "1" "$RC"
line_has "incoherent: named as contradictory" "$ERR" "contradictory response"

# ═══ 8. unreachable ══════════════════════════════════════════════════════════
reset
RC=0
OUT=$(HERDR_BIN_PATH="$TMP/definitely-not-here" ralph_herdr_call agent_list agent list 2>/dev/null) || RC=$?
is "unreachable: a missing binary is rc 3, distinct from malformed" "3" "$RC"

# ═══ 9. snapshot validation + capability gate ════════════════════════════════
reset
call session_snapshot api snapshot
is "snapshot: a valid snapshot is accepted" "0" "$RC"

reset
printf '{"snapshot":{"version":1,"protocol":18,"workspaces":[],"tabs":[],"panes":[],"layouts":[],"agents":[]}}\n' \
  >"$FAKE_HERDR_FIXTURES/api-snapshot.json"
RC=0; ralph_herdr_snapshot >/dev/null 2>"$TMP/err" || RC=$?
is "capability: an older protocol is refused" "1" "$RC"
line_has "capability: the refusal names both versions" "$(cat "$TMP/err")" "speaks protocol 18"

reset
printf '{"snapshot":{"version":1,"protocol":19,"workspaces":[],"tabs":[],"panes":[]}}\n' \
  >"$FAKE_HERDR_FIXTURES/api-snapshot.json"
RC=0; ralph_herdr_snapshot >/dev/null 2>"$TMP/err" || RC=$?
is "snapshot: a partial snapshot (no agents array) is refused" "1" "$RC"
line_has "snapshot: named as partial, not read as empty" "$(cat "$TMP/err")" "partial snapshot"

# A SUCCESSFUL call that also logged to stderr. The binary does this; the bug it
# provokes is in the caller, which is why the assertion is about the herd rather
# than the adapter: a consumer capturing with 2>&1 gets the diagnostic prepended
# to the JSON, jq rejects the value, and the scoped herd reads as empty —
# "I could not find out" silently rendered as "no agents are running".
reset
herd_fixture '[{"name":"w42-fix","agent_status":"working"}]' "$REPO_DIR"
printf 'warning: chatty but harmless\n' >"$FAKE_HERDR_FIXTURES/api-snapshot.err"
is "stderr noise: a successful snapshot still parses" "0" \
  "$(ralph_herdr_snapshot >/dev/null 2>&1; echo $?)"
is "stderr noise: and the herd is NOT emptied by it" "w42-fix" \
  "$(ralph_scoped_agents_now "$REPO_DIR" 2>/dev/null | jq -r '.name')"
rm -f "$FAKE_HERDR_FIXTURES/api-snapshot.err"

# ═══ 10. multi-repository containment ════════════════════════════════════════
# The acceptance criterion: two repositories in one Herdr session cannot
# discover or mutate each other's agents. Both name their worker `w42-fix`,
# because both number issues from 1 — the collision is structural, not unlucky.
reset
herd_fixture_foreign \
  '[{"name":"w42-fix","agent_status":"working"}]' \
  '[{"name":"w42-fix","agent_status":"blocked"},{"name":"w99-theirs","agent_status":"working"}]' \
  "$REPO_DIR"
agents=$(ralph_scoped_agents_now "$REPO_DIR" 2>/dev/null)
is "multi-repo: exactly one agent is in scope" "1" \
  "$(printf '%s\n' "$agents" | grep -c . || true)"
is "multi-repo: it is OURS — the one bound to our worktree" "working" \
  "$(printf '%s' "$agents" | jq -r '.status')"
is "multi-repo: the foreign same-named agent is invisible" "0" \
  "$(printf '%s\n' "$agents" | jq -rs '[.[] | select(.status == "blocked")] | length')"
is "multi-repo: the foreign repo's other agent is invisible too" "0" \
  "$(printf '%s\n' "$agents" | jq -rs '[.[] | select(.name == "w99-theirs")] | length')"
is "multi-repo: our agent resolved via worktree provenance, not cwd" "worktree" \
  "$(printf '%s' "$agents" | jq -r '.via')"

# A workspace whose provenance points elsewhere is a definite NO, never a
# fall-through to the weaker cwd tier — even when its cwd would have matched.
# This is the case that makes provenance a boundary rather than a hint.
reset
jq -nc --arg root "$REPO_DIR" '
  {snapshot: {version: 1, protocol: 19, tabs: [], layouts: [],
    workspaces: [{workspace_id: "wF", number: 1, label: "theirs", focused: false,
      pane_count: 1, tab_count: 1, active_tab_id: "wF:t1", agent_status: "unknown",
      worktree: {repo_key: "other/elsewhere", repo_name: "elsewhere",
                 repo_root: "/nowhere/else", checkout_path: "/nowhere/else",
                 is_linked_worktree: false}}],
    panes: [{pane_id: "pF", terminal_id: "t", workspace_id: "wF", tab_id: "wF:t1",
             focused: false, agent_status: "unknown", revision: 1, cwd: $root}],
    agents: [{name: "w7-sneaky", agent_status: "working", workspace_id: "wF",
              pane_id: "pF", tab_id: "wF:t1", terminal_id: "t", focused: false,
              revision: 1, cwd: $root}]}}' \
  >"$FAKE_HERDR_FIXTURES/api-snapshot.json"
is "provenance: a foreign worktree wins over a matching cwd" "0" \
  "$(ralph_scoped_agents_now "$REPO_DIR" 2>/dev/null | grep -c . || true)"

# The weakest tier is reachable only when there is NO provenance to contradict.
reset
jq -nc --arg root "$REPO_DIR" '
  {snapshot: {version: 1, protocol: 19, tabs: [], layouts: [],
    workspaces: [{workspace_id: "wR", number: 1, label: "root", focused: true,
      pane_count: 1, tab_count: 1, active_tab_id: "wR:t1", agent_status: "unknown"}],
    panes: [{pane_id: "pR", terminal_id: "t", workspace_id: "wR", tab_id: "wR:t1",
             focused: false, agent_status: "unknown", revision: 1, cwd: $root}],
    agents: [{name: "w8-rooted", agent_status: "working", workspace_id: "wR",
              pane_id: "pR", tab_id: "wR:t1", terminal_id: "t", focused: false,
              revision: 1}]}}' \
  >"$FAKE_HERDR_FIXTURES/api-snapshot.json"
is "provenance: a root workspace with no worktree resolves through the pane cwd" "cwd" \
  "$(ralph_scoped_agents_now "$REPO_DIR" 2>/dev/null | jq -r '.via')"

# A worker that cd'd into a subdirectory is still ours. Exact equality would
# hide it — and the spawn pre-check reads this, so hiding a live owner means
# attempting a duplicate spawn on an issue someone already holds.
reset
jq -nc --arg sub "$REPO_DIR/src" '
  {snapshot: {version: 1, protocol: 19, tabs: [], layouts: [],
    workspaces: [{workspace_id: "wR"}],
    panes: [{pane_id: "pR", terminal_id: "t", workspace_id: "wR", tab_id: "wR:t1",
             focused: false, agent_status: "unknown", revision: 1, cwd: $sub}],
    agents: [{name: "w8-deep", agent_status: "working", workspace_id: "wR",
              pane_id: "pR", tab_id: "wR:t1", terminal_id: "t", focused: false,
              revision: 1}]}}' \
  >"$FAKE_HERDR_FIXTURES/api-snapshot.json"
is "provenance: a pane cwd BENEATH the root still resolves to us" "w8-deep" \
  "$(ralph_scoped_agents_now "$REPO_DIR" 2>/dev/null | jq -r '.name')"

# ...but a sibling sharing a path prefix is not ours. This is what the boundary
# slash buys: /repo must never swallow /repo-other.
reset
jq -nc --arg sib "${REPO_DIR}-other" '
  {snapshot: {version: 1, protocol: 19, tabs: [], layouts: [],
    workspaces: [{workspace_id: "wR"}],
    panes: [{pane_id: "pR", terminal_id: "t", workspace_id: "wR", tab_id: "wR:t1",
             focused: false, agent_status: "unknown", revision: 1, cwd: $sib}],
    agents: [{name: "w9-sibling", agent_status: "working", workspace_id: "wR",
              pane_id: "pR", tab_id: "wR:t1", terminal_id: "t", focused: false,
              revision: 1}]}}' \
  >"$FAKE_HERDR_FIXTURES/api-snapshot.json"
is "provenance: a prefix-sharing sibling directory is NOT ours" "0" \
  "$(ralph_scoped_agents_now "$REPO_DIR" 2>/dev/null | grep -c . || true)"

# ═══ 11. null names and unresolvable provenance ══════════════════════════════
# On the dev machine 6 of 11 live agents have no name at all — this is routine.
reset
herd_fixture '[{"name":null,"agent_status":"working"},{"name":"w5-real","agent_status":"idle"}]' "$REPO_DIR"
is "null names: a nameless agent does not crash the join" "2" \
  "$(ralph_scoped_agents_now "$REPO_DIR" 2>/dev/null | grep -c . || true)"
is "null names: and is filtered out of the ralph-named herd" "w5-real" \
  "$(ralph_scoped_agents_now "$REPO_DIR" 2>/dev/null |
     jq -rs '[.[] | select(.name != null)] | map(select(.name | test("^w[0-9]"))) | .[0].name')"

reset
jq -nc '{snapshot: {version: 1, protocol: 19, tabs: [], layouts: [], workspaces: [],
  panes: [], agents: [{name: "w9-nowhere", agent_status: "working",
    workspace_id: "wGONE", pane_id: "pGONE", tab_id: "t", terminal_id: "t",
    focused: false, revision: 1}]}}' \
  >"$FAKE_HERDR_FIXTURES/api-snapshot.json"
is "orphaned: an agent whose workspace and pane are both gone is out of scope" "0" \
  "$(ralph_scoped_agents_now "$REPO_DIR" 2>/dev/null | grep -c . || true)"

# ═══ 12. moved panes ═════════════════════════════════════════════════════════
# Pane ids are opaque and change when a pane moves. Scope must survive that,
# because the workspace binding — not the pane — is what carries provenance.
reset
herd_fixture '[{"name":"w42-fix","agent_status":"working","pane_id":"pBEFORE"}]' "$REPO_DIR"
before=$(ralph_scoped_agents_now "$REPO_DIR" 2>/dev/null | jq -r '.pane')
herd_fixture '[{"name":"w42-fix","agent_status":"working","pane_id":"pAFTER"}]' "$REPO_DIR"
after=$(ralph_scoped_agents_now "$REPO_DIR" 2>/dev/null | jq -r '.pane')
is "moved pane: the pane id genuinely changed" "pBEFORE pAFTER" "$before $after"
is "moved pane: the agent stays in scope across the move" "1" \
  "$(ralph_scoped_agents_now "$REPO_DIR" 2>/dev/null | grep -c . || true)"

# ═══ 13. terminal control sequences in display data ══════════════════════════
# Agent titles, statuses and error prose come from a terminal another process
# controls. Rendered raw, they repaint the very view meant to report on them.
esc=$(printf '\033')
bel=$(printf '\007')
is "sanitize: CSI colour sequences are stripped" "red text" \
  "$(ralph_sanitize "${esc}[31mred text${esc}[0m")"
is "sanitize: an OSC window-title hijack is stripped" "safe" \
  "$(ralph_sanitize "${esc}]0;PWNED${bel}safe")"
is "sanitize: OSC terminated by ST is stripped too" "safe" \
  "$(ralph_sanitize "${esc}]0;PWNED${esc}\\safe")"
is "sanitize: a full terminal reset (ESC c) is stripped" "after" \
  "$(ralph_sanitize "${esc}cafter")"
is "sanitize: erase-in-display cannot blank the herd list" "kept" \
  "$(ralph_sanitize "${esc}[2J${esc}[Hkept")"
is "sanitize: a newline cannot forge a second log line" "line onefake row" \
  "$(ralph_sanitize "$(printf 'line one\nfake row')")"
is "sanitize: backspace overstrike is stripped" "abc" \
  "$(ralph_sanitize "$(printf 'ab\bc')")"
is "sanitize: 8-bit C1 CSI (UTF-8 U+009B) is stripped with its parameters" "plain" \
  "$(ralph_sanitize "$(printf '\302\23331mplain')")"
is "sanitize: tabs survive — they carry column meaning" "a	b" \
  "$(ralph_sanitize "$(printf 'a\tb')")"
is "sanitize: ordinary text is untouched" "w42-fix working" \
  "$(ralph_sanitize "w42-fix working")"
is "sanitize: a value that is entirely escapes becomes empty, not an error" "" \
  "$(ralph_sanitize "${esc}[31m${esc}[0m")"

# The path that matters: hostile text arriving through an ERROR envelope, which
# is rendered into logs the human reads while diagnosing a failure.
reset
# \u001b, not a raw ESC: a literal control byte inside a JSON string is invalid
# JSON, and the fake rejects invalid fixtures outright (that is what .raw is
# for). The hostile payload has to be well-formed JSON to reach the sanitizer.
printf '{"error":{"code":"bad","message":"\\u001b[2Joops"}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-start.json"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-start.rc"
call agent_started agent start w1-x --kind claude --pane p1
is "sanitize: error prose is scrubbed before it reaches a caller" "oops" \
  "$(ralph_herdr_err_message "$OUT")"

# ═══ 14. session keys ════════════════════════════════════════════════════════
k_default=$(RALPH_HERDR_SESSION= HERDR_SOCKET_PATH= HERDR_SESSION= ralph_session_key)
k_named=$(RALPH_HERDR_SESSION=other ralph_session_key)
k_socket=$(RALPH_HERDR_SESSION= HERDR_SOCKET_PATH=/tmp/a.sock ralph_session_key)
is "session key: the default session has one" "1" \
  "$([ -n "$k_default" ] && echo 1 || echo 0)"
is "session key: a named session differs from the default" "1" \
  "$([ "$k_named" != "$k_default" ] && echo 1 || echo 0)"
is "session key: an explicit socket differs again" "1" \
  "$([ "$k_socket" != "$k_default" ] && [ "$k_socket" != "$k_named" ] && echo 1 || echo 0)"
is "session key: stable across calls" "$k_named" "$(RALPH_HERDR_SESSION=other ralph_session_key)"

# ═══ 15. repository scope ════════════════════════════════════════════════════
is "repo scope: three components, host defaulted" "github.com/acme/demo" \
  "$(ralph_repo_scope "$REPO_DIR")"
RC=0; ralph_repo_scope "$TMP" >/dev/null 2>&1 || RC=$?
is "repo scope: a directory with no board config refuses rather than defaulting" "1" "$RC"

echo "1..$n"
echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
