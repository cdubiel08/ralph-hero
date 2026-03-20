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
