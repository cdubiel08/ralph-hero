# Ralph CLI Reliability & UX Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix bash 3.2 crashes, eliminate version skew, flatten command namespace, improve doctor reliability, and add bats test coverage for the ralph CLI.

**Architecture:** The fix preserves the existing 4-layer architecture (ralph-cli.sh → just → recipe body → cli-dispatch.sh) while patching bash 3.2 array handling, replacing hardcoded versions with runtime resolution, adding flat-namespace recipes using just's native parameter system, and wrapping it all in bats-core tests.

**Tech Stack:** Bash, just (justfile), bats-core (testing), GitHub Actions (CI)

**Spec:** `docs/superpowers/specs/2026-03-19-ralph-cli-reliability-design.md`

---

### Task 1: Set up bats-core test infrastructure

**Files:**
- Create: `plugin/ralph-hero/scripts/__tests__/cli-dispatch.bats`

- [ ] **Step 1: Create the test directory and a minimal smoke test**

```bash
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
```

- [ ] **Step 2: Verify bats is installed, install if needed**

Run: `command -v bats || brew install bats-core`
Expected: bats available at a path

- [ ] **Step 3: Run the smoke test to verify infrastructure works**

Run: `cd /Users/dubiel/projects/ralph-hero && bats plugin/ralph-hero/scripts/__tests__/cli-dispatch.bats`
Expected: `1 test, 0 failures`

- [ ] **Step 4: Commit**

```bash
git add plugin/ralph-hero/scripts/__tests__/cli-dispatch.bats
git commit -m "test: add bats-core test infrastructure for CLI scripts"
```

---

### Task 2: Fix bash 3.2 empty array crash in cli-dispatch.sh

**Files:**
- Modify: `plugin/ralph-hero/scripts/cli-dispatch.sh:5,146-161`
- Modify: `plugin/ralph-hero/scripts/__tests__/cli-dispatch.bats`

- [ ] **Step 1: Write failing tests for bash 3.2 compatibility**

Add to `cli-dispatch.bats`:

```bash
# --- Bash 3.2 compatibility ---

@test "parse_mode with no args produces empty ARGS array" {
    parse_mode
    [ ${#ARGS[@]} -eq 0 ]
}

@test "dispatch with no extra args does not crash" {
    # Mock run_headless to capture the call instead of running claude
    run_headless() { echo "headless: $*"; }
    run_interactive() { echo "interactive: $*"; }
    dispatch "test-skill"
    # If we get here without "unbound variable" error, the fix works
}

@test "dispatch with -i flag and no other args does not crash" {
    run_interactive() { echo "interactive: $*"; }
    DEFAULT_MODE=headless
    parse_mode "-i"
    # ARGS should be empty, MODE should be interactive
    [ "$MODE" = "interactive" ]
    [ ${#ARGS[@]} -eq 0 ]
}
```

- [ ] **Step 2: Run tests to verify they fail on current code**

Run: `cd /Users/dubiel/projects/ralph-hero && bats plugin/ralph-hero/scripts/__tests__/cli-dispatch.bats`
Expected: "dispatch with no extra args does not crash" FAILS with `ARGS[@]: unbound variable`

- [ ] **Step 3: Fix the empty array expansion in dispatch()**

In `plugin/ralph-hero/scripts/cli-dispatch.sh`, change lines 151-152 in the `dispatch()` function:

```bash
# Before (line 151-152):
        headless)    run_headless "$skill" "${ARGS[@]}" ;;
        interactive) run_interactive "${INTERACTIVE_SKILL:-$skill}" "${ARGS[@]}" ;;

# After:
        headless)    run_headless "$skill" ${ARGS[@]+"${ARGS[@]}"} ;;
        interactive) run_interactive "${INTERACTIVE_SKILL:-$skill}" ${ARGS[@]+"${ARGS[@]}"} ;;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/dubiel/projects/ralph-hero && bats plugin/ralph-hero/scripts/__tests__/cli-dispatch.bats`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/scripts/cli-dispatch.sh plugin/ralph-hero/scripts/__tests__/cli-dispatch.bats
git commit -m "fix: bash 3.2 empty array crash in cli-dispatch.sh

Replace \${ARGS[@]} with \${ARGS[@]+\"\${ARGS[@]}\"} pattern
to handle empty arrays under set -u on macOS bash 3.2.57."
```

---

### Task 3: Runtime version resolution

**Files:**
- Modify: `plugin/ralph-hero/scripts/cli-dispatch.sh:5`
- Modify: `plugin/ralph-hero/scripts/ralph-cli.sh:93-95`
- Modify: `plugin/ralph-hero/justfile:472-498` (`_mcp_call` recipe)
- Modify: `plugin/ralph-hero/scripts/__tests__/cli-dispatch.bats`

- [ ] **Step 1: Write failing tests for version resolution**

Add to `cli-dispatch.bats`:

```bash
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/dubiel/projects/ralph-hero && bats plugin/ralph-hero/scripts/__tests__/cli-dispatch.bats`
Expected: Both version tests FAIL (MCP_VERSION is hardcoded "2.5.24")

- [ ] **Step 3: Fix cli-dispatch.sh version resolution**

In `plugin/ralph-hero/scripts/cli-dispatch.sh`, change line 5:

```bash
# Before:
MCP_VERSION="2.5.24"

# After:
MCP_VERSION="${RALPH_MCP_VERSION:-latest}"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/dubiel/projects/ralph-hero && bats plugin/ralph-hero/scripts/__tests__/cli-dispatch.bats`
Expected: All tests pass

- [ ] **Step 5: Export RALPH_MCP_VERSION from ralph-cli.sh**

In `plugin/ralph-hero/scripts/ralph-cli.sh`, add the export before the `exec` on line 95. Insert between line 93 (the `fi` closing the welcome banner) and line 95 (`exec just`):

```bash
# Export version for cli-dispatch.sh and justfile _mcp_call
export RALPH_MCP_VERSION="${LATEST:-latest}"

exec just --justfile "$RALPH_JUSTFILE" "$@"
```

- [ ] **Step 6: Fix justfile _mcp_call version**

In `plugin/ralph-hero/justfile`, change the `_mcp_call` recipe (line 483):

```bash
# Before:
    raw=$(mcp call "{{tool}}" --params '{{params}}' \
        npx -y ralph-hero-mcp-server@2.5.24)

# After:
    raw=$(mcp call "{{tool}}" --params '{{params}}' \
        npx -y "ralph-hero-mcp-server@${RALPH_MCP_VERSION:-latest}")
```

- [ ] **Step 7: Commit**

```bash
git add plugin/ralph-hero/scripts/cli-dispatch.sh plugin/ralph-hero/scripts/ralph-cli.sh plugin/ralph-hero/justfile plugin/ralph-hero/scripts/__tests__/cli-dispatch.bats
git commit -m "fix: eliminate hardcoded MCP version, resolve at runtime

ralph-cli.sh exports RALPH_MCP_VERSION from plugin cache.
cli-dispatch.sh and justfile _mcp_call read from env,
falling back to 'latest' npm tag for direct just usage."
```

---

### Task 4: Add mode parsing tests

**Files:**
- Modify: `plugin/ralph-hero/scripts/__tests__/cli-dispatch.bats`

- [ ] **Step 1: Add comprehensive parse_mode tests**

Add to `cli-dispatch.bats`:

```bash
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
```

- [ ] **Step 2: Run tests to verify they all pass**

Run: `cd /Users/dubiel/projects/ralph-hero && bats plugin/ralph-hero/scripts/__tests__/cli-dispatch.bats`
Expected: All tests pass (these test existing correct behavior)

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/scripts/__tests__/cli-dispatch.bats
git commit -m "test: add comprehensive parse_mode unit tests"
```

---

### Task 5: Flat-namespace command recipes

**Files:**
- Modify: `plugin/ralph-hero/justfile:11-17,109-119,383-440`

- [ ] **Step 1: Add flat-namespace command recipes to justfile**

Add the following recipes after the existing aliases block (after line 17), before the `default:` recipe:

```just
# Create a new issue
[group('commands')]
issue title priority="" estimate="" state="Backlog" label="":
    #!/usr/bin/env bash
    set -eu
    params='{"title":"{{title}}"'
    if [ -n "{{priority}}" ]; then params="$params,\"priority\":\"{{priority}}\""; fi
    if [ -n "{{estimate}}" ]; then params="$params,\"estimate\":\"{{estimate}}\""; fi
    if [ -n "{{label}}" ]; then params="$params,\"labels\":[\"{{label}}\"]"; fi
    params="$params,\"workflowState\":\"{{state}}\"}"
    just _mcp_call "ralph_hero__create_issue" "$params"

# Move issue to a workflow state
[group('commands')]
move number state:
    @just _mcp_call "ralph_hero__save_issue" \
        '{"number":{{number}},"workflowState":"{{state}}","command":"ralph_cli"}'

# Get issue details
[group('commands')]
info number:
    @just _mcp_call "ralph_hero__get_issue" \
        '{"number":{{number}}}'

# Add comment to an issue
[group('commands')]
comment number body:
    @just _mcp_call "ralph_hero__create_comment" \
        '{"number":{{number}},"body":"{{body}}"}'

# Assign issue to a user
[group('commands')]
assign number user:
    @just _mcp_call "ralph_hero__save_issue" \
        '{"number":{{number}},"assignees":["{{user}}"]}'

# Find next actionable issue
[group('commands')]
pick state="Research Needed" max-estimate="S":
    @just _mcp_call "ralph_hero__pick_actionable_issue" \
        '{"workflowState":"{{state}}","maxEstimate":"{{max-estimate}}"}'

# Create a draft card on the board
[group('commands')]
draft title priority="" estimate="" state="Backlog":
    #!/usr/bin/env bash
    set -eu
    params='{"title":"{{title}}"'
    if [ -n "{{priority}}" ]; then params="$params,\"priority\":\"{{priority}}\""; fi
    if [ -n "{{estimate}}" ]; then params="$params,\"estimate\":\"{{estimate}}\""; fi
    params="$params,\"workflowState\":\"{{state}}\"}"
    just _mcp_call "ralph_hero__create_draft_issue" "$params"
```

- [ ] **Step 2: Change status recipe to default to quick mode**

In the `status` recipe (currently line 110-119), add `DEFAULT_MODE=quick`:

```just
# Display pipeline status dashboard with health indicators
[group('workflow')]
status *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_MODE=quick DEFAULT_BUDGET=0.50 DEFAULT_TIMEOUT=10m
    QUICK_TOOL="ralph_hero__pipeline_dashboard" QUICK_PARAMS='{"format":"markdown","includeHealth":true}'
    _args={{quote(args)}}
    set -- $_args
    dispatch "status" "$@"
```

- [ ] **Step 3: Mark old quick-* recipes as private**

Add `[private]` attribute to each existing `quick-*` recipe. Change `[group('quick')]` to `[private]` for: `quick-status`, `quick-move`, `quick-pick`, `quick-assign`, `quick-issue`, `quick-info`, `quick-comment`, `quick-draft`.

Example for `quick-status`:

```just
# Pipeline status dashboard - instant, no API cost
[private]
quick-status format="markdown":
    @just _mcp_call "ralph_hero__pipeline_dashboard" \
        '{"format":"{{format}}","includeHealth":true}'
```

- [ ] **Step 4: Verify justfile parses correctly**

Run: `cd /Users/dubiel/projects/ralph-hero/plugin/ralph-hero && just --summary`
Expected: New recipes (`issue`, `move`, `info`, `comment`, `assign`, `pick`, `draft`) appear. Old `quick-*` recipes do NOT appear (they're private).

- [ ] **Step 5: Verify just --list shows grouped commands**

Run: `cd /Users/dubiel/projects/ralph-hero/plugin/ralph-hero && just --list`
Expected: New `[commands]` group visible with `issue`, `move`, `info`, etc.

- [ ] **Step 6: Commit**

```bash
git add plugin/ralph-hero/justfile
git commit -m "feat: add flat-namespace command recipes, default status to quick

Add issue, move, info, comment, assign, pick, draft as top-level
recipes using just's native key=value parameter system.
Mark old quick-* recipes as private.
Change status default from headless to quick mode."
```

---

### Task 6: Doctor reliability improvements

**Files:**
- Modify: `plugin/ralph-hero/justfile:170-297` (doctor recipe)
- Create: `plugin/ralph-hero/scripts/__tests__/doctor.bats`

- [ ] **Step 1: Write doctor settings resolution tests**

Create `plugin/ralph-hero/scripts/__tests__/doctor.bats`:

```bash
#!/usr/bin/env bats
# doctor.bats — Tests for doctor's read_settings_env function

# Extract read_settings_env from the justfile doctor recipe.
# Since it's embedded in a justfile recipe, we re-define it here
# to test in isolation.

setup() {
    TEST_DIR=$(mktemp -d)
    mkdir -p "$TEST_DIR/.claude"
    cat > "$TEST_DIR/.claude/settings.local.json" <<'JSON'
{
    "env": {
        "RALPH_GH_OWNER": "testowner",
        "RALPH_HERO_GITHUB_TOKEN": "ghp_testtoken123",
        "RALPH_GH_PROJECT_NUMBER": "7"
    }
}
JSON

    # Define the function under test (mirrors justfile doctor recipe)
    read_settings_env() {
        local var="$1"
        local found_in=""
        local paths=()

        # 1. Repo-local settings
        local repo_root
        repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
        if [ -n "$repo_root" ] && [ -f "$repo_root/.claude/settings.local.json" ]; then
            paths+=("$repo_root/.claude/settings.local.json")
        fi

        # 2. Global settings
        if [ -f "$HOME/.claude/settings.local.json" ]; then
            paths+=("$HOME/.claude/settings.local.json")
        fi

        for settings_file in ${paths[@]+"${paths[@]}"}; do
            local val
            val=$(node -e "
                const s = JSON.parse(require('fs').readFileSync('$settings_file','utf8'));
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

@test "read_settings_env finds var in global settings.local.json" {
    HOME="$TEST_DIR" run read_settings_env "RALPH_GH_OWNER"
    [ "$status" -eq 0 ]
    [ "$output" = "testowner" ]
}

@test "read_settings_env returns failure when var not present" {
    HOME="$TEST_DIR" run read_settings_env "NONEXISTENT_VAR"
    [ "$status" -ne 0 ]
}

@test "read_settings_env skips unexpanded template vars" {
    cat > "$TEST_DIR/.claude/settings.local.json" <<'JSON'
{"env": {"RALPH_GH_OWNER": "${SOME_UNSET_VAR}"}}
JSON
    HOME="$TEST_DIR" run read_settings_env "RALPH_GH_OWNER"
    [ "$status" -ne 0 ]
}

@test "read_settings_env returns failure when no settings files exist" {
    EMPTY_DIR=$(mktemp -d)
    HOME="$EMPTY_DIR" run read_settings_env "RALPH_GH_OWNER"
    [ "$status" -ne 0 ]
    rm -rf "$EMPTY_DIR"
}
```

- [ ] **Step 2: Run tests to verify they pass (testing the function directly)**

Run: `cd /Users/dubiel/projects/ralph-hero && bats plugin/ralph-hero/scripts/__tests__/doctor.bats`
Expected: All tests pass (we defined the improved function in the test itself)

- [ ] **Step 3: Update read_settings_env() and env var loop in doctor recipe**

In `plugin/ralph-hero/justfile`, replace `read_settings_env` (lines 176-189) with a version that accepts an optional explicit path for provenance tracking:

```bash
    read_settings_env() {
        local var="$1"
        local settings_file="${2:-}"
        # If explicit path given, only check that path
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
        # No explicit path — try all known locations
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
```

Then replace the env var checking loop (lines 196-217) to show provenance. **Important:** the loop body runs at recipe scope (not inside a function), so use plain variables — not `local`:

```bash
    # Resolve repo root once for the loop (no 'local' — we're at recipe scope, not in a function)
    _repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
    for var in RALPH_HERO_GITHUB_TOKEN RALPH_GH_OWNER RALPH_GH_PROJECT_NUMBER; do
        val="${!var:-}"
        source_label=""
        if [ -n "$val" ]; then
            source_label=" (from shell env)"
        else
            # Try repo-local settings first, then global
            if [ -n "$_repo_root" ] && [ -f "$_repo_root/.claude/settings.local.json" ]; then
                val=$(read_settings_env "$var" "$_repo_root/.claude/settings.local.json") && source_label=" (from .claude/settings.local.json)" || val=""
            fi
            if [ -z "$val" ] && [ -f "$HOME/.claude/settings.local.json" ]; then
                val=$(read_settings_env "$var" "$HOME/.claude/settings.local.json") && source_label=" (from ~/.claude/settings.local.json)" || val=""
            fi
        fi
        if [ -z "$val" ]; then
            echo "FAIL: $var — not found in:"
            echo "      - shell environment"
            if [ -n "$_repo_root" ]; then echo "      - .claude/settings.local.json (repo)"; fi
            echo "      - ~/.claude/settings.local.json (global)"
            errors=$((errors + 1))
        else
            if [ "$var" = "RALPH_HERO_GITHUB_TOKEN" ]; then
                echo "  OK: $var (set, redacted)$source_label"
                resolved_token="$val"
            elif [ "$var" = "RALPH_GH_OWNER" ]; then
                echo "  OK: $var = ${val}$source_label"
                resolved_owner="$val"
            elif [ "$var" = "RALPH_GH_PROJECT_NUMBER" ]; then
                echo "  OK: $var = ${val}$source_label"
                resolved_project="$val"
            fi
        fi
    done
```

- [ ] **Step 5: Add version section to doctor output**

Add after the "Plugin Files" section (before the API Health Check), around line 265:

```bash
    echo "--- Version ---"
    if [ -n "${RALPH_MCP_VERSION:-}" ]; then
        echo "  OK: ralph v${RALPH_MCP_VERSION} (from RALPH_MCP_VERSION)"
    elif [ -d "$HOME/.claude/plugins/cache/ralph-hero/ralph-hero" ]; then
        cache_ver=$(ls "$HOME/.claude/plugins/cache/ralph-hero/ralph-hero" | sort -V | tail -1)
        echo "  OK: ralph v${cache_ver} (from plugin cache)"
    else
        echo "WARN: version unknown — plugin cache not found"
        warnings=$((warnings + 1))
    fi
    echo ""
```

- [ ] **Step 6: Update mcptools warning message**

Change the mcptools warning (around line 231) to reference the new command names:

```bash
    # Before:
        echo "WARN: mcp (mcptools) not installed -- quick-* recipes unavailable"

    # After:
        echo "WARN: mcp (mcptools) not installed -- quick commands unavailable"
```

- [ ] **Step 7: Run doctor tests again**

Run: `cd /Users/dubiel/projects/ralph-hero && bats plugin/ralph-hero/scripts/__tests__/doctor.bats`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add plugin/ralph-hero/justfile plugin/ralph-hero/scripts/__tests__/doctor.bats
git commit -m "fix: doctor reliability — multi-path settings resolution, provenance labels

read_settings_env() now checks repo-local then global settings.local.json.
Each env var shows its source. Version section added to doctor output."
```

---

### Task 7: Error messages and help text in ralph-cli.sh

**Files:**
- Modify: `plugin/ralph-hero/scripts/ralph-cli.sh:37-70,72-76,93-95`
- Create: `plugin/ralph-hero/scripts/__tests__/ralph-cli.bats`

- [ ] **Step 1: Write integration tests for ralph-cli.sh**

Create `plugin/ralph-hero/scripts/__tests__/ralph-cli.bats`:

```bash
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
```

- [ ] **Step 2: Run tests to see which fail**

Run: `cd /Users/dubiel/projects/ralph-hero && bats plugin/ralph-hero/scripts/__tests__/ralph-cli.bats`
Expected: --version and --help tests may pass (help has old content), unknown-command tests FAIL (no pre-flight check yet)

- [ ] **Step 3: Update help text in ralph-cli.sh**

In `plugin/ralph-hero/scripts/ralph-cli.sh`, replace the `--help` heredoc (lines 38-68) with:

```bash
    cat <<EOF
Usage: ralph <command> [options]

Ralph Hero — autonomous GitHub Projects V2 workflow automation.

Workflow commands (AI-powered):
  triage              Triage backlog issues
  research            Investigate an issue
  plan                Write implementation plan
  impl                Implement from plan
  review              Critique a plan
  hygiene             Run project hygiene
  report              Post status report

Quick commands (instant, no AI cost):
  status              Pipeline dashboard
  issue <title>       Create a new issue
  move <num> <state>  Change workflow state
  info <num>          Get issue details
  comment <num> <body>  Add a comment
  assign <num> <user> Assign to a user
  pick                Find next actionable issue
  draft <title>       Create a draft card

Orchestrators:
  hero                Drive issue through full lifecycle
  team                Spawn multi-agent team
  loop                Sequential autonomous loop

Setup:
  doctor              Diagnose installation
  setup               Create GitHub Project V2

Options:
  --version, -V       Print installed version
  --help, -h          Print this help
  -i                  Interactive mode (opens Claude session)
  -q                  Quick mode (direct MCP call)
  --budget=N          Spend cap in USD (default varies by command)
  --timeout=T         Per-task timeout (default: 15m)

Examples:
  ralph status                              # Pipeline dashboard (instant)
  ralph issue "fix login bug" priority=P1   # Create issue with priority
  ralph triage                              # Triage next backlog issue
  ralph move 42 "In Progress"              # Move issue to new state
  ralph impl -i 42                          # Implement interactively

Docs: https://github.com/cdubiel08/ralph-hero
EOF
```

- [ ] **Step 4: Add pre-flight recipe check and RALPH_MCP_VERSION export**

In `plugin/ralph-hero/scripts/ralph-cli.sh`, replace lines 93-95 (welcome banner `fi` through `exec just`) with:

```bash
fi

# Export version for cli-dispatch.sh and justfile _mcp_call
export RALPH_MCP_VERSION="${LATEST:-latest}"

# Pre-flight: check if recipe exists before exec (preserves streaming)
if [ $# -gt 0 ]; then
    _recipe="$1"
    # Skip pre-flight for flags (--help, --version already handled above)
    case "$_recipe" in
        -*) ;;  # flags pass through to just
        *)
            _recipes=$(just --justfile "$RALPH_JUSTFILE" --summary 2>/dev/null)
            if ! echo "$_recipes" | tr ' ' '\n' | grep -qx "$_recipe"; then
                # Try prefix match (e.g., "isue" → "issue")
                _suggestion=$(echo "$_recipes" | tr ' ' '\n' | grep "^${_recipe:0:3}" | head -1)
                # Try substring match as fallback
                if [ -z "$_suggestion" ]; then
                    _suggestion=$(echo "$_recipes" | tr ' ' '\n' | grep "$_recipe" | head -1)
                fi
                echo "Error: Unknown command '$_recipe'."
                if [ -n "${_suggestion:-}" ]; then
                    echo "Did you mean '$_suggestion'?"
                fi
                echo ""
                echo "Run 'ralph --help' for available commands."
                exit 1
            fi
            ;;
    esac
fi

exec just --justfile "$RALPH_JUSTFILE" "$@"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/dubiel/projects/ralph-hero && bats plugin/ralph-hero/scripts/__tests__/ralph-cli.bats`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add plugin/ralph-hero/scripts/ralph-cli.sh plugin/ralph-hero/scripts/__tests__/ralph-cli.bats
git commit -m "feat: pre-flight command validation, updated help text

Add recipe existence check with typo suggestions before exec.
Update --help to show grouped flat-namespace commands.
Export RALPH_MCP_VERSION for downstream version resolution."
```

---

### Task 8: CI integration

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add bats test job to CI workflow**

In `.github/workflows/ci.yml`, add a new job after the existing jobs:

```yaml
  test-cli:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js (for doctor tests)
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install just
        uses: extractions/setup-just@v2

      - name: Run CLI tests
        uses: bats-core/bats-action@2.0.0
        with:
          support-path: plugin/ralph-hero/scripts/__tests__
          tests-path: plugin/ralph-hero/scripts/__tests__
```

- [ ] **Step 2: Verify CI file is valid YAML**

Run: `cd /Users/dubiel/projects/ralph-hero && node -e "const yaml = require('yaml'); yaml.parse(require('fs').readFileSync('.github/workflows/ci.yml', 'utf8')); console.log('Valid YAML')"`

If `yaml` module isn't available, use: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('Valid YAML')"`

Expected: `Valid YAML`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add bats-core CLI test job to CI workflow"
```

---

### Task 9: End-to-end verification

**Files:** None (verification only)

- [ ] **Step 1: Run the full bats test suite**

Run: `cd /Users/dubiel/projects/ralph-hero && bats plugin/ralph-hero/scripts/__tests__/*.bats`
Expected: All tests pass across all three test files

- [ ] **Step 2: Manually test the critical user scenario**

Run from a directory outside the repo to simulate the original failing commands:

```bash
# These were the original failing commands:
ralph status
ralph triage
ralph --help
```

Expected:
- `ralph status` shows pipeline dashboard (quick mode, no AI)
- `ralph triage` starts headless triage (or errors cleanly if no API token in shell)
- `ralph --help` shows the new grouped command list

- [ ] **Step 3: Test the new flat-namespace commands**

```bash
ralph info 42          # Should show issue details (requires mcptools)
ralph issue --help     # Should show just's parameter help for the recipe
```

- [ ] **Step 4: Test error messages**

```bash
ralph isue "test"      # Should suggest "issue"
ralph xyzzy            # Should show "Unknown command" + help hint
```

- [ ] **Step 5: Test doctor outside the repo**

```bash
cd /tmp && ralph doctor
```

Expected: Doctor finds env vars from `~/.claude/settings.local.json` (global path), shows provenance labels, doesn't crash.
