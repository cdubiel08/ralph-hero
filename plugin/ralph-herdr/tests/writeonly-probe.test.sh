#!/usr/bin/env bash
# writeonly-probe.test.sh — spawn_writeonly_probe (GH-2363): the in-pane
# tool-binding self-test for a harness with NO BASH, where
# spawn_containment_probe's Bash-touch/Write/Bash-control sandwich cannot run
# at all. The investigator is the only role this applies to today (no Bash in
# its allowlist), but the function itself takes no role — it is tested
# directly here rather than through the whole spawn_investigator path.
#
#   bash plugin/ralph-herdr/tests/writeonly-probe.test.sh   # rc 0 pass, 1 fail
#
# No herdr server, no board mutation, no writes outside $TMP.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-writeonly-probe-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

export HERDR_BIN_PATH="$SCRIPT_DIR/fake-herdr.sh"
export FAKE_HERDR_FIXTURES="$TMP/fixtures"
export FAKE_HERDR_LOG="$TMP/herdr.log"
mkdir -p "$FAKE_HERDR_FIXTURES"
export RALPH_HERDR_REPO="$TMP"
export RALPH_HERDR_LEDGER="$TMP/ledger/ledger.jsonl"
mkdir -p "$TMP/ledger"

# shellcheck source=../scripts/lib.sh
. "$SCRIPT_DIR/../scripts/lib.sh"
set +e

CHECKOUT="$TMP/tree"
mkdir -p "$CHECKOUT"

# The hook plays the pane's side of the ONE prompt spawn_writeonly_probe
# sends: it reads the Write target out of the prompt text and, per
# FAKE_PROBE_MODE, either touches it (an unbound Write ran) or leaves it
# alone (a bound harness refused the tool, or the model never got there).
cat >"$TMP/probe-hook.sh" <<'HOOK'
#!/usr/bin/env bash
target=$(printf '%s' "$2" | sed -n "s/^.*create the file '\([^']*\)' with the content.*$/\1/p" | head -1)
[ -n "$target" ] || exit 0
case "${FAKE_PROBE_MODE:-bound}" in
  bound) : ;;
  unbound-write) touch "$target" ;;
esac
HOOK
chmod +x "$TMP/probe-hook.sh"
export FAKE_HERDR_PROMPT_HOOK="$TMP/probe-hook.sh"

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1 — expected '$2', got '$3'"; fi
}
has() {
  if printf '%s' "$2" | grep -q -- "$3"; then ok "$1"; else not_ok "$1 — no '$3' in: $(printf '%s' "$2" | head -5)"; fi
}

reset() {
  rm -f "$FAKE_HERDR_FIXTURES"/agent-wait-until.* "$FAKE_HERDR_FIXTURES"/agent-get.*
  rm -f "$CHECKOUT"/.ralph-writeonly-probe-* "$TMP"/.ralph-writeonly-probe-*
  : >"$FAKE_HERDR_LOG"
  export FAKE_PROBE_MODE=bound
  unset RALPH_HERDR_CONTAINMENT_PROBE_SEC
}
agent_status() { # NAME STATUS — the fixture for a bare `agent get` (the
                 # completion poll), a DIFFERENT key from agent-wait-until so
                 # the turn-start wait and the completion poll are
                 # independently steerable.
  printf '{"agent":{"name":"%s","agent_status":"%s"}}\n' "$1" "$2" \
    >"$FAKE_HERDR_FIXTURES/agent-get.$1.json"
}
turn_started() { # NAME STATUS — the fixture for `agent wait --until …`
                 # (turn-start confirmation via spawn_confirm_turn).
  printf '{"agent":{"name":"%s","agent_status":"%s"}}\n' "$1" "$2" \
    >"$FAKE_HERDR_FIXTURES/agent-wait-until.$1.json"
}

# ── 1. bound harness: no writer, turn settles idle — accepted ────────────────
reset
turn_started p1-agent working
agent_status p1-agent idle
out=$(spawn_writeonly_probe p1-agent pane1 "$CHECKOUT" "re-spawn it" 2>"$TMP/err.log")
rc=$?
err=$(cat "$TMP/err.log" 2>/dev/null); rm -f "$TMP/err.log"
is "bound: rc 0" "0" "$rc"
is "bound: prints accepted" "accepted" "$out"
is "bound: no marker left behind" "0" "$(find "$CHECKOUT" -maxdepth 1 -name '.ralph-writeonly-probe-*' | wc -l | tr -d ' ')"
has "bound: the probe prompt names GH-2363" "$(grep 'agent prompt p1-agent' "$FAKE_HERDR_LOG")" "GH-2363"
has "bound: the prompt says Write-only and only" "$(grep 'agent prompt p1-agent' "$FAKE_HERDR_LOG")" "Write tool, and only the Write tool"

# ── 2. unbound Write: the marker lands — unforgeable, no Bash to fake it ─────
reset
turn_started p2-agent working
agent_status p2-agent idle
export FAKE_PROBE_MODE=unbound-write
out=$(spawn_writeonly_probe p2-agent pane2 "$CHECKOUT" "re-spawn it" 2>"$TMP/err.log")
rc=$?
err=$(cat "$TMP/err.log" 2>/dev/null); rm -f "$TMP/err.log"
is "unbound write: rc 1" "1" "$rc"
is "unbound write: prints not_applied" "not_applied" "$out"
has "unbound write: the refusal names the write" "$err" "WROTE"
has "unbound write: the refusal cites no Bash to forge it" "$err" "no Bash exists in this harness"
is "unbound write: the marker is cleaned up, not left in the tree" "0" \
  "$(find "$CHECKOUT" -maxdepth 1 -name '.ralph-writeonly-probe-*' | wc -l | tr -d ' ')"

# ── 3. a dialog during the Write step: blocked with no writer — not_applied ──
reset
turn_started p3-agent working
agent_status p3-agent blocked
out=$(spawn_writeonly_probe p3-agent pane3 "$CHECKOUT" "re-spawn it" 2>"$TMP/err.log")
rc=$?
err=$(cat "$TMP/err.log" 2>/dev/null); rm -f "$TMP/err.log"
is "blocked: rc 1" "1" "$rc"
is "blocked: prints not_applied" "not_applied" "$out"
has "blocked: the refusal names the dialog" "$err" "BLOCKED on a prompt during the Write step"

# ── 4. the turn never settles: neither idle/done nor blocked — unverified ────
reset
turn_started p4-agent working
agent_status p4-agent working
export RALPH_HERDR_CONTAINMENT_PROBE_SEC=1
out=$(spawn_writeonly_probe p4-agent pane4 "$CHECKOUT" "re-spawn it" 2>"$TMP/err.log")
rc=$?
err=$(cat "$TMP/err.log" 2>/dev/null); rm -f "$TMP/err.log"
is "never settles: rc 1" "1" "$rc"
is "never settles: prints unverified" "unverified" "$out"
has "never settles: the refusal names the honest limit" "$err" "unverified"

# ── 5. the writability pre-check (PR #2337 P1's lesson, restated) ───────────
reset
out=$(spawn_writeonly_probe p5-agent pane5 "$TMP/no-such-dir" "re-spawn it" 2>"$TMP/err.log")
rc=$?
err=$(cat "$TMP/err.log" 2>/dev/null); rm -f "$TMP/err.log"
is "bad checkout: rc 1" "1" "$rc"
is "bad checkout: prints unverified" "unverified" "$out"
is "bad checkout: no prompt ever reaches a pane that cannot even be probed" "0" \
  "$(grep -c 'agent prompt p5-agent' "$FAKE_HERDR_LOG" 2>/dev/null)"

# ── 6. required arguments ─────────────────────────────────────────────────────
reset
out=$(spawn_writeonly_probe "" pane6 "$CHECKOUT" 2>"$TMP/err.log")
rc=$?
err=$(cat "$TMP/err.log" 2>/dev/null); rm -f "$TMP/err.log"
is "missing agent: rc 1" "1" "$rc"
is "missing agent: prints unverified" "unverified" "$out"
has "missing agent: names what is required" "$err" "agent, pane and checkout are all required"

echo "1..$n"
echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
