---
date: 2026-02-21
github_issue: 296
github_url: https://github.com/cdubiel08/ralph-hero/issues/296
status: complete
type: research
---

# GH-296: Improve Error Messages with "What to Do Next" Suggestions

## Problem Statement

Error messages across the ralph CLI layers are inconsistent and leave users without clear recovery paths. Three specific locations were identified where errors stop at "what failed" without explaining "why" or "what to do next."

## Current State Analysis

### Location 1: `_run_skill` — Timeout Error

**File**: [`plugin/ralph-hero/justfile:298-299`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/justfile#L298-L299)

```bash
if [ $exit_code -eq 124 ]; then
    echo ">>> Timed out after {{timeout}}"
```

**Problem**: No suggestion for recovery. User doesn't know whether to increase the timeout, reduce scope, or check for a hung process.

**Improved message**:
```
>>> Timed out after 15m
    The skill did not complete within the time limit.
    Try: just <recipe> timeout=30m   (increase timeout)
      or: ralph <recipe> timeout=30m
```

### Location 2: `_run_skill` — Non-Zero Exit Error

**File**: [`plugin/ralph-hero/justfile:300-302`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/justfile#L300-L302)

```bash
else
    echo ">>> Exited with code $exit_code"
fi
```

**Problem**: Raw exit code with no context. Exit code 1 could mean budget exhausted, API error, missing env var, or a skill bug — indistinguishable from the message alone.

**Improved message**:
```
>>> Exited with code $exit_code
    Check above for error details from the skill output.
    Common causes: API token missing/expired, budget exhausted, network error.
    Run: just doctor   to diagnose environment issues.
```

### Location 3: `ralph-loop.sh` — `run_claude` Timeout/Failure

**File**: [`plugin/ralph-hero/scripts/ralph-loop.sh:74-78`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/scripts/ralph-loop.sh#L74-L78)

```bash
if [ $exit_code -eq 124 ]; then
    echo ">>> Task timed out after $TIMEOUT"
else
    echo ">>> Task exited with code $exit_code"
fi
```

**Problem**: Same pattern as `_run_skill` but in the loop script — no recovery suggestion. In the loop context, users also don't know whether to let the loop continue or stop it.

**Improved message**:
```
>>> Task timed out after $TIMEOUT
    Continuing to next iteration. To increase timeout: TIMEOUT=30m just loop
>>> Task exited with code $exit_code
    Continuing to next iteration. Check output above for details.
    Stop the loop: Ctrl+C, then run: just doctor
```

### Location 4: `doctor` API Health Check (Bonus)

**File**: [`plugin/ralph-hero/justfile:147-150`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/justfile#L147-L150)

```bash
just _mcp_call "ralph_hero__health_check" '{}' || {
    echo "FAIL: API health check failed"
    errors=$((errors + 1))
}
```

**Problem**: Raw MCP output appears inline before the `FAIL:` line, mixing tool output with structured doctor output. The "FAIL" message appears after noise.

**Improved pattern**: Capture `_mcp_call` output, suppress it on success, show it clearly on failure:
```bash
if ! hc_output=$(just _mcp_call "ralph_hero__health_check" '{}' 2>&1); then
    echo "FAIL: API health check failed"
    echo "      $hc_output"
    echo "      Check: RALPH_HERO_GITHUB_TOKEN is valid and has repo+project scopes"
    errors=$((errors + 1))
else
    echo "  OK: API health check"
fi
```

## Key Patterns to Follow

The issue body specifies the **what + why + what-to-do-next** pattern. Looking across existing messages:

- `doctor` already does this well for dependencies: `"WARN: mcp (mcptools) not installed -- quick-* recipes unavailable\n      Install: brew tap f/mcptools && brew install mcp"` — two-line pattern: problem on line 1, fix indented on line 2
- `_mcp_call` error is also good: shows install instructions inline
- The `_run_skill` and `ralph-loop.sh` errors need to match this established two-line pattern

## Scope

**Files to modify**:
1. `plugin/ralph-hero/justfile` — `_run_skill` recipe (lines 298-302), optionally `doctor` health check (lines 147-150)
2. `plugin/ralph-hero/scripts/ralph-loop.sh` — `run_claude` function (lines 74-78)

**Total changes**: ~10-15 lines across 2 files. S estimate is appropriate — requires thoughtful copy for each error path, not just mechanical changes.

## Recommendations

1. Follow the existing `doctor` two-line pattern: error on line 1, indented suggestion on line 2
2. For `_run_skill` timeout: suggest `timeout=` parameter with the recipe name templated in
3. For `_run_skill` failure: suggest `just doctor` as the diagnostic command
4. For `ralph-loop.sh` errors: clarify the loop continues (don't leave user wondering), and provide `just doctor` reference
5. `doctor` health check output capture is a bonus improvement — include it if easy, skip if complex

## Risks

- `_run_skill` uses `just` variable interpolation (`{{timeout}}`, `{{skill}}`), so the suggestion message can reference the actual recipe name and timeout value — a nice UX touch
- `ralph-loop.sh` `run_claude` uses local variables, so the actual command can be included in suggestions
- No functional behavior changes — pure output improvements
