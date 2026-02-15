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
│       │   │   ├── relationship-tools.ts
│       │   │   └── view-tools.ts
│       │   └── __tests__/          # Vitest tests
│       ├── dist/                   # Compiled JS (COMMITTED — see below)
│       ├── package.json
│       └── tsconfig.json
└── thoughts/                    # Research docs, plans, decisions
```

## Critical: dist/ Must Be Committed

Claude Code does **not** run `npm install` or build steps during plugin installation. It copies the plugin directory as-is. If `dist/` is missing, the MCP server silently fails to start and no tools are available.

**After ANY change to MCP server source (`src/`), you MUST:**

```bash
cd plugin/ralph-hero/mcp-server
npx tsc
git add dist/
```

The `.gitignore` excludes `dist/__tests__/` and sourcemaps to keep the repo clean — only runtime `.js` and `.d.ts` files are tracked.

## Development

### Build & Test

```bash
cd plugin/ralph-hero/mcp-server
npm install          # Install dependencies
npx tsc              # Build TypeScript -> dist/
npx vitest run       # Run tests (21 tests)
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RALPH_GH_REPO_TOKEN` | Yes | GitHub token for repo operations |
| `RALPH_GH_PROJECT_TOKEN` | No | Separate token for project operations (falls back to repo token) |
| `RALPH_HERO_GITHUB_TOKEN` | No | Legacy token variable |
| `RALPH_GH_OWNER` | Yes | GitHub owner (user or org) |
| `RALPH_GH_REPO` | Yes | Repository name |
| `RALPH_GH_PROJECT_OWNER` | No | Project owner if different from repo owner |
| `RALPH_GH_PROJECT_NUMBER` | Yes | GitHub Projects V2 number |

### Key Implementation Details

- **`@octokit/graphql` v9 reserves `query`, `method`, and `url`** as option keys. Never use these as GraphQL variable names.
- **`SessionCache` vs `FieldOptionCache`**: `SessionCache` stores API response caches (keyed with `query:` prefix) and stable node ID lookups (`issue-node-id:*`, `project-item-id:*`). `FieldOptionCache` is a separate in-memory structure for project field option IDs. Mutations invalidate `query:` prefixed entries only — node ID lookups are stable across mutations.
- **Split-owner support**: Repo and project can have different owners (e.g., personal repo with org project). `resolveProjectOwner()` handles this. `fetchProjectForCache()` tries both `user` and `organization` GraphQL types.
- **Rate limiting**: Every non-mutation query auto-injects a `rateLimit` fragment for proactive tracking. The `RateLimiter` class tracks remaining quota and pauses before requests when low.
