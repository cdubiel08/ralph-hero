#!/usr/bin/env bash
# logrotate.sh — cap dream-loop log files at 1000 lines.
#
# Invoked at the end of the launchd-scheduled dream-loop pipeline
# (see scripts/dream/launchd/com.dubiel.dream-loop.plist.template).
# Atomically truncates ~/Library/Logs/ralph-dream-loop.{out,err}
# to their last 1000 lines via tail + tmp file + mv. For backward
# compatibility, also rotates legacy /tmp/dream-loop.{out,err} if they
# still exist on this machine.

set -euo pipefail

MAX_LINES=1000

rotate_one() {
    local log_path="$1"
    if [[ ! -f "$log_path" ]]; then
        return 0
    fi

    local tmp_path
    tmp_path="${log_path}.rotate.$$"

    # tail -n never fails on short files; mv is atomic within the same fs.
    tail -n "$MAX_LINES" "$log_path" > "$tmp_path"
    mv "$tmp_path" "$log_path"
}

# Current paths (per templated plist) — under ~/Library/Logs/.
rotate_one "${HOME}/Library/Logs/ralph-dream-loop.out"
rotate_one "${HOME}/Library/Logs/ralph-dream-loop.err"

# Legacy paths under /tmp/ — rotate if any pre-templated installs still
# point there. No-op when the files don't exist.
rotate_one "/tmp/dream-loop.out"
rotate_one "/tmp/dream-loop.err"
