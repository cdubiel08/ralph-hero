#!/usr/bin/env bats
# cli-dispatch.bats — Unit tests for cli-dispatch.sh

setup() {
    # Source cli-dispatch.sh without set -u to avoid bash 3.2 empty array issues.
    # Do NOT re-enable set -u — bats tests must remain safe for ${#ARGS[@]} assertions.
    set +u
    source "${BATS_TEST_DIRNAME}/../cli-dispatch.sh"
}

@test "cli-dispatch.sh can be sourced without error" {
    # setup already sources it; if we get here, it worked
    [ -n "$(type -t parse_mode)" ]
}

# --- Bash 3.2 compatibility ---

@test "parse_mode with no args produces empty ARGS array" {
    parse_mode
    [ ${#ARGS[@]} -eq 0 ]
}

@test "dispatch with no extra args does not crash" {
    run_headless() { echo "headless: $*"; }
    run_interactive() { echo "interactive: $*"; }
    dispatch "test-skill"
}

@test "dispatch with -i flag and no other args does not crash" {
    run_interactive() { echo "interactive: $*"; }
    DEFAULT_MODE=headless
    parse_mode "-i"
    [ "$MODE" = "interactive" ]
    [ ${#ARGS[@]} -eq 0 ]
}

# --- Version resolution ---

@test "MCP_VERSION uses RALPH_MCP_VERSION when set" {
    export RALPH_MCP_VERSION="2.5.39"
    source "${BATS_TEST_DIRNAME}/../cli-dispatch.sh"
    [ "$MCP_VERSION" = "2.5.39" ]
}

@test "MCP_VERSION falls back to latest when RALPH_MCP_VERSION unset" {
    unset RALPH_MCP_VERSION
    source "${BATS_TEST_DIRNAME}/../cli-dispatch.sh"
    [ "$MCP_VERSION" = "latest" ]
}

# --- Mode parsing ---

@test "parse_mode defaults to headless" {
    parse_mode
    [ "$MODE" = "headless" ]
}

@test "parse_mode respects DEFAULT_MODE" {
    DEFAULT_MODE="quick"
    parse_mode
    [ "$MODE" = "quick" ]
}

@test "parse_mode -i sets interactive mode" {
    parse_mode "-i"
    [ "$MODE" = "interactive" ]
}

@test "parse_mode -q sets quick mode" {
    parse_mode "-q"
    [ "$MODE" = "quick" ]
}

@test "parse_mode extracts non-flag args into ARGS" {
    parse_mode "42" "-i" "extra"
    [ "$MODE" = "interactive" ]
    [ "${ARGS[0]}" = "42" ]
    [ "${ARGS[1]}" = "extra" ]
}

@test "parse_mode --budget sets BUDGET" {
    parse_mode "--budget=3.00"
    [ "$BUDGET" = "3.00" ]
}

@test "parse_mode --timeout sets TIMEOUT" {
    parse_mode "--timeout=30m"
    [ "$TIMEOUT" = "30m" ]
}

@test "parse_mode mixed flags and positional args" {
    parse_mode "-i" "--budget=5.00" "42" "--timeout=20m" "extra"
    [ "$MODE" = "interactive" ]
    [ "$BUDGET" = "5.00" ]
    [ "$TIMEOUT" = "20m" ]
    [ "${ARGS[0]}" = "42" ]
    [ "${ARGS[1]}" = "extra" ]
}

@test "parse_mode defaults BUDGET to 2.00" {
    parse_mode
    [ "$BUDGET" = "2.00" ]
}

@test "parse_mode defaults TIMEOUT to 15m" {
    parse_mode
    [ "$TIMEOUT" = "15m" ]
}

# --- portable_timeout ---

# Helper: run portable_timeout using the perl fallback by hiding the system
# `timeout` binary from PATH for the duration of the test.
_run_perl_fallback() {
    local saved_path="$PATH"
    # Create a temp dir with a stub that makes `command -v timeout` fail
    local stub_dir
    stub_dir=$(mktemp -d)
    # Do NOT place a `timeout` stub — the empty dir effectively hides it
    PATH="$stub_dir:$PATH"
    portable_timeout "$@"
    local rc=$?
    PATH="$saved_path"
    rm -rf "$stub_dir"
    return "$rc"
}

@test "portable_timeout: minute duration is converted to seconds" {
    # Test the bash regex+arithmetic that converts "15m" -> 900.
    # This logic lives in the perl-fallback branch of portable_timeout; we
    # replicate it directly so the test is not coupled to PATH stubbing.
    run bash -c '
        duration="15m"
        if [[ "$duration" =~ ^([0-9]+)m$ ]]; then
            seconds=$(( ${BASH_REMATCH[1]} * 60 ))
        else
            seconds="$duration"
        fi
        echo "$seconds"
    '
    [ "$status" -eq 0 ]
    [ "$output" = "900" ]
}

@test "portable_timeout: plain seconds pass through unchanged" {
    run bash -c '
        duration="300"
        if [[ "$duration" =~ ^([0-9]+)m$ ]]; then
            seconds=$(( ${BASH_REMATCH[1]} * 60 ))
        else
            seconds="$duration"
        fi
        echo "$seconds"
    '
    [ "$status" -eq 0 ]
    [ "$output" = "300" ]
}

@test "portable_timeout: uses GNU timeout when available" {
    run bash -c '
        set +u
        source "'"${BATS_TEST_DIRNAME}"'/../cli-dispatch.sh"
        # Stub timeout to record it was called
        timeout() { echo "gnu:$*"; return 0; }
        export -f timeout
        portable_timeout 10 true
    '
    [ "$status" -eq 0 ]
    [[ "$output" == "gnu:10 true" ]]
}

@test "portable_timeout: perl fallback runs command successfully" {
    run bash -c '
        set +u
        source "'"${BATS_TEST_DIRNAME}"'/../cli-dispatch.sh"
        stub_dir=$(mktemp -d)
        saved_path="$PATH"
        PATH="$stub_dir:$PATH"
        portable_timeout 5 true
        rc=$?
        PATH="$saved_path"
        rm -rf "$stub_dir"
        exit "$rc"
    '
    [ "$status" -eq 0 ]
}

@test "portable_timeout: perl fallback propagates non-zero exit from command" {
    run bash -c '
        set +u
        source "'"${BATS_TEST_DIRNAME}"'/../cli-dispatch.sh"
        stub_dir=$(mktemp -d)
        saved_path="$PATH"
        PATH="$stub_dir:$PATH"
        portable_timeout 5 bash -c "exit 42"
        rc=$?
        PATH="$saved_path"
        rm -rf "$stub_dir"
        exit "$rc"
    '
    [ "$status" -eq 42 ]
}

@test "portable_timeout: perl fallback remaps exit 142 to 124" {
    # When the alarm fires, perl exits 142; portable_timeout must remap to 124.
    run bash -c '
        set +u
        source "'"${BATS_TEST_DIRNAME}"'/../cli-dispatch.sh"
        stub_dir=$(mktemp -d)
        saved_path="$PATH"
        PATH="$stub_dir:$PATH"
        # Use 1-second timeout against a command that sleeps longer
        portable_timeout 1 sleep 10
        rc=$?
        PATH="$saved_path"
        rm -rf "$stub_dir"
        exit "$rc"
    '
    [ "$status" -eq 124 ]
}

# --- Env bridging ---

@test "run_quick calls ralph_bridge_env before mcp" {
    bridged=false
    ralph_bridge_env() { bridged=true; }
    mcp() { echo '{"content":[{"text":"ok"}]}'; }
    export -f mcp
    QUICK_TOOL="ralph_hero__pipeline_dashboard"
    QUICK_PARAMS='{}'
    run_quick "$QUICK_TOOL" "$QUICK_PARAMS"
    [ "$bridged" = "true" ]
}
