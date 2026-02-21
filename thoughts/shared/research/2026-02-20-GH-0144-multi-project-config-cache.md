---
date: 2026-02-20
github_issue: 144
github_url: https://github.com/cdubiel08/ralph-hero/issues/144
status: complete
type: research
---

# GH-144: Extend Config and Field Cache for Multi-Project Support

## Problem Statement

The ralph-hero MCP server is hardcoded to operate against a single GitHub Projects V2 project per process. `GitHubClientConfig` stores one `projectNumber`, `FieldOptionCache` holds one project's field data, and `ensureFieldCache` short-circuits after the first project loads. To support cross-project dashboard aggregation (#102), the config and cache layers must support multiple projects while maintaining backward compatibility for all existing single-project tools.

## Current State Analysis

### `GitHubClientConfig` — Single Project Number

[`types.ts:263-270`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L263):

```typescript
export interface GitHubClientConfig {
  token: string;
  projectToken?: string;
  owner?: string;
  repo?: string;
  projectNumber?: number;      // single value
  projectOwner?: string;
}
```

**12 direct references** to `config.projectNumber` across 7 files. Two access patterns:
- **Override-capable**: `args.number || client.config.projectNumber` (project-tools.ts, view-tools.ts — 4 sites)
- **Direct read**: `client.config.projectNumber` (issue-tools.ts, dashboard-tools.ts, relationship-tools.ts, helpers.ts, index.ts — 8 sites)

### `FieldOptionCache` — Single Project Store

[`cache.ts:100-189`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts#L100):

| Property | Type | Purpose |
|----------|------|---------|
| `projectId` | `string \| undefined` | Single GraphQL node ID (`PVT_...`) |
| `fields` | `Map<string, Map<string, string>>` | `fieldName → optionName → optionId` |
| `fieldIds` | `Map<string, string>` | `fieldName → fieldId` |

**Critical limitation**: `populate()` at [`cache.ts:121-123`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts#L121) calls `this.fields.clear()` and `this.fieldIds.clear()` before refilling — loading a second project destroys the first project's data.

**`isPopulated()` at [`cache.ts:162-164`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts#L162)**: Returns `this.fields.size > 0` — no project identity check. Once populated for project A, it returns `true` even when operating on project B.

One instance shared across all 7 tool registrars ([`index.ts:284-306`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts#L284)).

### `ensureFieldCache` — Single-Shot Guard

Canonical version at [`helpers.ts:91-113`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L91):

```typescript
export async function ensureFieldCache(
  client: GitHubClient, fieldCache: FieldOptionCache,
  owner: string, projectNumber: number
): Promise<void> {
  if (fieldCache.isPopulated()) return;   // short-circuit
  const project = await fetchProjectForCache(client, owner, projectNumber);
  fieldCache.populate(project.id, project.fields.nodes.map(...));
}
```

Three local duplicate variants exist (project-tools.ts, view-tools.ts, dashboard-tools.ts) with identical behavior.

**Bug with multi-project**: `isPopulated()` returns `true` after first project loads, so `ensureFieldCache` for a second project silently skips, returning stale data from the first project.

### `resolveFullConfig` — No Project Override

[`helpers.ts:345-363`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L345):

```typescript
export function resolveFullConfig(client, args): ResolvedConfig {
  const { owner, repo } = resolveConfig(client, args);
  const projectNumber = client.config.projectNumber;  // always reads single value
  // ...
  return { owner, repo, projectNumber, projectOwner };
}
```

Called at 14 sites across issue-tools.ts (8), project-management-tools.ts (5), batch-tools.ts (1). All receive the same single `projectNumber`.

### Environment Variable Parsing

[`index.ts:68-70`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts#L68):

```typescript
const projectNumber = resolveEnv("RALPH_GH_PROJECT_NUMBER")
  ? parseInt(resolveEnv("RALPH_GH_PROJECT_NUMBER")!, 10)
  : undefined;
```

No array parsing, no comma splitting. Single `parseInt` call.

### `fetchProjectForCache` — Already Parameterized

[`helpers.ts:41-85`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L41): Takes `(client, owner, number)` parameters — already works for any project number. Tries both `user` and `organization` owner types. Caches responses for 10 minutes via `SessionCache`.

## Key Discoveries

### 1. Prior Art: GH-23 Research Already Proposed the Pattern

[`GH-0023-multi-repo-support.md:285-302`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-16-GH-0023-multi-repo-support.md) proposed:

```typescript
class FieldOptionCache {
  private projects = new Map<string, {
    fields: Map<string, Map<string, string>>;
    fieldIds: Map<string, string>;
  }>();

  populate(projectId: string, fields: FieldDef[]): void;
  resolveOptionId(projectId: string, fieldName: string, optionName: string): string | undefined;
}
```

This is the right approach — key the cache by `projectId` (string, the GraphQL node ID). The GH-23 research noted: "For multi-repo on a **single project**, the current cache works fine — all repos share the same project fields."

### 2. Key By Project Number, Not Project ID

The GH-23 proposal keys by `projectId` (GraphQL node ID like `PVT_kwDO...`). However, callers know `projectNumber` (integer) at call time, not `projectId`. The cache itself resolves `projectNumber → projectId` during `populate()`.

**Recommended**: Key the internal Map by `projectNumber` (number), store `projectId` inside the per-project entry:

```typescript
private projects = new Map<number, {
  projectId: string;
  fields: Map<string, Map<string, string>>;
  fieldIds: Map<string, string>;
}>();
```

This avoids requiring callers to know the GraphQL node ID before calling `resolveOptionId()`.

### 3. Blast Radius Is Contained

The changes are tightly scoped:

| Layer | Change | Files |
|-------|--------|-------|
| Config | Add `projectNumbers?: number[]` | `types.ts` |
| Config | Add `resolveProjectNumbers()` helper | `types.ts` |
| Env parsing | Parse `RALPH_GH_PROJECT_NUMBERS` (comma-separated) | `index.ts` |
| Cache | Make `FieldOptionCache` multi-project-aware | `cache.ts` |
| Guard | Update `ensureFieldCache` to pass `projectNumber` through | `helpers.ts` |

**No tool files need to change** for this issue. Existing single-project tools continue to call `ensureFieldCache(client, fieldCache, owner, projectNumber)` with the same single `projectNumber` from `resolveFullConfig()` — they just don't know the cache can now hold multiple projects. The multi-project dashboard tools (#145) will be the first callers to use `resolveProjectNumbers()` and iterate.

### 4. `ensureFieldCache` Needs Identity Check

The guard `if (fieldCache.isPopulated()) return` must become project-aware:

```typescript
if (fieldCache.isPopulated(projectNumber)) return;
```

This is the most important behavioral change — without it, the second project's cache load silently skips.

### 5. Method Signature Changes

All `FieldOptionCache` methods need a `projectNumber` parameter:

| Method | Current | New |
|--------|---------|-----|
| `isPopulated()` | `(): boolean` | `(projectNumber?: number): boolean` |
| `populate()` | `(projectId, fields)` | `(projectNumber, projectId, fields)` |
| `getProjectId()` | `(): string \| undefined` | `(projectNumber?: number): string \| undefined` |
| `resolveOptionId()` | `(fieldName, optionName)` | `(projectNumber: number \| undefined, fieldName, optionName)` or keep current |
| `getFieldId()` | `(fieldName)` | `(projectNumber: number \| undefined, fieldName)` or keep current |

**Backward compatibility approach**: When `projectNumber` is `undefined`, fall back to the first (or only) populated project. This keeps all existing callers working without modification.

### 6. `resolveProjectNumbers()` Helper

Simple helper that returns all configured project numbers:

```typescript
export function resolveProjectNumbers(config: GitHubClientConfig): number[] {
  if (config.projectNumbers?.length) return config.projectNumbers;
  if (config.projectNumber) return [config.projectNumber];
  return [];
}
```

Only used by new multi-project tools (#145). Single-project tools continue using `config.projectNumber` directly.

### 7. `RALPH_GH_PROJECT_NUMBERS` Parsing

Follow existing env var patterns — comma-separated string:

```typescript
const projectNumbers = resolveEnv("RALPH_GH_PROJECT_NUMBERS")
  ? resolveEnv("RALPH_GH_PROJECT_NUMBERS")!
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n))
  : undefined;
```

Existing `RALPH_GH_PROJECT_NUMBER` continues to work for single-project users. `projectNumbers` is additive.

### 8. Call Site Count for Cache Methods

| Method | Call Sites | Requires Change? |
|--------|-----------|-----------------|
| `isPopulated()` | 4 (1 canonical + 3 local) | Yes — add `projectNumber` param |
| `populate()` | 4 (1 canonical + 3 local) | Yes — add `projectNumber` param |
| `getProjectId()` | 13 | Yes if callers pass projectNumber; No if defaulting |
| `resolveOptionId()` | 5 | No if defaulting to first project |
| `getFieldId()` | 6 | No if defaulting to first project |
| `getOptionNames()` | 3 | No if defaulting |
| `getFieldNames()` | 2 | No if defaulting |
| `clear()` | 2 | Clears all projects — no change needed |

**With the fallback approach** (undefined → first project), only `isPopulated`, `populate`, and `ensureFieldCache` callers need updates. All other methods work unchanged.

## Potential Approaches

### Approach A: Map-Keyed `FieldOptionCache` with Optional `projectNumber` (Recommended)

Refactor `FieldOptionCache` internals to use `Map<number, ProjectCacheData>` while keeping method signatures backward-compatible via optional `projectNumber` parameter defaulting to the first/only project.

**Pros:** Minimal blast radius (only cache.ts and helpers.ts change), backward-compatible, no tool file changes needed.
**Cons:** "First project" default is slightly magical — unclear which project is "default" when multiple are loaded.

### Approach B: Separate `MultiProjectFieldCache` Class

Create a new class that wraps multiple `FieldOptionCache` instances, one per project. Existing code continues to use the original `FieldOptionCache` for the primary project.

**Pros:** Zero risk to existing code, complete isolation.
**Cons:** Two cache classes to maintain, dashboard tools need different cache type than other tools, more complexity.

### Approach C: Pass `projectNumber` Everywhere

Update all cache method signatures to require `projectNumber`, update all 38 call sites.

**Pros:** Explicit, no ambiguity about which project is referenced.
**Cons:** Large blast radius — 38 call sites across 7 files, many of which don't need multi-project support.

### Recommendation: Approach A

Keeps the change contained to `cache.ts`, `types.ts`, `index.ts`, and the canonical `ensureFieldCache` in `helpers.ts`. Existing tools work without modification. The dashboard tools (#145) will be the first to exercise the multi-project path.

## Risks

1. **Local `ensureFieldCache` duplicates**: Three tool files (project-tools.ts, view-tools.ts, dashboard-tools.ts) have local duplicates that also use `fieldCache.isPopulated()` without project identity. These must be updated or consolidated to the canonical version in helpers.ts.
2. **Default project ambiguity**: When `projectNumber` is undefined, defaulting to "first populated" works for single-project but could be confusing in multi-project scenarios if callers forget to pass the number.
3. **Memory growth**: Each project's field cache is small (~20 fields × ~10 options), but the `SessionCache` query results for multi-project fetches could add up. The 10-minute TTL on `fetchProjectForCache` responses helps.
4. **Test coverage**: No existing tests for `FieldOptionCache`. This issue should add tests for both single-project and multi-project scenarios.

## Recommended Next Steps

1. Add `projectNumbers?: number[]` to `GitHubClientConfig` in `types.ts`
2. Add `resolveProjectNumbers()` helper in `types.ts`
3. Parse `RALPH_GH_PROJECT_NUMBERS` env var in `index.ts`
4. Refactor `FieldOptionCache` to use `Map<number, ProjectCacheData>` with optional `projectNumber` params
5. Update canonical `ensureFieldCache` in `helpers.ts` to pass `projectNumber` through
6. Update the 3 local `ensureFieldCache` duplicates (or consolidate to canonical)
7. Add unit tests for `FieldOptionCache` single-project and multi-project paths
8. Leave tool files unchanged — they continue using the single-project path via `resolveFullConfig`
