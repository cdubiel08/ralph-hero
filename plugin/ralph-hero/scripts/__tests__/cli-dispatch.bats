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
