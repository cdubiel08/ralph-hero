---
date: 2026-03-25
topic: "GitHub token management across ralph-hero MCP, gh CLI, and GitHub Actions"
tags: [research, codebase, tokens, authentication, gh-cli, mcp-server, github-actions]
status: complete
type: research
---

# Research: GitHub Token Management Across Tools

## Prior Work

- builds_on:: [[2026-02-13-setup-friction-fixes]]

## Research Question

How do GitHub tokens flow through ralph-hero MCP server, `gh` CLI, and GitHub Actions? Does the ralph-hero MCP server fall back to `GITHUB_TOKEN` or `GH_TOKEN`?

## Summary

**ralph-hero MCP does NOT fall back to `GITHUB_TOKEN` or `GH_TOKEN`.** This is an intentional design decision made during the setup-friction-fixes work (Feb 2026) to prevent token collision with the `gh` CLI. The two systems use completely independent authentication:

| Tool | Token source | Configured via |
|------|-------------|----------------|
| ralph-hero MCP | `RALPH_GH_REPO_TOKEN` or `RALPH_HERO_GITHUB_TOKEN` | `.claude/settings.local.json` `"env"` block |
| `gh` CLI | `gh auth login` credential store | Interactive login (keychain/config file) |
| GitHub Actions | `secrets.ROUTING_PAT` (project ops) or `secrets.GITHUB_TOKEN` (releases) | Repository secrets |

This means a user must maintain **two separate auth setups**: one for ralph-hero (env var in settings.local.json) and one for `gh` CLI (interactive login).

## Detailed Findings

### 1. Ralph-Hero MCP Token Resolution

**File**: `plugin/ralph-hero/mcp-server/src/index.ts:33-69`

The MCP server resolves tokens through a `RALPH_`-prefixed-only chain:

```
Repo token:    RALPH_GH_REPO_TOKEN  →  RALPH_HERO_GITHUB_TOKEN  →  exit(1)
Project token: RALPH_GH_PROJECT_TOKEN  →  repoToken (from above)
```

The `resolveEnv()` function (line 33-38) filters out unexpanded `${VAR}` literals that Claude Code may pass for unset vars, treating them as undefined.

**Explicitly forbidden** env vars (documented in test contract at `src/__tests__/init-config.test.ts:157-163`):
- `GITHUB_TOKEN`
- `GH_TOKEN`
- `GITHUB_PERSONAL_ACCESS_TOKEN`
- `GITHUB_OWNER`
- `GITHUB_REPO`

**Historical context**: The original implementation (pre-Feb 2026) had a 4-step fallback chain: `RALPH_HERO_GITHUB_TOKEN → GITHUB_PERSONAL_ACCESS_TOKEN → GITHUB_TOKEN → GH_TOKEN`. This was removed in the setup-friction-fixes work because setting `GITHUB_TOKEN` or `GH_TOKEN` in the MCP process environment would collide with `gh` CLI's own token resolution when Claude ran shell commands.

### 2. The `.mcp.json` Has No `env` Block

**File**: `plugin/ralph-hero/.mcp.json`

```json
{
  "mcpServers": {
    "ralph-github": {
      "command": "npx",
      "args": ["-y", "ralph-hero-mcp-server@2.5.42"],
      "cwd": "${CLAUDE_PLUGIN_ROOT}"
    }
  }
}
```

There is no `env` key. The MCP server inherits its entire environment from the Claude Code parent process. Tokens set in `.claude/settings.local.json` under `"env"` are injected into the parent process environment, which the MCP server inherits at startup.

### 3. Dual-Token Architecture

**File**: `plugin/ralph-hero/mcp-server/src/github-client.ts:84-104`

The client creates separate `@octokit/graphql` instances when `projectToken` differs from `token`:

- `query()` / `mutate()` — use repo token for repository operations (issues, PRs, comments)
- `projectQuery()` / `projectMutate()` — use project token for Projects V2 operations (fields, workflow state)
- `restPost()` — defaults to project token, overridable with `useProjectToken=false`

When only a single token is configured, all four methods use the same token.

### 4. `gh` CLI Authentication — Completely Independent

The `gh` CLI is used in scripts, hooks, skills (as instructions to Claude), and agents. **None of these set a token before invoking `gh`**. Every `gh` invocation relies on the ambient `gh auth login` credential store.

**Scripts using `gh`:**
- `plugin/ralph-hero/scripts/demo-seed.sh` — checks `gh auth status` at line 35 as a prerequisite
- `plugin/ralph-hero/scripts/demo-cleanup.sh` — no auth check
- `scripts/merge-pr.sh` — no auth check
- `scripts/test-memory-layer.sh` — no auth check

**Skills instructing Claude to run `gh`:**
- `skills/hello/SKILL.md` — `gh pr list`
- `skills/ralph-impl/SKILL.md` — `gh pr create`, `gh pr view`
- `skills/ralph-pr/SKILL.md` — `gh pr create`
- `skills/ralph-merge/SKILL.md` — `gh pr view`, `gh pr merge`
- `skills/setup/SKILL.md` — `gh api graphql`
- `skills/setup-repos/SKILL.md` — `gh api graphql`, `gh api repos/...`
- Multiple others

**Hooks using `gh`:**
- `hooks/scripts/team-stop-gate.sh` — `gh issue list` (line 32)

All rely on ambient `gh` login state. No token injection.

### 5. GitHub Actions Token Strategy

Actions workflows use a separate token model entirely:

**Project-mutating workflows** (need Projects V2 write access — `GITHUB_TOKEN` cannot do this):
- `sync-issue-state.yml` — `GH_TOKEN: ${{ secrets.ROUTING_PAT }}`
- `sync-pr-merge.yml` — `GH_TOKEN: ${{ secrets.ROUTING_PAT }}`
- `advance-parent.yml` — `GH_TOKEN: ${{ secrets.ROUTING_PAT }}`
- `route-issues.yml` — passes `ROUTING_PAT` to Node.js script (not `gh` CLI)
- `sync-project-state.yml` — passes `SYNC_PAT` (aliased from `ROUTING_PAT`) to Node.js script

**Release workflows** (repo-level only):
- `release.yml` — `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`
- `release-knowledge.yml` — `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`

### 6. Startup Diagnostics

**File**: `plugin/ralph-hero/mcp-server/src/index.ts:103-112`

The MCP server logs which token source is in use at startup:
```
[ralph-hero] Repo token: RALPH_HERO_GITHUB_TOKEN
```
or, in dual-token mode:
```
[ralph-hero] Repo token: RALPH_GH_REPO_TOKEN
[ralph-hero] Project token: RALPH_GH_PROJECT_TOKEN (separate)
```

When no token is found, a detailed error message (lines 49-68) includes a copy-pasteable `settings.local.json` template and a link to GitHub's token creation page, then exits with code 1.

## Code References

- `plugin/ralph-hero/mcp-server/src/index.ts:33-38` — `resolveEnv()` filters unexpanded `${VAR}` literals
- `plugin/ralph-hero/mcp-server/src/index.ts:40-69` — `initGitHubClient()` token resolution chain
- `plugin/ralph-hero/mcp-server/src/index.ts:103-112` — Token source logging
- `plugin/ralph-hero/mcp-server/src/github-client.ts:84-104` — Dual-client creation
- `plugin/ralph-hero/mcp-server/src/__tests__/init-config.test.ts:138-173` — `.mcp.json` contract test (forbidden vars)
- `plugin/ralph-hero/.mcp.json` — No `env` block; inherits parent environment
- `plugin/ralph-hero/scripts/demo-seed.sh:35` — Only script that checks `gh auth status`

## Architecture Documentation

```
┌─────────────────────────────────────────────────────────┐
│                   Claude Code Process                    │
│                                                         │
│  .claude/settings.local.json                            │
│  ┌─────────────────────────────────┐                    │
│  │ "env": {                        │                    │
│  │   "RALPH_HERO_GITHUB_TOKEN":... │──┐                 │
│  │   "RALPH_GH_OWNER": ...        │  │                 │
│  │ }                               │  │                 │
│  └─────────────────────────────────┘  │                 │
│                                       │ inherits env    │
│  ┌──────────────────────┐             │                 │
│  │  MCP Server (stdio)  │◀────────────┘                 │
│  │  index.ts             │                               │
│  │  resolveEnv() reads   │                               │
│  │  RALPH_* vars only    │                               │
│  └──────────────────────┘                               │
│                                                         │
│  ┌──────────────────────┐                               │
│  │  Bash tool (gh CLI)  │──── uses gh auth login store  │
│  │  No GITHUB_TOKEN set │     (separate from MCP)       │
│  └──────────────────────┘                               │
└─────────────────────────────────────────────────────────┘
```

The two auth systems are fully isolated:
1. **ralph-hero MCP**: `RALPH_*` env vars → `@octokit/graphql` with `token` header
2. **gh CLI**: `gh auth login` → OS keychain / `~/.config/gh/hosts.yml`

## Historical Context (from thoughts/)

The `2026-02-13-setup-friction-fixes.md` plan documents the original problem:
- The old `.mcp.json` passed `GITHUB_TOKEN` and `GH_TOKEN` through to the MCP server
- This collided with `gh` CLI's OAuth token because Claude Code's Bash tool inherits the same environment
- The fix was Phase 3 of that plan: remove all non-`RALPH_` vars from `.mcp.json` (and later remove the `env` block entirely)
- The old fallback chain `RALPH_HERO_GITHUB_TOKEN → GITHUB_PERSONAL_ACCESS_TOKEN → GITHUB_TOKEN → GH_TOKEN` was simplified to `RALPH_GH_REPO_TOKEN → RALPH_HERO_GITHUB_TOKEN`

## Open Questions

- If a user has `gh auth login` configured with a token that has `project` scope, could ralph-hero be taught to optionally read from the `gh` credential store as a convenience fallback? (e.g., `gh auth token` outputs the active token)
- The two independent auth setups mean users must configure both separately — is there a way to unify without reintroducing the collision problem?
