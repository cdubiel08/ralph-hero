---
type: plan
date: 2026-03-05
status: draft
github_issues: [539]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/539
primary_issue: 539
---

# Cross-Repo Dependency Tooling Implementation Plan

## Overview

Enhance Ralph's dependency tools to support cross-repository blocking relationships, add dependency querying, integrate blocking into `decompose_feature`, and make group-detection cross-repo aware. GitHub's GraphQL API uses globally unique node IDs for `addBlockedBy`/`removeBlockedBy`, which inherently supports cross-repo — our tools just need to stop assuming same-repo.

## Current State Analysis

**Working:**
- `add_dependency` / `remove_dependency` create/remove blocking relationships within a single repo
- `decompose_feature` creates cross-repo issues and attempts `addSubIssue` wiring for dependency-flow edges
- `group-detection` performs transitive closure over sub-issues + dependencies with topological sort
- `blocking`/`blockedBy` GraphQL fields are queried in group-detection seed/expand queries

**Broken/Missing:**
- `add_dependency` forces both issues to same `owner/repo` (`relationship-tools.ts:357`)
- `remove_dependency` has same limitation (`relationship-tools.ts:429`)
- `decompose_feature` wires dependency-flow as `addSubIssue` (parent/child) instead of `addBlockedBy` — conceptually wrong for ordering dependencies (`decompose-tools.ts:464-475`)
- No `list_dependencies` tool — can't query what blocks or is blocked by an issue
- Group-detection `EXPAND_QUERY` fetches by `owner/repo/number` — cross-repo deps silently skipped (`group-detection.ts:310-343`)
- Group-detection `blocking`/`blockedBy` nodes don't include `repository { nameWithOwner }` — can't resolve cross-repo issues (`group-detection.ts:63-64, 74-75, 78-83`)

### Key API Details (from research)
- `AddBlockedByInput`: `issueId: ID!`, `blockingIssueId: ID!` — globally unique node IDs, cross-repo works
- `RemoveBlockedByInput`: `issueId: ID!`, `blockingIssueId: ID!` (our code uses this field name and works)
- `blocking(first: N)` / `blockedBy(first: N)` on Issue return `IssueConnection` — can select `repository { nameWithOwner }` on each node for cross-repo visibility
- Limit: 50 blocking + 50 blockedBy per issue
- EMU users get `FORBIDDEN` crossing enterprise boundaries (out of our control)
- Not available on GHES — github.com only

## Desired End State

After this plan:
1. `add_dependency` and `remove_dependency` accept separate owner/repo for blocked and blocking issues
2. New `list_dependencies` tool queries an issue's blocking/blockedBy with full repo context
3. `decompose_feature` wires `addBlockedBy` for dependency-flow edges (in addition to optional sub-issue parent/child wiring)
4. Group-detection follows cross-repo dependencies in its transitive closure, using `repository { nameWithOwner }` from blocking/blockedBy nodes
5. All changes are backward-compatible — existing single-repo usage works unchanged

### Verification:
- All existing tests continue to pass
- New tests cover cross-repo add/remove/list dependency scenarios
- `decompose_feature` tests verify blockedBy wiring
- Group-detection tests verify cross-repo expansion

## What We're NOT Doing

- **Cross-repo sub-issue wiring in `decompose_feature`** — the existing `addSubIssue` wiring is removed from dependency-flow; sub-issue relationships are a separate concern from blocking dependencies
- **Dashboard cross-repo dependency visualization** — querying `blockedBy` on every project item would be too expensive; defer to a future `dependency_graph` tool
- **REST API alternative** — sticking with GraphQL for consistency with existing tools
- **GHES compatibility** — feature is github.com only, no detection needed for now
- **`IssueDependenciesSummary` integration** — useful but not needed for core cross-repo wiring

## Implementation Approach

Each tool change is additive — new optional parameters with backward-compatible defaults. The key insight is that GitHub's `addBlockedBy` already works cross-repo since it uses node IDs; we just need to resolve those node IDs from potentially different repos.

---

## Phase 1: Cross-Repo `add_dependency` / `remove_dependency`

### Overview
Add separate owner/repo parameters for blocked and blocking issues. When not provided, fall back to the shared `owner`/`repo` (backward-compatible).

### Changes Required:

#### 1. `relationship-tools.ts` — `add_dependency`
**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`
**Lines**: 332-407
**Changes**: Add `blockedOwner`, `blockedRepo`, `blockingOwner`, `blockingRepo` optional params. Resolve each issue's node ID from its own owner/repo.

```typescript
server.tool(
  "ralph_hero__add_dependency",
  "Create a blocking dependency between two GitHub issues. Supports cross-repo: " +
    "the blocked and blocking issues can be in different repositories. " +
    "The 'blockingNumber' issue blocks the 'blockedNumber' issue.",
  {
    owner: z
      .string()
      .optional()
      .describe("Default GitHub owner for both issues. Defaults to GITHUB_OWNER env var"),
    repo: z
      .string()
      .optional()
      .describe("Default repository for both issues. Defaults to GITHUB_REPO env var"),
    blockedNumber: z
      .number()
      .describe("Issue number that IS blocked (cannot proceed until blocker is done)"),
    blockedOwner: z
      .string()
      .optional()
      .describe("GitHub owner for the blocked issue. Defaults to 'owner' param"),
    blockedRepo: z
      .string()
      .optional()
      .describe("Repository for the blocked issue. Defaults to 'repo' param"),
    blockingNumber: z
      .number()
      .describe("Issue number that IS the blocker (must be completed first)"),
    blockingOwner: z
      .string()
      .optional()
      .describe("GitHub owner for the blocking issue. Defaults to 'owner' param"),
    blockingRepo: z
      .string()
      .optional()
      .describe("Repository for the blocking issue. Defaults to 'repo' param"),
  },
  async (args) => {
    try {
      const { owner, repo } = resolveConfig(client, args);

      const bOwner = args.blockedOwner || owner;
      const bRepo = args.blockedRepo || repo;
      const kOwner = args.blockingOwner || owner;
      const kRepo = args.blockingRepo || repo;

      const blockedId = await resolveIssueNodeId(client, bOwner, bRepo, args.blockedNumber);
      const blockingId = await resolveIssueNodeId(client, kOwner, kRepo, args.blockingNumber);

      const result = await client.mutate<{
        addBlockedBy: {
          issue: { id: string; number: number; title: string; repository: { nameWithOwner: string } };
          blockingIssue: { id: string; number: number; title: string; repository: { nameWithOwner: string } };
        };
      }>(
        `mutation($blockedId: ID!, $blockingId: ID!) {
          addBlockedBy(input: {
            issueId: $blockedId,
            blockingIssueId: $blockingId
          }) {
            issue { id number title repository { nameWithOwner } }
            blockingIssue { id number title repository { nameWithOwner } }
          }
        }`,
        { blockedId, blockingId },
      );

      return toolSuccess({
        blocked: {
          id: result.addBlockedBy.issue.id,
          number: result.addBlockedBy.issue.number,
          title: result.addBlockedBy.issue.title,
          repository: result.addBlockedBy.issue.repository.nameWithOwner,
        },
        blocking: {
          id: result.addBlockedBy.blockingIssue.id,
          number: result.addBlockedBy.blockingIssue.number,
          title: result.addBlockedBy.blockingIssue.title,
          repository: result.addBlockedBy.blockingIssue.repository.nameWithOwner,
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError(`Failed to add dependency: ${message}`);
    }
  },
);
```

#### 2. `relationship-tools.ts` — `remove_dependency`
**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`
**Lines**: 410-479
**Changes**: Same pattern — add `blockedOwner`, `blockedRepo`, `blockingOwner`, `blockingRepo` optional params.

```typescript
server.tool(
  "ralph_hero__remove_dependency",
  "Remove a blocking dependency between two GitHub issues. Supports cross-repo: " +
    "the blocked and blocking issues can be in different repositories.",
  {
    owner: z
      .string()
      .optional()
      .describe("Default GitHub owner for both issues. Defaults to GITHUB_OWNER env var"),
    repo: z
      .string()
      .optional()
      .describe("Default repository for both issues. Defaults to GITHUB_REPO env var"),
    blockedNumber: z.coerce.number().describe("Issue number that was blocked"),
    blockedOwner: z
      .string()
      .optional()
      .describe("GitHub owner for the blocked issue. Defaults to 'owner' param"),
    blockedRepo: z
      .string()
      .optional()
      .describe("Repository for the blocked issue. Defaults to 'repo' param"),
    blockingNumber: z.coerce.number().describe("Issue number that was the blocker"),
    blockingOwner: z
      .string()
      .optional()
      .describe("GitHub owner for the blocking issue. Defaults to 'owner' param"),
    blockingRepo: z
      .string()
      .optional()
      .describe("Repository for the blocking issue. Defaults to 'repo' param"),
  },
  async (args) => {
    try {
      const { owner, repo } = resolveConfig(client, args);

      const bOwner = args.blockedOwner || owner;
      const bRepo = args.blockedRepo || repo;
      const kOwner = args.blockingOwner || owner;
      const kRepo = args.blockingRepo || repo;

      const blockedId = await resolveIssueNodeId(client, bOwner, bRepo, args.blockedNumber);
      const blockingId = await resolveIssueNodeId(client, kOwner, kRepo, args.blockingNumber);

      const result = await client.mutate<{
        removeBlockedBy: {
          issue: { id: string; number: number; title: string; repository: { nameWithOwner: string } };
          blockingIssue: { id: string; number: number; title: string; repository: { nameWithOwner: string } };
        };
      }>(
        `mutation($blockedId: ID!, $blockingId: ID!) {
          removeBlockedBy(input: {
            issueId: $blockedId,
            blockingIssueId: $blockingId
          }) {
            issue { id number title repository { nameWithOwner } }
            blockingIssue { id number title repository { nameWithOwner } }
          }
        }`,
        { blockedId, blockingId },
      );

      return toolSuccess({
        blocked: {
          id: result.removeBlockedBy.issue.id,
          number: result.removeBlockedBy.issue.number,
          title: result.removeBlockedBy.issue.title,
          repository: result.removeBlockedBy.issue.repository.nameWithOwner,
        },
        blocking: {
          id: result.removeBlockedBy.blockingIssue.id,
          number: result.removeBlockedBy.blockingIssue.number,
          title: result.removeBlockedBy.blockingIssue.title,
          repository: result.removeBlockedBy.blockingIssue.repository.nameWithOwner,
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError(`Failed to remove dependency: ${message}`);
    }
  },
);
```

### Success Criteria:

#### Automated Verification:
- [ ] `npm run build` passes
- [ ] Existing relationship tool tests still pass
- [ ] New tests verify cross-repo param resolution (separate owner/repo for each side)
- [ ] New tests verify backward compat (shared owner/repo still works)

#### Manual Verification:
- [ ] Call `add_dependency` with issues in two different repos — verify relationship created
- [ ] Call `remove_dependency` with cross-repo issues — verify relationship removed
- [ ] Call `add_dependency` with only `owner`/`repo` (no per-side overrides) — verify backward compat

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Add `list_dependencies` Tool

### Overview
New tool that queries an issue's `blocking` and `blockedBy` connections, returning full cross-repo context including repository name for each linked issue.

### Changes Required:

#### 1. `relationship-tools.ts` — new `list_dependencies` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`
**Location**: After the `remove_dependency` tool (after line 479), before `advance_issue`
**Changes**: Add new tool registration

```typescript
// -------------------------------------------------------------------------
// ralph_hero__list_dependencies
// -------------------------------------------------------------------------
server.tool(
  "ralph_hero__list_dependencies",
  "List all blocking dependencies for a GitHub issue. Returns both 'blocking' " +
    "(issues this issue blocks) and 'blockedBy' (issues blocking this issue) " +
    "with full cross-repo context including repository name.",
  {
    owner: z
      .string()
      .optional()
      .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
    repo: z
      .string()
      .optional()
      .describe("Repository name. Defaults to GITHUB_REPO env var"),
    number: z.coerce.number().describe("Issue number to query dependencies for"),
  },
  async (args) => {
    try {
      const { owner, repo } = resolveConfig(client, args);

      const result = await client.query<{
        repository: {
          issue: {
            id: string;
            number: number;
            title: string;
            state: string;
            blocking: {
              nodes: Array<{
                id: string;
                number: number;
                title: string;
                state: string;
                repository: { nameWithOwner: string };
              }>;
            };
            blockedBy: {
              nodes: Array<{
                id: string;
                number: number;
                title: string;
                state: string;
                repository: { nameWithOwner: string };
              }>;
            };
          } | null;
        } | null;
      }>(
        `query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            issue(number: $number) {
              id
              number
              title
              state
              blocking(first: 50) {
                nodes {
                  id number title state
                  repository { nameWithOwner }
                }
              }
              blockedBy(first: 50) {
                nodes {
                  id number title state
                  repository { nameWithOwner }
                }
              }
            }
          }
        }`,
        { owner, repo, number: args.number },
      );

      const issue = result.repository?.issue;
      if (!issue) {
        return toolError(`Issue #${args.number} not found in ${owner}/${repo}`);
      }

      return toolSuccess({
        issue: {
          id: issue.id,
          number: issue.number,
          title: issue.title,
          state: issue.state,
          repository: `${owner}/${repo}`,
        },
        blocking: issue.blocking.nodes.map((n) => ({
          id: n.id,
          number: n.number,
          title: n.title,
          state: n.state,
          repository: n.repository.nameWithOwner,
        })),
        blockedBy: issue.blockedBy.nodes.map((n) => ({
          id: n.id,
          number: n.number,
          title: n.title,
          state: n.state,
          repository: n.repository.nameWithOwner,
        })),
        summary: {
          blockingCount: issue.blocking.nodes.length,
          blockedByCount: issue.blockedBy.nodes.length,
          isBlocked: issue.blockedBy.nodes.length > 0,
          isBlocking: issue.blocking.nodes.length > 0,
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError(`Failed to list dependencies: ${message}`);
    }
  },
);
```

### Success Criteria:

#### Automated Verification:
- [ ] `npm run build` passes
- [ ] New test verifies response shape with mocked blocking/blockedBy data
- [ ] New test verifies cross-repo repository info in response
- [ ] New test verifies empty dependencies (no blocking, no blockedBy)

#### Manual Verification:
- [ ] Call `list_dependencies` on an issue with known blocking relationships — verify correct output
- [ ] Call `list_dependencies` on an issue blocked by a cross-repo issue — verify `repository` field shows other repo

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation.

---

## Phase 3: Enhance `decompose_feature` Dependency Wiring

### Overview
Replace the `addSubIssue` wiring for dependency-flow edges with `addBlockedBy`. The dependency-flow in `.ralph-repos.yml` represents execution ordering (A must finish before B), which maps to blocking relationships, not parent/child. The existing `addSubIssue` approach was a workaround; now that we know `addBlockedBy` works cross-repo, use it properly.

### Changes Required:

#### 1. `decompose-tools.ts` — Wire `addBlockedBy` for dependency-flow
**File**: `plugin/ralph-hero/mcp-server/src/tools/decompose-tools.ts`
**Lines**: 430-486
**Changes**: Replace `addSubIssue` with `addBlockedBy`. The edge `"api -> frontend"` means api must finish before frontend can start, so frontend is blocked by api.

```typescript
// Step 5: Wire dependencies (addBlockedBy for dependency-flow edges)
// Parse "a -> b" edges: a blocks b (b is blocked by a)
const wiringResults: Array<{
  edge: string;
  type: "blockedBy";
  status: "ok" | "skipped";
  reason?: string;
}> = [];

for (const edge of decomposition.dependency_chain) {
  const match = edge.match(/^\s*(\S+)\s*->\s*(\S+)\s*$/);
  if (!match) {
    wiringResults.push({
      edge,
      type: "blockedBy",
      status: "skipped",
      reason: "Unrecognized edge format (expected 'a -> b')",
    });
    continue;
  }

  const [, blockingRepo, blockedRepo] = match;
  const blockingIssue = createdIssues.find((i) => i.repoKey === blockingRepo);
  const blockedIssue = createdIssues.find((i) => i.repoKey === blockedRepo);

  if (!blockingIssue || !blockedIssue) {
    wiringResults.push({
      edge,
      type: "blockedBy",
      status: "skipped",
      reason: `Could not find created issue for repo "${blockingRepo}" or "${blockedRepo}"`,
    });
    continue;
  }

  try {
    await client.mutate(
      `mutation($blockedId: ID!, $blockingId: ID!) {
        addBlockedBy(input: {
          issueId: $blockedId,
          blockingIssueId: $blockingId
        }) {
          issue { id }
          blockingIssue { id }
        }
      }`,
      { blockedId: blockedIssue.id, blockingId: blockingIssue.id },
    );
    wiringResults.push({ edge, type: "blockedBy", status: "ok" });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    wiringResults.push({
      edge,
      type: "blockedBy",
      status: "skipped",
      reason: `addBlockedBy failed: ${reason}`,
    });
  }
}
```

#### 2. Update `DecompositionResult` type — reflect blockedBy wiring
**File**: `plugin/ralph-hero/mcp-server/src/tools/decompose-tools.ts`
**Lines**: 56-62
**Changes**: Update the `dependency_chain` doc comment to clarify these are blocking edges, not sub-issue relationships.

No type change needed — `dependency_chain: string[]` is still correct. Just update the JSDoc:

```typescript
export interface DecompositionResult {
  proposed_issues: ProposedIssue[];
  /** Blocking dependency edges from the pattern, e.g. ["api -> frontend"] meaning api blocks frontend */
  dependency_chain: string[];
  /** The canonical pattern name used (from registry, case-preserved) */
  matched_pattern: string;
}
```

### Success Criteria:

#### Automated Verification:
- [ ] `npm run build` passes
- [ ] Existing `decompose-tools.test.ts` tests pass (dry-run tests are unaffected)
- [ ] New test: verify `addBlockedBy` mutation is called (not `addSubIssue`) for dependency-flow edges when `dryRun=false`
- [ ] New test: verify edge `"api -> frontend"` wires `blockedId=frontendIssue.id, blockingId=apiIssue.id`

#### Manual Verification:
- [ ] Run `decompose_feature` with `dryRun=false` on a real pattern — verify blocking relationships appear on created issues
- [ ] Verify `dependency_wiring` in response shows `type: "blockedBy"` and `status: "ok"` for each edge

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation.

---

## Phase 4: Cross-Repo Group Detection

### Overview
Enhance the group-detection algorithm to follow cross-repo dependencies. Currently, when a blocking/blockedBy node points to an issue in a different repo, it's silently skipped because the expand query uses the seed issue's `owner/repo`. Fix: include `repository { owner { login } name }` in dependency nodes and expand using the correct owner/repo.

### Changes Required:

#### 1. `group-detection.ts` — Add `repository` to blocking/blockedBy nodes in queries
**File**: `plugin/ralph-hero/mcp-server/src/lib/group-detection.ts`
**Lines**: 45-86 (SEED_QUERY), 89-130 (EXPAND_QUERY)
**Changes**: Add `repository { owner { login } name }` to all `blocking`/`blockedBy` nodes. This allows us to resolve the correct owner/repo for cross-repo expansion.

Updated SEED_QUERY (changes apply to both SEED_QUERY and EXPAND_QUERY):

```typescript
const SEED_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      id
      number
      title
      state
      parent {
        id
        number
        title
        state
        subIssues(first: 50) {
          nodes {
            id
            number
            title
            state
            blocking(first: 20) { nodes { number repository { owner { login } name } } }
            blockedBy(first: 20) { nodes { number repository { owner { login } name } } }
          }
        }
      }
      subIssues(first: 50) {
        nodes {
          id
          number
          title
          state
          blocking(first: 20) { nodes { number repository { owner { login } name } } }
          blockedBy(first: 20) { nodes { number repository { owner { login } name } } }
        }
      }
      blocking(first: 20) {
        nodes { id number title state repository { owner { login } name } }
      }
      blockedBy(first: 20) {
        nodes { id number title state repository { owner { login } name } }
      }
    }
  }
}`;
```

#### 2. `group-detection.ts` — Update types for cross-repo nodes
**File**: `plugin/ralph-hero/mcp-server/src/lib/group-detection.ts`
**Lines**: 30-39 (IssueRelationData), 136-164 (SeedIssueNode, SeedIssueResponse)
**Changes**: Add `repoOwner`/`repoName` fields to `IssueRelationData`. Update `SeedIssueNode` to include repo info on dependency nodes.

```typescript
interface IssueRelationData {
  id: string;
  number: number;
  title: string;
  state: string;
  repoOwner: string;  // NEW: owner for cross-repo expansion
  repoName: string;   // NEW: repo name for cross-repo expansion
  parentNumber: number | null;
  subIssueNumbers: number[];
  blockingNumbers: number[];
  blockedByNumbers: number[];
}
```

```typescript
interface SeedIssueNode {
  id: string;
  number: number;
  title: string;
  state: string;
  blocking?: { nodes: Array<{ number: number; repository?: { owner: { login: string }; name: string } }> };
  blockedBy?: { nodes: Array<{ number: number; repository?: { owner: { login: string }; name: string } }> };
}
```

#### 3. `group-detection.ts` — Use per-issue owner/repo for expand queries
**File**: `plugin/ralph-hero/mcp-server/src/lib/group-detection.ts`
**Lines**: 300-344 (expand loop)
**Changes**: When expanding a dependency target, look up its `repoOwner`/`repoName` from the dependency node's `repository` field. If not found (same-repo dependency), fall back to seed owner/repo.

Store cross-repo info during seed processing:

```typescript
// When processing blocking/blockedBy nodes that have repository info:
const depRepoInfo = new Map<number, { owner: string; repo: string }>();

// During seed processing, for each blocking/blockedBy node:
for (const dep of seedIssue.blocking.nodes) {
  if (dep.repository) {
    depRepoInfo.set(dep.number, {
      owner: dep.repository.owner.login,
      repo: dep.repository.name,
    });
  }
  // ... existing addIssueToMap + expandQueue logic
}
```

Then in the expand loop:

```typescript
while (expandQueue.length > 0) {
  const num = expandQueue.shift()!;
  if (expanded.has(num) || issueMap.has(num)) {
    if (issueMap.has(num)) expanded.add(num);
    continue;
  }
  expanded.add(num);

  // Resolve owner/repo for this issue — check cross-repo info first
  const crossRepoInfo = depRepoInfo.get(num);
  const expandOwner = crossRepoInfo?.owner ?? owner;
  const expandRepo = crossRepoInfo?.repo ?? repo;

  try {
    const expandResult = await client.query<{
      repository: { issue: SeedIssueResponse | null } | null;
    }>(EXPAND_QUERY, { owner: expandOwner, repo: expandRepo, number: num });

    const expandedIssue = expandResult.repository?.issue;
    if (!expandedIssue) continue;

    addIssueToMap(issueMap, {
      id: expandedIssue.id,
      number: expandedIssue.number,
      title: expandedIssue.title,
      state: expandedIssue.state,
      repoOwner: expandOwner,
      repoName: expandRepo,
      parentNumber: expandedIssue.parent?.number ?? null,
      subIssueNumbers: expandedIssue.subIssues.nodes.map((n) => n.number),
      blockingNumbers: expandedIssue.blocking.nodes.map((n) => n.number),
      blockedByNumbers: expandedIssue.blockedBy.nodes.map((n) => n.number),
    });

    // Store cross-repo info from expanded issue's dependency nodes
    for (const dep of [...expandedIssue.blocking.nodes, ...expandedIssue.blockedBy.nodes]) {
      if (dep.repository) {
        depRepoInfo.set(dep.number, {
          owner: dep.repository.owner.login,
          repo: dep.repository.name,
        });
      }
    }

    // Queue new dependency targets
    for (const depNum of [
      ...expandedIssue.blocking.nodes.map((n) => n.number),
      ...expandedIssue.blockedBy.nodes.map((n) => n.number),
    ]) {
      if (!issueMap.has(depNum) && !expanded.has(depNum)) {
        expandQueue.push(depNum);
      }
    }
  } catch {
    console.error(
      `[group-detection] Could not fetch issue #${num} from ${expandOwner}/${expandRepo}, skipping`,
    );
  }
}
```

#### 4. `group-detection.ts` — Update `addIssueToMap` for new fields
**File**: `plugin/ralph-hero/mcp-server/src/lib/group-detection.ts`
**Lines**: 387-413
**Changes**: Handle `repoOwner`/`repoName` in merge logic.

```typescript
function addIssueToMap(
  map: Map<number, IssueRelationData>,
  data: IssueRelationData,
): void {
  const existing = map.get(data.number);
  if (existing) {
    // ... existing merge logic ...
    // Add: prefer non-empty repoOwner/repoName
    if (!existing.repoOwner && data.repoOwner) existing.repoOwner = data.repoOwner;
    if (!existing.repoName && data.repoName) existing.repoName = data.repoName;
  } else {
    map.set(data.number, { ...data });
  }
}
```

#### 5. `group-detection.ts` — Update `GroupIssue` to include repo info
**File**: `plugin/ralph-hero/mcp-server/src/lib/group-detection.ts`
**Lines**: 15-22
**Changes**: Add optional `repository` field to `GroupIssue` for downstream consumers.

```typescript
export interface GroupIssue {
  id: string;
  number: number;
  title: string;
  state: string;
  order: number;
  repository?: string; // "owner/repo" — present for cross-repo issues
}
```

Update the result builder (line 354-363):

```typescript
const groupTickets: GroupIssue[] = sorted.map((num, index) => {
  const issue = issueMap.get(num)!;
  const result: GroupIssue = {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    order: index + 1,
  };
  // Include repository only for cross-repo issues
  if (issue.repoOwner !== owner || issue.repoName !== repo) {
    result.repository = `${issue.repoOwner}/${issue.repoName}`;
  }
  return result;
});
```

#### 6. All callers of `addIssueToMap` — pass `repoOwner`/`repoName`
**File**: `plugin/ralph-hero/mcp-server/src/lib/group-detection.ts`
**Changes**: Every call to `addIssueToMap` in `detectGroup()` needs `repoOwner` and `repoName`. For the seed issue and its same-repo relatives, these are simply the `owner`/`repo` params. For cross-repo deps, use the `repository` field from the GraphQL response.

### Success Criteria:

#### Automated Verification:
- [ ] `npm run build` passes
- [ ] Existing group-detection tests pass (they mock same-repo data — should work unchanged)
- [ ] New test: mock a seed issue with a `blockedBy` node pointing to a different repo — verify the expand query uses the correct owner/repo
- [ ] New test: verify `GroupIssue.repository` is populated for cross-repo issues
- [ ] New test: verify topological sort still works correctly with mixed same-repo and cross-repo issues

#### Manual Verification:
- [ ] Use `decompose_feature` to create cross-repo issues with blocking deps, then trigger group detection — verify the full dependency graph is discovered
- [ ] Verify cross-repo issues appear in the topologically sorted group with correct `repository` field

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation.

---

## Phase 5: Tests

### Overview
Comprehensive test coverage for all changes. Tests use vitest mocks for the GitHubClient — no real API calls.

### Changes Required:

#### 1. New test file: `cross-repo-dependencies.test.ts`
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/cross-repo-dependencies.test.ts`

Test cases:

**add_dependency cross-repo:**
- `blockedOwner`/`blockedRepo` resolve independently from `blockingOwner`/`blockingRepo`
- Backward compat: omitting per-side params uses shared `owner`/`repo`
- Error: blocked issue not found in specified repo

**remove_dependency cross-repo:**
- Same pattern as add_dependency tests

**list_dependencies:**
- Returns blocking and blockedBy with repository info
- Empty lists for issue with no dependencies
- Cross-repo issues show correct `repository` field

#### 2. Updates to `decompose-tools.test.ts`
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/decompose-tools.test.ts`
**Changes**: Add test for `dryRun=false` verifying `addBlockedBy` is called instead of `addSubIssue`

#### 3. Updates to group-detection tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/group-detection.test.ts` (or existing test file)
**Changes**: Add test for cross-repo dependency expansion

### Success Criteria:

#### Automated Verification:
- [ ] All tests pass: `npm test`
- [ ] No linting errors: `npm run build`
- [ ] Test coverage includes: cross-repo add/remove dependency, list dependencies, decompose wiring, group detection expansion

---

## Testing Strategy

### Unit Tests:
- Mock `GitHubClient.query()` and `GitHubClient.mutate()` to verify correct GraphQL queries and variables
- Test `resolveIssueNodeId` is called with correct per-side owner/repo
- Test `buildDecomposition` pure function (already tested, no changes needed)
- Test `addIssueToMap` merges `repoOwner`/`repoName` correctly
- Test topological sort with cross-repo nodes

### Integration Tests:
- End-to-end flow: `decompose_feature` with `dryRun=false` creates issues, wires `addBlockedBy`, returns correct `dependency_wiring`
- Group detection from a seed with cross-repo blocking — verify full transitive closure

### Manual Testing Steps:
1. Create two issues in different repos
2. Use `add_dependency` with cross-repo params — verify blocking relationship in GitHub UI
3. Use `list_dependencies` — verify both sides shown with correct repos
4. Use `remove_dependency` — verify relationship removed
5. Use `decompose_feature` with real pattern — verify blocking deps wired
6. Trigger group detection on a decomposed feature — verify cross-repo graph

## Performance Considerations

- Group-detection cross-repo expansion adds N-1 additional API calls for N cross-repo dependency targets (one expand query per unknown repo). This is bounded by the 50-per-relationship limit.
- `decompose_feature` wiring adds one `addBlockedBy` mutation per dependency-flow edge (typically 1-3 edges per pattern). No batching available in GitHub API.
- `list_dependencies` is a single query — no performance concern.

## References

- GitHub GraphQL API: `addBlockedBy`/`removeBlockedBy` mutations — [Mutations reference](https://docs.github.com/en/graphql/reference/mutations)
- GitHub issue dependencies GA: [Dependencies on Issues changelog](https://github.blog/changelog/2025-08-21-dependencies-on-issues/)
- `AddBlockedByInput`: `issueId: ID!`, `blockingIssueId: ID!` — [Input objects reference](https://docs.github.com/en/graphql/reference/input-objects)
- Cross-repo confirmed in [Public Preview Feedback discussion](https://github.com/orgs/community/discussions/165749)
- Current code: `relationship-tools.ts`, `decompose-tools.ts`, `group-detection.ts`
