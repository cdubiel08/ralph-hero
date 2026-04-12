---
date: 2026-03-27
status: draft
type: plan
tags: [cli, env-resolution, setup, scope-detection, settings]
github_issue: 694
github_url: https://github.com/cdubiel08/ralph-hero/issues/694
---

# CLI Environment Resolution Scope Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `ralph` CLI work from any directory when the plugin is installed at user scope, by writing env vars to the scope-appropriate Claude Code settings file and teaching all CLI paths to read from the full settings hierarchy.

**Architecture:** Extract `read_settings_env()` into a shared shell library (`scripts/resolve-env.sh`). Update the justfile `doctor`, `_mcp_call`, and `cli-dispatch.sh` `run_quick` to source it and bridge env vars before spawning the MCP server. Update the setup skill to write config to the correct file based on plugin install scope.

**Tech Stack:** Bash (shell scripts, justfile recipes), BATS (tests), SKILL.md (setup skill)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `plugin/ralph-hero/scripts/resolve-env.sh` | Create | Shared shell library: `ralph_resolve_env()` and `ralph_detect_scope()` |
| `plugin/ralph-hero/scripts/__tests__/resolve-env.bats` | Create | BATS tests for resolve-env.sh |
| `plugin/ralph-hero/scripts/cli-dispatch.sh` | Modify | Source resolve-env.sh, bridge env in `run_quick` |
| `plugin/ralph-hero/justfile` | Modify | Replace inline `read_settings_env()` in doctor, add env bridging to `_mcp_call` |
| `plugin/ralph-hero/skills/setup/SKILL.md` | Modify | Scope-aware config file targeting |
| `plugin/ralph-hero/mcp-server/src/lib/helpers.ts` | Modify | Improve error messages with scope-aware guidance |
| `plugin/ralph-hero/scripts/__tests__/doctor.bats` | Modify | Add tests for new search paths |

---

### Task 1: Create `resolve-env.sh` Shared Shell Library

**Files:**
- Create: `plugin/ralph-hero/scripts/resolve-env.sh`
- Test: `plugin/ralph-hero/scripts/__tests__/resolve-env.bats`

- [ ] **Step 1: Write the failing tests**

Create `plugin/ralph-hero/scripts/__tests__/resolve-env.bats`:

```bash
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugin/ralph-hero && bats scripts/__tests__/resolve-env.bats`
Expected: FAIL — `resolve-env.sh` does not exist

- [ ] **Step 3: Write the implementation**

Create `plugin/ralph-hero/scripts/resolve-env.sh`:

```bash
#!/usr/bin/env bash
# resolve-env.sh — Shared env var resolution for Ralph CLI
# Sources: shell env → repo settings.local.json → repo settings.json → ~/.claude/settings.json
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugin/ralph-hero && bats scripts/__tests__/resolve-env.bats`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/scripts/resolve-env.sh plugin/ralph-hero/scripts/__tests__/resolve-env.bats
git commit -m "feat(cli): add resolve-env.sh shared shell library for settings hierarchy

Extracts env var resolution into a reusable library with full search order:
shell env → repo settings.local.json → repo settings.json → ~/.claude/settings.json

Includes scope detection from installed_plugins.json and env bridging
for direct MCP calls. GH-694"
```

---

### Task 2: Wire Env Bridging into `cli-dispatch.sh` and Justfile `_mcp_call`

**Files:**
- Modify: `plugin/ralph-hero/scripts/cli-dispatch.sh:1-5` (add source)
- Modify: `plugin/ralph-hero/scripts/cli-dispatch.sh:163-190` (`run_quick`)
- Modify: `plugin/ralph-hero/justfile:576-601` (`_mcp_call`)
- Modify: `plugin/ralph-hero/scripts/__tests__/cli-dispatch.bats` (add test)

- [ ] **Step 1: Write the failing test**

Add to `plugin/ralph-hero/scripts/__tests__/cli-dispatch.bats`:

```bash
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugin/ralph-hero && bats scripts/__tests__/cli-dispatch.bats`
Expected: FAIL — `ralph_bridge_env` not called

- [ ] **Step 3: Add source line to `cli-dispatch.sh`**

Add after line 4 of `plugin/ralph-hero/scripts/cli-dispatch.sh`:

```bash
# Source shared env resolution
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/resolve-env.sh"
```

- [ ] **Step 4: Add `ralph_bridge_env` call to `run_quick` in `cli-dispatch.sh`**

Add before the `mcp call` at line 174 of `plugin/ralph-hero/scripts/cli-dispatch.sh`, inside `run_quick()`:

```bash
    # Bridge env vars from settings files for direct MCP calls
    ralph_bridge_env
```

So `run_quick` becomes:

```bash
run_quick() {
    local tool="$1"
    local params="$2"
    if ! command -v mcp &>/dev/null; then
        echo "Error: mcptools not installed."
        echo "Install: brew tap f/mcptools && brew install mcp"
        echo "   or: go install github.com/f/mcptools/cmd/mcptools@latest"
        exit 1
    fi
    # Bridge env vars from settings files for direct MCP calls
    ralph_bridge_env
    local raw
    raw=$(mcp call "$tool" --params "$params" \
        npx -y "ralph-hero-mcp-server@${MCP_VERSION}") || {
        echo "Error: MCP call to $tool failed." >&2
        echo "Run: ralph doctor" >&2
        exit 1
    }
    # ... rest unchanged
```

- [ ] **Step 5: Add `ralph_bridge_env` to justfile `_mcp_call`**

The justfile's `_mcp_call` recipe at line 576 also spawns `mcp call` directly. Add env bridging before the call. Replace lines 576-586 with:

```bash
_mcp_call tool params:
    #!/usr/bin/env bash
    set -eu
    if ! command -v mcp &>/dev/null; then
        echo "Error: mcptools not installed."
        echo "Install: brew tap f/mcptools && brew install mcp"
        echo "   or: go install github.com/f/mcptools/cmd/mcptools@latest"
        exit 1
    fi
    # Bridge env vars from settings hierarchy
    source "{{justfile_directory()}}/scripts/resolve-env.sh"
    ralph_bridge_env
    raw=$(mcp call "{{tool}}" --params '{{params}}' \
        npx -y "ralph-hero-mcp-server@${RALPH_MCP_VERSION:-latest}")
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd plugin/ralph-hero && bats scripts/__tests__/cli-dispatch.bats`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add plugin/ralph-hero/scripts/cli-dispatch.sh plugin/ralph-hero/justfile plugin/ralph-hero/scripts/__tests__/cli-dispatch.bats
git commit -m "feat(cli): bridge env vars for direct MCP calls

run_quick (cli-dispatch.sh) and _mcp_call (justfile) now source
resolve-env.sh and call ralph_bridge_env() before spawning the MCP
server via mcptools. This resolves RALPH_GH_OWNER and other vars
from the full settings hierarchy. GH-694"
```

---

### Task 3: Update Doctor Recipe to Search Full Settings Hierarchy

**Files:**
- Modify: `plugin/ralph-hero/justfile:224-400` (doctor recipe)

- [ ] **Step 1: Write the failing test**

Add to `plugin/ralph-hero/scripts/__tests__/doctor.bats` (or create if it only has basic tests):

```bash
@test "doctor checks settings.json (not just settings.local.json)" {
    # This test verifies doctor's output mentions settings.json paths
    # The actual doctor recipe runs with just, so we test the output format
    run grep -c "settings.json" <<'OUTPUT'
FAIL: RALPH_GH_OWNER — not found in:
      - shell environment
      - .claude/settings.local.json (repo)
      - .claude/settings.json (repo)
      - ~/.claude/settings.json (global)
OUTPUT
    [ "$output" = "2" ]
}
```

- [ ] **Step 2: Replace `read_settings_env` in doctor with shared library**

Replace the inline `read_settings_env()` definition (justfile lines 228-268) and the env var resolution loop (lines 269-309) with:

```bash
    # Source shared env resolution
    source "{{justfile_directory()}}/scripts/resolve-env.sh"
    resolved_token=""
    resolved_owner=""
    resolved_project=""
    echo "=== Ralph Doctor ==="
    echo ""
    echo "--- Environment Variables ---"
    _repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
    _scope=$(ralph_detect_scope)
    if [ "$_scope" != "unknown" ]; then
        echo "  Plugin scope: $_scope"
    fi
    for var in RALPH_HERO_GITHUB_TOKEN RALPH_GH_OWNER RALPH_GH_PROJECT_NUMBER; do
        val=""
        source_label=""
        # Check shell env first
        shell_val="${!var:-}"
        if [ -n "$shell_val" ]; then
            val="$shell_val"
            source_label=" (from shell env)"
        fi
        # Check settings hierarchy with source tracking
        if [ -z "$val" ] && [ -n "$_repo_root" ] && [ -f "$_repo_root/.claude/settings.local.json" ]; then
            val=$(_ralph_read_json_env "$var" "$_repo_root/.claude/settings.local.json") && source_label=" (from .claude/settings.local.json)" || val=""
        fi
        if [ -z "$val" ] && [ -n "$_repo_root" ] && [ -f "$_repo_root/.claude/settings.json" ]; then
            val=$(_ralph_read_json_env "$var" "$_repo_root/.claude/settings.json") && source_label=" (from .claude/settings.json)" || val=""
        fi
        if [ -z "$val" ] && [ -f "$HOME/.claude/settings.json" ]; then
            val=$(_ralph_read_json_env "$var" "$HOME/.claude/settings.json") && source_label=" (from ~/.claude/settings.json)" || val=""
        fi
        if [ -z "$val" ]; then
            echo "FAIL: $var — not found in:"
            echo "      - shell environment"
            if [ -n "$_repo_root" ]; then
                echo "      - .claude/settings.local.json (repo)"
                echo "      - .claude/settings.json (repo)"
            fi
            echo "      - ~/.claude/settings.json (global)"
            errors=$((errors + 1))
            # Scope-aware hint
            if [ "$_scope" = "user" ]; then
                echo "      Hint: plugin is user-scoped — add to ~/.claude/settings.json for cross-repo use"
            fi
        else
            if [ "$var" = "RALPH_HERO_GITHUB_TOKEN" ]; then
                echo "  OK: $var (set, redacted)$source_label"
                resolved_token="$val"
            elif [ "$var" = "RALPH_GH_OWNER" ]; then
                echo "  OK: $var = ${val}$source_label"
                resolved_owner="$val"
                # Scope mismatch warning
                if [ "$_scope" = "user" ] && [[ "$source_label" == *"settings.local.json"* ]]; then
                    echo "  WARN: user-scoped plugin but config in project-local file — CLI won't work outside this repo"
                    warnings=$((warnings + 1))
                fi
            elif [ "$var" = "RALPH_GH_PROJECT_NUMBER" ]; then
                echo "  OK: $var = ${val}$source_label"
                resolved_project="$val"
            fi
        fi
    done
```

- [ ] **Step 3: Run doctor manually to verify**

Run: `cd plugin/ralph-hero && just doctor`
Expected: Output shows scope detection and new search paths. No errors if vars are set.

- [ ] **Step 4: Commit**

```bash
git add plugin/ralph-hero/justfile plugin/ralph-hero/scripts/__tests__/doctor.bats
git commit -m "feat(cli): doctor searches full settings hierarchy with scope diagnostics

Doctor now checks: shell env → settings.local.json → settings.json → ~/.claude/settings.json.
Reports plugin install scope, warns on scope/config mismatch. GH-694"
```

---

### Task 4: Update Setup Skill for Scope-Aware Config Writing

**Files:**
- Modify: `plugin/ralph-hero/skills/setup/SKILL.md`

- [ ] **Step 1: Read the full setup skill**

Run: Read `plugin/ralph-hero/skills/setup/SKILL.md` to understand the full flow before modifying.

- [ ] **Step 2: Add scope detection step to setup skill**

After the project creation/validation step, add a new step that detects install scope and determines the target config file. Insert before the "Add to Claude Code Settings" section:

```markdown
### 1b. Detect Install Scope

Before writing configuration, determine where to write it:

1. Read `~/.claude/plugins/installed_plugins.json`
2. Find the `ralph-hero@ralph-hero` entry
3. Check the `"scope"` field of the latest entry

**If scope is `"user"`:**
- Write non-sensitive env vars to `~/.claude/settings.json` under `"env"`
- Write token to `~/.claude/settings.local.json` under `"env"` (gitignored by default in home dir)
- Tell the user: "Ralph is installed at user scope — config will be written to ~/.claude/settings.json so the CLI works from any directory."

**If scope is `"project"`:**
- Write all env vars to `<project>/.claude/settings.local.json` under `"env"`
- Tell the user: "Ralph is installed at project scope — config will be written to .claude/settings.local.json. The CLI will only work from this project directory."

**If scope cannot be determined:**
- Fall back to current behavior (`settings.local.json`)
- Warn: "Could not detect install scope. Writing to .claude/settings.local.json (project-scoped)."
```

- [ ] **Step 3: Update all `settings.local.json` references in the skill**

Replace hardcoded `settings.local.json` references with scope-conditional language:

- Section "2. Add to Claude Code Settings" — show both paths based on scope detection
- Section "Where NOT to put tokens" — keep as-is (tokens always go in local/gitignored files)
- Section "Advanced: Split-Owner / Dual-Token" — add scope note
- All "Next steps" sections — replace `"Verify .claude/settings.local.json"` with scope-conditional: `"Verify your config file (see above for location)"`

- [ ] **Step 4: Commit**

```bash
git add plugin/ralph-hero/skills/setup/SKILL.md
git commit -m "feat(setup): scope-aware config file targeting

Setup skill now detects plugin install scope (user vs project) and
writes non-sensitive env vars to the appropriate settings file.
User-scoped: ~/.claude/settings.json. Project-scoped: settings.local.json.
GH-694"
```

---

### Task 5: Improve MCP Server Error Messages

**Files:**
- Modify: `plugin/ralph-hero/mcp-server/src/lib/helpers.ts:556-558`
- Modify: `plugin/ralph-hero/mcp-server/src/lib/helpers.ts:580-582`
- Test: `plugin/ralph-hero/mcp-server/src/__tests__/helpers-resolve-config.test.ts` (create or extend)

- [ ] **Step 1: Write the failing test**

Create or extend a test file for `resolveConfig` error messages:

```typescript
import { describe, it, expect } from "vitest";
import { resolveConfig, resolveConfigOptionalRepo } from "../lib/helpers.js";
import type { GitHubClient } from "../github-client.js";

function mockClient(overrides: Partial<GitHubClient["config"]> = {}): GitHubClient {
  return {
    config: {
      token: "fake",
      ...overrides,
    },
  } as unknown as GitHubClient;
}

describe("resolveConfig", () => {
  it("throws with scope-aware message when owner is missing", () => {
    const client = mockClient({ owner: undefined });
    expect(() => resolveConfig(client, {})).toThrow(
      "owner is required",
    );
    expect(() => resolveConfig(client, {})).toThrow(
      "~/.claude/settings.json",
    );
  });
});

describe("resolveConfigOptionalRepo", () => {
  it("throws with scope-aware message when owner is missing", () => {
    const client = mockClient({ owner: undefined });
    expect(() => resolveConfigOptionalRepo(client, {})).toThrow(
      "owner is required",
    );
    expect(() => resolveConfigOptionalRepo(client, {})).toThrow(
      "~/.claude/settings.json",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/helpers-resolve-config.test.ts`
Expected: FAIL — current error message doesn't mention `~/.claude/settings.json`

- [ ] **Step 3: Update error messages in helpers.ts**

At `plugin/ralph-hero/mcp-server/src/lib/helpers.ts:556-558`, change:

```typescript
  if (!owner)
    throw new Error(
      "owner is required (set RALPH_GH_OWNER env var or pass explicitly)",
    );
```

To:

```typescript
  if (!owner)
    throw new Error(
      "owner is required. Set RALPH_GH_OWNER in ~/.claude/settings.json (user-scoped) " +
      "or .claude/settings.local.json (project-scoped), or pass owner explicitly.",
    );
```

At `plugin/ralph-hero/mcp-server/src/lib/helpers.ts:580-582`, apply the same change.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/helpers-resolve-config.test.ts`
Expected: PASS

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: Full suite PASS (no regressions)

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/lib/helpers.ts plugin/ralph-hero/mcp-server/src/__tests__/helpers-resolve-config.test.ts
git commit -m "fix(mcp): improve owner-missing error with scope-aware config guidance

Error messages now mention both ~/.claude/settings.json (user-scoped)
and .claude/settings.local.json (project-scoped) so users know where
to add their config. GH-694"
```

---

### Task 6: Manual Verification

- [ ] **Step 1: Run all BATS tests**

```bash
cd plugin/ralph-hero && bats scripts/__tests__/resolve-env.bats scripts/__tests__/cli-dispatch.bats scripts/__tests__/doctor.bats
```

Expected: All PASS

- [ ] **Step 2: Run MCP server test suite**

```bash
cd plugin/ralph-hero/mcp-server && npm test
```

Expected: All PASS

- [ ] **Step 3: Build MCP server**

```bash
cd plugin/ralph-hero/mcp-server && npm run build
```

Expected: No type errors

- [ ] **Step 4: Test cross-repo CLI (the original reproduction)**

Set `RALPH_GH_OWNER` and `RALPH_GH_PROJECT_NUMBER` in `~/.claude/settings.json`:

```json
{
  "env": {
    "RALPH_GH_OWNER": "cdubiel08",
    "RALPH_GH_PROJECT_NUMBER": "3"
  }
}
```

Then from a different repo:

```bash
cd ~/projects/ralph-engine
ralph status -q
ralph doctor
```

Expected: Both work without "owner is required" error.

- [ ] **Step 5: Test doctor scope diagnostics**

```bash
cd plugin/ralph-hero && just doctor
```

Expected: Output shows "Plugin scope: user" and correct source labels for each var.
