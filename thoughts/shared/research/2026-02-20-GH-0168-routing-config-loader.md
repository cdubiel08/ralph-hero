---
date: 2026-02-20
github_issue: 168
github_url: https://github.com/cdubiel08/ralph-hero/issues/168
status: complete
type: research
---

# GH-168: Implement Routing Config Loader and Live Validation

## Problem Statement

The routing engine needs a config loader that reads `.ralph-routing.yml` from a repository path, validates it against the Zod schemas defined by GH-166, and optionally performs live validation against the GitHub API to verify that referenced workflow states, labels, and priorities actually exist in the project. Downstream consumers (#178 CRUD tool, #171 Actions evaluation script) need a single `loadRoutingConfig()` function they can call instead of inline `yaml.parse` + manual validation.

## Current State Analysis

### No Config Loading Infrastructure Exists

Zero YAML parsing, config loading, or routing-related source files exist in `plugin/ralph-hero/mcp-server/src/`. The MCP server's only configuration mechanism is environment variables via `resolveEnv()` in [`index.ts:28-33`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts#L28). No `yaml` or `js-yaml` package exists in `package.json` dependencies.

### GH-166 Types Implemented (Not Yet Merged)

The `feature/GH-166` branch contains [`lib/routing-types.ts`](https://github.com/cdubiel08/ralph-hero/blob/feature/GH-166/plugin/ralph-hero/mcp-server/src/lib/routing-types.ts) with:

- `RoutingConfigSchema` — top-level Zod schema: `{ version: z.literal(1), stopOnFirstMatch, rules }`
- `RoutingRuleSchema` — `{ name, match, action, enabled }`
- `MatchCriteriaSchema` — `{ repo, labels: { any, all }, issueType, negate }` with `.refine()` requiring at least one criterion
- `RoutingActionSchema` — `{ projectNumber, projectNumbers, workflowState, labels }` with `.refine()` requiring at least one action
- `validateRoutingConfig(data: unknown): RoutingConfig` — throws `ZodError` on failure
- Inferred types: `MatchCriteria`, `RoutingAction`, `RoutingRule`, `RoutingConfig`

GH-168 imports `RoutingConfigSchema` from this module for post-YAML-parse validation.

### Downstream Consumer Expectations

The GH-178 research ([`2026-02-20-GH-0178-configure-routing-crud-tool.md:260-262`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0178-configure-routing-crud-tool.md)) defines the expected API:

> Once #168 is done, #178's `readFile + parse` inline should be replaced with `loadRoutingConfig(configPath, client)` from `lib/routing-config.ts`.

The GH-178 implementation plan currently uses an inline `yaml.parse` without validation as a temporary measure until GH-168 is available.

### FieldOptionCache — Live Validation Data Source

The existing `FieldOptionCache` ([`cache.ts:113-157`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts#L113)) stores:

- All workflow state option names and IDs
- All priority option names and IDs
- All estimate option names and IDs

This cache is populated by `ensureFieldCache()` ([`helpers.ts:91-113`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L91)) which queries the project's field definitions. The live validation step can use `fieldCache.resolveOptionId(fieldName, optionName)` to check whether a referenced workflow state or priority exists in the project — returning `undefined` for non-existent values.

However, the `FieldOptionCache` does not store repository labels. Label validation requires a separate GitHub API query (`repository.labels`).

### Test Patterns in the Codebase

The test suite uses vitest `^4.0.18` with these patterns:

1. **Pure unit tests** — no mocks, import functions directly (e.g., `workflow-states.test.ts`)
2. **Structural tests** — read `.ts` source as a string via `fs.readFileSync`, assert content (`project-tools.test.ts`)
3. **Module-level mock** — `vi.mock("@octokit/graphql", ...)` for client tests
4. **No file I/O mocking** — no `vi.mock("fs")` or `vi.mock("node:fs")` patterns exist

The config loader introduces the codebase's first file I/O tests. For pure unit tests of `loadRoutingConfig`, the simplest approach is to create test fixture YAML files in the test directory and point the loader at them, rather than mocking `fs`.

## Key Discoveries

### 1. YAML Parser Selection: `yaml` Package

The `yaml` package (eemeli/yaml) is the recommended YAML parser over `js-yaml`:

| Aspect | `yaml` | `js-yaml` |
|--------|--------|-----------|
| TypeScript types | Native (bundled) | Separate `@types/js-yaml` |
| Non-throwing parse | `parseDocument()` → `doc.errors[]` | No — `load()` throws |
| YAML spec | 1.2 Core Schema | 1.2 |
| Downloads | ~85M/week | ~164M/week |
| Comment preservation | Yes (Document API) | No |

The non-throwing `parseDocument()` API is critical: YAML syntax errors can be collected alongside Zod validation errors in a unified error report, rather than requiring a separate try/catch layer.

### 2. Two-Phase Validation Architecture

**Phase 1: Structural (synchronous)** — YAML parse + Zod schema validation
- `yaml.parseDocument()` → check `doc.errors` → `doc.toJS()` → `RoutingConfigSchema.safeParse()`
- Catches: invalid YAML syntax, missing required fields, wrong types, invalid enum values

**Phase 2: Referential / Live (async)** — GitHub API checks
- Verify that `action.workflowState` values exist in the project's Workflow State field
- Verify that `action.labels` exist in the repository
- Verify that `action.projectNumber` / `action.projectNumbers` resolve to real projects
- Uses `FieldOptionCache.resolveOptionId()` for workflow state/priority checks
- Uses GitHub API for label checks (not cached)

Keep these phases separate — Phase 2 only runs if Phase 1 passes, avoiding API calls for structurally invalid configs. The live validation function is a standalone function, not embedded in Zod refinements, making it independently testable and cacheable.

### 3. Graceful Missing File Handling

When `.ralph-routing.yml` doesn't exist:
- Return a default empty config: `{ version: 1, stopOnFirstMatch: true, rules: [] }`
- Log a notice, don't error
- This makes the routing engine opt-in — repositories without a config file simply have no routing rules

Use `ENOENT` error code detection rather than `fs.existsSync()` to avoid TOCTOU race conditions:

```typescript
try {
  contents = await fs.readFile(filePath, 'utf-8');
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    return { status: 'missing', config: DEFAULT_CONFIG };
  }
  throw err; // EACCES, etc. should still fail
}
```

### 4. Return Type: Discriminated Union

The loader should return a discriminated union for explicit caller handling:

```typescript
type LoadResult =
  | { status: 'loaded'; config: RoutingConfig; filePath: string }
  | { status: 'missing'; config: RoutingConfig }  // default empty config
  | { status: 'error'; errors: ConfigError[] };

interface ConfigError {
  phase: 'yaml_parse' | 'schema_validation' | 'live_validation';
  path: string[];
  message: string;
}
```

This mirrors the MCP server's existing pattern of returning structured objects with clear success/failure semantics rather than throwing exceptions.

### 5. Config File Path Resolution

The GH-178 research establishes the pattern: `RALPH_ROUTING_CONFIG` env var with `process.cwd() + '/.ralph-routing.yml'` default. However, for GH-168's scope (the loader library function), the path should be a parameter — the caller decides how to resolve it. The env var parsing belongs to the tool that calls the loader (#178), not the loader itself.

### 6. Dependency Chain Refinement

The original triage comment says "#168 is blocked by #167 (matching engine)". However, the GH-166 research doc clarifies ([line 220-223](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0166-routing-rules-config-schema.md#L220)):

> **Recommended parallel tracks:**
> - Track 1: #166 (types) → #168 (config loader)
> - Track 2: #167 (matching engine) — parallel with #166

GH-168 depends only on GH-166 (types/schemas). The config loader doesn't use the matching engine — it just validates config structure and field references. GH-167 (matching engine) is a sibling, not a blocker.

**Current state:**
- GH-166: Implemented on `feature/GH-166` branch, PR pending merge
- GH-167: Research in progress (T-67)
- GH-168: This issue — can proceed once GH-166 merges

### 7. No `yaml` in package.json — Must Be Added

The `yaml` package is not currently in `package.json` dependencies. It appears only as an optional peer dependency of vitest. GH-168 implementation must add it:

```bash
npm install yaml
```

This adds the first file-format parsing dependency to the MCP server. The `yaml` package has zero transitive dependencies, so the footprint is minimal.

## Recommended Approach

### New File: `plugin/ralph-hero/mcp-server/src/lib/routing-config.ts`

```typescript
import { readFile } from "fs/promises";
import { parseDocument } from "yaml";
import { RoutingConfigSchema, type RoutingConfig } from "./routing-types.js";

const CONFIG_FILENAME = ".ralph-routing.yml";
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

export async function loadRoutingConfig(configPath: string): Promise<LoadResult>;
```

### Exports

1. `loadRoutingConfig(configPath: string): Promise<LoadResult>` — Phase 1: read file, parse YAML, validate schema
2. `validateRulesLive(config: RoutingConfig, fieldCache: FieldOptionCache, client: GitHubClient): Promise<ConfigError[]>` — Phase 2: check references against GitHub API
3. `ConfigError`, `LoadResult` types

### Implementation Flow

```
loadRoutingConfig(path)
  ├── readFile(path) → catch ENOENT → { status: 'missing', config: DEFAULT }
  ├── parseDocument(contents) → check doc.errors → collect yaml_parse errors
  ├── doc.toJS() → RoutingConfigSchema.safeParse() → collect schema_validation errors
  └── return { status: 'loaded', config } or { status: 'error', errors }

validateRulesLive(config, fieldCache, client)
  ├── for each rule.action.workflowState → fieldCache.resolveOptionId("Workflow State", state)
  ├── for each rule.action.labels → client query: repository.label(name:)
  ├── for each rule.action.projectNumber → client query: user/org projectV2(number:)
  └── return ConfigError[] (empty if all valid)
```

### Test Strategy

**Pure unit tests** (no mocks):
- Create YAML fixture files in `src/__tests__/fixtures/`:
  - `valid-config.yml` — full valid config
  - `invalid-yaml.yml` — malformed YAML
  - `invalid-schema.yml` — valid YAML, fails Zod (e.g., missing `version`)
  - `empty-rules.yml` — valid but no rules
- Test `loadRoutingConfig()` with real file paths to fixtures
- Test missing file path returns `{ status: 'missing' }`
- Test `validateRulesLive()` with mock `FieldOptionCache` (in-memory, no file I/O)

## Risks

1. **GH-166 not merged**: `routing-types.ts` only exists on `feature/GH-166` branch. GH-168 implementation must wait for GH-166 to merge, or branch from `feature/GH-166`. Branching from a feature branch is fragile — prefer waiting for merge.

2. **New dependency**: Adding `yaml` is the first file-format parser in the MCP server. It has zero transitive deps and is well-maintained, but it's a new category of dependency. The `prepublishOnly` build step handles it fine since it's a production dependency.

3. **Live validation scope**: Label validation requires a GitHub API call per label (no cache). For configs with many labels, this could be slow. Consider batching with a single `repository.labels(first: 100)` query and checking locally.

4. **File path in MCP context**: When the MCP server runs via `npx`, `process.cwd()` may not be the repo root. The config path must be explicitly provided by callers (env var or tool parameter), not assumed.

5. **YAML comment loss**: Using `yaml.parse()` (simple API) loses comments. The GH-178 research accepts this for v1. If round-trip editing with comment preservation is needed later, upgrade to `parseDocument()` + `doc.toString()`.

## Recommended Next Steps

1. Wait for GH-166 (`feature/GH-166`) to merge to main
2. Add `yaml` to `package.json` dependencies
3. Create `lib/routing-config.ts` with `loadRoutingConfig()` and `validateRulesLive()`
4. Create `__tests__/routing-config.test.ts` with fixture YAML files
5. Export `ConfigError` and `LoadResult` types for consumer use
6. Update GH-168 blockedBy to reference GH-166 only (remove GH-167 if present)
