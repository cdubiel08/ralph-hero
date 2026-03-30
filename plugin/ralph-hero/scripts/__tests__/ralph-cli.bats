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

@test "ralph cli passes --working-directory with the user's CWD to just" {
    # Create a fake just that records its args and exits cleanly
    local fake_just fake_bin
    fake_just=$(mktemp)
    fake_bin=$(mktemp -d)
    chmod +x "$fake_just"
    cat > "$fake_just" <<'SH'
#!/usr/bin/env bash
echo "ARGS: $*"
# Simulate --summary sub-command so pre-flight probe succeeds
if [[ "$*" == *"--summary"* ]]; then echo "status"; fi
exit 0
SH
    cp "$fake_just" "$fake_bin/just"

    # Capture the user's CWD before BATS captures the run
    local expected_cwd
    expected_cwd="$(pwd)"

    # Use a trap so temp files are always cleaned up, even when assertions fail.
    # Use /usr/bin/rm with absolute path so it is not affected by PATH changes.
    trap '/usr/bin/rm -rf "$fake_bin" "$fake_just"' RETURN

    # Set PATH inline for the run call only — avoids polluting the process
    # environment (which would break BATS's own cleanup code that calls rm).
    PATH="$fake_bin:$PATH" run "$RALPH_CLI" status

    # Verify the flag AND its value (the user's CWD) are both present
    [[ "$output" =~ "--working-directory" ]]
    [[ "$output" =~ "$expected_cwd" ]]
}
