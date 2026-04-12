---
date: 2026-03-26
github_issue: 694
github_url: https://github.com/cdubiel08/ralph-hero/issues/694
topic: "How does the ralph CLI resolve RALPH_GH_OWNER and other env vars, and why does it fail outside the ralph-hero repo?"
tags: [research, codebase, cli, env-resolution, settings-local-json, justfile, mcp-server]
status: complete
type: research
git_commit: c4eea06e2f97fd7806ceae8258b3727f2e1c1859
---

# Research: `ralph` CLI Environment Resolution Outside the ralph-hero Repo

## Prior Work

- builds_on:: [[2026-03-06-GH-0546-ralph-cli-justfile-architecture]]
- builds_on:: [[2026-03-18-justfile-cli-setup-fallbacks]]
- builds_on:: [[2026-03-24-agent-env-propagation-token-scope]]
- builds_on:: [[2026-03-25-github-token-management-across-tools]]
- builds_on:: [[2026-03-25-GH-0684-userconfig-healthcheck-setup-rewrite]]

## Research Question

Running `ralph issue "..."` from `~/projects/ralph-engine` produces:
```
{ "error": "Failed to create issue: owner is required (set RALPH_GH_OWNER env var or pass explicitly)" }
```

How does the `ralph` CLI resolve environment variables, and why does it fail when invoked outside the ralph-hero repo?

## Summary

The `ralph` CLI has **two independent env resolution paths** that both contribute to the failure:

1. **Shell-side (`justfile`)**: The `read_settings_env()` bash function searches for `settings.local.json` in **the current git repo root** first, then falls back to `~/.claude/settings.local.json`. When run from `ralph-engine`, it finds no repo-local settings and the global file likely doesn't contain `RALPH_GH_OWNER`.

2. **MCP-server-side**: The `ralph issue` command spawns Claude Code with `--print`, which launches the MCP server via `npx`. The MCP server reads env vars from `process.env` via `resolveEnv()`. Since Claude Code injects env vars from the **project-scoped** `settings.local.json`, running from a different project means the ralph-hero settings are not in scope.

The core issue: `RALPH_GH_OWNER` is configured in ralph-hero's `.claude/settings.local.json`, which is project-scoped. The global `ralph` CLI has no mechanism to propagate ralph-hero project settings when invoked from other directories.

## Detailed Findings

### 1. CLI Entry Point: `ralph-cli.sh`

**File**: [`plugin/ralph-hero/scripts/ralph-cli.sh`](https://github.com/cdubiel08/ralph-hero/blob/c4eea06e2f97fd7806ceae8258b3727f2e1c1859/plugin/ralph-hero/scripts/ralph-cli.sh)

The global `ralph` command is a bash script installed to `~/.local/bin/ralph` by the `setup-cli` skill. It:
- Resolves the latest installed plugin version at runtime from `~/.claude/plugins/`
- Validates the recipe name with fuzzy matching
- Delegates to the justfile via `just` command executor

The script itself does **not** resolve env vars — it delegates entirely to justfile recipes.

### 2. Shell-Side Env Resolution: `read_settings_env()`

**File**: [`plugin/ralph-hero/justfile:230-268`](https://github.com/cdubiel08/ralph-hero/blob/c4eea06e2f97fd7806ceae8258b3727f2e1c1859/plugin/ralph-hero/justfile#L230-L268)

The justfile defines `read_settings_env()`, a bash function that searches for env vars in `settings.local.json` files:

```bash
read_settings_env() {
    local var="$1"
    # Try repo-local first
    repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
    if [ -n "$repo_root" ] && [ -f "$repo_root/.claude/settings.local.json" ]; then
        paths+=("$repo_root/.claude/settings.local.json")
    fi
    # Then global
    if [ -f "$HOME/.claude/settings.local.json" ]; then
        paths+=("$HOME/.claude/settings.local.json")
    fi
    # Parse JSON with Node.js, filter ${VAR} literals
    ...
}
```

**Search order**:
1. `<current-git-repo>/.claude/settings.local.json` (repo-local)
2. `~/.claude/settings.local.json` (global)

When run from `~/projects/ralph-engine`, step 1 looks for `ralph-engine/.claude/settings.local.json` (which doesn't exist or doesn't have RALPH_GH_OWNER). Step 2 checks the global file, which may also lack it.

### 3. The `issue` Recipe Flow

**File**: [`plugin/ralph-hero/justfile`](https://github.com/cdubiel08/ralph-hero/blob/c4eea06e2f97fd7806ceae8258b3727f2e1c1859/plugin/ralph-hero/justfile)

The `issue` recipe spawns a Claude Code `--print` session with a prompt to call `ralph_hero__create_issue`. This launches the MCP server, which reads env vars from the process environment injected by Claude Code.

### 4. MCP Server Env Resolution: `resolveEnv()`

**File**: [`plugin/ralph-hero/mcp-server/src/index.ts:33-38`](https://github.com/cdubiel08/ralph-hero/blob/c4eea06e2f97fd7806ceae8258b3727f2e1c1859/plugin/ralph-hero/mcp-server/src/index.ts#L33-L38)

```typescript
function resolveEnv(name: string): string | undefined {
  const val = process.env[name];
  if (!val || val.startsWith("${")) return undefined;
  return val;
}
```

Called at startup for all RALPH_* variables ([index.ts:71-86](https://github.com/cdubiel08/ralph-hero/blob/c4eea06e2f97fd7806ceae8258b3727f2e1c1859/plugin/ralph-hero/mcp-server/src/index.ts#L71-L86)):

```typescript
const owner = resolveEnv("RALPH_GH_OWNER");
const repo = resolveEnv("RALPH_GH_REPO");
const projectOwner = resolveEnv("RALPH_GH_PROJECT_OWNER") || owner;
```

### 5. What Happens When RALPH_GH_OWNER Is Undefined

**At startup** ([index.ts:88-93](https://github.com/cdubiel08/ralph-hero/blob/c4eea06e2f97fd7806ceae8258b3727f2e1c1859/plugin/ralph-hero/mcp-server/src/index.ts#L88-L93)): Non-fatal warning to stderr; server continues.

**At tool invocation** ([helpers.ts:554-558](https://github.com/cdubiel08/ralph-hero/blob/c4eea06e2f97fd7806ceae8258b3727f2e1c1859/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L554-L558)): `resolveConfig()` throws:
```
"owner is required (set RALPH_GH_OWNER env var or pass explicitly)"
```

This is the exact error seen in the reproduction.

**Repo inference** ([helpers.ts:491-540](https://github.com/cdubiel08/ralph-hero/blob/c4eea06e2f97fd7806ceae8258b3727f2e1c1859/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L491-L540)): `resolveRepoFromProject()` also requires `RALPH_GH_OWNER` to query the project's linked repos. Without it, inference cannot run.

### 6. The Config Resolver Functions

Three functions in `helpers.ts` gate tool execution:

| Function | Line | Behavior when owner missing |
|----------|------|-----------------------------|
| `resolveConfig()` | [554](https://github.com/cdubiel08/ralph-hero/blob/c4eea06e2f97fd7806ceae8258b3727f2e1c1859/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L554) | Throws "owner is required" |
| `resolveConfigOptionalRepo()` | [579](https://github.com/cdubiel08/ralph-hero/blob/c4eea06e2f97fd7806ceae8258b3727f2e1c1859/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L579) | Throws "owner is required" |
| `resolveFullConfig()` | [596](https://github.com/cdubiel08/ralph-hero/blob/c4eea06e2f97fd7806ceae8258b3727f2e1c1859/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L596) | Calls resolveConfig(), same error |

All tools that create/read issues call one of these, making the entire CLI non-functional without `RALPH_GH_OWNER`.

### 7. How Claude Code Provides Env to the MCP Server

Claude Code reads `settings.local.json` and merges the `"env"` object into the child process environment before launching MCP servers via `npx`. The `.mcp.json` has **no `env` block** — the server inherits the parent process environment.

**Key constraint**: Claude Code loads `settings.local.json` from the **current project's** `.claude/` directory. When `ralph` spawns Claude Code from `ralph-engine`, it uses `ralph-engine/.claude/settings.local.json` (or global), not `ralph-hero/.claude/settings.local.json`.

### 8. Global Settings Fallback

The `read_settings_env()` function does check `~/.claude/settings.local.json` as a fallback. If `RALPH_GH_OWNER` were set there, the shell-side resolution would work. However, the MCP server path through Claude Code `--print` depends on Claude Code's own project resolution, which is directory-dependent.

## Code References

- `plugin/ralph-hero/scripts/ralph-cli.sh` — CLI entry point, recipe dispatch
- `plugin/ralph-hero/justfile:230-268` — `read_settings_env()` shell function
- `plugin/ralph-hero/mcp-server/src/index.ts:33-38` — `resolveEnv()` MCP-side
- `plugin/ralph-hero/mcp-server/src/index.ts:71-93` — Owner/config reading + warning
- `plugin/ralph-hero/mcp-server/src/lib/helpers.ts:491-540` — Repo inference from project
- `plugin/ralph-hero/mcp-server/src/lib/helpers.ts:554-600` — Config resolver functions (error source)
- `plugin/ralph-hero/mcp-server/src/types.ts:283-294` — `GitHubClientConfig` type
- `plugin/ralph-hero/mcp-server/src/types.ts:296-300` — `resolveProjectOwner()`
- `plugin/ralph-hero/skills/setup-cli/SKILL.md` — CLI installation procedure

## Architecture Documentation

### Env Resolution Flow (Current)

```
ralph issue "..."  (from ~/projects/ralph-engine)
  └─ ralph-cli.sh
      └─ just issue "..."  (justfile from plugin cache)
          ├─ read_settings_env("RALPH_GH_OWNER")
          │   ├─ Try: ralph-engine/.claude/settings.local.json  → NOT FOUND
          │   └─ Try: ~/.claude/settings.local.json             → MAY NOT HAVE IT
          └─ claude --print "call ralph_hero__create_issue..."
              └─ Claude Code launches MCP server
                  ├─ Loads env from current project's settings.local.json
                  │   (ralph-engine's, not ralph-hero's)
                  └─ resolveEnv("RALPH_GH_OWNER") → undefined
                      └─ resolveConfig() → ERROR: "owner is required"
```

### Two Independent Failure Points

1. **Shell-side** (`read_settings_env`): Searches repo-local then global settings. Works if global settings have the value.
2. **MCP-server-side** (via Claude Code `--print`): Depends on which project Claude Code resolves. The MCP server only sees env vars from the active project's `settings.local.json`.

Even if the shell-side resolves the value, the MCP-server-side may still fail because Claude Code scopes env injection to the current project directory.

## Historical Context (from thoughts/)

- **GH-0588**: Removed the `.mcp.json` env block, consolidating all config into `settings.local.json`. This made the problem more acute — there's no env fallback in the MCP config itself.
- **GH-0634**: Added `settings.local.json` fallback to the doctor command, establishing the repo-local → global search pattern now used by `read_settings_env()`.
- **GH-0684/0685**: Active work on userconfig healthcheck and setup rewrite (Mar 25), which may touch config resolution.
- **Agent env propagation research** (Mar 24): Documents how env vars flow from settings to agents and MCP servers.
- **Token management research** (Mar 25): Maps token resolution across all tools, relevant to understanding the full config chain.

## Related Research

- [[2026-03-06-GH-0546-ralph-cli-justfile-architecture]] — CLI justfile architecture
- [[2026-03-18-justfile-cli-setup-fallbacks]] — Justfile CLI setup fallbacks
- [[2026-03-24-agent-env-propagation-token-scope]] — Agent env propagation
- [[2026-03-25-github-token-management-across-tools]] — Token management cross-tool
- [[2026-03-25-userconfig-manifest-schema-validation]] — Userconfig manifest validation
- [[2026-02-21-group-GH-0281-global-ralph-cli]] — Global ralph CLI plan

## Open Questions

1. Should the `ralph` CLI explicitly pass `--owner` / `--project-number` to the `claude --print` invocation when `read_settings_env()` resolves them shell-side, bridging the gap between shell resolution and MCP server resolution?
2. Should there be a dedicated `~/.ralph/config` or `~/.config/ralph/config.json` that both the shell scripts and the MCP server can read, independent of Claude Code's project scoping?
3. Does the active GH-0684/0685 userconfig work already address this gap, or is it focused only on the MCP server's internal config validation?
