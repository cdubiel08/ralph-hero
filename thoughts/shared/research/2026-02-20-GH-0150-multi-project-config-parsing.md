---
date: 2026-02-20
github_issue: 150
github_url: https://github.com/cdubiel08/ralph-hero/issues/150
status: complete
type: research
---

# GH-150: Parse `RALPH_GH_PROJECT_NUMBERS` and Extend `resolveFullConfig` for Multi-Project

## Problem Statement

The ralph-hero MCP server supports a single project per process. `resolveFullConfig()` always reads `client.config.projectNumber` with no per-call override. Tools that need to operate on a different project (e.g., cross-project dashboard, multi-project batch operations) have no way to specify which project to target.

## Scope Overlap with GH-144

**Critical finding**: GH-150 (child of #103) and GH-144 (child of #102) share 3 of 4 scope items:

| Change | GH-144 | GH-150 | Overlap? |
|--------|--------|--------|----------|
| Add `projectNumbers?: number[]` to `GitHubClientConfig` | Yes | Yes | **Full overlap** |
| Add `resolveProjectNumbers()` helper | Yes (types.ts) | Yes (helpers.ts) | **Full overlap** (minor file placement diff) |
| Parse `RALPH_GH_PROJECT_NUMBERS` env var | Yes | Yes | **Full overlap** |
| Refactor `FieldOptionCache` to multi-project Map | Yes | No | GH-144 only |
| Update `ensureFieldCache` identity guard | Yes | No | GH-144 only |
| Extend `resolveFullConfig` args with `projectNumber` | No | Yes | **GH-150 only** |

**Recommendation**: GH-144 should absorb the shared foundation (items 1-3). GH-150's scope should be narrowed to its unique contribution: extending `resolveFullConfig` to accept `projectNumber` from args. Add a blocking dependency: #150 blocked by #144.

## Current State Analysis

### `resolveFullConfig` — No Per-Call Override

[`helpers.ts:345-363`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L345):

```typescript
export function resolveFullConfig(
  client: GitHubClient,
  args: { owner?: string; repo?: string },  // no projectNumber
): ResolvedConfig {
  const { owner, repo } = resolveConfig(client, args);
  const projectNumber = client.config.projectNumber;  // always from config
  if (!projectNumber) throw new Error("...");
  const projectOwner = resolveProjectOwner(client.config);
  if (!projectOwner) throw new Error("...");
  return { owner, repo, projectNumber, projectOwner };
}
```

`projectNumber` is sourced exclusively from `client.config.projectNumber` — no `args` override path exists.

### `ResolvedConfig` Return Type

[`helpers.ts:30-35`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L30):

```typescript
export interface ResolvedConfig {
  owner: string;
  repo: string;
  projectNumber: number;
  projectOwner: string;
}
```

### 14 Call Sites of `resolveFullConfig`

| File | Count | Lines | Tool `args` has `projectNumber`? |
|------|-------|-------|----------------------------------|
| `issue-tools.ts` | 8 | 95, 583, 907, 991, 1045, 1160, 1244, 1398 | No — `args.number` exists but means issue number |
| `project-management-tools.ts` | 5 | 52, 123, 184, 255, 348 | No — `args.number` means issue number |
| `batch-tools.ts` | 1 | 238 | No |

Every call passes the tool's full `args` object. Since `resolveFullConfig` only destructures `{ owner?, repo? }`, the `number` field present in many tool schemas (which refers to issue number, not project number) is safely ignored.

### 4 Tools That Bypass `resolveFullConfig`

These already have per-call project number override via `args.number || client.config.projectNumber`:

| Tool | File | Line | Schema Param |
|------|------|------|-------------|
| `get_project` | `project-tools.ts` | 329 | `number: z.number().optional()` |
| `list_project_items` | `project-tools.ts` | 416 | `number: z.number().optional()` |
| `list_views` | `view-tools.ts` | 47 | `number: z.number().optional()` |
| `update_field_options` | `view-tools.ts` | 126 | `number: z.number().optional()` |

These use `number` (not `projectNumber`) as the param name, which conflicts with the issue-number `number` param used in 14 other tools. This naming collision is addressed in GH-151.

### 2 Tools With Inline Resolution (No Helper)

| Tool | File | Lines | Pattern |
|------|------|-------|---------|
| `advance_children` | `relationship-tools.ts` | 552-558 | Manual `client.config.projectNumber` + `resolveProjectOwner` |
| `advance_parent` | `relationship-tools.ts` | 735-741 | Identical manual pattern |

## Key Discoveries

### 1. GH-150's Unique Contribution: `resolveFullConfig` Args Extension

The only change exclusive to GH-150 is:

```typescript
// Current (helpers.ts:347)
args: { owner?: string; repo?: string }

// Proposed
args: { owner?: string; repo?: string; projectNumber?: number }
```

With resolution priority: `args.projectNumber ?? client.config.projectNumber`.

This is a small, backward-compatible change. All 14 existing call sites pass `args` objects that don't have `projectNumber`, so they continue using `client.config.projectNumber`. New or updated tools (GH-151) can start passing `projectNumber` through.

### 2. Naming: `projectNumber` Not `number`

The 4 bypass tools use `number` as the schema param name for project number. The 14 `resolveFullConfig` tools use `number` for issue number. Adding `projectNumber` as a distinct param avoids the collision:

```typescript
// Tool schema
projectNumber: z.number().optional()
  .describe("Project number override (defaults to configured project)")
```

This is cleaner than overloading `number` which means different things in different tools.

### 3. No `ensureFieldCache` Change Needed Here

`ensureFieldCache` already takes `projectNumber` as a parameter ([`helpers.ts:94`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L94)). Once `resolveFullConfig` returns the correct `projectNumber` (from args or config), it flows naturally through the existing pattern:

```typescript
const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(client, args);
await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);
```

The cache identity check fix (making `isPopulated(projectNumber)` project-aware) is in GH-144's scope.

### 4. Backward Compatibility Is Trivial

The change adds an optional field to the `args` type. TypeScript's structural typing means existing call sites passing `{ owner?, repo? }` objects continue to work — the missing `projectNumber` resolves to `undefined`, which triggers the fallback to `client.config.projectNumber`. Zero existing call sites break.

### 5. Group Dependency Chain

The #103 group has a clear dependency chain:
1. **#150** — Config parsing + `resolveFullConfig` extension (this issue)
2. **#151** — Add `projectNumber` param to 16 project-aware tools (depends on #150)
3. **#152** — Document in CLAUDE.md (depends on #150 + #151)

Cross-group: #150 should be blocked by #144 (shared config foundation). #151's mechanical tool changes depend on #150's `resolveFullConfig` update.

## Potential Approaches

### Approach A: Narrow GH-150 to `resolveFullConfig` Only (Recommended)

Since GH-144 already covers the shared foundation (config type, env parsing, `resolveProjectNumbers`), GH-150 should be narrowed to:

1. Extend `resolveFullConfig` args type with optional `projectNumber`
2. Add resolution priority logic: `args.projectNumber ?? client.config.projectNumber`
3. Tests for the override behavior

**Pros:** No duplication with GH-144, clean ticket boundaries, minimal scope.
**Cons:** Requires implementing GH-144 first.

### Approach B: GH-150 Absorbs All Shared Foundation

Move the shared items (config type, env parsing, `resolveProjectNumbers`) into GH-150's scope, making GH-144 focused only on cache refactoring.

**Pros:** Config-related changes grouped together.
**Cons:** GH-144 research doc already covers these items; would require re-scoping GH-144.

### Recommendation: Approach A

GH-144's research is complete and comprehensively covers the shared foundation. GH-150 should add a `blockedBy: #144` dependency and narrow its scope to the `resolveFullConfig` extension only. This keeps both tickets clean and avoids merge conflicts.

## Risks

1. **Merge conflict with GH-144**: If both are implemented independently, `types.ts` and `index.ts` will conflict on the same lines. The blocking dependency prevents this.
2. **`number` vs `projectNumber` naming**: Sibling #151 must use `projectNumber` (not `number`) consistently to avoid confusion with issue-number `number` params. This should be documented in #151's scope.
3. **4 bypass tools need alignment**: The 4 tools in project-tools.ts and view-tools.ts that already use `args.number || client.config.projectNumber` should eventually be updated to use `resolveFullConfig` for consistency, but this is out of scope for #150.

## Recommended Next Steps

1. **Add blocking dependency**: #150 blocked by #144
2. **Narrow #150 scope** to `resolveFullConfig` args extension only (remove overlapping items)
3. Extend `resolveFullConfig` args type: `{ owner?, repo?, projectNumber? }`
4. Add resolution: `args.projectNumber ?? client.config.projectNumber`
5. Add tests verifying override and fallback behavior
6. Leave tool schema changes to #151
