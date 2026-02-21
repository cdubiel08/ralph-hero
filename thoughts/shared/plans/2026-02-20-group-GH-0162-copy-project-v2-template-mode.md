---
date: 2026-02-20
status: draft
github_issues: [162, 163]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/162
  - https://github.com/cdubiel08/ralph-hero/issues/163
primary_issue: 162
---

# copyProjectV2 Template Mode for setup_project - Atomic Implementation Plan

## Overview

2 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-162 | Implement `copyProjectV2` mutation and template parameter in `setup_project` | S |
| 2 | GH-163 | Add post-copy repository linking and tests for template mode in `setup_project` | XS |

**Why grouped**: GH-163 (repo linking + tests) directly depends on GH-162 (copy mutation + template parameter). Both modify `setup_project` in `project-tools.ts` and share the same handler flow. Testing both paths together ensures end-to-end coverage.

## Current State Analysis

**`setup_project`** ([`project-tools.ts:173-308`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L173-L308)):
- Creates blank projects via `createProjectV2` + 3x `createProjectV2Field` calls
- Zod schema: `{ owner, title }` only
- Returns `{ project: { id, number, url, title }, fields: Record<string, { id, options }> }`
- Hydrates field cache via `ensureFieldCacheForNewProject` (clear + re-fetch)
- No template parameter, no env var, no repo linking

**`copy_project`** ([`project-tools.ts:514-661`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L514-L661)):
- Standalone tool using `copyProjectV2` mutation
- Demonstrates the working copy pattern: resolve source project ID, resolve target owner ID, call `copyProjectV2`
- Does NOT link repositories after copy

**`link_repository`** ([`project-management-tools.ts:247-334`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L247-L334)):
- Resolves repo node ID via `repository(owner:, name:)` query (1hr cache)
- Calls `linkProjectV2ToRepository(input: { projectId, repositoryId })`
- Pattern to reuse for post-setup repo linking

**Env var parsing** ([`index.ts:72-74`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts#L72-L74)):
- `RALPH_GH_PROJECT_NUMBER` uses `parseInt` with `undefined` fallback
- `RALPH_GH_TEMPLATE_PROJECT` will follow identical pattern

**Config type** ([`types.ts:263-271`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L263-L271)):
- `GitHubClientConfig` has `projectNumber`, `projectNumbers`, `projectOwner`
- No `templateProjectNumber` field

## Desired End State

### Verification
- [ ] `setup_project` accepts optional `templateProjectNumber` parameter
- [ ] `RALPH_GH_TEMPLATE_PROJECT` env var is parsed and passed to config
- [ ] When template provided: copies project via `copyProjectV2`, skips field creation, fetches fields from copy
- [ ] When no template: existing blank creation + field creation behavior unchanged
- [ ] Both paths return same `{ project, fields }` response shape
- [ ] Repository auto-linked after project creation (both paths, best-effort)
- [ ] Field cache correctly populated after copy
- [ ] Structural tests verify all new code paths
- [ ] All existing tests pass

## What We're NOT Doing

- Modifying `copy_project` tool (separate standalone tool, independent)
- Adding integration tests that call the GitHub API
- Supporting cross-owner template copies (same owner assumed for template resolution)
- Adding iteration field support or custom field management
- Fallback from copy to blank on template not found (error cleanly instead)

## Implementation Approach

Phase 1 adds the template parameter, env var, config type change, and copy branch inside `setup_project`. The handler branches after owner ID resolution: if `templateProjectNumber` is provided, resolve the template project node ID, call `copyProjectV2`, then fetch the new project's fields to build `fieldResults`. If no template, existing blank creation flow runs unchanged. Both paths converge at cache hydration and return.

Phase 2 adds a `linkRepoAfterSetup` helper that runs after cache hydration (for both paths) and structural tests covering all new code paths.

---

## Phase 1: GH-162 - Implement `copyProjectV2` mutation and template parameter

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/162 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0162-copy-project-v2-setup-project.md

### Changes Required

#### 1. Add `templateProjectNumber` to `GitHubClientConfig`
**File**: `mcp-server/src/types.ts`
**Changes**: Add `templateProjectNumber?: number` to `GitHubClientConfig` interface, after `projectNumbers`.

#### 2. Parse `RALPH_GH_TEMPLATE_PROJECT` env var
**File**: `mcp-server/src/index.ts`
**Changes**:
- After `projectNumbers` parsing (line ~80), add:
  ```typescript
  const templateProjectNumber = resolveEnv("RALPH_GH_TEMPLATE_PROJECT")
    ? parseInt(resolveEnv("RALPH_GH_TEMPLATE_PROJECT")!, 10)
    : undefined;
  ```
- Pass `templateProjectNumber` in `createGitHubClient()` call (line ~108-116)

#### 3. Add template parameter and copy branch to `setup_project`
**File**: `mcp-server/src/tools/project-tools.ts`
**Changes**:

**Zod schema** (line ~177): Add `templateProjectNumber` parameter:
```typescript
templateProjectNumber: z
  .number()
  .optional()
  .describe(
    "Template project number to copy from. Overrides RALPH_GH_TEMPLATE_PROJECT env var. " +
    "When set, copies the template project (views, fields, automations) instead of creating blank.",
  ),
```

**Handler** (after owner ID resolution, line ~228): Add template resolution and copy branch:

```typescript
// Resolve template project number: arg > config > undefined (blank)
const templatePN = args.templateProjectNumber ?? client.config.templateProjectNumber;

let project: { id: string; number: number; url: string; title: string };
let fieldResults: Record<string, { id: string; options: string[] }>;

if (templatePN) {
  // --- Copy path: clone template project ---
  // 1. Resolve template project node ID
  const templateProject = await fetchProject(client, owner, templatePN);
  if (!templateProject) {
    return toolError(
      `Template project #${templatePN} not found for owner "${owner}"`,
    );
  }

  // 2. Copy via copyProjectV2
  const copyResult = await client.projectMutate<{
    copyProjectV2: {
      projectV2: { id: string; number: number; url: string; title: string };
    };
  }>(
    `mutation($projectId: ID!, $ownerId: ID!, $title: String!) {
      copyProjectV2(input: {
        projectId: $projectId
        ownerId: $ownerId
        title: $title
        includeDraftIssues: false
      }) {
        projectV2 { id number url title }
      }
    }`,
    { projectId: templateProject.id, ownerId, title: args.title },
  );
  project = copyResult.copyProjectV2.projectV2;

  // 3. Fetch fields from the copied project to build fieldResults
  const copiedProject = await fetchProject(client, owner, project.number);
  if (!copiedProject) {
    return toolError(
      `Copied project #${project.number} not found after creation`,
    );
  }
  fieldResults = {};
  for (const f of copiedProject.fields.nodes) {
    if (f.options) {
      fieldResults[f.name] = {
        id: f.id,
        options: f.options.map((o) => o.name),
      };
    }
  }
} else {
  // --- Blank path: existing createProjectV2 + field creation ---
  // [existing code from lines 230-285 stays here, wrapped in else block]
  const createResult = await client.projectMutate<{ ... }>(...);
  project = createResult.createProjectV2.projectV2;
  fieldResults = {};
  // [existing createSingleSelectField calls]
}

// Shared: cache hydration + return (existing lines 287-303)
await ensureFieldCacheForNewProject(client, fieldCache, owner, project.number);
return toolSuccess({
  project: { id: project.id, number: project.number, url: project.url, title: project.title },
  fields: fieldResults,
  ...(templatePN && { copiedFrom: { templateProjectNumber: templatePN } }),
});
```

### Success Criteria
- [x] Automated: `npm run build` passes
- [x] Automated: `npm test` passes (all existing tests)
- [ ] Manual: `setup_project` without template creates blank project (unchanged behavior)
- [ ] Manual: `setup_project` with `templateProjectNumber` copies the template

**Creates for next phase**: Template copy path exists, `fieldResults` populated from copy, `project.id` available for repo linking.

---

## Phase 2: GH-163 - Add post-copy repository linking and tests

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/163 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0163-post-copy-repo-linking-tests.md | **Depends on**: Phase 1

### Changes Required

#### 1. Add `linkRepoAfterSetup` helper
**File**: `mcp-server/src/tools/project-tools.ts`
**Changes**: Add internal helper function (near other helpers at bottom of file):

```typescript
async function linkRepoAfterSetup(
  client: GitHubClient,
  projectId: string,
  repoOwner: string,
  repoName: string,
): Promise<{ linked: boolean; repository: string }> {
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

#### 2. Insert repo linking call in `setup_project` handler
**File**: `mcp-server/src/tools/project-tools.ts`
**Changes**: After `ensureFieldCacheForNewProject` and before `return toolSuccess(...)`, add:

```typescript
// Link configured repo to new project (best-effort, both paths)
let repoLink: { linked: boolean; repository: string } | undefined;
const configOwner = client.config.owner;
const configRepo = client.config.repo;
if (configOwner && configRepo) {
  try {
    repoLink = await linkRepoAfterSetup(client, project.id, configOwner, configRepo);
  } catch {
    // Best-effort - don't fail setup if linking fails
  }
}
```

Update the return value to include `repositoryLink` when present:
```typescript
return toolSuccess({
  project: { ... },
  fields: fieldResults,
  ...(templatePN && { copiedFrom: { templateProjectNumber: templatePN } }),
  ...(repoLink && { repositoryLink: repoLink }),
});
```

#### 3. Create structural tests
**File**: `mcp-server/src/__tests__/setup-project-template.test.ts` (NEW)
**Changes**: Structural tests following codebase convention (source-string pattern from `project-tools.test.ts`):

```typescript
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const projectToolsSrc = fs.readFileSync(
  path.resolve(__dirname, "../tools/project-tools.ts"),
  "utf-8",
);

const indexSrc = fs.readFileSync(
  path.resolve(__dirname, "../index.ts"),
  "utf-8",
);

const typesSrc = fs.readFileSync(
  path.resolve(__dirname, "../types.ts"),
  "utf-8",
);

describe("setup_project template mode structural", () => {
  it("Zod schema includes templateProjectNumber param", () => {
    expect(projectToolsSrc).toContain("templateProjectNumber");
  });

  it("contains copyProjectV2 mutation", () => {
    expect(projectToolsSrc).toContain("copyProjectV2(input:");
  });

  it("resolves template from args or config", () => {
    expect(projectToolsSrc).toContain("client.config.templateProjectNumber");
  });

  it("uses fetchProject to resolve template", () => {
    expect(projectToolsSrc).toContain("fetchProject(client, owner, templatePN)");
  });

  it("sets includeDraftIssues to false", () => {
    expect(projectToolsSrc).toContain("includeDraftIssues: false");
  });

  it("fetches fields from copied project", () => {
    expect(projectToolsSrc).toContain("fetchProject(client, owner, project.number)");
  });
});

describe("setup_project repo linking structural", () => {
  it("contains linkProjectV2ToRepository mutation", () => {
    expect(projectToolsSrc).toContain("linkProjectV2ToRepository(input:");
  });

  it("has linkRepoAfterSetup helper function", () => {
    expect(projectToolsSrc).toContain("async function linkRepoAfterSetup");
  });

  it("repo linking is best-effort (wrapped in try/catch)", () => {
    expect(projectToolsSrc).toContain("linkRepoAfterSetup(client, project.id");
  });

  it("reads repo from client config", () => {
    expect(projectToolsSrc).toContain("client.config.owner");
    expect(projectToolsSrc).toContain("client.config.repo");
  });

  it("returns repositoryLink in response", () => {
    expect(projectToolsSrc).toContain("repositoryLink:");
  });
});

describe("RALPH_GH_TEMPLATE_PROJECT env var structural", () => {
  it("index.ts parses RALPH_GH_TEMPLATE_PROJECT", () => {
    expect(indexSrc).toContain("RALPH_GH_TEMPLATE_PROJECT");
  });

  it("index.ts passes templateProjectNumber to createGitHubClient", () => {
    expect(indexSrc).toContain("templateProjectNumber");
  });
});

describe("GitHubClientConfig templateProjectNumber structural", () => {
  it("types.ts includes templateProjectNumber in config", () => {
    expect(typesSrc).toContain("templateProjectNumber");
  });
});
```

### Success Criteria
- [ ] Automated: `npm run build` passes
- [ ] Automated: `npm test` passes (all tests including new structural tests)
- [ ] Manual: Repo auto-linked after blank project creation
- [ ] Manual: Repo auto-linked after template copy

**Creates for next phase**: N/A (final phase)

---

## Integration Testing

- [ ] Create blank project without template: verify fields created, repo linked, cache populated
- [ ] Create project from template: verify fields copied, repo linked, cache populated, `copiedFrom` in response
- [ ] Verify `setup_project` with invalid template number returns clean error
- [ ] Verify blank creation still works when `RALPH_GH_TEMPLATE_PROJECT` env var is not set
- [ ] All existing tests pass (regression)

## References

- Research GH-162: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0162-copy-project-v2-setup-project.md
- Research GH-163: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0163-post-copy-repo-linking-tests.md
- Parent: https://github.com/cdubiel08/ralph-hero/issues/111
- Golden template project: https://github.com/users/cdubiel08/projects/4
- `copy_project` tool (independent): https://github.com/cdubiel08/ralph-hero/issues/101
