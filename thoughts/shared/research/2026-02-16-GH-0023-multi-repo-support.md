---
date: 2026-02-16
github_issue: 23
github_url: https://github.com/cdubiel08/ralph-hero/issues/23
status: complete
type: research
---

# Research: GH-23 - Multi-Repository Support for Cross-Repo Project Management

## Problem Statement

The ralph-hero MCP server is hardcoded to a single `RALPH_GH_OWNER/RALPH_GH_REPO` pair. Teams that split work across multiple repositories (frontend/backend/infra) but use one GitHub Projects V2 board cannot manage issues across repos. The issue proposes three options: multi-repo env config, per-call repo specification, and auto-detection from the project.

## Current State Analysis

### Configuration Architecture

**Environment variables** ([.mcp.json](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/.mcp.json)):
- `RALPH_GH_OWNER` — single default owner
- `RALPH_GH_REPO` — single default repo
- `RALPH_GH_PROJECT_NUMBER` — single project number
- `RALPH_GH_PROJECT_OWNER` — optional separate project owner

**Client config** ([types.ts:263-270](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L263-L270)):
```typescript
interface GitHubClientConfig {
  token: string;
  projectToken?: string;
  owner?: string;         // Single default
  repo?: string;          // Single default
  projectNumber?: number;
  projectOwner?: string;
}
```

**Config resolution** ([issue-tools.ts:329-364](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L329-L364)):
- `resolveConfig()` — falls back from `args.owner/repo` → `client.config.owner/repo` → error
- `resolveFullConfig()` — adds projectNumber and projectOwner resolution
- Every tool already accepts optional `owner` and `repo` parameters

### What Already Supports Multi-Repo

The foundation is surprisingly strong:

| Feature | Status | Details |
|---------|--------|---------|
| Per-tool owner/repo override | **Works** | Every tool accepts optional `owner`/`repo` params |
| Cache key isolation | **Works** | Keys include owner/repo: `issue-node-id:${owner}/${repo}#${number}` |
| Dual-token support | **Works** | Separate repo and project tokens ([github-client.ts:84-94](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/github-client.ts#L84-L94)) |
| Split-owner support | **Works** | `resolveProjectOwner()` handles repo owner ≠ project owner |
| Project-level queries | **Works** | `list_project_items`, `get_project` don't assume a repo |
| `addProjectV2ItemById` | **Works** | Cross-repo by design — accepts any issue node ID |
| Field updates | **Works** | `updateProjectV2ItemFieldValue` uses project item ID, not repo |

### What Does NOT Support Multi-Repo

**11 GraphQL queries hardcode `repository(owner:, name:)`:**

| File | Function | Impact |
|------|----------|--------|
| [issue-tools.ts:131](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L131) | `resolveIssueNodeId()` | Node ID resolution |
| [issue-tools.ts:670](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L670) | `get_issue` | Single issue fetch |
| [issue-tools.ts:925](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L925) | `create_issue` | Get repo ID |
| [issue-tools.ts:947](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L947) | `create_issue` | Resolve label IDs |
| [issue-tools.ts:1144](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1144) | `update_issue` | Resolve label IDs |
| [relationship-tools.ts:41](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L41) | `resolveIssueNodeId()` | Node ID resolution (duplicate) |
| [relationship-tools.ts:212](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L212) | `list_sub_issues` | Sub-issue listing |
| [relationship-tools.ts:470](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L470) | `list_dependencies` | Dependency listing |
| [relationship-tools.ts:634](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L634) | `advance_children` | Sub-issue fetch |
| [group-detection.ts:46](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/group-detection.ts#L46) | `SEED_QUERY` | Group detection seed |
| [group-detection.ts:90](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/group-detection.ts#L90) | `EXPAND_QUERY` | Group expansion |

These queries all pass `owner`/`repo` as variables, so they **already work with any repo** — the issue is that the owner/repo values come from a single default.

**FieldOptionCache is single-project** ([cache.ts:100-189](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts#L100-L189)):
- Stores one project's field definitions
- `populate()` replaces all cached data
- Multi-project would need per-project caching

**Group detection silently skips cross-repo issues** ([group-detection.ts:338-343](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/group-detection.ts)):
- Dependencies pointing to issues in different repos fail silently
- Logs: `"Could not fetch issue #N, skipping (may be cross-repo)"`
- Results in incomplete groups

**`list_project_items` doesn't return repo info** ([project-tools.ts:436-489](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L436-L489)):
- Queries issue number, title, state, url but NOT `repository { nameWithOwner }`
- Cannot distinguish issue #5 in repo-A from issue #5 in repo-B

### Skill and Agent Assumptions

All skill files construct GitHub URLs with `$RALPH_GH_OWNER/$RALPH_GH_REPO`:
- Research docs: `thoughts/shared/research/YYYY-MM-DD-GH-NNNN-*.md`
- Plan docs: `thoughts/shared/plans/YYYY-MM-DD-*.md`
- Review docs: `thoughts/shared/reviews/YYYY-MM-DD-*.md`
- GitHub link format: `https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/...`

Scripts (`ralph-loop.sh`, `ralph-team-loop.sh`) invoke skills without repo context — they rely on environment defaults.

## Key Discoveries

### 1. GitHub Projects V2 Natively Supports Multi-Repo

A single GitHub Projects V2 board can contain issues from **any repository** the authenticated user has access to. Key GraphQL capabilities:

**Discover linked repos:**
```graphql
node(id: "PROJECT_ID") {
  ... on ProjectV2 { repositories(first: 100) { nodes { nameWithOwner } } }
}
```

**Get repo from project item content:**
```graphql
items(first: 100) {
  nodes {
    content {
      ... on Issue { number title repository { nameWithOwner owner { login } } }
    }
  }
}
```

**Built-in Repository field type:**
```graphql
fieldValues { nodes {
  ... on ProjectV2ItemFieldRepositoryValue { repository { nameWithOwner } }
}}
```

The `addProjectV2ItemById` mutation already works cross-repo — it accepts any issue node ID regardless of source repo.

### 2. No Token Changes Needed

A single classic PAT with `repo` + `project` scopes covers all repos the user can access. The existing dual-token architecture (repo token vs project token) already handles the case where project ownership differs from repo ownership. No additional tokens are needed for multi-repo.

### 3. Per-Tool Override Already Works (Option B from the Issue)

Every MCP tool already accepts optional `owner` and `repo` params. An agent can call:
```json
{ "tool": "ralph_hero__get_issue", "params": { "owner": "org", "repo": "backend-api", "number": 42 } }
```
And it works today — cache keys, GraphQL variables, and node ID resolution all include owner/repo.

### 4. Auto-Detection from Project Is Feasible (Option C)

The `ProjectV2.repositories` connection and `content.repository` field on project items enable auto-detection of which repos are linked to the project. A new tool like `ralph_hero__list_project_repos` could expose this.

### 5. Issue Number Disambiguation Is the Core Challenge

Currently, tools accept issue numbers without repo context. In a multi-repo project:
- Issue #5 in `frontend-app` ≠ Issue #5 in `backend-api`
- Cache keys already handle this (`issue-node-id:owner/repo#5`)
- But agent prompts, skill files, and user interfaces all use bare `#5` references

## Potential Approaches

### Approach A: Minimal — Enhance `list_project_items` + Document Per-Call Overrides

Add `repository { nameWithOwner }` to the `list_project_items` query so agents can discover which repo an item belongs to. Document that tools already support per-call `owner`/`repo` overrides.

**Pros:**
- Smallest change — one GraphQL query modification
- No breaking changes
- Agents already know how to pass owner/repo
- Works today for explicit cross-repo operations

**Cons:**
- Skills still assume single repo for artifact paths and URLs
- Group detection still incomplete for cross-repo dependencies
- No repo auto-discovery — agent must know which repos to target

### Approach B: Add `list_project_repos` + Enrich Project Item Queries (Recommended for Phase 1)

Add a new `ralph_hero__list_project_repos` tool that returns all repos linked to the project. Enhance `list_project_items` and `list_issues` to include source repo info.

**Pros:**
- Auto-discovery: agent can query which repos are in the project
- Issue disambiguation: agents see `owner/repo` alongside issue numbers
- Foundation for deeper multi-repo features
- Non-breaking — additive changes only

**Cons:**
- Doesn't fix skill-level single-repo assumptions
- Group detection still single-repo
- Skills still construct paths/URLs with single owner/repo

### Approach C: Full Multi-Repo Config (`RALPH_GH_REPOS` env var)

Add a comma-separated repo list env var. Tools iterate across repos when no specific repo is provided.

**Pros:**
- Transparent multi-repo for all tools
- No per-call overrides needed
- Skills automatically work with multiple repos

**Cons:**
- Major refactor — every tool needs iteration logic
- API point cost multiplied by repo count
- Complex cache invalidation (which repo's cache to clear?)
- Rate limit pressure (N repos × M operations)
- Over-engineering for current use case

### Approach D: Cross-Repo Group Detection

Extend `detectGroup()` to follow dependencies across repos by resolving issue node IDs from different repos.

**Pros:**
- Enables atomic multi-repo workflows
- Groups can span repos (e.g., frontend issue depends on backend issue)

**Cons:**
- Highest complexity — need repo context for every issue in the group
- N+1 query risk (each cross-repo reference needs separate resolution)
- Topological sort becomes repo-aware

### Recommendation

**Phase 1**: Approach B — Add `list_project_repos` tool and enrich `list_project_items` with repo info. This provides the foundation for agents to operate cross-repo using existing per-call overrides.

**Phase 2**: Fix skill artifact paths to include repo context in filenames (e.g., `GH-0023-backend-api-description.md` instead of just `GH-0023-description.md`).

**Phase 3**: Approach D — Cross-repo group detection for teams that need atomic multi-repo workflows.

**Defer**: Approach C (`RALPH_GH_REPOS` env var) — over-engineering for current needs.

## Implementation Considerations

### New Tool: `ralph_hero__list_project_repos`

```typescript
Input: { owner?, number? }
Output: {
  projectId: string,
  repos: Array<{
    owner: string,
    repo: string,
    nameWithOwner: string,
    issueCount: number,
  }>,
  totalRepos: number,
}
```

GraphQL:
```graphql
query($owner: String!, $number: Int!) {
  user(login: $owner) {  // or organization
    projectV2(number: $number) {
      id
      repositories(first: 100) {
        totalCount
        nodes { nameWithOwner name owner { login } }
      }
    }
  }
}
```

### Enhanced `list_project_items` Response

Add to the existing query ([project-tools.ts:446-457](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L446-L457)):

```graphql
content {
  ... on Issue {
    repository { nameWithOwner name owner { login } }
    # ... existing fields
  }
}
```

Return format changes:
```typescript
{
  number: 42,
  title: "Fix login bug",
  owner: "cdubiel08",     // NEW
  repo: "frontend-app",   // NEW
  nameWithOwner: "cdubiel08/frontend-app",  // NEW
  // ... existing fields
}
```

### FieldOptionCache Multi-Project Support

Current: single `projectId` + flat field maps.

Needed: keyed by project ID:
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

This is needed if supporting multiple projects. For multi-repo on a **single project**, the current cache works fine — all repos share the same project fields.

### Cross-Repo Group Detection (Phase 3)

To resolve cross-repo dependencies in `detectGroup()`:
1. When expanding a dependency, check if the target issue exists in the current repo
2. If not found, check the project for an item with that number from a different repo
3. Use the project item's `content.repository` to determine the correct repo
4. Fetch the issue from the correct repo

This adds ~1-2 extra API calls per cross-repo dependency but enables complete group detection.

### Skill Artifact Path Changes

Current: `thoughts/shared/research/2026-02-16-GH-0023-description.md`

Multi-repo: `thoughts/shared/research/2026-02-16-GH-0023-ralph-hero-description.md`

Or: `thoughts/shared/research/ralph-hero/2026-02-16-GH-0023-description.md`

The repo name in the filename/path prevents collisions when the same issue number exists in multiple repos.

## Risks and Considerations

1. **Estimate accuracy**: This is estimated as XL. Research confirms it — full multi-repo support touches 11+ GraphQL queries, the cache layer, group detection, all 5 skill files, agent definitions, and scripts. Recommend splitting into 3-4 sub-issues by phase.

2. **API point budget**: Multi-repo operations multiply API calls. Listing issues across 3 repos costs 3x points. Rate limiter needs awareness of multi-repo cost.

3. **Issue number ambiguity**: Bare `#42` references become ambiguous. All user-facing output needs `owner/repo#42` format. This is a pervasive change across skills and comments.

4. **Group detection complexity**: Cross-repo groups are O(repos × issues) instead of O(issues). For most projects (2-3 repos), this is manageable. For 10+ repos, it may hit rate limits.

5. **Artifact storage**: Research/plan/review documents currently live in the ralph-hero repo. Multi-repo needs a decision: store artifacts in the target repo, in a central docs repo, or in the ralph-hero plugin repo?

6. **Breaking changes**: Phase 1 (Approach B) is additive — no breaking changes. Phase 2+ may change artifact paths and comment formats.

7. **Fine-grained PAT limitation**: GitHub fine-grained PATs cannot access user-owned Projects V2. Classic PATs are required. This is a GitHub platform limitation, not a ralph-hero issue.

## Recommended Next Steps

1. **Split this XL issue** into phased sub-issues:
   - Phase 1 (S): Add `list_project_repos` tool + enrich `list_project_items` with repo info
   - Phase 2 (M): Update skill artifact paths and comment formats for repo disambiguation
   - Phase 3 (L): Cross-repo group detection and dependency traversal
   - Phase 4 (S): Multi-repo aware scripts and hooks

2. **Implement Phase 1 first** — it's additive, non-breaking, and enables agents to discover and operate on multi-repo projects using existing per-call overrides

3. **Validate with a real multi-repo project** — create a test project with items from 2 repos and verify Phase 1 tools work correctly
