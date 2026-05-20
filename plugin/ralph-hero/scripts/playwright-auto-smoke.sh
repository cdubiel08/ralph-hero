#!/usr/bin/env bash
# playwright-auto-smoke.sh — smoke test for the bash logic embedded in playwright-auto.yml
#
# Purpose:
#   Validates the embedded bash logic in .github/workflows/playwright-auto.yml in
#   isolation, without invoking GitHub (no gh CLI, no git, no network calls). Tests
#   include: heuristic sourcing, heuristic match/no-match assertions, and marker
#   construction (both HTML-comment form and plain-text form, on the correct lines).
#
# Invocation:
#   bash plugin/ralph-hero/scripts/playwright-auto-smoke.sh
#
# Exit codes:
#   0   All assertions passed
#   1   One or more assertions failed
#
# Mirrors the shape of plugin/ralph-hero/scripts/scout-heuristic-smoke.sh (PASS/FAIL
# counters, _pass/_fail helpers, section headers, and final summary line).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PASS=0
FAIL=0

_pass() { echo "[PASS] $1"; (( PASS++ )) || true; }
_fail() { echo "[FAIL] $1" >&2; (( FAIL++ )) || true; }

echo "=== playwright-auto smoke test ==="
echo ""

# ---------------------------------------------------------------------------
# Section 1: Heuristic sourcing
# ---------------------------------------------------------------------------
echo "--- Heuristic sourcing ---"

source "${SCRIPT_DIR}/shared/ui-heuristic.sh"

if declare -F is_ui_touching >/dev/null 2>&1; then
  _pass "is_ui_touching function defined after source"
else
  _fail "is_ui_touching function NOT defined after source"
fi

# ---------------------------------------------------------------------------
# Section 2: Heuristic match / no-match assertions
# ---------------------------------------------------------------------------
echo ""
echo "--- Heuristic assertions ---"

# Assertion 1: UI-touching file returns 0 (match)
if is_ui_touching "src/components/Button.tsx"; then
  _pass "is_ui_touching returns 0 for UI file (src/components/Button.tsx)"
else
  _fail "is_ui_touching returned 1 for UI file (src/components/Button.tsx) — expected MATCH"
fi

# Assertion 2: Non-UI file returns 1 (no match)
if ! is_ui_touching "README.md"; then
  _pass "is_ui_touching returns 1 for README.md — NO_MATCH (expected)"
else
  _fail "is_ui_touching returned 0 for README.md — expected NO_MATCH"
fi

# ---------------------------------------------------------------------------
# Section 3: Marker construction assertions
# ---------------------------------------------------------------------------
echo ""
echo "--- Marker construction ---"

# Build the body exactly as playwright-auto.yml does it (printf, no heredoc indentation).
PR_NUMBER_TEST=42
PR_URL_TEST="https://github.com/example/repo/pull/42"
HEAD_SHA_TEST="abc1234"
UI_FILES_TEST="src/components/Button.tsx
src/styles/theme.scss"

BODY=$(printf '<!-- scout-pr: %s -->\nscout-pr/%s\n\nScout review requested for PR #%s.\n\n- **PR**: %s\n- **Head SHA**: `%s`\n\n## UI-touching files\n\n```\n%s\n```\n\n---\n\n*Filed by `.github/workflows/playwright-auto.yml`. Director will route this issue to the scouts team-skill via the `scout-auto` label. Re-running the workflow on the same PR is a no-op as long as this issue stays open (idempotency: `scout-pr/%s`).*' \
  "${PR_NUMBER_TEST}" "${PR_NUMBER_TEST}" "${PR_NUMBER_TEST}" "${PR_URL_TEST}" "${HEAD_SHA_TEST}" "${UI_FILES_TEST}" "${PR_NUMBER_TEST}")

# Assertion 3: Both marker forms appear in the body
if echo "$BODY" | grep -qF "<!-- scout-pr: 42 -->"; then
  _pass "HTML-comment marker '<!-- scout-pr: 42 -->' present in body"
else
  _fail "HTML-comment marker '<!-- scout-pr: 42 -->' NOT found in body"
fi

if echo "$BODY" | grep -qF "scout-pr/42"; then
  _pass "Plain-text marker 'scout-pr/42' present in body"
else
  _fail "Plain-text marker 'scout-pr/42' NOT found in body"
fi

# Assertion 4: HTML-comment marker is on line 1 with NO leading whitespace
FIRST_LINE=$(echo "$BODY" | head -n 1)
if [ "$FIRST_LINE" = "<!-- scout-pr: 42 -->" ]; then
  _pass "HTML-comment marker is on line 1 of body (no leading whitespace)"
else
  _fail "HTML-comment marker is NOT on line 1 or has leading whitespace — got: '${FIRST_LINE}'"
fi

# Assertion 5: Body line 1 has no leading whitespace (belt-and-suspenders check)
if echo "$FIRST_LINE" | grep -qE '^[[:space:]]'; then
  _fail "Body line 1 has leading whitespace — got: '${FIRST_LINE}'"
else
  _pass "Body line 1 has no leading whitespace"
fi

# Assertion 6: Plain-text marker is on line 2
SECOND_LINE=$(echo "$BODY" | sed -n '2p')
if [ "$SECOND_LINE" = "scout-pr/42" ]; then
  _pass "Plain-text marker is on line 2 of body"
else
  _fail "Plain-text marker is NOT on line 2 — got: '${SECOND_LINE}'"
fi

# ---------------------------------------------------------------------------
# Section 4: Workflow file structural assertions
# ---------------------------------------------------------------------------
echo ""
echo "--- Workflow file structure ---"

WORKFLOW_FILE="${SCRIPT_DIR}/../../../.github/workflows/playwright-auto.yml"

if [ -f "$WORKFLOW_FILE" ]; then
  # Assertion 7: No inline regex in workflow — the pattern must only live in the shared helper
  # grep -F for literal string search avoids ERE parentheses issues; matches the tsx|svelte|vue pattern fragment
  INLINE_REGEX_COUNT=$(grep -cF 'tsx|svelte|vue' "$WORKFLOW_FILE" || true)
  if [ "$INLINE_REGEX_COUNT" -eq 0 ]; then
    _pass "No inline UI regex in playwright-auto.yml (shared helper is sole source of truth)"
  else
    _fail "Inline UI regex found in playwright-auto.yml (${INLINE_REGEX_COUNT} match(es)) — must use is_ui_touching only"
  fi
else
  _fail "Cannot verify workflow structure: $WORKFLOW_FILE not found"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== playwright-auto-smoke: PASS=${PASS} FAIL=${FAIL} ==="

if (( FAIL > 0 )); then
  exit 1
fi

echo "Smoke test PASSED."
exit 0
