#!/usr/bin/env bash
# spawn.test.sh — tests for lib.sh's Phase-2 spawn-path additions (TAP-ish).
#
#   bash plugin/ralph-herdr/tests/spawn.test.sh    # exits 0 on pass, 1 on fail
#
# Covers ralph_depth_guard (fixture ledger, no herdr) and the dry-run spawn
# plan's C7 spawn record + token line (stub herdr binary — no server, no
# board mutation, no writes outside $TMP). bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-spawn-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

# The shared fake, not an ad-hoc stub: it composes protocol-19 envelopes (id +
# result.type + required fields), which the transport adapter now demands. A
# local stub answering the pre-protocol `{"result":{"agents":[]}}` shape would
# be asserting against a response the real server cannot produce.
#
# The spawn path's ownership pre-check reads the session snapshot (an empty
# herd by default here); dry-run stops before any other call.
export HERDR_BIN_PATH="$SCRIPT_DIR/fake-herdr.sh"
export FAKE_HERDR_FIXTURES="$TMP/fixtures"
mkdir -p "$FAKE_HERDR_FIXTURES"
export RALPH_HERDR_REPO="$ROOT"
# The healthy post-prompt world (GH-1926): the agent left idle and a turn is
# running. The fake's bare default is `idle` — correct as a default, since a
# spawn that cannot demonstrate a started turn must fail — so every live-spawn
# case here states the healthy answer explicitly, and the unhealthy ones
# override it below.
printf '{"agent":{"name":"w","agent_status":"working","pane_id":"p1","workspace_id":"w1","tab_id":"w1:t1","terminal_id":"term_fake","focused":false,"revision":9}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-wait-until.json"
export RALPH_HERDR_LEDGER="$TMP/ledger/ledger.jsonl"
# Isolate the D3 lock pre-check from the machine's real ~/.ralph/sessions —
# a genuinely live lock there would skip a test spawn and read as a failure.
export RALPH_HERDR_SESSIONS_DIR="$TMP/sessions"
mkdir -p "$TMP/sessions"

# The spawn path derives its branch from `board name` (GH-1858). Point it at
# the shim so the dry-run plan stays offline — the real CLI would fetch the
# issue from GitHub for a name a unit test has no business needing.
export RALPH_HERDR_BOARD="$SCRIPT_DIR/fake-board.sh"
export FAKE_BOARD_FIXTURES="$TMP/board-fixtures"
mkdir -p "$FAKE_BOARD_FIXTURES"

# lib.sh sets -euo pipefail at source time; the harness needs to observe
# failures, not die on them.
# shellcheck source=../scripts/lib.sh
. "$SCRIPT_DIR/../scripts/lib.sh"
# shellcheck source=herd-fixture.sh
. "$SCRIPT_DIR/herd-fixture.sh"
set +e
set +o pipefail

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1 — expected '$2', got '$3'"; fi
}
fails() {
  local desc="$1" out rc=0
  shift
  out=$("$@" 2>/dev/null) || rc=$?
  if [ "$rc" -ne 0 ]; then ok "$desc"; else not_ok "$desc — expected failure, got rc 0 ('$out')"; fi
}

# ── ralph_depth_guard ────────────────────────────────────────────────────────
mkdir -p "$TMP/ledger"
cat >"$RALPH_HERDR_LEDGER" <<'EOF'
{"ts":"2026-08-11T00:00:00Z","ev":"spawn","agent_ref":"o10-orch#aaaa","tokens":{"role":"o","issue":"10","slug":"orch","depth":"0","state":"spawned"}}
{"ts":"2026-08-11T00:01:00Z","ev":"spawn","agent_ref":"w11-child#bbbb","tokens":{"role":"w","issue":"11","slug":"child","depth":"1","state":"spawned"}}
{"ts":"2026-08-11T00:02:00Z","ev":"spawn","agent_ref":"w12-grand#cccc","tokens":{"role":"w","issue":"12","slug":"grand","depth":"2","state":"spawned"}}
{"ts":"2026-08-11T00:03:00Z","ev":"discover","agent_ref":"w13-found#dddd","tokens":{"role":"w","issue":"13","slug":"found"}}
EOF

is "depth: empty parent is a root spawn (depth 0)" "0" "$(ralph_depth_guard '')"
is "depth: '-' parent is a root spawn too" "0" "$(ralph_depth_guard -)"
is "depth: child of a depth-0 parent is depth 1" "1" "$(ralph_depth_guard 'o10-orch#aaaa')"
is "depth: child of a depth-1 parent is depth 2" "2" "$(ralph_depth_guard 'w11-child#bbbb')"
fails "depth: a depth-2 parent is refused (cap: 3 levels)" ralph_depth_guard 'w12-grand#cccc'
is "depth: discovered parent (no depth token) is treated as a root" "1" "$(ralph_depth_guard 'w13-found#dddd')"
is "depth: unledgered parent is treated as a root" "1" "$(ralph_depth_guard 'w99-nowhere#eeee')"
is "depth: bare-name parent matches its ledger records" "1" "$(ralph_depth_guard 'o10-orch')"

# ── dry-run spawn plan: C7 spawn record + tokens ─────────────────────────────
QUEUE='{"next":{"number":123,"title":"Fix the flaky test","parentNumber":45},"queue":[]}'
out=$(RALPH_HERDR_DRY_RUN=true spawn_work_session 123 "$QUEUE" 2>&1)
rc=$?
is "dry-run: spawn plan exits 0" "0" "$rc"

record=$(printf '%s\n' "$out" | sed -n 's/^  ledger append (spawn): //p')
if [ -n "$record" ] && jq -e . >/dev/null 2>&1 <<<"$record"; then
  ok "dry-run: plan carries a JSON spawn record"
else
  not_ok "dry-run: plan carries a JSON spawn record — got '$record'"
fi

jqr() { jq -r "$1" <<<"$record" 2>/dev/null; }
is "record: ev is spawn"                     "spawn"          "$(jqr '.ev')"
is "record: no pane_id in a dry-run plan"    "false"          "$(jqr 'has("pane_id")')"
is "record: lineage contract"                "ralph.lineage"  "$(jqr '.lineage.contract')"
is "record: lineage contract_version"        "1"              "$(jqr '.lineage.contract_version')"
is "record: issue is a number"               "123"            "$(jqr '.lineage.issue')"
is "record: parent_issue from the queue"     "45"             "$(jqr '.lineage.parent_issue')"
is "record: plane is herdr"                  "herdr"          "$(jqr '.lineage.plane')"
is "record: invoked_by is human"             "human"          "$(jqr '.lineage.spawner.invoked_by')"
is "record: worktree branch is the board's grammar" "feat/123-fake-issue" "$(jqr '.lineage.herdr.worktree_branch')"
is "record: workspace label is the address's display suffix (GH-2235)" "w123-fake-issue" "$(jqr '.lineage.herdr.workspace_label')"
is "record: ts equals spawned_at"            "$(jqr '.ts')"   "$(jqr '.lineage.spawned_at')"
is "record: token role is the FLEET role, not the lane (GH-1808)" "driver" "$(jqr '.tokens.role')"
is "record: lineage carries the role too"    "driver"         "$(jqr '.lineage.role')"
is "record: token issue (string)"            "123"            "$(jqr '.tokens.issue')"
is "record: token slug"                      "fix-the-flaky-test" "$(jqr '.tokens.slug')"
is "record: token depth 0 (human root)"      "0"              "$(jqr '.tokens.depth')"
is "record: token state spawned"             "spawned"        "$(jqr '.tokens.state')"
is "record: token harness claude"            "claude"         "$(jqr '.tokens.harness')"
is "record: no parent token on a root spawn" "false"          "$(jqr '.tokens | has("parent")')"
is "record: address token is the board's herd address (GH-2209)" "fake-repo/w123-fake-issue" "$(jqr '.tokens.address')"
is "record: root token is the agent's own ref" "$(jqr '.agent_ref')" "$(jqr '.tokens.root')"
is "record: spawn_epoch token matches the ref" "$(jqr '.agent_ref' | sed 's/^.*#//')" "$(jqr '.tokens.spawn_epoch')"

case "$(jqr '.agent_ref')" in
  w123-fix-the-flaky-test\#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
    ok "record: agent_ref is name#epoch" ;;
  *)
    not_ok "record: agent_ref is name#epoch — got '$(jqr '.agent_ref')'" ;;
esac

# Dry-run is a plan, never a mutation: nothing may have been appended.
first_ledger_line=$(head -1 "$RALPH_HERDR_LEDGER")
is "dry-run: ledger untouched (line count)" "4" "$(wc -l <"$RALPH_HERDR_LEDGER" | tr -d ' ')"
is "dry-run: ledger untouched (content)" \
  '{"ts":"2026-08-11T00:00:00Z","ev":"spawn","agent_ref":"o10-orch#aaaa","tokens":{"role":"o","issue":"10","slug":"orch","depth":"0","state":"spawned"}}' \
  "$first_ledger_line"

# ── label fallback: a board copy with no address keeps the legacy spelling ──
# (GH-2210): the canonical label is the herd address; against an older board
# whose `name` envelope has no .address, the nesting spelling survives and no
# address token is stamped.
printf '{"number":77,"kind":"feat","lane":"w","branch":"feat/77-old","worktree":"feat-77-old","agent":"w77-old","legacyBranch":"feature/GH-77"}\n' \
  >"$FAKE_BOARD_FIXTURES/name.77.json"
OLD_QUEUE='{"next":{"number":77,"title":"Old board","parentNumber":9},"queue":[]}'
old_out=$(RALPH_HERDR_DRY_RUN=true spawn_work_session 77 "$OLD_QUEUE" 2>&1)
old_record=$(printf '%s\n' "$old_out" | sed -n 's/^  ledger append (spawn): //p')
is "label fallback: pre-grammar board keeps the nesting label" "GH-77 via GH-9" \
  "$(jq -r '.lineage.herdr.workspace_label' <<<"$old_record" 2>/dev/null)"
is "label fallback: no address token stamped" "false" \
  "$(jq -r '.tokens | has("address")' <<<"$old_record" 2>/dev/null)"
rm -f "$FAKE_BOARD_FIXTURES/name.77.json"

# The exported read-backs (run in THIS shell, not a subshell, to see them).
RALPH_HERDR_DRY_RUN=true spawn_work_session 123 "$QUEUE" >/dev/null 2>&1
is "dry-run: RALPH_HERDR_SPAWNED_AGENT exported" "w123-fix-the-flaky-test" "$RALPH_HERDR_SPAWNED_AGENT"
case "$RALPH_HERDR_SPAWNED_REF" in
  "$RALPH_HERDR_SPAWNED_AGENT"\#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
    ok "dry-run: RALPH_HERDR_SPAWNED_REF exported as name#epoch" ;;
  *)
    not_ok "dry-run: RALPH_HERDR_SPAWNED_REF exported as name#epoch — got '$RALPH_HERDR_SPAWNED_REF'" ;;
esac

# ── ralph_worktree_source_dir: ASK herdr for the source (GH-1832, GH-1860) ───
# herdr refuses `worktree create`/`open` when --cwd is a LINKED worktree, and
# $REPO defaults to $PWD — which is always a linked worktree when an agent
# spawns an agent, because that is where /ralph:work runs.
#
# The source is READ from `worktree list`, not derived locally: herdr owns the
# rule about which checkout it will start from, and a local `git worktree list`
# answers a related-but-different question (the main GIT worktree). These tests
# therefore assert the herdr contract, not a git one.
is "source dir: resolved from herdr's source_checkout_path" \
  "/tmp/fake-herdr-parent" "$(ralph_worktree_source_dir "$TMP/anywhere")"

# --cwd is load-bearing: without it herdr answers from its own session context
# rather than the directory we asked about, which for a background spawn could
# resolve a source in the WRONG repository. Asserted on the recorded argv.
FAKE_HERDR_LOG="$TMP/argv.log" ralph_worktree_source_dir "$TMP/some/checkout" >/dev/null
line_has_arg=$(grep 'worktree list' "$TMP/argv.log" 2>/dev/null | head -1)
case "$line_has_arg" in
  *"--cwd $TMP/some/checkout"*)
    ok "source dir: the query is scoped with --cwd, never left to session context" ;;
  *)
    not_ok "source dir: the query is scoped with --cwd — got '$line_has_arg'" ;;
esac
rm -f "$TMP/argv.log"

# A refusal (a non-repo cwd answers not_git_worktree) falls back to the input.
# The caller is about to make a worktree call against the same server, so that
# call surfaces herdr's own code — better than a path invented here.
printf '{"error":{"code":"not_git_worktree","message":"Herdr worktree actions require a path inside a Git work tree"}}\n' \
  >"$FAKE_HERDR_FIXTURES/worktree-list.json"
printf '1\n' >"$FAKE_HERDR_FIXTURES/worktree-list.rc"
is "source dir: a refused query falls back to the directory itself" \
  "$TMP/notgit" "$(ralph_worktree_source_dir "$TMP/notgit")"
rm -f "$FAKE_HERDR_FIXTURES/worktree-list.json" "$FAKE_HERDR_FIXTURES/worktree-list.rc"

# A response missing the path is not a source. Falling back beats printing an
# empty --cwd, which herdr would answer with a far less obvious error.
printf '{"source":{"repo_key":"k","repo_name":"n","repo_root":"/r"},"worktrees":[]}\n' \
  >"$FAKE_HERDR_FIXTURES/worktree-list.json"
is "source dir: a source with no checkout path falls back too" \
  "$TMP/notgit" "$(ralph_worktree_source_dir "$TMP/notgit")"
rm -f "$FAKE_HERDR_FIXTURES/worktree-list.json"

# The dry-run plan must print the cwd the live path would use. A plan naming
# $REPO while the spawn sends the parent workspace is a plan you cannot debug
# from — and the misleading plan is half of what made GH-1832 expensive.
_saved_repo="$REPO"
REPO="$TMP/linked-worktree"
plan=$(RALPH_HERDR_DRY_RUN=true spawn_work_session 123 "$QUEUE" 2>&1)
REPO="$_saved_repo"
create_line=$(printf '%s\n' "$plan" | grep -- 'worktree create' | head -1)
case "$create_line" in
  *"--cwd /tmp/fake-herdr-parent "*)
    ok "dry-run plan: worktree create --cwd is herdr's source checkout" ;;
  *)
    not_ok "dry-run plan: worktree create --cwd is herdr's source checkout — got '$create_line'" ;;
esac
case "$create_line" in
  *"$TMP/linked-worktree"*)
    not_ok "dry-run plan: the linked worktree must not appear as --cwd — got '$create_line'" ;;
  *)
    ok "dry-run plan: the linked worktree is not offered as --cwd" ;;
esac

# ── the create-failure line names the code, not a guess (GH-1832) ────────────
# The old text asserted "existing checkout is the usual cause" without checking.
# When the real cause was the linked-worktree cwd, that guess sent the reader
# hunting for a checkout that did not exist. A live (non-dry-run) spawn against
# a fake that refuses BOTH calls, so the terminal message is the one under test.
ORIGIN="$TMP/origin.git"
SPAWNREPO="$TMP/spawnrepo"
(
  git init -q --bare "$ORIGIN"
  git clone -q "$ORIGIN" "$SPAWNREPO" 2>/dev/null
  cd "$SPAWNREPO" || exit 1
  git config user.email t@example.com
  git config user.name t
  git commit -q --allow-empty -m init
  git branch -M main
  git push -q origin main
) >/dev/null 2>&1

if git -C "$SPAWNREPO" rev-parse --verify -q origin/main >/dev/null 2>&1; then
  printf '{"error":{"code":"linked_worktree_source","message":"New and open worktree actions start from the repo parent workspace."}}\n' \
    >"$FAKE_HERDR_FIXTURES/worktree-create.json"
  printf '1\n' >"$FAKE_HERDR_FIXTURES/worktree-create.rc"
  printf '{"error":{"code":"worktree_branch_missing","message":"no such branch"}}\n' \
    >"$FAKE_HERDR_FIXTURES/worktree-open.json"
  printf '1\n' >"$FAKE_HERDR_FIXTURES/worktree-open.rc"

  _saved_repo="$REPO"
  REPO="$SPAWNREPO"
  spawn_out=$(spawn_work_session 777 '' 2>&1)
  spawn_rc=$?
  REPO="$_saved_repo"
  rm -f "$FAKE_HERDR_FIXTURES/worktree-create.json" "$FAKE_HERDR_FIXTURES/worktree-create.rc" \
    "$FAKE_HERDR_FIXTURES/worktree-open.json" "$FAKE_HERDR_FIXTURES/worktree-open.rc"

  is "spawn failure: a refused worktree create fails the spawn" "1" "$spawn_rc"
  case "$spawn_out" in
    *linked_worktree_source*) ok "spawn failure: the create refusal names the server's code" ;;
    *) not_ok "spawn failure: the create refusal names the server's code — got '$spawn_out'" ;;
  esac
  case "$spawn_out" in
    *worktree_branch_missing*) ok "spawn failure: the open refusal names ITS code too" ;;
    *) not_ok "spawn failure: the open refusal names ITS code too — got '$spawn_out'" ;;
  esac
  case "$spawn_out" in
    *"existing checkout"*) not_ok "spawn failure: must not assert a cause it did not check — got '$spawn_out'" ;;
    *) ok "spawn failure: no unchecked cause is asserted" ;;
  esac
  case "$spawn_out" in
    *unreachable*) not_ok "spawn failure: a refusal is not a reachability claim — got '$spawn_out'" ;;
    *) ok "spawn failure: a refusal is not reported as an unreachable server" ;;
  esac
else
  not_ok "spawn failure: origin/main fixture could not be built"
fi

# ── the one-writer invariant: a deterministic race schedule (GH-1776) ────────
#
# The invariant: only one worker may write into a worktree at a time. It holds
# by construction through three layers — issue <-> branch <-> worktree is 1:1,
# herdr refuses a duplicate agent name server-side, and the board claim is
# read-back verified. The name mutex is the layer that wins an actual race, and
# it is the only one testable without a server or a board, so this pins it.
#
# Concurrency is not simulated with real processes — a race that only fails
# sometimes is not a test. The schedule below IS the interleaving, replayed
# deterministically: each step sets the world the fake reports, then runs the
# spawn that observes it.
#
#   1. A and B both read the herd. It is EMPTY — the `w<N>-*` pre-check is
#      advisory and fails open, so both pass it. This is the window.
#   2. A reaches `agent start` first and wins the name.
#   3. B reaches `agent start` and the server refuses: agent_name_taken.
#   4. B re-reads the herd, confirms A is live, and returns rc 2 — leaving the
#      worktree pane to A. It must NOT improvise a `--2` sibling, must not
#      prompt, and must not ledger a second worker.
#
# The assertion that matters is step 4: ONE agent prompt across both spawns.
if git -C "$SPAWNREPO" rev-parse --verify -q origin/main >/dev/null 2>&1; then
  RQUEUE='{"next":{"number":900,"title":"Race the spawn"},"queue":[]}'
  RNAME="w900-race-the-spawn"
  RACE_LEDGER="$TMP/race/ledger.jsonl"
  mkdir -p "$TMP/race"
  _saved_repo="$REPO"
  _saved_ledger="$RALPH_HERDR_LEDGER"
  REPO="$SPAWNREPO"
  RALPH_HERDR_LEDGER="$RACE_LEDGER"
  export FAKE_HERDR_LOG="$TMP/race.log"
  : >"$FAKE_HERDR_LOG"

  # Step 1+2 — the herd is empty, so A's pre-check passes and its start wins.
  herd_fixture '[]' "$SPAWNREPO"
  a_out=$(RALPH_HERDR_AGENT_LIVE= spawn_work_session 900 "$RQUEUE" 2>&1)
  a_rc=$?
  is "race: the first spawn wins (rc 0)" "0" "$a_rc"
  case "$a_out" in
    *"SKIP"*) not_ok "race: the winner actually spawned — got '$a_out'" ;;
    *) ok "race: the winner actually spawned" ;;
  esac

  # Step 3+4 — B started before A won, so its pre-check ALSO saw the empty
  # herd. Modelling that needs the snapshot to change mid-spawn: B must read an
  # empty herd at the pre-check and a herd containing A at the confirming read
  # after `agent start` refuses. A shim in front of the fake advances the world
  # on the second snapshot call, which IS the interleaving — written down once,
  # replayed identically every run, rather than hoped for from real processes.
  herd_fixture "$(jq -nc --arg n "$RNAME" '[{name: $n, agent_status: "working"}]')" "$SPAWNREPO"
  mv "$FAKE_HERDR_FIXTURES/api-snapshot.json" "$TMP/race-winner-snapshot.json"
  herd_fixture '[]' "$SPAWNREPO"
  cat >"$TMP/race-herdr.sh" <<'SHIM'
#!/usr/bin/env bash
# The pre-check reads the herd, then `agent start` runs, then the confirming
# read runs. Swap in the winner's herd on the SECOND snapshot — that is the
# window in which A takes the name.
if [ "${1-}" = "api" ] && [ "${2-}" = "snapshot" ]; then
  _n=$(cat "$RACE_SNAP_COUNT" 2>/dev/null || echo 0)
  _n=$((_n + 1))
  echo "$_n" >"$RACE_SNAP_COUNT"
  [ "$_n" -ge 2 ] && cp "$RACE_WINNER_SNAP" "$FAKE_HERDR_FIXTURES/api-snapshot.json"
fi
exec "$RACE_REAL_FAKE" "$@"
SHIM
  chmod +x "$TMP/race-herdr.sh"
  export RACE_SNAP_COUNT="$TMP/race-snap.count"
  export RACE_WINNER_SNAP="$TMP/race-winner-snapshot.json"
  export RACE_REAL_FAKE="$SCRIPT_DIR/fake-herdr.sh"
  : >"$RACE_SNAP_COUNT"

  # The server's answer when the name is already taken. Paired with a .rc so
  # the fake routes it the way 0.8.x does — envelope on stderr, nonzero exit.
  printf '{"error":{"code":"agent_name_taken","message":"an agent named %s already exists"}}\n' \
    "$RNAME" >"$FAKE_HERDR_FIXTURES/agent-start.$RNAME.json"
  printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-start.rc"

  b_out=$(HERDR_BIN_PATH="$TMP/race-herdr.sh" RALPH_HERDR_AGENT_LIVE= spawn_work_session 900 "$RQUEUE" 2>&1)
  b_rc=$?

  is "race: the loser returns rc 2, not a failure and not a second worker" "2" "$b_rc"
  case "$b_out" in
    *"lost the spawn race"*) ok "race: the loser says which race it lost" ;;
    *) not_ok "race: the loser says which race it lost — got '$b_out'" ;;
  esac
  case "$b_out" in
    *"$RNAME--2"* | *"--2 "*) not_ok "race: no --N sibling was improvised — got '$b_out'" ;;
    *) ok "race: no --N sibling was improvised" ;;
  esac
  # Both attempts asked for the SAME name — which is what lets the server's
  # name mutex arbitrate at all. Two starts here is the race, not a bug; the
  # invariant is about how many of them ended up with a worker.
  is "race: both attempts contended for one name" "2" \
    "$(grep -c "^agent start $RNAME " "$FAKE_HERDR_LOG" 2>/dev/null | tr -d ' ')"
  is "race: exactly one worker was prompted — the invariant" "1" \
    "$(grep -c "^agent prompt $RNAME " "$FAKE_HERDR_LOG" 2>/dev/null | tr -d ' ')"
  # Two spawn records now reach the ledger — the loser's is PROVISIONAL
  # (written at pane creation, audit D2b, so a spawner killed pre-start still
  # leaves a sweepable row) — but the invariant survives at the level that
  # matters: exactly ONE record is OPEN, and the loser's is closed with the
  # honest reason rather than left for a sweep to prove.
  is "race: exactly one OPEN spawn record — the invariant" "1" \
    "$(RALPH_HERDR_LEDGER="$RACE_LEDGER" ralph_ledger_open_agents | grep -c . | tr -d ' ')"
  is "race: the loser's provisional record is closed never_started" "1" \
    "$(_ralph_ledger_events "$RACE_LEDGER" 2>/dev/null | jq -s '[.[] | select(.ev == "exit" and .reason == "never_started" and .via == "spawn")] | length')"

  # The pre-check catches the ordinary (non-racing) case earlier and cheaper:
  # B arrives after A is visible, so it never touches the server at all.
  : >"$FAKE_HERDR_LOG"
  c_out=$(RALPH_HERDR_AGENT_LIVE= spawn_work_session 900 "$RQUEUE" 2>&1)
  c_rc=$?
  is "race: an already-visible owner is skipped before any mutation" "2" "$c_rc"
  case "$c_out" in
    *"SKIP $RNAME already live"*) ok "race: the skip names the owner" ;;
    *) not_ok "race: the skip names the owner — got '$c_out'" ;;
  esac
  is "race: the skip made no worktree call" "0" \
    "$(grep -c '^worktree ' "$FAKE_HERDR_LOG" 2>/dev/null | tr -d ' ')"

  # And the fail-CLOSED direction: an unreadable herd cannot prove nobody owns
  # the issue, so the spawn is refused rather than risking the second writer.
  printf 'not json at all\n' >"$FAKE_HERDR_FIXTURES/api-snapshot.raw"
  d_out=$(RALPH_HERDR_AGENT_LIVE= spawn_work_session 900 "$RQUEUE" 2>&1)
  d_rc=$?
  is "race: an unreadable herd refuses the spawn (fail-closed)" "1" "$d_rc"
  case "$d_out" in
    *"cannot read the herd"*) ok "race: the refusal names the unproven condition" ;;
    *) not_ok "race: the refusal names the unproven condition — got '$d_out'" ;;
  esac
  rm -f "$FAKE_HERDR_FIXTURES/api-snapshot.raw" "$FAKE_HERDR_FIXTURES/api-snapshot.json" \
    "$FAKE_HERDR_FIXTURES/agent-start.$RNAME.json" "$FAKE_HERDR_FIXTURES/agent-start.rc"
  unset FAKE_HERDR_LOG
  REPO="$_saved_repo"
  RALPH_HERDR_LEDGER="$_saved_ledger"
  unset RALPH_HERDR_AGENT_LIVE
else
  not_ok "race: origin/main fixture could not be built"
fi

# ── spawn_turn_started: delivered ≠ submitted (GH-1926) ─────────────────────
# The observed defect: `agent prompt` returned 0, the text sat unsubmitted in
# the pane's input, and the fleet counted the slot as working for twelve
# minutes. Every assertion below is about the STATUS the wait woke on — an
# exit code alone is the conflation this whole block exists to close.
is "turn: a working agent is a started turn" "0" \
  "$(spawn_turn_started w900-race-the-spawn >/dev/null 2>&1; echo $?)"

# blocked = a turn that started and is waiting on a human. Started is started.
printf '{"agent":{"name":"w","agent_status":"blocked","pane_id":"p1","workspace_id":"w1","tab_id":"w1:t1","terminal_id":"term_fake","focused":false,"revision":9}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-wait-until.json"
is "turn: a blocked agent has also started its turn" "0" \
  "$(spawn_turn_started w900-race-the-spawn >/dev/null 2>&1; echo $?)"

# The defect itself: the call SUCCEEDS and answers `idle`. rc 0 from herdr,
# and no turn — exactly the pair that used to read as a healthy spawn.
printf '{"agent":{"name":"w","agent_status":"idle","pane_id":"p1","workspace_id":"w1","tab_id":"w1:t1","terminal_id":"term_fake","focused":false,"revision":9}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-wait-until.json"
turn_out=$(spawn_turn_started w900-race-the-spawn 2>&1)
is "turn: an idle agent after the prompt is NOT a started turn" "1" "$?"
case "$turn_out" in
  *"never submitted"*) ok "turn: the failure names the unsubmitted prompt" ;;
  *) not_ok "turn: the failure names the unsubmitted prompt — got '$turn_out'" ;;
esac

# The wait timing out is the same verdict, reached the other way.
printf '{"error":{"code":"timeout","message":"timed out waiting for agent status"}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-wait-until.json"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-wait-until.rc"
turn_out=$(spawn_turn_started w900-race-the-spawn 2>&1)
is "turn: a wait that times out is not a started turn" "1" "$?"
case "$turn_out" in
  *timeout*) ok "turn: the timeout is reported as the server's own code" ;;
  *) not_ok "turn: the timeout is reported as the server's own code — got '$turn_out'" ;;
esac
rm -f "$FAKE_HERDR_FIXTURES/agent-wait-until.rc"

# End to end: an unconfirmed turn fails the SPAWN, so the fleet summary's
# `failed:` line carries it and the slot is never counted as occupied.
if git -C "$SPAWNREPO" rev-parse --verify -q origin/main >/dev/null 2>&1; then
  _saved_repo="$REPO"
  REPO="$SPAWNREPO"
  herd_fixture '[]' "$SPAWNREPO"
  RALPH_HERDR_LEDGER="$TMP/turn/ledger.jsonl"
  mkdir -p "$TMP/turn"
  turn_out=$(RALPH_HERDR_AGENT_LIVE= spawn_work_session 901 \
    '{"next":{"number":901,"title":"Unsubmitted prompt"},"queue":[]}' 2>&1)
  is "turn: an unconfirmed turn fails the spawn" "1" "$?"
  case "$turn_out" in
    *"spawned GH-901"*) not_ok "turn: an unconfirmed spawn must not report success — got '$turn_out'" ;;
    *) ok "turn: an unconfirmed spawn does not report success" ;;
  esac
  case "$turn_out" in
    *"send-keys"*) ok "turn: the failure hands back the manual submit" ;;
    *) not_ok "turn: the failure hands back the manual submit — got '$turn_out'" ;;
  esac
  # Audit D2a: the unconfirmed verdict is machine-greppable and names the pane.
  case "$turn_out" in
    *"SPAWN-UNCONFIRMED pW1"*) ok "turn: SPAWN-UNCONFIRMED names the pane" ;;
    *) not_ok "turn: SPAWN-UNCONFIRMED names the pane — got '$turn_out'" ;;
  esac
  # Audit D1: the spawn output says which provisioning path was taken — here
  # the fake's worktree path does not exist, and the report says so.
  case "$turn_out" in
    *"provision: skipped"*) ok "provision: the spawn reports the provisioning path taken" ;;
    *) not_ok "provision: the spawn reports the provisioning path taken — got '$turn_out'" ;;
  esac
  # Audit D2b: the worker is LIVE (only its prompt is unsubmitted), so the
  # provisional spawn record stays OPEN — an open row means a live worker.
  is "turn: the provisional record stays open for the live worker" "1" \
    "$(ralph_ledger_open_agents 2>/dev/null | grep -c . | tr -d ' ')"
  # GH-2223: the fake's default pane read renders NO text, and a live session
  # always renders its input-box chrome — so this is the UNREADABLE verdict,
  # whose message keys both remedies on a human look instead of asserting
  # either mode.
  case "$turn_out" in
    *"could not be read to tell undelivered from unsubmitted"*) ok "turn: an unreadable pane names neither mode" ;;
    *) not_ok "turn: an unreadable pane names neither mode — got '$turn_out'" ;;
  esac
  rm -f "$FAKE_HERDR_FIXTURES/api-snapshot.json"
  REPO="$_saved_repo"
  RALPH_HERDR_LEDGER="$_saved_ledger"
  unset RALPH_HERDR_AGENT_LIVE
else
  not_ok "turn: origin/main fixture could not be built"
fi

# ── GH-2223: undelivered vs unsubmitted stop sharing one message ────────────
# Twice observed (GH-2159, GH-2209): SPAWN-UNCONFIRMED printed the send-keys
# remedy while the pane's input box was EMPTY — the prompt was never delivered,
# Enter would submit a blank line, and the true recovery was remove-and-
# respawn. The confirm path now reads the pane: a present prompt keeps the
# submit remedy; an empty input box gets ONE redelivery to the live session,
# then the respawn remedy.
if git -C "$SPAWNREPO" rev-parse --verify -q origin/main >/dev/null 2>&1; then
  _saved_repo="$REPO"
  REPO="$SPAWNREPO"
  RALPH_HERDR_LEDGER="$TMP/modes/ledger.jsonl"
  mkdir -p "$TMP/modes"
  printf '{"agent":{"name":"w","agent_status":"idle","pane_id":"p1","workspace_id":"w1","tab_id":"w1:t1","terminal_id":"term_fake","focused":false,"revision":9}}\n' \
    >"$FAKE_HERDR_FIXTURES/agent-wait-until.json"

  # Mode 1 — the prompt IS in the input box: the submit remedy, and no
  # redelivery (a redelivery here would double the text).
  herd_fixture '[]' "$SPAWNREPO"
  printf '{"read":{"pane_id":"pW1","lines":["╭──────╮","│ > /ralph:work 905","╰──────╯"]}}\n' \
    >"$FAKE_HERDR_FIXTURES/pane-read.pW1.json"
  export FAKE_HERDR_LOG="$TMP/modes/present.log"
  turn_out=$(RALPH_HERDR_AGENT_LIVE= spawn_work_session 905 \
    '{"next":{"number":905,"title":"Prompt present unsubmitted"},"queue":[]}' 2>&1)
  is "modes: a present prompt still fails the spawn" "1" "$?"
  case "$turn_out" in
    *"unsubmitted prompt"*"send-keys pW1"*) ok "modes: a present prompt keeps the submit remedy" ;;
    *) not_ok "modes: a present prompt keeps the submit remedy — got '$turn_out'" ;;
  esac
  case "$turn_out" in
    *"NEVER DELIVERED"*) not_ok "modes: a present prompt must not read as undelivered — got '$turn_out'" ;;
    *) ok "modes: a present prompt does not read as undelivered" ;;
  esac
  is "modes: a present prompt is never redelivered" "1" \
    "$(grep -c '^agent prompt ' "$FAKE_HERDR_LOG" 2>/dev/null | tr -d ' ')"
  rm -f "$FAKE_HERDR_FIXTURES/api-snapshot.json"

  # Mode 2 — the pane renders chrome and the prompt is NOWHERE in it: the
  # delivery never landed. One redelivery to the live session, and when the
  # turn still never starts, the remedy is remove-and-respawn — safe because
  # an agent that never took a turn holds no claim and no commits.
  herd_fixture '[]' "$SPAWNREPO"
  printf '{"read":{"pane_id":"pW1","lines":["╭──────╮","│ > ","╰──────╯","? for shortcuts"]}}\n' \
    >"$FAKE_HERDR_FIXTURES/pane-read.pW1.json"
  export FAKE_HERDR_LOG="$TMP/modes/absent.log"
  turn_out=$(RALPH_HERDR_AGENT_LIVE= spawn_work_session 906 \
    '{"next":{"number":906,"title":"Prompt never delivered"},"queue":[]}' 2>&1)
  is "modes: an undelivered prompt fails the spawn" "1" "$?"
  case "$turn_out" in
    *"SPAWN-UNCONFIRMED pW1"*) ok "modes: the undelivered verdict keeps the greppable token and pane" ;;
    *) not_ok "modes: the undelivered verdict keeps the greppable token and pane — got '$turn_out'" ;;
  esac
  case "$turn_out" in
    *"NEVER DELIVERED"*"worktree remove --workspace w1"*) ok "modes: an empty input box gets the respawn remedy" ;;
    *) not_ok "modes: an empty input box gets the respawn remedy — got '$turn_out'" ;;
  esac
  case "$turn_out" in
    *"send-keys pW1 Enter"*) not_ok "modes: an empty input box must not be told to submit — got '$turn_out'" ;;
    *) ok "modes: an empty input box is not told to submit a blank line" ;;
  esac
  # Exactly TWO deliveries: the original and the one retry — never a loop.
  is "modes: an undelivered prompt is redelivered exactly once" "2" \
    "$(grep -c '^agent prompt ' "$FAKE_HERDR_LOG" 2>/dev/null | tr -d ' ')"
  rm -f "$FAKE_HERDR_FIXTURES/api-snapshot.json" "$FAKE_HERDR_FIXTURES/pane-read.pW1.json"
  unset FAKE_HERDR_LOG
  REPO="$_saved_repo"
  RALPH_HERDR_LEDGER="$_saved_ledger"
  unset RALPH_HERDR_AGENT_LIVE
else
  not_ok "modes: origin/main fixture could not be built"
fi

# ── the D3 lock pre-check: a live per-(worktree, unit) lock skips the spawn ──
# `board claim` publishes wt-<N>-<16-hex>.json under the sessions dir
# (GH-1956); a FRESH one means a local session is driving N right now, and the
# spawn must SKIP (rc 2) rather than open a pane whose only act would be being
# refused. A STALE one (older than RALPH_LOCK_TTL_MIN, the board claim's own
# clock) asserts nothing and the spawn proceeds. Both run under dry-run: the
# check sits before the plan branch, so a skip costs no herdr call at all.
LQUEUE='{"next":{"number":902,"title":"Lock pre-check"},"queue":[]}'
printf '{"session":"other-session","issue":902,"worktree":"/tmp/elsewhere","since":"2026-08-19T00:00:00Z"}' \
  >"$TMP/sessions/wt-902-0123456789abcdef.json"
lock_out=$(RALPH_HERDR_DRY_RUN=true spawn_work_session 902 "$LQUEUE" 2>&1)
is "lock: a live worktree lock skips the spawn (rc 2)" "2" "$?"
case "$lock_out" in
  *"SKIP GH-902"*"/tmp/elsewhere"*) ok "lock: the skip names the lock's worktree" ;;
  *) not_ok "lock: the skip names the lock's worktree — got '$lock_out'" ;;
esac
# The prefix trap (GH-1996): a lock on #9020 is NOT a hold on #902.
mv "$TMP/sessions/wt-902-0123456789abcdef.json" "$TMP/sessions/wt-9020-0123456789abcdef.json"
lock_out=$(RALPH_HERDR_DRY_RUN=true spawn_work_session 902 "$LQUEUE" 2>&1)
is "lock: another issue's lock never skips this one (anchored match)" "0" "$?"
rm -f "$TMP/sessions/wt-9020-0123456789abcdef.json"
# Staleness: aged out on the board claim's clock → asserts nothing, proceed.
printf '{"session":"other-session","issue":902,"worktree":"/tmp/elsewhere","since":"2026-08-19T00:00:00Z"}' \
  >"$TMP/sessions/wt-902-0123456789abcdef.json"
touch -t 202601010000 "$TMP/sessions/wt-902-0123456789abcdef.json"
lock_out=$(RALPH_HERDR_DRY_RUN=true spawn_work_session 902 "$LQUEUE" 2>&1)
is "lock: a stale lock asserts nothing — the spawn proceeds" "0" "$?"
rm -f "$TMP/sessions/wt-902-0123456789abcdef.json"
# An absent sessions dir is not evaluated, never a block.
_saved_sessions="$RALPH_HERDR_SESSIONS_DIR"
RALPH_HERDR_SESSIONS_DIR="$TMP/no-such-sessions-dir"
lock_out=$(RALPH_HERDR_DRY_RUN=true spawn_work_session 902 "$LQUEUE" 2>&1)
is "lock: an unreadable sessions dir is not evaluated (spawn proceeds)" "0" "$?"
RALPH_HERDR_SESSIONS_DIR="$_saved_sessions"

# ── the D2a modal probe: pane content named, never gated on ─────────────────
printf '{"read":{"pane_id":"pM1","lines":["╭─ Welcome to Claude Code","Do you trust the files in this folder?","╰─"]}}' \
  >"$FAKE_HERDR_FIXTURES/pane-read.pM1.json"
modal_out=$(spawn_modal_probe pM1 2>&1)
case "$modal_out" in
  *"pane-blocked-modal pM1"*) ok "modal: a known blocking modal is named with its pane" ;;
  *) not_ok "modal: a known blocking modal is named with its pane — got '$modal_out'" ;;
esac
modal_out=$(spawn_modal_probe pEmpty 2>&1)
is "modal: an empty pane prints nothing" "" "$modal_out"
printf 'not json\n' >"$FAKE_HERDR_FIXTURES/pane-read.raw"
modal_out=$(spawn_modal_probe pBroken 2>&1)
is "modal: an unreadable pane prints nothing (absence is not evidence)" "" "$modal_out"
rm -f "$FAKE_HERDR_FIXTURES/pane-read.pM1.json" "$FAKE_HERDR_FIXTURES/pane-read.raw"
printf '{"agent":{"name":"w","agent_status":"working","pane_id":"p1","workspace_id":"w1","tab_id":"w1:t1","terminal_id":"term_fake","focused":false,"revision":9}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-wait-until.json"

# ── provision_worktree: the host script is told WHERE (GH-2106) ─────────────
# The call used to be `(cd "$wt" && bash scripts/provision-worktree.sh)` with no
# argv, so a host script opening with `${1:?Usage}` — the shape a pilot repo
# ships — exited 1 on every spawn of every fleet. Provisioning is fail-open, so
# the run continued and each agent landed in a tree with no install: it could
# not type-check, test or build until it rediscovered that for itself.
PROV="$TMP/prov-wt"
mkdir -p "$PROV/scripts"
cat >"$PROV/scripts/provision-worktree.sh" <<'PROVEOF'
#!/usr/bin/env bash
set -u
worktree_path="${1:?Usage: $0 <worktree_path>}"
echo "provisioned $worktree_path"
PROVEOF
chmod +x "$PROV/scripts/provision-worktree.sh"

# Redirected rather than captured in `$( )`: the out-variable would not survive
# the subshell, and the spawn path calls provision_worktree in-process too.
RALPH_HERDR_SPAWNED_PROVISION_RC=""
provision_worktree "$PROV" >"$TMP/prov.out" 2>&1
prov_rc=$?
prov_out=$(cat "$TMP/prov.out")
is "provision: a host script requiring the path succeeds" "0" "$prov_rc"
case "$prov_out" in
  *"provisioned $PROV"*) ok "provision: the host script is handed the worktree path" ;;
  *) not_ok "provision: the host script is handed the worktree path — got '$prov_out'" ;;
esac
is "provision: a clean run records rc 0" "0" "$RALPH_HERDR_SPAWNED_PROVISION_RC"

# Fail-open is unchanged — but the rc is now RECORDED, so the fleet summary can
# name the spawn instead of leaving the only trace in mid-spawn stderr.
cat >"$PROV/scripts/provision-worktree.sh" <<'PROVEOF'
#!/usr/bin/env bash
exit 3
PROVEOF
chmod +x "$PROV/scripts/provision-worktree.sh"
RALPH_HERDR_SPAWNED_PROVISION_RC=""
provision_worktree "$PROV" >"$TMP/prov.out" 2>&1
prov_rc=$?
prov_out=$(cat "$TMP/prov.out")
is "provision: a failing host script still fails OPEN (rc 0)" "0" "$prov_rc"
is "provision: the failing rc is recorded for the summary" "3" "$RALPH_HERDR_SPAWNED_PROVISION_RC"
case "$prov_out" in
  *"exited 3"*) ok "provision: the failure names the host script's own code" ;;
  *) not_ok "provision: the failure names the host script's own code — got '$prov_out'" ;;
esac

# A run that attempted NOTHING must not record a success: "no provisioner ran"
# and "provisioning passed" are different answers and the summary reads the rc.
rm -rf "$PROV/scripts"
RALPH_HERDR_SPAWNED_PROVISION_RC=""
provision_worktree "$PROV" >"$TMP/prov.out" 2>&1
prov_rc=$?
is "provision: no script and no lockfile does nothing (rc 0)" "0" "$prov_rc"
is "provision: an unattempted run records no rc at all" "" "$RALPH_HERDR_SPAWNED_PROVISION_RC"

# ── ralph_herdr_tab_create: the lane spawns' tab goes through the adapter ────
# deliver-pass.sh and tend-pass.sh used to capture `tab create` stdout and pull
# a pane id out of it. A refusal lands on stderr with stdout empty, so that
# capture came back empty and every failure — refused, unreachable, garbled —
# read as the single line "no pane id in tab response": true, and stripped of
# the error.code that says which one it was (GH-1855).
is "tab create: the validated result is returned, not the envelope" "pTF" \
  "$(ralph_herdr_tab_create ralph-deliver | jq -r '.root_pane.pane_id')"
is "tab create: the tab id (the cleanup path reads it) comes back too" "w1:tF" \
  "$(ralph_herdr_tab_create ralph-deliver | jq -r '.tab.tab_id')"
is "tab create: no envelope fields leak into what callers read" "null" \
  "$(ralph_herdr_tab_create ralph-deliver | jq -r '.result // "null"')"

FAKE_HERDR_LOG="$TMP/tab.log" ralph_herdr_tab_create ralph-tend >/dev/null
tab_argv=$(grep 'tab create' "$TMP/tab.log" 2>/dev/null | head -1)
case "$tab_argv" in
  *"--cwd $ROOT"*"--label ralph-tend"*"--no-focus"*)
    ok "tab create: argv is unchanged by the route-through" ;;
  *)
    not_ok "tab create: argv is unchanged by the route-through — got '$tab_argv'" ;;
esac
rm -f "$TMP/tab.log"

# A refusal: the error envelope on stderr with an empty stdout, which is what
# the real 0.8.x binary does.
printf '{"error":{"code":"tab_limit_reached","message":"too many tabs in this workspace"}}\n' \
  >"$FAKE_HERDR_FIXTURES/tab-create.json"
printf '1\n' >"$FAKE_HERDR_FIXTURES/tab-create.rc"
tab_out=$(ralph_herdr_tab_create ralph-deliver 2>&1)
tab_rc=$?
is "tab create: a refusal fails the spawn" "1" "$tab_rc"
case "$tab_out" in
  *tab_limit_reached*) ok "tab create: the refusal names the server's code" ;;
  *) not_ok "tab create: the refusal names the server's code — got '$tab_out'" ;;
esac
case "$tab_out" in
  *"no pane id"*) not_ok "tab create: a refusal is not reported as a missing pane id — got '$tab_out'" ;;
  *) ok "tab create: a refusal is not reported as a missing pane id" ;;
esac
rm -f "$FAKE_HERDR_FIXTURES/tab-create.json" "$FAKE_HERDR_FIXTURES/tab-create.rc"

# Exit 0 with a body nobody can parse — the case an exit-status check sails
# straight through. Nothing resembling a pane id may reach the caller.
printf '{"id":"cli:tab:create","result":{"type":"tab_created","tab":{}}}trailing\n' \
  >"$FAKE_HERDR_FIXTURES/tab-create.raw"
tab_out=$(ralph_herdr_tab_create ralph-deliver 2>&1)
is "tab create: a malformed body at exit 0 fails the spawn" "1" "$?"
case "$tab_out" in
  *pTF*) not_ok "tab create: a malformed body must yield no pane id — got '$tab_out'" ;;
  *) ok "tab create: a malformed body yields no pane id" ;;
esac
rm -f "$FAKE_HERDR_FIXTURES/tab-create.raw"

# Silence: no stdout, no stderr, nonzero exit — the server did not answer.
: >"$FAKE_HERDR_FIXTURES/tab-create.raw"
printf '1\n' >"$FAKE_HERDR_FIXTURES/tab-create.rc"
tab_out=$(ralph_herdr_tab_create ralph-deliver 2>&1)
is "tab create: an unanswered call fails the spawn" "1" "$?"
case "$tab_out" in
  *"did not answer"*) ok "tab create: silence is reported as silence, not as a refusal" ;;
  *) not_ok "tab create: silence is reported as silence — got '$tab_out'" ;;
esac
rm -f "$FAKE_HERDR_FIXTURES/tab-create.raw" "$FAKE_HERDR_FIXTURES/tab-create.rc"

# ── the lane spawns prompt through the adapter, not the binary (GH-1999) ─────
# Neither lane parses the prompt response, so nothing there can be MISREAD —
# what a raw `$HERDR agent prompt` branches on instead is the exit status, and
# transport.sh's founding rule is that a zero exit is not evidence of success.
# herdr exits 0 having answered an error envelope, a reply to a different
# request, or a wrong result type; each read here as "prompt delivered" and
# the lane proceeded to notify-watch against an agent that never got its
# prompt. Asserted structurally because the fix IS structural (one call swap)
# and the regression is someone writing the raw form back: driving the whole
# script would need a tend-queue/deliver-queue fixture the fake board has no
# other reason to grow.
for _lane in tend deliver; do
  _raw=$(grep -v '^[[:space:]]*echo ' "$SCRIPT_DIR/../scripts/$_lane-pass.sh" \
    | grep -c 'HERDR" agent prompt')
  is "$_lane-pass: no raw agent prompt outside the adapter" "0" "$_raw"
  # The agent name rides the $agent variable (agent=ralph-<lane>, GH-2317).
  if grep -q 'ralph_herdr_agent_prompt "$agent"' "$SCRIPT_DIR/../scripts/$_lane-pass.sh" \
    && grep -q "agent=ralph-$_lane" "$SCRIPT_DIR/../scripts/$_lane-pass.sh"; then
    ok "$_lane-pass: the prompt goes through the validating adapter"
  else
    not_ok "$_lane-pass: the prompt goes through the validating adapter"
  fi
done
unset _lane _raw

# ── ralph_branch_for_issue: the GH-1807 grammar, and the legacy resume ───────
# A throwaway git repo so the ref probes see exactly the branches this block
# creates — the real checkout's branch list is not a fixture.
BREPO="$TMP/branch-repo"
mkdir -p "$BREPO"
git -C "$BREPO" init -q
git -C "$BREPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m base
REPO="$BREPO"

is "branch: the board's grammar is what the cockpit cuts" \
  "feat/500-fake-issue" "$(ralph_branch_for_issue 500)"

# Resume beats re-cut: a legacy branch with no semantic sibling keeps the unit
# on one head instead of splitting its work across two.
git -C "$BREPO" branch -q feature/GH-501
is "branch: a lone legacy branch is resumed, not re-cut" \
  "feature/GH-501" "$(ralph_branch_for_issue 501)"

# ...but only when there is nothing semantic to resume. Once the new branch
# exists it wins, so a unit that already migrated does not fall back.
git -C "$BREPO" branch -q feature/GH-502
git -C "$BREPO" branch -q feat/502-fake-issue
is "branch: the semantic branch outranks a legacy sibling" \
  "feat/502-fake-issue" "$(ralph_branch_for_issue 502)"

# A board CLI that cannot name the issue must not silently mint a branch —
# guessing here would re-introduce the second grammar GH-1807 removed.
printf '1\n' >"$FAKE_BOARD_FIXTURES/name.503.rc"
fails "branch: a failing \`board name\` refuses rather than guessing" \
  ralph_branch_for_issue 503
rm -f "$FAKE_BOARD_FIXTURES/name.503.rc"

# Same for an answer that parses but names no branch.
echo '{"number":504}' >"$FAKE_BOARD_FIXTURES/name.504.json"
fails "branch: a name envelope with no branch is refused" \
  ralph_branch_for_issue 504
rm -f "$FAKE_BOARD_FIXTURES/name.504.json"

REPO="$ROOT"

# ── GH-2324: the herd-fixture scrub covers every var the spawn path injects ──
# Derived from the injection sites, never restated: a pane var added to
# lib.sh's _pane_env/_plan_env or work-team.sh's --env list without a matching
# entry in HERD_PANE_ENV fails here, in CI, before it can leak into a suite
# run from a cockpit-hosted session.
injected=$(grep -hE '_(pane|plan)_env=|--env ' "$SCRIPT_DIR"/../scripts/*.sh \
  | grep -vE '^[[:space:]]*#' \
  | grep -oE '(RALPH_HERDR_[A-Z_]+|WHO_[A-Z_]+)=' | tr -d = | sort -u)
is "scrub: the spawn path injects at least the known pane vars" "true" \
  "$( [ "$(printf '%s\n' "$injected" | grep -c .)" -ge 8 ] && echo true || echo false )"
missing=""
for v in $injected; do
  case " $HERD_PANE_ENV " in *" $v "*) ;; *) missing="$missing $v" ;; esac
done
is "scrub: every injected pane var is in HERD_PANE_ENV (missing:$missing)" "" "$missing"
for v in $HERD_PANE_ENV; do
  is "scrub: $v is unset for the suite" "unset" "${!v-unset}"
done

# ── ralph_plugin_freshness_notice (GH-2260) ──────────────────────────────────
# The spawn-time half of doctor's `ralph-herdr-content` line. Advisory by
# construction, so every case asserts rc 0; what varies is what it SAYS.
FTMP="$TMP/freshness"
mkdir -p "$FTMP/repo/plugin/ralph-herdr/scripts" "$FTMP/other/scripts"

# A stub standing in for herdr-plugin-sync.sh --check: the function's contract
# with it is the exit code (0 in sync / 1 different / anything else not
# evaluable), and driving the real hash would make this a test of shasum.
_fresh_stub() {
  cat >"$FTMP/repo/plugin/ralph-herdr/scripts/herdr-plugin-sync.sh" <<STUB
#!/usr/bin/env bash
echo "source    /src  aaaa"
echo "installed /inst bbbb"
echo "stub reason line" >&2
exit $1
STUB
}

# rc must survive into the parent shell, so it is captured here rather than
# inside a command substitution — a subshell's assignment would never return.
_fresh_rc=0
_fresh_run() {
  local saved="$REPO"
  REPO="$FTMP/repo"
  ralph_plugin_freshness_notice >"$FTMP/out" 2>&1
  _fresh_rc=$?
  REPO="$saved"
}
_fresh_out() { _fresh_run; cat "$FTMP/out"; }

_fresh_stub 0
is "freshness: an in-sync tree says nothing" "" "$(_fresh_out)"
is "freshness: in sync returns 0" "0" "$_fresh_rc"

_fresh_stub 1
out=$(_fresh_out)
is "freshness: a divergence still returns 0 — advisory, never a gate" "0" "$_fresh_rc"
case "$out" in
  *"INSTALLED ralph-herdr differs"*) ok "freshness: a divergence names the drift" ;;
  *) not_ok "freshness: a divergence names the drift — got '$out'" ;;
esac
case "$out" in
  *"herdr-plugin-sync.sh"*) ok "freshness: a divergence names the sync command" ;;
  *) not_ok "freshness: a divergence names the sync command — got '$out'" ;;
esac
case "$out" in
  *"never a gate"*) ok "freshness: a divergence says the spawn proceeds" ;;
  *) not_ok "freshness: a divergence says the spawn proceeds — got '$out'" ;;
esac

# An unreadable input may not render like a clean one (GH-1971).
_fresh_stub 2
out=$(_fresh_out)
is "freshness: an unevaluable check still returns 0" "0" "$_fresh_rc"
case "$out" in
  *"NOT CHECKED"*) ok "freshness: unevaluable reads NOT CHECKED, not clean" ;;
  *) not_ok "freshness: unevaluable reads NOT CHECKED, not clean — got '$out'" ;;
esac
case "$out" in
  *"stub reason line"*) ok "freshness: NOT CHECKED carries the reason" ;;
  *) not_ok "freshness: NOT CHECKED carries the reason — got '$out'" ;;
esac

# A host repo has no source tree to be stale against and no remedy to name:
# NOT APPLICABLE is silence, not a permanent line nothing can clear (GH-2052).
REPO_SAVED="$REPO"
REPO="$FTMP/other"
out=$(ralph_plugin_freshness_notice 2>&1); rc=$?
REPO="$REPO_SAVED"
is "freshness: a repo with no ralph-herdr source tree is silent" "" "$out"
is "freshness: not-applicable returns 0" "0" "$rc"

# The anchor is the load-bearing part: the notice must run the SOURCE copy of
# the sync script, never the one beside lib.sh. When herdr executes the
# INSTALLED plugin, those are the same directory, and a check that hashed its
# own tree would let every stale cockpit certify itself fresh.
if grep -q 'sync="\$REPO/plugin/ralph-herdr/scripts/herdr-plugin-sync.sh"' "$SCRIPT_DIR/../scripts/lib.sh"; then
  ok "freshness: the sync script is resolved from \$REPO, not from lib.sh's own tree"
else
  not_ok "freshness: the sync script is resolved from \$REPO, not from lib.sh's own tree"
fi

# Every spawn entry point carries it — a lane that spawns without the notice
# is a lane where stale code runs unannounced.
for _f in work-fleet.sh work-next.sh work-team.sh hero.sh dispatch-up.sh fork.sh deliver-pass.sh tend-pass.sh cockpit-fzf.sh; do
  if grep -q '^ *ralph_plugin_freshness_notice$' "$SCRIPT_DIR/../scripts/$_f"; then
    ok "freshness: $_f announces plugin staleness at spawn"
  else
    not_ok "freshness: $_f announces plugin staleness at spawn"
  fi
done


echo "1..$n"
echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
