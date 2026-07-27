#!/usr/bin/env bash
# ralph/hooks/scripts/__tests__/autopilot-enable-gate.test.sh
# Regression suite for the RALPH_AUTOPILOT_ENABLE opt-in gate.
#
# The defect this pins (CodeRabbit, PR #1620): the gate's scope was keyed on
# RALPH_SUBCOMMAND, which hero/SKILL.md Step 0 sets with a bare `export` inside a
# Bash tool call. That export does NOT reach hook subprocesses — only the
# CLAUDE_ENV_FILE writes from set-skill-env.sh do (see
# autopilot-director-postcheck.sh's header for the same finding). So
# RALPH_SUBCOMMAND is typically EMPTY in this hook, the scope check fell through
# to `exit 0`, and every `--mode auto` launch ran unattended automation with
# RALPH_AUTOPILOT_ENABLE unset. Worse, the value is model-controlled: an agent
# that simply never ran Step 0 disarmed the safeguard.
#
# The gate must therefore derive its scope from the harness-supplied Skill
# payload. Every case below with "SUBCOMMAND unset" is the red-before-green
# scenario.
#
# Run: bash ralph/hooks/scripts/__tests__/autopilot-enable-gate.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$(cd "${SCRIPT_DIR}/.." && pwd)/autopilot-enable-gate.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

if [[ ! -f "$GATE" ]]; then
  echo "FATAL: hook not found at $GATE"
  exit 1
fi

# run_case <desc> <expected_exit> <json> [ENV=val ...]
# Clears every RALPH_* control var the gate reads before applying per-case
# overrides — the developer shell profile exports RALPH_* (including
# RALPH_AUTOPILOT_ENABLE), so an inherited value would silently flip a block
# case green.
run_case() {
  local desc="$1" expected="$2" json="$3"; shift 3
  local actual
  if env -u RALPH_COMMAND -u RALPH_SUBCOMMAND -u RALPH_AUTOPILOT_ENABLE \
    RALPH_HOOK_INPUT= "$@" bash "$GATE" <<<"$json" >/dev/null 2>&1; then
    actual=0
  else
    actual=$?
  fi
  if [[ "$actual" == "$expected" ]]; then
    pass "$desc (exit $actual)"
  else
    fail "$desc — expected exit $expected, got $actual"
  fi
}

echo "=== autopilot-enable-gate tests ==="
echo ""

loop_tick='{"tool_input":{"skill":"loop","args":"Run /ralph:hero --tick on the next-most-important event on the project queue"}}'
loop_tickle='{"tool_input":{"skill":"loop","args":"Run /ralph:hero --tickle on the queue"}}'
loop_unrelated='{"tool_input":{"skill":"loop","args":"15m /ralph:caretake --mode watch"}}'
hero_auto='{"tool_input":{"skill":"ralph:hero","args":"--mode auto"}}'
hero_auto_nonleading='{"tool_input":{"skill":"ralph:hero","args":"--issue 5 --mode auto"}}'
hero_auto_alias='{"tool_input":{"skill":"ralph:hero","args":"--auto"}}'
hero_tick='{"tool_input":{"skill":"ralph:hero","args":"--tick"}}'
hero_watch='{"tool_input":{"skill":"ralph:hero","args":"--mode watch --issue 42"}}'
impl_dispatch='{"tool_input":{"skill":"ralph:impl","args":"123"}}'

echo "-- payload-derived scope: RALPH_SUBCOMMAND absent must NOT disarm the gate --"
run_case "1: hero + Skill(loop,/ralph:hero --tick), SUBCOMMAND unset, enable unset -> exit 2" 2 \
  "$loop_tick" RALPH_COMMAND=hero
run_case "2: hero + Skill(loop,/ralph:hero --tick), SUBCOMMAND unset, enable=true -> exit 0" 0 \
  "$loop_tick" RALPH_COMMAND=hero RALPH_AUTOPILOT_ENABLE=true
run_case "3: hero + Skill(ralph:hero,--mode auto), SUBCOMMAND unset -> exit 2" 2 \
  "$hero_auto" RALPH_COMMAND=hero
run_case "4: hero + Skill(ralph:hero,--issue 5 --mode auto) non-leading flag -> exit 2" 2 \
  "$hero_auto_nonleading" RALPH_COMMAND=hero
run_case "5: hero + Skill(ralph:hero,--auto) alias -> exit 2" 2 \
  "$hero_auto_alias" RALPH_COMMAND=hero
run_case "6: hero + Skill(ralph:hero,--tick) direct tick -> exit 2" 2 \
  "$hero_tick" RALPH_COMMAND=hero

echo ""
echo "-- payload scope survives a wrong/absent RALPH_SUBCOMMAND value --"
run_case "7: SUBCOMMAND=default (wrong) + auto-loop payload -> exit 2" 2 \
  "$loop_tick" RALPH_COMMAND=hero RALPH_SUBCOMMAND=default
run_case "8: RALPH_COMMAND unset entirely + auto-loop payload -> exit 2" 2 \
  "$loop_tick"

echo ""
echo "-- env-derived scope preserved (additive, never subtractive) --"
run_case "9: legacy RALPH_COMMAND=autopilot, any Skill -> exit 2" 2 \
  "$impl_dispatch" RALPH_COMMAND=autopilot
run_case "10: RALPH_COMMAND=hero + SUBCOMMAND=auto (env propagated) -> exit 2" 2 \
  "$impl_dispatch" RALPH_COMMAND=hero RALPH_SUBCOMMAND=auto
run_case "11: RALPH_COMMAND=hero + SUBCOMMAND=tick (env propagated) -> exit 2" 2 \
  "$impl_dispatch" RALPH_COMMAND=hero RALPH_SUBCOMMAND=tick
run_case "12: RALPH_COMMAND=autopilot + enable=true -> exit 0" 0 \
  "$impl_dispatch" RALPH_COMMAND=autopilot RALPH_AUTOPILOT_ENABLE=true

echo ""
echo "-- out of scope: non-autonomous dispatches pass through --"
run_case "13: hero default-mode Skill(ralph:impl,123) -> exit 0" 0 \
  "$impl_dispatch" RALPH_COMMAND=hero
run_case "14: hero Skill(ralph:hero,--mode watch --issue 42) -> exit 0" 0 \
  "$hero_watch" RALPH_COMMAND=hero
run_case "15: token boundary — /ralph:hero --tickle is not --tick -> exit 0" 0 \
  "$loop_tickle" RALPH_COMMAND=hero
run_case "16: unrelated /loop wrapper (caretake watch) -> exit 0" 0 \
  "$loop_unrelated" RALPH_COMMAND=hero
run_case "17: non-hero verb, unrelated Skill -> exit 0" 0 \
  "$impl_dispatch" RALPH_COMMAND=research

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
