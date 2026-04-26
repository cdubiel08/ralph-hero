---
date: 2026-04-26
status: draft
type: plan
github_issue: 890
github_issues: [890, 891, 892]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/890
  - https://github.com/cdubiel08/ralph-hero/issues/891
  - https://github.com/cdubiel08/ralph-hero/issues/892
primary_issue: 890
parent_plan: thoughts/shared/plans/2026-04-25-GH-0877-token-resolution-via-gh-auth.md
tags: [mcp-server, auth, token-resolution, doctor, setup, gh-cli]
---

# GH-877 Token Resolution via `gh auth` — Group Implementation Plan (GH-890, GH-891, GH-892)

## Prior Work

- builds_on:: [[2026-04-25-GH-0877-token-resolution-via-gh-auth]]
- builds_on:: [[2026-03-25-token-management-setup-skill-improvement]]
- builds_on:: [[2026-03-25-github-token-management-across-tools]]
- extends:: [[2026-02-21-GH-0073-ralph-doctor-cli-command]]

## Overview

Three sub-issues comprising the three independently-shippable phases of GH-877. Implementing all three in a single PR delivers coherent end-to-end value: the MCP server fallback, the doctor diagnostic to surface it, and the docs that steer new users to it.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-890 | MCP server `gh auth token` fallback | S |
| 2 | GH-891 | `just doctor` Token Resolution diagnostics | S |
| 3 | GH-892 | Setup skill / README / CLAUDE.md doc updates | S |

**Why grouped**: All three issues share a single parent (#877) and a single parent plan ([2026-04-25-GH-0877-token-resolution-via-gh-auth.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-25-GH-0877-token-resolution-via-gh-auth.md)). They represent the load-bearing change (Phase 1), the diagnostic that surfaces it (Phase 2), and the docs that steer new users to it (Phase 3). Shipping them together means a single user-visible release artifact: "Token rotation now works via `gh auth`." Phase 1 must land first (it introduces the new resolution chain). Phase 2 and Phase 3 build on top and are independent of each other.

## Shared Constraints

Inherited verbatim from the parent plan-of-plans, with feature-specific extensions:

1. **Anti-collision invariant (LOAD-BEARING)**: The contract test at `plugin/ralph-hero/mcp-server/src/__tests__/init-config.test.ts:218` forbids `GH_TOKEN`/`GITHUB_TOKEN`/`GITHUB_PERSONAL_ACCESS_TOKEN` as MCP env vars. The `gh auth token` subprocess output MUST flow into the internal `repoToken` variable only — never re-exported via `process.env.GH_TOKEN` or `process.env.GITHUB_TOKEN`. Phase 2's probe step uses `GH_TOKEN=` as an inline assignment to a subshell-only `gh` CLI invocation; this does NOT violate the contract because it is not setting a process-level env var that the MCP server reads.

2. **Single-account scope only**: Multi-account `--user` delegation (`gh auth token --user X`) is explicitly out of scope and deferred. The `gh auth token` call has no `--user` argument.

3. **Existing dual-token and single-token users see zero behavior change**: `RALPH_HERO_GITHUB_TOKEN`, `RALPH_GH_REPO_TOKEN`, `RALPH_GH_PROJECT_TOKEN` all stay; the chain only *adds* a final fallback layer.

4. **Subprocess cached, one call per process**: `resolveGhAuthToken()` uses a `null`-sentinel cache (where `null = not-yet-resolved`, `undefined = resolved-to-failure`). The 3000ms timeout and `stdio: ["ignore", "pipe", "ignore"]` together suppress stderr noise on missing/unauth gh installations.

5. **Diagnostic must work with broken/expired tokens**: `just doctor` cannot short-circuit on token resolution failure — it must continue probing scopes and emit source-aware fix lines.

6. **No removal, only addition**: We never remove an existing fallback layer or env var. The chain becomes longer, never shorter.

## Current State Analysis

**Resolution chain today** (`plugin/ralph-hero/mcp-server/src/index.ts:42-43`):

```typescript
const repoToken = resolveEnv("RALPH_GH_REPO_TOKEN") || resolveEnv("RALPH_HERO_GITHUB_TOKEN");
const projectToken = resolveEnv("RALPH_GH_PROJECT_TOKEN") || repoToken;
```

If neither env var resolves, the server prints an error block (lines 49-69) leading with "Quick fix — add to .claude/settings.local.json" and `process.exit(1)`s. The `gh` CLI keychain is never consulted, even though it is a de-facto prerequisite for ralph-hero (used by `ralph-pr`, `ralph-merge`, hooks, the `demo-seed.sh` script).

**Resulting sprawl** (verified on the user's machine in the parent research):
- `RALPH_HERO_GITHUB_TOKEN` in `~/.claude/settings.json` (often expired)
- `GITHUB_TOKEN` in env (separate copy, unread by ralph-hero by deliberate contract)
- `gh auth` keychain (already valid with the right scopes — ignored)

**Setup skill steers users toward sprawl**: `plugin/ralph-hero/skills/setup/SKILL.md:36-110` ("Quick Start") tells users to generate a PAT and paste it into `settings.json`, never mentioning `gh auth login`. Result: each new install creates the sprawl pattern.

**`just doctor` shows env-var presence only**: `plugin/ralph-hero/justfile:241-290` reports each env var's source (shell vs. settings hierarchy) but does not check `gh auth status`, does not show layered resolution, and does not emit source-specific rotation commands.

### Key Discoveries (from parent research)

- **No subprocess infrastructure in MCP server today**: zero hits for `execSync`/`spawn`/`child_process` in `plugin/ralph-hero/mcp-server/src/`. Phase 1 introduces the first such call.
- **Token resolution happens once per process** at `index.ts:316` inside `main()` → `initGitHubClient()`. Subprocess to `gh` runs at most once per MCP session.
- **`just doctor` already has a clean section structure** (`--- Environment Variables ---`, `--- Plugin Files ---`, `--- API Health Check ---`). The new "Token Resolution" section slots between env vars and dependencies.
- **Existing helper script `resolve-env.sh` is sourced at line 229**; the new section uses the already-resolved `$resolved_token` from line 276 for the env-source path.
- **gh's `Token scopes:` line** is in `gh auth status` output as `Token scopes: 'repo, project, ...'` — parseable via grep.
- **CLAUDE.md env-var table** currently lists `RALPH_HERO_GITHUB_TOKEN` as **Yes** (required); after Phase 3 it becomes **No** with a default-source note.
- **README has no token-rotation section** today; Phase 3 adds a new "Token Expired?" top-level section.

## Desired End State

After this group lands:

1. A user running `gh auth login -s repo,project,read:org` and nothing else can use ralph-hero with no settings.json edits (only the three non-token settings).
2. A user with a valid `gh` keychain whose `RALPH_HERO_GITHUB_TOKEN` expires sees ralph-hero continue to work — startup falls back to `gh auth token`.
3. `just doctor` shows which source resolved each scope (`repo ops → gh auth (user: <login>)`) and emits the exact rotation command for that source.
4. The setup skill recommends `gh auth login` first; PAT-paste-in-settings.json is documented as the advanced (split-token) path.
5. CLAUDE.md env-var table reflects the new optional status of `RALPH_HERO_GITHUB_TOKEN`.
6. Existing dual-token users (`RALPH_GH_REPO_TOKEN` + `RALPH_GH_PROJECT_TOKEN`) and existing single-token users (`RALPH_HERO_GITHUB_TOKEN`) both continue to work unchanged.

### Verification

- [ ] From a fresh shell with all `RALPH_*_TOKEN` env vars unset and a valid `gh auth` keychain, `npx ralph-hero-mcp-server` starts successfully and `ralph_hero__health_check` returns `auth: ok`.
- [ ] Startup log shows `[ralph-hero] Repo token: gh auth (keychain)` when env vars are absent.
- [ ] `just doctor` shows `repo ops → gh auth (user: <login>)` and the `gh auth refresh` rotation hint when only `gh auth` is configured.
- [ ] `just doctor` shows the explicit env source for `RALPH_HERO_GITHUB_TOKEN`-only and dual-token modes (regression check).
- [ ] Contract test still forbids `GH_TOKEN`/`GITHUB_TOKEN`: `npx vitest run -t "should only accept RALPH"` passes.
- [ ] Setup skill primary path is `gh auth login`; PAT-paste demoted to "Advanced".
- [ ] README has a new "Token Expired?" section.
- [ ] CLAUDE.md env-var table marks `RALPH_HERO_GITHUB_TOKEN` as optional.

## What We're NOT Doing

- **Multi-account `--user` delegation** — same-account is the dominant pattern; deferred follow-up.
- **`/ralph-hero:doctor` skill wrapper** — pure shell `just doctor` covers the diagnostic surface.
- **Removing existing env-var fallbacks** — `RALPH_HERO_GITHUB_TOKEN`, `RALPH_GH_REPO_TOKEN`, `RALPH_GH_PROJECT_TOKEN` all stay.
- **Auto-rotation / hot-reload** — MCP startup-only resolution remains.
- **GitHub App authentication** — out of scope.
- **Changing the contract test that forbids `GH_TOKEN`/`GITHUB_TOKEN`** — that test stays exactly as-is.
- **Fragment extraction follow-ups (#840-843)** — tracked separately in Phase 3 issue.

## Implementation Approach

Phase 1 lands the load-bearing MCP server change (the resolution chain). Phase 2 builds the diagnostic on top — its `repo_source` detection logic mirrors the new chain. Phase 3 documents the change so users adopt the new path. Phases 2 and 3 are independent of each other once Phase 1 is merged.

The plan keeps each phase strictly within its declared scope. The mechanics of the change are documented in detail in the parent plan (`thoughts/shared/plans/2026-04-25-GH-0877-token-resolution-via-gh-auth.md`); this group plan focuses on per-task dispatchability for autonomous implementation.

**Phase dependency annotations** — Phase 1 has no prerequisites. Phase 2 and Phase 3 depend on Phase 1 (they reference behavior introduced there). Phase 2 and Phase 3 are independent and can be executed in parallel by orchestrators.

---

## Phase 1: GH-890 — MCP Server `gh auth token` fallback
- **depends_on**: null

### Overview
Add a `resolveGhAuthToken()` helper that calls `gh auth token` via `execSync` once per process and caches the result. Extend the repo-token resolution chain to include this as the final fallback. Update the startup error block to lead with `gh auth login` and the token-source log to report `gh auth (keychain)` when applicable.

### Tasks

#### Task 1.1: Add `resolveGhAuthToken()` helper
- **files**: `plugin/ralph-hero/mcp-server/src/index.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [x] New `import { execSync } from "node:child_process";` added at the top of the file (alongside other Node imports).
  - [x] Module-level cache: `let cachedGhAuthToken: string | undefined | null = null;` declared after `resolveEnv()` (around line 38).
  - [x] Exported function `resolveGhAuthToken(): string | undefined` declared (the `export` keyword is required so the test file can `import { resolveGhAuthToken }`).
  - [x] Function body: returns `cachedGhAuthToken` immediately if `!== null`; otherwise wraps `execSync("gh auth token", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 })` in `try`/`catch`. On success: trim output and assign to `cachedGhAuthToken` (empty string becomes `undefined`). On any throw: assign `undefined`.
  - [x] JSDoc comment explains the contract: result NEVER re-exported as env var, flows into internal token state only.

#### Task 1.2: Extend repo-token resolution chain
- **files**: `plugin/ralph-hero/mcp-server/src/index.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [x] Line 42-43 `repoToken` assignment becomes a 3-stage chain: `RALPH_GH_REPO_TOKEN` → `RALPH_HERO_GITHUB_TOKEN` → `resolveGhAuthToken()`.
  - [x] Line 47 `projectToken` assignment unchanged (still falls back to `repoToken`, which now transitively gains the gh source).
  - [x] No other token-related lines modified by this task.

#### Task 1.3: Replace startup error block to lead with `gh auth login`
- **files**: `plugin/ralph-hero/mcp-server/src/index.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [x] Existing block at lines 49-69 (the `if (!repoToken)` console.error + process.exit) replaced with new copy that leads with `gh auth login -s repo,project,read:org` as "Quickest fix — authenticate gh (recommended)".
  - [x] PAT-paste path demoted to a section labeled "Alternative — paste a PAT into Claude Code settings" (with the JSON snippet preserved).
  - [x] Final line points to `/ralph-hero:setup` for advanced (split-token) configurations.
  - [x] `process.exit(1)` retained (no behavior change on missing token).

#### Task 1.4: Update token-source logging to report `gh auth (keychain)`
- **files**: `plugin/ralph-hero/mcp-server/src/index.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [x] Line 103-105 logic for `repoTokenSource` becomes a three-way ternary chain: `RALPH_GH_REPO_TOKEN` (env present) → `RALPH_HERO_GITHUB_TOKEN` (env present) → `gh auth (keychain)` (else).
  - [x] The same three-way logic also updates the `repoTokenSource` derivation inside `health_check` at lines 266-268 (so `tokenSources.repoToken` in the health check output also reports `gh auth (keychain)` correctly).
  - [x] Line 108-112 (the `if (projectToken !== repoToken)` block reporting "Project token: RALPH_GH_PROJECT_TOKEN (separate)") unchanged.

#### Task 1.5: Extend `resolveTokens()` test simulator and add fallback test cases
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/init-config.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.2]
- **acceptance**:
  - [x] `resolveTokens()` helper at lines 35-42 takes an optional `opts?: { ghAuthToken?: string }` parameter; chain becomes `RALPH_GH_REPO_TOKEN || RALPH_HERO_GITHUB_TOKEN || opts?.ghAuthToken`.
  - [x] New `describe("gh auth fallback")` block added containing 5 cases:
    1. gh keychain is final fallback: no env vars set, `ghAuthToken: "ghp_kc"` → `repoToken === "ghp_kc"`, `projectToken === "ghp_kc"`.
    2. `RALPH_HERO_GITHUB_TOKEN` wins over gh: env set, `ghAuthToken: "ghp_kc"` → `repoToken === "ghp_env"`.
    3. `RALPH_GH_REPO_TOKEN` wins over gh: env set, `ghAuthToken: "ghp_kc"` → `repoToken === "ghp_repo"`.
    4. Project-only override works with gh repo: `RALPH_GH_PROJECT_TOKEN` set + `ghAuthToken: "ghp_kc"` → `repoToken === "ghp_kc"`, `projectToken === "ghp_proj"`.
    5. Undefined when neither env nor gh: nothing set → `repoToken === undefined`.
  - [x] All 5 cases pass via `npx vitest run src/__tests__/init-config.test.ts`.

#### Task 1.6: Add subprocess behavior tests against actual `resolveGhAuthToken`
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/init-config.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1, 1.5]
- **acceptance**:
  - [x] Test file imports `resolveGhAuthToken` from `../index.js` (relies on Task 1.1's `export`).
  - [x] Test file imports `* as childProcess from "node:child_process"` for `vi.spyOn`. (Implementation note: ESM module namespaces are non-configurable in vitest, so `vi.spyOn(childProcess, "execSync")` throws `TypeError: Cannot redefine property: execSync`. We instead use a top-of-file `vi.mock("node:child_process", ...)` factory that returns `{ ...actual, execSync: vi.fn(actual.execSync) }`, and assert via `vi.mocked(execSync)`. Functionally equivalent — same calls, same assertions.)
  - [x] New `describe("subprocess behavior")` block with 3 cases:
    1. Returns trimmed token on success: `vi.mocked(execSync).mockReturnValueOnce("ghp_subproc\n" as unknown as Buffer)` → `resolveGhAuthToken() === "ghp_subproc"`.
    2. Returns `undefined` on throw: `vi.mocked(execSync).mockImplementationOnce(() => { throw new Error("not authenticated"); })` → `resolveGhAuthToken() === undefined`.
    3. Caches result: after first call, second call does NOT invoke `execSync` (assert mock `.toHaveBeenCalledTimes(1)`).
  - [x] Each test resets the module-level cache between cases (exposed test-only `resetGhAuthTokenCache()` helper from `index.ts`; called in `beforeEach`/`afterEach` alongside `mockReset()`).
  - [x] All 3 cases pass via `npx vitest run src/__tests__/init-config.test.ts -t "subprocess behavior"`.

#### Task 1.7: Verify contract test still rejects `GH_TOKEN`/`GITHUB_TOKEN`
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/init-config.test.ts` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.6]
- **acceptance**:
  - [x] No edits to the `describe(".mcp.json contract")` block at lines 217-252.
  - [x] `npx vitest run -t "should only accept RALPH"` passes unchanged.
  - [x] `forbiddenVars` still includes `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN`.

### Phase Success Criteria

#### Automated Verification:
- [x] `cd plugin/ralph-hero/mcp-server && npm run build` — no TypeScript errors.
- [x] `cd plugin/ralph-hero/mcp-server && npm test` — all existing tests pass plus 8 new cases (5 fallback + 3 subprocess). (44 files / 1031 tests pass.)
- [x] `npx vitest run src/__tests__/init-config.test.ts -t "gh auth fallback"` — 5 cases pass.
- [x] `npx vitest run src/__tests__/init-config.test.ts -t "subprocess behavior"` — 3 cases pass.
- [x] `npx vitest run -t "should only accept RALPH"` — contract test still passes.

#### Manual Verification:
- [ ] With all `RALPH_*_TOKEN` env vars unset in `~/.claude/settings.json` and `gh auth status` showing valid scopes, restart Claude Code and invoke `ralph_hero__health_check`. Expect `auth: ok` and startup log line `[ralph-hero] Repo token: gh auth (keychain)`.
- [ ] With `RALPH_HERO_GITHUB_TOKEN=invalid_token` set and `gh auth` valid, restart Claude Code. Expect health_check to fail (env wins, gh ignored) — confirming env-precedence preserved.
- [ ] With all `RALPH_*_TOKEN` unset AND `gh auth logout` executed, restart. Expect the new error message leading with `gh auth login -s repo,project,read:org`.

**Creates for next phase**: The new resolution chain (Phase 2 detects it) and the new error message (Phase 3 documents it).

---

## Phase 2: GH-891 — `just doctor` Token Resolution diagnostics
- **depends_on**: [phase-1]

### Overview
Add a `--- Token Resolution ---` section to `just doctor` between the env-vars loop and the `--- Dependencies ---` section. The section reports per-scope source attribution, parses `gh auth` scopes, probes the winning token, and emits source-specific rotation commands.

### Tasks

#### Task 2.1: Insert "Token Resolution" section in justfile
- **files**: `plugin/ralph-hero/justfile` (modify)
- **tdd**: false
- **complexity**: high
- **depends_on**: null
- **acceptance**:
  - [ ] New section inserted after line 290 (`done` of the env-vars loop) and before line 291 (`echo ""` preceding `--- Dependencies ---`).
  - [ ] Section header: `echo "--- Token Resolution ---"`.
  - [ ] Step 1 (gh detection): use `command -v gh &>/dev/null` guard; if present, `gh_token=$(gh auth token 2>/dev/null)`, `gh_status_output=$(gh auth status 2>&1 || true)`, parse `gh_user` from `'account [^ ]+'` regex, parse `gh_scopes` from `"Token scopes: '[^']+'"` regex.
  - [ ] Step 2 (winning source detection): `repo_source` set to `"RALPH_GH_REPO_TOKEN (explicit)"` when env present, else `"RALPH_HERO_GITHUB_TOKEN${source_label:-}"` when `$resolved_token` non-empty (using `source_label` already populated by line 276 loop), else `"gh auth (user: ${gh_user:-unknown})"` when `gh_token` non-empty, else empty string.
  - [ ] `project_source` set to `"RALPH_GH_PROJECT_TOKEN (explicit)"` when env present, else `"$repo_source (fallback)"`.
  - [ ] Display: `echo "  OK: repo ops    → $repo_source"` and `echo "  OK: project ops → $project_source"` when `repo_source` non-empty; otherwise `echo "FAIL: no token resolvable"` and increment `errors`.
  - [ ] Step 3 (gh scopes report): when `gh_scopes` non-empty, `echo "  gh scopes: $gh_scopes"`, then for each `required` in `repo project`: if not present in `gh_scopes`, emit `WARN: gh keychain missing scope '$required' — run: gh auth refresh -s repo,project,read:org` and increment `warnings`.
  - [ ] Step 4 (token probe): when `$resolved_token` or `$gh_token` non-empty, `probe_token="${resolved_token:-$gh_token}"` and `probe_login=$(GH_TOKEN="$probe_token" gh api graphql -f query='query{viewer{login}}' --jq .data.viewer.login 2>/dev/null)`. On success: `echo "  OK: token probe — authenticated as $probe_login"`. On failure: emit `FAIL: token probe failed (token may be expired or lack required scopes)`, follow with source-specific `Fix:` line (`gh auth refresh -s repo,project,read:org` for gh source, `regenerate PAT at https://github.com/settings/tokens, update Claude Code settings` otherwise), increment `errors`.
  - [ ] Step 5 (rotation hint): trailing `echo ""` then `case "$repo_source"` block — `*"gh auth"*` emits the gh-refresh one-liner; `*"RALPH_GH_REPO_TOKEN"*|*"RALPH_HERO_GITHUB_TOKEN"*` emits the regenerate-PAT path PLUS a "Or migrate to gh auth: gh auth login -s repo,project,read:org && remove the env var" follow-up line.
  - [ ] Final `echo ""` before the `--- Dependencies ---` header preserves the existing spacing pattern.

#### Task 2.2: Verify justfile syntax and structure
- **files**: `plugin/ralph-hero/justfile` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] `bash -n plugin/ralph-hero/justfile` exits 0 (no syntax errors). Note: just recipe bodies are bash, so this catches most syntax issues even though the file itself is not pure bash.
  - [ ] `just --list` succeeds and shows `doctor` recipe still present.
  - [ ] No existing sections (`Environment Variables`, `Dependencies`, `Plugin Files`, `Version`, `API Health Check`, `WSL2 Compatibility`, Summary line) deleted or reordered.

#### Task 2.3: Manual smoke tests for each token-source combination
- **files**: (none — runtime verification)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [2.2]
- **acceptance**:
  - [ ] **gh-only path**: with `RALPH_*_TOKEN` env vars unset and `gh auth` valid, `just doctor` exits 0 and shows `repo ops → gh auth (user: <login>)` plus the `gh auth refresh` rotation hint.
  - [ ] **env-var path**: with `RALPH_HERO_GITHUB_TOKEN` set, `just doctor` exits 0 and shows `repo ops → RALPH_HERO_GITHUB_TOKEN (from <source>)` plus the regenerate-PAT rotation hint.
  - [ ] **dual-token path**: with `RALPH_GH_REPO_TOKEN` + `RALPH_GH_PROJECT_TOKEN` both set, `just doctor` exits 0, both `repo ops` and `project ops` show explicit-env sources.
  - [ ] **expired-token path**: with a known-bad PAT, the probe section reports `FAIL: token probe failed` with the right `Fix:` line for the source.
  - [ ] **gh missing scope**: when `gh auth` is logged in with only `repo` (no `project`), the WARN line fires for `project`.
  - [ ] **no token at all**: with everything unset, `just doctor` exits 1 and reports `FAIL: no token resolvable`.

### Phase Success Criteria

#### Automated Verification:
- [ ] `bash -n plugin/ralph-hero/justfile` passes (syntax check).
- [ ] `just --list` succeeds and lists the `doctor` recipe.
- [ ] `just doctor` exits 0 with at least one valid token source configured (manual verification covers the matrix in Task 2.3).
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` — Phase 1's tests still pass (regression).

#### Manual Verification:
- [ ] All six smoke tests in Task 2.3 pass.

**Creates for next phase**: A diagnostic that documents the new resolution behavior — Phase 3's docs reference this for the rotation flow.

---

## Phase 3: GH-892 — Setup skill, README, CLAUDE.md doc updates
- **depends_on**: [phase-1]

### Overview
Documentation-only updates (no code, no tests). Flip the setup skill's primary path to `gh auth login`, demote PAT-paste to "Advanced". Add a "Token Expired?" rotation guide to the root README. Update the CLAUDE.md env-var table to mark `RALPH_HERO_GITHUB_TOKEN` as optional.

### Tasks

#### Task 3.1: Rewrite setup skill Quick Start section
- **files**: `plugin/ralph-hero/skills/setup/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Replace the entire content from line 36 (`## Quick Start (Minimum Viable Config)`) through line 110 (the end of the `### Advanced: Split-Owner / Dual-Token` paragraph) with the revised structure documented in the parent plan (Phase 3 §1).
  - [ ] New "### 1. Authenticate with `gh` (recommended)" subsection contains the `gh auth login -s repo,project,read:org` command and a one-line rotation hint pointing to `gh auth refresh` and `just doctor`.
  - [ ] Existing "### 1b. Detect Install Scope" subsection preserved verbatim — no content changes, just renumbered if needed (the install-scope detection logic at the heart of the skill must remain intact).
  - [ ] New "### 2. Add the Three Settings to Claude Code" subsection shows ONLY the three non-token settings (`RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER`) in the JSON snippet — token absent.
  - [ ] "### 3. Restart Claude Code" subsection retained.
  - [ ] "### Where NOT to put tokens" subsection retained (or merged into the new Quick Start).
  - [ ] New "## Advanced: Split-Token Configurations" section (note: rename from "Split-Owner / Dual-Token") documents the explicit-PAT path (`RALPH_GH_REPO_TOKEN` + `RALPH_GH_PROJECT_TOKEN`) and the legacy `RALPH_HERO_GITHUB_TOKEN` form. Explicitly states: "Explicit env vars always take precedence over `gh auth`."
  - [ ] No content below line 110 (the "## Workflow" section starting at line 112) modified.

#### Task 3.2: Add "Token Expired?" section to README
- **files**: `README.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] New top-level `## Token Expired?` section inserted after the "Set Up Your Project Board" section (after line 58) and before "## Skills" (around line 60).
  - [ ] Section opens with a `gh auth refresh -s repo,project,read:org` code block as the primary rotation path.
  - [ ] Follow-up paragraph: "Then restart Claude Code. Run `just doctor` if anything still looks off."
  - [ ] Final paragraph documents the explicit-PAT rotation path: regenerate at https://github.com/settings/tokens, update `~/.claude/settings.json` (or `.claude/settings.local.json`), restart Claude Code.
  - [ ] No other README sections modified.

#### Task 3.3: Update CLAUDE.md env-var table
- **files**: `CLAUDE.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Locate the `RALPH_HERO_GITHUB_TOKEN` row in the env-var table (the table currently has it as `**Yes**` in the Required column, with description "GitHub PAT with `repo` + `project` scopes").
  - [ ] Update the Required column from `**Yes**` to `No (defaults to `gh auth token`)`.
  - [ ] Update the Description column to: "GitHub PAT with `repo` + `project` scopes. Optional override — if unset, the MCP server falls back to the `gh` CLI keychain."
  - [ ] Update the prose paragraph immediately above the env-var table (currently "The CLI's `resolve-env.sh` searches in order: shell env → repo `settings.local.json` → repo `settings.json` → `~/.claude/settings.json`.") to also mention the gh-keychain fallback as the new default for the token specifically. Add a sentence like: "When no `RALPH_*_TOKEN` env var is set, the MCP server falls back to `gh auth token` from the gh CLI keychain."
  - [ ] No other CLAUDE.md sections modified.

#### Task 3.4: Visual link review on modified docs
- **files**: `plugin/ralph-hero/skills/setup/SKILL.md` (read), `README.md` (read), `CLAUDE.md` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.1, 3.2, 3.3]
- **acceptance**:
  - [ ] No internal cross-references in the three modified files broken (e.g., a section deleted that another section linked to).
  - [ ] All external URLs (https://github.com/settings/tokens) syntactically intact in code blocks.
  - [ ] `gh auth login` command form is identical across all three files: `gh auth login -s repo,project,read:org` (no other scope strings introduced).

### Phase Success Criteria

#### Automated Verification:
- [ ] No CI changes — these are doc-only edits.
- [ ] `git diff --stat` for the PR shows changes confined to `plugin/ralph-hero/skills/setup/SKILL.md`, `README.md`, and `CLAUDE.md` (no source/test changes from this phase).

#### Manual Verification:
- [ ] A new user can follow the updated setup skill end-to-end with only `gh auth login` + 3 non-token settings entries, and ralph-hero starts successfully.
- [ ] `/ralph-hero:setup` re-run on existing setup reads correctly; the recommended path is `gh auth login`.
- [ ] README "Token Expired?" section is visible from the repo root and the rotation flow is one command for gh-source users.
- [ ] CLAUDE.md env-var table correctly marks `RALPH_HERO_GITHUB_TOKEN` as optional.

**Creates for next phase**: N/A — this is the final phase.

---

## Integration Testing

After all three phases land:

- [ ] **End-to-end gh-only path**: `unset RALPH_HERO_GITHUB_TOKEN RALPH_GH_REPO_TOKEN RALPH_GH_PROJECT_TOKEN`; `gh auth login -s repo,project,read:org`; restart Claude Code; run `/ralph-hero:status`. Expect success.
- [ ] **End-to-end env-var precedence**: With `gh auth` valid, set `RALPH_HERO_GITHUB_TOKEN=invalid_token` in `settings.local.json`; restart; expect 401 from health_check (env wins, gh ignored).
- [ ] **End-to-end split-token preserved**: Set `RALPH_GH_REPO_TOKEN` and `RALPH_GH_PROJECT_TOKEN` to two distinct valid tokens; restart; expect both to work; `just doctor` reports both as explicit sources.
- [ ] **Doctor diagnostics accuracy**: With only `gh auth` configured, `just doctor` shows `repo ops → gh auth (user: <login>)` and a one-line rotation hint. Output matches what Phase 3's README describes.
- [ ] **Expired-token diagnosis**: Manually expire the gh token (or use a known-bad PAT); `just doctor` probe reports `FAIL: token probe failed` with the correct `Fix:` line.
- [ ] **Setup-skill walkthrough on a fresh checkout**: A clean install following only the new Quick Start gets the user to a working state without ever pasting a token into JSON.

## References

- Parent plan: [thoughts/shared/plans/2026-04-25-GH-0877-token-resolution-via-gh-auth.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-25-GH-0877-token-resolution-via-gh-auth.md)
- Parent issue: [#877](https://github.com/cdubiel08/ralph-hero/issues/877)
- Phase 1 issue: [#890](https://github.com/cdubiel08/ralph-hero/issues/890)
- Phase 2 issue: [#891](https://github.com/cdubiel08/ralph-hero/issues/891)
- Phase 3 issue: [#892](https://github.com/cdubiel08/ralph-hero/issues/892)
- Token-management research (foundational): [thoughts/shared/research/2026-03-25-token-management-setup-skill-improvement.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-25-token-management-setup-skill-improvement.md)
- Cross-tool token survey: [thoughts/shared/research/2026-03-25-github-token-management-across-tools.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-25-github-token-management-across-tools.md)
- Anti-collision invariant origin: [thoughts/shared/plans/2026-02-13-setup-friction-fixes.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-13-setup-friction-fixes.md)
- MCP server entry point: [plugin/ralph-hero/mcp-server/src/index.ts:33-125](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts#L33-L125)
- Existing `just doctor` recipe: [plugin/ralph-hero/justfile:224-389](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/justfile#L224-L389)
- Contract test (do-not-touch): [plugin/ralph-hero/mcp-server/src/__tests__/init-config.test.ts:218](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/init-config.test.ts#L218)
- Setup skill (target of Phase 3): [plugin/ralph-hero/skills/setup/SKILL.md:36-110](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/setup/SKILL.md#L36-L110)
- README (target of Phase 3): [README.md](https://github.com/cdubiel08/ralph-hero/blob/main/README.md)
- CLAUDE.md (target of Phase 3): [CLAUDE.md](https://github.com/cdubiel08/ralph-hero/blob/main/CLAUDE.md)
