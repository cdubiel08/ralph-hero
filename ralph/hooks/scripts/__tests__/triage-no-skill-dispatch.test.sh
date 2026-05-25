#!/bin/bash
# ralph/hooks/scripts/__tests__/triage-no-skill-dispatch.test.sh
# Tests for triage-no-skill-dispatch.sh
#
# Exercises:
#   1. RALPH_SUBCOMMAND=triage + Skill tool → exit 2 (blocked)
#   2. RALPH_SUBCOMMAND=hygiene + Skill tool → exit 0 (pass through)
#   3. RALPH_SUBCOMMAND=triage + Agent tool → exit 0 (pass through)
#   4. RALPH_SUBCOMMAND=triage + MCP tool → exit 0 (pass through)
#   5. RALPH_SUBCOMMAND unset → exit 0 (pass through)

set -euo pipefail

HOOK="$(dirname "$0")/../triage-no-skill-dispatch.sh"
PASS=0
FAIL=0

pass() {
  echo "  PASS: $1"
  ((PASS++)) || true
}

fail() {
  echo "  FAIL: $1"
  ((FAIL++)) || true
}

# Helper: invoke the hook with given env + JSON input, return exit code
run_hook() {
  local subcommand="${1:-}"
  local tool_name="${2:-Skill}"
  local input
  input=$(printf '{"tool_name":"%s","tool_input":{}}' "$tool_name")

  local exit_code=0
  if [[ -n "$subcommand" ]]; then
    RALPH_SUBCOMMAND="$subcommand" \
    RALPH_COMMAND="caretake" \
    RALPH_HOOK_INPUT="$input" \
      bash "$HOOK" <<< "$input" 2>/dev/null
    exit_code=$?
  else
    RALPH_COMMAND="caretake" \
    RALPH_HOOK_INPUT="$input" \
      bash "$HOOK" <<< "$input" 2>/dev/null
    exit_code=$?
  fi
  echo "$exit_code"
}

echo "=== triage-no-skill-dispatch hook tests ==="
echo ""

echo "--- Should BLOCK (exit 2) ---"

# Test 1: triage + Skill → blocked
code=$(RALPH_SUBCOMMAND=triage RALPH_COMMAND=caretake RALPH_HOOK_INPUT='{"tool_name":"Skill","tool_input":{}}' \
  bash "$HOOK" <<< '{"tool_name":"Skill","tool_input":{}}' 2>/dev/null; echo $?)
if [[ "$code" == "2" ]]; then
  pass "RALPH_SUBCOMMAND=triage + Skill tool → exit 2"
else
  fail "RALPH_SUBCOMMAND=triage + Skill tool → expected exit 2, got $code"
fi

echo ""
echo "--- Should PASS THROUGH (exit 0) ---"

# Test 2: hygiene + Skill → pass through (different subcommand)
code=$(RALPH_SUBCOMMAND=hygiene RALPH_COMMAND=caretake RALPH_HOOK_INPUT='{"tool_name":"Skill","tool_input":{}}' \
  bash "$HOOK" <<< '{"tool_name":"Skill","tool_input":{}}' 2>/dev/null; echo $?)
if [[ "$code" == "0" ]]; then
  pass "RALPH_SUBCOMMAND=hygiene + Skill tool → exit 0"
else
  fail "RALPH_SUBCOMMAND=hygiene + Skill tool → expected exit 0, got $code"
fi

# Test 3: triage + Agent → pass through (non-Skill tool)
code=$(RALPH_SUBCOMMAND=triage RALPH_COMMAND=caretake RALPH_HOOK_INPUT='{"tool_name":"Agent","tool_input":{}}' \
  bash "$HOOK" <<< '{"tool_name":"Agent","tool_input":{}}' 2>/dev/null; echo $?)
if [[ "$code" == "0" ]]; then
  pass "RALPH_SUBCOMMAND=triage + Agent tool → exit 0"
else
  fail "RALPH_SUBCOMMAND=triage + Agent tool → expected exit 0, got $code"
fi

# Test 4: triage + MCP tool → pass through
code=$(RALPH_SUBCOMMAND=triage RALPH_COMMAND=caretake RALPH_HOOK_INPUT='{"tool_name":"mcp__plugin_ralph_ralph-github__ralph_hero__get_issue","tool_input":{}}' \
  bash "$HOOK" <<< '{"tool_name":"mcp__plugin_ralph_ralph-github__ralph_hero__get_issue","tool_input":{}}' 2>/dev/null; echo $?)
if [[ "$code" == "0" ]]; then
  pass "RALPH_SUBCOMMAND=triage + MCP get_issue tool → exit 0"
else
  fail "RALPH_SUBCOMMAND=triage + MCP get_issue tool → expected exit 0, got $code"
fi

# Test 5: RALPH_SUBCOMMAND unset → pass through
code=$(RALPH_COMMAND=caretake RALPH_HOOK_INPUT='{"tool_name":"Skill","tool_input":{}}' \
  bash "$HOOK" <<< '{"tool_name":"Skill","tool_input":{}}' 2>/dev/null; echo $?)
if [[ "$code" == "0" ]]; then
  pass "RALPH_SUBCOMMAND unset + Skill tool → exit 0"
else
  fail "RALPH_SUBCOMMAND unset + Skill tool → expected exit 0, got $code"
fi

# Test 6: all caretake mode passes Skill (e.g., fan-out)
code=$(RALPH_SUBCOMMAND=all RALPH_COMMAND=caretake RALPH_HOOK_INPUT='{"tool_name":"Skill","tool_input":{}}' \
  bash "$HOOK" <<< '{"tool_name":"Skill","tool_input":{}}' 2>/dev/null; echo $?)
if [[ "$code" == "0" ]]; then
  pass "RALPH_SUBCOMMAND=all + Skill tool → exit 0 (fan-out allowed)"
else
  fail "RALPH_SUBCOMMAND=all + Skill tool → expected exit 0, got $code"
fi

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
