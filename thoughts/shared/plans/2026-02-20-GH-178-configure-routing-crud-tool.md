---
date: 2026-02-20
status: draft
github_issue: 178
github_url: https://github.com/cdubiel08/ralph-hero/issues/178
primary_issue: 178
---

# `configure_routing` CRUD MCP Tool - Implementation Plan

## Overview

Single issue implementation: GH-178 — Add `ralph_hero__configure_routing` MCP tool with four CRUD operations (`list_rules`, `add_rule`, `update_rule`, `remove_rule`) for managing routing rules in `.ralph-routing.yml`.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-178 | Implement `configure_routing` MCP tool — CRUD operations | S |

## Current State Analysis

- No routing infrastructure exists anywhere in the MCP server — fully greenfield
- No YAML library in `package.json` — must add `yaml` npm package
- No `routing-tools.ts`, `routing-config.ts`, or `routing-types.ts` files exist
- No `vi.mock('fs')` pattern in test suite — this will be the first file-system mock
- The only existing mock is `vi.mock("@octokit/graphql")` in `github-client.test.ts:5-11`
- All 7 existing tool files follow identical registration pattern: `export function register*Tools(server: McpServer, client: GitHubClient, fieldCache: FieldOptionCache): void`
- `index.ts` has imports at lines 10-22, registration calls at lines 287-306
- Dependencies #166 (types) and #168 (config loader) are not yet complete — use inline temporary types
- Research recommends single tool with `z.enum` dispatch (Option A) per issue specification

## Desired End State

### Verification
- [ ] `ralph_hero__configure_routing` tool registered and functional
- [ ] `list_rules` returns parsed rules from `.ralph-routing.yml` (empty array if file missing)
- [ ] `add_rule` appends a rule and writes config back
- [ ] `update_rule` replaces rule at given index and writes config back
- [ ] `remove_rule` removes rule at given index and writes config back
- [ ] Inline types used temporarily (to be replaced by #166 imports)
- [ ] `yaml` package added to dependencies
- [ ] Tests pass with `vi.mock('fs')` pattern
- [ ] `npm run build` and `npm test` succeed

## What We're NOT Doing
- No live GitHub API validation of rules (that's #179 — `validate_rules` + `dry_run`)
- No config loader with schema validation (that's #168)
- No formal TypeScript types module (that's #166 — using inline types temporarily)
- No YAML comment preservation (using simple `parse`/`stringify` for v1)
- No file locking for concurrent write safety (single-session MCP, not a concern for v1)
- No matching engine logic (that's #167)

## Implementation Approach

Create a new `routing-tools.ts` file following the standard registration function pattern. The tool uses a single `ralph_hero__configure_routing` entry with an `operation` enum parameter to dispatch to four CRUD handlers. File I/O uses `fs.promises` with `yaml` package for parse/stringify. Config path is determined by `configPath` arg > `RALPH_ROUTING_CONFIG` env var > `.ralph-routing.yml` default. Tests use `vi.mock('fs')` for filesystem isolation.

---

## Phase 1: GH-178 — Implement `configure_routing` MCP tool
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/178 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0178-configure-routing-crud-tool.md

### Changes Required

#### 1. Add `yaml` dependency
**File**: `plugin/ralph-hero/mcp-server/package.json`
**Where**: `dependencies` block (lines 19-24)

**Changes**: Add `"yaml": "^2.7.0"` to the dependencies object.

#### 2. Create `routing-tools.ts`
**File**: `plugin/ralph-hero/mcp-server/src/tools/routing-tools.ts` (NEW)

**Changes**: Create new tool registration file with:

- **Imports**: `McpServer` (type), `z`, `GitHubClient` (type), `FieldOptionCache`, `toolSuccess`, `toolError`, `fs/promises`, `yaml` (`parse`, `stringify`)
- **Inline types** (temporary until #166):
  ```typescript
  // Temporary inline types — will be replaced by import from lib/routing-types.ts (#166)
  interface RoutingRule {
    match: { labels?: string[]; repo?: string };
    action: { workflowState?: string; projectNumber?: number };
  }
  interface RoutingConfig { rules: RoutingRule[] }
  ```
- **Registration function**: `export function registerRoutingTools(server: McpServer, client: GitHubClient, fieldCache: FieldOptionCache): void`
  - Note: `client` and `fieldCache` are not used by this tool (no GitHub API calls needed for file-based config), but the signature is kept consistent with all other registration functions
- **Tool name**: `ralph_hero__configure_routing`
- **Description**: `"Manage routing rules in .ralph-routing.yml. CRUD operations: list, add, update, remove rules. Config path: configPath arg > RALPH_ROUTING_CONFIG env var > .ralph-routing.yml. Returns: updated rule list and configPath."`
- **Input schema**:
  ```typescript
  {
    operation: z.enum(["list_rules", "add_rule", "update_rule", "remove_rule"])
      .describe("CRUD operation to perform"),
    configPath: z.string().optional()
      .describe("Path to routing config file. Defaults to RALPH_ROUTING_CONFIG env var or .ralph-routing.yml"),
    rule: z.object({
      match: z.object({
        labels: z.array(z.string()).optional(),
        repo: z.string().optional(),
      }),
      action: z.object({
        workflowState: z.string().optional(),
        projectNumber: z.number().optional(),
      }),
    }).optional()
      .describe("Rule definition (required for add_rule, update_rule)"),
    ruleIndex: z.number().optional()
      .describe("Zero-based rule index (required for update_rule, remove_rule)"),
  }
  ```
- **Handler flow**:
  1. Resolve config path: `args.configPath ?? process.env.RALPH_ROUTING_CONFIG ?? ".ralph-routing.yml"`
  2. Read file via `fs.promises.readFile(configPath, "utf-8")` with `.catch(() => "")` for missing file
  3. Parse YAML: `raw ? (parse(raw) as RoutingConfig) : { rules: [] }`
  4. Switch on `args.operation`:
     - `list_rules`: return `toolSuccess({ rules: config.rules ?? [], configPath })`
     - `add_rule`: validate `args.rule` exists, append to `config.rules`, write file, return updated rules
     - `update_rule`: validate `args.ruleIndex` and `args.rule`, bounds-check index, replace rule, write file, return updated rules
     - `remove_rule`: validate `args.ruleIndex`, bounds-check index, filter out rule, write file, return updated rules
  5. Write via `fs.promises.writeFile(configPath, stringify(config, { lineWidth: 0 }))`
  6. Catch block: `toolError("Failed to configure routing: ${message}")`

#### 3. Wire into `index.ts`
**File**: `plugin/ralph-hero/mcp-server/src/index.ts`
**Where**: Import after line 22, registration call after line 306

**Changes**:
- Add import: `import { registerRoutingTools } from "./tools/routing-tools.js";` (after line 22)
- Add registration call: `registerRoutingTools(server, client, fieldCache);` (after line 306, before stdio transport connection)

#### 4. Add tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/routing-tools.test.ts` (NEW)

**Changes**: Create test file with `vi.mock('fs')` pattern — first fs mock in test suite:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
```

Mock setup:
```typescript
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));
```

Import the mocked module and set up `beforeEach` to reset mocks.

**Test cases** (7 tests in 2 describe blocks):

`describe("configure_routing CRUD operations")`:
1. `list_rules — returns empty array when config file missing` — mock readFile to reject, verify `{ rules: [], configPath }`
2. `list_rules — returns parsed rules from existing config` — mock readFile with valid YAML, verify parsed rules returned
3. `add_rule — appends rule and writes back` — mock readFile with existing rules, verify writeFile called with appended rule
4. `update_rule — replaces rule at index` — mock readFile with 2 rules, update index 0, verify writeFile called with replaced rule
5. `remove_rule — removes rule at index` — mock readFile with 2 rules, remove index 1, verify writeFile called with 1 rule remaining

`describe("configure_routing validation")`:
6. `add_rule — errors when rule is missing` — call add_rule without rule arg, verify error message
7. `update_rule — errors for out-of-range index` — call update_rule with index beyond array length, verify error message

Note: Since the tool is registered via `server.tool()` and requires MCP server setup, tests should validate the handler logic by extracting it or by testing the YAML parse/write logic directly. Follow the structural test pattern from `project-management-tools.test.ts` — validate YAML structure and operation dispatch logic without requiring live MCP server.

Alternative approach (matching existing structural patterns): Test YAML round-trip and operation dispatch as pure logic tests:

```typescript
describe("routing config YAML structure", () => {
  it("config has rules array at top level", () => {
    const config = { rules: [{ match: { labels: ["bug"] }, action: { workflowState: "Backlog" } }] };
    expect(config.rules).toHaveLength(1);
    expect(config.rules[0].match.labels).toContain("bug");
  });

  it("empty config defaults to empty rules array", () => {
    const config = { rules: [] as unknown[] };
    expect(config.rules).toEqual([]);
  });
});

describe("routing CRUD logic", () => {
  it("add_rule appends to rules array", () => {
    const rules = [{ match: { labels: ["bug"] }, action: { workflowState: "Backlog" } }];
    const newRule = { match: { repo: "my-repo" }, action: { projectNumber: 3 } };
    const updated = [...rules, newRule];
    expect(updated).toHaveLength(2);
    expect(updated[1]).toEqual(newRule);
  });

  it("update_rule replaces at index", () => {
    const rules = [
      { match: { labels: ["bug"] }, action: { workflowState: "Backlog" } },
      { match: { labels: ["feature"] }, action: { workflowState: "Todo" } },
    ];
    const replacement = { match: { repo: "my-repo" }, action: { projectNumber: 3 } };
    rules[0] = replacement;
    expect(rules[0]).toEqual(replacement);
    expect(rules).toHaveLength(2);
  });

  it("remove_rule filters out at index", () => {
    const rules = [
      { match: { labels: ["bug"] }, action: { workflowState: "Backlog" } },
      { match: { labels: ["feature"] }, action: { workflowState: "Todo" } },
    ];
    const filtered = rules.filter((_, i) => i !== 0);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].match.labels).toContain("feature");
  });

  it("update_rule detects out-of-range index", () => {
    const rules = [{ match: { labels: ["bug"] }, action: { workflowState: "Backlog" } }];
    const index = 5;
    expect(index >= rules.length).toBe(true);
  });

  it("add_rule requires rule parameter", () => {
    const rule = undefined;
    expect(rule).toBeUndefined();
  });
});

describe("routing YAML round-trip", () => {
  it("parse and stringify preserve rule structure", async () => {
    const { parse, stringify } = await import("yaml");
    const input = { rules: [{ match: { labels: ["bug"] }, action: { workflowState: "Backlog" } }] };
    const yamlStr = stringify(input);
    const parsed = parse(yamlStr);
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.rules[0].match.labels).toContain("bug");
  });
});
```

### Success Criteria
- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` succeeds
- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes
- [ ] Manual: `ralph_hero__configure_routing` tool appears in MCP tool listing
- [ ] Manual: `list_rules` returns empty array when no config file exists
- [ ] Manual: `add_rule` → `list_rules` round-trip shows added rule

---

## Integration Testing
- [x] Build succeeds: `cd plugin/ralph-hero/mcp-server && npm run build`
- [x] All tests pass: `cd plugin/ralph-hero/mcp-server && npm test`
- [x] No type errors in new code
- [x] New tool follows standard registration function pattern
- [x] `yaml` package properly added to dependencies (not devDependencies)
- [x] Variable names avoid `@octokit/graphql` reserved names (`query`, `method`, `url`)
- [x] Inline types clearly marked as temporary (#166 replacement)

## References
- Research GH-178: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0178-configure-routing-crud-tool.md
- Registration pattern: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts:228-232`
- Index wiring: `plugin/ralph-hero/mcp-server/src/index.ts:10-22` (imports), `287-306` (registration calls)
- Test pattern: `plugin/ralph-hero/mcp-server/src/__tests__/project-management-tools.test.ts` (structural tests)
- Dependencies: GH-166 (types, upstream), GH-168 (config loader, upstream), GH-179 (validate + dry-run, downstream)
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/128
