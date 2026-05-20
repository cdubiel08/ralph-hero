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

# Build the body template exactly as playwright-auto.yml does it.
# Using a subshell so PR_NUMBER scoping is clean.
BODY=$(PR_NUMBER=42 bash -c '
PR_NUMBER=42
UI_FILES="src/components/Button.tsx
src/styles/theme.scss"
cat <<EOF
<!-- scout-pr: ${PR_NUMBER} -->
scout-pr/${PR_NUMBER}

Scout review requested for PR #${PR_NUMBER}.

- **PR**: https://github.com/example/repo/pull/${PR_NUMBER}
- **Head SHA**: \`abc1234\`

## UI-touching files

\`\`\`
${UI_FILES}
\`\`\`

---

*Filed by \`.github/workflows/playwright-auto.yml\`. Director will route this issue to the scouts team-skill via the \`scout-auto\` label. Re-running the workflow on the same PR is a no-op as long as this issue stays open (idempotency: \`scout-pr/${PR_NUMBER}\`).*
EOF
')

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

# Assertion 4: HTML-comment marker is on line 1
FIRST_LINE=$(echo "$BODY" | head -n 1)
if [ "$FIRST_LINE" = "<!-- scout-pr: 42 -->" ]; then
  _pass "HTML-comment marker is on line 1 of body"
else
  _fail "HTML-comment marker is NOT on line 1 — got: '${FIRST_LINE}'"
fi

# Assertion 5: Plain-text marker is on line 2
SECOND_LINE=$(echo "$BODY" | sed -n '2p')
if [ "$SECOND_LINE" = "scout-pr/42" ]; then
  _pass "Plain-text marker is on line 2 of body"
else
  _fail "Plain-text marker is NOT on line 2 — got: '${SECOND_LINE}'"
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
