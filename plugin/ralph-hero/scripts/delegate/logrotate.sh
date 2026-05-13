#!/usr/bin/env bash
# logrotate.sh — size-based rotation for the ralph-delegate JSONL audit log.
#
# Unlike the activity log (which is date-partitioned across YYYY/MM/DD.jsonl
# files), the delegate audit log is a single ever-growing file. We rotate it
# by size: when delegate.log exceeds the threshold, shift .N -> .N+1
# (dropping the oldest beyond KEEP), rename delegate.log -> delegate.log.1,
# and touch a fresh empty delegate.log.
#
# Usage:
#   logrotate.sh              # rotate if over threshold, else no-op
#   logrotate.sh --dry-run    # print what would happen, do nothing
#   logrotate.sh --help       # this message
#
# Env:
#   RALPH_DELEGATE_LOG_PATH         — log path (default: ~/.ralph-hero/delegate.log)
#   RALPH_DELEGATE_LOG_ROTATE_BYTES — rotation threshold (default: 5242880 = 5 MB)
#   RALPH_DELEGATE_LOG_KEEP         — number of rotated files to retain (default: 3)
#
# Exit codes:
#   0 — completed (rotation done OR no rotation needed)
#   1 — unknown flag

set -euo pipefail

LOG_PATH="${RALPH_DELEGATE_LOG_PATH:-$HOME/.ralph-hero/delegate.log}"
ROTATE_BYTES="${RALPH_DELEGATE_LOG_ROTATE_BYTES:-5242880}"
KEEP="${RALPH_DELEGATE_LOG_KEEP:-3}"
DRY_RUN=0

# Expand leading ~/ (mirrors ralph-delegate.sh:208-211).
# Note: \~ is escaped inside the pattern so bash does NOT perform
# tilde-expansion on the pattern itself (which would otherwise turn
# `${x#~/}` into `${x#$HOME/}` and silently no-op).
case "$LOG_PATH" in
    "~/"*) LOG_PATH="$HOME/${LOG_PATH#\~/}" ;;
esac

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help)
            sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "Unknown flag: $1" >&2; exit 1 ;;
    esac
done

# Absent log file → nothing to rotate.
if [[ ! -f "$LOG_PATH" ]]; then
    echo "logrotate: no rotation needed (no log file at $LOG_PATH)"
    exit 0
fi

# POSIX-portable byte count (works on macOS BSD + GNU coreutils).
SIZE=$(wc -c < "$LOG_PATH" | tr -d ' ')

if (( SIZE <= ROTATE_BYTES )); then
    echo "logrotate: no rotation needed (${SIZE} bytes <= ${ROTATE_BYTES} threshold)"
    exit 0
fi

if (( DRY_RUN )); then
    echo "DRY-RUN would rotate $LOG_PATH (${SIZE} bytes > ${ROTATE_BYTES} threshold)"
    echo "DRY-RUN would shift .1..N and create fresh empty log"
    exit 0
fi

# Shift the oldest rotated file out, then walk down.
# .KEEP gets dropped; .KEEP-1 -> .KEEP; ...; .1 -> .2.
if [[ -f "$LOG_PATH.$KEEP" ]]; then
    rm -f "$LOG_PATH.$KEEP"
fi

i=$((KEEP - 1))
while (( i >= 1 )); do
    if [[ -f "$LOG_PATH.$i" ]]; then
        mv -f "$LOG_PATH.$i" "$LOG_PATH.$((i + 1))"
    fi
    i=$((i - 1))
done

# Rotate current log into .1, leave a fresh empty file behind.
mv -f "$LOG_PATH" "$LOG_PATH.1"
: > "$LOG_PATH"

echo "logrotate: rotated $LOG_PATH (${SIZE} bytes) -> $LOG_PATH.1, fresh log created (keep=$KEEP)"
exit 0
