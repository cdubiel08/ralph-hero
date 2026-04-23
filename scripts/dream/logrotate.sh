#!/usr/bin/env bash
# logrotate.sh — cap dream-loop log files at 1000 lines.
#
# Invoked at the end of the launchd-scheduled dream-loop pipeline
# (see scripts/dream/launchd/com.dubiel.dream-loop.plist.template).
# Atomically truncates /tmp/dream-loop.out and /tmp/dream-loop.err
# to their last 1000 lines via tail + tmp file + mv.

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

rotate_one "/tmp/dream-loop.out"
rotate_one "/tmp/dream-loop.err"
