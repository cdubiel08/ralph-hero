#!/usr/bin/env bash
# scripts/__tests__/herdr-setup-sweep.test.sh
# Tests ralph/scripts/herdr-setup.sh's sweep verb (GH-2103): finished fleet
# worktrees — merged, clean, session idle — removed only under --apply, and
# every other reading LISTED, never touched.
#
# Load-bearing properties:
#   - removal needs THREE positive readings (clean porcelain, ancestor of the
#     origin default ref, no live session); dirty/unmerged/live/stray/self are
#     LISTED and survive --apply untouched
#   - an unavailable snapshot is exit 2 (not evaluable), never an empty herd
#   - --limit bounds one sweep's actions; dry run is the default and touches
#     nothing
#
# The herdr binary is a stub; the transport boundary is the REAL
# plugin/ralph-herdr/scripts (pointed at via RALPH_HERDR_SCRIPTS_DIR), so the
# envelope validation the sweep depends on actually runs. The git side is a
# real repo with a real bare origin — nothing about clean/merged is mocked.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$REPO_ROOT/ralph/scripts/herdr-setup.sh"
TRANSPORT_DIR="$REPO_ROOT/plugin/ralph-herdr/scripts"
TMP_ROOT=$(mktemp -d)
TMP_ROOT=$(cd "$TMP_ROOT" && pwd -P)   # macOS: /var/folders is a symlink; git records physical paths
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; echo "$2" | sed 's/^/        /'; }
expect() { if grep -qF -- "$3" <<<"$2"; then pass "$1"; else fail "$1" "$2"; fi; }
refute() { if grep -qF -- "$3" <<<"$2"; then fail "$1" "$2"; else pass "$1"; fi; }

# --- git fixture: bare origin, main clone, a pile of linked worktrees --------
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git init -q --bare "$TMP_ROOT/origin.git"
git init -q -b main "$TMP_ROOT/repo"
git -C "$TMP_ROOT/repo" remote add origin "$TMP_ROOT/origin.git"
echo hello >"$TMP_ROOT/repo/README"
git -C "$TMP_ROOT/repo" add README
git -C "$TMP_ROOT/repo" commit -qm init
git -C "$TMP_ROOT/repo" push -qu origin main

WT_ROOT="$TMP_ROOT/wtroot"
PILE="$WT_ROOT/repo"
mkdir -p "$PILE"
git -C "$TMP_ROOT/repo" worktree add -q "$PILE/merged-clean" -b feat/1-merged
git -C "$TMP_ROOT/repo" worktree add -q "$PILE/dirty" -b feat/2-dirty
echo stray-change >"$PILE/dirty/uncommitted.txt"
git -C "$TMP_ROOT/repo" worktree add -q "$PILE/unmerged" -b feat/3-unmerged
echo more >"$PILE/unmerged/more.txt"
git -C "$PILE/unmerged" add more.txt
git -C "$PILE/unmerged" commit -qm "unpushed work"
git -C "$TMP_ROOT/repo" worktree add -q "$PILE/ws-idle" -b feat/4-idle
git -C "$TMP_ROOT/repo" worktree add -q "$PILE/ws-live" -b feat/5-live
git -C "$TMP_ROOT/repo" worktree add -q "$PILE/ws-stale-token" -b feat/6-stale-token
git -C "$TMP_ROOT/repo" worktree add -q "$PILE/ws-blocked-token" -b feat/7-blocked-token
git -C "$TMP_ROOT/repo" worktree add -q "$PILE/ws-no-status" -b feat/8-no-status
mkdir "$PILE/stray-dir"

# --- herdr stub ---------------------------------------------------------------
BIN="$TMP_ROOT/bin"
mkdir -p "$BIN"
cat >"$BIN/herdr" <<'STUB'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
  "api snapshot")
    [ -n "${FAKE_SNAP_FILE:-}" ] && [ -f "$FAKE_SNAP_FILE" ] && { cat "$FAKE_SNAP_FILE"; exit 0; }
    exit 1 ;;
  "worktree remove")
    shift 2
    echo "worktree remove $*" >>"${FAKE_HERDR_LOG:-/dev/null}"
    printf '{"id":"t","result":{"type":"worktree_removed"}}\n'
    exit 0 ;;
  "workspace close")
    shift 2
    echo "workspace close $*" >>"${FAKE_HERDR_LOG:-/dev/null}"
    printf '{"id":"t","result":{"type":"workspace_closed"}}\n'
    exit 0 ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$BIN/herdr"

SNAP="$TMP_ROOT/snapshot.json"
jq -n --arg idle "$PILE/ws-idle" --arg live "$PILE/ws-live" \
      --arg staletok "$PILE/ws-stale-token" --arg blockedtok "$PILE/ws-blocked-token" \
      --arg nostatus "$PILE/ws-no-status" '
  { id: "t",
    result: { type: "session_snapshot",
      snapshot: { protocol: 19, version: "0.8.0",
        workspaces: [
          { workspace_id: "wIdle", agent_status: "idle",
            worktree: { checkout_path: $idle, is_linked_worktree: true } },
          { workspace_id: "wLive", agent_status: "working",
            worktree: { checkout_path: $live, is_linked_worktree: true } },
          # GH-2118: finished session that never cleared its self-report token
          { workspace_id: "wStaleTok", agent_status: "idle",
            worktree: { checkout_path: $staletok, is_linked_worktree: true } },
          # blocked token outranks a done agent — that tree waits on a human
          { workspace_id: "wBlockedTok", agent_status: "done",
            worktree: { checkout_path: $blockedtok, is_linked_worktree: true } },
          # no known agent status anywhere — the token keeps its authority
          { workspace_id: "wNoStatus",
            worktree: { checkout_path: $nostatus, is_linked_worktree: true } },
          # GH-2215: TEAM spaces — no worktree, label is the canonical team
          # address. These are the orphan-space pass subjects.
          { workspace_id: "wTeamIdle", label: "repo/t31-shipped-epic" },
          { workspace_id: "wTeamLive", label: "repo/t32-live-epic", agent_status: "working" },
          # an id a server restart recycled: flagged, but the label belongs to
          # another workspace — the identity proof must refuse it
          { workspace_id: "wRecycled", label: "unrelated-project" } ],
        panes: [
          { pane_id: "p1", workspace_id: "wStaleTok", tokens: { state: "reporting" } },
          { pane_id: "p2", workspace_id: "wBlockedTok", tokens: { state: "blocked" } },
          { pane_id: "p3", workspace_id: "wNoStatus", tokens: { state: "working" } } ],
        agents: [] } } }' >"$SNAP"

HLOG="$TMP_ROOT/herdr.log"
: >"$HLOG"

# --- ledger fixture: orphan_space flags from the event healer (GH-2215) ------
# wTeamIdle: flagged, present, idle, label matches → the one closable subject.
# wTeamLive: flagged, present, but live → LISTED. wGone: flagged, absent from
# the snapshot → settled, skipped. wRecycled: flagged for GH-40 but the id now
# wears an unrelated label → the identity proof refuses it.
LEDGER="$TMP_ROOT/ledger.jsonl"
cat >"$LEDGER" <<'EOF_LEDGER'
{"ts":"2026-08-28T00:00:00Z","ev":"spawn","agent_ref":"w1-not-an-orphan#1","workspace_id":"wIdle"}
{"ts":"2026-08-28T00:01:00Z","ev":"orphan_space","agent_ref":"o31-shipped-epic#1700000000","workspace_id":"wTeamIdle","reason":"pane_exited","via":"event"}
{"ts":"2026-08-28T00:02:00Z","ev":"orphan_space","agent_ref":"o32-live-epic#1700000001","workspace_id":"wTeamLive","reason":"pane_exited","via":"event"}
{"ts":"2026-08-28T00:03:00Z","ev":"orphan_space","agent_ref":"o99-vanished#1700000002","workspace_id":"wGone","reason":"pane_exited","via":"event"}
{"ts":"2026-08-28T00:04:00Z","ev":"orphan_space","agent_ref":"o40-old-team#1700000003","workspace_id":"wRecycled","reason":"pane_exited","via":"event"}
EOF_LEDGER

# run_sweep [args...] — from a neutral cwd. Capture as:
#   out=$(run_sweep ...) && RC=0 || RC=$?
run_sweep() {
  (cd "$TMP_ROOT" && env \
    HERDR_BIN_PATH="$BIN/herdr" \
    RALPH_HERDR_SCRIPTS_DIR="$TRANSPORT_DIR" \
    RALPH_HERDR_REPO="$TMP_ROOT/repo" \
    RALPH_HERDR_WORKTREES_ROOT="$WT_ROOT" \
    FAKE_SNAP_FILE="$SNAP" \
    FAKE_HERDR_LOG="$HLOG" \
    RALPH_HERDR_LEDGER="$LEDGER" \
    bash "$SRC" sweep "$@" 2>&1)
}

echo "herdr-setup.sh sweep — finished fleet worktrees (GH-2103)"

# --- 1. dry run: candidates named, nothing touched, exit 1 --------------------
out=$(run_sweep) && RC=0 || RC=$?
expect "dry run banner" "$out" "DRY RUN — nothing is closed, killed or removed"
expect "merged+clean, no workspace → WOULD git worktree remove" "$out" \
  "WOULD remove worktree $PILE/merged-clean (clean, merged into origin/main, no herdr workspace)"
expect "merged+clean, idle workspace → WOULD herdr worktree remove" "$out" \
  "WOULD remove workspace wIdle + checkout $PILE/ws-idle"
expect "dirty tree LISTED" "$out" "LIST  worktree $PILE/dirty — tree is dirty"
expect "unmerged head LISTED" "$out" "LIST  worktree $PILE/unmerged — not merged"
expect "live session LISTED" "$out" "LIST  worktree $PILE/ws-live (workspace wLive) — session is live (working)"
expect "stray dir LISTED, remove-by-hand" "$out" "LIST  dir $PILE/stray-dir — not a linked worktree"
refute "live worktree never a WOULD row" "$out" "WOULD remove workspace wLive"
# GH-2118: idle agent + leftover 'reporting' token = finished, not live
expect "stale token on an idle agent → WOULD remove, override named" "$out" \
  "WOULD remove workspace wStaleTok + checkout $PILE/ws-stale-token (clean, merged into origin/main, session idle; stale 'reporting' pane token overridden — its agent is idle/done)"
refute "stale token never reads as live" "$out" "worktree $PILE/ws-stale-token (workspace wStaleTok) — session is live"
expect "blocked token outranks a done agent — LISTED live" "$out" \
  "LIST  worktree $PILE/ws-blocked-token (workspace wBlockedTok) — session is live (blocked)"
refute "blocked-token worktree never a WOULD row" "$out" "WOULD remove workspace wBlockedTok"
expect "token with no known agent status stays authoritative — LISTED live" "$out" \
  "LIST  worktree $PILE/ws-no-status (workspace wNoStatus) — session is live (working)"
refute "no-status worktree never a WOULD row" "$out" "WOULD remove workspace wNoStatus"
# GH-2215: flagged orphan team spaces — the D3.3 backstop
expect "flagged idle team space with matching label → WOULD close" "$out" \
  "WOULD close orphaned team space wTeamIdle (repo/t31-shipped-epic; lead o31-shipped-epic#1700000000 died — the D3.3 backstop)"
expect "flagged but live team space LISTED, never closed" "$out" \
  "LIST  team space wTeamLive (repo/t32-live-epic) — flagged orphaned but session is live (working) — never touched"
refute "live team space never a WOULD row" "$out" "WOULD close orphaned team space wTeamLive"
expect "recycled id refused by the label proof — LISTED" "$out" \
  "LIST  team space wRecycled — flagged for GH-40 (lead o40-old-team#1700000003) but its label 'unrelated-project' is not that team's — id likely recycled; inspect by hand"
refute "recycled id never a WOULD row" "$out" "WOULD close orphaned team space wRecycled"
refute "a flag whose workspace is gone is settled — no row at all" "$out" "wGone"
[ "$RC" -eq 1 ] && pass "dry run with findings exits 1" || fail "dry run with findings exits 1" "rc=$RC"
for d in merged-clean dirty unmerged ws-idle ws-live stray-dir; do
  [ -d "$PILE/$d" ] || { fail "dry run touched nothing" "$d is gone"; break; }
done
[ -d "$PILE/merged-clean" ] && pass "dry run touched nothing"
[ -s "$HLOG" ] && fail "dry run never called herdr worktree remove" "$(cat "$HLOG")" ||
  pass "dry run never called herdr worktree remove"

# --- 2. self-guard: the tree the sweep runs from is LISTED --------------------
out=$(cd "$PILE/merged-clean" && env \
  HERDR_BIN_PATH="$BIN/herdr" RALPH_HERDR_SCRIPTS_DIR="$TRANSPORT_DIR" \
  RALPH_HERDR_REPO="$PILE/merged-clean" RALPH_HERDR_WORKTREES_ROOT="$WT_ROOT" \
  FAKE_SNAP_FILE="$SNAP" FAKE_HERDR_LOG="$HLOG" \
  bash "$SRC" sweep 2>&1) || true
expect "own worktree LISTED, never a candidate" "$out" \
  "LIST  worktree $PILE/merged-clean — this sweep is running inside it"
refute "own worktree never a WOULD row" "$out" "WOULD remove worktree $PILE/merged-clean"

# --- 3. --limit 1 --apply: one action, the rest SKIP ---------------------------
out=$(run_sweep --apply --limit 1) && RC=0 || RC=$?
expect "apply banner names the limit" "$out" "APPLY mode — acting, limit 1 action(s)"
acted=$(grep -c "^  SWEEP" <<<"$out" || true)
[ "$acted" -eq 1 ] && pass "--limit 1 acts exactly once" || fail "--limit 1 acts exactly once" "$out"
expect "over-limit candidate SKIPped" "$out" "per-sweep limit 1 reached"

# --- 4. full --apply: candidates removed, everything listed survives ----------
out=$(run_sweep --apply) && RC=0 || RC=$?
[ "$RC" -eq 1 ] && pass "apply with findings exits 1" || fail "apply with findings exits 1" "rc=$RC"
[ ! -d "$PILE/merged-clean" ] && pass "merged+clean checkout removed" ||
  fail "merged+clean checkout removed" "still on disk"
git -C "$TMP_ROOT/repo" worktree list | grep -q "merged-clean" &&
  fail "git no longer lists the removed worktree" "$(git -C "$TMP_ROOT/repo" worktree list)" ||
  pass "git no longer lists the removed worktree"
grep -q "worktree remove --workspace wIdle" "$HLOG" &&
  pass "idle workspace removed through herdr" ||
  fail "idle workspace removed through herdr" "$(cat "$HLOG")"
grep -q "worktree remove --workspace wLive" "$HLOG" &&
  fail "live workspace never removed" "$(cat "$HLOG")" ||
  pass "live workspace never removed"
grep -q "worktree remove --workspace wStaleTok" "$HLOG" &&
  pass "stale-token workspace removed through herdr (GH-2118)" ||
  fail "stale-token workspace removed through herdr (GH-2118)" "$(cat "$HLOG")"
grep -Eq "worktree remove --workspace (wBlockedTok|wNoStatus)" "$HLOG" &&
  fail "blocked-token and no-status workspaces never removed" "$(cat "$HLOG")" ||
  pass "blocked-token and no-status workspaces never removed"
grep -q "workspace close wTeamIdle" "$HLOG" &&
  pass "flagged idle team space closed through herdr (GH-2215)" ||
  fail "flagged idle team space closed through herdr (GH-2215)" "$(cat "$HLOG")"
grep -Eq "workspace close (wTeamLive|wRecycled|wGone)" "$HLOG" &&
  fail "live/recycled/absent team spaces never closed" "$(cat "$HLOG")" ||
  pass "live/recycled/absent team spaces never closed"
for d in dirty unmerged ws-live ws-blocked-token ws-no-status stray-dir; do
  [ -d "$PILE/$d" ] || { fail "listed trees survive --apply" "$d is gone"; break; }
done
[ -d "$PILE/dirty" ] && pass "listed trees survive --apply"

# --- 5. unavailable snapshot: not evaluable, exit 2 ----------------------------
out=$(cd "$TMP_ROOT" && env \
  HERDR_BIN_PATH="$BIN/herdr" RALPH_HERDR_SCRIPTS_DIR="$TRANSPORT_DIR" \
  RALPH_HERDR_REPO="$TMP_ROOT/repo" RALPH_HERDR_WORKTREES_ROOT="$WT_ROOT" \
  bash "$SRC" sweep 2>&1) && rc=0 || rc=$?
expect "unreadable snapshot says not evaluable" "$out" "not evaluable — herdr snapshot unavailable"
[ "$rc" -eq 2 ] && pass "unreadable snapshot exits 2" || fail "unreadable snapshot exits 2" "rc=$rc"

# --- 6. empty pile: nothing to sweep, exit 0 -----------------------------------
EMPTY_ROOT="$TMP_ROOT/empty-root"
mkdir -p "$EMPTY_ROOT"
out=$(cd "$TMP_ROOT" && env \
  HERDR_BIN_PATH="$BIN/herdr" RALPH_HERDR_SCRIPTS_DIR="$TRANSPORT_DIR" \
  RALPH_HERDR_REPO="$TMP_ROOT/repo" RALPH_HERDR_WORKTREES_ROOT="$EMPTY_ROOT" \
  FAKE_SNAP_FILE="$SNAP" \
  bash "$SRC" sweep 2>&1) && rc=0 || rc=$?
expect "empty pile reports nothing to sweep" "$out" "nothing to sweep"
[ "$rc" -eq 0 ] && pass "empty pile exits 0" || fail "empty pile exits 0" "rc=$rc"
# no RALPH_HERDR_LEDGER and no board scope in the repo: the orphan-space pass
# forfeits with a note — never exit 2, never a finding
expect "no board scope: orphan pass notes and forfeits" "$out" \
  "note orphan team spaces not evaluable — no board scope discoverable"

# --- 6b. unreadable ledger: a note, never 'no flags', never a close ------------
BADLEDGER="$TMP_ROOT/bad-ledger.jsonl"
echo "this is not json" >"$BADLEDGER"
: >"$HLOG"
out=$(cd "$TMP_ROOT" && env \
  HERDR_BIN_PATH="$BIN/herdr" RALPH_HERDR_SCRIPTS_DIR="$TRANSPORT_DIR" \
  RALPH_HERDR_REPO="$TMP_ROOT/repo" RALPH_HERDR_WORKTREES_ROOT="$EMPTY_ROOT" \
  FAKE_SNAP_FILE="$SNAP" FAKE_HERDR_LOG="$HLOG" RALPH_HERDR_LEDGER="$BADLEDGER" \
  bash "$SRC" sweep --apply 2>&1) && rc=0 || rc=$?
expect "unreadable ledger says so" "$out" \
  "note orphan team spaces not evaluable — ledger unreadable"
grep -q "workspace close" "$HLOG" &&
  fail "unreadable ledger closes nothing" "$(cat "$HLOG")" ||
  pass "unreadable ledger closes nothing"

# --- 7. --apply/--limit stay refused outside reap/sweep ------------------------
out=$(bash "$SRC" check --apply 2>&1) && rc=0 || rc=$?
expect "check --apply refused" "$out" "--apply/--limit belong to the reap and sweep verbs"
[ "$rc" -eq 64 ] && pass "check --apply exits 64" || fail "check --apply exits 64" "rc=$rc"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
