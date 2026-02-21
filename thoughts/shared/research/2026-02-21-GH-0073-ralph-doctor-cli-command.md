---
date: 2026-02-21
github_issue: 73
github_url: https://github.com/cdubiel08/ralph-hero/issues/73
status: complete
type: research
---

# GH-73: Implement `ralph doctor` CLI Command for Diagnosing Setup Issues

## Problem Statement

Users encounter configuration errors (missing tokens, wrong project numbers, missing workflow states) that surface as cryptic MCP tool failures deep in a workflow run. A `ralph doctor` command would catch these issues upfront with clear, actionable remediation steps -- before an expensive LLM session is wasted on a misconfigured environment.

## Current State

### Existing `health_check` MCP Tool (`index.ts:129-281`)

The MCP server already has a comprehensive `ralph_hero__health_check` tool that validates:

1. **Auth** (line 137-145): Calls `client.getAuthenticatedUser()` to verify the GitHub token works
2. **Repo access** (line 148-171): GraphQL query to verify `owner/repo` is accessible
3. **Project access** (line 173-253): Tries both `user` and `organization` owner types to find the project
4. **Required fields** (line 226-241): Checks for `Workflow State`, `Priority`, `Estimate` fields

Returns a structured JSON result:
```json
{
  "status": "ok" | "issues_found",
  "checks": { "auth": { "status": "ok|fail|skip", "detail": "..." }, ... },
  "config": { "repoOwner": "...", "repo": "...", "projectOwner": "...", "projectNumber": "...", "tokenMode": "single-token|dual-token" }
}
```

### What `health_check` Does NOT Cover

The `health_check` tool runs inside the MCP server process, meaning the server must start successfully first. It cannot catch:

1. **Missing environment variables**: If `RALPH_HERO_GITHUB_TOKEN` is unset, the MCP server exits on `index.ts:66` before any tools register. The health check never runs.
2. **Plugin manifest issues**: If `plugin.json` is malformed or missing, the plugin won't load at all.
3. **Missing dependencies**: If `just`, `mcptools`, or `npx` are not installed, CLI recipes fail silently.
4. **Workflow state completeness**: The health check verifies 3 field names exist but doesn't check whether all 11 required workflow state options (Backlog through Done + Canceled + Human Needed) are present.
5. **`.mcp.json` validity**: Malformed JSON or wrong server command prevent the MCP server from starting.

### Justfile Pattern (`plugin/ralph-hero/justfile`)

Two helper patterns exist:
- `_run_skill` (lines 107-127): Wraps `claude -p` invocations with timeout and budget
- `_mcp_call` (lines 128-138): Wraps `mcp call` with dependency checking

The `doctor` command fits a third pattern: a **hybrid recipe** that performs local shell checks first, then optionally calls the MCP health check via mcptools for API-dependent validations.

### Required Workflow States (`workflow-states.ts`)

The `VALID_STATES` constant (line 66-70) defines 11 states:
```
Backlog, Research Needed, Research in Progress, Ready for Plan,
Plan in Progress, Plan in Review, In Progress, In Review, Done,
Canceled, Human Needed
```

The `health_check` tool only verifies that the "Workflow State" single-select field exists -- it does not verify that all 11 options are configured on that field. This is a gap.

### Environment Variables

From `CLAUDE.md` and `index.ts`, the required/optional env vars are:

| Variable | Required | Checked by health_check? |
|----------|----------|------------------------|
| `RALPH_HERO_GITHUB_TOKEN` | Yes | Indirectly (server exits if missing) |
| `RALPH_GH_OWNER` | Yes | Yes (via repoAccess check) |
| `RALPH_GH_REPO` | No (inferred) | Yes (via repoAccess check) |
| `RALPH_GH_PROJECT_NUMBER` | Yes | Yes (via projectAccess check) |
| `RALPH_GH_REPO_TOKEN` | No | No |
| `RALPH_GH_PROJECT_TOKEN` | No | No |
| `RALPH_GH_PROJECT_OWNER` | No | No |

## Analysis

### Check Categories

The doctor command should perform checks in two phases:

**Phase 1 -- Local checks (pure shell, no API calls)**:
1. **Environment variables**: Verify `RALPH_HERO_GITHUB_TOKEN`, `RALPH_GH_OWNER`, `RALPH_GH_PROJECT_NUMBER` are set
2. **Dependencies**: Check for `just`, `npx`, `node` (required), `mcp` (optional, for quick-* recipes)
3. **Plugin manifest**: Verify `.claude-plugin/plugin.json` exists and is valid JSON
4. **MCP config**: Verify `.mcp.json` exists and is valid JSON

**Phase 2 -- API checks (via mcptools -> health_check)**:
5. **Auth**: GitHub token is valid
6. **Repo access**: Owner/repo is accessible
7. **Project access**: Project exists and is accessible
8. **Required fields**: Workflow State, Priority, Estimate fields exist
9. **Workflow state options** (enhancement): All 11 states are configured

Phase 1 runs without any external calls. Phase 2 requires mcptools and a working token but provides deeper validation.

### Design Options

**Approach A -- Single justfile recipe (bash script)**:

```just
# Diagnose setup issues - checks env, deps, and API connectivity
doctor:
    #!/usr/bin/env bash
    set -eu
    errors=0; warnings=0

    echo "=== Ralph Doctor ==="
    echo ""

    # Phase 1: Local checks
    echo "--- Environment ---"
    for var in RALPH_HERO_GITHUB_TOKEN RALPH_GH_OWNER RALPH_GH_PROJECT_NUMBER; do
      if [ -z "${!var:-}" ]; then
        echo "FAIL: $var is not set"
        errors=$((errors + 1))
      else
        echo "  OK: $var"
      fi
    done

    echo ""
    echo "--- Dependencies ---"
    for cmd in just npx node; do
      if command -v "$cmd" &>/dev/null; then
        echo "  OK: $cmd ($(command -v "$cmd"))"
      else
        echo "FAIL: $cmd not found"
        errors=$((errors + 1))
      fi
    done
    if command -v mcp &>/dev/null; then
      echo "  OK: mcp (mcptools)"
    else
      echo "WARN: mcp (mcptools) not installed -- quick-* recipes unavailable"
      warnings=$((warnings + 1))
    fi

    echo ""
    echo "--- Plugin ---"
    # Check plugin.json and .mcp.json
    ...

    # Phase 2: API checks (if mcptools available and token set)
    if command -v mcp &>/dev/null && [ -n "${RALPH_HERO_GITHUB_TOKEN:-}" ]; then
      echo ""
      echo "--- API Health Check ---"
      just _mcp_call "ralph_hero__health_check" '{}'
    fi

    echo ""
    echo "=== Summary: $errors errors, $warnings warnings ==="
    exit $((errors > 0 ? 1 : 0))
```

**Pros**: Single file change (justfile only), uses existing `_mcp_call` helper, follows justfile patterns.
**Cons**: Bash script in justfile can get long. No subcommand targeting.

**Approach B -- Separate shell script + justfile recipe**:

Create `scripts/ralph-doctor.sh` with full check logic, then add a thin justfile recipe:

```just
# Diagnose setup issues - checks env, deps, and API connectivity
doctor:
    @"${CLAUDE_PLUGIN_ROOT:-plugin/ralph-hero}/scripts/ralph-doctor.sh"
```

**Pros**: Clean separation, script is testable independently, supports subcommands (`ralph-doctor.sh env`, `ralph-doctor.sh api`).
**Cons**: Two files to create/maintain. Script path resolution requires `CLAUDE_PLUGIN_ROOT`.

**Approach C -- Justfile recipe + enhanced health_check**:

Enhance the `health_check` MCP tool to also validate workflow state options, then use a simple justfile recipe that calls it via mcptools. Local checks remain in the recipe.

**Pros**: Richer API validation, reusable from Claude sessions too.
**Cons**: Two-part implementation (justfile + MCP server change), more complex.

### Recommendation: Approach A (single justfile recipe)

Approach A is the simplest and stays within the S estimate. The bash script is 40-50 lines -- manageable inline in the justfile. The original triage suggested subcommand targeting (`ralph doctor mcp`, `ralph doctor env`, `ralph doctor project`), but that's over-engineering for the initial version. A single `just doctor` that runs all checks is sufficient.

If the recipe grows beyond ~60 lines, it can be extracted to a separate script (Approach B) in a follow-up.

### Workflow State Options Enhancement

The gap in `health_check` (not checking workflow state options) is worth noting but out of scope for this issue. It could be a separate XS enhancement to `health_check` that parses the `options` array on the "Workflow State" field and compares against `VALID_STATES`. The `doctor` recipe can display the raw `health_check` JSON output for now -- users can visually confirm.

## Files to Change

| File | Change | Lines |
|------|--------|-------|
| `plugin/ralph-hero/justfile` | Add `doctor` recipe with local checks + API health check | +50-60 |

Single file change. No MCP server modifications.

## Risks

1. **Environment variable expansion in justfile**: Justfile's `set dotenv-load` loads `.env` files, but `settings.local.json` is the recommended config location. The `RALPH_HERO_GITHUB_TOKEN` may not be in the shell environment when running `just doctor` directly (vs through Claude). The recipe should note this: "If token checks fail, ensure env vars are exported or in a .env file."

2. **mcptools availability for Phase 2**: If mcptools is not installed, Phase 2 (API checks) is skipped entirely. The recipe should clearly indicate this: "Install mcptools for API validation: brew tap f/mcptools && brew install mcp".

3. **Plugin root resolution**: The recipe runs from the justfile directory (`plugin/ralph-hero/`), so relative paths to `plugin.json` and `.mcp.json` are straightforward (`.claude-plugin/plugin.json` and `.mcp.json` relative to justfile).

4. **Output formatting**: The recipe should use consistent formatting with `OK`/`FAIL`/`WARN` prefixes for each check line. The `health_check` JSON output from mcptools is raw -- consider piping through `jq` if available, or noting that the output is JSON.

## Recommendation

Add a `doctor` justfile recipe using Approach A. ~50 lines of bash checking env vars, dependencies, plugin manifest, MCP config, and optionally running `health_check` via mcptools. No subcommands in v1 -- a single `just doctor` covers all checks. Follow the `_mcp_call` pattern for the API health check portion.
