#!/usr/bin/env bash
# smoke.sh — static + dry-run assertions for the monitoring-bridge subscriber
#
# Checks:
#   1. subscribe.py exists and is syntactically valid Python
#   2. fixtures/sample-alert.json exists and parses as JSON
#   3. pyproject.toml exists and contains google-cloud-pubsub dependency
#   4. launchd plist template is well-formed (plutil -lint)
#   5. Dry-run mode: runs subscribe.py --dry-run and asserts required tokens
#      present in stdout:
#        - watcher-auto
#        - <!-- gcp-policy:
#        - [gcp-alert]
#        - ## Source
#        - ## Suggested Team: watchers
#
# Usage (from repo root):
#   bash plugin/ralph-hero/scripts/monitoring-bridge/smoke.sh
#
# Exit codes:
#   0   All checks passed
#   1   One or more assertions failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

PASS=0
FAIL=0

_pass() { echo "[PASS] $1"; (( PASS++ )) || true; }
_fail() { echo "[FAIL] $1" >&2; (( FAIL++ )) || true; }

echo "=== monitoring-bridge smoke test ==="
echo ""

# ---------------------------------------------------------------------------
# 1. subscribe.py exists and parses as valid Python
# ---------------------------------------------------------------------------
SUBSCRIBE_PY="${SCRIPT_DIR}/subscribe.py"
if [[ ! -f "$SUBSCRIBE_PY" ]]; then
    _fail "subscribe.py not found: ${SUBSCRIBE_PY}"
else
    if python3 -c "import ast; ast.parse(open('${SUBSCRIBE_PY}').read())" 2>/dev/null; then
        _pass "subscribe.py is syntactically valid Python"
    else
        _fail "subscribe.py has syntax errors"
    fi
fi

# ---------------------------------------------------------------------------
# 2. fixtures/sample-alert.json exists and parses as JSON
# ---------------------------------------------------------------------------
FIXTURE="${SCRIPT_DIR}/fixtures/sample-alert.json"
if [[ ! -f "$FIXTURE" ]]; then
    _fail "fixtures/sample-alert.json not found: ${FIXTURE}"
else
    if python3 -c "import json; json.load(open('${FIXTURE}'))" 2>/dev/null; then
        _pass "fixtures/sample-alert.json is valid JSON"
    else
        _fail "fixtures/sample-alert.json is invalid JSON"
    fi
fi

# ---------------------------------------------------------------------------
# 3. pyproject.toml contains google-cloud-pubsub dependency
# ---------------------------------------------------------------------------
PYPROJECT="${SCRIPT_DIR}/pyproject.toml"
if [[ ! -f "$PYPROJECT" ]]; then
    _fail "pyproject.toml not found: ${PYPROJECT}"
else
    if grep -q "google-cloud-pubsub" "$PYPROJECT"; then
        _pass "pyproject.toml declares google-cloud-pubsub dependency"
    else
        _fail "pyproject.toml missing google-cloud-pubsub dependency"
    fi
fi

# ---------------------------------------------------------------------------
# 4. launchd plist template is well-formed
# ---------------------------------------------------------------------------
PLIST="${SCRIPT_DIR}/launchd/com.ralph.monitoring-bridge.plist.template"
if [[ ! -f "$PLIST" ]]; then
    _fail "launchd plist template not found: ${PLIST}"
else
    if plutil -lint "$PLIST" >/dev/null 2>&1; then
        _pass "launchd plist template is well-formed (plutil -lint)"
    else
        _fail "launchd plist template is malformed (plutil -lint failed)"
    fi
fi

# ---------------------------------------------------------------------------
# 5. Dry-run mode: subscribe.py --dry-run emits expected tokens
# ---------------------------------------------------------------------------
if [[ -f "$SUBSCRIBE_PY" && -f "$FIXTURE" ]]; then
    # Run dry-run directly with python3 (no uv sync required for dry-run path
    # since google-cloud-pubsub is NOT imported in --dry-run mode)
    DRY_RUN_OUTPUT=$(
        cd "$SCRIPT_DIR" &&
        python3 subscribe.py \
            --dry-run \
            --subscription dummy \
            --project dummy \
            --max-messages 1 \
            2>/dev/null
    ) || {
        _fail "subscribe.py --dry-run exited non-zero"
        DRY_RUN_OUTPUT=""
    }

    if [[ -n "$DRY_RUN_OUTPUT" ]]; then
        REQUIRED_TOKENS=(
            "watcher-auto"
            "<!-- gcp-policy:"
            "[gcp-alert]"
            "## Source"
            "## Suggested Team: watchers"
        )
        ALL_PRESENT=true
        for token in "${REQUIRED_TOKENS[@]}"; do
            if echo "$DRY_RUN_OUTPUT" | grep -qF "$token"; then
                _pass "dry-run output contains: ${token}"
            else
                _fail "dry-run output MISSING: ${token}"
                ALL_PRESENT=false
            fi
        done

        if [[ "$ALL_PRESENT" == "true" ]]; then
            _pass "dry-run output contains all required tokens"
        fi
    fi
else
    _fail "Skipping dry-run assertion (subscribe.py or fixture missing)"
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
