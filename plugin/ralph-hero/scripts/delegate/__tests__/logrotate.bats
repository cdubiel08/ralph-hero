#!/usr/bin/env bats
# logrotate.bats — Tests for the size-based delegate.log rotation script.
#
# Hermetic: every test runs against a private TEST_TMPDIR, sets
# RALPH_DELEGATE_LOG_PATH to a file inside it, and asserts on the
# resulting rotation state.

SCRIPT="${BATS_TEST_DIRNAME}/../logrotate.sh"

setup() {
    set +u
    TEST_TMPDIR=$(mktemp -d)
    export RALPH_DELEGATE_LOG_PATH="$TEST_TMPDIR/delegate.log"
    # Default 5 MB threshold is too large to exercise in unit tests — use 1 KB.
    export RALPH_DELEGATE_LOG_ROTATE_BYTES=1024
    export RALPH_DELEGATE_LOG_KEEP=3
}

teardown() {
    rm -rf "$TEST_TMPDIR"
}

# --- Helpers ---

# Write a file of N bytes (filled with 'x').
write_bytes() {
    local path="$1"
    local n="$2"
    head -c "$n" /dev/zero | tr '\0' 'x' > "$path"
}

# --- Tests ---

@test "--help prints usage and exits 0" {
    run bash "$SCRIPT" --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"logrotate"* ]]
    [[ "$output" == *"--dry-run"* ]]
}

@test "absent log file: no-op, exits 0" {
    [ ! -f "$RALPH_DELEGATE_LOG_PATH" ]
    run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"no rotation needed"* ]]
    [ ! -f "$RALPH_DELEGATE_LOG_PATH" ]
}

@test "under-threshold log: no-op, exits 0" {
    write_bytes "$RALPH_DELEGATE_LOG_PATH" 500
    run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"no rotation needed"* ]]
    # Original still present; no .1 created
    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    [ "$(wc -c < "$RALPH_DELEGATE_LOG_PATH" | tr -d ' ')" -eq 500 ]
    [ ! -f "$RALPH_DELEGATE_LOG_PATH.1" ]
}

@test "over-threshold log: rotates to .1, leaves fresh empty log" {
    write_bytes "$RALPH_DELEGATE_LOG_PATH" 2048
    run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"rotated"* ]]

    # .1 should exist with the original size; fresh log empty
    [ -f "$RALPH_DELEGATE_LOG_PATH.1" ]
    [ "$(wc -c < "$RALPH_DELEGATE_LOG_PATH.1" | tr -d ' ')" -eq 2048 ]
    [ -f "$RALPH_DELEGATE_LOG_PATH" ]
    [ "$(wc -c < "$RALPH_DELEGATE_LOG_PATH" | tr -d ' ')" -eq 0 ]
}

@test "three consecutive rotations build .1, .2, .3 and drop the oldest" {
    # Round 1
    write_bytes "$RALPH_DELEGATE_LOG_PATH" 2048
    run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -f "$RALPH_DELEGATE_LOG_PATH.1" ]
    [ ! -f "$RALPH_DELEGATE_LOG_PATH.2" ]

    # Round 2 — distinct content so we can verify shifting
    echo "round-2-content" > "$RALPH_DELEGATE_LOG_PATH"
    write_bytes "$RALPH_DELEGATE_LOG_PATH" 2048
    run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -f "$RALPH_DELEGATE_LOG_PATH.1" ]
    [ -f "$RALPH_DELEGATE_LOG_PATH.2" ]
    [ ! -f "$RALPH_DELEGATE_LOG_PATH.3" ]

    # Round 3
    write_bytes "$RALPH_DELEGATE_LOG_PATH" 2048
    run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -f "$RALPH_DELEGATE_LOG_PATH.1" ]
    [ -f "$RALPH_DELEGATE_LOG_PATH.2" ]
    [ -f "$RALPH_DELEGATE_LOG_PATH.3" ]

    # Round 4 — oldest (.3) drops; .4 must NOT exist
    write_bytes "$RALPH_DELEGATE_LOG_PATH" 2048
    run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -f "$RALPH_DELEGATE_LOG_PATH.1" ]
    [ -f "$RALPH_DELEGATE_LOG_PATH.2" ]
    [ -f "$RALPH_DELEGATE_LOG_PATH.3" ]
    [ ! -f "$RALPH_DELEGATE_LOG_PATH.4" ]
}

@test "--dry-run announces, does not rotate" {
    write_bytes "$RALPH_DELEGATE_LOG_PATH" 2048
    run bash "$SCRIPT" --dry-run
    [ "$status" -eq 0 ]
    [[ "$output" == *"DRY-RUN"* ]]
    # Nothing actually rotated
    [ ! -f "$RALPH_DELEGATE_LOG_PATH.1" ]
    [ "$(wc -c < "$RALPH_DELEGATE_LOG_PATH" | tr -d ' ')" -eq 2048 ]
}

@test "honors custom RALPH_DELEGATE_LOG_KEEP" {
    export RALPH_DELEGATE_LOG_KEEP=1
    # Round 1
    write_bytes "$RALPH_DELEGATE_LOG_PATH" 2048
    bash "$SCRIPT" >/dev/null
    [ -f "$RALPH_DELEGATE_LOG_PATH.1" ]
    # Round 2 — .2 should NOT exist because KEEP=1
    write_bytes "$RALPH_DELEGATE_LOG_PATH" 2048
    bash "$SCRIPT" >/dev/null
    [ -f "$RALPH_DELEGATE_LOG_PATH.1" ]
    [ ! -f "$RALPH_DELEGATE_LOG_PATH.2" ]
}

@test "unknown flag exits non-zero" {
    run bash "$SCRIPT" --bogus
    [ "$status" -ne 0 ]
}

@test "expands leading ~/ in RALPH_DELEGATE_LOG_PATH" {
    # Point at a tilde-prefixed path inside TEST_TMPDIR using a fake HOME.
    HOME_FAKE="$TEST_TMPDIR/fakehome"
    mkdir -p "$HOME_FAKE/.ralph-hero"
    LOG_REL="~/.ralph-hero/delegate.log"
    write_bytes "$HOME_FAKE/.ralph-hero/delegate.log" 2048

    HOME="$HOME_FAKE" RALPH_DELEGATE_LOG_PATH="$LOG_REL" run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -f "$HOME_FAKE/.ralph-hero/delegate.log.1" ]
}
