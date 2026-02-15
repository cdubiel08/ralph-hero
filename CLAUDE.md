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

### Publishing

```bash
cd plugin/ralph-hero/mcp-server
npm publish          # Builds automatically via prepublishOnly, then publishes
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
