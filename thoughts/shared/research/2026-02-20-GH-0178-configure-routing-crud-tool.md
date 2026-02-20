---
date: 2026-02-20
github_issue: 178
github_url: https://github.com/cdubiel08/ralph-hero/issues/178
status: complete
type: research
---

# GH-178: Implement `configure_routing` MCP Tool — CRUD Operations

## Problem Statement

The `configure_routing` MCP tool must provide four CRUD operations for managing routing rules in `.ralph-routing.yml`: `list_rules`, `add_rule`, `update_rule`, and `remove_rule`. This is the core management surface for the routing rules engine (parent #128, epic #99). No routing code exists anywhere in the codebase today — this is entirely greenfield.

## Current State Analysis

### What Exists

No routing infrastructure exists in the MCP server:
- No `routing-tools.ts`, `routing-config.ts`, or `routing-types.ts`
- No `.ralph-routing.yml` schema or example file
- No `routing` references in `index.ts`
- No YAML library in `package.json`

The project has 7 tool files: `issue-tools.ts`, `project-tools.ts`, `project-management-tools.ts`, `relationship-tools.ts`, `batch-tools.ts`, `view-tools.ts`, `dashboard-tools.ts`.

### Tool Registration Pattern

All tools follow an identical two-layer pattern:

**Layer 1 — Registration function** (`tools/routing-tools.ts`):
```typescript
export function registerRoutingTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  server.tool("ralph_hero__configure_routing", description, zodSchema, async (args) => {
    try {
      // ...
      return toolSuccess({ ... });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError(`Failed to configure routing: ${message}`);
    }
  });
}
```

**Layer 2 — `index.ts` wiring** (`src/index.ts`):
```typescript
// Add import (line ~22):
import { registerRoutingTools } from "./tools/routing-tools.js";

// Add call in main() (line ~306):
registerRoutingTools(server, client, fieldCache);
```

All imports use `.js` extension (ES module with TypeScript compilation). The `fieldCache` parameter may not be needed for routing (no project field lookups required for file-based config), but the signature is kept consistent for maintainability.

### No File I/O Pattern in Production Code

The entire MCP server has zero file I/O in production code — config comes exclusively from environment variables and GitHub API calls. Introducing file system access for `.ralph-routing.yml` is a first-of-kind pattern in this codebase.

The one file I/O pattern in tests (`state-resolution.test.ts:200-232`) uses synchronous `fs.readFileSync` with an existence guard. For production CRUD operations, async `fs.promises` is more appropriate.

### No YAML Library

`package.json` `dependencies` only includes: `@modelcontextprotocol/sdk`, `@octokit/graphql`, `@octokit/plugin-paginate-graphql`, `zod`. No YAML parsing library exists. One must be added.

**YAML library options:**
- `yaml` (npm) — TypeScript-first, actively maintained, preserves comments, no types package needed
- `js-yaml` — older, widely used, simpler API, requires `@types/js-yaml`

**Recommendation: `yaml`** — preserves YAML comments (useful when users hand-edit routing files), TypeScript-native, modern API.

### Dependency Chain

```
#166 (types/schema, XS, Research Needed)
  └── #168 (config loader + validation, XS, Backlog, blocked by #167 matching engine)
       └── #178 (CRUD tool — this issue, S, Research Needed) ← blocked by #166 + #168
            └── #179 (validate_rules + dry_run, XS, Backlog) ← blocked by #178
```

**Key implication**: #178 cannot be implemented until both #166 (TypeScript types) and #168 (config loader) are done. This is a long chain. The `blockedBy` relationships have been formally established in GitHub.

### Operation Dispatch Design

The issue specifies operations via an `operation` parameter. Two valid patterns exist:

**Option A: Single tool with `z.enum` dispatch** (as described in issue body):
```typescript
server.tool("ralph_hero__configure_routing", ..., {
  operation: z.enum(["list_rules", "add_rule", "update_rule", "remove_rule"]),
  // operation-specific fields...
}, async (args) => {
  switch (args.operation) {
    case "list_rules": ...
    case "add_rule": ...
  }
});
```

**Option B: Four separate tools** (more consistent with existing patterns):
```typescript
server.tool("ralph_hero__list_rules", ...)
server.tool("ralph_hero__add_rule", ...)
server.tool("ralph_hero__update_rule", ...)
server.tool("ralph_hero__remove_rule", ...)
```

**Recommendation: Option A (single tool with operation enum).** The issue body explicitly specifies "via `operation` parameter". A single tool also simplifies the schema — `add_rule` needs match criteria + action fields that are meaningless for `list_rules` and `remove_rule`. Using `z.union` or optional fields on a single schema is cleaner than four partially-overlapping tool schemas.

## Implementation Plan

### File Changes

| File | Change | Effort |
|------|--------|--------|
| `package.json` | Add `yaml` dependency | Trivial |
| `lib/routing-types.ts` | Temporary: inline minimal types (superseded by #166) | XS |
| `tools/routing-tools.ts` | NEW: register `ralph_hero__configure_routing` with 4 operations | Primary |
| `index.ts` | Add import + `registerRoutingTools()` call | Trivial |
| `__tests__/routing-tools.test.ts` | NEW: tests per operation with mock file system | Secondary |

### Tool Schema

```typescript
server.tool(
  "ralph_hero__configure_routing",
  "Manage routing rules in .ralph-routing.yml. CRUD operations: list, add, update, remove rules. Returns: updated rule list or error. Config file path: configurable via RALPH_ROUTING_CONFIG env var (default: .ralph-routing.yml).",
  {
    operation: z
      .enum(["list_rules", "add_rule", "update_rule", "remove_rule"])
      .describe("CRUD operation to perform"),
    configPath: z
      .string()
      .optional()
      .describe("Path to routing config file (default: .ralph-routing.yml)"),
    // For add_rule / update_rule:
    rule: z
      .object({
        match: z.object({
          labels: z.array(z.string()).optional(),
          repo: z.string().optional(),
        }),
        action: z.object({
          workflowState: z.string().optional(),
          projectNumber: z.number().optional(),
        }),
      })
      .optional()
      .describe("Rule definition (required for add_rule, update_rule)"),
    // For update_rule / remove_rule:
    ruleIndex: z
      .number()
      .optional()
      .describe("Zero-based rule index (required for update_rule, remove_rule)"),
  },
  async (args) => { /* dispatch on args.operation */ }
);
```

### Config File Location

The tool needs a path to `.ralph-routing.yml`. Two options:
1. **Fixed relative path**: Always `process.cwd() + "/.ralph-routing.yml"` — simple but assumes tool is run from repo root
2. **Env var override**: `RALPH_ROUTING_CONFIG` env var with fallback to `.ralph-routing.yml`

**Recommendation: Env var override** — consistent with how the MCP server handles other config (`RALPH_GH_OWNER`, `RALPH_GH_REPO`, etc.). Add `RALPH_ROUTING_CONFIG` to `.mcp.json` defaults.

### Handler Logic per Operation

```typescript
async (args) => {
  const configPath = args.configPath ??
    process.env.RALPH_ROUTING_CONFIG ??
    ".ralph-routing.yml";

  try {
    const raw = await fs.promises.readFile(configPath, "utf-8").catch(() => "");
    const config = raw ? parse(raw) : { rules: [] };  // yaml.parse

    switch (args.operation) {
      case "list_rules":
        return toolSuccess({ rules: config.rules ?? [], configPath });

      case "add_rule":
        if (!args.rule) throw new Error("rule is required for add_rule");
        config.rules = [...(config.rules ?? []), args.rule];
        await fs.promises.writeFile(configPath, stringify(config));
        return toolSuccess({ rules: config.rules, configPath });

      case "update_rule":
        if (args.ruleIndex == null || !args.rule)
          throw new Error("ruleIndex and rule are required for update_rule");
        if (args.ruleIndex >= (config.rules?.length ?? 0))
          throw new Error(`Rule index ${args.ruleIndex} out of range`);
        config.rules[args.ruleIndex] = args.rule;
        await fs.promises.writeFile(configPath, stringify(config));
        return toolSuccess({ rules: config.rules, configPath });

      case "remove_rule":
        if (args.ruleIndex == null)
          throw new Error("ruleIndex is required for remove_rule");
        config.rules = config.rules?.filter((_, i) => i !== args.ruleIndex) ?? [];
        await fs.promises.writeFile(configPath, stringify(config));
        return toolSuccess({ rules: config.rules, configPath });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`Failed to configure routing: ${message}`);
  }
}
```

### Tests

Follow `dashboard.test.ts` factory pattern with vitest `vi.mock`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
}));

// Test cases:
// 1. list_rules — empty config returns []
// 2. list_rules — existing config returns parsed rules
// 3. add_rule — appends rule and writes back
// 4. update_rule — replaces rule at index
// 5. remove_rule — removes rule at index
// 6. update_rule — throws for out-of-range index
// 7. add_rule — throws if rule is missing
```

Note: This introduces the first `vi.mock('fs')` in the test suite. The existing `state-resolution.test.ts` uses real `fs` calls — that pattern remains unchanged.

## Dependency Coordination Notes

### #166 (Types) — Research Needed, XS

#166 defines `RoutingConfig`, `RoutingRule`, match criteria, and action types. Until #166 is done, #178 should use inline minimal types:

```typescript
// Temporary until #166 — will be replaced with import from lib/routing-types.ts
interface RoutingRule {
  match: { labels?: string[]; repo?: string };
  action: { workflowState?: string; projectNumber?: number };
}
interface RoutingConfig { rules: RoutingRule[] }
```

### #168 (Config Loader) — Backlog, blocked by #167

#168 implements a validated loader with live GitHub API checks. Until #168 is done, #178 uses a simpler inline loader (just `yaml.parse` without validation). Once #168 is done, #178's `readFile + parse` inline should be replaced with `loadRoutingConfig(configPath, client)` from `lib/routing-config.ts`.

### Implementation Order

1. #166 (types) — unblock first, defines the shape
2. #167 (matching engine) — parallel with #166
3. #168 (config loader) — after #166 + #167
4. **#178 (this issue)** — after #166 + #168
5. #179 (validate + dry-run) — after #178

## Risks

1. **YAML comment preservation**: `yaml` package preserves comments on round-trip if using Document API (`parseDocument` + `toString`). Using `parse`/`stringify` directly loses comments. Decision: use `parse`/`stringify` for v1 (simpler); note comment loss in tool description. Can upgrade to Document API in a follow-up.

2. **File path portability**: `process.cwd()` may not be the repo root when the MCP server is invoked via `npx`. The `RALPH_ROUTING_CONFIG` env var solves this — users set the absolute path in `.claude/settings.local.json`.

3. **Race conditions on concurrent writes**: Multiple MCP calls could corrupt the config file if called concurrently. Not a concern for v1 (MCP is typically single-session). Could add file locking later.

4. **Missing file on list_rules**: Tool should return `{ rules: [] }` (not error) when `.ralph-routing.yml` doesn't exist — graceful empty-state behavior.

## Recommended Approach

1. Add `yaml` to `package.json` dependencies
2. Create `tools/routing-tools.ts` with single `ralph_hero__configure_routing` tool
3. Implement 4-operation dispatch in handler using `fs.promises` + `yaml.parse`/`stringify`
4. Include inline minimal types (replace with #166 import once done)
5. Wire into `index.ts`
6. Create `__tests__/routing-tools.test.ts` with `vi.mock('fs')` and 7 test cases
7. Update `CLAUDE.md` note that `RALPH_ROUTING_CONFIG` env var is needed
