# Ralph CLI Reliability & UX Overhaul

**Date:** 2026-03-19
**Status:** Draft
**Scope:** `plugin/ralph-hero/scripts/cli-dispatch.sh`, `plugin/ralph-hero/scripts/ralph-cli.sh`, `plugin/ralph-hero/justfile`, `plugin/ralph-hero/scripts/__tests__/`

## Problem

The `ralph` global CLI has multiple reliability and UX issues:

1. **Bash 3.2 crash** — `${ARGS[@]}` under `set -u` with an empty array is treated as unbound on macOS's system bash (3.2.57). This breaks almost every command when invoked without extra args (`ralph triage`, `ralph status`, etc.).
2. **Version skew** — `MCP_VERSION` is hardcoded as `"2.5.24"` in both `cli-dispatch.sh` and the justfile's `_mcp_call`, while the installed plugin is at 2.5.39. Every release requires manual updates in two places.
3. **Doctor false positives** — `read_settings_env()` uses `git rev-parse --show-toplevel` to locate `settings.local.json`, which fails when `ralph doctor` is run outside the repository. Environment variables appear missing even though they're configured.
4. **Fragmented command namespace** — Quick data operations (`quick-issue`, `quick-move`, `quick-status`, etc.) use a `quick-*` prefix that doesn't match user expectations. `ralph issue "fix the thing"` fails with "recipe not found."
5. **Poor error messages** — Unknown commands get just's raw "does not contain recipe" error with no suggestions. Missing dependencies lack actionable install instructions.

## Design

### 1. Bash 3.2 Compatibility

**File:** `cli-dispatch.sh`

Replace all `"${ARGS[@]}"` expansions with the bash 3.2-safe pattern:

```bash
# Before (crashes on bash 3.2 with empty arrays under set -u)
run_headless "$skill" "${ARGS[@]}"

# After (safe on all bash versions)
run_headless "$skill" ${ARGS[@]+"${ARGS[@]}"}
```

Two occurrences in `dispatch()` need the fix:
- Line 151: headless case — `"${ARGS[@]}"` → `${ARGS[@]+"${ARGS[@]}"}`
- Line 152: interactive case — same pattern

Line 155 (`"${QUICK_PARAMS:-{}}"`) is already safe — it uses `:-` default, not an array expansion.

### 2. Runtime Version Resolution

**Files:** `ralph-cli.sh`, `cli-dispatch.sh`, `justfile`

Eliminate all hardcoded `MCP_VERSION` values. Version is resolved once and flows via environment variable.

**ralph-cli.sh** — already resolves `$LATEST` from the plugin cache. Export it:

```bash
export RALPH_MCP_VERSION="${LATEST:-latest}"
exec just --justfile "$RALPH_JUSTFILE" "$@"
```

**cli-dispatch.sh** — read from environment instead of hardcoding:

```bash
# Before
MCP_VERSION="2.5.24"

# After
MCP_VERSION="${RALPH_MCP_VERSION:-latest}"
```

When `latest` is used as the npm tag, `npx -y ralph-hero-mcp-server@latest` fetches the current published version. This is the correct fallback for direct `just` usage outside the global CLI.

**justfile `_mcp_call`** — same pattern:

```bash
# Before
npx -y ralph-hero-mcp-server@2.5.24

# After
npx -y "ralph-hero-mcp-server@${RALPH_MCP_VERSION:-latest}"
```

### 3. Flat-Namespace Commands

**File:** `justfile`

Add first-class recipes for data operations using just's native `key=value` parameter system. Group under `[group('commands')]`.

#### New recipes

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

#### Status defaults to quick

Change the `status` recipe to default to quick mode:

```just
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

`ralph status` now hits MCP directly (instant, no AI cost). `ralph status -i` opens an AI-powered session.

**Note:** This is a behavioral change — `ralph status` previously defaulted to headless (AI-powered). The new default is quick mode since the pipeline dashboard is a pure data query that doesn't benefit from AI processing.

#### Old quick-* recipes

Mark all existing `quick-*` recipes as `[private]` so they don't appear in `--list` or completions, but remain available for backwards compatibility and direct `just` usage.

### 4. Doctor Reliability

**File:** `justfile` (doctor recipe)

#### Multi-path settings resolution

Update `read_settings_env()` to try multiple paths:

```bash
read_settings_env() {
    local var="$1"
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

    for settings_file in "${paths[@]+"${paths[@]}"}"; do
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
```

#### Clearer output

Show provenance for each resolved variable:

```
--- Environment Variables ---
  OK: RALPH_GH_OWNER = dubiel (from ~/.claude/settings.local.json)
  OK: RALPH_HERO_GITHUB_TOKEN (set, redacted) (from shell env)
FAIL: RALPH_GH_PROJECT_NUMBER — not found in:
      - shell environment
      - .claude/settings.local.json (repo)
      - ~/.claude/settings.local.json (global)
```

#### Version reporting

Add a version section to doctor output:

```
--- Version ---
  OK: ralph v2.5.39 (plugin cache: ~/.claude/plugins/cache/ralph-hero/ralph-hero/2.5.39)
```

### 5. Error Messages

**File:** `ralph-cli.sh`

#### Unknown command suggestions

Use a pre-flight recipe existence check before calling `exec just`. This preserves streaming output for all commands (important for long-running AI workflows like `ralph impl`) while still catching unknown commands:

```bash
# Pre-flight: check if recipe exists before exec
_recipe="$1"
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
exec just --justfile "$RALPH_JUSTFILE" "$@"
```

This approach:
- Runs the check before `exec`, so streaming output is never interrupted
- Uses `grep` prefix matching (3-char prefix) — no Perl regex, works on macOS
- Falls back to substring matching for less obvious typos
- Only adds one `just --summary` call overhead (fast, no API calls)

#### Missing dependency errors

Clear, actionable messages when `mcp` (mcptools) isn't installed and a quick command is invoked:

```
Error: Quick commands require mcptools.
Install: brew install mcptools
```

#### Missing plugin cache

```
Error: No ralph-hero plugin found in ~/.claude/plugins/cache/
Install: claude plugin install ralph-hero
```

### 6. Help Text

**File:** `ralph-cli.sh`

Update `--help` to show the flat namespace with grouped commands:

```
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
```

### 7. Completions

**No changes required.** The zsh and bash completions scripts use `just --summary` to discover recipes dynamically. New flat-namespace recipes automatically appear. Old `quick-*` recipes marked `[private]` automatically disappear from completions.

### 8. Test Suite (bats-core)

**Directory:** `plugin/ralph-hero/scripts/__tests__/`

#### cli-dispatch.bats — Unit tests

Source `cli-dispatch.sh` and test functions in isolation:

```bash
setup() {
    source "${BATS_TEST_DIRNAME}/../cli-dispatch.sh"
}

# --- Bash 3.2 compatibility ---

@test "parse_mode with no args produces empty ARGS array" {
    parse_mode
    [ ${#ARGS[@]} -eq 0 ]
}

@test "dispatch with no extra args does not crash" {
    # Mock run_headless to just echo
    run_headless() { echo "called: $*"; }
    dispatch "test-skill"
    # Should not error — the bash 3.2 empty array fix is the point
}

# --- Mode parsing ---

@test "parse_mode defaults to headless" {
    parse_mode
    [ "$MODE" = "headless" ]
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

# --- Version resolution ---

@test "MCP_VERSION uses RALPH_MCP_VERSION when set" {
    RALPH_MCP_VERSION="2.5.39"
    source "${BATS_TEST_DIRNAME}/../cli-dispatch.sh"
    [ "$MCP_VERSION" = "2.5.39" ]
}

@test "MCP_VERSION falls back to latest when RALPH_MCP_VERSION unset" {
    unset RALPH_MCP_VERSION
    source "${BATS_TEST_DIRNAME}/../cli-dispatch.sh"
    [ "$MCP_VERSION" = "latest" ]
}
```

#### ralph-cli.bats — Integration tests

Test the `ralph` CLI end-to-end:

```bash
setup() {
    RALPH_CLI="${BATS_TEST_DIRNAME}/../ralph-cli.sh"
}

@test "ralph --version prints version" {
    run "$RALPH_CLI" --version
    [ "$status" -eq 0 ]
    [[ "$output" =~ ^ralph\ version ]]
}

@test "ralph --help shows grouped command sections" {
    run "$RALPH_CLI" --help
    [ "$status" -eq 0 ]
    [[ "$output" =~ "Workflow commands" ]]
    [[ "$output" =~ "Quick commands" ]]
    [[ "$output" =~ "Orchestrators" ]]
}

@test "ralph unknown-command suggests closest match" {
    run "$RALPH_CLI" "isue"
    [ "$status" -ne 0 ]
    [[ "$output" =~ "Did you mean" ]]
    [[ "$output" =~ "issue" ]]
}

@test "ralph with missing plugin cache shows install instructions" {
    RALPH_JUSTFILE="" run "$RALPH_CLI" status
    [ "$status" -ne 0 ]
    [[ "$output" =~ "not found" ]]
}
```

#### doctor.bats — Settings resolution tests

```bash
setup() {
    TEST_DIR=$(mktemp -d)
    mkdir -p "$TEST_DIR/.claude"
    # Create a mock settings.local.json
    cat > "$TEST_DIR/.claude/settings.local.json" <<'JSON'
{
    "env": {
        "RALPH_GH_OWNER": "testowner",
        "RALPH_HERO_GITHUB_TOKEN": "ghp_testtoken123",
        "RALPH_GH_PROJECT_NUMBER": "7"
    }
}
JSON
}

teardown() {
    rm -rf "$TEST_DIR"
}

@test "read_settings_env finds var in settings.local.json" {
    # Override HOME to use test dir
    HOME="$TEST_DIR" run read_settings_env "RALPH_GH_OWNER"
    [ "$status" -eq 0 ]
    [ "$output" = "testowner" ]
}

@test "read_settings_env returns failure when var missing" {
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
```

#### CI integration

Add a bats step to `.github/workflows/ci.yml`:

```yaml
  test-cli:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: bats-core/bats-action@2.0.0
        with:
          support-path: plugin/ralph-hero/scripts/__tests__
          tests-path: plugin/ralph-hero/scripts/__tests__
```

## Files Changed

| File | Change |
|------|--------|
| `plugin/ralph-hero/scripts/cli-dispatch.sh` | Bash 3.2 fix, runtime version resolution |
| `plugin/ralph-hero/scripts/ralph-cli.sh` | Export `RALPH_MCP_VERSION`, error suggestions, updated help |
| `plugin/ralph-hero/justfile` | Flat-namespace recipes, status defaults to quick, `quick-*` marked private, `_mcp_call` uses env version |
| `plugin/ralph-hero/scripts/__tests__/cli-dispatch.bats` | New — unit tests |
| `plugin/ralph-hero/scripts/__tests__/ralph-cli.bats` | New — integration tests |
| `plugin/ralph-hero/scripts/__tests__/doctor.bats` | New — doctor/settings tests |
| `.github/workflows/ci.yml` | Add bats test job |

## Out of Scope

- Removing the justfile layer (decided to keep)
- Subcommand-style routing (decided on flat namespace with just's native params)
- `--key value` flag syntax (using just's `key=value` parameter system)
- Changes to skill definitions or MCP server code
