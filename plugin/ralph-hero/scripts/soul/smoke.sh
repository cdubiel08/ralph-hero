#!/usr/bin/env bash
# smoke.sh — contract gate for the SOUL framework SessionStart hook
#
# Verifies that load-team-soul.sh:
#   - Exits 0 silently (no stdout) when RALPH_COMMAND is unset or has no SOUL
#   - Emits a valid JSON envelope ({ hookSpecificOutput: { hookEventName, additionalContext } })
#     when RALPH_COMMAND matches a team with a SOUL file
#   - additionalContext contains the correct team: <plural-name> for each skill directory
#   - hero/SOUL.md body headings (## How you talk, ## Bad / Good) survive the envelope
#   - RALPH_SOUL_LOADED=<team> is appended to $CLAUDE_ENV_FILE when SOUL is loaded
#
# Skill-dir → team frontmatter mapping (asserted by Tests C1–C5):
#   hero/         → team: builders
#   watch/        → team: watchers
#   scouts/       → team: scouts
#   memorykeepers/→ team: memorykeepers
#   caretake/     → team: caretakers
#
# Raw substring matches against unparsed stdout are intentionally absent from
# Tests C. They would pass on a broken raw-cat implementation and mask the
# regression this smoke exists to prevent.
#
# Usage:
#   bash plugin/ralph-hero/scripts/soul/smoke.sh
#
# Exit codes:
#   0   All checks passed
#   1   One or more checks failed
#
# Invoke manually — this smoke runs without external services (no network, no MLX).
# To run from the repo root: bash plugin/ralph-hero/scripts/soul/smoke.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
HOOK="${PLUGIN_ROOT}/hooks/scripts/load-team-soul.sh"

PASS=0
FAIL=0

_pass() { echo "[PASS] $1"; (( PASS++ )) || true; }
_fail() { echo "[FAIL] $1" >&2; (( FAIL++ )) || true; }

echo "=== soul smoke test ==="
echo ""

# ---------------------------------------------------------------------------
# Preflight: jq required
# ---------------------------------------------------------------------------
if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke] ERROR: jq not found on PATH — install jq before running this smoke" >&2
  exit 1
fi
_pass "jq found at $(command -v jq)"

# ---------------------------------------------------------------------------
# Preflight: hook script exists and is executable
# ---------------------------------------------------------------------------
if [[ ! -x "$HOOK" ]]; then
  echo "[smoke] ERROR: hook not executable or missing: $HOOK" >&2
  exit 1
fi
_pass "hook executable: $HOOK"

# ---------------------------------------------------------------------------
# Test A: RALPH_COMMAND unset — silent exit 0, no stdout
# ---------------------------------------------------------------------------
echo ""
echo "--- Test A: RALPH_COMMAND unset ---"
OUT_A=$(env -u RALPH_COMMAND CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$HOOK" 2>/dev/null)
CODE_A=$?
if [[ $CODE_A -eq 0 && -z "$OUT_A" ]]; then
  _pass "Test A: exit 0, empty stdout when RALPH_COMMAND unset"
else
  _fail "Test A: expected exit 0 + empty stdout; got exit=$CODE_A stdout='$OUT_A'"
fi

# ---------------------------------------------------------------------------
# Test B: RALPH_COMMAND set to nonexistent skill — silent exit 0, no stdout
# ---------------------------------------------------------------------------
echo ""
echo "--- Test B: RALPH_COMMAND=nonexistent-soul-skill ---"
OUT_B=$(RALPH_COMMAND=nonexistent-soul-skill CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$HOOK" 2>/dev/null)
CODE_B=$?
if [[ $CODE_B -eq 0 && -z "$OUT_B" ]]; then
  _pass "Test B: exit 0, empty stdout when SOUL file missing"
else
  _fail "Test B: expected exit 0 + empty stdout; got exit=$CODE_B stdout='$OUT_B'"
fi

# ---------------------------------------------------------------------------
# Tests C1–C5: JSON envelope assertions per team
# Assertions use jq directly from a tempfile — NO raw substring matches.
# ---------------------------------------------------------------------------
echo ""
echo "--- Tests C1–C5: JSON envelope per team ---"

# Mapping: skill-dir → expected team: value in SOUL frontmatter
# Uses a case statement instead of associative arrays for bash 3.2 compat (macOS).
_team_for_cmd() {
  case "$1" in
    hero)          echo "builders"      ;;
    watch)         echo "watchers"      ;;
    scouts)        echo "scouts"        ;;
    memorykeepers) echo "memorykeepers" ;;
    caretake)      echo "caretakers"    ;;
    *)             echo "unknown"       ;;
  esac
}

# Use a tempfile for hook output — avoids $() shell variable corruption of
# multi-line JSON with embedded newlines and control characters.
OUT_TMP=$(mktemp)
trap 'rm -f "$OUT_TMP"' EXIT

for cmd in hero watch scouts memorykeepers caretake; do
  expected_team="$(_team_for_cmd "$cmd")"
  echo ""
  echo "  C: RALPH_COMMAND=$cmd (expect team: $expected_team)"

  # Capture hook stdout to tempfile; use || idiom so set -e does not fire on non-zero exit
  hook_exit=0
  RALPH_COMMAND="$cmd" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$HOOK" >"$OUT_TMP" 2>/dev/null || hook_exit=$?

  # (a) exit 0
  if [[ $hook_exit -ne 0 ]]; then
    _fail "Test C ($cmd): hook exited $hook_exit (expected 0)"
    continue
  fi

  # (b) stdout parses as JSON
  if ! jq -e '.' "$OUT_TMP" >/dev/null 2>&1; then
    _fail "Test C ($cmd): stdout is not valid JSON"
    continue
  fi

  # (c) .hookSpecificOutput.hookEventName == "SessionStart"
  if ! jq -e '.hookSpecificOutput.hookEventName == "SessionStart"' "$OUT_TMP" >/dev/null 2>&1; then
    actual_name=$(jq -r '.hookSpecificOutput.hookEventName // "missing"' "$OUT_TMP" 2>/dev/null || echo "parse-error")
    _fail "Test C ($cmd): hookEventName='$actual_name' (expected 'SessionStart')"
    continue
  fi

  # (d) .hookSpecificOutput.additionalContext contains "team: <expected>"
  # This assertion uses jq -r to unwrap, then grep — NOT raw substring match on unparsed JSON.
  if ! jq -r '.hookSpecificOutput.additionalContext' "$OUT_TMP" 2>/dev/null | grep -q "team: ${expected_team}"; then
    actual_team=$(jq -r '.hookSpecificOutput.additionalContext' "$OUT_TMP" 2>/dev/null | grep '^team:' | head -1 || echo "not-found")
    _fail "Test C ($cmd): additionalContext has '$actual_team' (expected 'team: $expected_team')"
    continue
  fi

  _pass "Test C ($cmd): JSON envelope valid, hookEventName=SessionStart, team=$expected_team"
done

# ---------------------------------------------------------------------------
# Test D: hero body headings present in additionalContext
# ---------------------------------------------------------------------------
echo ""
echo "--- Test D: hero/SOUL.md body headings in additionalContext ---"

hook_exit_d=0
RALPH_COMMAND=hero CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$HOOK" >"$OUT_TMP" 2>/dev/null || hook_exit_d=$?
if [[ $hook_exit_d -ne 0 ]]; then
  _fail "Test D: hook exited $hook_exit_d (expected 0)"
fi

ctx=$(jq -r '.hookSpecificOutput.additionalContext' "$OUT_TMP" 2>/dev/null)

if echo "$ctx" | grep -q '^## How you talk'; then
  _pass "Test D: '## How you talk' heading present in hero additionalContext"
else
  _fail "Test D: '## How you talk' heading missing from hero additionalContext"
fi

if echo "$ctx" | grep -q '^## Bad / Good'; then
  _pass "Test D: '## Bad / Good' heading present in hero additionalContext"
else
  _fail "Test D: '## Bad / Good' heading missing from hero additionalContext"
fi

# ---------------------------------------------------------------------------
# Test E: CLAUDE_ENV_FILE side effect — RALPH_SOUL_LOADED=hero written
# Uses a separate tempfile; trap guarantees cleanup even on assertion failure.
# ---------------------------------------------------------------------------
echo ""
echo "--- Test E: CLAUDE_ENV_FILE side effect ---"

ENV_TMP=$(mktemp)
# Update trap to clean both tempfiles
trap 'rm -f "$OUT_TMP" "$ENV_TMP"' EXIT

hook_exit_e=0
RALPH_COMMAND=hero CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_ENV_FILE="$ENV_TMP" bash "$HOOK" >/dev/null 2>/dev/null || hook_exit_e=$?
if [[ $hook_exit_e -ne 0 ]]; then
  _fail "Test E: hook exited $hook_exit_e (expected 0)"
fi

if grep -q 'export RALPH_SOUL_LOADED=hero' "$ENV_TMP"; then
  _pass "Test E: 'export RALPH_SOUL_LOADED=hero' written to CLAUDE_ENV_FILE"
else
  actual=$(cat "$ENV_TMP" 2>/dev/null || echo "(empty)")
  _fail "Test E: CLAUDE_ENV_FILE contents: '$actual' (expected 'export RALPH_SOUL_LOADED=hero')"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== smoke: PASS=${PASS} FAIL=${FAIL} ==="

if (( FAIL > 0 )); then
  exit 1
fi

exit 0
