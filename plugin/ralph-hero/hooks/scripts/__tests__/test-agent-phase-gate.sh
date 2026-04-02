#!/bin/bash
# Test agent-phase-gate.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"
GATE="$HOOKS_DIR/agent-phase-gate.sh"

pass=0
fail=0

assert_eq() {
  local expected="$1" actual="$2" desc="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
  else
    echo "FAIL: $desc — expected '$expected', got '$actual'"
    fail=$((fail + 1))
  fi
}

# Build a minimal hook input JSON for testing
make_input() {
  local tool_name="${1:-Write}"
  local agent_type="${2:-}"
  # Use printf to avoid locale issues with jq
  printf '{"tool_name":"%s","agent_type":"%s","tool_input":{}}' "$tool_name" "$agent_type"
}

# ── Test 1: RALPH_COMMAND set → exits 0 (guard fires, skip phase gate) ────
result=$(echo "$(make_input "Write" "impl-agent")" | RALPH_COMMAND=ralph_plan bash "$GATE"; echo $?)
assert_eq "0" "$result" "RALPH_COMMAND=ralph_plan set, agent_type=impl-agent → exits 0 (RALPH_COMMAND guard)"

# ── Test 2: RALPH_COMMAND unset, agent_type empty → exits 0 ──────────────
result=$(echo "$(make_input "Write" "")" | bash "$GATE"; echo $?)
assert_eq "0" "$result" "RALPH_COMMAND unset, agent_type empty → exits 0 (empty agent_type guard)"

# ── Test 3: exec delegation exports RALPH_HOOK_INPUT to child script ──────
# Create a stub that replaces impl-plan-required.sh in a temp dir
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

# Stub: prints RALPH_HOOK_INPUT env var value and exits 0
cat > "$TMP_DIR/impl-plan-required.sh" <<'EOF'
#!/bin/bash
printf '%s' "${RALPH_HOOK_INPUT:-NOT_SET}"
exit 0
EOF
chmod +x "$TMP_DIR/impl-plan-required.sh"

# Stub hook-utils.sh that sets RALPH_HOOK_INPUT via read_input() and exposes helpers
cat > "$TMP_DIR/hook-utils.sh" <<'EOF'
#!/bin/bash
read_input() {
  if [[ -z "${RALPH_HOOK_INPUT:-}" ]]; then
    export RALPH_HOOK_INPUT=$(cat)
  fi
  echo "$RALPH_HOOK_INPUT"
}
get_field() {
  local field="$1"
  echo "$RALPH_HOOK_INPUT" | jq -r "$field // empty"
}
get_tool_name() { get_field '.tool_name'; }
get_agent_type() { get_field '.agent_type'; }
allow() { exit 0; }
EOF

# Stub impl-branch-gate.sh
cp "$TMP_DIR/impl-plan-required.sh" "$TMP_DIR/impl-branch-gate.sh"
# Stub branch-gate.sh
cp "$TMP_DIR/impl-plan-required.sh" "$TMP_DIR/branch-gate.sh"

# Make a copy of agent-phase-gate.sh that sources from our stub dir
STUB_GATE="$TMP_DIR/agent-phase-gate.sh"
sed "s|source \"\$(dirname \"\$0\")/hook-utils.sh\"|source \"$TMP_DIR/hook-utils.sh\"|" "$GATE" \
  | sed "s|\$(dirname \"\$0\")|$TMP_DIR|g" > "$STUB_GATE"
chmod +x "$STUB_GATE"

INPUT_JSON=$(make_input "Write" "impl-agent")
ralph_hook_output=$(echo "$INPUT_JSON" | bash "$STUB_GATE")

assert_eq "$INPUT_JSON" "$ralph_hook_output" "impl-agent+Write: RALPH_HOOK_INPUT exported and received by child script"

# ── Test 4: research-agent + Read tool → exits 0 (no case match, allow) ──
result=$(echo "$(make_input "Read" "research-agent")" | bash "$GATE"; echo $?)
assert_eq "0" "$result" "research-agent + Read tool → exits 0 (no matching case, falls through to allow)"

echo ""
echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]] || exit 1
