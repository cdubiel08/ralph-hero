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
#
# Usage:
#   bash plugin/ralph-hero/scripts/watch/smoke.sh
#
# Exit codes:
#   0   All checks passed
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

_pass() { echo "[PASS] $1"; (( PASS++ )) || true; }
_fail() { echo "[FAIL] $1" >&2; (( FAIL++ )) || true; }

echo "=== watch smoke test ==="
echo ""

# ---------------------------------------------------------------------------
# 1. SOUL.md frontmatter has team, voice, refuses keys
# ---------------------------------------------------------------------------
if [[ ! -f "$SOUL_MD" ]]; then
  _fail "SOUL.md not found: ${SOUL_MD}"
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
# ---------------------------------------------------------------------------
if [[ -f "$SOUL_MD" ]]; then
  WORD_COUNT=$(awk '/^---$/{n++; next} n==2' "$SOUL_MD" | wc -w | tr -d ' ')
  if [[ "$WORD_COUNT" -ge 150 && "$WORD_COUNT" -le 250 ]]; then
    _pass "SOUL.md body word count ${WORD_COUNT} is in [150, 250]"
  else
    _fail "SOUL.md body word count ${WORD_COUNT} is outside [150, 250]"
  fi
fi

# ---------------------------------------------------------------------------
# 3. log-reader.md tools: field excludes write/mutation tools
# ---------------------------------------------------------------------------
if [[ ! -f "$LOG_READER_MD" ]]; then
  _fail "log-reader.md not found: ${LOG_READER_MD}"
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
  _fail "sre-fixit.md not found: ${SRE_FIXIT_MD}"
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
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="

if (( FAIL > 0 )); then
  exit 1
fi

echo "Smoke test PASSED."
exit 0
