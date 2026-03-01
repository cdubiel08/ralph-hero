---
date: 2026-03-01
github_issue: 479
github_url: https://github.com/cdubiel08/ralph-hero/issues/479
status: complete
type: research
---

# GH-479: `doctor` health check doesn't increment error counter on API failure

## Problem Statement

The `just doctor` recipe includes an API Health Check section that calls `just _mcp_call "ralph_hero__health_check" '{}'`. When this call fails, the `errors` counter is not incremented, causing the doctor to exit with `0 error(s)` even when the health check visibly failed (jq parse errors printed to stderr).

## Current State Analysis

### `doctor` recipe — the error counter pattern

In `plugin/ralph-hero/justfile:169-174`:
```bash
if command -v mcp &>/dev/null && [ -n "${RALPH_HERO_GITHUB_TOKEN:-}" ]; then
    echo "--- API Health Check ---"
    just _mcp_call "ralph_hero__health_check" '{}' || {
        echo "FAIL: API health check failed"
        errors=$((errors + 1))
    }
```

The `|| { errors++ }` block should trigger when `just _mcp_call` exits non-zero. The bug is that `_mcp_call` exits **0** even on failure.

### `_mcp_call` recipe — the swallowed error

In `plugin/ralph-hero/justfile:372-392`:
```bash
_mcp_call tool params:
    #!/usr/bin/env bash
    set -eu
    ...
    raw=$(mcp call "{{tool}}" --params '{{params}}' \
        npx -y ralph-hero-mcp-server@2.4.97)
    if command -v jq &>/dev/null; then
        if echo "$raw" | jq -e '.isError // false' > /dev/null 2>&1; then
            echo "$raw" | jq -r '.content[0].text' >&2
            exit 1
        fi
        echo "$raw" | jq -r '.content[0].text // .' | jq '.' 2>/dev/null \
            || echo "$raw" | jq -r '.content[0].text // .'
    else
        echo "$raw"
    fi
```

### Root Cause: Three-stage pipeline without `pipefail`

When `mcp call` returns invalid/non-JSON output (due to the empty params bug #478 or any API failure):

1. `raw=$(mcp call ...)` may succeed (mcp exits 0 with error text on stdout)
2. `jq -e '.isError // false'` fails to parse `raw` → the `if` condition is **false** (non-zero = false in bash `if`) → we skip `exit 1`
3. `echo "$raw" | jq -r '.content[0].text // .' | jq '.' 2>/dev/null` is a three-command pipeline **without `set -o pipefail`**:
   - `jq -r '.content[0].text // .'` fails (invalid JSON input), writes nothing to stdout, prints parse error to stderr
   - `jq '.' 2>/dev/null` receives **empty stdin** (previous jq exited with no output), reads EOF, and **exits with code 0**
4. Without `pipefail`, the pipeline exit code is the **last command's exit code** = 0
5. The `||` fallback is never triggered
6. `_mcp_call` exits **0** (false success)
7. `doctor`'s `|| { errors++ }` never runs

The jq parse error IS printed to stderr by step 3, but `_mcp_call` still exits 0.

### `health_check` tool schema

In `plugin/ralph-hero/mcp-server/src/index.ts:131-134`:
```typescript
server.tool(
    "ralph_hero__health_check",
    "Validate GitHub API connectivity...",
    {},  // empty schema — takes no parameters
    async () => { ... })
```

The tool always returns `toolSuccess(...)` and never throws. If called correctly, it succeeds. But when `mcp call` invocation itself fails (empty params bug #478), `_mcp_call` receives invalid output.

## Key Discoveries

1. **The bug is in `_mcp_call`, not in `doctor`**: The `|| { errors++ }` pattern in `doctor` is correct; the problem is that `_mcp_call` exits 0 on failure.
2. **Bash pipeline exit code semantics**: Without `set -o pipefail`, only the last command in `a | b | c` determines the pipeline's exit code. `jq '.'` with empty stdin exits 0.
3. **The `jq -e '.isError // false'` check is insufficient**: It only handles well-formed MCP error responses. It fails silently (non-zero exit = `if` condition is false) when `raw` is not valid JSON at all.
4. **The `health_check` tool has no params**: It uses `{}` schema. Calling it with `'{}'` via mcptools should work — the #478 empty params bug may affect the transport layer before the tool runs.

## Potential Approaches

### Option A: Add `set -o pipefail` to `_mcp_call`
Change `set -eu` to `set -euo pipefail`. The three-stage pipeline would then exit non-zero if any stage fails.

- **Pros**: One-line change, fixes root cause for all callers
- **Cons**: Behavior change for all pipelines in `_mcp_call`; the `||` fallback still works for valid cases (text that isn't JSON parseable)

### Option B: Add explicit JSON validation before output (Recommended)
After capturing `raw`, validate it's parseable JSON before proceeding:
```bash
if ! echo "$raw" | jq -e '.' > /dev/null 2>&1; then
    echo "Error: MCP server returned invalid response" >&2
    exit 1
fi
```

- **Pros**: Explicit, self-documenting, targeted fix, doesn't change pipeline behavior
- **Cons**: Slightly more code

### Option C: Fix `doctor` to use output capture
```bash
if health_out=$(just _mcp_call "ralph_hero__health_check" '{}' 2>&1); then
    echo "$health_out"
else
    echo "FAIL: API health check failed"
    errors=$((errors + 1))
fi
```

- **Pros**: Localized to `doctor`, doesn't affect other callers
- **Cons**: Doesn't fix `_mcp_call` for other callers; relies on `_mcp_call` exit code still being broken

## Recommended Fix

**Option B** — explicit JSON validation in `_mcp_call`. This fixes the root cause for all callers while making the intent clear. Additionally, it also handles the case where `mcp call` itself exits non-zero (the `raw=$(...)` with `set -e` covers that).

The fix adds one guard clause in the `jq` branch of `_mcp_call`:
```bash
# After the isError check, before outputting:
if ! echo "$raw" | jq -e '.' > /dev/null 2>&1; then
    echo "Error: MCP server returned invalid response" >&2
    exit 1
fi
```

## Risks

- **Low risk**: The fix only adds a guard for a case that was previously silently broken (invalid JSON response)
- **No behavior change for valid responses**: Valid MCP responses are always valid JSON

## Files Affected

### Will Modify
- `plugin/ralph-hero/justfile` — Fix `_mcp_call` recipe to exit non-zero when raw response is not valid JSON

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/index.ts` — `health_check` tool implementation and schema
- `plugin/ralph-hero/mcp-server/src/tools/debug-tools.ts` — Confirmed not the relevant file
