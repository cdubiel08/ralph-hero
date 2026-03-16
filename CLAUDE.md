# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Claude Code plugin providing autonomous GitHub Projects V2 workflow automation. The MCP server is published to npm as `ralph-hero-mcp-server` and consumed via `npx` in `.mcp.json`. The `dist/` directory is not committed to git.

## Build & Test

All commands run from `plugin/ralph-hero/mcp-server/`:

```bash
npm install          # Install dependencies
npm run build        # TypeScript -> dist/ (tsc)
npm test             # Run full test suite (vitest)
npx vitest run src/__tests__/cache.test.ts           # Run a single test file
npx vitest run -t "should invalidate"                # Run tests matching a name pattern
```

**ralph-knowledge plugin** (from `plugin/ralph-knowledge/`):
```bash
npm install && npm run build && npm test
```

No linter is configured. TypeScript strict mode is the primary code quality gate.

## CI/CD

**PR checks** (`ci.yml`): Build + test across Node 18, 20, 22 for all three plugins (hero, knowledge, demo).

**Auto-release** (`release.yml`): Merges to `main` that touch MCP server source auto-bump version in both `mcp-server/package.json` and `.claude-plugin/plugin.json`, tag, and publish to npm with provenance. Include `#minor` or `#major` in a commit message for larger bumps.

**Do NOT** run `npm publish` manually or push `v*` tags manually — the release workflow handles both.

## Architecture

### Three-Plugin System

```
plugin/
├── ralph-hero/              # Main plugin — MCP server, skills, agents, hooks
│   ├── mcp-server/          # TypeScript MCP server (published as ralph-hero-mcp-server)
│   ├── skills/              # 30+ skill definitions (YAML frontmatter + markdown)
│   ├── agents/              # 10 agent definitions
│   ├── hooks/               # 50+ lifecycle enforcement hooks
│   └── scripts/             # CLI and automation scripts
├── ralph-knowledge/         # Semantic search over thoughts/ documents
│   └── src/                 # Hono MCP server, SQLite + sqlite-vec embeddings
└── ralph-demo/              # Sprint demo video generation (Remotion)
    └── remotion/            # React-based video compositing (pnpm)
```

### MCP Server Internals

**Entry point**: `src/index.ts` — resolves environment, creates `GitHubClient`, registers all tool modules, connects stdio transport.

**Tool registration pattern** — each module exports a `registerXyzTools()` function:
```typescript
export function registerIssueTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  server.tool("ralph_hero__tool_name", "description", {
    param: z.string().describe("..."),
  }, async (params) => {
    return toolSuccess(result); // or toolError(message)
  });
}
```

All tool names use the `ralph_hero__` prefix. Use `toolSuccess()` and `toolError()` from `types.ts` for responses.

**Tool modules** (in `src/tools/`):

| Module | Key tools |
|--------|-----------|
| `issue-tools.ts` | list_issues, get_issue, create_issue, save_issue |
| `project-tools.ts` | setup_project, get_project |
| `relationship-tools.ts` | add_sub_issue, add_dependency, advance_issue |
| `batch-tools.ts` | batch_update |
| `dashboard-tools.ts` | pipeline_dashboard, detect_stream_positions |
| `project-management-tools.ts` | archive_items, create_status_update |
| `hygiene-tools.ts` | pick_actionable_issue, project_hygiene |
| `decompose-tools.ts` | decompose_feature |
| `debug-tools.ts` | debug tools (only registered when RALPH_DEBUG=true) |

**GitHub client** (`github-client.ts`): Wraps `@octokit/graphql` with dual endpoints — `query()`/`mutate()` for repo operations, `projectQuery()`/`projectMutate()` for project operations (may use a separate token). Auto-injects `rateLimit` fragments into non-mutation queries.

**Lib modules** (in `src/lib/`):

| Module | Purpose |
|--------|---------|
| `workflow-states.ts` | State machine definitions, ordering, validation |
| `cache.ts` | SessionCache (API responses) + FieldOptionCache (field metadata) |
| `helpers.ts` | Config resolution, field cache ensure, node ID lookup, status sync, parent auto-advance |
| `rate-limiter.ts` | Proactive rate limit tracking (warn at 100, block at 50 remaining) |
| `pipeline-detection.ts` | Phase detection for orchestrators |
| `group-detection.ts` | Parent-child group analysis |
| `dashboard.ts` | Pipeline aggregation, health scoring |
| `repo-registry.ts` | Multi-repo YAML registry types |

### Workflow State Machine

```
Backlog → Research Needed → Research in Progress → Ready for Plan
       → Plan in Progress → Plan in Review → In Progress → In Review → Done
```

Key state categories defined in `workflow-states.ts`:
- **Terminal**: Done, Canceled
- **Lock states**: Research in Progress, Plan in Progress, In Progress (exclusive claim)
- **Parent gate states**: Ready for Plan, Plan in Review, In Review, Done (trigger parent advancement)

`save_issue` automatically syncs the Status field (Todo/In Progress/Done) based on `WORKFLOW_STATE_TO_STATUS` mapping when setting `workflowState`. The sync is best-effort and one-way.

### Caching Strategy

Two separate caches serve different purposes:
- **`SessionCache`**: API response cache keyed with `query:` prefix + stable node ID lookups (`issue-node-id:*`, `project-item-id:*`). Mutations invalidate `query:` entries only — node ID lookups are stable.
- **`FieldOptionCache`**: In-memory project field option IDs, populated by `fetchProjectForCache()`. Multi-project aware (keyed by project number).

## Key Implementation Gotchas

- **`@octokit/graphql` v9 reserves `query`, `method`, and `url`** as option keys. Never use these as GraphQL variable names.
- **ESM module system**: All internal imports require `.js` extensions (e.g., `import { foo } from "./bar.js"`). The project uses `"type": "module"` with `"module": "NodeNext"`.
- **`resolveEnv()` pattern**: Claude Code passes unexpanded `${VAR}` literals for unset env vars in `.mcp.json`. The `resolveEnv()` function in `index.ts` filters these out. Only non-sensitive defaults with fallbacks belong in `.mcp.json`.
- **Split-owner support**: Repo and project can have different owners. `resolveProjectOwner()` handles this. `fetchProjectForCache()` tries both `user` and `organization` GraphQL types.
- **Aliased GraphQL mutations**: Bulk operations (like `batch_update`) use GraphQL aliases (`m0:`, `m1:`, ...) to batch multiple mutations in a single request.
- **mcptools args normalization**: `index.ts` patches `validateToolInput` to normalize `undefined` args to `{}` because mcptools 0.7.1 strips empty `{}` params.

## Environment Variables

Set in `.claude/settings.local.json` (gitignored) under `"env"`:

| Variable | Required | Description |
|----------|----------|-------------|
| `RALPH_HERO_GITHUB_TOKEN` | **Yes** | GitHub PAT with `repo` + `project` scopes |
| `RALPH_GH_OWNER` | Yes | GitHub owner (user or org) |
| `RALPH_GH_PROJECT_NUMBER` | Yes | GitHub Projects V2 number |
| `RALPH_GH_REPO` | No | Repository name (inferred from project if omitted) |
| `RALPH_GH_PROJECT_NUMBERS` | No | Comma-separated project numbers for cross-project dashboard |
| `RALPH_GH_REPO_TOKEN` | No | Separate repo token (falls back to main token) |
| `RALPH_GH_PROJECT_TOKEN` | No | Separate project token (falls back to repo token) |
| `RALPH_GH_PROJECT_OWNER` | No | Project owner if different from repo owner |
| `RALPH_DEBUG` | No | Set to `"true"` to enable JSONL debug logging and register debug tools |

**Do NOT put tokens in `.mcp.json`** — the `env` block can overwrite inherited values with unexpanded `${VAR}` literals.

## GitHub Actions Workflows

Beyond CI/CD, several workflows automate project board management:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `route-issues.yml` | Issue opened | Route new issues to project board |
| `sync-issue-state.yml` | Issue state change | Sync GitHub issue state with project workflow |
| `sync-pr-merge.yml` | PR merged | Move linked issues to Done |
| `sync-project-state.yml` | Project field change | Sync project state back to issues |
| `advance-parent.yml` | Sub-issue state change | Auto-advance parent when children reach gate states |
