#!/usr/bin/env bash
# push-artifact.sh — shared gdrive-push helper with iOS-mode sentinel awareness
#
# Feature H (GH-1275): iOS remote-control integration
# Plan: thoughts/shared/plans/2026-05-16-GH-1275-ios-remote-integration.md (Phase 3, Task 3.1)
#
# CLI signature:
#   push-artifact.sh <path> [description] [--push-drive | --no-push-drive]
#
# Decision logic (evaluated in this exact order — explicit flags win first):
#   1. If --no-push-drive was passed: SKIP (explicit operator opt-out always wins)
#   2. Else if --push-drive was passed: PUSH (explicit operator opt-in always wins)
#   3. Else if ${TMPDIR:-/tmp}/ralph-ios-mode exists: PUSH (Phase 0 sentinel)
#   4. Else if RALPH_IOS_MODE is non-empty: PUSH (legacy env var manual override)
#   5. Else: SKIP (desk-mode default OFF)
#
# On PUSH: invokes gdrive-push skill via `claude -p`, parses stdout for Drive URL.
# On SKIP or failure: exits 0 with empty stdout (no warning for the expected default-OFF case).
#
# Returns:
#   stdout: Drive URL (one line) on successful push; empty on skip or failure
#   stderr: diagnostic messages (only on failure or RALPH_COS_DEBUG=1)
#   exit:   always 0 (best-effort)

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument parsing — centralized; callers forward flags unparsed
# ---------------------------------------------------------------------------
ARTIFACT_PATH=""
DESCRIPTION=""
PUSH_FLAG=""   # "push" | "no-push" | "" (unset = use sentinel/env logic)

while [[ $# -gt 0 ]]; do
    case "$1" in
        --push-drive)    PUSH_FLAG="push";    shift ;;
        --no-push-drive) PUSH_FLAG="no-push"; shift ;;
        *)
            if [[ -z "$ARTIFACT_PATH" ]]; then
                ARTIFACT_PATH="$1"
            elif [[ -z "$DESCRIPTION" ]]; then
                DESCRIPTION="$1"
            fi
            shift ;;
    esac
done

if [[ -z "$ARTIFACT_PATH" ]]; then
    echo "[push-artifact] ERROR: no path provided" >&2
    exit 0
fi

# ---------------------------------------------------------------------------
# Decision logic (rules 1–5)
# ---------------------------------------------------------------------------
DECISION="skip"
RULE=5

if [[ "$PUSH_FLAG" == "no-push" ]]; then
    DECISION="skip"
    RULE=1
elif [[ "$PUSH_FLAG" == "push" ]]; then
    DECISION="push"
    RULE=2
elif [[ -f "${TMPDIR:-/tmp}/ralph-ios-mode" ]]; then
    DECISION="push"
    RULE=3
elif [[ -n "${RALPH_IOS_MODE:-}" ]]; then
    DECISION="push"
    RULE=4
fi

if [[ "${RALPH_COS_DEBUG:-}" == "1" ]]; then
    echo "[push-artifact] decision=${DECISION} rule=${RULE} path=${ARTIFACT_PATH}" >&2
fi

# ---------------------------------------------------------------------------
# SKIP path — silent exit (no warning; this is the expected desk-mode default)
# ---------------------------------------------------------------------------
if [[ "$DECISION" == "skip" ]]; then
    exit 0
fi

# ---------------------------------------------------------------------------
# PUSH path — invoke gdrive-push skill via claude -p
# ---------------------------------------------------------------------------
GDRIVE_CMD="'/gdrive-push ${ARTIFACT_PATH}'"
if [[ -n "$DESCRIPTION" ]]; then
    GDRIVE_CMD="'/gdrive-push ${ARTIFACT_PATH} \"${DESCRIPTION}\"'"
fi

GDRIVE_OUTPUT=""
rc=0
GDRIVE_OUTPUT=$(claude -p "/gdrive-push ${ARTIFACT_PATH}${DESCRIPTION:+ \"${DESCRIPTION}\"}" 2>&1) || rc=$?

if [[ "$rc" -ne 0 ]]; then
    echo "[push-artifact] gdrive-push failed — artifact still landed locally at ${ARTIFACT_PATH}" >&2
    exit 0
fi

# Parse Drive URL from output (gdrive-push emits https://drive.google.com/file/d/... URLs)
DRIVE_URL=$(printf '%s\n' "$GDRIVE_OUTPUT" | grep -oE 'https://drive\.google\.com/[^ ]+' | head -1 || true)

if [[ -n "$DRIVE_URL" ]]; then
    if [[ "${RALPH_COS_DEBUG:-}" == "1" ]]; then
        echo "[push-artifact] drive_url=${DRIVE_URL}" >&2
    fi
    printf '%s\n' "$DRIVE_URL"
else
    echo "[push-artifact] gdrive-push succeeded but no Drive URL found in output" >&2
fi

exit 0
