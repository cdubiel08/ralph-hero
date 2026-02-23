---
date: 2026-02-22
github_issue: 360
github_url: https://github.com/cdubiel08/ralph-hero/issues/360
status: complete
type: research
---

# GH-360: V4 Phase 7 — Observability Layer: Debug Logging & Hook Capture

## Problem Statement

Ralph has no observability into its own operation. Errors disappear after sessions, making debugging and diagnosis opaque. Phase 7 implements a zero-overhead debug mode (`RALPH_DEBUG=true`) that captures four event categories to JSONL log files: MCP tool calls, GraphQL requests, hook executions, and agent-level events.

## Prior Spec

A detailed design already exists: `thoughts/shared/plans/2026-02-21-debug-mode-observability-spec.md` (362 lines). This research document confirms feasibility, identifies injection points, and maps the spec to the actual codebase structure.

## Current State Analysis

### What Exists

- **No `DebugLogger`**: `src/lib/debug-logger.ts` does not exist
- **No `RALPH_DEBUG` usage**: Zero references in the MCP server source
- **No JSONL hook scripts**: `hooks/scripts/` has 47 files, none for debug capture
- **Prior spec**: Complete design in `2026-02-21-debug-mode-observability-spec.md`

### MCP Server Architecture

The MCP server is an ESM Node.js process (≥18) communicating via stdio transport (`@modelcontextprotocol/sdk` ^1.26.0). It uses:
- **`createGitHubClient()`** factory function returning `GitHubClient` interface
- **10 `register*()` functions** each calling `server.tool(name, description, schema, handler)` directly on the MCP SDK instance
- **`toolSuccess(data)` / `toolError(message)`** from `types.ts` as the only two return paths for all handlers
- **Vitest** for tests (31 existing test files in `src/__tests__/`)

## Key Discoveries

### GraphQL Injection Point: `executeGraphQL()` in `github-client.ts:102-168`

This is the **single, canonical injection point** for all GitHub API calls. Every public method (`query`, `projectQuery`, `mutate`, `projectMutate`) routes through this one internal closure. No changes to the four public methods are required — only `executeGraphQL` needs instrumentation.

**Data available at injection point:**

| Field | Source | Notes |
|---|---|---|
| `fullQuery` | `executeGraphQL` local var | Complete query with rateLimit fragment injected |
| `variables` | `executeGraphQL` argument | All GraphQL variables |
| `isMutation` | `executeGraphQL` local var (line 111) | Boolean — query vs mutation |
| `durationMs` | `Date.now()` before/after line 127 | Net network time (post rate-limit sleep) |
| `rateLimitRemaining` | `response.rateLimit.remaining` (lines 133-138) | From response |
| `rateLimitCost` | `response.rateLimit.cost` | From response |
| `error` | `catch` block at line 141 | Error message; `error.status` for HTTP code |

**Proposed instrumentation** (wrapping the `try` block at `github-client.ts:126-140`):

```typescript
const t0 = Date.now();
try {
  const response = await graphqlFn<T & { rateLimit?: RateLimitInfo }>(fullQuery, variables || {});
  // ... existing rate limit update ...
  debugLogger?.logGraphQL({
    operation: extractOperationName(fullQuery),
    variables: sanitize(variables),
    durationMs: Date.now() - t0,
    status: 200,
    rateLimitRemaining: response.rateLimit?.remaining,
    rateLimitCost: response.rateLimit?.cost,
  });
  return response as T;
} catch (error) {
  debugLogger?.logGraphQL({
    operation: extractOperationName(fullQuery),
    variables: sanitize(variables),
    durationMs: Date.now() - t0,
    status: (error as {status?: number}).status,
    error: String(error),
  });
  // ... existing 403 retry ...
}
```

### MCP Tool Dispatch: No Central Point — `withLogging` Wrapper Required

There is **no application-level dispatch function**. The MCP SDK routes incoming JSON-RPC calls internally. Tool handlers are registered as bare `async () => {...}` closures passed to `server.tool()`.

**Best approach**: Pass a `debugLogger` instance to each `register*()` function and wrap each handler with a `withLogging(name, params, handler)` utility:

```typescript
// In debug-logger.ts — exported utility
export function withLogging<T>(
  logger: DebugLogger | null,
  toolName: string,
  params: Record<string, unknown>,
  handler: () => Promise<T>
): Promise<T> {
  if (!logger) return handler();
  const t0 = Date.now();
  return handler().then(
    (result) => {
      logger.logTool({ name: toolName, params: sanitize(params), durationMs: Date.now() - t0, ok: true });
      return result;
    },
    (err) => {
      logger.logTool({ name: toolName, params: sanitize(params), durationMs: Date.now() - t0, ok: false, error: String(err) });
      throw err;
    }
  );
}
```

**Tool handler pattern** (example in one tool module):
```typescript
server.tool("ralph_hero__update_workflow_state", description, schema, async (params) =>
  withLogging(debugLogger, "ralph_hero__update_workflow_state", params, async () => {
    // existing handler body
  })
);
```

This requires threading `debugLogger` through to all 10 `register*()` functions, which is a straightforward mechanical change since they all accept `(server, client, fieldCache)` and this adds an optional 4th param.

**Alternative — wrap `toolSuccess`/`toolError` in `types.ts`**: These are the universal return paths. However, they don't have access to tool name or duration, so this alone is insufficient.

### DebugLogger Class Design

Following the pattern of `RateLimiter` and `FieldOptionCache` in `src/lib/`:

```typescript
// src/lib/debug-logger.ts
export interface DebugLoggerOptions {
  logDir?: string;  // defaults to ~/.ralph-hero/logs/
}

export class DebugLogger {
  private logPath: string | null = null;
  private logDir: string;

  constructor(options: DebugLoggerOptions = {}) {
    this.logDir = options.logDir ?? path.join(os.homedir(), ".ralph-hero", "logs");
  }

  // Lazy file creation: only create on first write
  private async getLogPath(): Promise<string> {
    if (this.logPath) return this.logPath;
    await fs.mkdir(this.logDir, { recursive: true });
    const ts = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
    const rand = Math.random().toString(36).slice(2, 6);
    this.logPath = path.join(this.logDir, `session-${ts}-${rand}.jsonl`);
    await this.append({ ts: new Date().toISOString(), cat: "session", event: "start", version: VERSION });
    return this.logPath;
  }

  private async append(event: Record<string, unknown>): Promise<void> {
    const file = await this.getLogPath();
    await fs.appendFile(file, JSON.stringify(event) + "\n");
  }

  logGraphQL(fields: GraphQLLogFields): void { /* fire-and-forget */ }
  logTool(fields: ToolLogFields): void { /* fire-and-forget */ }
}

// Factory — returns null when RALPH_DEBUG is not set
export function createDebugLogger(): DebugLogger | null {
  const enabled = process.env.RALPH_DEBUG === "true";
  return enabled ? new DebugLogger() : null;
}
```

**Zero overhead guarantee**: `createDebugLogger()` returns `null` when `RALPH_DEBUG` is unset. All call sites use `debugLogger?.logX(...)` optional chaining — no overhead, no file I/O.

### JSONL Event Format (from prior spec)

Five categories, each with consistent `ts` + `cat` fields:

```jsonl
{"ts":"...","cat":"session","event":"start","version":"2.4.61","node":"22.0.0"}
{"ts":"...","cat":"graphql","operation":"getIssue","variables":{...},"durationMs":180,"rateLimitRemaining":4800,"rateLimitCost":1}
{"ts":"...","cat":"tool","name":"ralph_hero__update_workflow_state","params":{...},"durationMs":340,"ok":true}
{"ts":"...","cat":"hook","hook":"pre-github-validator","tool":"Bash","exitCode":0,"blocked":false}
{"ts":"...","cat":"agent","event":"skill_invoked","skill":"ralph-impl","issueNumber":42}
```

**Sanitization required**: Strip GitHub tokens from variables and params before logging.

### Hook Capture: `debug-hook-counter.sh`

A lightweight hook script that runs on all tool events when `RALPH_DEBUG=true`. Following existing hook patterns (`hook-utils.sh`):

```bash
#!/bin/bash
# debug-hook-counter.sh — log hook executions to JSONL
set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

# Zero overhead when debug mode off
if [[ "${RALPH_DEBUG:-}" != "true" ]]; then
  exit 0
fi

INPUT=$(read_input)
HOOK_NAME=$(echo "$INPUT" | jq -r '.hookEventName // "unknown"')
TOOL_NAME=$(get_tool_name)
EXIT_CODE="${HOOK_EXIT_CODE:-0}"  # passed via env by calling hook framework
BLOCKED=$( [[ "$EXIT_CODE" == "2" ]] && echo "true" || echo "false" )
TS=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

LOG_DIR="${HOME}/.ralph-hero/logs"
mkdir -p "$LOG_DIR"
# Append to existing session log if present, otherwise create new
LOG_FILE=$(ls -t "$LOG_DIR"/session-*.jsonl 2>/dev/null | head -1 || echo "$LOG_DIR/session-$(date +%Y-%m-%d-%H-%M-%S)-hook.jsonl")

echo "{\"ts\":\"$TS\",\"cat\":\"hook\",\"hook\":\"$(basename "$0")\",\"tool\":\"$TOOL_NAME\",\"exitCode\":$EXIT_CODE,\"blocked\":$BLOCKED}" >> "$LOG_FILE"
exit 0
```

**Registration**: The hook must be registered in the plugin hooks config with type `PostToolUse` (or PreToolUse) for all tools, with exit 0 (observer only, never blocks).

### Env Var Activation Pattern

Following `resolveEnv()` in `index.ts`:

```typescript
function isDebugEnabled(): boolean {
  const val = process.env.RALPH_DEBUG;
  if (!val || val.startsWith("${")) return false;
  return val === "true";
}
```

Initialize once in `main()` before registering tools:

```typescript
const debugLogger = isDebugEnabled() ? new DebugLogger() : null;
```

### Test Strategy

Following existing test patterns in `src/__tests__/`:

```typescript
// src/__tests__/debug-logger.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DebugLogger } from "../lib/debug-logger.js";

// Mock fs to avoid real file I/O
vi.mock("fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
}));

describe("DebugLogger", () => {
  it("is inactive when RALPH_DEBUG is not set", () => { /* ... */ });
  it("creates log file lazily on first event", () => { /* ... */ });
  it("appends valid JSONL on logGraphQL()", () => { /* ... */ });
  it("sanitizes tokens from variables", () => { /* ... */ });
});
```

## Potential Approaches

### Approach A: Inject via Constructor Prop Threading (Recommended)

Pass `debugLogger: DebugLogger | null` as optional 4th argument to all 10 `register*()` functions. Each function wraps its handlers with `withLogging()`.

**Pros**: Explicit, testable, no global state, consistent with existing factory patterns
**Cons**: Mechanical change across 10 files (low risk, high volume)

### Approach B: Module-Level Singleton

Export `debugLogger` as module-level singleton initialized once in `index.ts`, import in each tool file.

**Pros**: No signature changes in register functions
**Cons**: Global singleton harder to test; import ordering matters in ESM; breaks the factory pattern used throughout the codebase

### Approach C: SDK Middleware (Transport Intercept)

Hook into `StdioServerTransport` at the MCP SDK level to intercept all tool calls before dispatch.

**Pros**: Single injection point for tool logging
**Cons**: Relies on SDK internals not guaranteed to be stable; not documented; may not capture tool name or typed params at this layer

**Recommendation**: Approach A. Threading a nullable `debugLogger` through 10 `register*()` functions is mechanical and safe. `withLogging()` utility in `debug-logger.ts` encapsulates the timing/logging concern cleanly.

## Risks

1. **Fire-and-forget logging blocking handlers**: `appendFile` is async; tool handlers must not `await` log calls. Use `.catch(console.error)` for silent failure on log write errors — never let debug logging break a tool call.
2. **Log file contention** (agent events): Multiple Claude Code processes may share `~/.ralph-hero/logs/`. JSONL append is atomic at the OS level for small writes (<4KB on Linux), but concurrent session starts may interleave session headers. Acceptable for v1.
3. **Token leakage in logs**: Variables and params must be sanitized before logging — strip any field matching `*token*`, `*auth*`, `*secret*`, `*key*` pattern. The `sanitize()` function must be thorough.
4. **Hook session log matching**: `debug-hook-counter.sh` must find the current session's JSONL file (created by MCP server) to append hook events to the same file. The `ls -t | head -1` approach works but may pick up a stale file from a previous session. A more robust approach: MCP server writes its log path to a well-known location (e.g., `~/.ralph-hero/current-session.txt`) on startup.
5. **Phase 7b scope**: GH-361 (collation + stats MCP tools) is out of scope for this issue. This research covers only Phase 7 (capture layer).

## Recommended Next Steps

1. **Create `src/lib/debug-logger.ts`**:
   - `DebugLogger` class with lazy file creation, JSONL append, sanitization
   - `createDebugLogger()` factory returning null when disabled
   - `withLogging()` handler wrapper utility
   - `extractOperationName()` helper for GraphQL query strings

2. **Modify `src/github-client.ts`**:
   - Accept optional `debugLogger` in `createGitHubClient()` config
   - Wrap `executeGraphQL` try/catch with timing + `debugLogger?.logGraphQL()`

3. **Modify `src/index.ts`**:
   - Call `createDebugLogger()` in `main()` before registering tools
   - Pass `debugLogger` to all 10 `register*()` calls

4. **Modify all 10 `src/tools/*.ts` files**:
   - Accept `debugLogger: DebugLogger | null` in `register*()` signature
   - Wrap each `server.tool(name, ...)` handler with `withLogging(debugLogger, name, params, handler)`

5. **Create `hooks/scripts/debug-hook-counter.sh`**:
   - Check `RALPH_DEBUG` first, exit 0 if unset
   - Append hook event to current session JSONL
   - Register as PostToolUse observer (exit 0 always)

6. **Add tests**: `src/__tests__/debug-logger.test.ts` covering activation, lazy init, JSONL format, sanitization

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/github-client.ts` — inject DebugLogger into `executeGraphQL()` for GraphQL call logging
- `plugin/ralph-hero/mcp-server/src/index.ts` — initialize DebugLogger from `RALPH_DEBUG`, thread to register functions
- `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts` — add `withLogging` wrapper
- `plugin/ralph-hero/mcp-server/src/tools/view-tools.ts` — add `withLogging` wrapper
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` — add `withLogging` wrapper
- `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts` — add `withLogging` wrapper
- `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` — add `withLogging` wrapper
- `plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts` — add `withLogging` wrapper
- `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts` — add `withLogging` wrapper
- `plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts` — add `withLogging` wrapper
- `plugin/ralph-hero/mcp-server/src/tools/routing-tools.ts` — add `withLogging` wrapper
- `plugin/ralph-hero/mcp-server/src/tools/sync-tools.ts` — add `withLogging` wrapper

### Will Create
- `plugin/ralph-hero/mcp-server/src/lib/debug-logger.ts` — DebugLogger class, withLogging utility, createDebugLogger factory
- `plugin/ralph-hero/mcp-server/src/__tests__/debug-logger.test.ts` — unit tests
- `plugin/ralph-hero/hooks/scripts/debug-hook-counter.sh` — hook execution JSONL logging

### Will Read (Dependencies)
- `thoughts/shared/plans/2026-02-21-debug-mode-observability-spec.md` — complete design spec (JSONL formats, event fields, file paths)
- `plugin/ralph-hero/mcp-server/src/lib/rate-limiter.ts` — TypeScript class pattern to follow
- `plugin/ralph-hero/mcp-server/src/lib/cache.ts` — TypeScript class pattern to follow
- `plugin/ralph-hero/hooks/scripts/hook-utils.sh` — hook script utilities pattern
- `plugin/ralph-hero/mcp-server/src/__tests__/cache.test.ts` — test structure pattern
