---
date: 2026-03-25
status: draft
type: plan
github_issue: 685
github_issues: [685, 686, 687]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/685
  - https://github.com/cdubiel08/ralph-hero/issues/686
  - https://github.com/cdubiel08/ralph-hero/issues/687
primary_issue: 685
parent_plan: thoughts/shared/plans/2026-03-25-GH-0684-userconfig-healthcheck-setup-rewrite.md
tags: [userconfig, health-check, setup, tokens, security, mcp-server]
---

# userConfig + health_check + Setup Rewrite — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-25-GH-0684-userconfig-healthcheck-setup-rewrite]]
- builds_on:: [[2026-03-25-token-management-setup-skill-improvement]]
- builds_on:: [[2026-03-25-github-token-management-across-tools]]
- builds_on:: [[2026-03-24-agent-env-propagation-token-scope]]
- builds_on:: [[2026-03-17-GH-0588-remove-mcp-env-block]]
- builds_on:: [[2026-03-21-secret-protection-gitignore-enforcement]]

## Overview

3 related issues for atomic implementation across three PRs (each independently shippable):

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-685 | Add userConfig manifest for secure token storage + .mcp.json env wiring | XS |
| 2 | GH-686 | Extract and harden health_check with token source reporting and full test coverage | S |
| 3 | GH-687 | Rewrite setup skill to use userConfig for token delivery | S |

**Why grouped**: All three phases implement the same security initiative — migrating token delivery from plaintext `settings.local.json` to the Claude Code `userConfig` / Keychain mechanism. Each phase is independently shippable but references output from prior phases. Phase 1 provides the manifest changes that Phase 3's setup skill guides users through. Phase 2 provides the `tokenSource` field that Phase 3 displays in its final report. No phase is a hard prerequisite for any other from a code dependency standpoint.

## Shared Constraints

Inherited from parent plan GH-684:

1. **`resolveEnv()` is the boundary**: It already filters `${user_config.*}` unresolved literals — no changes needed to that function. Token resolution chain (`RALPH_GH_REPO_TOKEN` → `RALPH_HERO_GITHUB_TOKEN`) is unchanged.
2. **Only `github_token` goes into `userConfig`**: Owner, repo, project number remain in `settings.local.json` and are handled by the setup skill interactively. Do NOT add `userConfig` fields for non-sensitive config.
3. **Backward compatibility is non-negotiable**: Existing users with tokens in `settings.local.json` must continue to work with zero changes. The `resolveEnv()` chain resolves `RALPH_HERO_GITHUB_TOKEN` from whichever source provides it first.
4. **`@octokit/graphql` strips HTTP response headers**: Do NOT attempt to read `X-OAuth-Scopes` header. Use actual access tests (query the repo/project) to detect scope issues.
5. **ESM import conventions**: All internal imports use `.js` extensions. Project uses `"type": "module"` with `"module": "NodeNext"`.
6. **Test pattern**: Use `mockClient()` with `as unknown as GitHubClient` cast. Env var isolation via `process.env = { ...originalEnv }` in `beforeEach`, restore in `afterEach`.
7. **`initGitHubClient()` is not exported and calls `process.exit(1)`**: Tests mirror its logic locally (as in `init-config.test.ts`) rather than importing it.
8. **`.mcp.json` env block is additive**: The new `env` block adds one mapping (`RALPH_HERO_GITHUB_TOKEN`) while all other `RALPH_*` vars still inherit from the parent environment. This avoids the GH-588 allowlist problem.

## Current State Analysis

### Token Storage (before this group)
- Tokens live in `.claude/settings.local.json` under `"env"` — plaintext JSON, protected only by gitignore
- `plugin.json` has no `userConfig` section
- `.mcp.json` has no `env` block (correct per GH-588 fix, but userConfig wiring not yet present)

### health_check Tool (before this group)
- Anonymous handler inside `registerCoreTools()` at [`index.ts:131-286`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts#L131-L286)
- Not extractable for testing; zero test coverage
- Config output includes `tokenMode` but no `tokenSource` field
- Scope-failure error messages are generic ("Token may lack 'repo' scope") without the "Authenticated successfully, but..." context

### Setup Skill (before this group)
- [`plugin/ralph-hero/skills/setup/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/setup/SKILL.md): Quick Start instructs users to manually edit `settings.local.json` with `RALPH_HERO_GITHUB_TOKEN`
- No awareness of `userConfig` or `claude plugin configure ralph-hero`

### Key Architectural Facts
- `repoTokenSource` string is already computed at [`index.ts:103-106`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts#L103-L106) and logged to stderr — but not surfaced to callers
- `GitHubClientConfig` at [`types.ts:283-294`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L283-L294) has no `tokenSource` field yet
- `resolveProjectOwner()` at [`types.ts:296-300`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L296-L300) already works correctly — reuse in extracted `health-check.ts`

## Desired End State

1. `plugin.json` declares `github_token` as `sensitive: true` userConfig — prompted at plugin enable time, stored in Keychain/credentials file
2. `.mcp.json` maps `${user_config.github_token}` → `RALPH_HERO_GITHUB_TOKEN` via env block
3. `health_check` is an exported, tested function reporting `tokenSource` with full path coverage (at least 8 test cases)
4. Setup skill guides users through `claude plugin configure ralph-hero` for token delivery, not manual `settings.local.json` editing

### Verification
- [ ] `npm run build` passes with no type errors after all three phases
- [ ] `npm test` passes — new health-check and userConfig contract tests green
- [ ] `ralph_hero__health_check` output includes `tokenSource` field
- [ ] Plugin enable flow prompts for token (manual test, macOS Keychain or WSL2 credentials file)
- [ ] Setup skill guidance references `claude plugin configure` not manual token editing

## What We're NOT Doing

- Adding `userConfig` for non-sensitive vars (owner, repo, project number)
- Adding `userConfig` to ralph-knowledge
- Reading `X-OAuth-Scopes` headers (stripped by `@octokit/graphql`)
- Adding `CLAUDE_PLUGIN_OPTION_*` reads to the MCP server
- Changing the token resolution chain in `initGitHubClient()`
- Dual-token `userConfig` fields — advanced users configure `RALPH_GH_REPO_TOKEN`/`RALPH_GH_PROJECT_TOKEN` via `settings.local.json` as before

## Implementation Approach

Phase 1 (pure config): Add `userConfig` to `plugin.json` and `env` block to `.mcp.json`. No TypeScript changes. Add two contract tests documenting the delivery path. Independent of Phases 2 and 3.

Phase 2 (MCP server refactor + tests): Extract the inline health_check handler into `src/lib/health-check.ts` as an exported function. Add `tokenSource` to `GitHubClientConfig`. Wire `tokenSource` from `initGitHubClient()` through `registerCoreTools()` to the extracted function. Write comprehensive tests.

Phase 3 (skill rewrite): Rewrite `skills/setup/SKILL.md` to use `claude plugin configure ralph-hero` as the token delivery path. Health check's `tokenSource` field from Phase 2 is displayed in the final report to confirm delivery.

---

## Phase 1: userConfig Manifest + .mcp.json Wiring (GH-685)

### Overview

Add `github_token` as a sensitive userConfig field to `plugin.json` and wire it through a new `.mcp.json` `env` block to the existing `RALPH_HERO_GITHUB_TOKEN` env var. Add two contract tests documenting the new delivery path.

### Tasks

#### Task 1.1: Add userConfig section to plugin.json
- **files**: `plugin/ralph-hero/.claude-plugin/plugin.json` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `plugin.json` is valid JSON after change
  - [ ] New top-level `"userConfig"` key with `"github_token"` field
  - [ ] `github_token` has `"description"` (referencing github.com/settings/tokens and required scopes `repo`, `project`) and `"sensitive": true`
  - [ ] All existing keys (`name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`) are unchanged
  - [ ] `npm run build` (from `plugin/ralph-hero/mcp-server/`) passes — plugin.json is not compiled but should remain parseable

#### Task 1.2: Add env block to .mcp.json
- **files**: `plugin/ralph-hero/.mcp.json` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `.mcp.json` is valid JSON after change
  - [ ] `mcpServers.ralph-github` has a new `"env"` key with exactly one entry: `"RALPH_HERO_GITHUB_TOKEN": "${user_config.github_token}"`
  - [ ] Existing keys (`command`, `args`, `cwd`) are unchanged
  - [ ] No other `RALPH_*` vars are added to the `env` block (additive, not allowlist)

#### Task 1.3: Add userConfig delivery contract tests
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/init-config.test.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - [ ] New `describe("userConfig delivery path")` block with two `it()` tests appended to the existing file
  - [ ] Test 1: sets `process.env.RALPH_HERO_GITHUB_TOKEN = "ghp_from_userconfig"`, calls `resolveTokens()` (the local mirror function already in the file at line 35-42), expects `repoToken === "ghp_from_userconfig"`. Test name: `"token from userConfig arrives as RALPH_HERO_GITHUB_TOKEN"`
  - [ ] Test 2: sets `process.env.RALPH_HERO_GITHUB_TOKEN = "${user_config.github_token}"`, calls a local `resolveEnvMirror()` helper (mirrors `resolveEnv()` from `index.ts:33-37`: returns `undefined` if value starts with `${`), expects result to be `undefined`. Test name: `"unresolved userConfig template is filtered by resolveEnv"`
  - [ ] Both tests use the existing `beforeEach`/`afterEach` env clone-restore pattern (see lines 13-29 of `init-config.test.ts`)
  - [ ] `npx vitest run src/__tests__/init-config.test.ts` (from `plugin/ralph-hero/mcp-server/`) passes with all tests green

### Phase Success Criteria

#### Automated Verification:
- [x] `npm run build` (from `plugin/ralph-hero/mcp-server/`) — no errors
- [x] `npx vitest run src/__tests__/init-config.test.ts` — all tests pass including the two new userConfig delivery tests

#### Manual Verification:
- [ ] `cat plugin/ralph-hero/.claude-plugin/plugin.json | python3 -m json.tool` validates cleanly
- [ ] `cat plugin/ralph-hero/.mcp.json | python3 -m json.tool` validates cleanly
- [ ] Existing `settings.local.json` users still work (parent env inheritance — `RALPH_HERO_GITHUB_TOKEN` set in `settings.local.json` still flows through unchanged)

**Creates for next phase**: `plugin.json` `userConfig.github_token` definition that Phase 3's setup skill instructions will reference. `.mcp.json` env block that delivers the token from Keychain to `RALPH_HERO_GITHUB_TOKEN`.

---

## Phase 2: Extract and Harden health_check (GH-686)

### Overview

Extract the inline health_check handler from `index.ts` into an exported, testable `src/lib/health-check.ts` module. Add `tokenSource` to `GitHubClientConfig` so it flows from `initGitHubClient()` to the tool. Improve scope-failure error messages. Write comprehensive tests.

### Tasks

#### Task 2.1: Add tokenSource to GitHubClientConfig
- **files**: `plugin/ralph-hero/mcp-server/src/types.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `GitHubClientConfig` interface (line 283) gains an optional field: `tokenSource?: string;`
  - [ ] JSDoc comment for the field: `// "RALPH_GH_REPO_TOKEN" | "RALPH_HERO_GITHUB_TOKEN"`
  - [ ] All existing fields and their types are unchanged
  - [ ] `npm run build` passes — no type errors

#### Task 2.2: Set tokenSource in initGitHubClient
- **files**: `plugin/ralph-hero/mcp-server/src/index.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] After Task 2.1 adds `tokenSource` to `GitHubClientConfig`, the `createGitHubClient()` call at line 114 includes `tokenSource: resolveEnv("RALPH_GH_REPO_TOKEN") ? "RALPH_GH_REPO_TOKEN" : "RALPH_HERO_GITHUB_TOKEN"`
  - [ ] The existing `console.error(\`[ralph-hero] Repo token: ${repoTokenSource}\`)` at line 106 is preserved (still logs to stderr)
  - [ ] No other changes to `initGitHubClient()`
  - [ ] `npm run build` passes

#### Task 2.3: Create src/lib/health-check.ts
- **files**: `plugin/ralph-hero/mcp-server/src/lib/health-check.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] File exports `HealthCheckResult` interface and `runHealthCheck()` async function
  - [ ] `HealthCheckResult` has fields: `status: "ok" | "issues_found"`, `checks: Record<string, { status: string; detail?: string }>`, `config: { repoOwner, repo, projectOwner, projectNumber, tokenMode: "single-token" | "dual-token", tokenSource: string }`
  - [ ] `runHealthCheck(client: GitHubClient, tokenSource: string): Promise<HealthCheckResult>` implements the same 4-check logic as the inline handler (auth → repoAccess → projectAccess → requiredFields) with one key improvement: when auth passes but repo/project access fails, the error detail says `"Authenticated successfully, but cannot access repo/project..."` with scope guidance
  - [ ] Project not found path (null after trying both `user` and `organization` ownerTypes) returns `checks.projectAccess.status === "fail"` with detail containing "not found" and "RALPH_GH_PROJECT_OWNER"
  - [ ] All imports use `.js` extensions
  - [ ] Imports `resolveProjectOwner` from `"../types.js"` (not redefined)
  - [ ] Does NOT import from `"../index.js"` (no circular dependency)
  - [ ] `npm run build` passes — new module compiles

#### Task 2.4: Replace inline handler in registerCoreTools
- **files**: `plugin/ralph-hero/mcp-server/src/index.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.2, 2.3]
- **acceptance**:
  - [ ] Add import: `import { runHealthCheck } from "./lib/health-check.js";` at the top of the file with other lib imports
  - [ ] `registerCoreTools` signature changes from `(server: McpServer, client: GitHubClient)` to `(server: McpServer, client: GitHubClient)` — no signature change needed; `tokenSource` is read from `client.config.tokenSource`
  - [ ] The anonymous tool handler body (lines 137-284) is replaced with: `const result = await runHealthCheck(client, client.config.tokenSource ?? "RALPH_HERO_GITHUB_TOKEN"); return toolSuccess(result);`
  - [ ] The `registerCoreTools(server, client)` call site at line 352 is unchanged
  - [ ] `npm run build` passes — no unused imports, no type errors
  - [ ] `npm test` passes — existing tests still green

#### Task 2.5: Write health-check test suite
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/health-check.test.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [2.3]
- **acceptance**:
  - [ ] File uses `import { describe, it, expect, vi } from "vitest"` (no `beforeEach`/`afterEach` needed — tests are pure function calls)
  - [ ] Defines local `mockClient()` factory following the pattern from other test files (e.g., `decompose-tools.test.ts`): returns object cast `as unknown as GitHubClient`
  - [ ] `mockClient()` sets `config` with `token`, `owner: "test-owner"`, `repo: "test-repo"`, `projectNumber: 3`, `projectOwner: "test-owner"` plus any `Partial<GitHubClientConfig>` overrides
  - [ ] `mockClient()` sets default method mocks: `getAuthenticatedUser` resolves `"test-user"`, `query` resolves valid repo response, `projectQuery` resolves valid project with all 3 required fields (`Workflow State`, `Priority`, `Estimate`) via `user.projectV2`
  - [ ] Test cases (minimum 8, all in `describe("runHealthCheck")` sub-groups):
    1. `"returns ok status with all checks green"` — asserts `result.status === "ok"`, all four check statuses === "ok"
    2. `"includes tokenSource in config output"` — asserts `result.config.tokenSource === "RALPH_GH_REPO_TOKEN"` when passed that string
    3. `"reports dual-token mode when project token differs"` — passes `{ projectToken: "different-token" }` config override, asserts `result.config.tokenMode === "dual-token"`
    4. `"auth failure returns fail with error message"` — `getAuthenticatedUser` rejects, asserts `result.status === "issues_found"`, `result.checks.auth.status === "fail"`, detail contains "Bad credentials"
    5. `"repo access failure with auth success gives scope-specific message"` — `query` rejects, asserts `result.checks.repoAccess.detail` contains "Authenticated successfully" and "'repo' scope"
    6. `"project access failure with auth success gives scope-specific message"` — `projectQuery` rejects, asserts `result.checks.projectAccess.detail` contains "Authenticated successfully" and "'project' scope"
    7. `"missing required fields reports which fields are missing"` — `projectQuery` resolves with only `Workflow State` field, asserts `result.checks.requiredFields.status === "fail"`, detail contains "Priority" and "Estimate"
    8. `"skips repo access when owner/repo not set"` — config override `{ owner: undefined, repo: undefined }`, asserts `result.checks.repoAccess.status === "skip"`
    9. `"skips project access when project number not set"` — config override `{ projectNumber: undefined }`, asserts `result.checks.projectAccess.status === "skip"`
    10. `"skipped checks count as ok in summary"` — both owner and projectNumber undefined, asserts `result.status === "ok"`
    11. `"project not found after trying user and org"` — `projectQuery` resolves `{ user: { projectV2: null } }` for both calls, asserts `result.checks.projectAccess.status === "fail"`, detail contains "not found" and "RALPH_GH_PROJECT_OWNER"
  - [ ] `npx vitest run src/__tests__/health-check.test.ts` passes with all 11 tests green

### Phase Success Criteria

#### Automated Verification:
- [x] `npm run build` (from `plugin/ralph-hero/mcp-server/`) — no type errors
- [x] `npm test` — all existing tests still pass (992/992 green)
- [x] `npx vitest run src/__tests__/health-check.test.ts` — all 11 tests pass

#### Manual Verification:
- [ ] `ralph_hero__health_check` tool output includes `tokenSource` field in the `config` section
- [ ] When repo access fails but auth passes, error message starts with "Authenticated successfully, but cannot access repo..."
- [ ] When project access fails but auth passes, error message starts with "Authenticated successfully, but cannot access project..."

**Creates for next phase**: `tokenSource` field in `health_check` output that Phase 3's setup skill displays in its final verification report.

---

## Phase 3: Rewrite Setup Skill (GH-687)

### Overview

Rewrite `plugin/ralph-hero/skills/setup/SKILL.md` to use `claude plugin configure ralph-hero` as THE token delivery path. Remove manual `settings.local.json` token instructions from the primary flow. Preserve all non-token setup steps.

### Tasks

#### Task 3.1: Rewrite SKILL.md
- **files**: `plugin/ralph-hero/skills/setup/SKILL.md` (modify — full rewrite of body content, preserve YAML frontmatter)
- **tdd**: false
- **complexity**: high
- **depends_on**: null
- **acceptance**:
  - [ ] YAML frontmatter is preserved exactly: `description`, `argument-hint`, `context: fork`, `model: haiku`, `hooks`, `allowed-tools` — no changes
  - [ ] **Step 1 — Detect Token**: calls `ralph_hero__health_check`. If `auth: ok`, skip to Step 3. If `auth: fail`, instruct user to run `claude plugin configure ralph-hero` to enter their token. Display platform note:
    ```
    Your token will be stored securely:
    - macOS: System Keychain (encrypted, OS-managed)
    - WSL2/Linux: ~/.claude/.credentials.json (mode 0600, user-only access)
    ```
    After configuring, tell user to restart Claude Code, then re-run `/ralph-hero:setup`.
  - [ ] **Step 2 — Choose Setup Mode**: prompt user to choose between "Same owner for repo and project" (simple) or "Split setup (org repo + personal project)"
  - [ ] **Step 3 — Collect Config**: interactive prompts for owner, repo, project number (per chosen mode). Write non-sensitive config to `.claude/settings.local.json` under `"env"`. For split mode, also write `RALPH_GH_PROJECT_OWNER`. Token is NOT written to `settings.local.json`.
  - [ ] **Step 4 — Create or Verify Project**: calls `ralph_hero__setup_project` if no project. Verifies required fields if project exists. (Same as current Step 3.)
  - [ ] **Step 5 — Store Local Config**: writes `.claude/ralph-hero.local.md` with project settings, workflow states. No token references.
  - [ ] **Step 6 — Verify Setup**: calls `ralph_hero__health_check`. All checks must pass. Reports `tokenSource` from output to confirm delivery path.
  - [ ] **Step 6b — Enable Routing & Sync**: ROUTING_PAT secret, repo variables, routing config — unchanged from current skill.
  - [ ] **Step 7 — Final Report**: shows setup summary including `Token: Stored securely via plugin config (tokenSource: RALPH_HERO_GITHUB_TOKEN)`.
  - [ ] **WSL2 note** in Step 1: explains `~/.claude/.credentials.json` storage, `BROWSER` env var for auto-open, manual URL copy fallback.
  - [ ] **Dual-token advanced note** in split-owner flow: `RALPH_GH_REPO_TOKEN` / `RALPH_GH_PROJECT_TOKEN` in `settings.local.json` for users who need it.
  - [ ] No references to `RALPH_HERO_GITHUB_TOKEN` in `settings.local.json` as a primary user-facing path (it may appear in explanatory notes about how the env var works, but not as a step user must take)
  - [ ] Total line count is shorter than the current 628-line skill (simpler primary flow)

### Phase Success Criteria

#### Automated Verification:
- [ ] `plugin/ralph-hero/skills/setup/SKILL.md` is valid markdown with parseable YAML frontmatter (`python3 -c "import yaml; yaml.safe_load(open('...').read().split('---')[1])"`)
  - [ ] All tool names in `allowed-tools` exist in the MCP server tool registry: `ralph_hero__health_check`, `ralph_hero__get_project`, `ralph_hero__setup_project`
  - [ ] No occurrences of `"RALPH_HERO_GITHUB_TOKEN": "ghp_` (the old manual token step pattern) in the primary flow

#### Manual Verification:
- [ ] Fresh setup on macOS: prompted for token via `claude plugin configure`, guided through owner/repo/project interactively, health_check passes
- [ ] Existing user: health_check passes with token from `settings.local.json` (backward compatible — skill detects `auth: ok` and skips to Step 3)
- [ ] Split-owner flow: org owner for repo, personal owner for project, both accessible
- [ ] Routing setup flow: ROUTING_PAT guidance, repo variables, routing config stub

**Creates for next phase**: N/A — Phase 3 is the final phase.

---

## Integration Testing

- [ ] Full end-to-end: `claude plugin install ralph-hero` on fresh macOS → prompted for token → stored in Keychain → restart → `/ralph-hero:setup` → health_check all green with `tokenSource: RALPH_HERO_GITHUB_TOKEN`
- [ ] WSL2 end-to-end: same flow, `~/.claude/.credentials.json` created with mode `0600`
- [ ] Backward compat: existing user with token in `settings.local.json`, no `userConfig` configured → health_check shows `tokenSource: RALPH_HERO_GITHUB_TOKEN`, `auth: ok`
- [ ] Wrong-scopes: valid token with only `public_repo` scope → health_check `auth: ok` but `repoAccess: fail` with "Authenticated successfully, but..." message

## References

- Parent plan: [`thoughts/shared/plans/2026-03-25-GH-0684-userconfig-healthcheck-setup-rewrite.md`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-03-25-GH-0684-userconfig-healthcheck-setup-rewrite.md)
- Issue GH-685: https://github.com/cdubiel08/ralph-hero/issues/685
- Issue GH-686: https://github.com/cdubiel08/ralph-hero/issues/686
- Issue GH-687: https://github.com/cdubiel08/ralph-hero/issues/687
- Current health_check impl: [`plugin/ralph-hero/mcp-server/src/index.ts:131-286`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts#L131-L286)
- `GitHubClientConfig`: [`plugin/ralph-hero/mcp-server/src/types.ts:283-294`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L283-L294)
- Contract tests: [`plugin/ralph-hero/mcp-server/src/__tests__/init-config.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/init-config.test.ts)
- Current setup skill: [`plugin/ralph-hero/skills/setup/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/setup/SKILL.md)
