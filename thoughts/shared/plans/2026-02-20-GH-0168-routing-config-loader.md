---
date: 2026-02-20
status: draft
github_issues: [168]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/168
primary_issue: 168
---

# Implement Routing Config Loader and Live Validation - Implementation Plan

## Overview
1 issue creating the config loader library for the routing engine:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-168 | Implement routing config loader and live validation | XS |

## Current State Analysis

- `routing-types.ts` (GH-166) is merged to `main` with `RoutingConfigSchema`, `validateRoutingConfig()`, and all inferred types
- `yaml` package (v2.7.0) is already in `package.json` dependencies
- `FieldOptionCache` in `cache.ts:100-170` provides `resolveOptionId(fieldName, optionName)` for verifying workflow states, priorities, and estimates exist in the project
- `ensureFieldCache()` in `helpers.ts:91-113` populates the cache from project field data
- No config loading infrastructure exists -- zero `readFile` or `yaml.parse` calls in the MCP server source
- The `configure_routing` tool (GH-178, merged) uses inline `yaml.parse` without the loader -- should be updated later to use `loadRoutingConfig()`
- The routing Actions script (`scripts/routing/route.js`) has its own inline `loadConfig()` stub -- different consumer, not affected by this library
- Test patterns: vitest with pure unit tests (no mocks for file I/O), structural tests, `vi.mock` for GraphQL client

## Desired End State

### Verification
- [ ] `loadRoutingConfig(path)` returns `{ status: 'loaded', config, filePath }` for valid YAML files
- [ ] `loadRoutingConfig(path)` returns `{ status: 'missing', config: DEFAULT }` for non-existent files
- [ ] `loadRoutingConfig(path)` returns `{ status: 'error', errors }` for invalid YAML or schema failures
- [ ] `validateRulesLive(config, fieldCache)` returns errors for non-existent workflow states
- [ ] Fixture YAML files exist for all test scenarios
- [ ] `npm test` passes with new test file
- [ ] `npm run build` compiles the new module

## What We're NOT Doing
- No label validation via GitHub API (labels aren't cached by `FieldOptionCache`; deferred to a future issue)
- No project number validation via API (would require additional GraphQL calls per rule)
- No round-trip YAML editing with comment preservation (v1 uses `yaml.parse()` not `parseDocument()`)
- No refactoring of GH-178's inline YAML parsing (downstream update, separate issue)
- No refactoring of `scripts/routing/route.js` config loader (different consumer)
- No env var parsing for config file path (callers provide the path)

## Implementation Approach

Create a single new library file `lib/routing-config.ts` that provides two functions: `loadRoutingConfig()` for synchronous structural validation (file read + YAML parse + Zod schema), and `validateRulesLive()` for asynchronous referential validation (checking field values against `FieldOptionCache`). Test with real YAML fixture files rather than mocking `fs`.

---

## Phase 1: GH-168 -- Routing Config Loader and Live Validation
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/168 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0168-routing-config-loader.md

### Changes Required

#### 1. Create config loader library
**File**: `plugin/ralph-hero/mcp-server/src/lib/routing-config.ts` (NEW)

**Changes**: Create a module that exports `loadRoutingConfig`, `validateRulesLive`, and the `LoadResult`/`ConfigError` types.

**Constants and types**:
```typescript
import { readFile } from "fs/promises";
import { parse as yamlParse } from "yaml";
import { RoutingConfigSchema, type RoutingConfig } from "./routing-types.js";
import type { FieldOptionCache } from "./cache.js";

const DEFAULT_CONFIG: RoutingConfig = {
  version: 1,
  stopOnFirstMatch: true,
  rules: [],
};

export interface ConfigError {
  phase: "yaml_parse" | "schema_validation" | "live_validation";
  path: string[];
  message: string;
}

export type LoadResult =
  | { status: "loaded"; config: RoutingConfig; filePath: string }
  | { status: "missing"; config: RoutingConfig }
  | { status: "error"; errors: ConfigError[] };
```

**`loadRoutingConfig(configPath: string): Promise<LoadResult>`**:
1. Read file with `readFile(configPath, "utf-8")` -- catch `ENOENT`, return `{ status: "missing", config: DEFAULT_CONFIG }`; re-throw other errors (EACCES, etc.)
2. Parse YAML with `yamlParse(contents)` -- catch parse errors, return `{ status: "error", errors: [{ phase: "yaml_parse", path: [], message }] }`
3. Validate with `RoutingConfigSchema.safeParse(parsed)` -- if `!result.success`, map `result.error.issues` to `ConfigError[]` with `phase: "schema_validation"`, `path: issue.path.map(String)`, `message: issue.message`
4. If all pass, return `{ status: "loaded", config: result.data, filePath: configPath }`

**`validateRulesLive(config: RoutingConfig, fieldCache: FieldOptionCache): ConfigError[]`** (synchronous -- cache is already populated):
1. For each rule with `action.workflowState`: call `fieldCache.resolveOptionId("Workflow State", state)` -- if `undefined`, add error with `phase: "live_validation"`, path `["rules", ruleIndex, "action", "workflowState"]`, message `Workflow state "${state}" not found in project`
2. Return collected errors (empty array if all valid)

Note: Live validation is synchronous because `FieldOptionCache` is pre-populated. The caller is responsible for calling `ensureFieldCache()` before `validateRulesLive()`. This keeps the function pure and easily testable.

#### 2. Create YAML fixture files for tests
**Directory**: `plugin/ralph-hero/mcp-server/src/__tests__/fixtures/` (NEW)

**Files**:

**`valid-config.yml`**:
```yaml
version: 1
stopOnFirstMatch: true
rules:
  - name: "Route bugs to project 3"
    match:
      labels:
        any: ["bug"]
    action:
      projectNumber: 3
      workflowState: "Backlog"
  - name: "Route enhancements"
    match:
      labels:
        any: ["enhancement"]
    action:
      projectNumber: 3
```

**`empty-rules.yml`**:
```yaml
version: 1
rules: []
```

**`invalid-yaml.yml`**:
```
version: 1
rules:
  - name: "broken
    indentation problem
```

**`invalid-schema.yml`**:
```yaml
version: 2
rules:
  - match: {}
    action: {}
```

**`no-version.yml`**:
```yaml
rules:
  - match:
      repo: "owner/repo"
    action:
      projectNumber: 3
```

#### 3. Create test file
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/routing-config.test.ts` (NEW)

**Changes**: Vitest test suite following existing codebase patterns (pure imports, `describe`/`it`/`expect`):

```typescript
import { describe, it, expect } from "vitest";
import { join } from "path";
import { fileURLToPath } from "url";
import { loadRoutingConfig, validateRulesLive } from "../lib/routing-config.js";
import { FieldOptionCache } from "../lib/cache.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const fixtures = join(__dirname, "fixtures");
```

**Test cases for `loadRoutingConfig`**:

- `returns loaded status for valid config` -- load `valid-config.yml`, assert `status === "loaded"`, verify `config.version === 1`, `config.rules.length === 2`, `filePath` matches
- `returns loaded status for empty rules` -- load `empty-rules.yml`, assert `status === "loaded"`, `config.rules.length === 0`
- `returns missing status for non-existent file` -- load `nonexistent.yml`, assert `status === "missing"`, `config.version === 1`, `config.rules.length === 0`
- `returns error for invalid YAML` -- load `invalid-yaml.yml`, assert `status === "error"`, `errors[0].phase === "yaml_parse"`
- `returns error for invalid schema` -- load `invalid-schema.yml`, assert `status === "error"`, errors include `phase === "schema_validation"`
- `returns error for missing version` -- load `no-version.yml`, assert `status === "error"`, errors include schema validation failure

**Test cases for `validateRulesLive`**:

- `returns no errors when all workflow states exist` -- create `FieldOptionCache`, populate with `Workflow State` field having `Backlog` option, validate config with `workflowState: "Backlog"`, assert empty errors
- `returns errors for non-existent workflow state` -- populate cache without the referenced state, assert error with `phase === "live_validation"` and path including `workflowState`
- `returns no errors for rules without workflowState` -- validate config with only `projectNumber` action, assert empty errors
- `skips disabled rules` -- validate config with disabled rule referencing invalid state, assert empty errors

### Success Criteria
- [ ] Automated: `npm test` -- all tests pass including new `routing-config.test.ts`
- [ ] Automated: `npm run build` -- TypeScript compiles without errors
- [ ] Manual: `loadRoutingConfig` correctly discriminates between loaded/missing/error states
- [ ] Manual: `validateRulesLive` catches non-existent workflow states

---

## Integration Testing
- [ ] `npm run build` compiles `routing-config.ts` and emits to `dist/lib/`
- [ ] `npm test` passes all existing tests plus new tests
- [ ] `loadRoutingConfig` uses async file I/O (not `readFileSync`) for Node.js best practices
- [ ] `ConfigError` and `LoadResult` types are exported for downstream consumers
- [ ] No breaking changes to existing modules (new file only, no modifications to existing files)

## References
- Research GH-168: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0168-routing-config-loader.md
- Types (GH-166): [`lib/routing-types.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/routing-types.ts)
- Cache API: [`lib/cache.ts:100-170`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts#L100) (`FieldOptionCache.resolveOptionId`)
- Test pattern: [`__tests__/routing-types.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/routing-types.test.ts)
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/125
