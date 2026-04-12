---
date: 2026-03-25
status: draft
type: plan
tags: [userConfig, health-check, setup, tokens, security, WSL2]
github_issue: 684
github_issues: [684]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/684
primary_issue: 684
---

# Plugin userConfig + health_check Hardening + Setup Skill Rewrite

## Prior Work

- builds_on:: [[2026-03-25-token-management-setup-skill-improvement]]
- builds_on:: [[2026-03-25-github-token-management-across-tools]]
- builds_on:: [[2026-03-24-agent-env-propagation-token-scope]]
- builds_on:: [[2026-03-19-GH-0634-doctor-settings-local-json-fallback]]
- builds_on:: [[2026-03-17-GH-0588-remove-mcp-env-block]]
- builds_on:: [[2026-03-21-secret-protection-gitignore-enforcement]]

## Overview

Adopt Claude Code's `userConfig` manifest feature (v2.1.83+) so that the GitHub PAT is stored in the macOS Keychain (or `~/.claude/.credentials.json` with mode `0600` on WSL2/Linux) instead of plaintext `settings.local.json`. Only `github_token` goes into `userConfig` (sensitive: true). Owner, repo, and project number remain interactive setup-skill concerns written to `settings.local.json`. The health_check tool is extracted, enhanced with token source reporting and better error messages, and given full test coverage. The setup skill is rewritten to use `userConfig` as THE token delivery path with no manual fallback.

## Current State Analysis

### Token Storage
- Tokens live in `.claude/settings.local.json` under `"env"` — plaintext JSON, protected only by gitignore
- Users must manually create/edit this file, know the exact env var names, and restart Claude Code
- Consumer repos may lack `.gitignore` entries for `*.local.json`

### health_check Tool
- Anonymous handler inside `registerCoreTools()` at `index.ts:137-284` — not extractable for testing
- Auth check uses `viewer { login }` which succeeds with any valid token regardless of scopes
- Does not report which env var the token came from (only logs to stderr at startup)
- Zero test coverage — no test file exercises any health_check path
- `@octokit/graphql` strips HTTP response headers on success, so `X-OAuth-Scopes` is inaccessible

### Setup Skill
- 628-line `SKILL.md` with 7 steps + optional routing setup
- Guides users through manual `settings.local.json` editing
- Handles simple, split-owner, and dual-token flows
- No awareness of `userConfig` or `claude plugin configure`

### Key Discoveries
- `resolveEnv()` at `index.ts:33-38` already filters `${...}` literals — unresolved `${user_config.*}` values get filtered to `undefined` automatically
- Token resolution chain: `RALPH_GH_REPO_TOKEN` → `RALPH_HERO_GITHUB_TOKEN` → exit(1)
- `initGitHubClient()` is not exported and calls `process.exit(1)` — tests mirror logic locally
- Test patterns: `mockClient()` with `as unknown as GitHubClient` cast, env var clone-restore in beforeEach/afterEach
- `CLAUDE_PLUGIN_OPTION_*` env vars are auto-injected but not used anywhere in the codebase

## Desired End State

1. `plugin.json` declares `github_token` as `sensitive: true` userConfig — prompted at plugin enable time, stored in Keychain/credentials file
2. `.mcp.json` maps `${user_config.github_token}` → `RALPH_HERO_GITHUB_TOKEN` via env block
3. `health_check` is an exported, tested function that reports token source, gives clear scope-failure messages, and has full path coverage
4. Setup skill uses `claude plugin configure ralph-hero` for token delivery, interactive prompts for owner/repo/project, writes non-sensitive config to `settings.local.json`
5. WSL2 works correctly with file-based credential storage

### Verification
- `npm test` passes with new health_check tests covering success, fail, skip, and wrong-scopes paths
- `npm run build` passes with no type errors
- `ralph_hero__health_check` output includes `tokenSource` field
- Plugin enable flow prompts for token and stores it in Keychain (macOS) or `.credentials.json` (WSL2/Linux)
- Setup skill guides through interactive config without mentioning manual `settings.local.json` token editing

## What We're NOT Doing

- Adding `userConfig` for non-sensitive vars (owner, repo, project number) — these are setup-skill interactive concerns
- Adding `userConfig` to ralph-knowledge — no sensitive data, has sensible defaults
- Reading `X-OAuth-Scopes` headers — `@octokit/graphql` strips them; actual access testing is more reliable
- Adding `CLAUDE_PLUGIN_OPTION_*` reads to the MCP server — the `.mcp.json` env block mapping is cleaner
- Changing the token resolution chain in `initGitHubClient()` — it works as-is
- Dual-token `userConfig` fields — advanced users configure `RALPH_GH_REPO_TOKEN`/`RALPH_GH_PROJECT_TOKEN` via `settings.local.json` as before

## Implementation Approach

Three phases, each independently shippable. Phase 1 is pure manifest/config. Phase 2 is MCP server refactor + tests. Phase 3 is skill rewrite. No phase depends on another being deployed first — `resolveEnv()` handles both old (`settings.local.json`) and new (`userConfig` via env block) paths transparently.

---

## Phase 1: `userConfig` Manifest + `.mcp.json` Wiring

### Overview
Add `github_token` as a sensitive userConfig field to the plugin manifest and wire it through the `.mcp.json` env block to the existing `RALPH_HERO_GITHUB_TOKEN` env var.

### Changes Required

#### 1. Plugin Manifest
**File**: `plugin/ralph-hero/.claude-plugin/plugin.json`
**Changes**: Add `userConfig` section with `github_token` field

```json
{
  "name": "ralph-hero",
  "version": "2.5.49",
  "description": "...",
  "userConfig": {
    "github_token": {
      "description": "GitHub Personal Access Token with repo + project scopes (create at https://github.com/settings/tokens)",
      "sensitive": true
    }
  },
  "author": { ... },
  ...
}
```

#### 2. MCP Server Config
**File**: `plugin/ralph-hero/.mcp.json`
**Changes**: Add `env` block mapping userConfig to the existing RALPH env var

```json
{
  "mcpServers": {
    "ralph-github": {
      "command": "npx",
      "args": ["-y", "ralph-hero-mcp-server@2.5.42"],
      "cwd": "${CLAUDE_PLUGIN_ROOT}",
      "env": {
        "RALPH_HERO_GITHUB_TOKEN": "${user_config.github_token}"
      }
    }
  }
}
```

**Why only one env var in the block**: The old GH-588 problem was an env block that acted as an allowlist, silently dropping vars. This new block is additive — it maps one `userConfig` value while all other `RALPH_*` vars still inherit from the parent environment (`settings.local.json`). The `resolveEnv()` filter handles the case where `${user_config.github_token}` is unresolved (user hasn't configured yet) — it starts with `${` and gets filtered to `undefined`, then the parent-environment fallback kicks in.

#### 3. Contract Test Update
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/init-config.test.ts`
**Changes**: Add a test documenting that `userConfig`-delivered tokens flow through the same `RALPH_HERO_GITHUB_TOKEN` env var

```typescript
describe("userConfig delivery path", () => {
  it("token from userConfig arrives as RALPH_HERO_GITHUB_TOKEN", () => {
    // userConfig.github_token is mapped to RALPH_HERO_GITHUB_TOKEN
    // via .mcp.json env block: "${user_config.github_token}"
    // resolveEnv filters unresolved ${...} literals to undefined
    process.env.RALPH_HERO_GITHUB_TOKEN = "ghp_from_userconfig";
    const { repoToken } = resolveTokens();
    expect(repoToken).toBe("ghp_from_userconfig");
  });

  it("unresolved userConfig template is filtered by resolveEnv", () => {
    process.env.RALPH_HERO_GITHUB_TOKEN = "${user_config.github_token}";
    const { repoToken } = resolveTokens();
    expect(repoToken).toBeUndefined();
  });
});
```

### Success Criteria

#### Automated Verification:
- [ ] `npm run build` passes with no type errors
- [ ] `npm test` passes — new contract tests pass
- [ ] `plugin.json` is valid JSON with `userConfig.github_token.sensitive === true`

#### Manual Verification:
- [ ] On macOS: `claude plugin install` prompts for GitHub token, stores in Keychain
- [ ] On WSL2/Linux: `claude plugin install` prompts for token, stores in `~/.claude/.credentials.json` with mode `0600`
- [ ] MCP server starts and reads token from `RALPH_HERO_GITHUB_TOKEN` env var
- [ ] Existing `settings.local.json` users still work (parent env inheritance)
- [ ] `ralph_hero__health_check` returns `auth: ok` with userConfig-delivered token

---

## Phase 2: Extract and Harden health_check

### Overview
Extract the health_check handler into an exported, testable function. Add token source reporting to the output. Improve error messages for "auth passes but access denied" scenarios. Write comprehensive tests for all paths.

### Changes Required

#### 1. Extract health_check Handler
**File**: `plugin/ralph-hero/mcp-server/src/index.ts`
**Changes**: Extract the anonymous handler into an exported function in a new module

**New File**: `plugin/ralph-hero/mcp-server/src/lib/health-check.ts`

```typescript
import type { GitHubClient } from "../github-client.js";
import { resolveProjectOwner } from "../types.js";
import { toolSuccess } from "../types.js";
import type { ToolResult } from "../types.js";

export interface HealthCheckResult {
  status: "ok" | "issues_found";
  checks: Record<string, { status: string; detail?: string }>;
  config: {
    repoOwner: string;
    repo: string;
    projectOwner: string;
    projectNumber: number | string;
    tokenMode: "single-token" | "dual-token";
    tokenSource: string;
  };
}

export async function runHealthCheck(
  client: GitHubClient,
  tokenSource: string,
): Promise<HealthCheckResult> {
  const checks: Record<string, { status: string; detail?: string }> = {};

  // 1. Auth check (repo token)
  try {
    const login = await client.getAuthenticatedUser();
    checks.auth = { status: "ok", detail: `Authenticated as ${login}` };
  } catch (e) {
    checks.auth = {
      status: "fail",
      detail: `Auth failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // 2. Repo access check
  if (client.config.owner && client.config.repo) {
    try {
      await client.query<{ repository: { nameWithOwner: string } | null }>(
        `query($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) { nameWithOwner }
        }`,
        { owner: client.config.owner, repo: client.config.repo },
      );
      checks.repoAccess = {
        status: "ok",
        detail: `${client.config.owner}/${client.config.repo}`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      checks.repoAccess = {
        status: "fail",
        detail: checks.auth.status === "ok"
          ? `Authenticated successfully, but cannot access repo ${client.config.owner}/${client.config.repo}. Token likely lacks 'repo' scope or org SSO authorization. Re-run /ralph-hero:setup to reconfigure.`
          : `Cannot access repo: ${msg}`,
      };
    }
  } else {
    checks.repoAccess = {
      status: "skip",
      detail: "RALPH_GH_OWNER/RALPH_GH_REPO not set",
    };
  }

  // 3. Project access check (uses project token + project owner)
  const projOwner = resolveProjectOwner(client.config);
  const projNum = client.config.projectNumber;
  if (projOwner && projNum) {
    try {
      let project: {
        title: string;
        fields: { nodes: Array<{ name: string }> };
      } | null = null;

      for (const ownerType of ["user", "organization"]) {
        try {
          const result = await client.projectQuery<
            Record<
              string,
              {
                projectV2: {
                  title: string;
                  fields: { nodes: Array<{ name: string }> };
                } | null;
              }
            >
          >(
            `query($owner: String!, $number: Int!) {
              ${ownerType}(login: $owner) {
                projectV2(number: $number) {
                  title
                  fields(first: 50) {
                    nodes {
                      ... on ProjectV2FieldCommon { name }
                      ... on ProjectV2SingleSelectField { name }
                    }
                  }
                }
              }
            }`,
            { owner: projOwner, number: projNum },
          );
          project = result[ownerType]?.projectV2 ?? null;
          if (project) break;
        } catch {
          // Try next owner type
        }
      }

      if (project) {
        checks.projectAccess = {
          status: "ok",
          detail: `${project.title} (#${projNum})`,
        };

        // 4. Required fields check
        const requiredFields = ["Workflow State", "Priority", "Estimate"];
        const fieldNames = project.fields.nodes.map((f) => f.name);
        const missing = requiredFields.filter(
          (f) => !fieldNames.includes(f),
        );
        if (missing.length === 0) {
          checks.requiredFields = {
            status: "ok",
            detail: "All required fields present",
          };
        } else {
          checks.requiredFields = {
            status: "fail",
            detail: `Missing fields: ${missing.join(", ")}. Run /ralph-hero:setup.`,
          };
        }
      } else {
        checks.projectAccess = {
          status: "fail",
          detail: `Project #${projNum} not found for owner "${projOwner}". Check RALPH_GH_PROJECT_OWNER.`,
        };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      checks.projectAccess = {
        status: "fail",
        detail: checks.auth.status === "ok"
          ? `Authenticated successfully, but cannot access project #${projNum}. Token likely lacks 'project' scope. Re-run /ralph-hero:setup to reconfigure.`
          : `Project access failed: ${msg}`,
      };
    }
  } else {
    checks.projectAccess = {
      status: "skip",
      detail: "RALPH_GH_PROJECT_NUMBER not set",
    };
  }

  // Summary
  const allOk = Object.values(checks).every(
    (c) => c.status === "ok" || c.status === "skip",
  );

  return {
    status: allOk ? "ok" : "issues_found",
    checks,
    config: {
      repoOwner: client.config.owner || "(not set)",
      repo: client.config.repo || "(not set)",
      projectOwner: resolveProjectOwner(client.config) || "(not set)",
      projectNumber: client.config.projectNumber || "(not set)",
      tokenMode:
        client.config.projectToken &&
        client.config.projectToken !== client.config.token
          ? "dual-token"
          : "single-token",
      tokenSource,
    },
  };
}
```

#### 2. Update `registerCoreTools` to Use Extracted Function
**File**: `plugin/ralph-hero/mcp-server/src/index.ts`
**Changes**: Replace inline handler with call to `runHealthCheck()`, pass `tokenSource` string computed during `initGitHubClient()`

In `initGitHubClient()`, compute and return `tokenSource`:
```typescript
const tokenSource = resolveEnv("RALPH_GH_REPO_TOKEN")
  ? "RALPH_GH_REPO_TOKEN"
  : "RALPH_HERO_GITHUB_TOKEN";
```

Store `tokenSource` on client config or pass through to `registerCoreTools`. In the tool registration:

```typescript
import { runHealthCheck } from "./lib/health-check.js";

function registerCoreTools(server: McpServer, client: GitHubClient, tokenSource: string): void {
  server.tool(
    "ralph_hero__health_check",
    "Validate GitHub API connectivity, token permissions, repo access, project access, and required fields",
    {},
    async () => {
      const result = await runHealthCheck(client, tokenSource);
      return toolSuccess(result);
    },
  );
}
```

#### 3. Add `tokenSource` to `GitHubClientConfig`
**File**: `plugin/ralph-hero/mcp-server/src/types.ts`
**Changes**: Add optional `tokenSource` field to `GitHubClientConfig`

```typescript
export interface GitHubClientConfig {
  token: string;
  projectToken?: string;
  owner?: string;
  repo?: string;
  // ... existing fields ...
  tokenSource?: string; // "RALPH_GH_REPO_TOKEN" | "RALPH_HERO_GITHUB_TOKEN"
}
```

This lets `tokenSource` flow through `client.config.tokenSource` instead of requiring a separate parameter chain. Update `initGitHubClient()` to set `config.tokenSource` and `registerCoreTools` to read `client.config.tokenSource`.

#### 4. Comprehensive Test Suite
**New File**: `plugin/ralph-hero/mcp-server/src/__tests__/health-check.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { runHealthCheck } from "../lib/health-check.js";
import type { GitHubClient } from "../github-client.js";
import type { GitHubClientConfig } from "../types.js";

function mockClient(
  config: Partial<GitHubClientConfig>,
  overrides: {
    getAuthenticatedUser?: () => Promise<string>;
    query?: (...args: unknown[]) => Promise<unknown>;
    projectQuery?: (...args: unknown[]) => Promise<unknown>;
  } = {},
): GitHubClient {
  return {
    config: {
      token: "test-token",
      owner: "test-owner",
      repo: "test-repo",
      projectNumber: 3,
      projectOwner: "test-owner",
      ...config,
    },
    getAuthenticatedUser: overrides.getAuthenticatedUser ?? vi.fn().mockResolvedValue("test-user"),
    query: overrides.query ?? vi.fn().mockResolvedValue({ repository: { nameWithOwner: "test-owner/test-repo" } }),
    projectQuery: overrides.projectQuery ?? vi.fn().mockResolvedValue({
      user: {
        projectV2: {
          title: "Test Project",
          fields: {
            nodes: [
              { name: "Workflow State" },
              { name: "Priority" },
              { name: "Estimate" },
            ],
          },
        },
      },
    }),
  } as unknown as GitHubClient;
}

describe("runHealthCheck", () => {
  describe("all checks pass", () => {
    it("returns ok status with all checks green", async () => {
      const client = mockClient({});
      const result = await runHealthCheck(client, "RALPH_HERO_GITHUB_TOKEN");

      expect(result.status).toBe("ok");
      expect(result.checks.auth.status).toBe("ok");
      expect(result.checks.auth.detail).toContain("test-user");
      expect(result.checks.repoAccess.status).toBe("ok");
      expect(result.checks.projectAccess.status).toBe("ok");
      expect(result.checks.requiredFields.status).toBe("ok");
    });

    it("includes tokenSource in config output", async () => {
      const client = mockClient({});
      const result = await runHealthCheck(client, "RALPH_GH_REPO_TOKEN");

      expect(result.config.tokenSource).toBe("RALPH_GH_REPO_TOKEN");
      expect(result.config.tokenMode).toBe("single-token");
    });

    it("reports dual-token mode when project token differs", async () => {
      const client = mockClient({ projectToken: "different-token" });
      const result = await runHealthCheck(client, "RALPH_GH_REPO_TOKEN");

      expect(result.config.tokenMode).toBe("dual-token");
    });
  });

  describe("auth failure", () => {
    it("returns fail with error message", async () => {
      const client = mockClient({}, {
        getAuthenticatedUser: vi.fn().mockRejectedValue(new Error("Bad credentials")),
      });
      const result = await runHealthCheck(client, "RALPH_HERO_GITHUB_TOKEN");

      expect(result.status).toBe("issues_found");
      expect(result.checks.auth.status).toBe("fail");
      expect(result.checks.auth.detail).toContain("Bad credentials");
    });
  });

  describe("repo access failure with auth success", () => {
    it("gives scope-specific error message", async () => {
      const client = mockClient({}, {
        query: vi.fn().mockRejectedValue(new Error("Resource not accessible")),
      });
      const result = await runHealthCheck(client, "RALPH_HERO_GITHUB_TOKEN");

      expect(result.checks.auth.status).toBe("ok");
      expect(result.checks.repoAccess.status).toBe("fail");
      expect(result.checks.repoAccess.detail).toContain("Authenticated successfully");
      expect(result.checks.repoAccess.detail).toContain("'repo' scope");
    });
  });

  describe("project access failure with auth success", () => {
    it("gives scope-specific error message", async () => {
      const client = mockClient({}, {
        projectQuery: vi.fn().mockRejectedValue(new Error("Resource not accessible")),
      });
      const result = await runHealthCheck(client, "RALPH_HERO_GITHUB_TOKEN");

      expect(result.checks.auth.status).toBe("ok");
      expect(result.checks.projectAccess.status).toBe("fail");
      expect(result.checks.projectAccess.detail).toContain("Authenticated successfully");
      expect(result.checks.projectAccess.detail).toContain("'project' scope");
    });
  });

  describe("missing required fields", () => {
    it("reports which fields are missing", async () => {
      const client = mockClient({}, {
        projectQuery: vi.fn().mockResolvedValue({
          user: {
            projectV2: {
              title: "Test Project",
              fields: {
                nodes: [{ name: "Workflow State" }],
              },
            },
          },
        }),
      });
      const result = await runHealthCheck(client, "RALPH_HERO_GITHUB_TOKEN");

      expect(result.checks.requiredFields.status).toBe("fail");
      expect(result.checks.requiredFields.detail).toContain("Priority");
      expect(result.checks.requiredFields.detail).toContain("Estimate");
    });
  });

  describe("skip conditions", () => {
    it("skips repo access when owner/repo not set", async () => {
      const client = mockClient({ owner: undefined, repo: undefined });
      const result = await runHealthCheck(client, "RALPH_HERO_GITHUB_TOKEN");

      expect(result.checks.repoAccess.status).toBe("skip");
    });

    it("skips project access when project number not set", async () => {
      const client = mockClient({ projectNumber: undefined });
      const result = await runHealthCheck(client, "RALPH_HERO_GITHUB_TOKEN");

      expect(result.checks.projectAccess.status).toBe("skip");
    });

    it("skipped checks still count as ok in summary", async () => {
      const client = mockClient({ owner: undefined, repo: undefined, projectNumber: undefined });
      const result = await runHealthCheck(client, "RALPH_HERO_GITHUB_TOKEN");

      expect(result.status).toBe("ok");
    });
  });

  describe("project not found (null after trying user + org)", () => {
    it("reports project not found with owner hint", async () => {
      const client = mockClient({}, {
        projectQuery: vi.fn().mockResolvedValue({ user: { projectV2: null } }),
      });
      const result = await runHealthCheck(client, "RALPH_HERO_GITHUB_TOKEN");

      expect(result.checks.projectAccess.status).toBe("fail");
      expect(result.checks.projectAccess.detail).toContain("not found");
      expect(result.checks.projectAccess.detail).toContain("RALPH_GH_PROJECT_OWNER");
    });
  });
});
```

### Success Criteria

#### Automated Verification:
- [ ] `npm run build` passes — new module compiles, imports resolve
- [ ] `npm test` passes — all health-check test paths green
- [ ] `npx vitest run src/__tests__/health-check.test.ts` — at least 8 tests covering success, auth fail, repo fail with scope hint, project fail with scope hint, missing fields, skip owner, skip project, project not found

#### Manual Verification:
- [ ] `ralph_hero__health_check` output includes `tokenSource` field showing which env var delivered the token
- [ ] When auth passes but repo access fails, error message says "Authenticated successfully, but cannot access repo..." with scope guidance
- [ ] When auth passes but project access fails, error message says "Authenticated successfully, but cannot access project..." with scope guidance

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Rewrite Setup Skill

### Overview
Rewrite `plugin/ralph-hero/skills/setup/SKILL.md` to use `userConfig` as THE token delivery path. Two interactive flows: simple owner (same owner for repo and project) and split-owner (org repo + personal project). Token via `claude plugin configure ralph-hero`. Non-sensitive config (owner, repo, project number) written to `settings.local.json` interactively. WSL2-specific notes included.

### Changes Required

#### 1. Setup Skill Rewrite
**File**: `plugin/ralph-hero/skills/setup/SKILL.md`
**Changes**: Full rewrite. Key structural changes:

**New Step 1: Detect Token**
- Call `ralph_hero__health_check`
- If `auth: ok` → token is already configured, skip to Step 3
- If `auth: fail` → guide through `claude plugin configure ralph-hero`
- Display platform-specific note:
  ```
  Your token will be stored securely:
  - macOS: System Keychain (encrypted, OS-managed)
  - WSL2/Linux: ~/.claude/.credentials.json (mode 0600, user-only access)
  ```
- After token is configured, tell user to restart Claude Code, then re-run `/ralph-hero:setup`

**New Step 2: Choose Setup Mode**
- Ask using AskUserQuestion:
  - **"Same owner for repo and project"** — single GitHub user/org owns both
  - **"Split setup (org repo + personal project)"** — org owns the repo, personal account owns the project
- Record the chosen mode

**New Step 3: Collect Configuration**
- For **simple mode**: ask for owner, repo name(s), project number (or offer to create)
- For **split mode**: ask for org owner, repo name(s), personal GitHub username, project number (or offer to create)
- Write non-sensitive config to `.claude/settings.local.json`:
  ```json
  {
    "env": {
      "RALPH_GH_OWNER": "[owner]",
      "RALPH_GH_REPO": "[repo]",
      "RALPH_GH_PROJECT_NUMBER": "[number]"
    }
  }
  ```
- For split mode, also include:
  ```json
  {
    "env": {
      "RALPH_GH_PROJECT_OWNER": "[personal-username]"
    }
  }
  ```
- Tell user to restart Claude Code after writing settings

**New Step 4: Create or Verify Project** (same as current Step 3)
- Call `ralph_hero__setup_project` if no project exists
- Verify required fields if project exists

**New Step 5: Store Configuration** (same as current Step 5, minus token instructions)
- Write `.claude/ralph-hero.local.md` with project settings, workflow states
- No token references in the local config file

**New Step 6: Verify Setup** (same as current Step 6)
- Call `ralph_hero__health_check` — all checks must pass
- Report `tokenSource` from health_check output to confirm token delivery path

**New Step 6b: Enable Routing & Sync** (same as current Step 6b)
- Unchanged — ROUTING_PAT secret, repo variables, routing config

**New Step 7: Final Report**
- Show setup summary including:
  ```
  Token: Stored securely via plugin config (tokenSource: RALPH_HERO_GITHUB_TOKEN)
  ```
- Next steps (same as current, minus "verify settings.local.json has your token")

**WSL2 Notes** (included in Step 1 token guidance):
```
WSL2 Users:
- Your token is stored in ~/.claude/.credentials.json (not Windows Credential Manager)
- File permissions: mode 0600 (only your user can read)
- If the OAuth browser flow fails, press 'c' to copy the URL and paste into your Windows browser
- Set BROWSER="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" for auto-open
```

**Dual-Token Note** (included in split-owner flow):
```
Advanced: Dual-Token Setup
If your org requires separate tokens for repo and project access:
1. Configure the primary token via plugin config (already done above)
2. Add the second token to .claude/settings.local.json:
   {
     "env": {
       "RALPH_GH_REPO_TOKEN": "ghp_org_repo_token",
       "RALPH_GH_PROJECT_TOKEN": "ghp_personal_project_token"
     }
   }
3. Restart Claude Code
```

### Success Criteria

#### Automated Verification:
- [ ] `SKILL.md` is valid markdown with correct YAML frontmatter
- [ ] All tool references in `allowed-tools` match existing MCP tool names
- [ ] No references to manual token editing in `settings.local.json` as a primary path

#### Manual Verification:
- [ ] Fresh setup on macOS: prompted for token via `claude plugin configure`, guided through owner/repo/project interactively, health_check passes
- [ ] Fresh setup on WSL2: prompted for token, stored in `~/.claude/.credentials.json`, health_check passes
- [ ] Existing user upgrade: health_check passes with token from `settings.local.json` (backward compatible)
- [ ] Split-owner flow: org owner for repo, personal owner for project, both accessible
- [ ] Project creation flow: `setup_project` creates project when none exists
- [ ] Routing setup flow: ROUTING_PAT guidance, repo variables, routing config stub

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding.

---

## Testing Strategy

### Unit Tests (Phase 2):
- `health-check.test.ts` — all paths: success, auth fail, repo fail with scope hint, project fail with scope hint, missing fields, skip conditions, project not found, dual-token mode, tokenSource reporting
- `init-config.test.ts` — new tests for userConfig delivery path and unresolved template filtering

### Integration Tests:
- Manual: `claude plugin install` → token prompt → MCP server starts → health_check passes
- Manual: WSL2 end-to-end with file-based credential storage

### Manual Testing Steps:
1. Fresh macOS install: enable plugin → prompted for token → setup skill → health_check all green
2. Fresh WSL2 install: enable plugin → prompted for token → verify `~/.claude/.credentials.json` exists with `0600` → setup skill → health_check all green
3. Existing user: no `userConfig` configured → `settings.local.json` token still works → health_check reports correct `tokenSource`
4. Wrong scopes: valid token with no `repo` scope → health_check reports "Authenticated successfully, but cannot access repo..."
5. Split-owner: org repo + personal project → both accessible → health_check all green

## Performance Considerations

None. The health_check extraction adds no overhead — same logic, same queries, just in a separate module.

## Migration Notes

**Backward compatibility**: Existing users with tokens in `settings.local.json` continue to work with no changes. The `resolveEnv()` chain resolves `RALPH_HERO_GITHUB_TOKEN` from whichever source provides it first — `userConfig` via `.mcp.json` env block, or parent environment via `settings.local.json`. No migration required.

**Consumer repos**: The setup skill rewrite benefits consumer repos most — they get the same `claude plugin configure` flow without needing to know about `settings.local.json` or env var names.

## Platform Behavior Matrix

| Platform | Token Storage | Protection | OAuth Flow | Known Issues |
|----------|--------------|------------|------------|--------------|
| macOS | System Keychain | OS-encrypted | Browser redirect | None |
| WSL2 | `~/.claude/.credentials.json` | mode `0600` | May need manual URL copy | [#20756](https://github.com/anthropics/claude-code/issues/20756) |
| Linux | `~/.claude/.credentials.json` | mode `0600` | Browser redirect | None known |
| Windows (native) | `~/.claude/.credentials.json` | NTFS ACLs | May not persist | [#29049](https://github.com/anthropics/claude-code/issues/29049) |

## References

- Research: `thoughts/shared/research/2026-03-25-token-management-setup-skill-improvement.md`
- Research: `thoughts/shared/research/2026-03-25-github-token-management-across-tools.md`
- Claude Code docs: [Plugins Reference — User configuration](https://code.claude.com/docs/en/plugins-reference#user-configuration)
- Claude Code docs: [Authentication](https://code.claude.com/docs/en/authentication)
- Current setup skill: `plugin/ralph-hero/skills/setup/SKILL.md`
- health_check impl: `plugin/ralph-hero/mcp-server/src/index.ts:131-286`
- Token resolution: `plugin/ralph-hero/mcp-server/src/index.ts:33-125`
- Contract tests: `plugin/ralph-hero/mcp-server/src/__tests__/init-config.test.ts`
