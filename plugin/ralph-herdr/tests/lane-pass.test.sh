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
printf '{"agent":{"name":"t0-tend","agent_status":"working","pane_id":"pS1","workspace_id":"w1","tab_id":"w1:t1","terminal_id":"term_fake","focused":false,"revision":2}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-wait-until.t0-tend.json"
cat >"$TMP/probe-hook.sh" <<'HOOK'
#!/usr/bin/env bash
paths=$(printf '%s' "$2" | grep -o "touch '[^']*' '[^']*'" | head -1)
[ -n "$paths" ] || exit 0
inside=$(printf '%s' "$paths" | sed -n "s/^touch '\([^']*\)' '.*$/\1/p")
outside=$(printf '%s' "$paths" | sed -n "s/^touch '[^']*' '\([^']*\)'$/\1/p")
tool=$(printf '%s' "$2" | sed -n "s/^.*create the file '\([^']*\)' with the content.*$/\1/p" | head -1)
control=$(printf '%s' "$2" | sed -n "s/^touch '\([^']*\)'; echo CONTROL_RC.*$/\1/p" | head -1)
case "${FAKE_PROBE_MODE:-applied}" in
  applied) touch "$outside"; [ -n "$control" ] && touch "$control" ;;
  inert) touch "$inside" "$outside"; [ -n "$control" ] && touch "$control" ;;
  silent) : ;;
  tool-writer) touch "$outside"; [ -n "$tool" ] && touch "$tool"; [ -n "$control" ] && touch "$control" ;;
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

LEDGER_DB="$RALPH_HERDR_LEDGER_ROOT/fake/fake/ledger.sqlite"
# ledger_events — every fact's payload, one JSON object per line (empty when
# no tape exists — a dry run must leave none).
ledger_events() {
  [ -f "$LEDGER_DB" ] || return 0
  sqlite3 "$LEDGER_DB" 'SELECT payload FROM facts ORDER BY seq;' 2>/dev/null
}
# ledger_count JQ_FILTER — how many events satisfy the filter.
ledger_count() {
  ledger_events | jq -c "select($1)" 2>/dev/null | grep -c . || true
}
is() { # NAME EXPECTED ACTUAL
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1 — expected '$2', got '$3'"; fi
}

reset() {
  rm -rf "$RALPH_HERDR_LEDGER_ROOT"
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
log_has "deliver: agent starts in the SPLIT pane" "agent start r0-deliver --kind claude --pane pS1"
log_hasnt "deliver: in-tab shape creates NO second tab" "tab create"
log_has "deliver: the pass prompt goes to the agent" "agent prompt r0-deliver /ralph:deliver"
has "deliver: the watcher takes over the launcher pane" "$out" "notify-watch r0-deliver"
has "deliver: the spawn line names the queue head" "$out" "queue head #42"
# GH-2342: the pass is ledgered — one spawn row, grammar-B ref, role driver,
# both GH-2267 outcomes `not_requested` ON the row (known at record time:
# the deliverer is handed no harness argument), the pane and the checkout.
is "deliver: exactly one spawn row for the pass" "1" \
  "$(ledger_count '.ev=="spawn" and (.agent_ref | test("^r0-deliver#[0-9a-f]{8}$"))')"
is "deliver: the row is a driver at issue 0 with both outcomes not_requested" "1" \
  "$(ledger_count '.ev=="spawn" and .tokens.role=="driver" and .tokens.issue=="0" and .tool_binding=="not_requested" and .process_containment=="not_requested" and .lineage.issue==0 and .lineage.role=="driver"')"
is "deliver: the row binds the pane and the checkout" "1" \
  "$(ledger_count '.ev=="spawn" and .pane_id=="pS1" and .checkout=="'"$REPO_DIR"'"')"
is "deliver: no containment event — both outcomes already ride the row" "0" \
  "$(ledger_count '.ev=="containment"')"
is "deliver: the row stays OPEN — a live pass is what an open row means" "0" \
  "$(ledger_count '.ev=="exit"')"
log_has "deliver: spawn tokens pushed onto the agent pane" "pane report-metadata pS1 .*--token role=driver"

# ── 3. bare-shell fallback: a fresh lane tab, labeled from the lane ──────────
reset
out=$(env -u HERDR_PANE_ID bash -c "cd '$REPO_DIR' && bash '$SCRIPTS/deliver-pass.sh' </dev/null 2>&1")
log_has "deliver fallback: tab created with the LANE label" "tab create --cwd $REPO_DIR --label deliver --no-focus"
log_hasnt "deliver fallback: no split without a pane to split" "pane split"
log_has "deliver fallback: agent starts in the tab's root pane" "agent start r0-deliver --kind claude --pane pTF"
has "deliver fallback: the watcher still takes over" "$out" "notify-watch r0-deliver"

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
printf '{"error":{"code":"agent_name_taken","message":"an agent named r0-deliver is already running"}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-start.json"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-start.rc"
out=$(RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane deliver)
rc=$?
if [ "$rc" -ne 0 ]; then ok "deliver: a refused start fails the pass"; else not_ok "deliver: a refused start fails the pass (rc 0)"; fi
log_has "deliver: in-tab cleanup closes the empty SPLIT pane" "pane close pS1"
log_hasnt "deliver: in-tab cleanup never closes a tab" "tab close"
has "deliver: the refusal names the taken name as the common cause" "$out" "live deliver pass owning the name"
# GH-2342: a REFUSED start proved no worker ever existed — the provisional
# row is closed by the spawn path itself, not left for a sweep.
is "deliver refused: the provisional row was written" "1" "$(ledger_count '.ev=="spawn"')"
is "deliver refused: …and closed never_started by the spawn path" "1" \
  "$(ledger_count '.ev=="exit" and .reason=="never_started" and .via=="spawn" and (.agent_ref | startswith("r0-deliver#"))')"

reset
printf '{"error":{"code":"agent_name_taken","message":"an agent named r0-deliver is already running"}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-start.json"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-start.rc"
out=$(env -u HERDR_PANE_ID bash -c "cd '$REPO_DIR' && bash '$SCRIPTS/deliver-pass.sh' </dev/null 2>&1")
log_has "deliver fallback: cleanup closes the tab this run created" "tab close w1:tF"
log_hasnt "deliver fallback: cleanup closes no pane" "pane close"

# ── 4a. a live pass under the PRE-0.41 name is still a live pass (PR #2354 P1)
# The `agent start` interlock keys on the new name; a `ralph-deliver` pane
# from an older plugin survives an upgrade and must still count. Refused
# before any surface exists.
reset
. "$SCRIPT_DIR/herd-fixture.sh"
herd_fixture '[{"name":"ralph-deliver","agent_status":"working","pane_id":"pL"}]' "$REPO_DIR"
out=$(RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane deliver)
rc=$?
if [ "$rc" -ne 0 ]; then ok "deliver legacy-live: a live ralph-deliver refuses the pass"; else not_ok "deliver legacy-live: a live ralph-deliver must refuse (rc 0)"; fi
has "deliver legacy-live: the refusal names the legacy pane" "$out" "already live under its pre-0.42 name (ralph-deliver)"
log_hasnt "deliver legacy-live: no pane was split" "pane split"
log_hasnt "deliver legacy-live: no agent was started" "agent start"
is "deliver legacy-live: no ledger row for a spawn that never began" "0" "$(ledger_count 'true')"
herd_fixture '[{"name":"ralph-tend","agent_status":"working","pane_id":"pL"}]' "$REPO_DIR"
out=$(RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane tend)
rc=$?
if [ "$rc" -ne 0 ]; then ok "tend legacy-live: a live ralph-tend refuses the pass"; else not_ok "tend legacy-live: a live ralph-tend must refuse (rc 0)"; fi
log_hasnt "tend legacy-live: no agent was started" "agent start"
# A live pass in the OTHER lane is not a collision.
reset
herd_fixture '[{"name":"ralph-tend","agent_status":"working","pane_id":"pL"}]' "$REPO_DIR"
out=$(RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane deliver)
log_has "deliver with a live legacy TEND: still spawns" "agent start r0-deliver"
# An UNREADABLE herd is not an empty one (PR #2354 P1): the legacy pass
# cannot be ruled out, so the lane refuses before any surface exists.
reset
printf '{"error":{"code":"server_unavailable","message":"no server"}}\n' >"$FAKE_HERDR_FIXTURES/api-snapshot.json"
printf '1\n' >"$FAKE_HERDR_FIXTURES/api-snapshot.rc"
out=$(RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane deliver)
rc=$?
rm -f "$FAKE_HERDR_FIXTURES/api-snapshot.rc"
if [ "$rc" -ne 0 ]; then ok "deliver unreadable herd: refuses (a legacy pass cannot be ruled out)"; else not_ok "deliver unreadable herd: must refuse (rc 0)"; fi
has "deliver unreadable herd: the refusal says the herd could not be read, not that a pass is live" "$out" "cannot read the herd"
log_hasnt "deliver unreadable herd: no pane was split" "pane split"
log_hasnt "deliver unreadable herd: no agent was started" "agent start"
is "deliver unreadable herd: no ledger row" "0" "$(ledger_count 'true')"
herd_fixture '[]' "$REPO_DIR"
# …and an EMPTY herd (a successful read with no agents) still spawns.
reset
out=$(RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane deliver)
log_has "deliver empty herd: a successful empty read spawns" "agent start r0-deliver"

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
is "deliver uncertain: the row stays OPEN for reconcile to prove (the start may have landed)" "0" \
  "$(ledger_count '.ev=="exit"')"

# ── 5. tend rides the same shape, tool binding intact (GH-2265) ──────────────
reset
out=$(RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane tend)
log_has "tend: own tab renamed from the LANE" "tab rename w1:t1 tend"
log_has "tend: agent pane is a split of the launcher pane" "pane split w1:p9 --direction down"
log_has "tend: the tender's registry tool binding survives the reshape" "agent start t0-tend --kind claude --pane pS1 -- --disallowedTools"
has "tend: the watcher takes over" "$out" "notify-watch t0-tend"
# GH-2266: process containment rides the same argv, as a SEPARATE flag
log_has "tend: the sandbox profile reaches the harness argv beside tool binding" \
  "agent start t0-tend --kind claude --pane pS1 -- --disallowedTools Edit,Write,NotebookEdit --settings {\"sandbox\":{\"enabled\":true,\"failIfUnavailable\":true"
log_has "tend: the profile denies the checkout by REALPATH" "\"denyWrite\":\[\"$REPO_REAL\"\]"
log_has "tend: the probe prompt reaches the pane BEFORE the pass prompt" "agent prompt t0-tend Containment self-test"
has "tend: the pass reports the observed outcome" "$out" "process containment: applied for t0-tend"
has "tend: tool binding is reported beside it as its own line (GH-2267)" "$out" "tool binding: accepted for t0-tend"
case "$(grep 'agent prompt t0-tend' "$FAKE_HERDR_LOG" | head -2 | tail -1)" in
  *"/ralph:tend"*) ok "tend: the real prompt is delivered only AFTER the probe" ;;
  *) not_ok "tend: prompt order — got: $(grep 'agent prompt t0-tend' "$FAKE_HERDR_LOG" | cut -c1-80)" ;;
esac
# GH-2342: the criterion this unit exists for — the achieved outcomes are
# RECORDED, not only printed. The spawn row is provisional (no containment
# fields — neither existed when it was written) and the `containment` event
# carries both, separately, once the probe has answered.
is "tend: exactly one spawn row, role tender, issue 0" "1" \
  "$(ledger_count '.ev=="spawn" and (.agent_ref | test("^t0-tend#[0-9a-f]{8}$")) and .tokens.role=="tender" and .tokens.issue=="0" and .lineage.role=="tender" and .lineage.issue==0')"
is "tend: the provisional row carries NEITHER outcome (unknown when written)" "1" \
  "$(ledger_count '.ev=="spawn" and (has("tool_binding") | not) and (has("process_containment") | not)')"
is "tend: the containment event records BOTH achieved values, separately" "1" \
  "$(ledger_count '.ev=="containment" and .via=="spawn" and .tool_binding=="accepted" and .process_containment=="applied" and (.agent_ref | startswith("t0-tend#"))')"
is "tend: the containment event names the SAME ref as the spawn row" \
  "$(ledger_events | jq -r 'select(.ev=="spawn") | .agent_ref')" \
  "$(ledger_events | jq -r 'select(.ev=="containment") | .agent_ref')"
is "tend: the row stays OPEN — the pass is live" "0" "$(ledger_count '.ev=="exit"')"
log_has "tend: spawn tokens pushed onto the agent pane" "pane report-metadata pS1 .*--token role=tender"

# ── 5b. an INERT sandbox (pane wrote inside the tree) refuses and closes ─────
# The criterion this unit exists for: a malformed profile produces no error
# and a writable pane; the probe is what turns that into a refusal.
reset
out=$(FAKE_PROBE_MODE=inert RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane tend)
rc=$?
if [ "$rc" -ne 0 ]; then ok "tend inert: an uncontained pane FAILS the pass"; else not_ok "tend inert: an uncontained pane must fail the pass (rc 0)"; fi
has "tend inert: the failure names not_applied" "$out" "process containment not_applied for t0-tend"
log_has "tend inert: the split pane this run created is closed" "pane close pS1"
log_hasnt "tend inert: the real prompt is NEVER delivered to an uncontained pane" "agent prompt t0-tend /ralph:tend"
case "$out" in
  *"notify-watch"*) not_ok "tend inert: the watcher must not take over a refused pass" ;;
  *) ok "tend inert: no watcher hand-off on refusal" ;;
esac
[ -e "$REPO_DIR/.ralph-containment-probe-t0-tend" ] && not_ok "tend inert: the marker the inert pane wrote is cleaned up" || ok "tend inert: the marker the inert pane wrote is cleaned up"
# GH-2342: the REFUSAL is the fact this line of work exists to keep — a
# `not_applied` that lived only in a stderr line was the paperwork nobody
# could re-read. Recorded as the two values, then the row closes naming it.
is "tend inert: the containment event records the refusal (accepted / not_applied)" "1" \
  "$(ledger_count '.ev=="containment" and .tool_binding=="accepted" and .process_containment=="not_applied"')"
is "tend inert: the row is closed with the outcome as its reason" "1" \
  "$(ledger_count '.ev=="exit" and .reason=="containment_not_applied" and .via=="spawn"')"

# ── 5c. a pane that produces NO marker is unverified — refused, distinctly ──
reset
out=$(FAKE_PROBE_MODE=silent RALPH_HERDR_CONTAINMENT_PROBE_SEC=1 RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane tend)
rc=$?
if [ "$rc" -ne 0 ]; then ok "tend silent: an unverifiable pane FAILS the pass"; else not_ok "tend silent: an unverifiable pane must fail the pass (rc 0)"; fi
has "tend silent: the failure names unverified, not not_applied" "$out" "process containment unverified for t0-tend"
log_has "tend silent: the pane is closed" "pane close pS1"
log_hasnt "tend silent: no real prompt" "agent prompt t0-tend /ralph:tend"
is "tend silent: unverified is recorded as unverified — never as not_applied, never as applied" "1" \
  "$(ledger_count '.ev=="containment" and .process_containment=="unverified"')"
is "tend silent: the row closes containment_unverified" "1" \
  "$(ledger_count '.ev=="exit" and .reason=="containment_unverified"')"

# ── 5d. GH-2341: an UNBOUND Write tool writes inside the tree — refused ──────
# The harness accepted --disallowedTools at start (argv: accepted), and the
# pane's Write step landed a file inside the denied tree anyway: the binding
# is not applied, the pass fails naming it, and the surface closes.
reset
out=$(FAKE_PROBE_MODE=tool-writer RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane tend)
rc=$?
if [ "$rc" -ne 0 ]; then ok "tend tool-writer: a pane whose Write tool wrote the tree FAILS the pass"; else not_ok "tend tool-writer: must fail the pass (rc 0)"; fi
has "tend tool-writer: the failure names process applied AND tool binding not_applied" "$out" "process containment applied for t0-tend, tool binding not_applied"
log_has "tend tool-writer: the pane is closed" "pane close pS1"
log_hasnt "tend tool-writer: no real prompt to a writer" "agent prompt t0-tend /ralph:tend"
[ -e "$REPO_DIR/.ralph-tool-probe-t0-tend" ] && not_ok "tend tool-writer: the tool marker is cleaned up" || ok "tend tool-writer: the tool marker is cleaned up"
# GH-2342: the refuted binding is RECORDED — process applied beside tool
# binding not_applied, two fields, and the close reason names the mechanism.
is "tend tool-writer: the containment event records applied / not_applied, separately" "1" \
  "$(ledger_count '.ev=="containment" and .process_containment=="applied" and .tool_binding=="not_applied"')"
is "tend tool-writer: the row closes tool_binding_not_applied" "1" \
  "$(ledger_count '.ev=="exit" and .reason=="tool_binding_not_applied" and .via=="spawn"')"

# ── 5d. an unmeasured platform refuses BEFORE any pane exists, but leaves a
#        ledger row (GH-2360): the closed row is the only durable proof this
#        was a refusal, platform unmeasured — never "not attempted" ────────
reset
out=$(RALPH_HERDR_UNAME=Linux RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane tend)
rc=$?
if [ "$rc" -ne 0 ]; then ok "tend linux: refuses"; else not_ok "tend linux: must refuse (rc 0)"; fi
has "tend linux: the refusal names not_available" "$out" "not_available on Linux"
log_hasnt "tend linux: no pane was split for a spawn that refused" "pane split"
log_hasnt "tend linux: no agent was started" "agent start"
is "tend linux: one spawn row for the refused pass" "1" \
  "$(ledger_count '.ev=="spawn" and (.agent_ref | test("^t0-tend#[0-9a-f]{8}$"))')"
is "tend linux: a containment event names process_containment not_available" "1" \
  "$(ledger_count '.ev=="containment" and .process_containment=="not_available" and .tool_binding=="accepted"')"
is "tend linux: the row closes containment_not_available" "1" \
  "$(ledger_count '.ev=="exit" and .reason=="containment_not_available" and .via=="spawn"')"

# ── 6. dry run narrates the in-tab plan and mutates nothing ──────────────────
reset
out=$(RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" RALPH_HERDR_DRY_RUN=true run_lane deliver)
has "deliver dry run: narrates the rename" "$out" "tab rename <own tab> deliver"
has "deliver dry run: narrates the split" "$out" "pane split w1:p9 --direction down"
log_hasnt "deliver dry run: mutates nothing" "pane split"
has "deliver dry run: the plan prints the spawn record it would append" "$out" 'ledger append (spawn): {"ts":'
has "deliver dry run: …with both outcomes not_requested on the row" "$out" '"tool_binding":"not_requested","process_containment":"not_requested"'
is "deliver dry run: the ledger is untouched" "0" "$(ledger_count 'true')"
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
has "tend dry: the plan prints the provisional spawn record (role tender)" "$out" 'ledger append (spawn): {"ts":.*"role":"tender"'
has "tend dry: the plan names the containment event that follows the probe" "$out" 'ledger append (containment, after the probe): {ev: "containment", agent_ref: "t0-tend#'
log_hasnt "tend dry: no agent started" "agent start"
log_hasnt "tend dry: no prompt sent" "agent prompt"
is "tend dry: the ledger is untouched" "0" "$(ledger_count 'true')"

# ── per-lane model (GH-2350): each pass asks for its own lane's model ────────
cp "$REPO_DIR/.ralph.json" "$TMP/ralph.json.bak"
printf '{"owner":"fake","repo":"fake","projectNumber":1,"models":{"deliver":"claude-sonnet-5","tend":"claude-haiku-4-5"}}\n' >"$REPO_DIR/.ralph.json"
reset
out=$(RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane deliver)
log_has "deliver model: --model is the one harness argument the deliverer is handed" \
  "agent start r0-deliver --kind claude --pane pS1 -- --model claude-sonnet-5"
is "deliver model: the row records model_requested beside both not_requested outcomes" "1" \
  "$(ledger_count '.ev=="spawn" and .model_requested=="claude-sonnet-5" and .tool_binding=="not_requested" and .process_containment=="not_requested"')"
has "deliver model: the watcher still takes over" "$out" "notify-watch r0-deliver"
reset
out=$(RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane tend)
log_has "tend model: --model rides LAST, after binding and containment" \
  "agent start t0-tend --kind claude --pane pS1 -- --disallowedTools Edit,Write,NotebookEdit --settings .* --model claude-haiku-4-5"
is "tend model: the provisional row carries model_requested" "1" \
  "$(ledger_count '.ev=="spawn" and .model_requested=="claude-haiku-4-5" and .tokens.role=="tender"')"
has "tend model: containment is still probed and applied" "$out" "process containment: applied for t0-tend"
has "tend model: tool binding is still read as accepted off the argv" "$out" "tool binding: accepted for t0-tend"
reset
out=$(RALPH_MODEL_DELIVER=fable RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane deliver)
log_has "deliver model: RALPH_MODEL_DELIVER outranks .ralph.json" \
  "agent start r0-deliver --kind claude --pane pS1 -- --model fable"
reset
out=$(RALPH_MODEL_TEND='bad value' RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane tend)
rc=$?
if [ "$rc" -ne 0 ]; then ok "tend bad model: an unridable model refuses the pass"; else not_ok "tend bad model: expected a refusal, got rc 0"; fi
has "tend bad model: the refusal names the source" "$out" "RALPH_MODEL_TEND='bad value'"
log_hasnt "tend bad model: refused before any surface — no split" "pane split"
log_hasnt "tend bad model: refused before any surface — no agent" "agent start"
is "tend bad model: the ledger is untouched" "0" "$(ledger_count 'true')"
reset
out=$(RALPH_HERDR_DRY_RUN=true RALPH_HERDR_LANE_TAB=1 HERDR_PANE_ID="w1:p9" run_lane deliver)
has "deliver dry (model): the plan prints the argv the live path hands over" "$out" "agent start r0-deliver --kind claude --pane <captured> -- --model claude-sonnet-5"
has "deliver dry (model): the printed record carries model_requested" "$out" '"model_requested":"claude-sonnet-5"'
log_hasnt "deliver dry (model): no agent started" "agent start"
cp "$TMP/ralph.json.bak" "$REPO_DIR/.ralph.json"

echo "$pass passed, $fail failed ($n total)"
[ "$fail" -eq 0 ]
