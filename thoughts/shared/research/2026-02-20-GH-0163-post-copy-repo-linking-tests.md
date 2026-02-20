---
date: 2026-02-20
github_issue: 163
github_url: https://github.com/cdubiel08/ralph-hero/issues/163
status: complete
type: research
---

# GH-163: Add Post-Copy Repository Linking and Tests for Template Mode in `setup_project`

## Problem Statement

After `copyProjectV2` creates a new project from a template (#162), repository links are not copied — this is a GitHub API limitation. The new project needs the configured repository linked automatically so issues from that repo can be added. Additionally, the `setup_project` tool currently has zero tests. GH-163 adds post-copy `linkProjectV2ToRepository` and comprehensive tests for both creation paths (template copy and blank).

## Current State Analysis

### `copyProjectV2` Does NOT Copy Repository Links

Confirmed by GitHub documentation and the GH-162 research: `copyProjectV2` copies views, custom fields, and built-in workflows but does NOT copy items, collaborators, team links, or repository links. After a template copy, `linkProjectV2ToRepository` must be called separately.

### `link_repository` Tool — The Existing Pattern

The `link_repository` tool ([`project-management-tools.ts:251-335`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L251)) implements the full link flow:

1. `resolveFullConfig(client, args)` → get `projectNumber`, `projectOwner`
2. `ensureFieldCache(...)` → populate project ID
3. `fieldCache.getProjectId()` → project node ID
4. Parse `repoToLink` (`owner/name` or bare `name`)
5. Query `repository(owner:, name:)` → repository node ID (1hr cache TTL)
6. Call `linkProjectV2ToRepository(input: { projectId, repositoryId })` via `client.projectMutate`
7. Return `{ repository: "owner/name", linked: true }`

The GraphQL mutation ([`project-management-tools.ts:314-324`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L314)):

```graphql
mutation($projectId: ID!, $repositoryId: ID!) {
  linkProjectV2ToRepository(input: {
    projectId: $projectId,
    repositoryId: $repositoryId
  }) {
    repository { id }
  }
}
```

### `setup_project` — Current Implementation

[`project-tools.ts:173-304`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L173):

**Zod schema** (lines 173-175): `{ owner: z.string(), title: z.string().default("Ralph Workflow") }`

**Handler flow**:
1. Owner ID resolution (lines 185-224): try `user(login:)` then `organization(login:)` → `ownerId`
2. Create project (lines 226-248): `createProjectV2(input: { ownerId, title })` → `{ id, number, url, title }`
3. Create 3 fields (lines 252-281): Workflow State (11 options), Priority (4 options), Estimate (5 options) via `createSingleSelectField`
4. Cache hydration (lines 283-289): `ensureFieldCacheForNewProject(client, fieldCache, owner, project.number)`
5. Return (lines 291-299): `{ project: { id, number, url, title }, fields: fieldResults }`

**No `templateProjectNumber` parameter** exists yet — GH-162 adds it. No repository linking step exists — GH-163 adds it.

### GH-162 Implementation — Branch Status

GH-162 is implemented on `feature/GH-162` branch (not yet merged to main). It adds:
- `templateProjectNumber: z.number().optional()` Zod param
- `RALPH_GH_TEMPLATE_PROJECT` env var parsing
- Copy path branch after owner ID resolution: `copyProjectV2` → fetch fields → cache hydrate
- Both paths produce same return shape: `{ project, fields }`

The copy path skips `createSingleSelectField` calls (template has all fields). After copy, `fieldResults` is populated by querying the new project's fields via `fetchProjectForCache`.

### No Existing Tests

Zero tests exist for `setup_project` anywhere in the test suite. The test file `setup-project-template.test.ts` does not exist. The issue AC specifies creating this file.

### Test Patterns in the Codebase

The MCP server uses several test patterns:

1. **Pure unit tests** — no mocks, import functions directly (`workflow-states.test.ts`, `date-math.test.ts`)
2. **Structural source-string tests** — read `.ts` source as string via `fs.readFileSync`, assert with `toContain()` (`project-tools.test.ts:10-13`)
3. **Module-level mock** — `vi.mock("@octokit/graphql", ...)` for client tests (`github-client.test.ts`)
4. **Inline mutation string tests** — declare mutation literal, assert fields (`project-management-tools.test.ts:113-139`)
5. **Pure function with factory helpers** — `makeItem()` factories for data (`hygiene.test.ts:25-38`)

No `vi.mock("fs")` or test fixture file patterns exist. No `__fixtures__/` directory.

## Key Discoveries

### 1. Repository Linking Insertion Point

In the GH-162 implementation sketch, the flow after both paths is:

```typescript
// Both paths produce: project { id, number, url, title } + fieldResults
await ensureFieldCacheForNewProject(client, fieldCache, owner, project.number);
return toolSuccess({ project, fields: fieldResults });
```

The repository link step should be inserted **after cache hydration and before return**, since linking requires the project node ID (available from `project.id` directly — no cache needed):

```typescript
// After cache hydration, before return:
if (client.config.repo) {
  await linkRepoToProject(client, project.id, client.config.owner, client.config.repo);
}
```

This runs for **both** copy and blank paths — a blank project also needs its repo linked. The GH-162 research recommends this for the copy path specifically, but linking is useful for both paths.

### 2. Repository Node ID Resolution — Reuse Pattern

The `link_repository` tool resolves repo node ID via:

```graphql
query($repoOwner: String!, $repoName: String!) {
  repository(owner: $repoOwner, name: $repoName) { id }
}
```

This query can be extracted or inlined in `setup_project`. Since `setup_project` already knows `owner` and `repo` from `client.config`, the values are directly available without parsing `owner/name` format.

### 3. Already-Linked Error Handling

GitHub's `linkProjectV2ToRepository` behavior when the repo is already linked is undocumented. The safe approach:

- **Option A**: Call the mutation anyway and catch errors — if it errors on duplicate, handle gracefully
- **Option B**: Pre-check via `ProjectV2.repositories` connection — query linked repos first, skip if already linked

For `setup_project`, Option A is sufficient since we just created the project (no pre-existing links). For the copy path, the template's repo links are NOT copied, so the new project also has no pre-existing links. The only edge case is if `setup_project` is called twice with the same project — but that creates a new project each time, so no duplicate risk.

### 4. Test Strategy — Structural + Pure Function

Given the codebase patterns, the recommended test approach:

**Structural tests** (source-string pattern):
- Verify `linkProjectV2ToRepository` mutation string exists in `project-tools.ts`
- Verify `templateProjectNumber` param exists in Zod schema
- Verify `copyProjectV2` mutation string exists
- Verify `RALPH_GH_TEMPLATE_PROJECT` env var parsing exists

**Pure function tests** (if helper extracted):
- If `linkRepoToProject` is extracted as a separate helper, test the GraphQL query construction
- Test the repo node ID resolution flow

This avoids the complexity of mocking the full GitHub API while providing confidence that the code structure is correct.

### 5. Scope Clarification — Both Paths Need Linking

The issue AC says "Repository automatically linked after template copy." However, linking is also valuable for the blank creation path — without it, a newly created blank project has no linked repositories and can't auto-add issues from any repo.

**Recommendation**: Link the configured repo for both paths, not just the copy path. This is a minor scope expansion but makes `setup_project` more useful for both modes.

### 6. Group Context

Parent #111 was split into:
- **#162** (S): Core `copyProjectV2` implementation — on `feature/GH-162` branch, PR pending
- **#163** (XS): Post-copy repo linking + tests — this issue
- **#164** (Closed): Duplicate of #162
- **#165** (Closed): Duplicate of #162

#163 is blocked by #162 (needs the template parameter and copy branch to exist before adding linking and tests). Once #162 merges, #163 can proceed.

### 7. `ensureFieldCacheForNewProject` Already Queries Fields

The cache hydration step (`ensureFieldCacheForNewProject` at [`project-tools.ts:787-797`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L787)) calls `fieldCache.clear()` → `client.getCache().clear()` → `ensureFieldCache(...)`. This queries the project's fields fresh. For the copy path, this provides the `fieldResults` data needed for the return value — the copy mutation's return doesn't include field details.

## Recommended Approach

### Changes

1. **Modify: `tools/project-tools.ts`** — Add `linkProjectV2ToRepository` call after project creation (both paths), before return
2. **New file: `__tests__/setup-project-template.test.ts`** — Structural and unit tests

### Implementation

**Repository linking helper** (add to `project-tools.ts` as internal helper):

```typescript
async function linkRepoAfterSetup(
  client: GitHubClient,
  projectId: string,
  repoOwner: string,
  repoName: string,
): Promise<{ linked: boolean; repository: string }> {
  // Resolve repo node ID
  const repoResult = await client.query<{
    repository: { id: string } | null;
  }>(
    `query($repoOwner: String!, $repoName: String!) {
      repository(owner: $repoOwner, name: $repoName) { id }
    }`,
    { repoOwner, repoName },
    { cache: true, cacheTtlMs: 60 * 60 * 1000 },
  );

  const repoId = repoResult.repository?.id;
  if (!repoId) {
    return { linked: false, repository: `${repoOwner}/${repoName}` };
  }

  // Link repo to project
  await client.projectMutate(
    `mutation($projectId: ID!, $repositoryId: ID!) {
      linkProjectV2ToRepository(input: {
        projectId: $projectId,
        repositoryId: $repositoryId
      }) {
        repository { id }
      }
    }`,
    { projectId, repositoryId: repoId },
  );

  return { linked: true, repository: `${repoOwner}/${repoName}` };
}
```

**Insertion in handler** (after cache hydration, before return):

```typescript
// Link configured repo to new project (best-effort)
let repoLink: { linked: boolean; repository: string } | undefined;
const configOwner = client.config.owner;
const configRepo = client.config.repo;
if (configOwner && configRepo) {
  try {
    repoLink = await linkRepoAfterSetup(client, project.id, configOwner, configRepo);
  } catch {
    // Best-effort — don't fail setup if linking fails
  }
}

return toolSuccess({
  project: { id: project.id, number: project.number, url: project.url, title: project.title },
  fields: fieldResults,
  ...(repoLink && { repositoryLink: repoLink }),
});
```

### Test Plan

**File: `__tests__/setup-project-template.test.ts`**

```typescript
// Structural tests (source-string pattern):
describe("setup_project source structure", () => {
  it("contains linkProjectV2ToRepository mutation");
  it("contains templateProjectNumber in Zod schema");
  it("contains copyProjectV2 mutation");
  it("contains RALPH_GH_TEMPLATE_PROJECT env var");
  it("contains ensureFieldCacheForNewProject call");
});

// link_repository mutation tests (inline pattern):
describe("linkProjectV2ToRepository mutation", () => {
  it("accepts projectId and repositoryId inputs");
  it("returns repository { id }");
});
```

## Risks

1. **GH-162 not merged**: GH-163 cannot be implemented until GH-162 merges. The `templateProjectNumber` param, copy path branch, and `copyProjectV2` mutation are all prerequisites.

2. **Already-linked mutation behavior**: GitHub doesn't document whether `linkProjectV2ToRepository` errors or no-ops on a duplicate link. The best-effort try/catch pattern handles this safely for `setup_project` since we just created the project.

3. **Scope creep — linking for blank path**: The AC specifies "after template copy" but linking is equally useful for blank creation. Implementing for both paths is a minor expansion that makes the tool more complete. If this is rejected, the `if` guard can be scoped to `if (templateProjectNumber && configOwner && configRepo)`.

4. **Test coverage**: Structural tests verify code exists but don't execute it. Full integration tests would require mocking the GitHub API extensively. The structural pattern matches the codebase convention and provides reasonable coverage for an XS ticket.

## Recommended Next Steps

1. Wait for GH-162 to merge to main
2. Add `linkRepoAfterSetup` helper to `project-tools.ts`
3. Insert repo linking call after `ensureFieldCacheForNewProject` (both paths)
4. Add `repositoryLink` to return value (optional field, present when repo configured)
5. Create `__tests__/setup-project-template.test.ts` with structural tests
6. Handle linking failure gracefully (best-effort, don't fail setup)
