# Ralph Hero Plugin

Claude Code plugin providing autonomous GitHub Projects V2 workflow automation.

## Structure

```
ralph-hero/
├── plugin/ralph-hero/           # Plugin root (CLAUDE_PLUGIN_ROOT)
│   ├── .claude-plugin/plugin.json  # Plugin manifest
│   ├── .mcp.json                   # MCP server config
│   ├── .gitignore
│   ├── agents/                     # Agent definitions
│   ├── hooks/                      # Lifecycle hooks
│   ├── scripts/                    # Shell scripts (ralph-loop, ralph-team-loop)
│   ├── skills/                     # Skill definitions
│   └── mcp-server/                 # TypeScript MCP server
│       ├── src/                    # Source code
│       │   ├── index.ts            # Server entrypoint
│       │   ├── github-client.ts    # GraphQL client with rate limiting & caching
│       │   ├── types.ts            # Shared types
│       │   ├── lib/                # Cache, pagination, rate limiter, group detection
│       │   ├── tools/              # MCP tool implementations
│       │   │   ├── issue-tools.ts  # Issue CRUD + workflow state + estimates
│       │   │   ├── project-tools.ts
│       │   │   ├── project-management-tools.ts  # Archive, remove, add, link, clear
│       │   │   ├── relationship-tools.ts
│       │   │   └── view-tools.ts
│       │   └── __tests__/          # Vitest tests
│       ├── dist/                   # Compiled JS (gitignored, published to npm)
│       ├── package.json
│       └── tsconfig.json
└── thoughts/                    # Research docs, plans, decisions
```

## MCP Server Distribution

The MCP server is published to npm as `ralph-hero-mcp-server` and consumed via `npx` in `.mcp.json`. This follows the standard MCP ecosystem pattern used by official servers (`@modelcontextprotocol/server-*`) and plugins (Firebase, Context7).

The `dist/` directory is **not** committed to git. It is built and published via `npm publish` (the `prepublishOnly` script runs `tsc` automatically).

## Development

### Build & Test

```bash
cd plugin/ralph-hero/mcp-server
npm install          # Install dependencies
npm run build        # Build TypeScript -> dist/
npm test             # Run tests (vitest)
```

### CI/CD

**PR checks** (`ci.yml`): Every PR to `main` runs build + test across Node 18, 20, and 22.

**Auto-release** (`release.yml`): Merges to `main` that touch MCP server source, `package.json`, or `plugin.json` automatically:
1. Build and test
2. Bump versions in both `mcp-server/package.json` and `.claude-plugin/plugin.json`
3. Commit, tag, and push
4. Publish to npm with provenance

Version bump defaults to **patch**. Include `#minor` or `#major` in a commit message for larger bumps. Manual releases are available via `workflow_dispatch` in the GitHub Actions UI.

**Do NOT run `npm publish` manually** — the release workflow handles it. Do NOT push `v*` tags manually — the workflow creates them.

### Environment Variables

Set these in `.claude/settings.local.json` (recommended, gitignored):

```json
{
  "env": {
    "RALPH_HERO_GITHUB_TOKEN": "ghp_xxx",
    "RALPH_GH_OWNER": "cdubiel08",
    "RALPH_GH_REPO": "ralph-hero",
    "RALPH_GH_PROJECT_NUMBER": "3"
  }
}
```

**Do NOT put tokens in `.mcp.json`** — the `env` block can overwrite inherited values with unexpanded `${VAR}` literals, preventing the MCP server from starting. Only non-sensitive defaults with fallbacks belong in `.mcp.json` (e.g., `${RALPH_GH_OWNER:-cdubiel08}`).

| Variable | Required | Where to set | Description |
|----------|----------|-------------|-------------|
| `RALPH_HERO_GITHUB_TOKEN` | **Yes** | `settings.local.json` | GitHub PAT with `repo` + `project` scopes |
| `RALPH_GH_OWNER` | Yes | `settings.local.json` or `.mcp.json` default | GitHub owner (user or org) |
| `RALPH_GH_REPO` | No† | `settings.local.json` or `.mcp.json` default | Repository name (inferred from project if omitted) |
| `RALPH_GH_PROJECT_NUMBER` | Yes | `settings.local.json` or `.mcp.json` default | GitHub Projects V2 number |
| `RALPH_GH_REPO_TOKEN` | No | `settings.local.json` | Separate repo token (falls back to `RALPH_HERO_GITHUB_TOKEN`) |
| `RALPH_GH_PROJECT_TOKEN` | No | `settings.local.json` | Separate project token (falls back to repo token) |
| `RALPH_GH_PROJECT_OWNER` | No | `settings.local.json` | Project owner if different from repo owner |

†`RALPH_GH_REPO` is inferred from the repositories linked to the project via `link_repository`. Only set it explicitly as a tiebreaker when multiple repos are linked. Bootstrap: `setup_project` → `link_repository` → repo is inferred. See #23.

### Key Implementation Details

- **`@octokit/graphql` v9 reserves `query`, `method`, and `url`** as option keys. Never use these as GraphQL variable names.
- **`SessionCache` vs `FieldOptionCache`**: `SessionCache` stores API response caches (keyed with `query:` prefix) and stable node ID lookups (`issue-node-id:*`, `project-item-id:*`). `FieldOptionCache` is a separate in-memory structure for project field option IDs. Mutations invalidate `query:` prefixed entries only — node ID lookups are stable across mutations.
- **Split-owner support**: Repo and project can have different owners (e.g., personal repo with org project). `resolveProjectOwner()` handles this. `fetchProjectForCache()` tries both `user` and `organization` GraphQL types.
- **Rate limiting**: Every non-mutation query auto-injects a `rateLimit` fragment for proactive tracking. The `RateLimiter` class tracks remaining quota and pauses before requests when low.
- **Status sync (one-way)**: `update_workflow_state` automatically syncs the default Status field (Todo/In Progress/Done) based on `WORKFLOW_STATE_TO_STATUS` mapping in `workflow-states.ts`. The sync is best-effort: if the Status field is missing or has custom options, the sync silently skips. Mapping: queue states -> Todo, lock/active states -> In Progress, terminal states -> Done. `batch_update` and `advance_children` also sync Status.
- **Project management tools**: 5 tools in `project-management-tools.ts` for project operations: `archive_item`, `remove_from_project`, `add_to_project`, `link_repository`, `clear_field`. See `thoughts/shared/research/2026-02-18-GH-0066-github-projects-v2-docs-guidance.md` for full tool reference and setup guide.
