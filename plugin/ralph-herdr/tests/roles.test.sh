#!/usr/bin/env bash
# roles.test.sh — the fleet role model (GH-1808). TAP-ish.
#
#   bash plugin/ralph-herdr/tests/roles.test.sh    # exits 0 on pass, 1 on fail
#
# Five things, in the order they matter:
#   1. the bash mirror equals the TypeScript registry (the golden table —
#      contracts.ts owns the vocabulary, roles.sh restates it, and a role
#      added on one side must fail here rather than drift);
#   2. the spawn edge graph refuses what it should, including both unknown
#      sides (an edge check that fails open is not a check);
#   3. one driver per worktree, with the liveness and fail-closed rules;
#   4. the investigator's tool allowlist is READ from the agent definition
#      and refuses rather than degrading;
#   5. tool binding (GH-2265) — every non-driver role's registry row denies
#      Edit/Write/NotebookEdit, generically, never Bash.
#
# No herdr server, no board mutation, no writes outside $TMP.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-roles-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

export HERDR_BIN_PATH="$SCRIPT_DIR/fake-herdr.sh"
export FAKE_HERDR_FIXTURES="$TMP/fixtures"
mkdir -p "$FAKE_HERDR_FIXTURES"
export RALPH_HERDR_REPO="$ROOT"
export RALPH_HERDR_LEDGER="$TMP/ledger/ledger.jsonl"
export RALPH_HERDR_BOARD="$SCRIPT_DIR/fake-board.sh"
export FAKE_BOARD_FIXTURES="$TMP/board-fixtures"
mkdir -p "$FAKE_BOARD_FIXTURES" "$TMP/ledger"

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
succeeds() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else not_ok "$desc — expected rc 0"; fi
}
fails() {
  local desc="$1" out rc=0
  shift
  out=$("$@" 2>/dev/null) || rc=$?
  if [ "$rc" -ne 0 ]; then ok "$desc"; else not_ok "$desc — expected failure, got rc 0 ('$out')"; fi
}

# ── 1. the golden table: bash mirror vs contracts.ts ─────────────────────────
# The registry is dumped from the TypeScript source itself, so this compares
# the mirror against the definition rather than against a second hand-written
# copy (which would only prove the copies agree with each other).
registry=$(cd "$ROOT" && npx tsx -e '
  import { ROLES, LANE_ROLES, HUMAN_SPAWNS, ROLE_NAMES, CONTAINMENT_OUTCOMES } from "./ralph/scripts/contracts.ts";
  console.log(JSON.stringify({ ROLES, LANE_ROLES, HUMAN_SPAWNS, ROLE_NAMES, CONTAINMENT_OUTCOMES }));
' 2>/dev/null)

if [ -z "$registry" ]; then
  not_ok "golden table: could not read the role registry from contracts.ts"
else
  ok "golden table: role registry read from contracts.ts"

  # lane -> role
  for lane in $(jq -r '.LANE_ROLES | keys[]' <<<"$registry"); do
    want=$(jq -r --arg l "$lane" '.LANE_ROLES[$l]' <<<"$registry")
    is "lane '$lane' maps to $want in both planes" "$want" "$(ralph_role_for_lane "$lane")"
  done

  # the role set itself
  is "the bash mirror knows exactly the registry's roles" \
    "$(jq -r '.ROLE_NAMES | sort | join(" ")' <<<"$registry")" \
    "$(for r in orchestrator driver investigator tender relay watcher; do
         ralph_role_known "$r" && echo "$r"
       done | sort | tr '\n' ' ' | sed 's/ $//')"

  # writesTree: exactly one role writes, and it is the driver
  is "exactly one role writes the tree, per contracts.ts" "driver" \
    "$(jq -r '[.ROLES | to_entries[] | select(.value.writesTree) | .key] | join(" ")' <<<"$registry")"

  # toolBinding: every role but the driver needs it, per contracts.ts
  is "every role but the driver is toolBinding:true, per contracts.ts" \
    "$(jq -r '[.ROLES | to_entries[] | select(.value.toolBinding) | .key] | sort | join(" ")' <<<"$registry")" \
    "$(for r in orchestrator driver investigator tender relay watcher; do
         ralph_role_tool_binding "$r" && echo "$r"
       done | sort | tr '\n' ' ' | sed 's/ $//')"

  # every edge in the registry, both directions
  edges_ok=1
  # GH-2266: processContainment — the second mechanism, mirrored separately
  is "every role but the driver is processContainment:true, per contracts.ts" \
    "$(jq -r '[.ROLES | to_entries[] | select(.value.processContainment) | .key] | sort | join(" ")' <<<"$registry")" \
    "$(for r in $(jq -r '.ROLES | keys[]' <<<"$registry"); do
         ralph_role_process_containment "$r" && echo "$r"
       done | sort | tr '\n' ' ' | sed 's/ $//')"
  is "containment outcomes: the bash vocabulary equals contracts.ts CONTAINMENT_OUTCOMES" \
    "$(jq -r '.CONTAINMENT_OUTCOMES | join(" ")' <<<"$registry")" \
    "$(ralph_containment_outcomes | tr '\n' ' ' | sed 's/ $//')"

  for parent in $(jq -r '.ROLES | keys[]' <<<"$registry") human; do
    if [ "$parent" = "human" ]; then
      allowed=$(jq -r '.HUMAN_SPAWNS | join(" ")' <<<"$registry")
    else
      allowed=$(jq -r --arg p "$parent" '.ROLES[$p].spawns | join(" ")' <<<"$registry")
    fi
    for child in $(jq -r '.ROLES | keys[]' <<<"$registry"); do
      case " $allowed " in
        *" $child "*) ralph_spawn_edge_guard "$parent" "$child" 2>/dev/null || edges_ok=0 ;;
        *) ralph_spawn_edge_guard "$parent" "$child" 2>/dev/null && edges_ok=0 ;;
      esac
    done
  done
  is "every edge agrees with contracts.ts spawnEdgeAllowed" "1" "$edges_ok"
fi

# ── 2. the edge graph's own refusals ─────────────────────────────────────────
succeeds "edge: human may spawn a driver"            ralph_spawn_edge_guard human driver
succeeds "edge: orchestrator may spawn a tender"     ralph_spawn_edge_guard orchestrator tender
succeeds "edge: driver may spawn an investigator"    ralph_spawn_edge_guard driver investigator
fails    "edge: a driver may NOT spawn a driver"     ralph_spawn_edge_guard driver driver
fails    "edge: an investigator is a leaf"           ralph_spawn_edge_guard investigator investigator
fails    "edge: a relay takes no children"           ralph_spawn_edge_guard relay driver
fails    "edge: a watcher takes no children"         ralph_spawn_edge_guard watcher driver
fails    "edge: human may not spawn an investigator directly" ralph_spawn_edge_guard human investigator
fails    "edge: an unknown parent is refused, not waved through" ralph_spawn_edge_guard mystery investigator
fails    "edge: an unknown child is refused, not waved through"  ralph_spawn_edge_guard driver mystery
fails    "edge: an empty parent is not 'human'"      ralph_spawn_edge_guard "" driver

is "role: only the driver writes the tree" "yes" \
  "$(ralph_role_writes_tree driver && echo yes || echo no)"
is "role: an investigator does not write the tree" "no" \
  "$(ralph_role_writes_tree investigator && echo yes || echo no)"
is "role: an unknown role is not a writer" "no" \
  "$(ralph_role_writes_tree mystery && echo yes || echo no)"

# GH-2265: tool binding — the generic per-role deny mechanism
fails  "tool binding: the driver is NOT bound (may keep Edit/Write/NotebookEdit)" \
  ralph_role_tool_binding driver
succeeds "tool binding: an orchestrator IS bound" ralph_role_tool_binding orchestrator
succeeds "tool binding: an investigator IS bound" ralph_role_tool_binding investigator
succeeds "tool binding: a tender IS bound"        ralph_role_tool_binding tender
succeeds "tool binding: a relay IS bound"          ralph_role_tool_binding relay
succeeds "tool binding: a watcher IS bound"        ralph_role_tool_binding watcher
succeeds "tool binding: an unknown role fails CLOSED (bound, not waved through)" \
  ralph_role_tool_binding mystery

is "tool binding args: the driver gets no restriction" "" \
  "$(ralph_tool_binding_args driver)"
is "tool binding args: a bound role gets --disallowedTools + the deny list" \
  "$(printf '%s\n' '--disallowedTools' 'Edit,Write,NotebookEdit')" \
  "$(ralph_tool_binding_args tender)"
case "$(ralph_tool_binding_args orchestrator)" in
  *Bash*) not_ok "tool binding args: Bash must NOT be in the deny list (process containment is #2266)" ;;
  *) ok "tool binding args: Bash is not denied by tool binding" ;;
esac

# ── 3. one driver per worktree ───────────────────────────────────────────────
CHECKOUT="$TMP/tree-a"
cat >"$RALPH_HERDR_LEDGER" <<EOF
{"ts":"2026-08-15T00:00:00Z","ev":"spawn","agent_ref":"w700-alpha#aaaaaaaa","checkout":"$CHECKOUT","tokens":{"role":"driver","issue":"700","depth":"0"}}
{"ts":"2026-08-15T00:01:00Z","ev":"spawn","agent_ref":"i700-read-the-thing#bbbbbbbb","checkout":"$CHECKOUT","tokens":{"role":"investigator","issue":"700","depth":"1"}}
EOF

herd_fixture '[{"name":"w700-alpha","agent_status":"working"}]' "$ROOT"
out=$(ralph_driver_guard "$CHECKOUT" 800 2>&1)
rc=$?
is "driver guard: refuses a second driver in a held tree" "1" "$rc"
case "$out" in
  *w700-alpha#aaaaaaaa*) ok "driver guard: the refusal NAMES the live driver" ;;
  *) not_ok "driver guard: the refusal must name the live driver — got '$out'" ;;
esac
case "$out" in
  *decomposition*) ok "driver guard: the refusal states the remedy, not a wait" ;;
  *) not_ok "driver guard: the refusal should point at decomposition — got '$out'" ;;
esac

succeeds "driver guard: the SAME issue is left to the atomic name mutex" \
  ralph_driver_guard "$CHECKOUT" 700

herd_fixture '[{"name":"i700-read-the-thing","agent_status":"working"}]' "$ROOT"
succeeds "driver guard: a live INVESTIGATOR does not hold the tree" \
  ralph_driver_guard "$CHECKOUT" 800

herd_fixture '[]' "$ROOT"
succeeds "driver guard: a tree whose driver is gone is free again" \
  ralph_driver_guard "$CHECKOUT" 800

succeeds "driver guard: an unrelated checkout is untouched" \
  ralph_driver_guard "$TMP/tree-b" 800

fails "driver guard: refuses to prove a tree unowned without naming it" \
  ralph_driver_guard ""

# Fail CLOSED: an unreadable herd cannot prove the tree is free, and an
# unprovable "nobody is driving this" must never become permission to add a
# second writer.
printf '#!/bin/sh\nexit 1\n' >"$TMP/broken-herdr.sh"
chmod +x "$TMP/broken-herdr.sh"
HERDR_BIN_PATH="$TMP/broken-herdr.sh" \
  fails "driver guard: an unreadable herd fails CLOSED" \
  ralph_driver_guard "$CHECKOUT" 800

# ── 3b. GH-2356: the SAME check when the tape is SQLite and there is NO
#      JSONL beside it at all — the fully-converted-machine shape. The old
#      implementation read the JSONL locator with a bare jq and never looked
#      at the sibling .sqlite, so this exact scenario went blind: the guard
#      checked nothing and returned as if the tree were unowned.
CONVERT="$SCRIPT_DIR/../scripts/ledger-convert.sh"
CHECKOUT_SQLITE="$TMP/tree-sqlite"
cat >"$RALPH_HERDR_LEDGER" <<EOF
{"ts":"2026-08-15T00:00:00Z","ev":"spawn","agent_ref":"w900-gamma#dddddddd","checkout":"$CHECKOUT_SQLITE","tokens":{"role":"driver","issue":"900","depth":"0"}}
EOF
bash "$CONVERT" "$RALPH_HERDR_LEDGER" >/dev/null 2>&1
rm -f "$RALPH_HERDR_LEDGER"
[ -f "$RALPH_HERDR_LEDGER" ] && not_ok "driver guard (sqlite tape): fixture setup left a JSONL behind" \
  || ok "driver guard (sqlite tape): only the sqlite tape exists, no JSONL beside it"

herd_fixture '[{"name":"w900-gamma","agent_status":"working"}]' "$ROOT"
out=$(ralph_driver_guard "$CHECKOUT_SQLITE" 800 2>&1)
rc=$?
is "driver guard (sqlite tape, no jsonl): refuses a second driver in a held tree" "1" "$rc"
case "$out" in
  *w900-gamma#dddddddd*) ok "driver guard (sqlite tape): the refusal NAMES the live driver" ;;
  *) not_ok "driver guard (sqlite tape): the refusal must name the live driver — got '$out'" ;;
esac

succeeds "driver guard (sqlite tape): the SAME issue is left to the atomic name mutex" \
  ralph_driver_guard "$CHECKOUT_SQLITE" 900

herd_fixture '[]' "$ROOT"
succeeds "driver guard (sqlite tape): a tree whose driver is gone is free again" \
  ralph_driver_guard "$CHECKOUT_SQLITE" 800

# Fail CLOSED on an unreadable TAPE, the same direction as the unreadable
# herd: the reducer's rc is jq's (0 over an empty pipe), so without the probe
# a present-but-unservable sqlite would read as an empty ledger and permit a
# second writer. A future user_version is the documented unservable shape.
herd_fixture '[{"name":"w900-gamma","agent_status":"working"}]' "$ROOT"
DB_SQLITE="${RALPH_HERDR_LEDGER%.jsonl}.sqlite"
sqlite3 "$DB_SQLITE" 'PRAGMA user_version=2;'
out=$(ralph_driver_guard "$CHECKOUT_SQLITE" 800 2>&1); rc=$?
is "driver guard (sqlite tape): an unreadable present tape fails CLOSED" "1" "$rc"
case "$out" in
  *"cannot read the ledger"*) ok "driver guard (sqlite tape): the refusal names the ledger read, not a live driver" ;;
  *) not_ok "driver guard (sqlite tape): expected a ledger-read refusal — got '$out'" ;;
esac
is "driver guard (sqlite tape): an unreadable tape prints no driver ref" "" "$(ralph_driver_guard "$CHECKOUT_SQLITE" 800 2>/dev/null)"
sqlite3 "$DB_SQLITE" 'PRAGMA user_version=1;'
fails "driver guard (sqlite tape): the restored tape refuses on the live driver again" \
  ralph_driver_guard "$CHECKOUT_SQLITE" 800

# ── 4. the investigator's harness binding ────────────────────────────────────
export RALPH_INVESTIGATOR_AGENT="$ROOT/ralph/agents/investigator.md"
is "investigator: the allowlist is read from the agent definition" \
  "Read,Grep,Glob" "$(ralph_investigator_tools)"

args=$(ralph_investigator_harness_args)
case "$args" in
  *--tools*) ok "investigator: harness args carry --tools (the documented allowlist)" ;;
  *) not_ok "investigator: harness args must carry --tools — got '$args'" ;;
esac
case "$args" in
  *--agent*) ok "investigator: harness args carry the agent definition" ;;
  *) not_ok "investigator: harness args must bind the agent definition — got '$args'" ;;
esac
is "investigator: the definition's tools reach the harness verbatim" \
  '["Read","Grep","Glob"]' \
  "$(printf '%s\n' "$args" | sed -n 2p | jq -c '.investigator.tools')"
case "$(printf '%s\n' "$args" | sed -n 2p | jq -r '.investigator.tools | join(",")')" in
  *Bash* | *Write* | *Edit*) not_ok "investigator: a mutating tool reached the allowlist" ;;
  *) ok "investigator: no mutating tool in the allowlist" ;;
esac

RALPH_INVESTIGATOR_AGENT="$TMP/nonexistent.md" \
  fails "investigator: an unreadable definition REFUSES rather than degrading" \
  ralph_investigator_tools

printf -- '---\nname: investigator\ndescription: d\n---\n\nbody\n' >"$TMP/no-tools.md"
RALPH_INVESTIGATOR_AGENT="$TMP/no-tools.md" \
  fails "investigator: a definition naming no tools refuses (no unrestricted fallback)" \
  ralph_investigator_tools

# ── 6. process containment (GH-2266) — the OTHER half, with the OPPOSITE
#      failure direction: the profile is built and read back, the platform is
#      named, and the spawn-time probe refuses on anything but an observed
#      denial.
fails  "containment: the driver is NOT contained (may write its tree)" \
  ralph_role_process_containment driver
succeeds "containment: an orchestrator IS contained" ralph_role_process_containment orchestrator
succeeds "containment: a tender IS contained"        ralph_role_process_containment tender
succeeds "containment: an investigator IS contained (registry row; inapplicable at spawn until it has Bash)" \
  ralph_role_process_containment investigator
succeeds "containment: an unknown role fails CLOSED (contained, not waved through)" \
  ralph_role_process_containment mystery

mkdir -p "$TMP/tree-real" "$TMP/home"
ln -s "$TMP/tree-real" "$TMP/tree-link"
REAL_TREE=$(cd "$TMP/tree-real" && pwd -P)

is "containment args: the driver gets no --settings" "" \
  "$(RALPH_HERDR_UNAME=Darwin RALPH_HOME="$TMP/home" ralph_process_containment_args driver "$TMP/tree-real")"
args=$(RALPH_HERDR_UNAME=Darwin RALPH_HOME="$TMP/home" HERDR_SOCKET_PATH="$TMP/herdr.sock" \
  ralph_process_containment_args tender "$TMP/tree-link")
is "containment args: a contained role gets --settings + one JSON line" "--settings" \
  "$(printf '%s\n' "$args" | sed -n 1p)"
json=$(printf '%s\n' "$args" | sed -n 2p)
is "containment args: exactly two lines (flag, document)" "2" "$(printf '%s\n' "$args" | wc -l | tr -d ' ')"
is "containment: denyWrite is the checkout REALPATH, symlink resolved (the /tmp -> /private/tmp confound)" \
  "[\"$REAL_TREE\"]" "$(jq -c .sandbox.filesystem.denyWrite <<<"$json")"
is "containment: failIfUnavailable is true (a missing sandbox is a startup refusal)" "true" \
  "$(jq -r .sandbox.failIfUnavailable <<<"$json")"
is "containment: allowUnsandboxedCommands is false (strict — no dangerouslyDisableSandbox retry)" "false" \
  "$(jq -r .sandbox.allowUnsandboxedCommands <<<"$json")"
is "containment: excludedCommands is EMPTY (an excluded gh … > file writes the tree — measured)" "[]" \
  "$(jq -c .sandbox.excludedCommands <<<"$json")"
is "containment: RALPH_HOME is the one allowWrite (budget, ledger, cache, probe marker)" \
  "[\"$(cd "$TMP/home" && pwd -P)\"]" "$(jq -c .sandbox.filesystem.allowWrite <<<"$json")"
is "containment: the herdr socket rides network.allowUnixSockets (the top-level spelling is inert)" \
  "[\"$TMP/herdr.sock\"]" "$(jq -c .sandbox.network.allowUnixSockets <<<"$json")"
is "containment: gh's trust lookup is the ONE mach service allowed" \
  '["com.apple.trustd.agent"]' "$(jq -c .sandbox.network.allowMachLookup <<<"$json")"
is "containment: GitHub is reachable (the board CLI is gh underneath)" \
  '["api.github.com","github.com"]' "$(jq -c .sandbox.network.allowedDomains <<<"$json")"
is "containment: no socket in the env means an empty socket list, never a guessed path" "[]" \
  "$(env -u HERDR_SOCKET_PATH RALPH_HERDR_UNAME=Darwin RALPH_HOME="$TMP/home" bash -c '. "'"$SCRIPT_DIR"'/../scripts/roles.sh"; ralph_process_containment_settings "'"$TMP/tree-real"'"' | jq -c .sandbox.network.allowUnixSockets)"
# The host is read from exactly the files board.ts reads (PR #2337, both
# P1s): `.ralph.json` first, then the tracked settings env block — never the
# process env, which board.ts ignores too. A stray RALPH_GH_HOST in the
# spawner's shell must not widen the allow-list to a host the client never
# contacts; an in-tree GHE host must be allow-listed with nothing exported.
is "containment: a process-env RALPH_GH_HOST with no in-tree config widens NOTHING (board.ts ignores it too)" \
  '["api.github.com","github.com"]' \
  "$(RALPH_HERDR_UNAME=Darwin RALPH_HOME="$TMP/home" RALPH_GH_HOST=ghe.example ralph_process_containment_settings "$TMP/tree-real" | jq -c .sandbox.network.allowedDomains)"
mkdir -p "$TMP/tree-ghe/.claude" "$TMP/tree-ghe2/.claude"
printf '{"owner":"o","repo":"r","projectNumber":1,"host":"ghe.in-tree"}\n' >"$TMP/tree-ghe/.ralph.json"
is "containment: .ralph.json's host is allow-listed with no env exported" \
  '["api.github.com","github.com","ghe.in-tree"]' \
  "$(env -u RALPH_GH_HOST RALPH_HERDR_UNAME=Darwin RALPH_HOME="$TMP/home" bash -c '. "'"$SCRIPT_DIR"'/../scripts/roles.sh"; ralph_process_containment_settings "'"$TMP/tree-ghe"'"' | jq -c .sandbox.network.allowedDomains)"
is "containment: .ralph.json's host is used, and a process-env host is still ignored beside it" \
  '["api.github.com","github.com","ghe.in-tree"]' \
  "$(RALPH_HERDR_UNAME=Darwin RALPH_HOME="$TMP/home" RALPH_GH_HOST=ghe.env ralph_process_containment_settings "$TMP/tree-ghe" | jq -c .sandbox.network.allowedDomains)"
printf '{"env":{"RALPH_GH_OWNER":"o","RALPH_GH_REPO":"r","RALPH_GH_HOST":"ghe.settings"}}\n' >"$TMP/tree-ghe2/.claude/settings.json"
is "containment: the tracked settings env block is the second source" \
  '["api.github.com","github.com","ghe.settings"]' \
  "$(env -u RALPH_GH_HOST RALPH_HERDR_UNAME=Darwin RALPH_HOME="$TMP/home" bash -c '. "'"$SCRIPT_DIR"'/../scripts/roles.sh"; ralph_process_containment_settings "'"$TMP/tree-ghe2"'"' | jq -c .sandbox.network.allowedDomains)"
printf '{"owner":"o","repo":"r","projectNumber":1,"host":"github.com"}\n' >"$TMP/tree-ghe/.ralph.json"
is "containment: an explicit github.com host adds no duplicate" '["api.github.com","github.com"]' \
  "$(RALPH_HERDR_UNAME=Darwin RALPH_HOME="$TMP/home" ralph_process_containment_settings "$TMP/tree-ghe" | jq -c .sandbox.network.allowedDomains)"

out=$(RALPH_HERDR_UNAME=Linux RALPH_HOME="$TMP/home" ralph_process_containment_args tender "$TMP/tree-real" 2>&1); rc=$?
is "containment: an unmeasured platform REFUSES (rc 1) rather than inheriting the claim" "1" "$rc"
case "$out" in
  *not_available*) ok "containment: the refusal names not_available and the measured platform" ;;
  *) not_ok "containment: the refusal must say not_available — got '$out'" ;;
esac
case "$out" in
  *--settings*) not_ok "containment: a refusal must print NO --settings (a half-profile is the silent-open case)" ;;
  *) ok "containment: a refusal prints no --settings" ;;
esac
is "containment: platform on Darwin is seatbelt" "seatbelt" "$(RALPH_HERDR_UNAME=Darwin ralph_process_containment_platform)"
RALPH_HERDR_UNAME=Darwin fails "containment: a checkout that is not a directory refuses (nothing to deny)" \
  ralph_process_containment_settings "$TMP/does-not-exist"
RALPH_HERDR_UNAME=Darwin fails "containment: an empty checkout refuses" ralph_process_containment_settings ""

# The in-pane probe, against the fake herd. The hook plays the pane: it
# receives the prompt and touches whatever an obedient pane under each
# sandbox state would have produced.
cat >"$TMP/probe-hook.sh" <<'HOOK'
#!/usr/bin/env bash
# $1 agent, $2 prompt text. Touch per $FAKE_PROBE_MODE what an obedient pane
# under each state would produce: applied (outside, plus the control marker
# when the prompt carries the GH-2341 Write step — a bound pane writes no tool
# marker), inert (inside too — an unsandboxed pane), silent (nothing),
# tool-writer (an UNBOUND Write tool: the in-tree tool marker lands),
# tool-stall (the Write step never completes: no tool marker, no control).
paths=$(printf '%s' "$2" | grep -o "touch '[^']*' '[^']*'" | head -1)
inside=$(printf '%s' "$paths" | sed -n "s/^touch '\([^']*\)' '.*$/\1/p")
outside=$(printf '%s' "$paths" | sed -n "s/^touch '[^']*' '\([^']*\)'$/\1/p")
tool=$(printf '%s' "$2" | sed -n "s/^.*create the file '\([^']*\)' with the content.*$/\1/p" | head -1)
control=$(printf '%s' "$2" | sed -n "s/^touch '\([^']*\)'; echo CONTROL_RC.*$/\1/p" | head -1)
case "${FAKE_PROBE_MODE:-applied}" in
  applied) touch "$outside"; [ -n "$control" ] && touch "$control" ;;
  inert) touch "$inside" "$outside"; [ -n "$control" ] && touch "$control" ;;
  silent) : ;;
  tool-writer) touch "$outside"; [ -n "$tool" ] && touch "$tool"; [ -n "$control" ] && touch "$control" ;;
  tool-stall) touch "$outside" ;;
esac
HOOK
chmod +x "$TMP/probe-hook.sh"
export FAKE_HERDR_PROMPT_HOOK="$TMP/probe-hook.sh"
printf '{"agent":{"name":"t-probe","agent_status":"working","pane_id":"p1","workspace_id":"w1","tab_id":"w1:t1","terminal_id":"term_fake","focused":false,"revision":2}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-wait-until.t-probe.json"

out=$(FAKE_PROBE_MODE=applied RALPH_HOME="$TMP/home" spawn_containment_probe t-probe p1 "$TMP/tree-real" "re-spawn" 2>"$TMP/probe.err"); rc=$?
is "probe: an outside marker with NO inside marker is applied (rc 0)" "0" "$rc"
is "probe: prints the one outcome word" "applied" "$out"
[ -e "$TMP/home/containment-probes/t-probe.$$" ] && not_ok "probe: the outside marker is cleaned up" || ok "probe: the outside marker is cleaned up"
[ -e "$TMP/tree-real/.ralph-containment-probe-t-probe" ] && not_ok "probe: no inside marker left behind" || ok "probe: no inside marker left behind"
case "$(cat "$TMP/probe.err")" in
  "") ok "probe: applied is silent on stderr" ;;
  *) not_ok "probe: applied should be silent on stderr — got '$(cat "$TMP/probe.err")'" ;;
esac

out=$(FAKE_PROBE_MODE=inert RALPH_HOME="$TMP/home" spawn_containment_probe t-probe p1 "$TMP/tree-real" "re-spawn" 2>"$TMP/probe.err"); rc=$?
is "probe: an INSIDE marker is not_applied (rc 1) — the sandbox was inert" "1" "$rc"
is "probe: not_applied is the word printed" "not_applied" "$out"
case "$(cat "$TMP/probe.err")" in
  *"WROTE INSIDE"*) ok "probe: not_applied names the write inside the tree" ;;
  *) not_ok "probe: not_applied must say the pane wrote inside — got '$(cat "$TMP/probe.err")'" ;;
esac
[ -e "$TMP/tree-real/.ralph-containment-probe-t-probe" ] && not_ok "probe: the inside marker an inert pane wrote is removed" || ok "probe: the inside marker an inert pane wrote is removed"

out=$(FAKE_PROBE_MODE=silent RALPH_HERDR_CONTAINMENT_PROBE_SEC=1 RALPH_HOME="$TMP/home" \
  spawn_containment_probe t-probe p1 "$TMP/tree-real" "re-spawn" 2>"$TMP/probe.err"); rc=$?
is "probe: no marker at all is unverified (rc 1) — distinct from not_applied" "1" "$rc"
is "probe: unverified is the word printed" "unverified" "$out"
case "$(cat "$TMP/probe.err")" in
  *"neither marker"*) ok "probe: unverified says neither marker appeared" ;;
  *) not_ok "probe: unverified must say neither marker appeared — got '$(cat "$TMP/probe.err")'" ;;
esac

# PR #2337 P1: a target this process cannot write outside the sandbox proves
# nothing — the probe must refuse as unverified, never read the (inevitable)
# missing inside marker as a denial.
export FAKE_HERDR_LOG="$TMP/herdr.log"
mkdir -p "$TMP/tree-ro" && chmod 555 "$TMP/tree-ro"
if [ "$(id -u)" -eq 0 ] || { : >"$TMP/tree-ro/.w"; } 2>/dev/null; then
  rm -f "$TMP/tree-ro/.w" 2>/dev/null; ok "probe: (skipped — this user can write a 555 directory) unwritable-root case"
  ok "probe: (skipped) unwritable-root names the pre-check"
  ok "probe: (skipped) unwritable-root sends no prompt"
else
  : >"$FAKE_HERDR_LOG"
  out=$(FAKE_PROBE_MODE=applied RALPH_HOME="$TMP/home" spawn_containment_probe t-probe p1 "$TMP/tree-ro" "re-spawn" 2>"$TMP/probe.err"); rc=$?
  is "probe: an inside target unwritable OUTSIDE the sandbox is unverified (rc 1), never applied" "1 unverified" "$rc $out"
  case "$(cat "$TMP/probe.err")" in
    *"not writable even OUTSIDE the sandbox"*) ok "probe: unwritable-root names the pre-check, not a denial" ;;
    *) not_ok "probe: unwritable-root must name the pre-check — got '$(cat "$TMP/probe.err")'" ;;
  esac
  if grep -q 'agent prompt' "$FAKE_HERDR_LOG"; then not_ok "probe: unwritable-root must not prompt the pane at all"; else ok "probe: unwritable-root sends no prompt"; fi
fi
chmod 755 "$TMP/tree-ro"

# The prompt itself: inside operand FIRST (an inert sandbox writes it before
# the outside marker lands), both quoted, one command.
export FAKE_HERDR_LOG="$TMP/herdr.log"
: >"$FAKE_HERDR_LOG"
FAKE_PROBE_MODE=applied RALPH_HOME="$TMP/home" spawn_containment_probe t-probe p1 "$TMP/tree-real" "x" >/dev/null 2>&1
# The fake logs argv joined by spaces, so the two-line prompt lands as two
# log lines; the command line is the second.
if grep -qF -- "touch '$REAL_TREE/.ralph-containment-probe-t-probe' '$TMP/home/containment-probes/t-probe." "$FAKE_HERDR_LOG"; then
  ok "probe: the prompt touches inside-then-outside in ONE command"
else
  not_ok "probe: prompt shape — got '$(grep -A1 'agent prompt t-probe' "$FAKE_HERDR_LOG" | cut -c1-200)'"
fi
unset FAKE_HERDR_PROMPT_HOOK

# ── GH-2341: the Write step rides the same turn, after the Bash touch ────────
# The probe is called WITHOUT a subshell here so the env words can be read
# too; stdout carries both words when a fifth argument is given.
export FAKE_HERDR_PROMPT_HOOK="$TMP/probe-hook.sh"
: >"$FAKE_HERDR_LOG"
FAKE_PROBE_MODE=applied RALPH_HOME="$TMP/home" spawn_containment_probe t-probe p1 "$TMP/tree-real" "re-spawn" accepted >"$TMP/probe.out" 2>"$TMP/probe.err"; rc=$?
is "tool step: a bound pane (no tool marker, control landed) is rc 0 and prints BOTH words" "0 applied accepted" "$rc $(cat "$TMP/probe.out")"
is "tool step: the tool word stays at accepted — no file is not an observed refusal" "accepted" "$RALPH_HERDR_TOOL_BINDING_OUTCOME"
case "$(cat "$TMP/probe.err")" in
  "") ok "tool step: the bound pane is silent on stderr" ;;
  *) not_ok "tool step: the bound pane should be silent — got '$(cat "$TMP/probe.err")'" ;;
esac
[ -e "$TMP/home/containment-probes/t-probe.$$.control" ] && not_ok "tool step: the control marker is cleaned up" || ok "tool step: the control marker is cleaned up"
if grep -qF "Use the Write tool, and only the Write tool, to create the file '$REAL_TREE/.ralph-tool-probe-t-probe'" "$FAKE_HERDR_LOG"; then
  ok "tool step: the prompt asks for a Write INSIDE the denied tree (a Bash write there was just refused, so only the Write tool can land it)"
else
  not_ok "tool step: prompt must name an in-tree Write target — got '$(grep -A4 'agent prompt t-probe' "$FAKE_HERDR_LOG" | cut -c1-200)'"
fi
touch_line=$(grep -nF "touch '$REAL_TREE/.ralph-containment-probe-t-probe'" "$FAKE_HERDR_LOG" | head -1 | cut -d: -f1)
write_line=$(grep -nF "Use the Write tool" "$FAKE_HERDR_LOG" | head -1 | cut -d: -f1)
control_line=$(grep -nF "echo CONTROL_RC" "$FAKE_HERDR_LOG" | head -1 | cut -d: -f1)
if [ -n "$touch_line" ] && [ -n "$write_line" ] && [ -n "$control_line" ] && [ "$touch_line" -lt "$write_line" ] && [ "$write_line" -lt "$control_line" ]; then
  ok "tool step: ordered Bash touch → Write → Bash control, so the process verdict is never at risk"
else
  not_ok "tool step: order must be touch ($touch_line) < Write ($write_line) < control ($control_line)"
fi

FAKE_PROBE_MODE=tool-writer RALPH_HOME="$TMP/home" spawn_containment_probe t-probe p1 "$TMP/tree-real" "re-spawn" accepted >"$TMP/probe.out" 2>"$TMP/probe.err"; rc=$?
is "tool step: a Write landing INSIDE the tree is tool binding not_applied (rc 1) beside process applied" "1 applied not_applied" "$rc $(cat "$TMP/probe.out")"
case "$(cat "$TMP/probe.err")" in
  *"Write tool WROTE INSIDE"*) ok "tool step: not_applied names the Write tool's write inside the tree" ;;
  *) not_ok "tool step: not_applied must name the Write tool — got '$(cat "$TMP/probe.err")'" ;;
esac
[ -e "$TMP/tree-real/.ralph-tool-probe-t-probe" ] && not_ok "tool step: the tool marker an unbound pane wrote is removed" || ok "tool step: the tool marker an unbound pane wrote is removed"

# The permission-dialog case (measured under --permission-mode default): the
# Write step blocks the pane, the control touch never lands, and herdr reads
# the agent as `blocked`. A bound tool never asks, so this is not_applied.
printf '{"agent":{"name":"t-probe","agent_status":"blocked","pane_id":"p1","workspace_id":"w1","tab_id":"w1:t1","terminal_id":"term_fake","focused":false,"revision":3}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-get.t-probe.json"
FAKE_PROBE_MODE=tool-stall RALPH_HERDR_CONTAINMENT_PROBE_SEC=1 RALPH_HOME="$TMP/home" spawn_containment_probe t-probe p1 "$TMP/tree-real" "re-spawn" accepted >"$TMP/probe.out" 2>"$TMP/probe.err"; rc=$?
is "tool step: a pane BLOCKED on the Write step with no control marker is not_applied (rc 1) — the dialog case refuses, never passes" "1 applied not_applied" "$rc $(cat "$TMP/probe.out")"
case "$(cat "$TMP/probe.err")" in
  *"BLOCKED on a prompt"*) ok "tool step: the dialog refusal names the blocked pane" ;;
  *) not_ok "tool step: the dialog refusal must say BLOCKED — got '$(cat "$TMP/probe.err")'" ;;
esac
rm -f "$FAKE_HERDR_FIXTURES/agent-get.t-probe.json"

# The same silence from a pane that does NOT read blocked (the default
# agent-get answers idle) is unverified and REFUSED (PR #2346 P1): the
# status read can fail or lag a dialog already up, and a pane that never
# finished its probe turn cannot take its prompt — "could not read" is
# neither "checked" nor a writer, and never a pass.
FAKE_PROBE_MODE=tool-stall RALPH_HERDR_CONTAINMENT_PROBE_SEC=1 RALPH_HOME="$TMP/home" spawn_containment_probe t-probe p1 "$TMP/tree-real" "re-spawn" accepted >"$TMP/probe.out" 2>"$TMP/probe.err"; rc=$?
is "tool step: an unreadable Write step on an unblocked pane is unverified (rc 1) — never promoted, never passed" "1 applied unverified" "$rc $(cat "$TMP/probe.out")"
case "$(cat "$TMP/probe.err")" in
  *"could not be read to a verdict"*) ok "tool step: the unverified case says the step could not be read" ;;
  *) not_ok "tool step: the unverified case must say it could not be read — got '$(cat "$TMP/probe.err")'" ;;
esac
printf 'agent_get_failed\n' >"$FAKE_HERDR_FIXTURES/agent-get.t-probe.raw"; printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-get.t-probe.rc"
FAKE_PROBE_MODE=tool-stall RALPH_HERDR_CONTAINMENT_PROBE_SEC=1 RALPH_HOME="$TMP/home" spawn_containment_probe t-probe p1 "$TMP/tree-real" "re-spawn" accepted >"$TMP/probe.out" 2>"$TMP/probe.err"; rc=$?
is "tool step: a FAILED status read with no control marker is unverified (rc 1), never a pass" "1 applied unverified" "$rc $(cat "$TMP/probe.out")"
rm -f "$FAKE_HERDR_FIXTURES/agent-get.t-probe.raw" "$FAKE_HERDR_FIXTURES/agent-get.t-probe.rc"

# An inert sandbox refuses on the PROCESS verdict and leaves the tool word at
# the argv observation: with Bash able to write the tree, an in-tree tool
# marker would be forgeable, so the Write step is not read at all.
FAKE_PROBE_MODE=inert RALPH_HOME="$TMP/home" spawn_containment_probe t-probe p1 "$TMP/tree-real" "re-spawn" accepted >"$TMP/probe.out" 2>"$TMP/probe.err"; rc=$?
is "tool step: an inert sandbox is process not_applied with the tool word untouched" "1 not_applied accepted" "$rc $(cat "$TMP/probe.out")"

# No binding on the argv → nothing to refute: the Write step is not sent, and
# the four-argument form keeps its one-word stdout.
: >"$FAKE_HERDR_LOG"
FAKE_PROBE_MODE=applied RALPH_HOME="$TMP/home" spawn_containment_probe t-probe p1 "$TMP/tree-real" "re-spawn" not_requested >"$TMP/probe.out" 2>/dev/null; rc=$?
is "tool step: not_requested sends no Write step and echoes the word back" "0 applied not_requested" "$rc $(cat "$TMP/probe.out")"
if grep -q "Use the Write tool" "$FAKE_HERDR_LOG"; then not_ok "tool step: not_requested must not prompt a Write"; else ok "tool step: not_requested prompts no Write"; fi
: >"$FAKE_HERDR_LOG"
FAKE_PROBE_MODE=applied RALPH_HOME="$TMP/home" spawn_containment_probe t-probe p1 "$TMP/tree-real" "re-spawn" >"$TMP/probe.out" 2>/dev/null; rc=$?
is "tool step: the four-argument form still prints one word" "0 applied" "$rc $(cat "$TMP/probe.out")"
if grep -q "Use the Write tool" "$FAKE_HERDR_LOG"; then not_ok "tool step: the four-argument form must not prompt a Write"; else ok "tool step: the four-argument form prompts no Write"; fi
unset FAKE_HERDR_PROMPT_HOOK

# ── GH-2267: what a spawn ACHIEVED, per mechanism, in the ledger ─────────────
# Tool binding is observed off the argv actually handed to `agent start`,
# never off the role row: the same helper answers for a driver's empty argv,
# an investigator's allowlist and a lead's deny list.
is "observed: an empty argv is not_requested (the driver)" "not_requested" "$(ralph_tool_binding_observed)"
is "observed: the deny list naming all three is accepted" "accepted" \
  "$(ralph_tool_binding_observed --disallowedTools Edit,Write,NotebookEdit)"
is "observed: the registry's own binding args read as accepted" "accepted" \
  "$(ralph_tool_binding_observed $(ralph_tool_binding_args tender | tr '\n' ' '))"
is "observed: a deny list missing one writer is not_applied" "not_applied" \
  "$(ralph_tool_binding_observed --disallowedTools Edit,Write)"
is "observed: an allowlist without a writer is accepted" "accepted" \
  "$(ralph_tool_binding_observed --agents '{}' --agent investigator --tools Read,Grep,Glob)"
is "observed: an allowlist granting Write is not_applied" "not_applied" \
  "$(ralph_tool_binding_observed --tools Read,Write)"
is "observed: the --flag=value spelling is read too" "accepted" "$(ralph_tool_binding_observed --tools=Read)"
is "observed: a deny list closes an allowlist's writer" "accepted" \
  "$(ralph_tool_binding_observed --tools Read,Write --disallowedTools Write,Edit,NotebookEdit)"
is "observed: the driver's registry args (none) are not_requested, not accepted" "not_requested" \
  "$(ralph_tool_binding_observed $(ralph_tool_binding_args driver | tr '\n' ' '))"
case "$(ralph_containment_outcomes | tr '\n' ' ')" in
  *" accepted not_requested "*) ok "observed: both words are in the achieved vocabulary" ;;
  *) not_ok "observed: accepted/not_requested must be in ralph_containment_outcomes — got '$(ralph_containment_outcomes | tr '\n' ' ')'" ;;
esac

# The proof the unit exists for: a run with a deliberately broken sandbox —
# the fake pane behaves exactly as an inert sandbox does (exit 0, a file
# written INSIDE the denied tree) — leaves a ledger a reader who was not
# present can tell apart from a contained pane's. Three provisional lead
# rows (written before their probes, as work-team.sh writes them), then the
# outcome of each probe recorded as its own event.
export FAKE_HERDR_PROMPT_HOOK="$TMP/probe-hook.sh"
L="$RALPH_HERDR_LEDGER"
seed() { # REF — a provisional spawn row with no outcome fields
  RALPH_HERDR_LEDGER="$L" ralph_ledger_append "$(jq -nc --arg r "$1" \
    '{ts: "2026-09-01T00:00:00Z", ev: "spawn", agent_ref: $r, tokens: {role: "orchestrator", issue: "77", depth: "0", state: "spawned"}}')"
}
seed "o77-broken#aaaaaaaa"; seed "o78-contained#bbbbbbbb"; seed "o79-linux#cccccccc"; seed "o80-old#dddddddd"
verdict=$(FAKE_PROBE_MODE=inert RALPH_HOME="$TMP/home" spawn_containment_probe t-probe p1 "$TMP/tree-real" "re-spawn" 2>/dev/null)
_ralph_spawn_containment_event "o77-broken#aaaaaaaa" "$L" accepted "$verdict"
verdict=$(FAKE_PROBE_MODE=applied RALPH_HOME="$TMP/home" spawn_containment_probe t-probe p1 "$TMP/tree-real" "re-spawn" 2>/dev/null)
_ralph_spawn_containment_event "o78-contained#bbbbbbbb" "$L" accepted "$verdict"
_ralph_spawn_containment_event "o79-linux#cccccccc" "$L" accepted not_available
broken_pc=$(_ralph_ledger_latest_process_containment "o77-broken#aaaaaaaa")
good_pc=$(_ralph_ledger_latest_process_containment "o78-contained#bbbbbbbb")
linux_pc=$(_ralph_ledger_latest_process_containment "o79-linux#cccccccc")
is "ledger: the broken-sandbox pane reads not_applied off the ledger alone" "not_applied" "$broken_pc"
is "ledger: the contained pane reads applied" "applied" "$good_pc"
is "ledger: the unmeasured platform reads not_available" "not_available" "$linux_pc"
if [ "$broken_pc" != "$good_pc" ] && [ "$good_pc" != "$linux_pc" ] && [ "$broken_pc" != "$linux_pc" ]; then
  ok "ledger: applied, not_applied and not_available are three renderings, never one"
else
  not_ok "ledger: three outcomes must render distinctly — got '$broken_pc' / '$good_pc' / '$linux_pc'"
fi
is "ledger: tool binding is its own field beside it (broken pane)" "accepted" "$(_ralph_ledger_latest_tool_binding "o77-broken#aaaaaaaa")"
is "ledger: the event carries both mechanisms as two keys" "2" \
  "$(_ralph_ledger_events "$L" | jq -s '[.[] | select(.ev == "containment" and .agent_ref == "o77-broken#aaaaaaaa")] | last | [.tool_binding, .process_containment] | map(select(. != null)) | length')"
is "ledger: the outcome is never inferred from the role token" "orchestrator" \
  "$(_ralph_ledger_events "$L" | jq -rs '[.[] | select(.ev == "containment" and .agent_ref == "o77-broken#aaaaaaaa")] | last | .tokens.role // "orchestrator"')"
old_pc=$(_ralph_ledger_latest_process_containment "o80-old#dddddddd" 2>/dev/null); rc=$?
is "ledger: a pre-GH-2267 row reads EMPTY (rc 1) — absent is not not_requested" "1 " "$rc $old_pc"
is "ledger: containment events neither open nor close a row (open set unchanged)" \
  "o77-broken#aaaaaaaa o78-contained#bbbbbbbb o79-linux#cccccccc o80-old#dddddddd" \
  "$(RALPH_HERDR_LEDGER="$L" ralph_ledger_open_agents | grep -E '^o(77|78|79|80)-' | sort | tr '\n' ' ' | sed 's/ $//')"
before=$(_ralph_ledger_events "$L" | wc -l | tr -d ' ')
out=$(_ralph_spawn_containment_event "o77-broken#aaaaaaaa" "$L" accepted "" 2>&1)
is "ledger: an event naming one mechanism is refused (nothing appended)" "$before" "$(_ralph_ledger_events "$L" | wc -l | tr -d ' ')"
case "$out" in
  *"both outcomes are required"*) ok "ledger: the half-record refusal says both are required" ;;
  *) not_ok "ledger: half-record refusal text — got '$out'" ;;
esac
unset FAKE_HERDR_PROMPT_HOOK

# ── 6. per-lane model (GH-2350) — one resolver, first hit wins, refuses ─────
# what it cannot hand an argv. The lanes are the five session kinds a
# cockpit starts, not the role registry.
is "model: the lane vocabulary is the five session kinds" "driver lead dispatch deliver tend" "$RALPH_MODEL_LANES"
MROOT="$TMP/models"
mkdir -p "$MROOT/a/.claude" "$MROOT/b/.claude" "$MROOT/c"
printf '{"owner":"f","repo":"f","projectNumber":1,"models":{"driver":"claude-sonnet-5","tend":"bad value"}}\n' >"$MROOT/a/.ralph.json"
printf '{"env":{"RALPH_MODEL_LEAD":"opus"}}\n' >"$MROOT/a/.claude/settings.json"
printf '{"env":{"RALPH_MODEL_DELIVER":"claude-haiku-4-5[1m]"}}\n' >"$MROOT/b/.claude/settings.json"
with_env() { local kv="$1"; shift; ( export "$kv"; "$@" ); }
is "model: unset everywhere is inherit — empty output" "" "$(ralph_lane_model dispatch "$MROOT/c")"
succeeds "model: unset everywhere is rc 0 (inherit is not an error)" ralph_lane_model dispatch "$MROOT/c"
is "model: .ralph.json models.<lane>" "claude-sonnet-5" "$(ralph_lane_model driver "$MROOT/a")"
is "model: a lane .ralph.json does not name falls THROUGH to the settings env block" "opus" "$(ralph_lane_model lead "$MROOT/a")"
is "model: the settings env block alone" "claude-haiku-4-5[1m]" "$(ralph_lane_model deliver "$MROOT/b")"
is "model: RALPH_MODEL_<LANE> in the environment outranks both files" "fable" "$(RALPH_MODEL_DRIVER=fable ralph_lane_model driver "$MROOT/a")"
is "model: ROOT defaults to \$REPO" "claude-sonnet-5" "$(REPO="$MROOT/a" ralph_lane_model driver)"
is "model: a full model id survives the shape check" "us.anthropic.claude-opus-5:0" "$(RALPH_MODEL_LEAD=us.anthropic.claude-opus-5:0 ralph_lane_model lead "$MROOT/c")"
fails "model: an unknown lane refuses (investigators are not a lane)" ralph_lane_model investigator "$MROOT/a"
fails "model: a value with whitespace refuses — a config error, never a silent inherit" ralph_lane_model tend "$MROOT/a"
fails "model: a shell metacharacter refuses" with_env 'RALPH_MODEL_LEAD=x;rm' ralph_lane_model lead "$MROOT/c"
fails "model: a leading dash refuses (it would read as a flag)" with_env 'RALPH_MODEL_LEAD=-model' ralph_lane_model lead "$MROOT/c"
fails "model: a control character refuses — not a metacharacter, but could forge terminal output (GH-2375, PR #2422 discussion_r3920882583)" \
  with_env $'RALPH_MODEL_LEAD=model\x1b[2J' ralph_lane_model lead "$MROOT/c"
out=$(with_env $'RALPH_MODEL_LEAD=model\x1b[2J' ralph_lane_model lead "$MROOT/c" 2>&1 >/dev/null)
case "$out" in
  *$'\x1b'*) not_ok "model: the control-char refusal must never echo the raw ESC byte (GH-2375 Greptile review, discussion_r3920987572) — got '$out'" ;;
  *"model"*"[2J"*) ok "model: the control-char refusal names the %q-escaped value instead of the raw byte" ;;
  *) not_ok "model: control-char refusal text — got '$out'" ;;
esac
long90=$(printf 'a%.0s' $(seq 1 90))
is "model: over 80 chars is admitted — no length ceiling (GH-2375)" "$long90" \
  "$(with_env "RALPH_MODEL_LEAD=$long90" ralph_lane_model lead "$MROOT/c")"
is "model: a Vertex AI id (@) is admitted (GH-2375)" "claude-3-5-sonnet-v2@20241022" \
  "$(with_env 'RALPH_MODEL_LEAD=claude-3-5-sonnet-v2@20241022' ralph_lane_model lead "$MROOT/c")"
bedrock_arn='arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abcdefghijklmnopqrstuvwxyz0123456789'
is "model: a Bedrock application inference-profile ARN (/, :, >80 chars) is admitted (GH-2375)" "$bedrock_arn" \
  "$(with_env "RALPH_MODEL_LEAD=$bedrock_arn" ralph_lane_model lead "$MROOT/c")"
out=$(ralph_lane_model tend "$MROOT/a" 2>&1 >/dev/null)
case "$out" in
  *".ralph.json models.tend=bad\\ value"*) ok "model: the refusal names the source and the %q-escaped value" ;;
  *) not_ok "model: refusal text — got '$out'" ;;
esac
is "model args: two argv words, --model then the value" "--model|claude-sonnet-5|" "$(ralph_model_args driver "$MROOT/a" | tr '\n' '|')"
is "model args: nothing configured prints nothing" "" "$(ralph_model_args dispatch "$MROOT/c")"
fails "model args: the resolver's refusal propagates" ralph_model_args tend "$MROOT/a"
is "observed: --model is not a binding flag (GH-2267 reads it as not_requested)" "not_requested" "$(ralph_tool_binding_observed --model claude-sonnet-5)"
# PR #2374 P1: an unreadable file is a refusal, never a fall-through — the
# knob being set must not render as the knob being ignored.
mkdir -p "$MROOT/d/.claude" "$MROOT/e" "$MROOT/f" "$MROOT/g/.claude"
printf 'not json' >"$MROOT/d/.ralph.json"
printf '{"env":{"RALPH_MODEL_DRIVER":"fable"}}\n' >"$MROOT/d/.claude/settings.json"
printf '{"models":"claude-sonnet-5"}\n' >"$MROOT/e/.ralph.json"
printf '{"models":{"driver":5}}\n' >"$MROOT/f/.ralph.json"
printf '{"models":{"lead":"opus"}}\n' >"$MROOT/g/.ralph.json"
printf '{"env":"nope"}\n' >"$MROOT/g/.claude/settings.json"
fails "model: malformed .ralph.json refuses instead of falling through to the settings block" ralph_lane_model driver "$MROOT/d"
out=$(ralph_lane_model driver "$MROOT/d" 2>&1 >/dev/null)
case "$out" in *"cannot read"*".ralph.json"*) ok "model: the malformed-file refusal names the file" ;; *) not_ok "model: malformed-file refusal text — got '$out'" ;; esac
fails "model: a models value that is not an object refuses" ralph_lane_model driver "$MROOT/e"
fails "model: a non-string lane value refuses" ralph_lane_model driver "$MROOT/f"
is "model: a lane absent from a well-formed models object still inherits" "" "$(ralph_lane_model driver "$MROOT/g")"
fails "model: a settings env block that is not an object refuses" ralph_lane_model tend "$MROOT/g"
is "model: the lane .ralph.json does name never reaches the broken settings block" "opus" "$(ralph_lane_model lead "$MROOT/g")"
# PR #2374 P2: an EMPTY file is unreadable too — a plain jq filter runs
# zero times on it and prints nothing, which read as inherit.
mkdir -p "$MROOT/h/.claude" "$MROOT/i"
printf '{"models":{"lead":"opus"}}\n' >"$MROOT/h/.ralph.json"
: >"$MROOT/h/.claude/settings.json"
printf '  \n' >"$MROOT/i/.ralph.json"
fails "model: an empty settings.json refuses rather than reading as inherit" ralph_lane_model driver "$MROOT/h"
fails "model: a whitespace-only .ralph.json refuses" ralph_lane_model driver "$MROOT/i"
is "model: the lane the well-formed .ralph.json names never reaches the empty settings file" "opus" "$(ralph_lane_model lead "$MROOT/h")"
# A top-level value that is not an object (null, array, scalar) is refused
# too — loadConfig's own "expected a JSON object" rule, restated here because
# board.ts never reads settings.json when .ralph.json exists, so this reader
# is the only thing that would ever look at that file.
mkdir -p "$MROOT/k/.claude" "$MROOT/l"
printf '{"models":{"lead":"opus"}}\n' >"$MROOT/k/.ralph.json"
printf 'null\n' >"$MROOT/k/.claude/settings.json"
printf '[]\n' >"$MROOT/l/.ralph.json"
fails "model: a top-level null settings.json refuses" ralph_lane_model driver "$MROOT/k"
fails "model: a top-level array .ralph.json refuses" ralph_lane_model driver "$MROOT/l"
# An empty STRING is not a model and not an error: it names nothing, like
# an absent key — the shell convention this repo already uses for its env
# knobs (RALPH_CLAIM_MAX_ESTIMATE: empty = off), so it falls through.
mkdir -p "$MROOT/j/.claude"
printf '{"models":{"driver":""}}\n' >"$MROOT/j/.ralph.json"
printf '{"env":{"RALPH_MODEL_DRIVER":"claude-sonnet-5"}}\n' >"$MROOT/j/.claude/settings.json"
is "model: an empty string names nothing and falls through like an absent key" "claude-sonnet-5" "$(ralph_lane_model driver "$MROOT/j")"
is "model: an empty RALPH_MODEL_<LANE> in the environment is unset, not a refusal" "claude-sonnet-5" "$(RALPH_MODEL_DRIVER= ralph_lane_model driver "$MROOT/j")"

echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
