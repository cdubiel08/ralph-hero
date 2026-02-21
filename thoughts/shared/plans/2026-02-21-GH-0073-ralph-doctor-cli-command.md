---
date: 2026-02-21
status: draft
github_issues: [73]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/73
primary_issue: 73
---

# Implement `ralph doctor` CLI Command - Atomic Implementation Plan

## Overview
Single issue (GH-73) to add a `doctor` justfile recipe that diagnoses setup issues by running local checks (env vars, dependencies, plugin manifest, MCP config) and optionally invoking the `health_check` MCP tool via mcptools for API validation.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-73 | Implement `ralph doctor` CLI command for diagnosing setup issues | S |

## Current State Analysis

The justfile (`plugin/ralph-hero/justfile`, 139 lines) has LLM-powered recipes via `_run_skill` and quick-action recipes via `_mcp_call`. The MCP server's `health_check` tool validates auth, repo access, project access, and required fields -- but only runs if the server starts successfully. No `doctor` recipe or diagnostic command exists. Users discover configuration problems as cryptic failures deep in workflow runs.

## Desired End State

### Verification
- [x] `doctor` recipe exists in justfile with two-phase check structure
- [x] Phase 1 checks env vars (RALPH_HERO_GITHUB_TOKEN, RALPH_GH_OWNER, RALPH_GH_PROJECT_NUMBER)
- [x] Phase 1 checks dependencies (just, npx, node required; mcp optional)
- [x] Phase 1 checks plugin manifest (`.claude-plugin/plugin.json` exists, valid JSON)
- [x] Phase 1 checks MCP config (`.mcp.json` exists, valid JSON)
- [x] Phase 2 runs `health_check` via `_mcp_call` when mcptools and token are available
- [x] Summary line shows error/warning counts
- [x] Exit code 1 if any errors found, 0 otherwise

## What We're NOT Doing
- Subcommand targeting (`doctor env`, `doctor api`) -- single command runs all checks
- Workflow state option completeness validation (separate XS enhancement to `health_check`)
- Creating a separate shell script file (single justfile recipe, Approach A)
- Adding `jq` as a required dependency (raw `health_check` JSON output is sufficient)
- Modifying the MCP server or `health_check` tool

## Implementation Approach

Single phase adding one bash script recipe to the Utility Recipes section of the justfile. The recipe has two phases: local shell checks (always run) and API checks (run only when mcptools + token are available). Uses `OK`/`FAIL`/`WARN` prefix formatting for each check line.

---

## Phase 1: GH-73 - Add Doctor Recipe
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/73 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0073-ralph-doctor-cli-command.md

### Changes Required

#### 1. Add `doctor` recipe to justfile
**File**: `plugin/ralph-hero/justfile`
**Location**: In the "Utility Recipes" section (after line 75, before line 77), alongside `setup` and `report`.
**Changes**: Add a new bash script recipe.

After the `report` recipe (line 75), add:

```just
# Diagnose setup issues - checks env, deps, plugin manifest, and API connectivity
doctor:
    #!/usr/bin/env bash
    set -eu
    errors=0; warnings=0
    echo "=== Ralph Doctor ==="
    echo ""
    echo "--- Environment Variables ---"
    for var in RALPH_HERO_GITHUB_TOKEN RALPH_GH_OWNER RALPH_GH_PROJECT_NUMBER; do
        if [ -z "${!var:-}" ]; then
            echo "FAIL: $var is not set"
            errors=$((errors + 1))
        else
            if [ "$var" = "RALPH_HERO_GITHUB_TOKEN" ]; then
                echo "  OK: $var (set, redacted)"
            else
                echo "  OK: $var = ${!var}"
            fi
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
        echo "      Install: brew tap f/mcptools && brew install mcp"
        warnings=$((warnings + 1))
    fi
    if command -v claude &>/dev/null; then
        echo "  OK: claude CLI"
    else
        echo "WARN: claude CLI not found -- LLM-powered recipes unavailable"
        warnings=$((warnings + 1))
    fi
    echo ""
    echo "--- Plugin Files ---"
    if [ -f .claude-plugin/plugin.json ]; then
        if node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf8'))" 2>/dev/null; then
            echo "  OK: .claude-plugin/plugin.json (valid JSON)"
        else
            echo "FAIL: .claude-plugin/plugin.json (invalid JSON)"
            errors=$((errors + 1))
        fi
    else
        echo "FAIL: .claude-plugin/plugin.json not found"
        errors=$((errors + 1))
    fi
    if [ -f .mcp.json ]; then
        if node -e "JSON.parse(require('fs').readFileSync('.mcp.json','utf8'))" 2>/dev/null; then
            echo "  OK: .mcp.json (valid JSON)"
        else
            echo "FAIL: .mcp.json (invalid JSON)"
            errors=$((errors + 1))
        fi
    else
        echo "FAIL: .mcp.json not found"
        errors=$((errors + 1))
    fi
    echo ""
    if command -v mcp &>/dev/null && [ -n "${RALPH_HERO_GITHUB_TOKEN:-}" ]; then
        echo "--- API Health Check ---"
        just _mcp_call "ralph_hero__health_check" '{}' || {
            echo "FAIL: API health check failed"
            errors=$((errors + 1))
        }
        echo ""
    else
        echo "--- API Health Check ---"
        echo "SKIP: mcptools or RALPH_HERO_GITHUB_TOKEN not available"
        echo ""
    fi
    echo "=== Summary: $errors error(s), $warnings warning(s) ==="
    if [ "$errors" -gt 0 ]; then exit 1; fi
```

**Design notes**:
- Placed in "Utility Recipes" section (alongside `setup` and `report`) rather than "Quick Actions" because it's a diagnostic tool, not a project operation
- Uses `#!/usr/bin/env bash` shebang for bash-specific features (`${!var}` indirect expansion)
- Token value is redacted in output (`set, redacted`) to prevent accidental exposure in logs
- Uses `node -e` for JSON validation instead of `jq` (node is already a required dependency)
- Phase 2 (API check) gracefully skips if mcptools or token is missing, with clear SKIP message
- Exit code 1 on errors (non-zero for CI integration), 0 on clean or warnings-only
- `claude` CLI is checked as optional warning (required for LLM recipes but not for quick-* or doctor itself)

### File Ownership Summary

| File | Changes |
|------|---------|
| `plugin/ralph-hero/justfile` | Add `doctor` recipe (~55 lines) in Utility Recipes section |

### Success Criteria
- [x] Automated: `grep -c "^doctor" plugin/ralph-hero/justfile` returns 1
- [x] Automated: `grep "RALPH_HERO_GITHUB_TOKEN\|RALPH_GH_OWNER\|RALPH_GH_PROJECT_NUMBER" plugin/ralph-hero/justfile | grep -c "var"` returns at least 1 (env var checks)
- [x] Automated: `grep "health_check" plugin/ralph-hero/justfile | wc -l` returns at least 1 (API check reference)
- [ ] Manual: `just doctor` runs and shows OK/FAIL/WARN status for each check category
- [ ] Manual: `just doctor` exits 0 when all required checks pass
- [ ] Manual: `just doctor` exits 1 when a required env var is missing

---

## Integration Testing
- [ ] Verify `doctor` shows OK for all env vars when properly configured
- [ ] Verify `doctor` shows FAIL for missing `RALPH_HERO_GITHUB_TOKEN` and exits 1
- [ ] Verify `doctor` shows WARN (not FAIL) for missing mcptools
- [ ] Verify `doctor` validates `.claude-plugin/plugin.json` as valid JSON
- [ ] Verify `doctor` validates `.mcp.json` as valid JSON
- [ ] Verify `doctor` runs `health_check` via mcptools when available
- [ ] Verify `doctor` skips API checks gracefully when mcptools is not installed
- [ ] Verify `just --list` shows the `doctor` recipe with its description

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0073-ralph-doctor-cli-command.md
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/59
- `health_check` MCP tool: `plugin/ralph-hero/mcp-server/src/index.ts` lines 129-281
- Sibling (justfile created): https://github.com/cdubiel08/ralph-hero/issues/68
- Sibling (quick actions): https://github.com/cdubiel08/ralph-hero/issues/252
