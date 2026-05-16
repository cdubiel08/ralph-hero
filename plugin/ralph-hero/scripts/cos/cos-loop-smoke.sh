#!/usr/bin/env bash
# cos-loop-smoke.sh — end-to-end smoke verification for cos-loop.sh
#
# Manual-only: requires pi on PATH and mlx-openai-server running on :8000.
# Start the MLX server with: gemma-up
# (or: cd ~/projects/gemma-lab && ./scripts/start-server.sh)
#
# Usage:
#   bash plugin/ralph-hero/scripts/cos/cos-loop-smoke.sh
#
# Exits 0 on full success, non-zero with a clear stderr message otherwise.
# Run logs are preserved — the JSONL rows written are valid history.
#
# This script does NOT run in CI (CI has no MLX server).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
COS_LOOP="${SCRIPT_DIR}/cos-loop.sh"
RUNS_DIR="${HOME}/.ralph-hero/cos/runs"
TODAY="$(date +%Y-%m-%d)"
RUN_LOG="${RUNS_DIR}/${TODAY}.jsonl"

_fail() {
    echo "[cos-loop-smoke] FAIL: $*" >&2
    exit 1
}

_pass() {
    echo "[cos-loop-smoke] PASS: $*"
}

# ---------------------------------------------------------------------------
# 0. Guard: cos-loop.sh must exist and be executable
# ---------------------------------------------------------------------------
if [[ ! -x "$COS_LOOP" ]]; then
    _fail "cos-loop.sh not found or not executable at ${COS_LOOP}"
fi

# ---------------------------------------------------------------------------
# 1. Guard: pi must be on PATH
# ---------------------------------------------------------------------------
if ! command -v pi >/dev/null 2>&1; then
    echo "[cos-loop-smoke] pi not installed — install @earendil-works/pi-coding-agent" >&2
    exit 127
fi
_pass "pi is on PATH"

# ---------------------------------------------------------------------------
# 2. Guard: MLX server must be reachable
# ---------------------------------------------------------------------------
if ! curl -fsS http://localhost:8000/v1/models >/dev/null 2>&1; then
    echo "[cos-loop-smoke] MLX server not running — run 'gemma-up' and retry" >&2
    exit 1
fi
_pass "MLX server reachable at :8000"

# ---------------------------------------------------------------------------
# 3. cos-loop.sh --help exits 0
# ---------------------------------------------------------------------------
bash "$COS_LOOP" --help >/dev/null
_pass "cos-loop.sh --help exits 0"

# ---------------------------------------------------------------------------
# 4. Count mode: 3 iterations → exactly 3 new JSONL rows
# ---------------------------------------------------------------------------
mkdir -p "$RUNS_DIR"
BEFORE=$(wc -l < "$RUN_LOG" 2>/dev/null || echo 0)
BEFORE=$(echo "$BEFORE" | tr -d ' ')

echo "[cos-loop-smoke] running count mode: 3 iterations..."
bash "$COS_LOOP" 3 "Echo the literal string 'cos-loop iteration ok' and exit"
COUNT_EXIT=$?
if [[ $COUNT_EXIT -ne 0 ]]; then
    _fail "cos-loop.sh exited ${COUNT_EXIT} (expected 0)"
fi

AFTER=$(wc -l < "$RUN_LOG" 2>/dev/null || echo 0)
AFTER=$(echo "$AFTER" | tr -d ' ')
DELTA=$(( AFTER - BEFORE ))
if [[ $DELTA -ne 3 ]]; then
    _fail "count mode: expected 3 new JSONL rows, got ${DELTA} (before=${BEFORE} after=${AFTER})"
fi
_pass "count mode: 3 iterations produced exactly 3 JSONL rows"

# ---------------------------------------------------------------------------
# 5. Duration mode: 5s → exits 0 within 5–15 s, at least 1 JSONL row
# ---------------------------------------------------------------------------
BEFORE2=$(wc -l < "$RUN_LOG" 2>/dev/null || echo 0)
BEFORE2=$(echo "$BEFORE2" | tr -d ' ')

T_START="$(date +%s)"
echo "[cos-loop-smoke] running duration mode: 5s..."
bash "$COS_LOOP" 5s "Echo a single word and exit"
DUR_EXIT=$?
T_END="$(date +%s)"
ELAPSED=$(( T_END - T_START ))

if [[ $DUR_EXIT -ne 0 ]]; then
    _fail "duration mode: cos-loop.sh exited ${DUR_EXIT} (expected 0)"
fi
if [[ $ELAPSED -gt 30 ]]; then
    _fail "duration mode: took ${ELAPSED}s (expected <= 30s)"
fi
_pass "duration mode: completed in ${ELAPSED}s"

AFTER2=$(wc -l < "$RUN_LOG" 2>/dev/null || echo 0)
AFTER2=$(echo "$AFTER2" | tr -d ' ')
DELTA2=$(( AFTER2 - BEFORE2 ))
if [[ $DELTA2 -lt 1 ]]; then
    _fail "duration mode: expected at least 1 new JSONL row, got ${DELTA2}"
fi
_pass "duration mode: produced ${DELTA2} JSONL row(s)"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "[cos-loop-smoke] All checks passed."
exit 0
