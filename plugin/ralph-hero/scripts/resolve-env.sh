#!/usr/bin/env bash
# resolve-env.sh — Shared env var resolution for Ralph CLI
# Sources: shell env -> repo settings.local.json -> repo settings.json -> ~/.claude/settings.json
#
# Usage:
#   source "$(dirname "$0")/resolve-env.sh"   # or absolute path
#   val=$(ralph_resolve_env "RALPH_GH_OWNER" "$repo_root" "$HOME")

# Read a single env var from a JSON settings file.
# Filters unexpanded ${VAR} template literals.
# Returns 0 + prints value on success, 1 on failure.
_ralph_read_json_env() {
    local var="$1" file="$2"
    [ -f "$file" ] || return 1
    local val
    val=$(node -e "
        const s = JSON.parse(require('fs').readFileSync('$file','utf8'));
        const v = (s.env || {})['$var'] || '';
        if (!v || v.startsWith('\${')) process.exit(1);
        process.stdout.write(v);
    " 2>/dev/null) || return 1
    echo "$val"
}

# Resolve an env var from the full settings hierarchy.
# Args: VAR_NAME [REPO_ROOT] [HOME_DIR]
# Search order:
#   1. Shell environment
#   2. <repo>/.claude/settings.local.json
#   3. <repo>/.claude/settings.json
#   4. ~/.claude/settings.json
ralph_resolve_env() {
    local var="$1"
    local repo_root="${2:-}"
    local home_dir="${3:-$HOME}"

    # 1. Shell environment
    local shell_val="${!var:-}"
    if [ -n "$shell_val" ]; then
        echo "$shell_val"
        return 0
    fi

    # 2. Repo settings.local.json (project-scoped secrets)
    if [ -n "$repo_root" ]; then
        local val
        val=$(_ralph_read_json_env "$var" "$repo_root/.claude/settings.local.json") && {
            echo "$val"; return 0
        }
    fi

    # 3. Repo settings.json (project-scoped committed config)
    if [ -n "$repo_root" ]; then
        local val
        val=$(_ralph_read_json_env "$var" "$repo_root/.claude/settings.json") && {
            echo "$val"; return 0
        }
    fi

    # 4. Global settings.json (user-scoped config)
    local val
    val=$(_ralph_read_json_env "$var" "$home_dir/.claude/settings.json") && {
        echo "$val"; return 0
    }

    return 1
}

# Detect plugin install scope from installed_plugins.json.
# Args: [HOME_DIR]
# Returns: "user", "project", or "unknown"
ralph_detect_scope() {
    local home_dir="${1:-$HOME}"
    local registry="$home_dir/.claude/plugins/installed_plugins.json"
    if [ ! -f "$registry" ]; then
        echo "unknown"
        return 0
    fi
    local scope
    scope=$(node -e "
        const r = JSON.parse(require('fs').readFileSync('$registry','utf8'));
        const entries = r['ralph-hero@ralph-hero'] || [];
        const latest = entries[entries.length - 1];
        if (latest && latest.scope) process.stdout.write(latest.scope);
        else process.exit(1);
    " 2>/dev/null) || { echo "unknown"; return 0; }
    echo "$scope"
}

# Bridge env vars for direct MCP calls (run_quick / _mcp_call).
# Resolves and exports RALPH_* vars if not already in shell env.
# Args: [REPO_ROOT] [HOME_DIR]
ralph_bridge_env() {
    local repo_root="${1:-}"
    local home_dir="${2:-$HOME}"

    # Auto-detect repo root if not provided
    if [ -z "$repo_root" ]; then
        repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
    fi

    local var val
    for var in RALPH_HERO_GITHUB_TOKEN RALPH_GH_OWNER RALPH_GH_REPO RALPH_GH_PROJECT_NUMBER; do
        val="${!var:-}"
        if [ -z "$val" ]; then
            val=$(ralph_resolve_env "$var" "$repo_root" "$home_dir") || continue
            export "$var=$val"
        fi
    done
}
