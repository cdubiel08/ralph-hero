#!/usr/bin/env bash
# self-improve-smoke.sh — manual smoke test for self-improve.sh (GH-1258)
#
# Creates a tmpdir with 7 synthetic morning-brief files (deliberately low-quality),
# runs self-improve.sh in dry-run mode, and asserts expected outputs.
#
# This is a LOCAL-ONLY smoke test: it never pushes to origin, never calls gh pr create
# (RALPH_COS_SELF_IMPROVE_DRY_RUN=1 is set automatically by this script).
#
# Prerequisites:
#   - mlx-openai-server running on :8000 (pi + qwen3.5-27b)
#   - pi on PATH
#   - self-improve.sh in the same directory as this script
#   - git in a working repo checkout
#
# Usage:
#   plugin/ralph-hero/scripts/cos/self-improve-smoke.sh [--help|-h]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SELF_IMPROVE="${SCRIPT_DIR}/self-improve.sh"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
_usage() {
    cat <<'EOF'
self-improve-smoke.sh — manual end-to-end smoke test for self-improve.sh

Usage:
  self-improve-smoke.sh [--help|-h]

Creates 7 synthetic low-quality morning brief files in a tmpdir, runs
self-improve.sh with RALPH_COS_SELF_IMPROVE=1 and RALPH_COS_SELF_IMPROVE_DRY_RUN=1,
then asserts expected stdout/stderr output.

Does NOT push to origin or call gh pr create.
Requires: pi on PATH, mlx-openai-server on :8000.
EOF
}

for arg in "$@"; do
    case "$arg" in
        --help|-h)
            _usage
            exit 0
            ;;
        *)
            echo "[smoke] ERROR: Unknown flag: $arg" >&2
            _usage >&2
            exit 2
            ;;
    esac
done

# ---------------------------------------------------------------------------
# Guard: self-improve.sh must exist and be executable
# ---------------------------------------------------------------------------
if [[ ! -x "$SELF_IMPROVE" ]]; then
    echo "[smoke] ERROR: self-improve.sh not found or not executable at: $SELF_IMPROVE" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Create tmpdir; clean up on exit
# ---------------------------------------------------------------------------
SMOKE_TMPDIR="$(mktemp -d)"
trap 'echo "[smoke] Cleaning up tmpdir: ${SMOKE_TMPDIR}"; rm -rf "${SMOKE_TMPDIR}"' EXIT

RESEARCH_DIR="${SMOKE_TMPDIR}/shared/research"
mkdir -p "$RESEARCH_DIR"

echo "[smoke] tmpdir: ${SMOKE_TMPDIR}"
echo "[smoke] Writing 7 synthetic low-quality morning briefs..."

# ---------------------------------------------------------------------------
# Write 7 synthetic briefs with deliberately low-quality content
# (vague, no #NNN refs, no file paths, repetitive, long)
# ---------------------------------------------------------------------------
for i in $(seq 1 7); do
    BRIEF_DATE="$(date -v-"${i}d" +%F 2>/dev/null || date -d "-${i} days" +%F 2>/dev/null || echo "2026-05-0${i}")"
    BRIEF_FILE="${RESEARCH_DIR}/${BRIEF_DATE}-cos-morning-brief.md"

    cat > "$BRIEF_FILE" <<EOF
# Morning Brief — ${BRIEF_DATE}

Here is a summary of what is happening with the project today. Things are generally moving forward. Some issues are in progress and some are waiting for review.

There are several items that need attention. The team should look into the issues that are open and make sure everything is on track. It would be good to check in on the current work items.

Some things were completed recently and other things are still pending. The overall status is okay but there is room for improvement in various areas. Moving forward we should continue to make progress on the open items.

The pipeline looks reasonable. No major blockers at this time though some tasks could use more attention. The team is working on various things and progress is being made.

In summary, things are progressing but there is work to be done. Stay focused and keep moving forward with the current priorities.
EOF

    echo "[smoke]   Wrote: $(basename "$BRIEF_FILE")"
done

# ---------------------------------------------------------------------------
# Run self-improve.sh with dry-run flag
# ---------------------------------------------------------------------------
STDOUT_LOG="${SMOKE_TMPDIR}/stdout.log"
STDERR_LOG="${SMOKE_TMPDIR}/stderr.log"

echo "[smoke] Running self-improve.sh (RALPH_COS_SELF_IMPROVE=1 RALPH_COS_SELF_IMPROVE_DRY_RUN=1)..."
echo "[smoke] (This invokes cos.sh --role slow 7+ times — expect it to take several minutes)"

IMPROVE_EXIT=0
RALPH_COS_SELF_IMPROVE=1 \
RALPH_COS_SELF_IMPROVE_DRY_RUN=1 \
RALPH_COS_THOUGHTS_DIR="${SMOKE_TMPDIR}" \
    "$SELF_IMPROVE" > "$STDOUT_LOG" 2> "$STDERR_LOG" || IMPROVE_EXIT=$?

echo "[smoke] self-improve.sh exited with code: ${IMPROVE_EXIT}"

# ---------------------------------------------------------------------------
# Display outputs
# ---------------------------------------------------------------------------
echo ""
echo "=== stdout ==="
cat "$STDOUT_LOG"

echo ""
echo "=== stderr ==="
cat "$STDERR_LOG"
echo ""

# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------
PASS=1

# 1. stdout must contain the markdown table header
if grep -qF "| Date | Brief |" "$STDOUT_LOG"; then
    echo "[smoke] PASS: stdout contains markdown table header"
else
    echo "[smoke] FAIL: stdout does not contain '| Date | Brief |'" >&2
    PASS=0
fi

# 2. stderr must mention the mean
if grep -qE "mean [0-9]+\.[0-9]+" "$STDERR_LOG"; then
    echo "[smoke] PASS: stderr contains mean line"
else
    echo "[smoke] FAIL: stderr does not contain a 'mean X.XX' line" >&2
    PASS=0
fi

# 3. self-improve.sh must exit 0
if [[ $IMPROVE_EXIT -eq 0 ]]; then
    echo "[smoke] PASS: self-improve.sh exited 0"
else
    echo "[smoke] FAIL: self-improve.sh exited ${IMPROVE_EXIT} (expected 0)" >&2
    PASS=0
fi

# 4. Determine which path fired
BRANCH_DATE="$(date -u +%F)"
BRANCH_NAME="cos-self-improvement/${BRANCH_DATE}"

if grep -qF "DRY RUN: skipping git push" "$STDERR_LOG"; then
    echo "[smoke] Path: mean < 3.5 — draft prompt + branch created (dry-run skipped push/PR)"
    # Verify the branch was created locally
    REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd -P)"
    if git -C "$REPO_ROOT" rev-parse --verify "$BRANCH_NAME" >/dev/null 2>&1; then
        echo "[smoke] PASS: local branch '${BRANCH_NAME}' was created"
        # Clean up the local branch
        git -C "$REPO_ROOT" checkout main 2>/dev/null || git -C "$REPO_ROOT" checkout - 2>/dev/null || true
        git -C "$REPO_ROOT" branch -D "$BRANCH_NAME" 2>/dev/null || true
        echo "[smoke] Cleaned up local branch: ${BRANCH_NAME}"
    else
        echo "[smoke] FAIL: local branch '${BRANCH_NAME}' was NOT created" >&2
        PASS=0
    fi
    echo "[smoke] Smoke test passed: low-quality briefs triggered draft prompt revision (branch cleaned up)"
elif grep -qF ">= 3.5; no revision needed" "$STDERR_LOG"; then
    MEAN_LINE="$(grep -oE "mean [0-9]+\.[0-9]+" "$STDERR_LOG" | head -1)"
    echo "[smoke] Path: mean >= 3.5 — no revision triggered"
    echo "[smoke] Smoke test passed: graded briefs but threshold not crossed (${MEAN_LINE})"
elif grep -qF "insufficient briefs" "$STDERR_LOG"; then
    echo "[smoke] FAIL: insufficient briefs detected (synthetic briefs may not have been found)" >&2
    PASS=0
elif grep -qF "too many parse failures" "$STDERR_LOG"; then
    echo "[smoke] WARNING: too many parse failures — grader may be unavailable (mlx-openai-server running?)" >&2
    # Not a hard failure for the smoke test — this can happen if the server is down
    PASS=0
else
    echo "[smoke] FAIL: unexpected stderr output (no recognizable path taken)" >&2
    PASS=0
fi

# ---------------------------------------------------------------------------
# Final result
# ---------------------------------------------------------------------------
echo ""
if [[ $PASS -eq 1 ]]; then
    echo "[smoke] ALL ASSERTIONS PASSED"
    exit 0
else
    echo "[smoke] SOME ASSERTIONS FAILED — review output above" >&2
    exit 1
fi
