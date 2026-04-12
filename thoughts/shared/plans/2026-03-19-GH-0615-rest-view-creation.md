---
date: 2026-03-19
status: draft
type: plan
tags: [mcp-server, github-api, projects-v2, views, rest-api]
github_issue: 615
github_issues: [615]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/615
primary_issue: 615
last_updated: 2026-03-19
last_updated_note: "Revised after code review — explicit GitHubClient interface update, fetchProjectViews returns ownerType to eliminate extra round-trip, toRestLayout typed as ProjectV2ViewLayout, camelCase fix, pure-function tests added"
---

# REST View Creation — `create_views` Tool Implementation Plan

## Prior Work

- builds_on:: [[2026-03-19-github-projects-v2-view-api-exhaustive]]
- builds_on:: [[2026-02-20-GH-0162-copy-project-v2-setup-project]]
- builds_on:: [[view-recipes]]
- builds_on:: [[golden-project-views]]

## Overview

Add a `ralph_hero__create_views` MCP tool that reads views from a source project via GraphQL and creates them in a target project via the GitHub Projects V2 REST API. Requires adding REST call capability to the GitHub client (currently GraphQL-only).

## Current State Analysis

- `github-client.ts` uses `@octokit/graphql` exclusively — no REST support (`github-client.ts:81-97`)
- `GitHubClient` interface declared inline in `github-client.ts:29-72` — **must be updated alongside the implementation** (both the interface block and the return object)
- `ProjectV2View` interface is defined in `types.ts:175-181` with `id`, `name`, `number`, `layout`, `filter` fields
- `ProjectV2ViewLayout` is a union type at `types.ts:170-173`: `"BOARD_LAYOUT" | "TABLE_LAYOUT" | "ROADMAP_LAYOUT"`
- `views: Connection<ProjectV2View>` exists on the `ProjectV2` interface (`types.ts:196`) but is never queried
- `fetchProject()` in `project-tools.ts:507-605` uses a user→org fallback pattern for GraphQL that must be replicated for views
- Tool registration follows the `registerXyzTools(server, client, fieldCache)` pattern; `index.ts` wires them all together
- Node 18/20/22 are all CI targets — native `globalThis.fetch` is available

### Key Discoveries

- `github-client.ts:29-72` — `GitHubClient` interface is declared inline in the same file as `createGitHubClient()`; both must be updated together for TypeScript to accept the new method
- `github-client.ts:81-97` — dual-token setup: `token` (repo) and `projectToken` (project); the `create_views` tool should use the project token for REST calls
- REST layout values are lowercase (`table`, `board`, `roadmap`); GraphQL returns uppercase with `_LAYOUT` suffix — conversion required; `toRestLayout` should accept `ProjectV2ViewLayout` (not `string`) so TypeScript enforces exhaustiveness
- `filter` from GraphQL is a plain top-level string (e.g. `"assignee:@me is:open"`) matching what the REST POST body expects as `filter` — confirmed by the REST API docs and research doc
- `@octokit/rest` is not installed; native `fetch` is the right choice (no new deps)

## Desired End State

After this plan is implemented:

```
ralph_hero__create_views({
  sourceProjectNumber: 3,
  targetProjectNumber: 7
})
```

Reads all views from project #3 via GraphQL, then POSTs each to project #7 via REST, returning:

```json
{
  "created": [
    { "name": "Active Work", "layout": "board", "id": "PVV_..." },
    { "name": "Backlog", "layout": "table", "id": "PVV_..." }
  ],
  "count": 2,
  "sourceProject": 3,
  "targetProject": 7
}
```

Verify by calling `ralph_hero__get_project` on #7 and confirming views are present (or querying GitHub UI).

## What We're NOT Doing

- No `updateProjectV2View` or `deleteProjectV2View` — these don't exist in any API
- No inline view recipe array parameter — source-copy mode only (keeps scope at S)
- No sort/group configuration — the REST POST endpoint only supports name, layout, filter, visible_fields
- No modification to `setup_project` to auto-call `create_views` (can be a follow-up)
- No pagination of views beyond `first: 50` — projects with >50 views are not a realistic concern
- No caching in `fetchProjectViews` — intentional; this is a one-shot setup tool

## Implementation Approach

Four phases:
1. Add `restPost()` to **both** the `GitHubClient` interface (lines 29–72) and `createGitHubClient()` return object using native `fetch`
2. Add `fetchProjectViews()` GraphQL helper (user/org fallback, returns views AND resolved `ownerType` — eliminates a separate owner-detection round-trip)
3. Implement `create_views` tool in new `view-tools.ts` using `ownerType` from phase 2
4. Wire into `index.ts` and add tests (source-inspection + pure-function for `toRestLayout`)

---

## Phase 1: Add `restPost()` to GitHubClient

### Overview
Extend **both** the `GitHubClient` interface declaration (lines 29–72 of `github-client.ts`) and the object returned by `createGitHubClient()`. Both live in the same file. Using native `fetch` keeps token management centralised and adds no new dependencies.

### Changes Required

#### 1. `github-client.ts` — interface declaration

**File**: `plugin/ralph-hero/mcp-server/src/github-client.ts`

Add inside the `GitHubClient` interface block (lines 29–72), alongside the existing method signatures:

```typescript
restPost<T>(path: string, body: unknown, useProjectToken?: boolean): Promise<T>;
```

#### 2. `github-client.ts` — implementation

Add to the object returned by `createGitHubClient()`, alongside `query`, `mutate`, `projectQuery`, `projectMutate`, etc.:

```typescript
async restPost<T>(
  path: string,
  body: unknown,
  useProjectToken = true,
): Promise<T> {
  const token = useProjectToken
    ? (clientConfig.projectToken ?? clientConfig.token)
    : clientConfig.token;

  const url = `https://api.github.com${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `GitHub REST API error ${response.status} for ${path}: ${text}`,
    );
  }

  return response.json() as Promise<T>;
},
```

### Success Criteria

#### Automated Verification
- [ ] `npm run build` — TypeScript compiles without errors
- [ ] `GitHubClient` type includes `restPost` method

#### Manual Verification
- [ ] No new runtime deps required (native `fetch` only)

**Implementation Note**: Pause after this phase and verify TypeScript compiles cleanly before proceeding.

---

## Phase 2: Add `fetchProjectViews()` GraphQL Helper

### Overview
Add a helper that reads all views from a project via GraphQL with the user→org fallback. Returns `{ views, ownerType }` so the caller knows which REST path to use without a second API round-trip.

### Changes Required

#### 1. `project-tools.ts`

**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`

Add after `fetchProject()` (around line 605). Ensure `ProjectV2View` and `ProjectV2ViewLayout` are imported from `../types.js`.

```typescript
interface ViewsQueryResult {
  user?: { projectV2: { views: { nodes: ProjectV2View[] } } | null } | null;
  organization?: {
    projectV2: { views: { nodes: ProjectV2View[] } } | null;
  } | null;
}

const VIEWS_QUERY_USER = `
  query($login: String!, $number: Int!) {
    user(login: $login) {
      projectV2(number: $number) {
        views(first: 50) {
          nodes { id name number layout filter }
        }
      }
    }
  }
`;

const VIEWS_QUERY_ORG = `
  query($login: String!, $number: Int!) {
    organization(login: $login) {
      projectV2(number: $number) {
        views(first: 50) {
          nodes { id name number layout filter }
        }
      }
    }
  }
`;

export interface FetchProjectViewsResult {
  views: ProjectV2View[];
  ownerType: "users" | "orgs";
}

// Returns views AND the resolved ownerType so callers can construct the
// correct REST path without a separate round-trip.
export async function fetchProjectViews(
  client: GitHubClient,
  owner: string,
  projectNumber: number,
): Promise<FetchProjectViewsResult> {
  // Try user first
  try {
    const result = await client.projectQuery<ViewsQueryResult>(
      VIEWS_QUERY_USER,
      { login: owner, number: projectNumber },
    );
    const nodes = result.user?.projectV2?.views?.nodes;
    if (nodes) return { views: nodes, ownerType: "users" };
  } catch {
    // fall through to org
  }

  // Try org
  const result = await client.projectQuery<ViewsQueryResult>(
    VIEWS_QUERY_ORG,
    { login: owner, number: projectNumber },
  );
  const nodes = result.organization?.projectV2?.views?.nodes;
  if (!nodes) {
    throw new Error(
      `Project #${projectNumber} not found for owner "${owner}"`,
    );
  }
  return { views: nodes, ownerType: "orgs" };
}
```

### Success Criteria

#### Automated Verification
- [ ] `npm run build` — compiles without errors

#### Manual Verification
- [ ] None required for this phase alone (tested via Phase 3)

**Implementation Note**: Pause after this phase and verify TypeScript compiles cleanly before proceeding.

---

## Phase 3: Implement `create_views` Tool

### Overview
New `view-tools.ts` with `ralph_hero__create_views`. Uses `ownerType` returned by `fetchProjectViews()` to select the REST path — no extra round-trip. `toRestLayout` accepts `ProjectV2ViewLayout` (not `string`), giving TypeScript exhaustiveness checking.

### Changes Required

#### 1. New `view-tools.ts`

**File**: `plugin/ralph-hero/mcp-server/src/tools/view-tools.ts`

```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolError, toolSuccess } from "../types.js";
import type { GitHubClient } from "../github-client.js";
import type { FieldOptionCache } from "../lib/cache.js";
import type { ProjectV2ViewLayout } from "../types.js";
import { fetchProjectViews } from "./project-tools.js";

// All three GraphQL layout variants are handled exhaustively.
// TypeScript will error at build time if GitHub adds a new layout variant
// and this function is not updated.
export function toRestLayout(
  layout: ProjectV2ViewLayout,
): "table" | "board" | "roadmap" {
  switch (layout) {
    case "TABLE_LAYOUT":
      return "table";
    case "BOARD_LAYOUT":
      return "board";
    case "ROADMAP_LAYOUT":
      return "roadmap";
  }
}

export function registerViewTools(
  server: McpServer,
  client: GitHubClient,
  _fieldCache: FieldOptionCache,
): void {
  server.tool(
    "ralph_hero__create_views",
    "Copy views from a source GitHub Project V2 to a target project using the REST API. Reads view names, layouts, and filter strings from the source project via GraphQL, then creates matching views in the target. Note: sort/group configuration is not available via API and must be set manually after creation.",
    {
      owner: z
        .string()
        .optional()
        .describe(
          "GitHub owner (user or org). Defaults to RALPH_GH_OWNER env var",
        ),
      sourceProjectNumber: z.coerce
        .number()
        .describe("Project number to copy views FROM"),
      targetProjectNumber: z.coerce
        .number()
        .describe("Project number to copy views INTO"),
    },
    async (args) => {
      const owner =
        args.owner ?? client.config.projectOwner ?? client.config.owner;
      if (!owner) {
        return toolError(
          "owner is required — set RALPH_GH_OWNER or pass owner param",
        );
      }

      // Read views from source project; ownerType drives REST path selection
      let sourceViews;
      let ownerType: "users" | "orgs";
      try {
        const result = await fetchProjectViews(
          client,
          owner,
          args.sourceProjectNumber,
        );
        sourceViews = result.views;
        ownerType = result.ownerType;
      } catch (err) {
        return toolError(
          `Failed to read views from project #${args.sourceProjectNumber}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (sourceViews.length === 0) {
        return toolSuccess({
          created: [],
          failed: [],
          count: 0,
          sourceProject: args.sourceProjectNumber,
          targetProject: args.targetProjectNumber,
          message: "Source project has no views",
        });
      }

      // REST path uses owner login (not numeric ID).
      // filter is a plain top-level string matching the GraphQL field value.
      const basePath =
        ownerType === "users"
          ? `/users/${owner}/projectsV2/${args.targetProjectNumber}/views`
          : `/orgs/${owner}/projectsV2/${args.targetProjectNumber}/views`;

      const created: Array<{ name: string; layout: string; id: string }> = [];
      const failed: Array<{ name: string; error: string }> = [];

      for (const view of sourceViews) {
        const body: Record<string, unknown> = {
          name: view.name,
          layout: toRestLayout(view.layout),
        };
        if (view.filter) {
          body.filter = view.filter;
        }

        try {
          const createdView = await client.restPost<{
            id: string;
            name: string;
            layout: string;
          }>(basePath, body);
          created.push({
            name: createdView.name,
            layout: createdView.layout,
            id: createdView.id,
          });
        } catch (err) {
          failed.push({
            name: view.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return toolSuccess({
        created,
        failed,
        count: created.length,
        sourceProject: args.sourceProjectNumber,
        targetProject: args.targetProjectNumber,
      });
    },
  );
}
```

#### 2. `index.ts` — Register the new tool module

**File**: `plugin/ralph-hero/mcp-server/src/index.ts`

Add import alongside the other tool module imports:

```typescript
import { registerViewTools } from "./tools/view-tools.js";
```

Add registration call alongside the other `registerXyzTools()` calls:

```typescript
registerViewTools(server, client, fieldCache);
```

### Success Criteria

#### Automated Verification
- [ ] `npm run build` — compiles without errors
- [ ] `npm test` — all existing tests pass

#### Manual Verification
- [ ] `ralph_hero__create_views({ sourceProjectNumber: 3, targetProjectNumber: 7 })` creates views in project #7
- [ ] Returned `created` array lists each view with name, layout, and id
- [ ] Views appear in the GitHub UI at https://github.com/users/cdubiel08/projects/7

**Implementation Note**: Pause after this phase for manual testing of the tool against live projects before proceeding to Phase 4.

---

## Phase 4: Tests

### Overview
Test file for `view-tools.ts` combining source-inspection (consistent with `issue-tools.test.ts`) and pure-function tests for the exported `toRestLayout`. Note: copy the `__dirname` / import style from existing test files exactly — do not invent a new pattern.

### Changes Required

#### 1. New test file

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/view-tools.test.ts`

```typescript
import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";
import { toRestLayout } from "../tools/view-tools.js";

const viewToolsSrc = fs.readFileSync(
  path.resolve(__dirname, "../tools/view-tools.ts"),
  "utf-8",
);

describe("view-tools source structure", () => {
  it("registers ralph_hero__create_views tool", () => {
    expect(viewToolsSrc).toContain("ralph_hero__create_views");
  });

  it("has sourceProjectNumber param", () => {
    expect(viewToolsSrc).toContain("sourceProjectNumber");
  });

  it("has targetProjectNumber param", () => {
    expect(viewToolsSrc).toContain("targetProjectNumber");
  });

  it("imports fetchProjectViews from project-tools", () => {
    expect(viewToolsSrc).toContain("fetchProjectViews");
  });

  it("calls restPost on client", () => {
    expect(viewToolsSrc).toContain("client.restPost");
  });
});

describe("toRestLayout", () => {
  it("converts TABLE_LAYOUT to table", () => {
    expect(toRestLayout("TABLE_LAYOUT")).toBe("table");
  });

  it("converts BOARD_LAYOUT to board", () => {
    expect(toRestLayout("BOARD_LAYOUT")).toBe("board");
  });

  it("converts ROADMAP_LAYOUT to roadmap", () => {
    expect(toRestLayout("ROADMAP_LAYOUT")).toBe("roadmap");
  });
});
```

### Success Criteria

#### Automated Verification
- [ ] `npx vitest run src/__tests__/view-tools.test.ts` — all tests pass
- [ ] `npm test` — full suite passes

#### Manual Verification
- [ ] None required

---

## Testing Strategy

### Unit Tests
- Source inspection: tool name, required params, `fetchProjectViews` import, `restPost` usage
- Pure-function: `toRestLayout` covers all three layout variants (TABLE/BOARD/ROADMAP)

### Manual Testing Steps
1. Ensure project #3 has at least one view configured in GitHub UI
2. Run `ralph_hero__create_views({ sourceProjectNumber: 3, targetProjectNumber: 7 })`
3. Verify response `created` array matches expected view names and layouts
4. Open https://github.com/users/cdubiel08/projects/7 and confirm views appear

## Performance Considerations

- Views are created serially (one REST call per view) — acceptable for typical project sizes (2–10 views)
- Each view POST is independent; partial success handled gracefully via `failed` array
- No caching in `fetchProjectViews` — intentional; this is a one-shot setup tool

## References

- Original issue: #615
- Research: `thoughts/shared/research/2026-03-19-github-projects-v2-view-api-exhaustive.md`
- REST endpoint docs: `POST /users/{user}/projectsV2/{n}/views` — [GitHub Docs](https://docs.github.com/en/enterprise-cloud@latest/rest/projects/views)
- Existing pattern: `fetchProject()` at `project-tools.ts:507-605`
- Existing pattern: `github-client.ts:29-72` (interface) and `github-client.ts:81-97` (dual-token setup)
