#!/usr/bin/env bash
# lane-pass.test.sh — executable tests for the ONE-TAB lane shape (GH-2317):
# lane-open.sh places the launcher pane as a tab in the repo's MAIN workspace
# (the GH-2246 resolution, shared in lib.sh's ralph_main_ws_from_list), and
# deliver-pass.sh / tend-pass.sh split the agent pane beside themselves —
# renaming their tab from the LANE — instead of creating a second tab. The
# bare-shell fallback (no HERDR_PANE_ID) keeps the old lane-tab shape, now
# labeled from the lane. Cleanup on a refused agent start closes exactly the
# surface this run created: the split pane in-tab, the tab in fallback.
#
#   bash plugin/ralph-herdr/tests/lane-pass.test.sh   # exits 0 pass, 1 fail
#
# All herdr traffic goes through tests/fake-herdr.sh, all board traffic
# through tests/fake-board.sh — no server, no GitHub, no writes outside $TMP.
# bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-lane-pass-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

# The scripts are copied so notify-watch.sh (exec'd on success — an infinite
# watcher) can be stubbed without touching the real tree.
cp -R "$SCRIPT_DIR/../scripts" "$TMP/scripts"
cat >"$TMP/scripts/notify-watch.sh" <<'EOF'
#!/usr/bin/env bash
echo "notify-watch ${1-}"
EOF
chmod +x "$TMP/scripts/notify-watch.sh"
SCRIPTS="$TMP/scripts"

BIN="$TMP/bin"
mkdir -p "$BIN"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-herdr.sh" >"$BIN/herdr"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-board.sh" >"$BIN/board"
chmod +x "$BIN/herdr" "$BIN/board"
export PATH="$BIN:$PATH"
export HERDR_BIN_PATH="$BIN/herdr"
export RALPH_HERDR_BOARD="$BIN/board"
export FAKE_HERDR_FIXTURES="$TMP/fixtures"
export FAKE_HERDR_LOG="$TMP/herdr.log"
export FAKE_BOARD_FIXTURES="$TMP/board-fixtures"
export FAKE_BOARD_LOG="$TMP/board.log"
mkdir -p "$FAKE_HERDR_FIXTURES" "$FAKE_BOARD_FIXTURES"
export RALPH_HERDR_LEDGER_ROOT="$TMP/ledger-root"

REPO_DIR="$TMP/repo"
mkdir -p "$REPO_DIR"
printf '{"owner":"fake","repo":"fake","projectNumber":1}\n' >"$REPO_DIR/.ralph.json"
export RALPH_HERDR_REPO="$REPO_DIR"

# Process containment (GH-2266): the tender is a contained role, so the live
# tend path runs the in-pane probe. The platform is pinned to the measured one
# (CI runs this suite on Linux, where the honest answer is a refusal — tested
# below on purpose), RALPH_HOME keeps the outside marker inside $TMP, the
# `agent wait` fixture lets the turn-confirmation return at once, and the hook
# plays the pane: it touches what an obedient pane under each sandbox state
# would produce.
export RALPH_HERDR_UNAME=Darwin
export RALPH_HOME="$TMP/home"
mkdir -p "$RALPH_HOME"
printf '{"agent":{"name":"ralph-tend","agent_status":"working","pane_id":"pS1","workspace_id":"w1","tab_id":"w1:t1","terminal_id":"term_fake","focused":false,"revision":2}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-wait-until.ralph-tend.json"
cat >"$TMP/probe-hook.sh" <<'HOOK'
#!/usr/bin/env bash
paths=$(printf '%s' "$2" | grep -o "touch '[^']*' '[^']*'" | head -1)
[ -n "$paths" ] || exit 0
inside=$(printf '%s' "$paths" | sed -n "s/^touch '\([^']*\)' '.*$/\1/p")
outside=$(printf '%s' "$paths" | sed -n "s/^touch '[^']*' '\([^']*\)'$/\1/p")
case "${FAKE_PROBE_MODE:-applied}" in
  applied) touch "$outside" ;;
  inert) touch "$inside" "$outside" ;;
  silent) : ;;
esac
HOOK
chmod +x "$TMP/probe-hook.sh"
export FAKE_HERDR_PROMPT_HOOK="$TMP/probe-hook.sh"
export FAKE_PROBE_MODE=applied
REPO_REAL=$(cd "$REPO_DIR" && pwd -P)

# A non-empty queue head for both lanes; the empty default models the
# spawn-nothing contract.
printf '{"next":{"number":42},"queue":[{"number":42}]}\n' >"$FAKE_BOARD_FIXTURES/deliver-queue.json"
printf '{"next":{"number":43},"queue":[{"number":43}]}\n' >"$FAKE_BOARD_FIXTURES/tend-queue.json"

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
has() {
  if printf '%s' "$2" | grep -q -- "$3"; then ok "$1"; else not_ok "$1 — no '$3' in: $(printf '%s' "$2" | head -5)"; fi
}
log_has() {
  if grep -q -- "$2" "$FAKE_HERDR_LOG" 2>/dev/null; then ok "$1"; else not_ok "$1 — no '$2' in herdr log: $(head -8 "$FAKE_HERDR_LOG" 2>/dev/null)"; fi
}
log_hasnt() {
  if grep -q -- "$2" "$FAKE_HERDR_LOG" 2>/dev/null; then not_ok "$1 — found '$2' in herdr log"; else ok "$1"; fi
}

reset() {
  : >"$FAKE_HERDR_LOG"
  : >"$FAKE_BOARD_LOG"
  rm -f "$FAKE_HERDR_FIXTURES"/agent-start.json "$FAKE_HERDR_FIXTURES"/agent-start.rc \
    "$FAKE_HERDR_FIXTURES"/workspace-list.json "$FAKE_HERDR_FIXTURES"/workspace-list.rc \
    "$FAKE_HERDR_FIXTURES"/pane-split.json "$FAKE_HERDR_FIXTURES"/pane-split.rc
}

run_lane() { # LANE [env VAR=…] — run the copied pass script </dev/null
  local lane="$1"
  (cd "$REPO_DIR" && bash "$SCRIPTS/$lane-pass.sh" </dev/null 2>&1)
}

# ── 1. empty queue spawns nothing ────────────────────────────────────────────
reset
rm -f "$FAKE_BOARD_FIXTURES/deliver-queue.json"
out=$(RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane deliver)
has "deliver: empty queue says so" "$out" "deliver queue empty"
log_hasnt "deliver: empty queue makes no herdr call" "pane split"
printf '{"next":{"number":42},"queue":[{"number":42}]}\n' >"$FAKE_BOARD_FIXTURES/deliver-queue.json"

# ── 2. in-tab shape: rename own tab from the lane, split the agent pane ──────
reset
out=$(RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane deliver)
log_has "deliver: own tab renamed from the LANE" "tab rename w1:t1 deliver"
log_has "deliver: agent pane is a split of the launcher pane" "pane split w1:p9 --direction down --cwd $REPO_DIR --no-focus"
log_has "deliver: agent starts in the SPLIT pane" "agent start ralph-deliver --kind claude --pane pS1"
log_hasnt "deliver: in-tab shape creates NO second tab" "tab create"
log_has "deliver: the pass prompt goes to the agent" "agent prompt ralph-deliver /ralph:deliver"
has "deliver: the watcher takes over the launcher pane" "$out" "notify-watch ralph-deliver"
has "deliver: the spawn line names the queue head" "$out" "queue head #42"

# ── 3. bare-shell fallback: a fresh lane tab, labeled from the lane ──────────
reset
out=$(env -u HERDR_PANE_ID bash -c "cd '$REPO_DIR' && bash '$SCRIPTS/deliver-pass.sh' </dev/null 2>&1")
log_has "deliver fallback: tab created with the LANE label" "tab create --cwd $REPO_DIR --label deliver --no-focus"
log_hasnt "deliver fallback: no split without a pane to split" "pane split"
log_has "deliver fallback: agent starts in the tab's root pane" "agent start ralph-deliver --kind claude --pane pTF"
has "deliver fallback: the watcher still takes over" "$out" "notify-watch ralph-deliver"

# ── 3b. a pane WITHOUT the lane-tab marker keeps the fallback shape ──────────
# invoke.sh's default split placement (and any hand-opened plugin pane) has an
# HERDR_PANE_ID but sits in a tab someone else owns — the lane may not rename
# or split it (PR #2326 P2).
reset
out=$(env -u RALPH_HERDR_LANE_TAB bash -c "cd '$REPO_DIR' && HERDR_PANE_ID=w1:p9 bash '$SCRIPTS/deliver-pass.sh' </dev/null 2>&1")
log_hasnt "deliver unmarked pane: never renames the host tab" "tab rename"
log_hasnt "deliver unmarked pane: never splits the host tab" "pane split"
log_has "deliver unmarked pane: falls back to its own lane tab" "tab create --cwd $REPO_DIR --label deliver --no-focus"

# ── 4. refused agent start cleans up exactly what this run created ───────────
reset
printf '{"error":{"code":"agent_name_taken","message":"an agent named ralph-deliver is already running"}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-start.json"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-start.rc"
out=$(RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane deliver)
rc=$?
if [ "$rc" -ne 0 ]; then ok "deliver: a refused start fails the pass"; else not_ok "deliver: a refused start fails the pass (rc 0)"; fi
log_has "deliver: in-tab cleanup closes the empty SPLIT pane" "pane close pS1"
log_hasnt "deliver: in-tab cleanup never closes a tab" "tab close"
has "deliver: the refusal names the taken name as the common cause" "$out" "live deliver pass owning the name"

reset
printf '{"error":{"code":"agent_name_taken","message":"an agent named ralph-deliver is already running"}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-start.json"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-start.rc"
out=$(env -u HERDR_PANE_ID bash -c "cd '$REPO_DIR' && bash '$SCRIPTS/deliver-pass.sh' </dev/null 2>&1")
log_has "deliver fallback: cleanup closes the tab this run created" "tab close w1:tF"
log_hasnt "deliver fallback: cleanup closes no pane" "pane close"

# ── 4b. an UNCERTAIN start (silence, transport failure) closes nothing ───────
# The start may have landed — closing the pane could kill a live agent
# (PR #2326 P1). The surface is left up and the message says why.
reset
: >"$FAKE_HERDR_FIXTURES/agent-start.raw"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-start.rc"
out=$(RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane deliver)
rc=$?
rm -f "$FAKE_HERDR_FIXTURES/agent-start.raw" "$FAKE_HERDR_FIXTURES/agent-start.rc"
if [ "$rc" -ne 0 ]; then ok "deliver: an unanswered start fails the pass"; else not_ok "deliver: an unanswered start fails the pass (rc 0)"; fi
log_hasnt "deliver: an unanswered start closes NO pane" "pane close"
log_hasnt "deliver: an unanswered start closes NO tab" "tab close"
has "deliver: the unanswered start says the pane is left up" "$out" "MAY have landed"

# ── 5. tend rides the same shape, tool binding intact (GH-2265) ──────────────
reset
out=$(RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane tend)
log_has "tend: own tab renamed from the LANE" "tab rename w1:t1 tend"
log_has "tend: agent pane is a split of the launcher pane" "pane split w1:p9 --direction down"
log_has "tend: the tender's registry tool binding survives the reshape" "agent start ralph-tend --kind claude --pane pS1 -- --disallowedTools"
has "tend: the watcher takes over" "$out" "notify-watch ralph-tend"
# GH-2266: process containment rides the same argv, as a SEPARATE flag
log_has "tend: the sandbox profile reaches the harness argv beside tool binding" \
  "agent start ralph-tend --kind claude --pane pS1 -- --disallowedTools Edit,Write,NotebookEdit --settings {\"sandbox\":{\"enabled\":true,\"failIfUnavailable\":true"
log_has "tend: the profile denies the checkout by REALPATH" "\"denyWrite\":\[\"$REPO_REAL\"\]"
log_has "tend: the probe prompt reaches the pane BEFORE the pass prompt" "agent prompt ralph-tend Containment self-test"
has "tend: the pass reports the observed outcome" "$out" "process containment: applied for ralph-tend"
has "tend: tool binding is reported beside it as its own line (GH-2267)" "$out" "tool binding: accepted for ralph-tend"
case "$(grep 'agent prompt ralph-tend' "$FAKE_HERDR_LOG" | head -2 | tail -1)" in
  *"/ralph:tend"*) ok "tend: the real prompt is delivered only AFTER the probe" ;;
  *) not_ok "tend: prompt order — got: $(grep 'agent prompt ralph-tend' "$FAKE_HERDR_LOG" | cut -c1-80)" ;;
esac

# ── 5b. an INERT sandbox (pane wrote inside the tree) refuses and closes ─────
# The criterion this unit exists for: a malformed profile produces no error
# and a writable pane; the probe is what turns that into a refusal.
reset
out=$(FAKE_PROBE_MODE=inert RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane tend)
rc=$?
if [ "$rc" -ne 0 ]; then ok "tend inert: an uncontained pane FAILS the pass"; else not_ok "tend inert: an uncontained pane must fail the pass (rc 0)"; fi
has "tend inert: the failure names not_applied" "$out" "process containment not_applied for ralph-tend"
log_has "tend inert: the split pane this run created is closed" "pane close pS1"
log_hasnt "tend inert: the real prompt is NEVER delivered to an uncontained pane" "agent prompt ralph-tend /ralph:tend"
case "$out" in
  *"notify-watch"*) not_ok "tend inert: the watcher must not take over a refused pass" ;;
  *) ok "tend inert: no watcher hand-off on refusal" ;;
esac
[ -e "$REPO_DIR/.ralph-containment-probe-ralph-tend" ] && not_ok "tend inert: the marker the inert pane wrote is cleaned up" || ok "tend inert: the marker the inert pane wrote is cleaned up"

# ── 5c. a pane that produces NO marker is unverified — refused, distinctly ──
reset
out=$(FAKE_PROBE_MODE=silent RALPH_HERDR_CONTAINMENT_PROBE_SEC=1 RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane tend)
rc=$?
if [ "$rc" -ne 0 ]; then ok "tend silent: an unverifiable pane FAILS the pass"; else not_ok "tend silent: an unverifiable pane must fail the pass (rc 0)"; fi
has "tend silent: the failure names unverified, not not_applied" "$out" "process containment unverified for ralph-tend"
log_has "tend silent: the pane is closed" "pane close pS1"
log_hasnt "tend silent: no real prompt" "agent prompt ralph-tend /ralph:tend"

# ── 5d. an unmeasured platform refuses BEFORE any surface exists ─────────────
reset
out=$(RALPH_HERDR_UNAME=Linux RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane tend)
rc=$?
if [ "$rc" -ne 0 ]; then ok "tend linux: refuses"; else not_ok "tend linux: must refuse (rc 0)"; fi
has "tend linux: the refusal names not_available" "$out" "not_available on Linux"
log_hasnt "tend linux: no pane was split for a spawn that refused" "pane split"
log_hasnt "tend linux: no agent was started" "agent start"

# ── 6. dry run narrates the in-tab plan and mutates nothing ──────────────────
reset
out=$(RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" RALPH_HERDR_DRY_RUN=true run_lane deliver)
has "deliver dry run: narrates the rename" "$out" "tab rename <own tab> deliver"
has "deliver dry run: narrates the split" "$out" "pane split w1:p9 --direction down"
log_hasnt "deliver dry run: mutates nothing" "pane split"
reset
out=$(env -u HERDR_PANE_ID bash -c "cd '$REPO_DIR' && RALPH_HERDR_DRY_RUN=true bash '$SCRIPTS/deliver-pass.sh' </dev/null 2>&1")
has "deliver dry run (bare shell): narrates the lane-labeled tab" "$out" 'tab create --cwd .* --label "deliver" --no-focus'

# ── 7. lane-open.sh: the tab lands in the repo's MAIN workspace ──────────────
# The fake's `worktree list` reports /tmp/fake-herdr-parent as the source
# checkout; a workspace-list fixture worktree-bound to it is the main space.
MAIN_WS='{"workspace_id":"wM","label":"fake-herdr-parent","number":2,"pane_count":1,"tab_count":1,"active_tab_id":"wM:t1","agent_status":"idle","focused":false,"worktree":{"checkout_path":"/tmp/fake-herdr-parent","is_linked_worktree":false,"repo_key":"/tmp/fake-herdr-parent/.git","repo_name":"fake","repo_root":"/tmp/fake-herdr-parent"}}'
reset
printf '{"workspaces":[%s]}\n' "$MAIN_WS" >"$FAKE_HERDR_FIXTURES/workspace-list.json"
out=$(cd "$REPO_DIR" && bash "$SCRIPTS/lane-open.sh" deliver </dev/null 2>&1)
rc=$?
if [ "$rc" -eq 0 ]; then ok "lane-open: a resolvable main workspace exits 0"; else not_ok "lane-open: a resolvable main workspace exits 0 (rc $rc): $out"; fi
log_has "lane-open: the launcher pane opens AS A TAB in the main workspace" \
  "plugin pane open --plugin ralph-herdr --entrypoint deliver-pass --workspace wM --placement tab --cwd /tmp/fake-herdr-parent --env RALPH_HERDR_LANE_TAB=1 --focus"

# The label-fallback half of the GH-2246 rule: a main workspace this plugin
# itself created reports no worktree object, only the checkout's basename.
reset
printf '{"workspaces":[{"workspace_id":"wC","label":"fake-herdr-parent","number":3,"pane_count":1,"tab_count":1,"active_tab_id":"wC:t1","agent_status":"idle","focused":false}]}\n' \
  >"$FAKE_HERDR_FIXTURES/workspace-list.json"
out=$(cd "$REPO_DIR" && bash "$SCRIPTS/lane-open.sh" tend </dev/null 2>&1)
log_has "lane-open: the label fallback resolves a created main workspace" \
  "plugin pane open --plugin ralph-herdr --entrypoint tend-pass --workspace wC --placement tab"

# ── 7b. an AMBIGUOUS label-only match resolves nothing (PR #2326 P2) ─────────
# Two repos can share a checkout basename; a label-only workspace carries
# nothing else to tell them apart, so the fallback must refuse to pick.
reset
printf '{"workspaces":[{"workspace_id":"wC1","label":"fake-herdr-parent","number":3,"pane_count":1,"tab_count":1,"active_tab_id":"wC1:t1","agent_status":"idle","focused":false},{"workspace_id":"wC2","label":"fake-herdr-parent","number":4,"pane_count":1,"tab_count":1,"active_tab_id":"wC2:t1","agent_status":"idle","focused":false}]}\n' \
  >"$FAKE_HERDR_FIXTURES/workspace-list.json"
out=$(cd "$REPO_DIR" && bash "$SCRIPTS/lane-open.sh" deliver </dev/null 2>&1)
has "lane-open: an ambiguous label match falls back, noted" "$out" "could not resolve the repo's main workspace"
log_hasnt "lane-open: an ambiguous label match picks NO workspace" "--workspace"

# ── 8. lane-open.sh fails OPEN: unresolvable main workspace still opens ──────
reset
printf '{"error":{"code":"server_unavailable","message":"no server"}}\n' >"$FAKE_HERDR_FIXTURES/workspace-list.json"
printf '1\n' >"$FAKE_HERDR_FIXTURES/workspace-list.rc"
out=$(cd "$REPO_DIR" && bash "$SCRIPTS/lane-open.sh" deliver </dev/null 2>&1)
rc=$?
if [ "$rc" -eq 0 ]; then ok "lane-open: an unreadable workspace list still opens the lane"; else not_ok "lane-open: an unreadable workspace list still opens the lane (rc $rc): $out"; fi
has "lane-open: the fallback placement is NOTED, never silent" "$out" "could not resolve the repo's main workspace"
log_has "lane-open: the fallback opens in the invoking workspace (no --workspace)" \
  "plugin pane open --plugin ralph-herdr --entrypoint deliver-pass --placement tab"
log_hasnt "lane-open: the fallback names no workspace" "--workspace"

# ── 9. lane-open.sh refuses an unknown lane ──────────────────────────────────
reset
out=$(cd "$REPO_DIR" && bash "$SCRIPTS/lane-open.sh" bogus </dev/null 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then ok "lane-open: an unknown lane is a usage refusal"; else not_ok "lane-open: an unknown lane is a usage refusal (rc 0)"; fi
has "lane-open: the refusal names the accepted lanes" "$out" "deliver|tend"

echo
# ── GH-2266: the dry run narrates the containment plan and mutates nothing ───
reset
out=$(RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" RALPH_HERDR_DRY_RUN=true run_lane tend)
has "tend dry: the plan shows the sandbox beside tool binding" "$out" \
  "-- --disallowedTools Edit,Write,NotebookEdit --settings <process containment: seatbelt denyWrite $REPO_DIR>"
has "tend dry: the plan names the probe and its refusal" "$out" "containment probe: prompt <captured> to touch"
has "tend dry: the plan reports tool binding off the argv, separately (GH-2267)" "$out" "tool binding: accepted (read off the argv"
log_hasnt "tend dry: no agent started" "agent start"
log_hasnt "tend dry: no prompt sent" "agent prompt"

echo "$pass passed, $fail failed ($n total)"
[ "$fail" -eq 0 ]
