# Multi-Repo Portfolio Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable tech leads to describe a feature once and have Ralph decompose it into repo-specific issues with correct defaults and cross-repo dependencies, powered by a `.ralph-repos.yml` registry.

**Architecture:** A new `lib/repo-registry.ts` module parses and validates `.ralph-repos.yml` from the project's primary repo. The registry is loaded at MCP server startup and stored on `GitHubClientConfig`. Existing tools (`create_issue`, `pipeline_dashboard`) are enhanced to consult the registry. A new `decompose_feature` tool and `setup-repos` skill are added.

**Tech Stack:** TypeScript, Zod (schema validation), `yaml` package (already a dependency), Vitest (tests), GitHub GraphQL API

---

## Pre-existing work (no changes needed)

- `list_issues` already has `repoFilter` parameter (`issue-tools.ts:94-100`, filtering at `issue-tools.ts:306-319`)
- `DashboardItem` already has `repository?: string` field (`lib/dashboard.ts:43`)
- Dashboard items already fetch `repository { nameWithOwner name }` (`dashboard-tools.ts:217`)

---

### Task 1: Repo Registry Types and Parser

**Files:**
- Create: `plugin/ralph-hero/mcp-server/src/lib/repo-registry.ts`
- Test: `plugin/ralph-hero/mcp-server/src/__tests__/repo-registry.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/__tests__/repo-registry.test.ts
import { describe, it, expect } from "vitest";
import {
  RepoRegistrySchema,
  parseRepoRegistry,
  type RepoRegistry,
  type RepoEntry,
} from "../lib/repo-registry.js";

describe("RepoRegistrySchema", () => {
  it("parses a minimal valid registry", () => {
    const result = RepoRegistrySchema.safeParse({
      version: 1,
      repos: {
        "my-service": {
          domain: "User management",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("parses a full registry with patterns", () => {
    const result = RepoRegistrySchema.safeParse({
      version: 1,
      repos: {
        "api-gateway": {
          owner: "myorg",
          domain: "API gateway, routing",
          tech: ["typescript", "express"],
          defaults: {
            labels: ["service:gateway"],
            assignees: ["alice"],
            estimate: "S",
          },
          paths: ["src/routes/"],
        },
        "frontend": {
          domain: "React SPA",
        },
      },
      patterns: {
        "api-feature": {
          description: "New API endpoint with UI",
          decomposition: [
            { repo: "api-gateway", role: "Route definition" },
            { repo: "frontend", role: "UI components" },
          ],
          "dependency-flow": ["api-gateway", "frontend"],
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.patterns?.["api-feature"].decomposition).toHaveLength(2);
    }
  });

  it("rejects missing version", () => {
    const result = RepoRegistrySchema.safeParse({
      repos: { svc: { domain: "x" } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty repos", () => {
    const result = RepoRegistrySchema.safeParse({
      version: 1,
      repos: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects repo without domain", () => {
    const result = RepoRegistrySchema.safeParse({
      version: 1,
      repos: { svc: { tech: ["go"] } },
    });
    expect(result.success).toBe(false);
  });
});

describe("parseRepoRegistry", () => {
  it("parses valid YAML string", () => {
    const yaml = `
version: 1
repos:
  my-service:
    domain: "User management"
`;
    const result = parseRepoRegistry(yaml);
    expect(result.repos["my-service"].domain).toBe("User management");
  });

  it("throws on invalid YAML", () => {
    expect(() => parseRepoRegistry("{{invalid")).toThrow();
  });

  it("throws on valid YAML but invalid schema", () => {
    expect(() => parseRepoRegistry("version: 1\nrepos: {}")).toThrow();
  });

  it("parses patterns with dependency-flow", () => {
    const yaml = `
version: 1
repos:
  backend:
    domain: "Backend API"
  frontend:
    domain: "Frontend app"
patterns:
  full-stack:
    description: "Full stack feature"
    decomposition:
      - repo: backend
        role: "API endpoint"
      - repo: frontend
        role: "UI"
    dependency-flow: [backend, frontend]
`;
    const result = parseRepoRegistry(yaml);
    expect(result.patterns?.["full-stack"]["dependency-flow"]).toEqual(["backend", "frontend"]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/repo-registry.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/lib/repo-registry.ts
import { z } from "zod";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const RepoDefaultsSchema = z.object({
  labels: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional(),
  estimate: z.string().optional(),
});

const RepoEntrySchema = z.object({
  owner: z.string().optional(),
  domain: z.string(),
  tech: z.array(z.string()).optional(),
  defaults: RepoDefaultsSchema.optional(),
  paths: z.array(z.string()).optional(),
});

const DecompositionStepSchema = z.object({
  repo: z.string(),
  role: z.string(),
});

const PatternSchema = z.object({
  description: z.string(),
  decomposition: z.array(DecompositionStepSchema).min(1),
  "dependency-flow": z.array(z.string()).optional(),
});

export const RepoRegistrySchema = z.object({
  version: z.literal(1),
  repos: z.record(z.string(), RepoEntrySchema).refine(
    (repos) => Object.keys(repos).length > 0,
    { message: "repos must have at least one entry" },
  ),
  patterns: z.record(z.string(), PatternSchema).optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RepoRegistry = z.infer<typeof RepoRegistrySchema>;
export type RepoEntry = z.infer<typeof RepoEntrySchema>;
export type RepoDefaults = z.infer<typeof RepoDefaultsSchema>;
export type DecompositionStep = z.infer<typeof DecompositionStepSchema>;
export type Pattern = z.infer<typeof PatternSchema>;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a YAML string into a validated RepoRegistry.
 * Throws on invalid YAML or schema validation failure.
 */
export function parseRepoRegistry(yamlContent: string): RepoRegistry {
  const raw = parseYaml(yamlContent);
  const result = RepoRegistrySchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid .ralph-repos.yml:\n${issues}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Look up a repo entry by name (case-insensitive).
 * Returns the entry and its canonical name, or undefined.
 */
export function lookupRepo(
  registry: RepoRegistry,
  repoName: string,
): { name: string; entry: RepoEntry } | undefined {
  const lower = repoName.toLowerCase();
  for (const [name, entry] of Object.entries(registry.repos)) {
    if (name.toLowerCase() === lower) {
      return { name, entry };
    }
  }
  return undefined;
}

/**
 * Look up a pattern by name (case-insensitive).
 */
export function lookupPattern(
  registry: RepoRegistry,
  patternName: string,
): { name: string; pattern: Pattern } | undefined {
  if (!registry.patterns) return undefined;
  const lower = patternName.toLowerCase();
  for (const [name, pattern] of Object.entries(registry.patterns)) {
    if (name.toLowerCase() === lower) {
      return { name, pattern };
    }
  }
  return undefined;
}

/**
 * Merge registry defaults with explicit args.
 * Labels are additive (union). Assignees and estimate are fallback-only.
 */
export function mergeDefaults(
  defaults: RepoDefaults | undefined,
  args: { labels?: string[]; assignees?: string[]; estimate?: string },
): { labels?: string[]; assignees?: string[]; estimate?: string } {
  if (!defaults) return args;

  const mergedLabels =
    defaults.labels || args.labels
      ? [...new Set([...(args.labels ?? []), ...(defaults.labels ?? [])])]
      : undefined;

  return {
    labels: mergedLabels,
    assignees: args.assignees ?? defaults.assignees,
    estimate: args.estimate ?? defaults.estimate,
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/repo-registry.test.ts`
Expected: PASS (all tests)

**Step 5: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/lib/repo-registry.ts plugin/ralph-hero/mcp-server/src/__tests__/repo-registry.test.ts
git commit -m "feat: add repo registry types, parser, and lookup helpers"
```

---

### Task 2: Load Registry at Server Startup

**Files:**
- Modify: `plugin/ralph-hero/mcp-server/src/types.ts:264-274` (add `repoRegistry` to config)
- Modify: `plugin/ralph-hero/mcp-server/src/index.ts:111-120` (pass registry into config)
- Modify: `plugin/ralph-hero/mcp-server/src/lib/helpers.ts:431-469` (tolerate 2+ repos with registry)
- Create: `plugin/ralph-hero/mcp-server/src/lib/registry-loader.ts` (fetch + parse from GitHub)
- Test: `plugin/ralph-hero/mcp-server/src/__tests__/registry-loader.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/__tests__/registry-loader.test.ts
import { describe, it, expect } from "vitest";
import { parseRepoRegistry } from "../lib/repo-registry.js";

// Test the loading logic as pure functions (actual GitHub fetch is integration-tested)

describe("registry-loader", () => {
  it("registry is optional on GitHubClientConfig", () => {
    // Structural test: verify the type allows undefined repoRegistry
    // This validates the types.ts change
    const config = {
      token: "ghp_test",
      owner: "org",
      repo: "main-repo",
      projectNumber: 1,
      repoRegistry: undefined,
    };
    expect(config.repoRegistry).toBeUndefined();
  });

  it("registry can be set on config", () => {
    const registry = parseRepoRegistry(`
version: 1
repos:
  svc:
    domain: "A service"
`);
    const config = {
      token: "ghp_test",
      repoRegistry: registry,
    };
    expect(config.repoRegistry?.repos["svc"].domain).toBe("A service");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/registry-loader.test.ts`
Expected: PASS (these are pure type/value tests, they'll pass once the import works)

**Step 3: Add `repoRegistry` to `GitHubClientConfig`**

In `src/types.ts`, add to the `GitHubClientConfig` interface (after line 273):

```typescript
  repoRegistry?: import("./lib/repo-registry.js").RepoRegistry; // Loaded from .ralph-repos.yml
```

**Step 4: Create `registry-loader.ts`**

```typescript
// src/lib/registry-loader.ts
/**
 * Load .ralph-repos.yml from the project's primary repo via GitHub API.
 * Returns null if the file doesn't exist (registry is optional).
 */
import type { GitHubClient } from "../github-client.js";
import { parseRepoRegistry, type RepoRegistry } from "./repo-registry.js";

export async function loadRepoRegistry(
  client: GitHubClient,
): Promise<RepoRegistry | null> {
  const { owner, repo } = client.config;
  if (!owner || !repo) return null;

  try {
    const result = await client.query<{
      repository: {
        object: { text: string } | null;
      } | null;
    }>(
      `query($owner: String!, $repo: String!, $expression: String!) {
        repository(owner: $owner, name: $repo) {
          object(expression: $expression) {
            ... on Blob { text }
          }
        }
      }`,
      { owner, repo, expression: "HEAD:.ralph-repos.yml" },
      { cache: true, cacheTtlMs: 10 * 60 * 1000 },
    );

    const text = result.repository?.object?.text;
    if (!text) return null;

    const registry = parseRepoRegistry(text);
    console.error(
      `[ralph-hero] Repo registry loaded: ${Object.keys(registry.repos).length} repos` +
        (registry.patterns
          ? `, ${Object.keys(registry.patterns).length} patterns`
          : ""),
    );
    return registry;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[ralph-hero] Warning: Failed to load .ralph-repos.yml: ${message}. ` +
        `Continuing without repo registry.`,
    );
    return null;
  }
}
```

**Step 5: Update `index.ts` startup to load registry**

In `src/index.ts`, after the `resolveRepoFromProject(client)` call (around line 310), add:

```typescript
  // Load repo registry if available
  const { loadRepoRegistry } = await import("./lib/registry-loader.js");
  const registry = await loadRepoRegistry(client);
  if (registry) {
    client.config.repoRegistry = registry;
  }
```

**Step 6: Update `resolveRepoFromProject()` to tolerate 2+ repos with registry**

In `src/lib/helpers.ts`, modify the 2+ repos branch (around line 462) to:

```typescript
  if (result.totalRepos === 1) {
    // ... existing single-repo logic unchanged ...
  }

  // 2+ repos: use first registry repo as default if available, else warn
  if (client.config.repoRegistry) {
    const firstRepoName = Object.keys(client.config.repoRegistry.repos)[0];
    const registryEntry = client.config.repoRegistry.repos[firstRepoName];
    const inferredOwner = registryEntry.owner || client.config.owner;
    client.config.repo = firstRepoName;
    if (!client.config.owner && inferredOwner) {
      client.config.owner = inferredOwner;
    }
    console.error(
      `[ralph-hero] Multiple repos linked. Using "${firstRepoName}" as default (from .ralph-repos.yml). ` +
      `Override per-call with repo param.`,
    );
    return firstRepoName;
  }

  const repoList = result.repos.map(r => r.nameWithOwner).join(", ");
  console.error(
    `[ralph-hero] Multiple repos linked to project: ${repoList}. ` +
    `Set RALPH_GH_REPO to select the default repo, or add .ralph-repos.yml. ` +
    `Read-only tools will work; write tools require an explicit repo param.`
  );
  return undefined;
```

Note: `resolveRepoFromProject` runs before registry loading in the current startup order. We need to reorder: first resolve repo (may get undefined for 2+ repos), then load registry (uses the resolved repo, or tries each linked repo), then re-resolve with registry. Alternatively, load registry from any linked repo if primary is unknown. The simplest approach: load registry before repo resolution. Update `index.ts` startup order to:

1. `initGitHubClient()` — env vars
2. `loadRepoRegistry(client)` — fetch from first linked repo or env-configured repo
3. `resolveRepoFromProject(client)` — now registry-aware

This requires `loadRepoRegistry` to handle the case where `client.config.repo` is not yet set by querying linked repos itself. Update `registry-loader.ts`:

```typescript
export async function loadRepoRegistry(
  client: GitHubClient,
): Promise<RepoRegistry | null> {
  const owner = client.config.owner;
  let repo = client.config.repo;

  if (!owner) return null;

  // If no default repo, try to find .ralph-repos.yml in any linked repo
  if (!repo) {
    const projectNumber = client.config.projectNumber;
    const projectOwner = client.config.projectOwner || owner;
    if (!projectNumber) return null;

    try {
      const linked = await queryProjectRepositories(client, projectOwner, projectNumber);
      if (!linked || linked.totalRepos === 0) return null;

      // Try each linked repo until we find .ralph-repos.yml
      for (const r of linked.repos) {
        const registry = await tryLoadRegistryFromRepo(client, r.owner, r.repo);
        if (registry) return registry;
      }
      return null;
    } catch {
      return null;
    }
  }

  return tryLoadRegistryFromRepo(client, owner, repo);
}

async function tryLoadRegistryFromRepo(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<RepoRegistry | null> {
  try {
    const result = await client.query<{
      repository: {
        object: { text: string } | null;
      } | null;
    }>(
      `query($owner: String!, $repo: String!, $expression: String!) {
        repository(owner: $owner, name: $repo) {
          object(expression: $expression) {
            ... on Blob { text }
          }
        }
      }`,
      { owner, repo, expression: "HEAD:.ralph-repos.yml" },
      { cache: true, cacheTtlMs: 10 * 60 * 1000 },
    );

    const text = result.repository?.object?.text;
    if (!text) return null;

    const registry = parseRepoRegistry(text);
    console.error(
      `[ralph-hero] Repo registry loaded from ${owner}/${repo}: ` +
        `${Object.keys(registry.repos).length} repos` +
        (registry.patterns
          ? `, ${Object.keys(registry.patterns).length} patterns`
          : ""),
    );
    return registry;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[ralph-hero] Warning: Failed to load .ralph-repos.yml from ${owner}/${repo}: ${message}`,
    );
    return null;
  }
}
```

Import `queryProjectRepositories` from helpers (already exists).

**Step 7: Run all tests**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run`
Expected: PASS (all existing + new tests)

**Step 8: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/types.ts plugin/ralph-hero/mcp-server/src/index.ts plugin/ralph-hero/mcp-server/src/lib/helpers.ts plugin/ralph-hero/mcp-server/src/lib/registry-loader.ts plugin/ralph-hero/mcp-server/src/__tests__/registry-loader.test.ts
git commit -m "feat: load repo registry at startup, tolerate 2+ repos"
```

---

### Task 3: Enhance `create_issue` with Registry Defaults

**Files:**
- Modify: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:876-1099` (create_issue handler)
- Test: `plugin/ralph-hero/mcp-server/src/__tests__/repo-registry.test.ts` (add mergeDefaults tests)

**Step 1: Write the failing tests for `mergeDefaults`**

Add to `src/__tests__/repo-registry.test.ts`:

```typescript
import { mergeDefaults } from "../lib/repo-registry.js";

describe("mergeDefaults", () => {
  it("returns args unchanged when no defaults", () => {
    const result = mergeDefaults(undefined, { labels: ["bug"] });
    expect(result).toEqual({ labels: ["bug"] });
  });

  it("merges labels (union, no duplicates)", () => {
    const result = mergeDefaults(
      { labels: ["service:api", "team:backend"] },
      { labels: ["bug", "service:api"] },
    );
    expect(result.labels).toEqual(["bug", "service:api", "team:backend"]);
  });

  it("uses default labels when no explicit labels", () => {
    const result = mergeDefaults(
      { labels: ["service:api"] },
      {},
    );
    expect(result.labels).toEqual(["service:api"]);
  });

  it("uses explicit assignees over defaults", () => {
    const result = mergeDefaults(
      { assignees: ["alice"] },
      { assignees: ["bob"] },
    );
    expect(result.assignees).toEqual(["bob"]);
  });

  it("falls back to default assignees when none provided", () => {
    const result = mergeDefaults(
      { assignees: ["alice"] },
      {},
    );
    expect(result.assignees).toEqual(["alice"]);
  });

  it("falls back to default estimate when none provided", () => {
    const result = mergeDefaults(
      { estimate: "S" },
      {},
    );
    expect(result.estimate).toBe("S");
  });

  it("explicit estimate wins over default", () => {
    const result = mergeDefaults(
      { estimate: "S" },
      { estimate: "M" },
    );
    expect(result.estimate).toBe("M");
  });
});
```

**Step 2: Run tests to verify `mergeDefaults` tests pass**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/repo-registry.test.ts`
Expected: PASS (mergeDefaults is already implemented in Task 1)

**Step 3: Modify `create_issue` to apply registry defaults**

In `src/tools/issue-tools.ts`, at the beginning of the `create_issue` handler (after `resolveFullConfig`, around line 908), add:

```typescript
        // Apply registry defaults if available
        const registry = client.config.repoRegistry;
        if (registry) {
          const repoLookup = lookupRepo(registry, repo);
          if (repoLookup) {
            // Resolve owner from registry if not explicitly provided
            if (!args.owner && repoLookup.entry.owner) {
              // Re-resolve with registry owner
              // (owner is already resolved above, but registry may refine it)
            }
            // Merge defaults
            const merged = mergeDefaults(repoLookup.entry.defaults, {
              labels: args.labels,
              assignees: args.assignees,
              estimate: args.estimate,
            });
            args = { ...args, ...merged };
          }
        }
```

Add imports at top of `issue-tools.ts`:

```typescript
import { lookupRepo, mergeDefaults } from "../lib/repo-registry.js";
```

Note: The `args` parameter is `const` in the closure. You'll need to create mutable copies:

```typescript
        let effectiveLabels = args.labels;
        let effectiveAssignees = args.assignees;
        let effectiveEstimate = args.estimate;

        const registry = client.config.repoRegistry;
        if (registry) {
          const repoLookup = lookupRepo(registry, repo);
          if (repoLookup) {
            const merged = mergeDefaults(repoLookup.entry.defaults, {
              labels: effectiveLabels,
              assignees: effectiveAssignees,
              estimate: effectiveEstimate,
            });
            effectiveLabels = merged.labels;
            effectiveAssignees = merged.assignees;
            effectiveEstimate = merged.estimate;
          }
        }
```

Then use `effectiveLabels`, `effectiveAssignees`, `effectiveEstimate` in the rest of the handler instead of `args.labels`, `args.assignees`, `args.estimate`.

Also apply registry owner resolution: if `args.repo` is provided but `args.owner` is not, and the repo name is in the registry with an `owner`, use it:

```typescript
        // Resolve owner from registry for repo shorthand
        if (registry && args.repo && !args.owner) {
          const repoLookup = lookupRepo(registry, args.repo);
          if (repoLookup?.entry.owner) {
            // Re-resolve config with registry owner
            owner = repoLookup.entry.owner;
          }
        }
```

This should be done before `resolveFullConfig`. Restructure the handler flow:

1. Check registry for owner resolution (before `resolveFullConfig`)
2. `resolveFullConfig` with potentially registry-augmented args
3. Merge defaults from registry
4. Continue with existing flow using merged values

**Step 4: Run all tests**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run`
Expected: PASS

**Step 5: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts plugin/ralph-hero/mcp-server/src/__tests__/repo-registry.test.ts
git commit -m "feat: create_issue applies repo registry defaults"
```

---

### Task 4: Dashboard `groupBy: "repo"` Support

**Files:**
- Modify: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:30-44` (add repo to PhaseSnapshot)
- Modify: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts:255-280` (add groupBy param)
- Test: `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts` (add groupBy tests)

**Step 1: Write the failing tests**

Add to `src/__tests__/dashboard.test.ts` (or create a new `dashboard-group-by.test.ts`):

```typescript
import { describe, it, expect } from "vitest";
import { groupDashboardItemsByRepo, type DashboardItem } from "../lib/dashboard.js";

const makeItem = (
  number: number,
  repository: string,
  workflowState: string,
): DashboardItem => ({
  number,
  title: `Issue #${number}`,
  updatedAt: new Date().toISOString(),
  closedAt: null,
  workflowState,
  priority: null,
  estimate: null,
  assignees: [],
  subIssueCount: 0,
  blockedBy: [],
  repository,
});

describe("groupDashboardItemsByRepo", () => {
  it("groups items by repository", () => {
    const items = [
      makeItem(1, "org/api-gateway", "In Progress"),
      makeItem(2, "org/api-gateway", "Backlog"),
      makeItem(3, "org/frontend", "In Progress"),
    ];
    const groups = groupDashboardItemsByRepo(items);
    expect(Object.keys(groups)).toEqual(["org/api-gateway", "org/frontend"]);
    expect(groups["org/api-gateway"]).toHaveLength(2);
    expect(groups["org/frontend"]).toHaveLength(1);
  });

  it("puts items without repository into '(unknown)' group", () => {
    const items = [makeItem(1, "org/svc", "Backlog")];
    items.push({ ...makeItem(2, "", "Backlog"), repository: undefined });
    const groups = groupDashboardItemsByRepo(items);
    expect(groups["(unknown)"]).toHaveLength(1);
  });

  it("returns empty object for empty input", () => {
    expect(groupDashboardItemsByRepo([])).toEqual({});
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/dashboard-group-by.test.ts`
Expected: FAIL — `groupDashboardItemsByRepo` not found

**Step 3: Add `groupDashboardItemsByRepo` to `lib/dashboard.ts`**

```typescript
/**
 * Group dashboard items by repository (nameWithOwner).
 * Items without a repository are grouped under "(unknown)".
 */
export function groupDashboardItemsByRepo(
  items: DashboardItem[],
): Record<string, DashboardItem[]> {
  const groups: Record<string, DashboardItem[]> = {};
  for (const item of items) {
    const key = item.repository || "(unknown)";
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}
```

**Step 4: Add `groupBy` parameter to `pipeline_dashboard` tool**

In `src/tools/dashboard-tools.ts`, add to the tool schema (around line 278):

```typescript
      groupBy: z
        .enum(["repo"])
        .optional()
        .describe(
          "Group dashboard output by dimension. 'repo' groups items by repository within the project.",
        ),
```

In the handler, after building the dashboard (around line 426), add repo grouping logic:

```typescript
        // If groupBy=repo, build per-repo sub-dashboards
        if (args.groupBy === "repo") {
          const { groupDashboardItemsByRepo } = await import("../lib/dashboard.js");
          const repoGroups = groupDashboardItemsByRepo(allItems);
          const repoResults: Record<string, unknown> = {};

          for (const [repoName, repoItems] of Object.entries(repoGroups)) {
            repoResults[repoName] = buildDashboard(repoItems, healthConfig);
          }

          if (args.format === "markdown") {
            let md = "# Pipeline Dashboard (by repo)\n\n";
            for (const [repoName, repoItems] of Object.entries(repoGroups)) {
              const sub = buildDashboard(repoItems, healthConfig);
              md += `## ${repoName} (${repoItems.length} items)\n\n`;
              md += formatMarkdown(sub) + "\n\n";
            }
            return toolSuccess({ markdown: md });
          }

          return toolSuccess({ groupBy: "repo", repos: repoResults });
        }
```

**Step 5: Run all tests**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run`
Expected: PASS

**Step 6: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/lib/dashboard.ts plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts plugin/ralph-hero/mcp-server/src/__tests__/dashboard-group-by.test.ts
git commit -m "feat: pipeline_dashboard supports groupBy repo"
```

---

### Task 5: `decompose_feature` MCP Tool

**Files:**
- Create: `plugin/ralph-hero/mcp-server/src/tools/decompose-tools.ts`
- Modify: `plugin/ralph-hero/mcp-server/src/index.ts` (register new tool module)
- Test: `plugin/ralph-hero/mcp-server/src/__tests__/decompose-tools.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/__tests__/decompose-tools.test.ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  buildDecomposition,
  type DecomposeInput,
  type DecomposeOutput,
} from "../tools/decompose-tools.js";
import { parseRepoRegistry } from "../lib/repo-registry.js";

const REGISTRY_YAML = `
version: 1
repos:
  api-gateway:
    owner: myorg
    domain: "API gateway, routing, auth middleware"
    defaults:
      labels: [service:gateway]
      assignees: [alice]
      estimate: S
  user-service:
    owner: myorg
    domain: "User management, profiles, authentication"
    defaults:
      labels: [service:users]
  frontend-app:
    owner: myorg
    domain: "React SPA, UI components"
    defaults:
      labels: [frontend]
patterns:
  api-feature:
    description: "New API endpoint with UI"
    decomposition:
      - repo: user-service
        role: "Data model and business logic"
      - repo: api-gateway
        role: "Route definition and middleware"
      - repo: frontend-app
        role: "UI components and API client"
    dependency-flow: [user-service, api-gateway, frontend-app]
`;

const registry = parseRepoRegistry(REGISTRY_YAML);

describe("buildDecomposition", () => {
  it("uses named pattern to build decomposition", () => {
    const result = buildDecomposition(
      {
        title: "Add OAuth2 support",
        description: "Users should log in via OAuth2",
        pattern: "api-feature",
      },
      registry,
    );
    expect(result.matched_pattern).toBe("api-feature");
    expect(result.proposed_issues).toHaveLength(3);
    expect(result.proposed_issues[0].repo).toBe("user-service");
    expect(result.proposed_issues[0].labels).toEqual(["service:users"]);
    expect(result.proposed_issues[1].repo).toBe("api-gateway");
    expect(result.proposed_issues[1].assignees).toEqual(["alice"]);
    expect(result.proposed_issues[1].estimate).toBe("S");
    expect(result.dependency_chain).toEqual([
      "user-service",
      "api-gateway",
      "frontend-app",
    ]);
  });

  it("throws on unknown pattern name", () => {
    expect(() =>
      buildDecomposition(
        { title: "test", description: "test", pattern: "nonexistent" },
        registry,
      ),
    ).toThrow(/Pattern "nonexistent" not found/);
  });

  it("generates titles scoped to each repo's role", () => {
    const result = buildDecomposition(
      {
        title: "Add OAuth2 support",
        description: "Login via Google OAuth2",
        pattern: "api-feature",
      },
      registry,
    );
    // Each issue title should reference the parent feature
    for (const issue of result.proposed_issues) {
      expect(issue.title).toContain("OAuth2");
    }
  });

  it("resolves owner from registry for each repo", () => {
    const result = buildDecomposition(
      { title: "test", description: "test", pattern: "api-feature" },
      registry,
    );
    for (const issue of result.proposed_issues) {
      expect(issue.owner).toBe("myorg");
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/decompose-tools.test.ts`
Expected: FAIL — module not found

**Step 3: Create `decompose-tools.ts`**

```typescript
// src/tools/decompose-tools.ts
/**
 * MCP tool for decomposing features across multiple repositories.
 * Uses .ralph-repos.yml registry patterns and defaults.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import type { FieldOptionCache } from "../lib/cache.js";
import { toolSuccess, toolError } from "../types.js";
import {
  lookupRepo,
  lookupPattern,
  mergeDefaults,
  type RepoRegistry,
  type Pattern,
} from "../lib/repo-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DecomposeInput {
  title: string;
  description: string;
  pattern?: string;
}

export interface ProposedIssue {
  repo: string;
  owner: string;
  title: string;
  body: string;
  role: string;
  labels?: string[];
  assignees?: string[];
  estimate?: string;
}

export interface DecomposeOutput {
  proposed_issues: ProposedIssue[];
  dependency_chain: string[];
  matched_pattern: string;
}

// ---------------------------------------------------------------------------
// Pure decomposition logic (testable without MCP/GitHub)
// ---------------------------------------------------------------------------

/**
 * Build a feature decomposition from a named pattern.
 * Applies registry defaults to each proposed issue.
 */
export function buildDecomposition(
  input: DecomposeInput,
  registry: RepoRegistry,
): DecomposeOutput {
  if (!input.pattern) {
    throw new Error(
      "Pattern name is required when calling buildDecomposition directly. " +
        "Domain-based inference is handled at the tool layer.",
    );
  }

  const patternLookup = lookupPattern(registry, input.pattern);
  if (!patternLookup) {
    const available = registry.patterns
      ? Object.keys(registry.patterns).join(", ")
      : "(none)";
    throw new Error(
      `Pattern "${input.pattern}" not found. Available patterns: ${available}`,
    );
  }

  const { pattern } = patternLookup;
  const proposed_issues: ProposedIssue[] = [];

  for (const step of pattern.decomposition) {
    const repoLookup = lookupRepo(registry, step.repo);
    const defaults = repoLookup?.entry.defaults;
    const owner = repoLookup?.entry.owner ?? "";
    const merged = mergeDefaults(defaults, {});

    proposed_issues.push({
      repo: step.repo,
      owner,
      title: `[${input.title}] ${step.role}`,
      body:
        `## Context\n\n${input.description}\n\n` +
        `## Scope (${step.repo})\n\n${step.role}\n\n` +
        (repoLookup?.entry.domain
          ? `**Repo domain:** ${repoLookup.entry.domain}\n`
          : ""),
      role: step.role,
      labels: merged.labels,
      assignees: merged.assignees,
      estimate: merged.estimate,
    });
  }

  return {
    proposed_issues,
    dependency_chain: pattern["dependency-flow"] ?? [],
    matched_pattern: patternLookup.name,
  };
}

// ---------------------------------------------------------------------------
// MCP tool registration
// ---------------------------------------------------------------------------

export function registerDecomposeTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  server.tool(
    "ralph_hero__decompose_feature",
    "Decompose a feature into repo-specific issues using .ralph-repos.yml patterns. " +
      "Dry-run by default (preview only). Set dryRun=false to create issues and wire dependencies. " +
      "Requires .ralph-repos.yml in the project's primary repo.",
    {
      title: z.string().describe("Feature title"),
      description: z.string().describe("Feature description (what needs to be built)"),
      pattern: z
        .string()
        .optional()
        .describe(
          "Named decomposition pattern from .ralph-repos.yml. " +
            "If omitted, all repos are listed for manual selection.",
        ),
      dryRun: z
        .boolean()
        .optional()
        .default(true)
        .describe("Preview decomposition without creating issues (default: true)"),
      projectNumber: z.coerce
        .number()
        .optional()
        .describe("Project number override (defaults to configured project)"),
    },
    async (args) => {
      try {
        const registry = client.config.repoRegistry;
        if (!registry) {
          return toolError(
            "No repo registry found. Add .ralph-repos.yml to your project's primary repo, " +
              "or run the setup-repos skill to generate one.",
          );
        }

        // If no pattern specified, list available patterns
        if (!args.pattern) {
          const patterns = registry.patterns
            ? Object.entries(registry.patterns).map(([name, p]) => ({
                name,
                description: p.description,
                repos: p.decomposition.map((d) => d.repo),
              }))
            : [];
          const repos = Object.entries(registry.repos).map(([name, r]) => ({
            name,
            domain: r.domain,
          }));
          return toolSuccess({
            message:
              "No pattern specified. Choose a pattern or specify repos manually.",
            available_patterns: patterns,
            available_repos: repos,
          });
        }

        const decomposition = buildDecomposition(
          {
            title: args.title,
            description: args.description,
            pattern: args.pattern,
          },
          registry,
        );

        if (args.dryRun) {
          return toolSuccess({
            dryRun: true,
            ...decomposition,
            hint: "Set dryRun=false to create these issues and wire dependencies.",
          });
        }

        // Create issues and wire dependencies
        // Import helpers dynamically to avoid circular deps
        const { resolveFullConfig, ensureFieldCache } = await import(
          "../lib/helpers.js"
        );

        const createdIssues: Array<{
          repo: string;
          number: number;
          url: string;
          title: string;
        }> = [];

        for (const proposed of decomposition.proposed_issues) {
          const owner = proposed.owner || client.config.owner;
          if (!owner) {
            return toolError(`Cannot resolve owner for repo "${proposed.repo}"`);
          }

          // Get repo ID
          const repoResult = await client.query<{
            repository: { id: string } | null;
          }>(
            `query($owner: String!, $repo: String!) {
              repository(owner: $owner, name: $repo) { id }
            }`,
            { owner, repo: proposed.repo },
            { cache: true, cacheTtlMs: 60 * 60 * 1000 },
          );
          const repoId = repoResult.repository?.id;
          if (!repoId) {
            return toolError(`Repository ${owner}/${proposed.repo} not found`);
          }

          // Resolve label IDs
          let labelIds: string[] | undefined;
          if (proposed.labels && proposed.labels.length > 0) {
            const labelResult = await client.query<{
              repository: {
                labels: { nodes: Array<{ id: string; name: string }> };
              };
            }>(
              `query($owner: String!, $repo: String!) {
                repository(owner: $owner, name: $repo) {
                  labels(first: 100) { nodes { id name } }
                }
              }`,
              { owner, repo: proposed.repo },
              { cache: true, cacheTtlMs: 5 * 60 * 1000 },
            );
            labelIds = proposed.labels
              .map((name) =>
                labelResult.repository.labels.nodes.find((l) => l.name === name)?.id,
              )
              .filter((id): id is string => !!id);
          }

          // Create issue
          const createResult = await client.mutate<{
            createIssue: {
              issue: { id: string; number: number; title: string; url: string };
            };
          }>(
            `mutation($repoId: ID!, $title: String!, $body: String, $labelIds: [ID!]) {
              createIssue(input: {
                repositoryId: $repoId,
                title: $title,
                body: $body,
                labelIds: $labelIds
              }) {
                issue { id number title url }
              }
            }`,
            {
              repoId,
              title: proposed.title,
              body: proposed.body,
              labelIds: labelIds || null,
            },
          );

          const issue = createResult.createIssue.issue;
          createdIssues.push({
            repo: proposed.repo,
            number: issue.number,
            url: issue.url,
            title: issue.title,
          });

          // Add to project
          const projectNumber =
            args.projectNumber ?? client.config.projectNumber;
          const projectOwner =
            client.config.projectOwner || client.config.owner;
          if (projectNumber && projectOwner) {
            await ensureFieldCache(
              client,
              fieldCache,
              projectOwner,
              projectNumber,
            );
            const projectId = fieldCache.getProjectId(projectNumber);
            if (projectId) {
              await client.projectMutate(
                `mutation($projectId: ID!, $contentId: ID!) {
                  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
                    item { id }
                  }
                }`,
                { projectId, contentId: issue.id },
              );
            }
          }
        }

        // Wire dependencies based on dependency chain
        if (
          decomposition.dependency_chain.length > 1 &&
          createdIssues.length > 1
        ) {
          const chainMap = new Map(
            createdIssues.map((i) => [i.repo, i]),
          );
          for (let idx = 1; idx < decomposition.dependency_chain.length; idx++) {
            const blocker = chainMap.get(decomposition.dependency_chain[idx - 1]);
            const blocked = chainMap.get(decomposition.dependency_chain[idx]);
            if (blocker && blocked) {
              // Use sub-issue relationship for cross-repo dependency
              // (GitHub sub-issues work cross-repo)
              try {
                await client.mutate(
                  `mutation($parentId: ID!, $childId: ID!) {
                    addSubIssue(input: { issueId: $parentId, subIssueId: $childId }) {
                      issue { id }
                    }
                  }`,
                  {
                    parentId: `issue-${blocker.number}`, // Will need node ID lookup
                    childId: `issue-${blocked.number}`,
                  },
                );
              } catch {
                // Cross-repo sub-issues may not be supported; log and continue
                console.error(
                  `[ralph-hero] Warning: Could not link ${blocker.repo}#${blocker.number} → ${blocked.repo}#${blocked.number}`,
                );
              }
            }
          }
        }

        return toolSuccess({
          dryRun: false,
          created: createdIssues,
          dependency_chain: decomposition.dependency_chain,
          matched_pattern: decomposition.matched_pattern,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to decompose feature: ${message}`);
      }
    },
  );
}
```

**Step 4: Register in `index.ts`**

Add import:
```typescript
import { registerDecomposeTools } from "./tools/decompose-tools.js";
```

Add registration call after existing tool registrations (around line 357):
```typescript
  registerDecomposeTools(server, client, fieldCache);
```

**Step 5: Run all tests**

Run: `cd plugin/ralph-hero/mcp-server && npx vitest run`
Expected: PASS

**Step 6: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/tools/decompose-tools.ts plugin/ralph-hero/mcp-server/src/index.ts plugin/ralph-hero/mcp-server/src/__tests__/decompose-tools.test.ts
git commit -m "feat: add decompose_feature MCP tool for cross-repo feature splitting"
```

---

### Task 6: `setup-repos` Skill

**Files:**
- Create: `plugin/ralph-hero/skills/setup-repos/SKILL.md`

**Step 1: Write the skill definition**

```markdown
---
name: setup-repos
description: Bootstrap .ralph-repos.yml by analyzing linked repositories. Use when setting up multi-repo management or adding new repos to an existing registry.
user_invocable: true
---

# Setup Repos

Generate or update `.ralph-repos.yml` by analyzing the project's linked repositories.

## Workflow

### Step 1: Discover linked repos

Call `ralph_hero__get_project` to get the project details and linked repositories.

If no repos are linked, tell the user to link repos first via GitHub UI or `link_repository` tool, then retry.

### Step 2: Analyze repos in parallel

For each linked repo, spawn a parallel sub-agent (type: `Explore`) that:

1. Reads the repo's README.md via `mcp__plugin_github_github__get_file_contents`
2. Reads package.json, Cargo.toml, go.mod, pyproject.toml, or similar manifest
3. Lists the top-level directory structure
4. Returns structured JSON:
   ```json
   {
     "repo": "repo-name",
     "owner": "org-name",
     "domain": "inferred domain description",
     "tech": ["typescript", "react"],
     "keyPaths": ["src/components/", "src/pages/"],
     "suggestedLabels": ["frontend", "ui"]
   }
   ```

### Step 3: Check for existing registry

Read the current `.ralph-repos.yml` if it exists (via `mcp__plugin_github_github__get_file_contents`).

- If it exists: present a diff showing what would be added/changed. Preserve all hand-edits for existing repos.
- If it doesn't exist: generate a fresh registry.

### Step 4: Synthesize and propose

Combine all repo analyses into a draft `.ralph-repos.yml`:

- Set `version: 1`
- For each repo: `domain`, `tech`, `paths`, and suggested `defaults`
- Propose 1-3 decomposition patterns based on detected repo relationships:
  - If repos span frontend/backend/infra → suggest "full-stack" pattern
  - If repos share API contracts → suggest "api-feature" pattern
  - Flag low-confidence inferences with "# TODO: verify" comments

Present the full YAML to the user. Ask: "Does this look right? I can adjust any section before writing."

### Step 5: Write and commit

After user approval:

1. Write `.ralph-repos.yml` to the project's primary repo
2. Commit with message: `chore: add repo registry (.ralph-repos.yml)`
3. Push if user confirms

## Constraints

- This skill is INTERACTIVE — always present the draft for user review
- Never overwrite existing hand-edits without showing the diff first
- Pattern suggestions are best-effort — always marked as suggestions
- If a repo's README is empty or missing, use directory structure and manifest files for inference
- Limit analysis to 15 repos maximum (warn if more are linked)
```

**Step 2: Commit**

```bash
git add plugin/ralph-hero/skills/setup-repos/SKILL.md
git commit -m "feat: add setup-repos skill for bootstrapping repo registry"
```

---

### Task 7: Build and Verify

**Step 1: Build the TypeScript project**

Run: `cd plugin/ralph-hero/mcp-server && npm run build`
Expected: Clean compile, no errors

**Step 2: Run the full test suite**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: All tests pass

**Step 3: Verify the build output includes new files**

Run: `ls plugin/ralph-hero/mcp-server/dist/lib/repo-registry.js plugin/ralph-hero/mcp-server/dist/lib/registry-loader.js plugin/ralph-hero/mcp-server/dist/tools/decompose-tools.js`
Expected: All three files exist

**Step 4: Commit build verification**

No commit needed — build artifacts are gitignored.

---

## Implementation Order Summary

| Task | What | Dependencies | Risk |
|------|------|-------------|------|
| 1 | Repo registry types + parser | None | Low — pure functions |
| 2 | Registry loading at startup | Task 1 | Medium — startup order change |
| 3 | create_issue registry defaults | Tasks 1, 2 | Low — additive change |
| 4 | Dashboard groupBy repo | None (parallel with 2-3) | Low — pure function + param |
| 5 | decompose_feature tool | Tasks 1, 2 | Medium — new tool with mutations |
| 6 | setup-repos skill | Tasks 1, 5 | Low — skill definition only |
| 7 | Build + verify | All | Low — verification step |

Tasks 1 and 4 can run in parallel. Tasks 2-3 are sequential. Task 5 depends on 1-2. Task 6 is independent (skill, no code).
