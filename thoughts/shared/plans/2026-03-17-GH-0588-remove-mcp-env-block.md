---
date: 2026-03-17
status: draft
type: plan
tags: [mcp, configuration, env, plugin]
github_issue: 588
github_issues: [588]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/588
primary_issue: 588
---

# Remove .mcp.json env block — inherit parent environment

## Prior Work

- builds_on:: [[2026-03-17-plugin-mcp-env-passthrough]]

## Overview

Remove the explicit `env` block from `plugin/ralph-hero/.mcp.json` so the MCP server inherits the full parent process environment. This eliminates the maintenance burden of enumerating every env var in two places and matches the pattern used by ralph-knowledge.

## Current State Analysis

The `.mcp.json` env block acts as an explicit allowlist — only listed vars reach the child process. Currently it lists 3 of 10+ vars the server reads via `resolveEnv()`. PR #589 added a 4th (`RALPH_HERO_GITHUB_TOKEN`) but the remaining optional vars (`RALPH_GH_REPO_TOKEN`, `RALPH_GH_PROJECT_TOKEN`, `RALPH_GH_PROJECT_OWNER`, `RALPH_GH_PROJECT_NUMBERS`, `RALPH_GH_TEMPLATE_PROJECT`, `RALPH_HERO_AUTO`, `RALPH_DEBUG`) are still silently dropped.

The env block also contains developer-specific defaults (`cdubiel08`, `ralph-hero`, `3`) that shouldn't be in committed code — they belong in `settings.local.json`.

### Key Discoveries:
- `plugin/ralph-knowledge/.mcp.json` has no env block and works correctly
- Claude Code's env block is designed to MERGE with the parent environment (per official docs)
- `resolveEnv()` in `index.ts:31-36` already handles the case where vars are missing or unexpanded
- The setup skill already directs users to put all vars in `settings.local.json`
- `release.yml` runs `sed` on `.mcp.json` to update the version pin — unaffected by removing the env block

## Desired End State

`.mcp.json` has no `env` block. The MCP server inherits all environment variables from Claude Code's process, which includes everything from `settings.local.json`. All documentation reflects this change.

### How to verify:
1. Set `RALPH_HERO_GITHUB_TOKEN` and `RALPH_GH_OWNER` in `settings.local.json` only
2. Restart Claude Code
3. MCP server connects successfully
4. `npm test` passes

## What We're NOT Doing

- Migrating to HTTP transport (future consideration)
- Adding a `requiredEnv` field to `plugin.json` (doesn't exist in the schema)
- Changing how `resolveEnv()` works (still needed for edge cases)
- Updating the version pin (`@2.5.13` → latest) — separate concern

## Implementation Approach

Remove the env block, update documentation to reflect that the env block no longer exists, and update the contract test to document the new pattern.

## Phase 1: Remove env block from .mcp.json

### Overview
Remove the `env` key from the MCP server config, keeping `command`, `args`, and `cwd`.

### Changes Required:

#### 1. Plugin .mcp.json
**File**: `plugin/ralph-hero/.mcp.json`
**Changes**: Remove the `env` block entirely

Before:
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

After:
```json
{
  "mcpServers": {
    "ralph-github": {
      "command": "npx",
      "args": ["-y", "ralph-hero-mcp-server@2.5.13"],
      "cwd": "${CLAUDE_PLUGIN_ROOT}"
    }
  }
}
```

### Success Criteria:

#### Automated Verification:
- [ ] `npm run build` passes in `plugin/ralph-hero/mcp-server/`
- [ ] `npm test` passes in `plugin/ralph-hero/mcp-server/`

#### Manual Verification:
- [ ] Set env vars only in `settings.local.json`, restart Claude Code, verify MCP server connects

---

## Phase 2: Update documentation

### Overview
Update CLAUDE.md and the setup skill to reflect that there is no longer an env block in `.mcp.json`.

### Changes Required:

#### 1. CLAUDE.md
**File**: `CLAUDE.md`
**Changes**: Update the `resolveEnv()` gotcha (line 128) and the token warning (line 149)

Line 128 — update from:
```
- **`resolveEnv()` pattern**: Claude Code passes unexpanded `${VAR}` literals for unset env vars in `.mcp.json`. The `resolveEnv()` function in `index.ts` filters these out. Only non-sensitive defaults with fallbacks belong in `.mcp.json`.
```
To:
```
- **`resolveEnv()` pattern**: The MCP server inherits env vars from Claude Code's process (set via `settings.local.json`). `resolveEnv()` in `index.ts` filters out unexpanded `${VAR}` literals that may appear when vars are unset. The `.mcp.json` has no `env` block — all configuration flows through `settings.local.json`.
```

Line 149 — update from:
```
**Do NOT put tokens in `.mcp.json`** — the `env` block can overwrite inherited values with unexpanded `${VAR}` literals.
```
To:
```
**Do NOT put tokens in `.mcp.json`** — all env vars should be set in `.claude/settings.local.json` (gitignored). The `.mcp.json` has no `env` block; the MCP server inherits the parent environment.
```

#### 2. Setup skill
**File**: `plugin/ralph-hero/skills/setup/SKILL.md`
**Changes**: Update the three `.mcp.json` warnings (lines 54, 275, 327)

Line 54 — update from:
```
- **Don't put tokens in `.mcp.json`** — the `env` block can overwrite inherited values with unexpanded literals
```
To:
```
- **Don't put tokens in `.mcp.json`** — all env vars belong in `settings.local.json`, not in the plugin config
```

Lines 275 and 327 — update from:
```
**Important**: Do NOT put tokens in `.mcp.json` — the env block can mask inherited values.
```
To:
```
**Important**: Do NOT put tokens in `.mcp.json` — all env vars belong in `settings.local.json`.
```

### Success Criteria:

#### Automated Verification:
- [ ] No broken markdown (visual check)

#### Manual Verification:
- [ ] CLAUDE.md accurately describes current behavior
- [ ] Setup skill warnings are still clear and correct

---

## Phase 3: Update contract test

### Overview
Update the `.mcp.json contract` test to document that env vars are inherited (no env block) rather than explicitly passed.

### Changes Required:

#### 1. Contract test
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/init-config.test.ts`
**Changes**: Update the `.mcp.json contract` describe block (lines 138-169)

Update the test description and add a comment documenting the new contract:

```typescript
describe(".mcp.json contract", () => {
  it("should only accept RALPH_-prefixed env vars", () => {
    // Contract: .mcp.json has no env block — the MCP server inherits
    // the parent environment. Only RALPH_-prefixed vars are read by
    // resolveEnv(). This test documents which vars the server accepts.
    const acceptedVars = [
      "RALPH_GH_REPO_TOKEN",
      "RALPH_GH_PROJECT_TOKEN",
      "RALPH_HERO_GITHUB_TOKEN",
      "RALPH_GH_OWNER",
      "RALPH_GH_REPO",
      "RALPH_GH_PROJECT_OWNER",
      "RALPH_GH_PROJECT_NUMBER",
      "RALPH_GH_PROJECT_NUMBERS",
      "RALPH_GH_TEMPLATE_PROJECT",
      "RALPH_HERO_AUTO",
      "RALPH_DEBUG",
    ];

    const forbiddenVars = [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "GITHUB_OWNER",
      "GITHUB_REPO",
    ];

    for (const forbidden of forbiddenVars) {
      expect(acceptedVars).not.toContain(forbidden);
    }

    for (const accepted of acceptedVars) {
      expect(accepted).toMatch(/^RALPH_/);
    }
  });
});
```

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` passes in `plugin/ralph-hero/mcp-server/`
- [ ] `npm run build` passes in `plugin/ralph-hero/mcp-server/`

#### Manual Verification:
- [ ] Test accurately documents all env vars the server reads

---

## Testing Strategy

### Unit Tests:
- Existing token resolution tests remain valid (no changes needed)
- Contract test updated to reflect full list of accepted vars

### Manual Testing Steps:
1. Remove any env exports from shell profile
2. Set `RALPH_HERO_GITHUB_TOKEN`, `RALPH_GH_OWNER`, `RALPH_GH_PROJECT_NUMBER` in `settings.local.json` only
3. Restart Claude Code
4. Verify MCP server connects and tools work

## References

- Original issue: #588
- PR #589 (superseded by this approach)
- Research: `thoughts/shared/research/2026-03-17-plugin-mcp-env-passthrough.md`
- ralph-knowledge model: `plugin/ralph-knowledge/.mcp.json`
