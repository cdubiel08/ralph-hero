---
date: 2026-03-25
topic: "Token/API key management struggles and setup skill improvement opportunities"
tags: [research, tokens, setup, configuration, developer-experience, security]
status: complete
type: research
git_commit: 1e26435
---

# Research: Token/API Key Management Struggles & Setup Skill Improvements

## Prior Work

- builds_on:: [[2026-03-25-github-token-management-across-tools]]
- builds_on:: [[2026-03-24-agent-env-propagation-token-scope]]
- builds_on:: [[2026-03-19-GH-0634-doctor-settings-local-json-fallback]]
- builds_on:: [[2026-03-17-GH-0588-remove-mcp-env-block]]
- builds_on:: [[2026-03-21-secret-protection-gitignore-enforcement]]
- builds_on:: [[2026-03-24-GH-0674-agent-per-phase-architecture]]

## Research Question

What recent struggles have we had managing API keys and tokens, and how can we improve 'setup' skills across the plugin ecosystem?

## Summary

Six prior documents spanning 2026-03-17 to 2026-03-25 reveal a consistent pattern: token and configuration management has been a recurring friction source across multiple dimensions — env var propagation to sub-agents, shell vs Claude Code process isolation, secret protection gaps, and multi-tool token collision. The current setup skills handle the *initial* happy path well but don't address the ongoing operational pain of token rotation, cross-tool auth verification, consumer-repo onboarding, or diagnostic self-service.

## Detailed Findings

### 1. The Token Landscape (3 independent auth systems)

Ralph operates across three token systems that must remain isolated:

| System | Token Source | Config Location | Scope |
|--------|-------------|-----------------|-------|
| ralph-hero MCP | `RALPH_HERO_GITHUB_TOKEN` (or split repo/project tokens) | `.claude/settings.local.json` | `repo`, `project` |
| `gh` CLI | `gh auth login` credential store | `~/.config/gh/hosts.yml` | Whatever user granted |
| GitHub Actions | `secrets.ROUTING_PAT` + `secrets.GITHUB_TOKEN` | Repo Settings > Secrets | `repo`, `project` for PAT |

**Key design decision**: ralph-hero intentionally refuses `GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_PERSONAL_ACCESS_TOKEN` to prevent collision with `gh` CLI (enforced by contract test at `init-config.test.ts:157-163`).

### 2. Documented Pain Points (Chronological)

#### 2a. Silent env var dropping (GH-588, 2026-03-17)
**What happened**: The `.mcp.json` `env` block acted as an allowlist — only 3 of 10+ supported vars were listed. Seven optional vars (`RALPH_GH_REPO_TOKEN`, `RALPH_GH_PROJECT_TOKEN`, `RALPH_GH_PROJECT_OWNER`, `RALPH_GH_PROJECT_NUMBERS`, `RALPH_GH_TEMPLATE_PROJECT`, `RALPH_HERO_AUTO`, `RALPH_DEBUG`) silently never reached the server.
**Resolution**: Removed the env block entirely. Server now inherits parent process environment.

#### 2b. `ralph doctor` blind to settings.local.json (GH-634, 2026-03-19)
**What happened**: `ralph doctor` runs in a shell context where `settings.local.json` env vars aren't exported — they only exist inside Claude Code's process. Doctor always reports FAIL even when everything works.
**Resolution**: Planned `node -e` fallback to parse `settings.local.json` directly. Status: plan exists, implementation pending.

#### 2c. Secret protection has gaps (GH-649, 2026-03-21)
**What happened**: Protection relies on Claude Code's global gitignore (`~/.config/git/ignore`), which doesn't exist on fresh machines or non-Claude-Code contributors. Root `.gitignore` has no entries for `.claude/` or `*.local.json`. Historical token commits occurred.
**Open questions**: Should root `.gitignore` include these patterns as defense-in-depth? Should setup skills verify/add `.gitignore` entries? Should a PreToolUse hook inspect `git diff --cached` for token patterns?

#### 2d. Sub-agent token scope confusion (2026-03-24)
**What happened**: Three compounding failures in wrapper-agent architecture:
1. Sub-agents cannot spawn sub-agents (platform limitation) — `context: fork` silently runs inline
2. `$RALPH_GH_OWNER` in skill prompts is literal text to LLMs — sub-agents hallucinate wrong repo names
3. Plugin sub-agent hooks (`hooks:`, `mcpServers:`, `permissionMode:` in frontmatter) are silently ignored for security
4. `skill-precondition.sh` blocks MCP calls when `RALPH_COMMAND` is empty — LLM interprets the block as a "token scope error"
**Resolution**: Agent-per-phase architecture planned (GH-674). Backtick preprocessing validated as env var injection solution.

#### 2e. No scripts check `gh auth status` (2026-03-25)
**What happened**: Only `demo-seed.sh` verifies `gh` authentication. Scripts like `demo-cleanup.sh`, `merge-pr.sh`, and `test-memory-layer.sh` invoke `gh` with no prerequisite check — they fail with cryptic errors when not authenticated.

### 3. Current Setup Skills Inventory

| Skill | Plugin | What It Configures | Token Handling |
|-------|--------|--------------------|----------------|
| `setup` | ralph-hero | GitHub Project V2, custom fields, workflow states | Guides through PAT creation, `settings.local.json`, health check |
| `setup-cli` | ralph-hero | Global `ralph` command, shell completions | No token handling (Bash only) |
| `setup-repos` | ralph-hero | `.ralph-repos.yml` multi-repo registry | Uses health_check, needs existing token |
| `setup` | ralph-knowledge | SQLite index from markdown docs | No external tokens needed |
| `setup-obsidian` | ralph-knowledge | Obsidian vault config for thoughts/ | No external tokens needed |
| `setup` | ralph-playwright | playwright-cli, browser binaries | No external tokens needed |

### 4. Setup Skill Architecture

The ralph-hero `setup` skill (`plugin/ralph-hero/skills/setup/SKILL.md`, 628 lines) is the most complex:
- Runs as `context: fork` with `model: haiku`
- SessionStart hook injects `RALPH_COMMAND=setup` via `set-skill-env.sh`
- Allowed tools: `Bash`, `ralph_hero__health_check`, `ralph_hero__get_project`, `ralph_hero__setup_project`
- 7-step workflow: health check → determine project owner → create/verify project → update colors → views (manual) → store config → verify
- Optional Step 6b: routing & sync setup (ROUTING_PAT secret, repo variables, routing config)
- Handles: simple setup, split-owner, dual-token

### 5. Token Resolution Flow in MCP Server

```
index.ts:33-38  resolveEnv() — filters undefined and ${VAR} literals
index.ts:40-69  initGitHubClient() — token priority chain:
                  Repo:    RALPH_GH_REPO_TOKEN → RALPH_HERO_GITHUB_TOKEN
                  Project: RALPH_GH_PROJECT_TOKEN → repo token
                  Missing repo token → console.error + process.exit(1)
index.ts:71-101 Optional vars — warnings only, no exit
index.ts:114-124 createGitHubClient() — builds dual graphql instances
```

### 6. Existing Diagnostics

- `ralph_hero__health_check` tool: validates auth, repo access, project access, required fields
- Startup logging: reports token source, warns on missing optional vars
- Rate limiter: proactive tracking with warn (100) and block (50) thresholds
- `ralph doctor` CLI command: exists but can't read `settings.local.json` (GH-634)

### 7. Secret Protection Mechanisms

| Mechanism | Scope | Gap |
|-----------|-------|-----|
| Claude Code global gitignore | `*.local.json`, `*.local.md` | Not present on fresh machines |
| `gitignore-enforcement.sh` hook | Blocks Write tool for local files not in `.gitignore` | Only catches Claude Code writes, not manual edits |
| Root `.gitignore` | `*.local.json`, `*.local.md`, `.env*` | Present (lines 17-19) |
| Plugin `.gitignore` | `*.local.md` | Scoped to plugin subtree only |

## Improvement Opportunities

### A. Cross-Plugin Setup Orchestrator

Currently each plugin has independent setup skills with no coordination. A user setting up ralph-hero for the first time must run multiple separate skills. A unified "first-run" experience could:
- Detect which plugins are installed
- Run health checks across all plugins
- Guide through token creation once (shared PAT)
- Verify `.gitignore` protection before writing any local files
- Create `settings.local.json` with all needed vars in one pass

### B. Token Lifecycle Management

No setup skill handles post-initial-setup scenarios:
- **Token rotation**: No skill to update an expired token and verify the new one works
- **Token audit**: No way to check what scopes a token has vs what's needed
- **Token sharing**: When onboarding a contributor, no guided flow exists
- **Expiration detection**: MCP server detects auth failures but doesn't suggest "your token may have expired"

### C. Consumer-Repo Onboarding

The current setup skill assumes you're in the ralph-hero repo. For consumer repos (repos that *use* ralph-hero as a plugin):
- `.gitignore` entries for `*.local.json` may not exist
- `ROUTING_PAT` secret needs to be created
- Repository variables need project-specific values (not defaults)
- The setup skill's Step 6b hard-codes `cdubiel08` and `3` as defaults in the repo variables table

### D. `ralph doctor` as First-Class Diagnostic

The `ralph doctor` command (`justfile:149-167`) should be the go-to diagnostic tool but is broken outside Claude Code. Fixing GH-634 (read `settings.local.json` directly) would make it useful for:
- Pre-setup validation ("do I have everything I need?")
- Post-rotation verification ("does my new token work?")
- CI debugging ("why is this workflow failing?")
- Cross-tool auth check (verify both MCP token and `gh auth` are valid)

### E. Defensive `.gitignore` in Setup Flow

The setup skill creates `settings.local.json` and `ralph-hero.local.md` but doesn't verify these patterns are in `.gitignore`. Adding a pre-write check would close the gap for consumer repos where Claude Code's global gitignore may not be configured.

### F. Unified Auth Verification

Scripts using `gh` CLI should have a common auth-check pattern. Only `demo-seed.sh` currently verifies `gh auth status`. A shared function in `hook-utils.sh` or a `gh-auth-check.sh` script could standardize this.

### G. Setup Skill Composability

The ralph-knowledge and ralph-playwright setup skills are lightweight and focused. The ralph-hero setup skill is 628 lines covering many scenarios. Breaking it into composable steps would allow:
- `setup-token`: Just token creation and verification
- `setup-project`: Just project creation/verification
- `setup-routing`: Just routing & sync configuration
- `setup-verify`: Just run all health checks

This mirrors the existing pattern of `setup-cli` and `setup-repos` being separate focused skills.

### H. Sub-Agent Environment Propagation

The agent-per-phase architecture (GH-674) addresses this at the architectural level. For setup skills specifically:
- Skills that spawn sub-agents should use backtick preprocessing for env vars
- `skill-precondition.sh` should recognize agent contexts via `agent_type` field
- SessionStart hooks should use `hookSpecificOutput.additionalContext` to inject resolved values

## Code References

- `plugin/ralph-hero/mcp-server/src/index.ts:33-69` — resolveEnv, token resolution, fatal guard
- `plugin/ralph-hero/mcp-server/src/index.ts:132-285` — health_check tool implementation
- `plugin/ralph-hero/mcp-server/src/github-client.ts:84-104` — dual-token client construction
- `plugin/ralph-hero/mcp-server/src/lib/helpers.ts:550-610` — resolveConfig, resolveFullConfig
- `plugin/ralph-hero/mcp-server/src/__tests__/init-config.test.ts:157-163` — forbidden vars contract test
- `plugin/ralph-hero/skills/setup/SKILL.md` — main setup skill (628 lines)
- `plugin/ralph-hero/skills/setup-cli/SKILL.md` — CLI setup skill
- `plugin/ralph-hero/skills/setup-repos/SKILL.md` — multi-repo registry setup
- `plugin/ralph-knowledge/skills/setup/SKILL.md` — knowledge index setup
- `plugin/ralph-knowledge/skills/setup-obsidian/SKILL.md` — Obsidian vault setup
- `plugin/ralph-playwright/skills/setup/SKILL.md` — Playwright browser setup
- `plugin/ralph-hero/hooks/scripts/set-skill-env.sh` — skill environment injection
- `plugin/ralph-hero/hooks/scripts/skill-precondition.sh` — RALPH_COMMAND validation
- `plugin/ralph-hero/hooks/scripts/gitignore-enforcement.sh` — write protection hook

## Historical Context (from thoughts/)

Six documents form a clear chain:
1. **GH-588** (Mar 17): Foundational fix — remove env block from `.mcp.json`
2. **GH-634** (Mar 19): Downstream consequence — `ralph doctor` can't see vars without env block
3. **GH-649** (Mar 21): Parallel concern — gitignore gaps expose secrets
4. **Agent env propagation** (Mar 24): Research revealing sub-agent token/hook failures
5. **GH-674** (Mar 24): Architectural fix — agent-per-phase to solve propagation
6. **Token management survey** (Mar 25): Horizontal mapping of all three auth systems

## Related Research

- [[2026-03-25-github-token-management-across-tools]] — comprehensive token landscape mapping
- [[2026-03-24-agent-env-propagation-token-scope]] — sub-agent environment failure analysis
- [[2026-03-19-GH-0634-doctor-settings-local-json-fallback]] — doctor CLI diagnostic gap
- [[2026-03-17-GH-0588-remove-mcp-env-block]] — env block removal plan
- [[2026-03-21-secret-protection-gitignore-enforcement]] — gitignore enforcement research
- [[2026-03-24-GH-0674-agent-per-phase-architecture]] — agent architecture fix plan

## Open Questions

1. Should ralph-hero optionally read from `gh auth token` as a convenience fallback (without reintroducing collision)?
2. Should root `.gitignore` gain defense-in-depth entries for `.claude/settings.local.json`?
3. Should setup skills verify `.gitignore` coverage before writing local files?
4. Should a PreToolUse hook on Bash inspect `git diff --cached` for token patterns before commits?
5. Is there value in a unified `setup-all` orchestrator that chains plugin setup skills?
6. Should token expiration be detected proactively (periodic health check) rather than reactively (auth failure)?
7. For consumer repos: should setup auto-detect missing `.gitignore` entries and offer to add them?
8. Would a `setup-token` sub-skill for rotation/update be worth the added surface area?
