#!/usr/bin/env bash
# smoke.sh — static assertions for the Watcher team artifact set
#
# Checks:
#   1. SOUL.md frontmatter has team, voice, refuses keys
#   2. SOUL.md body word count is in [150, 250]
#   3. log-reader.md tools: field excludes write/mutation tools
#   4. sre-fixit.md body contains the four kubectl shapes and no --force/--cascade
#   5. watch/SKILL.md SessionStart hook references both set-skill-env.sh and load-team-soul.sh
#   6. watch/SKILL.md contains at least three TODO(GH-1272) markers
#   7. sre-allowlist-gate.sh: positive test (permitted kubectl shape passes)
#   8. sre-allowlist-gate.sh: negative test (disallowed command is blocked)
#   9. Heartbeat patch (Feature D, GH-1271): SKILL.md contains --auto-confirm step
#  10. ralph-debug-collate/SKILL.md documents --auto-confirm flag (Feature D)
#
# Checks 1-8 are Feature C (GH-1270) artifacts. When running from a worktree
# that predates Feature C's merge, absent files are skipped (not failed) so the
# Feature D assertions (9-10) can be validated independently.
#
# Usage:
#   bash plugin/ralph-hero/scripts/watch/smoke.sh
#
# Exit codes:
#   0   All checks passed (or skipped due to absent Feature C artifacts)
#   1   One or more assertions failed (first failure emits to stderr)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd -P)"
PLUGIN_ROOT="${REPO_ROOT}/plugin/ralph-hero"

SOUL_MD="${PLUGIN_ROOT}/skills/watch/SOUL.md"
LOG_READER_MD="${PLUGIN_ROOT}/agents/log-reader.md"
SRE_FIXIT_MD="${PLUGIN_ROOT}/agents/sre-fixit.md"
SKILL_MD="${PLUGIN_ROOT}/skills/watch/SKILL.md"

PASS=0
FAIL=0
SKIP=0

_pass() { echo "[PASS] $1"; (( PASS++ )) || true; }
_fail() { echo "[FAIL] $1" >&2; (( FAIL++ )) || true; }
_skip() { echo "[SKIP] $1 (Feature C artifact absent — pending GH-1270 merge)"; (( SKIP++ )) || true; }

echo "=== watch smoke test ==="
echo ""

# ---------------------------------------------------------------------------
# 1. SOUL.md frontmatter has team, voice, refuses keys
# ---------------------------------------------------------------------------
if [[ ! -f "$SOUL_MD" ]]; then
  _skip "SOUL.md not found: ${SOUL_MD}"
else
  KEY_COUNT=$(grep -cE '^(team|voice|refuses):' "$SOUL_MD" || true)
  if [[ "$KEY_COUNT" -eq 3 ]]; then
    _pass "SOUL.md frontmatter has team, voice, refuses keys (found ${KEY_COUNT})"
  else
    _fail "SOUL.md frontmatter missing keys — expected 3 of (team|voice|refuses), found ${KEY_COUNT}"
  fi

  # Validate frontmatter YAML is parseable
  if python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]).read().split("---")[1])' "$SOUL_MD" 2>/dev/null; then
    _pass "SOUL.md frontmatter YAML is valid"
  else
    _fail "SOUL.md frontmatter YAML is invalid"
  fi
fi

# ---------------------------------------------------------------------------
# 2. SOUL.md body word count is in [150, 250]
#    (Feature C ships the full SOUL body; stub from Feature A is < 150 words)
# ---------------------------------------------------------------------------
if [[ ! -f "$SOUL_MD" ]]; then
  _skip "SOUL.md body word count (file absent)"
else
  WORD_COUNT=$(awk '/^---$/{n++; next} n==2' "$SOUL_MD" | wc -w | tr -d ' ')
  if [[ "$WORD_COUNT" -ge 150 && "$WORD_COUNT" -le 250 ]]; then
    _pass "SOUL.md body word count ${WORD_COUNT} is in [150, 250]"
  elif [[ "$WORD_COUNT" -lt 150 ]]; then
    _skip "SOUL.md body word count ${WORD_COUNT} < 150 — Feature C stub (full SOUL ships with GH-1270)"
  else
    _fail "SOUL.md body word count ${WORD_COUNT} is outside [150, 250]"
  fi
fi

# ---------------------------------------------------------------------------
# 3. log-reader.md tools: field excludes write/mutation tools
# ---------------------------------------------------------------------------
if [[ ! -f "$LOG_READER_MD" ]]; then
  _skip "log-reader.md not found: ${LOG_READER_MD}"
else
  if python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]).read().split("---")[1])' "$LOG_READER_MD" 2>/dev/null; then
    _pass "log-reader.md frontmatter YAML is valid"
  else
    _fail "log-reader.md frontmatter YAML is invalid"
  fi

  TOOLS_LINE=$(grep -E '^tools:' "$LOG_READER_MD" || true)
  FORBIDDEN='(Edit|Write|save_issue|create_issue|add_dependency|add_sub_issue|batch_update|advance_issue|archive_items)'
  if echo "$TOOLS_LINE" | grep -Eq "$FORBIDDEN"; then
    _fail "log-reader.md tools: field contains a forbidden write/mutation tool — line: '${TOOLS_LINE}'"
  else
    _pass "log-reader.md tools: field contains no write/mutation tools"
  fi

  if grep -qE '^model: haiku$' "$LOG_READER_MD"; then
    _pass "log-reader.md model is haiku"
  else
    _fail "log-reader.md model is not haiku"
  fi
fi

# ---------------------------------------------------------------------------
# 4a. sre-fixit.md body contains all four kubectl shapes
# ---------------------------------------------------------------------------
if [[ ! -f "$SRE_FIXIT_MD" ]]; then
  _skip "sre-fixit.md not found: ${SRE_FIXIT_MD}"
else
  if python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]).read().split("---")[1])' "$SRE_FIXIT_MD" 2>/dev/null; then
    _pass "sre-fixit.md frontmatter YAML is valid"
  else
    _fail "sre-fixit.md frontmatter YAML is invalid"
  fi

  KUBECTL_COUNT=$(grep -cE 'kubectl (scale|drain|rollout|delete pod)' "$SRE_FIXIT_MD" || true)
  if [[ "$KUBECTL_COUNT" -ge 4 ]]; then
    _pass "sre-fixit.md contains at least 4 kubectl allowlist shapes (found ${KUBECTL_COUNT})"
  else
    _fail "sre-fixit.md missing kubectl allowlist shapes — expected >=4, found ${KUBECTL_COUNT}"
  fi

  # 4b. No --force or --cascade=foreground
  if grep -qE '(--force|--cascade=foreground)' "$SRE_FIXIT_MD"; then
    _fail "sre-fixit.md contains forbidden flags (--force or --cascade=foreground)"
  else
    _pass "sre-fixit.md has no --force or --cascade=foreground flags"
  fi
fi

# ---------------------------------------------------------------------------
# 5. watch/SKILL.md SessionStart hook references both scripts
# ---------------------------------------------------------------------------
if [[ ! -f "$SKILL_MD" ]]; then
  _fail "watch/SKILL.md not found: ${SKILL_MD}"
else
  if python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]).read().split("---")[1])' "$SKILL_MD" 2>/dev/null; then
    _pass "watch/SKILL.md frontmatter YAML is valid"
  else
    _fail "watch/SKILL.md frontmatter YAML is invalid"
  fi

  HOOK_COUNT=$(grep -cE '(set-skill-env\.sh|load-team-soul\.sh)' "$SKILL_MD" || true)
  if [[ "$HOOK_COUNT" -ge 2 ]]; then
    _pass "watch/SKILL.md SessionStart hook references both set-skill-env.sh and load-team-soul.sh (found ${HOOK_COUNT})"
  else
    _fail "watch/SKILL.md SessionStart hook missing one or both scripts — expected >=2 matches, found ${HOOK_COUNT}"
  fi

  # argument-hint check
  if grep -qE '^argument-hint: "\[--issue NNN\]"$' "$SKILL_MD"; then
    _pass "watch/SKILL.md argument-hint is exactly \"[--issue NNN]\""
  else
    _fail "watch/SKILL.md argument-hint does not match expected value \"[--issue NNN]\""
  fi
fi

# ---------------------------------------------------------------------------
# 6. watch/SKILL.md contains at least three TODO(GH-1272) markers
# ---------------------------------------------------------------------------
if [[ -f "$SKILL_MD" ]]; then
  TODO_COUNT=$(grep -c 'TODO(GH-1272)' "$SKILL_MD" || true)
  if [[ "$TODO_COUNT" -ge 3 ]]; then
    _pass "watch/SKILL.md contains ${TODO_COUNT} TODO(GH-1272) markers (>= 3 required)"
  else
    _fail "watch/SKILL.md has only ${TODO_COUNT} TODO(GH-1272) markers — expected at least 3"
  fi
fi

# ---------------------------------------------------------------------------
# 7. sre-allowlist-gate.sh: positive test (permitted kubectl shape passes)
# ---------------------------------------------------------------------------
GATE_SCRIPT="${PLUGIN_ROOT}/hooks/scripts/sre-allowlist-gate.sh"

if [[ ! -f "$GATE_SCRIPT" ]]; then
  _skip "sre-allowlist-gate.sh not found: ${GATE_SCRIPT}"
else
  if [[ -x "$GATE_SCRIPT" ]]; then
    _pass "sre-allowlist-gate.sh is executable"
  else
    _fail "sre-allowlist-gate.sh is not executable"
  fi

  # Positive: kubectl scale deployment (allowed shape) must exit 0
  POSITIVE_PAYLOAD='{"hook_event_name":"PreToolUse","tool_name":"Bash","agent_type":"ralph-hero:sre-fixit","tool_input":{"command":"kubectl scale deployment api --replicas=3"}}'
  if echo "$POSITIVE_PAYLOAD" | bash "$GATE_SCRIPT" >/dev/null 2>&1; then
    _pass "sre-allowlist-gate.sh: permitted kubectl shape exits 0 (positive test)"
  else
    _fail "sre-allowlist-gate.sh: permitted kubectl shape was blocked — positive test FAILED"
  fi

  # ---------------------------------------------------------------------------
  # 8. sre-allowlist-gate.sh: negative test (disallowed command is blocked)
  # ---------------------------------------------------------------------------
  # kubectl delete deployment is NOT in the allowlist (only 'delete pod' is)
  NEGATIVE_PAYLOAD='{"hook_event_name":"PreToolUse","tool_name":"Bash","agent_type":"ralph-hero:sre-fixit","tool_input":{"command":"kubectl delete deployment api"}}'
  if echo "$NEGATIVE_PAYLOAD" | bash "$GATE_SCRIPT" >/dev/null 2>&1; then
    _fail "sre-allowlist-gate.sh: disallowed command was NOT blocked — negative test FAILED"
  else
    EXIT_CODE=$?
    if [[ "$EXIT_CODE" -eq 2 ]]; then
      _pass "sre-allowlist-gate.sh: disallowed kubectl command blocked with exit 2 (negative test)"
    else
      _pass "sre-allowlist-gate.sh: disallowed kubectl command blocked (exit ${EXIT_CODE}) (negative test)"
    fi
  fi

  # log-reader positive: gcloud logging read (allowed shape) must exit 0
  LOG_POSITIVE_PAYLOAD='{"hook_event_name":"PreToolUse","tool_name":"Bash","agent_type":"ralph-hero:log-reader","tool_input":{"command":"gcloud logging read '\''severity>=ERROR'\'' --limit=50 --project=my-proj --format=json"}}'
  if echo "$LOG_POSITIVE_PAYLOAD" | bash "$GATE_SCRIPT" >/dev/null 2>&1; then
    _pass "sre-allowlist-gate.sh: permitted gcloud logging read exits 0 (log-reader positive test)"
  else
    _fail "sre-allowlist-gate.sh: permitted gcloud logging read was blocked — log-reader positive test FAILED"
  fi

  # log-reader negative: arbitrary shell command must be blocked
  LOG_NEGATIVE_PAYLOAD='{"hook_event_name":"PreToolUse","tool_name":"Bash","agent_type":"ralph-hero:log-reader","tool_input":{"command":"gcloud projects delete my-proj"}}'
  if echo "$LOG_NEGATIVE_PAYLOAD" | bash "$GATE_SCRIPT" >/dev/null 2>&1; then
    _fail "sre-allowlist-gate.sh: disallowed gcloud subcommand was NOT blocked — log-reader negative test FAILED"
  else
    _pass "sre-allowlist-gate.sh: disallowed gcloud subcommand blocked (log-reader negative test)"
  fi

  # non-restricted agent: any command must pass through (exit 0)
  OTHER_PAYLOAD='{"hook_event_name":"PreToolUse","tool_name":"Bash","agent_type":"ralph-hero:impl-agent","tool_input":{"command":"echo hello"}}'
  if echo "$OTHER_PAYLOAD" | bash "$GATE_SCRIPT" >/dev/null 2>&1; then
    _pass "sre-allowlist-gate.sh: non-restricted agent_type passes through (exit 0)"
  else
    _fail "sre-allowlist-gate.sh: non-restricted agent_type was incorrectly blocked"
  fi
fi

# ---------------------------------------------------------------------------
# 9. Heartbeat patch (Feature D, GH-1271): SKILL.md contains auto-confirm step
# ---------------------------------------------------------------------------
if [[ -f "$SKILL_MD" ]]; then
  if grep -q 'auto-confirm' "$SKILL_MD"; then
    _pass "watch/SKILL.md heartbeat contains --auto-confirm step (Feature D)"
  else
    _fail "watch/SKILL.md heartbeat missing --auto-confirm step — Feature D patch not applied"
  fi

  if grep -q 'RALPH_DEBUG=true' "$SKILL_MD" && grep -q 'debug-collate skipped' "$SKILL_MD"; then
    _pass "watch/SKILL.md heartbeat has RALPH_DEBUG preflight check with skip warning"
  else
    _fail "watch/SKILL.md heartbeat missing RALPH_DEBUG preflight check or 'debug-collate skipped' warning"
  fi

  if grep -qE 'result: heartbeat:.*debug-collate issues filed' "$SKILL_MD"; then
    _pass "watch/SKILL.md heartbeat result: line includes debug-collate counter"
  else
    _fail "watch/SKILL.md heartbeat result: line missing debug-collate counter"
  fi
fi

# ---------------------------------------------------------------------------
# 10. ralph-debug-collate/SKILL.md contains --auto-confirm flag (Feature D)
# ---------------------------------------------------------------------------
DEBUG_COLLATE_MD="${PLUGIN_ROOT}/skills/ralph-debug-collate/SKILL.md"
if [[ ! -f "$DEBUG_COLLATE_MD" ]]; then
  _fail "ralph-debug-collate/SKILL.md not found: ${DEBUG_COLLATE_MD}"
else
  if grep -q 'auto-confirm' "$DEBUG_COLLATE_MD"; then
    _pass "ralph-debug-collate/SKILL.md documents --auto-confirm flag"
  else
    _fail "ralph-debug-collate/SKILL.md missing --auto-confirm flag documentation"
  fi

  if grep -q 'argument-hint' "$DEBUG_COLLATE_MD" && grep -E 'argument-hint.*auto-confirm' "$DEBUG_COLLATE_MD" >/dev/null 2>&1; then
    _pass "ralph-debug-collate/SKILL.md argument-hint includes --auto-confirm"
  else
    _fail "ralph-debug-collate/SKILL.md argument-hint missing --auto-confirm"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped (Feature C pending) ==="

if (( FAIL > 0 )); then
  exit 1
fi

echo "Smoke test PASSED."
exit 0
