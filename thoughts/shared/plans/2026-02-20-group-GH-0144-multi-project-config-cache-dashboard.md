---
date: 2026-02-20
github_issues: [144, 145, 150]
parent_epic: 102
status: draft
type: plan
---

# Group Plan: Multi-Project Config, Cache, and Dashboard

**Issues**: #144 (Extend config and field cache), #145 (Multi-project dashboard fetching), #150 (resolveFullConfig extension)
**Parent**: #102 (Multi-Project Dashboard Support)
**Excluded**: #146 (Cross-project aggregation) -- Backlog, not Ready for Plan

## Dependency Chain

```
Phase 1: GH-144 — Config type + env parsing + FieldOptionCache refactor
Phase 2: GH-150 — resolveFullConfig args extension (depends on Phase 1)
Phase 3: GH-145 — Multi-project dashboard fetching (depends on Phase 1 + 2)
```

GH-150's research identified significant scope overlap with GH-144 (config type, env parsing, resolveProjectNumbers). The plan absorbs the shared foundation into Phase 1 (GH-144) and narrows GH-150 to its unique contribution: the `resolveFullConfig` args extension.

## File Ownership

| File | Phase | Change |
|------|-------|--------|
| `src/types.ts` | 1 | Add `projectNumbers?: number[]`, add `resolveProjectNumbers()` |
| `src/lib/cache.ts` | 1 | Refactor `FieldOptionCache` to `Map<number, ProjectCacheData>` |
| `src/lib/helpers.ts` | 1, 2 | Update `ensureFieldCache` identity check (P1); extend `resolveFullConfig` args (P2) |
| `src/index.ts` | 1 | Parse `RALPH_GH_PROJECT_NUMBERS` env var |
| `src/lib/dashboard.ts` | 3 | Add `projectNumber?`, `projectTitle?` to `DashboardItem` |
| `src/tools/dashboard-tools.ts` | 3 | Add `projectNumbers` param, multi-project fetch loop, update `toDashboardItems` |
| `src/__tests__/cache.test.ts` | 1 | NEW -- unit tests for `FieldOptionCache` |
| `src/__tests__/dashboard.test.ts` | 3 | Add multi-project `DashboardItem` tests |
| `src/__tests__/helpers.test.ts` | 2 | Add `resolveFullConfig` override tests |

---

## Phase 1: Config + Cache Foundation (GH-144)

**Goal**: Make `FieldOptionCache` multi-project-aware with backward-compatible API. Add `projectNumbers` config and env parsing.

### Step 1.1: Add `projectNumbers` to `GitHubClientConfig`

**File**: `src/types.ts` (lines 263-270)

Add `projectNumbers?: number[]` field and `resolveProjectNumbers()` helper:

```typescript
export interface GitHubClientConfig {
  token: string;
  projectToken?: string;
  owner?: string;
  repo?: string;
  projectNumber?: number;
  projectNumbers?: number[];       // NEW: multiple project numbers
  projectOwner?: string;
}

/**
 * Return all configured project numbers.
 * Prefers projectNumbers array; falls back to single projectNumber.
 */
export function resolveProjectNumbers(config: GitHubClientConfig): number[] {
  if (config.projectNumbers?.length) return config.projectNumbers;
  if (config.projectNumber) return [config.projectNumber];
  return [];
}
```

### Step 1.2: Parse `RALPH_GH_PROJECT_NUMBERS` env var

**File**: `src/index.ts` (lines 72-74, inside `initGitHubClient`)

After existing `projectNumber` parsing, add:

```typescript
const projectNumbers = resolveEnv("RALPH_GH_PROJECT_NUMBERS")
  ? resolveEnv("RALPH_GH_PROJECT_NUMBERS")!
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n))
  : undefined;
```

Pass `projectNumbers` to `createGitHubClient()` config object (line 102-109).

### Step 1.3: Refactor `FieldOptionCache` to multi-project Map

**File**: `src/lib/cache.ts` (lines 100-189)

Replace flat `fields`/`fieldIds`/`projectId` with a `Map<number, ProjectCacheData>`:

```typescript
interface ProjectCacheData {
  projectId: string;
  fields: Map<string, Map<string, string>>;
  fieldIds: Map<string, string>;
}

export class FieldOptionCache {
  private projects = new Map<number, ProjectCacheData>();
  /** Track the first populated project number for backward compat */
  private defaultProjectNumber: number | undefined;

  populate(
    projectNumber: number,
    projectId: string,
    fields: Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }>,
  ): void {
    const fieldMap = new Map<string, Map<string, string>>();
    const fieldIdMap = new Map<string, string>();
    for (const field of fields) {
      fieldIdMap.set(field.name, field.id);
      if (field.options) {
        const optionMap = new Map<string, string>();
        for (const option of field.options) {
          optionMap.set(option.name, option.id);
        }
        fieldMap.set(field.name, optionMap);
      }
    }
    this.projects.set(projectNumber, { projectId, fields: fieldMap, fieldIds: fieldIdMap });
    if (this.defaultProjectNumber === undefined) {
      this.defaultProjectNumber = projectNumber;
    }
  }

  isPopulated(projectNumber?: number): boolean {
    if (projectNumber !== undefined) {
      return this.projects.has(projectNumber);
    }
    return this.projects.size > 0;
  }

  getProjectId(projectNumber?: number): string | undefined {
    const entry = this.resolveEntry(projectNumber);
    return entry?.projectId;
  }

  resolveOptionId(fieldName: string, optionName: string, projectNumber?: number): string | undefined {
    const entry = this.resolveEntry(projectNumber);
    return entry?.fields.get(fieldName)?.get(optionName);
  }

  getFieldId(fieldName: string, projectNumber?: number): string | undefined {
    const entry = this.resolveEntry(projectNumber);
    return entry?.fieldIds.get(fieldName);
  }

  getOptionNames(fieldName: string, projectNumber?: number): string[] {
    const entry = this.resolveEntry(projectNumber);
    const optionMap = entry?.fields.get(fieldName);
    return optionMap ? Array.from(optionMap.keys()) : [];
  }

  getFieldNames(projectNumber?: number): string[] {
    const entry = this.resolveEntry(projectNumber);
    return entry ? Array.from(entry.fieldIds.keys()) : [];
  }

  clear(): void {
    this.projects.clear();
    this.defaultProjectNumber = undefined;
  }

  private resolveEntry(projectNumber?: number): ProjectCacheData | undefined {
    if (projectNumber !== undefined) {
      return this.projects.get(projectNumber);
    }
    if (this.defaultProjectNumber !== undefined) {
      return this.projects.get(this.defaultProjectNumber);
    }
    return undefined;
  }
}
```

**Backward compatibility**: All existing callers omit `projectNumber` and get the default (first populated) project. No tool files need changes for Phase 1.

### Step 1.4: Update `ensureFieldCache` in `helpers.ts`

**File**: `src/lib/helpers.ts` (lines 91-113)

Change the guard to be project-aware, and pass `projectNumber` to `populate`:

```typescript
export async function ensureFieldCache(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  owner: string,
  projectNumber: number,
): Promise<void> {
  if (fieldCache.isPopulated(projectNumber)) return;  // <-- project-aware check

  const project = await fetchProjectForCache(client, owner, projectNumber);
  if (!project) {
    throw new Error(`Project #${projectNumber} not found for owner "${owner}"`);
  }

  fieldCache.populate(
    projectNumber,           // <-- NEW first parameter
    project.id,
    project.fields.nodes.map((f) => ({
      id: f.id,
      name: f.name,
      options: f.options,
    })),
  );
}
```

### Step 1.5: Update 3 local `ensureFieldCache` duplicates

The same pattern change in each:
- `src/tools/project-tools.ts` (line 109-155) -- local `ensureFieldCache`
- `src/tools/view-tools.ts` (line 214-276) -- local `ensureFieldCache`
- `src/tools/dashboard-tools.ts` (line 33-54) -- local `ensureFieldCache`

Each needs:
1. `isPopulated()` -> `isPopulated(projectNumber)`
2. `populate(project.id, ...)` -> `populate(projectNumber, project.id, ...)`

### Step 1.6: Update `ensureFieldCacheForNewProject` in `project-tools.ts`

**File**: `src/tools/project-tools.ts` (line 1258-1268)

This function calls `fieldCache.clear()` then `ensureFieldCache()`. No signature change needed -- `clear()` still clears all projects, and the subsequent `ensureFieldCache` call populates the new project. Just ensure the `populate` call inside the local `ensureFieldCache` passes `projectNumber`.

### Step 1.7: Add `FieldOptionCache` unit tests

**File**: `src/__tests__/cache.test.ts` (NEW)

Tests:
- [x] Single-project: `populate` + `isPopulated()` returns true
- [x] Single-project: `getProjectId()` returns correct ID
- [x] Single-project: `resolveOptionId` returns correct option ID
- [x] Single-project: `getFieldId` returns correct field ID
- [x] Single-project: `getOptionNames` returns all option names
- [x] Single-project: `getFieldNames` returns all field names
- [x] Multi-project: `isPopulated(N)` returns true for populated project, false for others
- [x] Multi-project: `populate` second project does NOT overwrite first
- [x] Multi-project: `getProjectId(N)` returns per-project ID
- [x] Multi-project: `resolveOptionId` with `projectNumber` returns per-project data
- [x] Multi-project: default (no projectNumber) returns first populated project
- [x] `clear()` removes all project data

### Phase 1 Automated Checks

```bash
# Build succeeds
cd plugin/ralph-hero/mcp-server && npm run build

# All tests pass (including new cache.test.ts)
npm test

# Verify no `this.fields.clear()` pattern remains in cache.ts
! grep -q "this\.fields\.clear()" src/lib/cache.ts

# Verify populate takes projectNumber as first param
grep -q "populate(projectNumber" src/lib/helpers.ts

# Verify isPopulated takes projectNumber
grep -q "isPopulated(projectNumber)" src/lib/helpers.ts
```

---

## Phase 2: Extend `resolveFullConfig` (GH-150)

**Goal**: Allow per-call `projectNumber` override in `resolveFullConfig` so tools can target different projects.

### Step 2.1: Extend `resolveFullConfig` args type

**File**: `src/lib/helpers.ts` (lines 478-496)

```typescript
export function resolveFullConfig(
  client: GitHubClient,
  args: { owner?: string; repo?: string; projectNumber?: number },  // <-- added
): ResolvedConfig {
  const { owner, repo } = resolveConfig(client, args);
  const projectNumber = args.projectNumber ?? client.config.projectNumber;  // <-- override
  if (!projectNumber) {
    throw new Error(
      "projectNumber is required (set RALPH_GH_PROJECT_NUMBER env var or pass explicitly)",
    );
  }
  const projectOwner = resolveProjectOwner(client.config);
  if (!projectOwner) {
    throw new Error(
      "projectOwner is required (set RALPH_GH_PROJECT_OWNER or RALPH_GH_OWNER env var)",
    );
  }
  return { owner, repo, projectNumber, projectOwner };
}
```

**Impact**: Zero changes to existing call sites. All 14 callers pass `args` objects that don't have `projectNumber`, so `args.projectNumber` is `undefined` and the fallback to `client.config.projectNumber` fires. New/updated tools (GH-151, future) can start passing `projectNumber` through their Zod schema.

### Step 2.2: Add tests for `resolveFullConfig` override

**File**: `src/__tests__/helpers.test.ts` (NEW or extend existing)

Tests:
- [x] `resolveFullConfig` without `projectNumber` in args uses `client.config.projectNumber`
- [x] `resolveFullConfig` with `projectNumber` in args uses the override
- [x] `resolveFullConfig` with undefined `projectNumber` in args falls back to config
- [x] `resolveFullConfig` throws when no projectNumber available anywhere

### Phase 2 Automated Checks

```bash
# Build succeeds
cd plugin/ralph-hero/mcp-server && npm run build

# All tests pass
npm test

# Verify args type includes projectNumber
grep -q "projectNumber?: number" src/lib/helpers.ts

# Verify override logic
grep -q "args.projectNumber" src/lib/helpers.ts
```

---

## Phase 3: Multi-Project Dashboard Fetching (GH-145)

**Goal**: Add `projectNumbers` parameter to `pipeline_dashboard` tool, enabling cross-project item fetching and merging.

**Prerequisite**: Phase 1 complete (multi-project `FieldOptionCache`).

### Step 3.1: Extend `DashboardItem` with project context

**File**: `src/lib/dashboard.ts` (lines 20-30)

Add optional fields:

```typescript
export interface DashboardItem {
  number: number;
  title: string;
  updatedAt: string;
  closedAt: string | null;
  workflowState: string | null;
  priority: string | null;
  estimate: string | null;
  assignees: string[];
  blockedBy: Array<{ number: number; workflowState: string | null }>;
  projectNumber?: number;     // NEW: source project number
  projectTitle?: string;      // NEW: human-readable project title
}
```

Optional fields preserve backward compatibility -- all 44 existing tests and single-project callers continue working without changes.

### Step 3.2: Update `toDashboardItems` signature

**File**: `src/tools/dashboard-tools.ts` (lines 155-178)

Add optional `projectNumber` and `projectTitle` parameters:

```typescript
export function toDashboardItems(
  raw: RawDashboardItem[],
  projectNumber?: number,
  projectTitle?: string,
): DashboardItem[] {
  const items: DashboardItem[] = [];

  for (const r of raw) {
    if (!r.content || r.content.__typename !== "Issue") continue;
    if (r.content.number === undefined) continue;

    items.push({
      number: r.content.number,
      title: r.content.title ?? "(untitled)",
      updatedAt: r.content.updatedAt ?? new Date(0).toISOString(),
      closedAt: r.content.closedAt ?? null,
      workflowState: getFieldValue(r, "Workflow State"),
      priority: getFieldValue(r, "Priority"),
      estimate: getFieldValue(r, "Estimate"),
      assignees: r.content.assignees?.nodes?.map((a) => a.login) ?? [],
      blockedBy: [],
      ...(projectNumber !== undefined ? { projectNumber } : {}),
      ...(projectTitle !== undefined ? { projectTitle } : {}),
    });
  }

  return items;
}
```

### Step 3.3: Add `title` to `DASHBOARD_ITEMS_QUERY`

**File**: `src/tools/dashboard-tools.ts` (lines 184-227)

Add `title` field to the ProjectV2 fragment:

```graphql
node(id: $projectId) {
  ... on ProjectV2 {
    title                              # <-- NEW
    items(first: $first, after: $cursor) {
      ...
    }
  }
}
```

Extract the title from the first page response. `paginateConnection` returns `{ nodes, totalCount }`, but we need access to the raw response to get `title`. Two approaches:

**Approach A (recommended)**: Fetch project title with a separate lightweight query before the paginated fetch. This avoids modifying `paginateConnection`:

```typescript
const titleResult = await client.projectQuery<{ node: { title: string } | null }>(
  `query($projectId: ID!) { node(id: $projectId) { ... on ProjectV2 { title } } }`,
  { projectId },
);
const projectTitle = titleResult.node?.title;
```

**Approach B**: Add `title` to the existing query and extract from raw response. This requires `paginateConnection` to expose extra fields, which complicates its generic interface.

Use **Approach A** for simplicity.

### Step 3.4: Add `projectNumbers` Zod parameter

**File**: `src/tools/dashboard-tools.ts` (Zod schema, lines 241-305)

Add after `owner`:

```typescript
projectNumbers: z
  .array(z.coerce.number())
  .optional()
  .describe(
    "Project numbers to include. Defaults to RALPH_GH_PROJECT_NUMBERS or single configured project."
  ),
```

### Step 3.5: Implement multi-project fetch loop

**File**: `src/tools/dashboard-tools.ts` (handler, lines 306-396)

Replace the single-project fetch (lines 308-336) with a multi-project loop:

```typescript
// Resolve project numbers
const projectNumbers = args.projectNumbers
  ?? resolveProjectNumbers(client.config);

if (projectNumbers.length === 0 && client.config.projectNumber) {
  projectNumbers.push(client.config.projectNumber);
}

if (projectNumbers.length === 0) {
  return toolError("No project numbers configured. Set RALPH_GH_PROJECT_NUMBER or RALPH_GH_PROJECT_NUMBERS.");
}

const allItems: DashboardItem[] = [];
const warnings: string[] = [];

for (const pn of projectNumbers) {
  const pOwner = args.owner || resolveProjectOwner(client.config);
  if (!pOwner) {
    warnings.push(`Project #${pn}: no owner resolved, skipping`);
    continue;
  }

  try {
    await ensureFieldCache(client, fieldCache, pOwner, pn);
  } catch (e) {
    warnings.push(`Project #${pn}: ${e instanceof Error ? e.message : String(e)}, skipping`);
    continue;
  }

  const projectId = fieldCache.getProjectId(pn);
  if (!projectId) {
    warnings.push(`Project #${pn}: could not resolve project ID, skipping`);
    continue;
  }

  // Fetch project title
  let projectTitle: string | undefined;
  try {
    const titleResult = await client.projectQuery<{ node: { title: string } | null }>(
      `query($projectId: ID!) { node(id: $projectId) { ... on ProjectV2 { title } } }`,
      { projectId },
    );
    projectTitle = titleResult.node?.title;
  } catch {
    // Non-fatal -- proceed without title
  }

  // Fetch items
  const result = await paginateConnection<RawDashboardItem>(
    (q, v) => client.projectQuery(q, v),
    DASHBOARD_ITEMS_QUERY,
    { projectId, first: 100 },
    "node.items",
    { maxItems: 500 },
  );

  const items = toDashboardItems(result.nodes, pn, projectTitle);
  allItems.push(...items);
}

// Build dashboard from merged items
const dashboard = buildDashboard(allItems, healthConfig);
```

**Single-project backward compatibility**: When only one project number is configured, the loop executes once with the same behavior as before.

### Step 3.6: Import `resolveProjectNumbers`

**File**: `src/tools/dashboard-tools.ts` (imports)

Add import:

```typescript
import { toolSuccess, toolError, resolveProjectOwner, resolveProjectNumbers } from "../types.js";
```

### Step 3.7: Add multi-project dashboard tests

**File**: `src/__tests__/dashboard.test.ts`

Extend existing test suite with:

- [x] `toDashboardItems` with `projectNumber` -- items have `projectNumber` set
- [x] `toDashboardItems` without `projectNumber` -- items have no `projectNumber` (backward compat)
- [x] `buildDashboard` with items from multiple projects -- aggregation works correctly
- [x] Items from different projects with same issue number are distinct dashboard items
- [x] `DashboardItem` with `projectTitle` populated

**Structural tests** (source-string pattern):
- [x] Verify `projectNumbers` param in Zod schema
- [x] Verify `projectNumber` field in `DashboardItem` interface
- [x] Verify `resolveProjectNumbers` import in dashboard-tools.ts

### Phase 3 Automated Checks

```bash
# Build succeeds
cd plugin/ralph-hero/mcp-server && npm run build

# All tests pass (including new multi-project tests)
npm test

# Verify projectNumbers param exists
grep -q "projectNumbers" src/tools/dashboard-tools.ts

# Verify DashboardItem has projectNumber
grep -q "projectNumber?" src/lib/dashboard.ts

# Verify resolveProjectNumbers import
grep -q "resolveProjectNumbers" src/tools/dashboard-tools.ts
```

---

## Implementation Notes

### What NOT to change

- **No tool Zod schema changes for existing tools** -- only `pipeline_dashboard` gets `projectNumbers`. Individual tool `projectNumber` overrides belong to GH-151.
- **No formatting changes** -- multi-project visual differentiation belongs to GH-146.
- **`clear()` behavior** -- continues to clear all projects. `ensureFieldCacheForNewProject` (project-tools.ts) still works: clear all, then populate the new project.
- **#146 (Backlog)** -- not included in this plan. It depends on GH-145 and needs its own planning when ready.

### Risk Mitigations

1. **Local `ensureFieldCache` duplicates**: Phase 1.5 explicitly updates all 3. Consolidation to the canonical version in helpers.ts is deferred -- it would touch import trees across 3 files and risks merge conflicts with other in-flight PRs.
2. **Default project ambiguity**: The `defaultProjectNumber` tracking in `FieldOptionCache` ensures the first populated project is always the default. Single-project users see no behavior change.
3. **Rate limiting for multi-project**: Sequential fetch (not parallel) in Phase 3 respects rate limits. The `RateLimiter` in `github-client.ts` pauses automatically when quota is low.
4. **Test isolation**: New cache tests use direct `FieldOptionCache` instantiation (no API mocking needed). Dashboard multi-project tests use the existing `makeItem()` factory with added `projectNumber`.
