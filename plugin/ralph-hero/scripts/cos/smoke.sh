#!/usr/bin/env bash
# smoke.sh — end-to-end smoke test for cos.sh
#
# Requires:
#   - pi on PATH
#   - mlx-openai-server running on localhost:8000 (run `gemma-up` or start-server.sh)
#   - cos.sh in the same directory
#
# NOT run in CI — the MLX server is not available in CI environments.
#
# Usage:
#   bash plugin/ralph-hero/scripts/cos/smoke.sh
#
# Exit codes:
#   0   All checks passed
#   1   MLX server unreachable or smoke assertion failed
#   127 pi not on PATH

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
COS_SH="${SCRIPT_DIR}/cos.sh"
SMOKE_FILE="/tmp/cos-smoke.txt"
TODAY="$(date +%Y-%m-%d)"
RUN_LOG="${HOME}/.ralph-hero/cos/runs/${TODAY}.jsonl"

PASS=0
FAIL=0

_pass() { echo "[PASS] $1"; (( PASS++ )) || true; }
_fail() { echo "[FAIL] $1" >&2; (( FAIL++ )) || true; }

echo "=== cos.sh smoke test ==="
echo ""

# ---------------------------------------------------------------------------
# 1. Assert pi is on PATH
# ---------------------------------------------------------------------------
if ! command -v pi >/dev/null 2>&1; then
    echo "[smoke] ERROR: pi not installed — install @earendil-works/pi-coding-agent" >&2
    exit 127
fi
_pass "pi found at $(command -v pi)"

# ---------------------------------------------------------------------------
# 2. Assert MLX server is reachable
# ---------------------------------------------------------------------------
if ! curl -fsS --max-time 5 http://localhost:8000/v1/models >/dev/null 2>&1; then
    echo "[smoke] ERROR: MLX server not running on localhost:8000" >&2
    echo "[smoke] Start it with: gemma-up  (or cd ~/projects/gemma-lab && ./scripts/start-server.sh)" >&2
    exit 1
fi
_pass "MLX server reachable at http://localhost:8000"

# ---------------------------------------------------------------------------
# 3. Clean up any previous smoke file
# ---------------------------------------------------------------------------
rm -f "$SMOKE_FILE"

# ---------------------------------------------------------------------------
# 4. Invoke cos.sh with a deterministic one-shot prompt
# ---------------------------------------------------------------------------
echo ""
echo "Invoking cos.sh..."
"$COS_SH" "Write the literal string 'cos online' to /tmp/cos-smoke.txt and nothing else. Do not add any extra text or newlines beyond 'cos online'."

# ---------------------------------------------------------------------------
# 5. Assert smoke file was created and contains the expected content
# ---------------------------------------------------------------------------
if [[ -f "$SMOKE_FILE" ]]; then
    CONTENT="$(cat "$SMOKE_FILE" | tr -d '\n' | xargs)"
    if [[ "$CONTENT" == "cos online" ]]; then
        _pass "Smoke file contains 'cos online'"
    else
        _fail "Smoke file exists but content is unexpected: '${CONTENT}'"
    fi
else
    _fail "Smoke file ${SMOKE_FILE} was not created"
fi

# ---------------------------------------------------------------------------
# 6. Assert JSONL run log exists and has a row with exit_code 0
# ---------------------------------------------------------------------------
if [[ -f "$RUN_LOG" ]]; then
    # Check last row (most recent invocation) has exit_code 0
    LAST_ROW="$(tail -1 "$RUN_LOG")"
    if echo "$LAST_ROW" | grep -q '"exit_code":0'; then
        _pass "Run log has exit_code:0 row: ${RUN_LOG}"
    else
        _fail "Run log last row does not have exit_code:0 — check ${RUN_LOG}"
        echo "  Last row: ${LAST_ROW}" >&2
    fi
else
    _fail "Run log not found: ${RUN_LOG}"
fi

# ---------------------------------------------------------------------------
# 7. Five-team rollup assertion (Feature H, GH-1275)
#    Gated on pi + mlx-openai-server being available (already checked above).
#    Asks cos.sh to emit a five-team status rollup and asserts all five section
#    headers appear in the output.
# ---------------------------------------------------------------------------
echo ""
echo "Running five-team rollup assertion..."
ROLLUP_FILE="/tmp/cos-smoke-rollup.txt"
rm -f "$ROLLUP_FILE"

"$COS_SH" --role smol "Output a five-team status rollup with sections for Builders, Watchers, Scouts, Memorykeepers, and Caretakers. Write the output to /tmp/cos-smoke-rollup.txt." || true

if [[ -f "$ROLLUP_FILE" ]]; then
    for section in "Builders" "Watchers" "Scouts" "Memorykeepers" "Caretakers"; do
        if grep -q "$section" "$ROLLUP_FILE"; then
            _pass "Five-team rollup contains '${section}' section"
        else
            _fail "Five-team rollup missing '${section}' section"
        fi
    done
    rm -f "$ROLLUP_FILE"
else
    _fail "Five-team rollup file was not created at ${ROLLUP_FILE}"
fi

# ---------------------------------------------------------------------------
# 8. Clean up
# ---------------------------------------------------------------------------
rm -f "$SMOKE_FILE"

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
