#!/usr/bin/env bats
# ralph-cli.bats — Integration tests for the ralph global CLI

setup() {
    RALPH_CLI="${BATS_TEST_DIRNAME}/../ralph-cli.sh"
    # Point to the repo's justfile for testing
    export RALPH_JUSTFILE="${BATS_TEST_DIRNAME}/../../justfile"
}

@test "ralph --version prints version string" {
    run "$RALPH_CLI" --version
    [ "$status" -eq 0 ]
    [[ "$output" =~ ^ralph\ version ]]
}

@test "ralph -V prints version string" {
    run "$RALPH_CLI" -V
    [ "$status" -eq 0 ]
    [[ "$output" =~ ^ralph\ version ]]
}

@test "ralph --help shows grouped command sections" {
    run "$RALPH_CLI" --help
    [ "$status" -eq 0 ]
    [[ "$output" =~ "Workflow commands" ]]
    [[ "$output" =~ "Quick commands" ]]
    [[ "$output" =~ "Orchestrators" ]]
    [[ "$output" =~ "Setup" ]]
}

@test "ralph --help shows new flat-namespace commands" {
    run "$RALPH_CLI" --help
    [ "$status" -eq 0 ]
    [[ "$output" =~ "issue" ]]
    [[ "$output" =~ "move" ]]
    [[ "$output" =~ "info" ]]
    [[ "$output" =~ "assign" ]]
}

@test "ralph unknown-command exits non-zero with suggestion" {
    run "$RALPH_CLI" "isue"
    [ "$status" -ne 0 ]
    [[ "$output" =~ "Unknown command" ]]
    [[ "$output" =~ "Did you mean" ]]
    [[ "$output" =~ "issue" ]]
}

@test "ralph unknown-command with no close match shows help hint" {
    run "$RALPH_CLI" "xyzzy"
    [ "$status" -ne 0 ]
    [[ "$output" =~ "Unknown command" ]]
    [[ "$output" =~ "ralph --help" ]]
}

@test "ralph with missing justfile shows install instructions" {
    RALPH_JUSTFILE="/nonexistent/path" run "$RALPH_CLI" status
    [ "$status" -ne 0 ]
    [[ "$output" =~ "not found" ]]
}
