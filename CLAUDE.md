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

**Do NOT run `npm publish` manually.** Publishing is handled by the GitHub Actions CD workflow (see #12). The workflow triggers on version tag pushes (`v*`), builds the TypeScript, and publishes to npm using the `NPM_TOKEN` repository secret.

To release a new version:

1. Bump version in `plugin/ralph-hero/mcp-server/package.json`
2. Bump version in `plugin/ralph-hero/.claude-plugin/plugin.json`
3. Commit, push, and merge to main
4. Tag and push: `git tag v1.3.0 && git push origin v1.3.0`
5. CD workflow builds and publishes automatically

**Note**: If CI (#12) is not yet set up, you can publish manually with `npm publish` from `plugin/ralph-hero/mcp-server/` — but you must run `npm login` first as npm tokens expire.

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
| `RALPH_GH_REPO` | Yes | `settings.local.json` or `.mcp.json` default | Repository name |
| `RALPH_GH_PROJECT_NUMBER` | Yes | `settings.local.json` or `.mcp.json` default | GitHub Projects V2 number |
| `RALPH_GH_REPO_TOKEN` | No | `settings.local.json` | Separate repo token (falls back to `RALPH_HERO_GITHUB_TOKEN`) |
| `RALPH_GH_PROJECT_TOKEN` | No | `settings.local.json` | Separate project token (falls back to repo token) |
| `RALPH_GH_PROJECT_OWNER` | No | `settings.local.json` | Project owner if different from repo owner |

### Key Implementation Details

- **`@octokit/graphql` v9 reserves `query`, `method`, and `url`** as option keys. Never use these as GraphQL variable names.
- **`SessionCache` vs `FieldOptionCache`**: `SessionCache` stores API response caches (keyed with `query:` prefix) and stable node ID lookups (`issue-node-id:*`, `project-item-id:*`). `FieldOptionCache` is a separate in-memory structure for project field option IDs. Mutations invalidate `query:` prefixed entries only — node ID lookups are stable across mutations.
- **Split-owner support**: Repo and project can have different owners (e.g., personal repo with org project). `resolveProjectOwner()` handles this. `fetchProjectForCache()` tries both `user` and `organization` GraphQL types.
- **Rate limiting**: Every non-mutation query auto-injects a `rateLimit` fragment for proactive tracking. The `RateLimiter` class tracks remaining quota and pauses before requests when low.
