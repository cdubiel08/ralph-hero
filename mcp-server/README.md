# ralph-hero-mcp-server

MCP server for GitHub Projects V2 — the workflow-automation engine behind the [Ralph](https://github.com/cdubiel08/ralph-hero) Claude Code plugin.

## What it is

`ralph-hero-mcp-server` exposes [GitHub Projects V2](https://docs.github.com/en/issues/planning-and-tracking-with-projects) as a set of [Model Context Protocol](https://modelcontextprotocol.io/) tools, so an agent (Claude Code) can read and drive an issue through a workflow state machine — `Backlog → Research Needed → … → In Review → Done` — entirely through typed tool calls instead of shelling out to `gh`.

It is bundled and consumed by the `ralph` Claude Code plugin (the skills call these tools), but it is a standalone stdio MCP server and can be wired into any MCP client.

## Install

The server is published to npm and is normally run via `npx` from an MCP client config (`.mcp.json`):

```json
{
  "mcpServers": {
    "ralph-github": {
      "command": "npx",
      "args": ["-y", "ralph-hero-mcp-server"]
    }
  }
}
```

All tools are namespaced with the `ralph_hero__` prefix (e.g. `ralph_hero__get_issue`, `ralph_hero__save_issue`, `ralph_hero__next_actions`).

## Configuration

Configuration flows through the parent process's environment (the `.mcp.json` has **no** `env` block — do not put tokens there).

| Variable | Required | Description |
|----------|----------|-------------|
| `RALPH_GH_OWNER` | Yes | GitHub owner (user or org). |
| `RALPH_GH_PROJECT_NUMBER` | Yes | GitHub Projects V2 number. |
| `RALPH_GH_REPO` | No | Repository name (inferred from the project if omitted). |
| `RALPH_HERO_GITHUB_TOKEN` | No | GitHub PAT with `repo` + `project` scopes. **Falls back to `gh auth token`** when unset — so with `gh auth login -s repo,project,read:org` you usually need no token in any config. |
| `RALPH_GH_PROJECT_OWNER` | No | Project owner, if different from the repo owner (split-owner setups). |

## Tool architecture

Each tool module exports a `registerXyzTools()` function that registers tools onto the MCP server. All tools use the `ralph_hero__` prefix and return via `toolSuccess()` / `toolError()`. Modules cover issues (`get_issue`, `save_issue`, `list_issues`), projects, relationships (`add_sub_issue`, `add_dependency`, `advance_issue`), dashboards (`pipeline_dashboard`, `next_actions`), trends, and more.

For the full module/tool inventory and internals (GitHub client dual-endpoint design, caching, the workflow state machine), see [the repo's CLAUDE.md § "MCP Server Internals"](https://github.com/cdubiel08/ralph-hero/blob/main/CLAUDE.md#mcp-server-internals).

## Build & test

```bash
npm install
npm run build   # TypeScript -> dist/ (tsc)
npm test        # vitest
```

The server is ESM (`"type": "module"`, `"module": "NodeNext"`) — internal imports use `.js` extensions. TypeScript strict mode is the primary quality gate (no linter).

## Links

- Repository: <https://github.com/cdubiel08/ralph-hero>
- Plugin + workflow docs: <https://github.com/cdubiel08/ralph-hero/blob/main/README.md>
- Issues: <https://github.com/cdubiel08/ralph-hero/issues>

## License

See the [repository](https://github.com/cdubiel08/ralph-hero).
