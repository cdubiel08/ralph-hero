#!/usr/bin/env bats
# resolve-env.bats — Unit tests for resolve-env.sh

setup() {
    set +u
    source "${BATS_TEST_DIRNAME}/../resolve-env.sh"
    # Create temp dirs for test fixtures
    TEST_TMPDIR=$(mktemp -d)
    mkdir -p "$TEST_TMPDIR/project/.claude"
    mkdir -p "$TEST_TMPDIR/home/.claude"
    mkdir -p "$TEST_TMPDIR/home/.claude/plugins"
}

teardown() {
    rm -rf "$TEST_TMPDIR"
}

# --- ralph_resolve_env ---

@test "ralph_resolve_env returns value from shell env" {
    export TEST_VAR="from-shell"
    run ralph_resolve_env "TEST_VAR" "$TEST_TMPDIR/project" "$TEST_TMPDIR/home"
    [ "$status" -eq 0 ]
    [ "$output" = "from-shell" ]
    unset TEST_VAR
}

@test "ralph_resolve_env finds value in repo settings.local.json" {
    cat > "$TEST_TMPDIR/project/.claude/settings.local.json" <<'JSON'
{"env":{"RALPH_GH_OWNER":"from-local"}}
JSON
    unset RALPH_GH_OWNER 2>/dev/null || true
    run ralph_resolve_env "RALPH_GH_OWNER" "$TEST_TMPDIR/project" "$TEST_TMPDIR/home"
    [ "$status" -eq 0 ]
    [ "$output" = "from-local" ]
}

@test "ralph_resolve_env finds value in repo settings.json" {
    cat > "$TEST_TMPDIR/project/.claude/settings.json" <<'JSON'
{"env":{"RALPH_GH_OWNER":"from-project"}}
JSON
    unset RALPH_GH_OWNER 2>/dev/null || true
    run ralph_resolve_env "RALPH_GH_OWNER" "$TEST_TMPDIR/project" "$TEST_TMPDIR/home"
    [ "$status" -eq 0 ]
    [ "$output" = "from-project" ]
}

@test "ralph_resolve_env finds value in global settings.json" {
    cat > "$TEST_TMPDIR/home/.claude/settings.json" <<'JSON'
{"env":{"RALPH_GH_OWNER":"from-global"}}
JSON
    unset RALPH_GH_OWNER 2>/dev/null || true
    run ralph_resolve_env "RALPH_GH_OWNER" "$TEST_TMPDIR/project" "$TEST_TMPDIR/home"
    [ "$status" -eq 0 ]
    [ "$output" = "from-global" ]
}

@test "ralph_resolve_env respects priority order: local > project > global" {
    cat > "$TEST_TMPDIR/project/.claude/settings.local.json" <<'JSON'
{"env":{"RALPH_GH_OWNER":"from-local"}}
JSON
    cat > "$TEST_TMPDIR/project/.claude/settings.json" <<'JSON'
{"env":{"RALPH_GH_OWNER":"from-project"}}
JSON
    cat > "$TEST_TMPDIR/home/.claude/settings.json" <<'JSON'
{"env":{"RALPH_GH_OWNER":"from-global"}}
JSON
    unset RALPH_GH_OWNER 2>/dev/null || true
    run ralph_resolve_env "RALPH_GH_OWNER" "$TEST_TMPDIR/project" "$TEST_TMPDIR/home"
    [ "$status" -eq 0 ]
    [ "$output" = "from-local" ]
}

@test "ralph_resolve_env returns 1 when not found anywhere" {
    unset RALPH_GH_OWNER 2>/dev/null || true
    run ralph_resolve_env "RALPH_GH_OWNER" "$TEST_TMPDIR/project" "$TEST_TMPDIR/home"
    [ "$status" -eq 1 ]
}

@test "ralph_resolve_env filters unexpanded template literals" {
    cat > "$TEST_TMPDIR/project/.claude/settings.local.json" <<'JSON'
{"env":{"RALPH_GH_OWNER":"${user_config.owner}"}}
JSON
    unset RALPH_GH_OWNER 2>/dev/null || true
    run ralph_resolve_env "RALPH_GH_OWNER" "$TEST_TMPDIR/project" "$TEST_TMPDIR/home"
    [ "$status" -eq 1 ]
}

# --- ralph_detect_scope ---

@test "ralph_detect_scope returns user when scope is user" {
    cat > "$TEST_TMPDIR/home/.claude/plugins/installed_plugins.json" <<'JSON'
{"ralph-hero@ralph-hero":[{"scope":"user","installPath":"/fake"}]}
JSON
    run ralph_detect_scope "$TEST_TMPDIR/home"
    [ "$status" -eq 0 ]
    [ "$output" = "user" ]
}

@test "ralph_detect_scope returns project when scope is project" {
    cat > "$TEST_TMPDIR/home/.claude/plugins/installed_plugins.json" <<'JSON'
{"ralph-hero@ralph-hero":[{"scope":"project","installPath":"/fake"}]}
JSON
    run ralph_detect_scope "$TEST_TMPDIR/home"
    [ "$status" -eq 0 ]
    [ "$output" = "project" ]
}

@test "ralph_detect_scope returns unknown when registry missing" {
    run ralph_detect_scope "$TEST_TMPDIR/home"
    [ "$status" -eq 0 ]
    [ "$output" = "unknown" ]
}

# --- ralph_bridge_env ---

@test "ralph_bridge_env exports resolved vars" {
    cat > "$TEST_TMPDIR/home/.claude/settings.json" <<'JSON'
{"env":{"RALPH_GH_OWNER":"test-owner","RALPH_GH_PROJECT_NUMBER":"42"}}
JSON
    unset RALPH_GH_OWNER RALPH_GH_PROJECT_NUMBER RALPH_GH_REPO RALPH_HERO_GITHUB_TOKEN 2>/dev/null || true
    ralph_bridge_env "" "$TEST_TMPDIR/home"
    [ "$RALPH_GH_OWNER" = "test-owner" ]
    [ "$RALPH_GH_PROJECT_NUMBER" = "42" ]
}

@test "ralph_bridge_env does not overwrite already-set shell vars" {
    cat > "$TEST_TMPDIR/home/.claude/settings.json" <<'JSON'
{"env":{"RALPH_GH_OWNER":"from-file"}}
JSON
    export RALPH_GH_OWNER="from-shell"
    ralph_bridge_env "" "$TEST_TMPDIR/home"
    [ "$RALPH_GH_OWNER" = "from-shell" ]
    unset RALPH_GH_OWNER
}
