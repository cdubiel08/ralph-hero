---
date: 2026-02-26
topic: "Multi-Repo Enterprise Project Management in Ralph Hero"
tags: [research, codebase, multi-repo, multi-project, enterprise, configuration, cross-project]
status: complete
type: research
git_commit: b821a06260e9bbd265d975b2a06fe4d5f445e53e
---

# Research: Multi-Repo Enterprise Project Management in Ralph Hero

## Research Question
How does ralph-hero currently handle multiple repositories, what are the limitations, and what improvements could support enterprise workflows with many repos across a single GitHub Projects V2 board?

## Summary

Ralph Hero already has substantial multi-project and split-owner infrastructure. It supports multiple GitHub Projects V2 boards via `RALPH_GH_PROJECT_NUMBERS`, per-call `projectNumber` overrides on all tools, cross-project dashboard aggregation, cross-project state sync, repo inference from linked projects, dual-token authentication (repo vs project), and split-owner support (repo owner != project owner). However, its **multi-repo** story within a single project is more limited — the system defaults to a single repo and requires explicit `RALPH_GH_REPO` when multiple repos are linked.

## Detailed Findings

### What Exists Today

#### 1. Repository Resolution Chain
- **Environment variables**: `RALPH_GH_OWNER` + `RALPH_GH_REPO` set the default repo ([index.ts:71-72](https://github.com/cdubiel08/ralph-hero/blob/b821a06/plugin/ralph-hero/mcp-server/src/index.ts#L71-L72))
- **Repo inference**: When `RALPH_GH_REPO` is unset, the server queries the project's linked repos at startup ([helpers.ts:420-456](https://github.com/cdubiel08/ralph-hero/blob/b821a06/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L420-L456))
  - 1 linked repo → auto-inferred, written to `client.config.repo`
  - 0 linked repos → error with bootstrap instructions
  - 2+ linked repos → error listing repos, asks user to set `RALPH_GH_REPO`
- **Per-call override**: All tools accept optional `owner` and `repo` parameters that override defaults ([helpers.ts:462-501](https://github.com/cdubiel08/ralph-hero/blob/b821a06/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L462-L501))

#### 2. Multi-Project Support
- **`RALPH_GH_PROJECT_NUMBERS`**: Comma-separated list parsed at startup ([index.ts:77-82](https://github.com/cdubiel08/ralph-hero/blob/b821a06/plugin/ralph-hero/mcp-server/src/index.ts#L77-L82))
- **`resolveProjectNumbers()`**: Normalizes single vs multi config ([types.ts:285-289](https://github.com/cdubiel08/ralph-hero/blob/b821a06/plugin/ralph-hero/mcp-server/src/types.ts#L285-L289))
- **`pipeline_dashboard`**: Aggregates items across all configured projects, with per-project breakdowns and cross-project health warnings ([dashboard-tools.ts:351-407](https://github.com/cdubiel08/ralph-hero/blob/b821a06/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts#L351-L407))
- **Per-call `projectNumber` override**: Every project-aware tool accepts this parameter

#### 3. Split-Owner Support
- **`RALPH_GH_PROJECT_OWNER`**: Separate from `RALPH_GH_OWNER` for org project + personal repo scenarios ([types.ts:275-279](https://github.com/cdubiel08/ralph-hero/blob/b821a06/plugin/ralph-hero/mcp-server/src/types.ts#L275-L279))
- **User/org fallback**: Both `fetchProjectForCache` and `queryProjectRepositories` try `user` then `organization` GraphQL types

#### 4. Dual-Token Authentication
- **`RALPH_GH_REPO_TOKEN`**: For repository operations (issues, PRs, comments) — falls back to `RALPH_HERO_GITHUB_TOKEN`
- **`RALPH_GH_PROJECT_TOKEN`**: For Projects V2 operations (fields, workflow state) — falls back to repo token
- Allows different PAT scopes for different operation types

#### 5. Cross-Project Sync
- **`sync_across_projects` tool**: Discovers all projects an issue belongs to via `projectItems` query, syncs workflow state across all of them ([sync-tools.ts:202-363](https://github.com/cdubiel08/ralph-hero/blob/b821a06/plugin/ralph-hero/mcp-server/src/tools/sync-tools.ts#L202-L363))
- **Audit trail**: Adds marker comments to prevent duplicate sync audits

#### 6. Repository Linking
- **`link_repository` tool**: Links/unlinks repos to projects, accepts `owner/name` or just `name` format ([project-management-tools.ts:280-371](https://github.com/cdubiel08/ralph-hero/blob/b821a06/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L280-L371))
- **`copy_project` tool**: Supports cross-owner copy with `sourceOwner`/`targetOwner` parameters

#### 7. Routing Rules
- **`configure_routing` tool**: Supports optional `repo` field in match conditions ([routing-tools.ts:20-70](https://github.com/cdubiel08/ralph-hero/blob/b821a06/plugin/ralph-hero/mcp-server/src/tools/routing-tools.ts#L20-L70))
- Rules can match on specific repos, enabling repo-aware automation

#### 8. Caching Architecture
- **`FieldOptionCache`**: Keyed by project number — supports multiple projects simultaneously ([cache.ts:110-233](https://github.com/cdubiel08/ralph-hero/blob/b821a06/plugin/ralph-hero/mcp-server/src/lib/cache.ts#L110-L233))
- **`SessionCache`**: Issue node IDs keyed as `issue-node-id:owner/repo#number` — naturally supports cross-repo lookups
- **`query:` prefix entries**: Invalidated on mutations; node ID lookups are stable

### Current Limitations for Multi-Repo Enterprise Use

#### L1: Single Default Repo
The system resolves to exactly one `client.config.repo` at startup. When a project has multiple linked repos, the user must pick one as the default. Tools like `create_issue` default to this single repo — creating issues in other repos requires passing `repo` explicitly on each call.

#### L2: No Repo-Aware List Filtering
`list_issues` queries by project items (via project number), not by repository. There's no built-in filter to say "show me all project items from repo X". The dashboard also aggregates by project, not by repo within a project.

#### L3: No Per-Repo Configuration Profiles
Enterprise teams with repos like `frontend`, `backend`, `infra` can't define repo-specific defaults (labels, workflow states, assignees). Each tool call must specify these manually.

#### L4: Inference Fails at 2+ Repos
The `resolveRepoFromProject` function throws when 2+ repos are linked. In enterprise setups, projects almost always span multiple repos. The current "pick one" approach doesn't scale.

#### L5: Single MCP Server Instance per Config
`.mcp.json` configures one server instance with one set of env vars. Running ralph-hero against multiple orgs or GitHub Enterprise instances requires separate plugin installations or manual env var switching.

## Code References

- `plugin/ralph-hero/mcp-server/src/index.ts:33-122` — Environment variable resolution and client init
- `plugin/ralph-hero/mcp-server/src/types.ts:264-289` — `GitHubClientConfig` interface and `resolveProjectNumbers()`
- `plugin/ralph-hero/mcp-server/src/lib/helpers.ts:346-501` — Repo inference, config resolution helpers
- `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts:244-470` — Multi-project dashboard aggregation
- `plugin/ralph-hero/mcp-server/src/tools/sync-tools.ts:202-363` — Cross-project state sync
- `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts:280-371` — Repository linking
- `plugin/ralph-hero/mcp-server/src/tools/routing-tools.ts:20-70` — Repo-aware routing rules
- `plugin/ralph-hero/mcp-server/src/lib/cache.ts:110-233` — Multi-project field option cache

## Architecture Documentation

### Configuration Hierarchy
```
Environment Variables (settings.local.json)
  └─ initGitHubClient() reads all RALPH_GH_* vars
       └─ GitHubClientConfig { owner, repo, projectNumber, projectNumbers, projectOwner }
            ├─ resolveRepoFromProject() — infers repo if unset (startup)
            ├─ resolveConfig() — per-call resolution (tool arg > env default)
            ├─ resolveFullConfig() — adds project resolution
            └─ resolveProjectNumbers() — normalizes single/multi project
```

### Token Routing
```
RALPH_HERO_GITHUB_TOKEN (base)
  ├─ RALPH_GH_REPO_TOKEN → client.query(), client.mutate()  (repo ops)
  └─ RALPH_GH_PROJECT_TOKEN → client.projectQuery(), client.projectMutate()  (project ops)
```

### Multi-Project Data Flow
```
RALPH_GH_PROJECT_NUMBERS="3,5,7"
  └─ pipeline_dashboard
       ├─ For each project: ensureFieldCache() → paginateConnection() → toDashboardItems()
       ├─ Merge all items → buildDashboard()
       ├─ Per-project breakdown (when 2+ projects)
       └─ detectCrossProjectHealth() → unbalanced_workload warnings
```

## Historical Context (from thoughts/)

27 documents found spanning the full multi-project architecture:
- **GH-0023**: Original multi-repo support research (`2026-02-16`)
- **GH-0144/0145/0150**: Multi-project config, cache, and dashboard design (`2026-02-20`)
- **GH-0151**: Project number override implementation across all tools (`2026-02-20`)
- **GH-0180/0199**: Cross-project sync and audit trail (`2026-02-20`)
- **GH-0152**: Multi-project documentation (`2026-02-21`)
- **GH-224**: Repo inference wiring (`2026-02-20`)

## Open Questions

1. **Repo-scoped listing**: Should `list_issues` support a `repo` filter to show only items from a specific repository within a project?
2. **Multi-repo inference**: Should the system support a "primary repo" concept when multiple repos are linked, rather than erroring?
3. **Per-repo config profiles**: Would a `.ralph-repos.yml` or similar config that maps repo names to default labels/workflow states/assignees be useful?
4. **Multi-instance support**: Should the plugin support multiple MCP server instances in `.mcp.json` for different GitHub orgs or GHES instances?
5. **Dashboard repo dimension**: Should `pipeline_dashboard` support grouping by repository in addition to by project?
