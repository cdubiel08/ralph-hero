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
export RALPH_HERDR_LEDGER="$TMP/ledger/ledger.jsonl"

# lib.sh sets -euo pipefail at source time; the harness needs to observe
# failures, not die on them.
# shellcheck source=../scripts/lib.sh
. "$SCRIPT_DIR/../scripts/lib.sh"
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
is "record: worktree branch"                 "feature/GH-123" "$(jqr '.lineage.herdr.worktree_branch')"
is "record: workspace label carries nesting" "GH-123 via GH-45" "$(jqr '.lineage.herdr.workspace_label')"
is "record: ts equals spawned_at"            "$(jqr '.ts')"   "$(jqr '.lineage.spawned_at')"
is "record: token role"                      "w"              "$(jqr '.tokens.role')"
is "record: token issue (string)"            "123"            "$(jqr '.tokens.issue')"
is "record: token slug"                      "fix-the-flaky-test" "$(jqr '.tokens.slug')"
is "record: token depth 0 (human root)"      "0"              "$(jqr '.tokens.depth')"
is "record: token state spawned"             "spawned"        "$(jqr '.tokens.state')"
is "record: token harness claude"            "claude"         "$(jqr '.tokens.harness')"
is "record: no parent token on a root spawn" "false"          "$(jqr '.tokens | has("parent")')"
is "record: root token is the agent's own ref" "$(jqr '.agent_ref')" "$(jqr '.tokens.root')"
is "record: spawn_epoch token matches the ref" "$(jqr '.agent_ref' | sed 's/^.*#//')" "$(jqr '.tokens.spawn_epoch')"

case "$(jqr '.agent_ref')" in
  w123-fix-the-flaky-test\#[0-9a-f][0-9a-f][0-9a-f][0-9a-f])
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

# The exported read-backs (run in THIS shell, not a subshell, to see them).
RALPH_HERDR_DRY_RUN=true spawn_work_session 123 "$QUEUE" >/dev/null 2>&1
is "dry-run: RALPH_HERDR_SPAWNED_AGENT exported" "w123-fix-the-flaky-test" "$RALPH_HERDR_SPAWNED_AGENT"
case "$RALPH_HERDR_SPAWNED_REF" in
  "$RALPH_HERDR_SPAWNED_AGENT"\#[0-9a-f][0-9a-f][0-9a-f][0-9a-f])
    ok "dry-run: RALPH_HERDR_SPAWNED_REF exported as name#epoch" ;;
  *)
    not_ok "dry-run: RALPH_HERDR_SPAWNED_REF exported as name#epoch — got '$RALPH_HERDR_SPAWNED_REF'" ;;
esac

# ── ralph_worktree_source_dir: the parent workspace (GH-1832) ────────────────
# herdr refuses `worktree create`/`open` when --cwd is a LINKED worktree, and
# $REPO defaults to $PWD — which is always a linked worktree when an agent
# spawns an agent, because that is where /ralph:work runs. A real git fixture
# (not a stub) because the whole function is one git invocation and the trap it
# avoids is a git output detail.
GITREPO="$TMP/gitrepo"
mkdir -p "$GITREPO"
(
  cd "$GITREPO" || exit 1
  git init -q -b main .
  git config user.email t@example.com
  git config user.name t
  git commit -q --allow-empty -m init
  git worktree add -q "$TMP/linked" -b feature/GH-1 >/dev/null 2>&1
) >/dev/null 2>&1

# Resolved paths are compared through `cd -P` because macOS hands out
# /var/folders TMPDIRs that are symlinks to /private/var — git reports the
# resolved form, the fixture path carries the symlink, and a raw string compare
# would fail on a function that is behaving correctly.
realp() { (cd -P "$1" 2>/dev/null && pwd -P); }

if [ -d "$TMP/linked" ]; then
  is "source dir: from a LINKED worktree, resolves to the main checkout" \
    "$(realp "$GITREPO")" "$(realp "$(ralph_worktree_source_dir "$TMP/linked")")"
  is "source dir: from the main checkout, resolves to itself" \
    "$(realp "$GITREPO")" "$(realp "$(ralph_worktree_source_dir "$GITREPO")")"
  # The trap this function exists to avoid: `dirname $(git rev-parse
  # --git-common-dir)` returns a bare "." from the main checkout, because
  # --git-common-dir answers relative there. An absolute path is the contract.
  case "$(ralph_worktree_source_dir "$GITREPO")" in
    /*) ok "source dir: the result is absolute, never a relative '.'" ;;
    *)  not_ok "source dir: the result is absolute — got '$(ralph_worktree_source_dir "$GITREPO")'" ;;
  esac
else
  not_ok "source dir: git worktree fixture could not be built"
fi

# A non-repo has no parent workspace to find. Returning the input unchanged
# lets herdr issue its own refusal, which beats a path this function invented.
mkdir -p "$TMP/notgit"
is "source dir: a non-repo falls back to the directory itself" \
  "$TMP/notgit" "$(ralph_worktree_source_dir "$TMP/notgit")"

# The dry-run plan must print the cwd the live path would use. A plan naming
# $REPO while the spawn sends the parent workspace is a plan you cannot debug
# from — and the misleading plan is half of what made GH-1832 expensive.
if [ -d "$TMP/linked" ]; then
  _saved_repo="$REPO"
  REPO="$TMP/linked"
  plan=$(RALPH_HERDR_DRY_RUN=true spawn_work_session 123 "$QUEUE" 2>&1)
  REPO="$_saved_repo"
  create_line=$(printf '%s\n' "$plan" | grep -- 'worktree create' | head -1)
  case "$create_line" in
    *"--cwd $(realp "$GITREPO") "*|*"--cwd $GITREPO "*)
      ok "dry-run plan: worktree create --cwd is the parent workspace" ;;
    *)
      not_ok "dry-run plan: worktree create --cwd is the parent workspace — got '$create_line'" ;;
  esac
  case "$create_line" in
    *"$TMP/linked"*) not_ok "dry-run plan: the linked worktree must not appear as --cwd — got '$create_line'" ;;
    *)               ok "dry-run plan: the linked worktree is not offered as --cwd" ;;
  esac
fi

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

echo "1..$n"
echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
