---
date: 2026-02-20
github_issue: 162
github_url: https://github.com/cdubiel08/ralph-hero/issues/162
status: complete
type: research
---

# GH-162: Implement `copyProjectV2` Mutation and Template Parameter in `setup_project`

## Problem Statement

The `setup_project` tool creates projects from scratch by calling `createProjectV2` followed by three `createProjectV2Field` calls. When a golden template project exists (#160), cloning it with `copyProjectV2` is faster and preserves views, automations, and field configurations. GH-162 adds a `templateProjectNumber` parameter and copy-from-template branch to `setup_project`.

## Current State Analysis

### `setup_project` Implementation

[`project-tools.ts:168-304`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L168) — Linear 5-step flow:

1. **Owner ID resolution** (lines 185-223): Try `user(login:)` then `organization(login:)` GraphQL queries. Returns `ownerId` (node ID).
2. **Create project** (lines 225-249): `createProjectV2(input: { ownerId, title })` via `client.projectMutate`. Returns `{ id, number, url, title }`.
3. **Create fields** (lines 251-280): Three calls to internal `createSingleSelectField` helper (lines 684-732), each using `createProjectV2Field` mutation with inline `singleSelectOptions`.
4. **Cache hydration** (lines 282-288): `ensureFieldCacheForNewProject` (lines 734-744) calls `fieldCache.clear()`, `client.getCache().clear()`, then `ensureFieldCache`.
5. **Return** (lines 290-298): `{ project: { id, number, url, title }, fields: fieldResults }`.

**Zod schema** (lines 168-174):
```typescript
{
  owner: z.string().describe("GitHub owner (user or org)"),
  title: z.string().describe("Project title").default("Ralph Workflow"),
}
```

No `templateProjectNumber` parameter exists. All mutations use `client.projectMutate` (project token, invalidates `query:` cache prefix).

### `copyProjectV2` GraphQL Mutation

**Input type**: `CopyProjectV2Input`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `projectId` | `ID!` | Yes | Node ID of source project |
| `ownerId` | `ID!` | Yes | Node ID of target owner |
| `title` | `String!` | Yes | Title for new project |
| `includeDraftIssues` | `Boolean` | No | Copy draft issues (default: false) |

**Payload**: `CopyProjectV2Payload` → `projectV2: ProjectV2` (same shape: `id`, `number`, `url`, `title`).

**What gets copied**: Custom fields (all options), views (board/table/roadmap), built-in automations (except auto-add), insights.

**What does NOT get copied**: Items (issues, PRs), collaborators, repository links, auto-add workflows.

**Key behaviors**:
- `includeDraftIssues: false` → pure structural clone (fields + views + automations, no items)
- Accepts `title` directly — no post-copy rename needed
- Source project does NOT need to be marked as a template
- New project gets entirely new node IDs for all objects (project, fields, field options)
- Mutations cost 5 secondary rate limit points (standard for all mutations)

### Template Project Resolution

To call `copyProjectV2`, we need the source project's node ID. The existing `fetchProjectForCache` at [`helpers.ts:41-85`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L41) resolves `(owner, projectNumber) → { id, fields }` by trying both `user` and `organization` owner types, but it returns field data for cache population — more than needed for just the project node ID.

A simpler approach: reuse the same try-user-then-org pattern from `setup_project`'s owner resolution (lines 185-223), but query `projectV2(number:)` instead of the user/org node:

```graphql
query($login: String!, $number: Int!) {
  user(login: $login) {
    projectV2(number: $number) { id }
  }
}
```

However, `fetchProjectForCache` is already cached with 10-minute TTL and returns exactly what's needed (`project.id`). Reusing it avoids duplicating the try-user-then-org pattern and benefits from caching.

### Env Var Parsing Pattern

[`index.ts:68-70`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts#L68):
```typescript
const projectNumber = resolveEnv("RALPH_GH_PROJECT_NUMBER")
  ? parseInt(resolveEnv("RALPH_GH_PROJECT_NUMBER")!, 10)
  : undefined;
```

`RALPH_GH_TEMPLATE_PROJECT` would follow the identical pattern: `parseInt` with `undefined` fallback.

## Key Discoveries

### 1. Natural Insertion Point for Copy Branch

The copy path branches **after** owner ID resolution (line 223) and **replaces** the project creation block (lines 226-249). The `project` variable must produce the same shape `{ id, number, url, title }` for downstream code.

When copying, the three `createSingleSelectField` calls (lines 252-280) must be **skipped** — the template already has all fields. The `fieldResults` block needs a conditional guard or the copy path must produce equivalent field data from the copied project's fields.

```typescript
// Proposed structure (pseudo-code)
let project: { id; number; url; title };
let fieldResults: Record<string, { id: string; options: string[] }>;

if (templateProjectNumber) {
  // Copy path: resolve template ID, call copyProjectV2
  const templateId = await resolveTemplateProjectId(client, owner, templateProjectNumber);
  project = await copyProject(client, ownerId, templateId, args.title);
  fieldResults = await fetchFieldsFromProject(client, owner, project.number);
} else {
  // Blank path: existing createProjectV2 + createProjectV2Field flow
  project = await createBlankProject(client, ownerId, args.title);
  fieldResults = await createFields(client, project.id);
}

// Shared: cache hydration + return (lines 282-298)
await ensureFieldCacheForNewProject(client, fieldCache, owner, project.number);
```

### 2. Field Cache Requires Re-Population After Copy

Copied projects get new field option IDs. The existing `ensureFieldCacheForNewProject` pattern (lines 734-744) handles this correctly — it calls `fieldCache.clear()`, `client.getCache().clear()`, and `ensureFieldCache`, which queries the new project's fields and populates the cache with fresh IDs.

No changes needed to cache hydration logic.

### 3. `fieldResults` for Copy Path

The blank path returns `fieldResults` from `createSingleSelectField` (field ID + option names). The copy path needs equivalent data. After copying, query the new project's fields:

```typescript
const fetchResult = await fetchProjectForCache(client, owner, project.number);
// fetchResult.fields.nodes contains all field definitions with options
```

This can be extracted from the cache population step — `ensureFieldCacheForNewProject` already queries the project's fields internally.

### 4. Critical: Duplicate Sibling Issues

Parent #111 was split **twice**, creating overlapping sub-issues:

**First split** (2026-02-20T02:19:55Z): #162 (S) + #163 (XS)
**Second split** (2026-02-20T02:24:19Z): #164 (S) + #165 (XS)

| Scope Item | #162 | #163 | #164 | #165 |
|------------|------|------|------|------|
| `copyProjectV2` mutation | **Yes** | No | **Yes** | No |
| `templateProjectNumber` Zod param | **Yes** | No | **Yes** | No |
| `RALPH_GH_TEMPLATE_PROJECT` env var | **Yes** | No | No | **Yes** |
| Config type change | **Yes** | No | No | **Yes** |
| Routing logic (copy vs blank) | **Yes** | No | No | **Yes** |
| Repository linking after copy | No | **Yes** | **Yes** | No |
| Tests | No | **Yes** | **Yes** | No |

**Overlap analysis**:
- **#162 ≈ #164**: ~90% overlap — both implement `copyProjectV2` mutation + `templateProjectNumber` param
- **#162 ∩ #165**: ~60% overlap — both cover env var parsing and routing
- **#163 ∩ #164**: ~30% overlap — both mention repo linking

**Recommendation**: Close #164 and #165 as duplicates of #162 and #163. The first split (#162 → #163) is the canonical decomposition:
- **#162** (S): Core implementation — mutation, param, env var, routing
- **#163** (XS): Post-copy repo linking + tests

### 5. Dependency Chain

Within the #111 group (after dedup):
1. **#162** — Core copy path (this issue, no blockers)
2. **#163** — Repo linking + tests (blocked by #162)

Cross-group relationships:
- **#101** — Standalone `copy_project` tool (independent, uses same mutation)
- **#160** → **#161** — Golden project creation (provides the template to copy from)
- **#162** is NOT blocked by #101 — both use `copyProjectV2` independently
- **#162** is NOT blocked by #160 — template number is configurable, doesn't require the golden project to exist

### 6. `setup_project` Return Shape Compatibility

The copy path must return the same shape as the blank path:
```typescript
{
  project: { id: string; number: number; url: string; title: string },
  fields: Record<string, { id: string; options: string[] }>
}
```

The `copyProjectV2` payload returns `projectV2 { id number url title }` — identical shape. The `fields` data requires a follow-up query (fetching the copied project's field definitions) since `copyProjectV2` doesn't return field details in its payload.

### 7. Cross-Org Copy Limitation

GitHub App tokens scoped to one org cannot access projects in another org, even if public. PATs with `project` scope work for cross-org copies. The existing `client.projectMutate` uses whatever token is configured — if it's a PAT with appropriate scopes, cross-org copies work. No code change needed, but should be documented.

## Potential Approaches

### Approach A: Inline Branch in `setup_project` Handler (Recommended)

Add `templateProjectNumber` to the Zod schema and `RALPH_GH_TEMPLATE_PROJECT` to env var parsing. Branch the handler at line 225 between copy path and blank path. Both paths produce the same `{ project, fields }` shape.

**Pros:** Single file change for the core logic, leverages existing cache hydration, backward compatible.
**Cons:** Makes `setup_project` handler longer (~50 more lines). Can be mitigated by extracting the copy path into a helper function.

### Approach B: Separate `copy_project` Tool + Delegation

Implement #101 first as a standalone `copy_project` tool, then have `setup_project` delegate to it when `templateProjectNumber` is provided.

**Pros:** Reusable `copy_project` tool, cleaner separation.
**Cons:** Adds a dependency on #101, requires cross-issue coordination, and `setup_project` would need to call another tool internally (unusual pattern in this codebase — tools don't call other tools).

### Recommendation: Approach A

Direct integration in `setup_project` is simpler, self-contained, and matches the issue's stated scope. The `copyProjectV2` mutation call is small enough (~10 lines) that a separate tool isn't justified for this use case. If #101 is later implemented, it can reuse the same mutation pattern independently.

## Risks

1. **Duplicate sub-issues**: #164 and #165 overlap significantly with #162 and #163. If not resolved before implementation, two developers could work on the same code simultaneously. **Action**: Close #164 and #165 as duplicates.
2. **Field data in return**: The copy path doesn't automatically get `fieldResults` (field IDs + option names) since `copyProjectV2` doesn't return field details. Need a follow-up query via `fetchProjectForCache` — this adds one extra API call but is cached.
3. **Template project doesn't exist**: If the configured `templateProjectNumber` doesn't resolve, the handler should fall back to blank creation with a warning, not error out. This keeps the tool robust.
4. **Auto-add workflows not copied**: The golden project's auto-add workflows won't transfer. This is a GitHub API limitation. Document it in the tool's response.

## Recommended Next Steps

1. **Close #164 and #165 as duplicates** of #162 and #163 (first split is canonical)
2. **Set dependency**: #163 blocked by #162
3. Add `templateProjectNumber: z.number().optional()` to `setup_project` Zod schema
4. Parse `RALPH_GH_TEMPLATE_PROJECT` env var in `index.ts` (same `parseInt` pattern)
5. Add `templateProjectNumber?: number` to `GitHubClientConfig` in `types.ts`
6. Implement copy branch in handler: resolve template ID → `copyProjectV2` → fetch fields → cache hydrate
7. Extract copy path into `copyFromTemplate` helper function for readability
8. Return same `{ project, fields }` shape from both paths
9. Handle missing template gracefully (fall back to blank creation with warning)
