#!/usr/bin/env bats
# doctor.bats — Tests for doctor env resolution via shared resolve-env.sh
#
# The doctor recipe now sources resolve-env.sh and uses _ralph_read_json_env
# for settings file reads. These tests exercise that shared function.

setup() {
    TEST_DIR=$(mktemp -d)
    mkdir -p "$TEST_DIR/.claude"
    cat > "$TEST_DIR/.claude/settings.local.json" <<'JSON'
{
    "env": {
        "RALPH_GH_OWNER": "testowner",
        "RALPH_HERO_GITHUB_TOKEN": "ghp_testtoken123",
        "RALPH_GH_PROJECT_NUMBER": "7",
        "RALPH_TEST_ONLY_VAR": "hello-from-global"
    }
}
JSON

    # Source the shared library (same as doctor recipe does)
    BATS_LIB_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
    source "$BATS_LIB_DIR/resolve-env.sh"
}

teardown() {
    rm -rf "$TEST_DIR"
}

@test "_ralph_read_json_env finds var in settings file" {
    run _ralph_read_json_env "RALPH_GH_OWNER" "$TEST_DIR/.claude/settings.local.json"
    [ "$status" -eq 0 ]
    [ "$output" = "testowner" ]
}

@test "_ralph_read_json_env returns failure when var not present" {
    run _ralph_read_json_env "NONEXISTENT_VAR_THAT_DOES_NOT_EXIST_ANYWHERE" "$TEST_DIR/.claude/settings.local.json"
    [ "$status" -ne 0 ]
}

@test "_ralph_read_json_env skips unexpanded template vars" {
    cat > "$TEST_DIR/.claude/settings.local.json" <<'JSON'
{"env": {"RALPH_GH_OWNER": "${SOME_UNSET_VAR}"}}
JSON
    run _ralph_read_json_env "RALPH_GH_OWNER" "$TEST_DIR/.claude/settings.local.json"
    [ "$status" -ne 0 ]
}

@test "_ralph_read_json_env returns failure when file does not exist" {
    run _ralph_read_json_env "RALPH_GH_OWNER" "/nonexistent/settings-$(date +%s).json"
    [ "$status" -ne 0 ]
}

@test "_ralph_read_json_env reads token from settings file" {
    run _ralph_read_json_env "RALPH_HERO_GITHUB_TOKEN" "$TEST_DIR/.claude/settings.local.json"
    [ "$status" -eq 0 ]
    [ "$output" = "ghp_testtoken123" ]
}

@test "ralph_resolve_env checks settings.json after settings.local.json" {
    # Put var only in settings.json (not settings.local.json)
    mkdir -p "$TEST_DIR/repo/.claude"
    echo '{"env": {}}' > "$TEST_DIR/repo/.claude/settings.local.json"
    cat > "$TEST_DIR/repo/.claude/settings.json" <<'JSON'
{"env": {"RALPH_GH_OWNER": "from-committed"}}
JSON
    unset RALPH_GH_OWNER 2>/dev/null || true
    run ralph_resolve_env "RALPH_GH_OWNER" "$TEST_DIR/repo" "$TEST_DIR"
    [ "$status" -eq 0 ]
    [ "$output" = "from-committed" ]
}

@test "ralph_resolve_env falls back to global ~/.claude/settings.json" {
    mkdir -p "$TEST_DIR/.claude"
    cat > "$TEST_DIR/.claude/settings.json" <<'JSON'
{"env": {"RALPH_GH_OWNER": "from-global"}}
JSON
    mkdir -p "$TEST_DIR/repo/.claude"
    echo '{"env": {}}' > "$TEST_DIR/repo/.claude/settings.local.json"
    echo '{"env": {}}' > "$TEST_DIR/repo/.claude/settings.json"
    unset RALPH_GH_OWNER 2>/dev/null || true
    run ralph_resolve_env "RALPH_GH_OWNER" "$TEST_DIR/repo" "$TEST_DIR"
    [ "$status" -eq 0 ]
    [ "$output" = "from-global" ]
}
