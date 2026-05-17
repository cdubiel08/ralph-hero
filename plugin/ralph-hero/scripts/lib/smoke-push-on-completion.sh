#!/usr/bin/env bash
# smoke-push-on-completion.sh — graceful-degradation smoke for push-on-completion.sh
#
# Feature H (GH-1275): iOS remote-control integration
# Plan: thoughts/shared/plans/2026-05-16-GH-1275-ios-remote-integration.md (Phase 2, Task 2.3)
#
# Tests the two graceful-degradation paths WITHOUT needing a real ntfy topic or binary:
#   1. RALPH_COS_NTFY_TOPIC unset → exits 0 + stderr contains "skipped"
#   2. RALPH_COS_NTFY_TOPIC=fake-topic + ntfy not on PATH → exits 0 + stderr contains "not installed"
#
# Does NOT test a live ntfy push — that requires a real topic and phone.
#
# Usage:
#   bash plugin/ralph-hero/scripts/lib/smoke-push-on-completion.sh
#
# Exit codes:
#   0   All checks passed
#   1   One or more checks failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
HELPER="${SCRIPT_DIR}/push-on-completion.sh"

PASS=0
FAIL=0

_pass() { echo "[PASS] $1"; (( PASS++ )) || true; }
_fail() { echo "[FAIL] $1" >&2; (( FAIL++ )) || true; }

echo "=== push-on-completion.sh smoke test ==="
echo ""

# ---------------------------------------------------------------------------
# 1. Syntax check
# ---------------------------------------------------------------------------
if bash -n "$HELPER" 2>/dev/null; then
    _pass "push-on-completion.sh: no syntax errors"
else
    _fail "push-on-completion.sh: syntax error"
fi

# ---------------------------------------------------------------------------
# 2. Graceful degradation: RALPH_COS_NTFY_TOPIC unset → exit 0 + "skipped"
# ---------------------------------------------------------------------------
stderr_out=$(RALPH_COS_NTFY_TOPIC= bash "$HELPER" "test message" "https://example.com" 2>&1) && rc=0 || rc=$?
if [[ "$rc" -eq 0 ]]; then
    _pass "Unset topic: exits 0"
else
    _fail "Unset topic: expected exit 0, got ${rc}"
fi
if echo "$stderr_out" | grep -q "skipped"; then
    _pass "Unset topic: stderr contains 'skipped'"
else
    _fail "Unset topic: stderr missing 'skipped' (got: ${stderr_out})"
fi

# ---------------------------------------------------------------------------
# 3. Graceful degradation: topic set + ntfy not on PATH → exit 0 + "not installed"
# ---------------------------------------------------------------------------
stderr_out=$(RALPH_COS_NTFY_TOPIC=fake-topic PATH=/usr/bin:/bin bash "$HELPER" "test message" "https://example.com" 2>&1) && rc=0 || rc=$?
if [[ "$rc" -eq 0 ]]; then
    _pass "ntfy off PATH: exits 0"
else
    _fail "ntfy off PATH: expected exit 0, got ${rc}"
fi
if echo "$stderr_out" | grep -q "not installed"; then
    _pass "ntfy off PATH: stderr contains 'not installed'"
else
    _fail "ntfy off PATH: stderr missing 'not installed' (got: ${stderr_out})"
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
