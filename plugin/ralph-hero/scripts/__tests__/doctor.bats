#!/usr/bin/env bats
# doctor.bats — Tests for doctor's read_settings_env function

# Since read_settings_env is embedded in a justfile recipe, we re-define it
# here to test in isolation. This mirrors the improved version.

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

    # Define the function under test (mirrors justfile doctor recipe)
    read_settings_env() {
        local var="$1"
        local settings_file="${2:-}"
        if [ -n "$settings_file" ]; then
            if [ ! -f "$settings_file" ]; then return 1; fi
            local val
            val=$(node -e "
                const s = JSON.parse(require('fs').readFileSync('$settings_file','utf8'));
                const v = (s.env || {})['$var'] || '';
                if (!v || v.startsWith('\${')) process.exit(1);
                process.stdout.write(v);
            " 2>/dev/null) || return 1
            echo "$val"
            return 0
        fi
        local paths=()
        local repo_root
        repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
        if [ -n "$repo_root" ] && [ -f "$repo_root/.claude/settings.local.json" ]; then
            paths+=("$repo_root/.claude/settings.local.json")
        fi
        if [ -f "$HOME/.claude/settings.local.json" ]; then
            paths+=("$HOME/.claude/settings.local.json")
        fi
        for sf in ${paths[@]+"${paths[@]}"}; do
            local val
            val=$(node -e "
                const s = JSON.parse(require('fs').readFileSync('$sf','utf8'));
                const v = (s.env || {})['$var'] || '';
                if (!v || v.startsWith('\${')) process.exit(1);
                process.stdout.write(v);
            " 2>/dev/null) || continue
            echo "$val"
            return 0
        done
        return 1
    }
    export -f read_settings_env
}

teardown() {
    rm -rf "$TEST_DIR"
}

# Uses RALPH_TEST_ONLY_VAR — not present in real repo settings — so the fallback
# path reaches the HOME-based settings.local.json.
@test "read_settings_env finds var in global settings.local.json" {
    HOME="$TEST_DIR" run read_settings_env "RALPH_TEST_ONLY_VAR"
    [ "$status" -eq 0 ]
    [ "$output" = "hello-from-global" ]
}

@test "read_settings_env returns failure when var not present in any settings" {
    HOME="$TEST_DIR" run read_settings_env "NONEXISTENT_VAR_THAT_DOES_NOT_EXIST_ANYWHERE"
    [ "$status" -ne 0 ]
}

# Uses explicit path so repo-local settings.local.json is bypassed entirely.
@test "read_settings_env skips unexpanded template vars" {
    cat > "$TEST_DIR/.claude/settings.local.json" <<'JSON'
{"env": {"RALPH_GH_OWNER": "${SOME_UNSET_VAR}"}}
JSON
    run read_settings_env "RALPH_GH_OWNER" "$TEST_DIR/.claude/settings.local.json"
    [ "$status" -ne 0 ]
}

# Uses explicit path (nonexistent) — confirms failure without relying on HOME override.
@test "read_settings_env returns failure when no settings files exist" {
    run read_settings_env "RALPH_GH_OWNER" "/nonexistent/settings-$(date +%s).json"
    [ "$status" -ne 0 ]
}

@test "read_settings_env with explicit path finds var" {
    run read_settings_env "RALPH_GH_OWNER" "$TEST_DIR/.claude/settings.local.json"
    [ "$status" -eq 0 ]
    [ "$output" = "testowner" ]
}

@test "read_settings_env with explicit nonexistent path fails" {
    run read_settings_env "RALPH_GH_OWNER" "/nonexistent/path.json"
    [ "$status" -ne 0 ]
}
