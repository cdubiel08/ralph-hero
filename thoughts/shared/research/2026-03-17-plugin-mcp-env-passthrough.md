---
date: 2026-03-17
topic: "Plugin .mcp.json env block does not pass through RALPH_HERO_GITHUB_TOKEN to MCP server"
tags: [research, plugin, mcp, env, configuration, secrets]
status: complete
type: research
---

# Research: Plugin .mcp.json env block does not pass through RALPH_HERO_GITHUB_TOKEN

## Prior Work

- builds_on:: [[2026-02-13-setup-friction-fixes]]
- builds_on:: [[2026-03-01-GH-0477-mcp-version-mismatch-cli-dispatch]]
- builds_on:: [[2026-02-27-GH-0439-resolve-config-optional-repo]]

## Research Question

The ralph-hero plugin's MCP server fails to connect because `RALPH_HERO_GITHUB_TOKEN` is not passed through the `env` block in `.mcp.json`. What is the correct, first-class pattern for handling env vars and secrets in Claude Code plugins?

## Summary

The plugin's `.mcp.json` has an explicit `env` block that defines which environment variables are passed to the spawned MCP server child process. This block was missing `RALPH_HERO_GITHUB_TOKEN`, so the server starts, finds no token, and exits with an error. The official Claude Code plugin ecosystem has **no `env_keys` or `required_env` mechanism** in `plugin.json` — the convention is to reference `${VAR}` in `.mcp.json` and rely on the process environment for expansion. Most official first-party plugins avoid the problem entirely by using HTTP transport with Bearer headers or OAuth, not stdio with env blocks.

## Detailed Findings

### How the current plugin passes env vars

The plugin's `.mcp.json` (`plugin/ralph-hero/.mcp.json`) defines a stdio MCP server:

```json
{
  "mcpServers": {
    "ralph-github": {
      "command": "npx",
      "args": ["-y", "ralph-hero-mcp-server@2.5.13"],
      "cwd": "${CLAUDE_PLUGIN_ROOT}",
      "env": {
        "RALPH_GH_OWNER": "${RALPH_GH_OWNER:-cdubiel08}",
        "RALPH_GH_REPO": "${RALPH_GH_REPO:-ralph-hero}",
        "RALPH_GH_PROJECT_NUMBER": "${RALPH_GH_PROJECT_NUMBER:-3}"
      }
    }
  }
}
```

The `env` block is **explicitly enumerated** — only vars listed here are passed to the child process. `RALPH_HERO_GITHUB_TOKEN` was not listed, so the MCP server never received it.

### How resolveEnv() handles missing vars (`index.ts:31-36`)

```typescript
function resolveEnv(name: string): string | undefined {
  const val = process.env[name];
  if (!val || val.startsWith("${")) return undefined;
  return val;
}
```

When Claude Code cannot expand a `${VAR}` reference (because the var isn't in the process environment), it passes the **literal string** `${RALPH_HERO_GITHUB_TOKEN}` to the child process. `resolveEnv()` detects this and treats it as undefined. This is a defensive workaround, not a solution — the var should be expandable in the first place.

### Official plugin patterns (from anthropics/claude-plugins-official)

The official Anthropic plugin directory uses three distinct patterns:

**1. HTTP transport with Bearer headers (GitHub, Greptile)**
```json
{
  "github": {
    "type": "http",
    "url": "https://api.githubcopilot.com/mcp/",
    "headers": {
      "Authorization": "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}"
    }
  }
}
```
`${VAR}` expansion happens in the `headers` block. No `env` block needed — the var is expanded by Claude Code itself before making the HTTP request.

**2. OAuth config block (Slack, Asana, Linear)**
```json
{
  "slack": {
    "type": "http",
    "url": "https://mcp.slack.com/mcp",
    "oauth": {
      "clientId": "1601185624273.8899143856786",
      "callbackPort": 3118
    }
  }
}
```
No secrets in .mcp.json at all. Claude Code handles the OAuth flow and token storage.

**3. stdio with env block (community plugins, ralph-hero)**
```json
{
  "env": {
    "TOKEN": "${MY_TOKEN}",
    "CONFIG_VAR": "${CONFIG_VAR:-default_value}"
  }
}
```
The plugin must explicitly list every env var it needs. `${VAR:-default}` syntax provides fallback defaults.

### Key finding: No plugin.json env declaration mechanism exists

Across all official Anthropic plugins and community plugins surveyed:
- **No `env_keys` field** exists in the plugin.json schema
- **No `required_env` field** exists
- **plugin.json is purely metadata**: name, version, description, author, keywords
- The convention for communicating required env vars is through the README, setup skill, or sentinel values in .mcp.json

### Why the token was missing from the env block

The setup friction fixes plan (2026-02-13) addressed a related issue: the `.mcp.json` originally passed `GITHUB_TOKEN` and `GH_TOKEN` which collided with the `gh` CLI's OAuth token. The fix was to use `RALPH_HERO_GITHUB_TOKEN` as the primary token name and remove the `GITHUB_TOKEN`/`GH_TOKEN` entries. However, the `env` block in `.mcp.json` was not updated to include `RALPH_HERO_GITHUB_TOKEN` — it was assumed the settings.local.json `env` block would make the var available to child processes, but the stdio `.mcp.json` env block operates as an **explicit allowlist**, not a merge.

### How settings.local.json env interacts with plugin .mcp.json env

The `settings.local.json` `env` block sets environment variables for the Claude Code process itself. However, when a plugin's `.mcp.json` defines its own `env` block, that block **defines the child process environment**. Variables from `settings.local.json` are available for `${VAR}` expansion within `.mcp.json`, but only if referenced.

The flow is:
1. User sets `RALPH_HERO_GITHUB_TOKEN` in `settings.local.json` env
2. Claude Code makes it available in its process environment
3. Plugin `.mcp.json` env block references `"${RALPH_HERO_GITHUB_TOKEN}"`
4. Claude Code expands it and passes the value to the child process
5. If step 3 is missing (var not listed in env block), the child process never sees it

### The ralph-knowledge plugin comparison

`plugin/ralph-knowledge/.mcp.json` has **no `env` block at all**:
```json
{
  "mcpServers": {
    "ralph-knowledge": {
      "command": "npx",
      "args": ["-y", "ralph-hero-knowledge-index@0.1.8"]
    }
  }
}
```
With no explicit `env` block, the child process likely inherits the parent environment (Claude Code's env, which includes `settings.local.json` vars). This may be the simplest fix for ralph-hero too — remove the explicit `env` block and let the server read from the inherited environment.

## Code References

- `plugin/ralph-hero/.mcp.json:7-12` — env block missing RALPH_HERO_GITHUB_TOKEN
- `plugin/ralph-hero/mcp-server/src/index.ts:31-36` — resolveEnv() filtering unexpanded vars
- `plugin/ralph-hero/mcp-server/src/index.ts:40-41` — token resolution chain
- `plugin/ralph-hero/.claude-plugin/plugin.json` — no env declaration mechanism
- `plugin/ralph-knowledge/.mcp.json` — no env block, inherits parent env

## Architecture Documentation

### Three approaches to fix this (ranked by elegance)

**Option A: Remove explicit env block entirely**
Let the MCP server inherit the full parent environment. The server already uses `resolveEnv()` to read what it needs. This matches what ralph-knowledge does.

Pros: Simplest, no maintenance burden, new env vars automatically available
Cons: Child process gets full environment (minor security concern), loses documentation of what vars the server uses

**Option B: Enumerate all required vars in env block**
Add `RALPH_HERO_GITHUB_TOKEN` (and all other optional vars) to the env block.

Pros: Explicit, self-documenting
Cons: Must be kept in sync — every new env var needs to be added to `.mcp.json` too

**Option C: Hybrid — remove env block, document vars in README/setup skill**
Same as A but with clear documentation. The setup skill already validates configuration.

## Related Research

- `thoughts/shared/plans/2026-02-13-setup-friction-fixes.md` — Token handling friction points
- `thoughts/shared/research/2026-03-01-GH-0477-mcp-version-mismatch-cli-dispatch.md` — .mcp.json version management
- `thoughts/shared/plans/2026-02-27-GH-0439-resolve-config-optional-repo.md` — Config resolution patterns

## Open Questions

1. Does removing the `env` block entirely cause the child process to inherit ALL parent env vars, or does Claude Code's plugin spawner apply its own filtering?
2. Should the version pin in `.mcp.json` (`ralph-hero-mcp-server@2.5.13`) be updated as part of this fix? It's currently behind the latest release (2.5.15).
3. Would migrating to HTTP transport (like official plugins) be a better long-term solution, or is stdio the right choice for a locally-run plugin?
