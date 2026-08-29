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
  import { ROLES, LANE_ROLES, HUMAN_SPAWNS, ROLE_NAMES } from "./ralph/scripts/contracts.ts";
  console.log(JSON.stringify({ ROLES, LANE_ROLES, HUMAN_SPAWNS, ROLE_NAMES }));
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

echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
