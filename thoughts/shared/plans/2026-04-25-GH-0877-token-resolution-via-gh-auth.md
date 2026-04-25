---
date: 2026-04-25
status: draft
type: plan
tags: [mcp-server, auth, token-resolution, doctor, setup, gh-cli]
github_issue: 877
github_issues: [877]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/877
primary_issue: 877
---

# GitHub Token Resolution via `gh auth` Implementation Plan

## Prior Work

- builds_on:: [[2026-03-25-token-management-setup-skill-improvement]]
- builds_on:: [[2026-03-25-github-token-management-across-tools]]
- extends:: [[2026-02-21-GH-0073-ralph-doctor-cli-command]]

## Overview

Eliminate the "token expired → painful multi-location update" rotation problem by adding `gh auth token` as the default fallback in the MCP server's token resolution chain, then extend `just doctor` to surface which token source is winning per scope. Single-account scope only — multi-account `--user` delegation is deferred.

## Current State Analysis

**Today's resolution chain** (`mcp-server/src/index.ts:43-47`):

```typescript
const repoToken    = resolveEnv("RALPH_GH_REPO_TOKEN") || resolveEnv("RALPH_HERO_GITHUB_TOKEN");
const projectToken = resolveEnv("RALPH_GH_PROJECT_TOKEN") || repoToken;
```

If neither `RALPH_GH_REPO_TOKEN` nor `RALPH_HERO_GITHUB_TOKEN` is set, the server prints an error and `process.exit(1)`s (lines 49-68). The `gh` CLI keychain is **never consulted**, even though `gh` is a de-facto prerequisite for ralph-hero (used by `ralph-pr`, `ralph-merge`, `demo-seed.sh`, hooks).

**Resulting sprawl** (verified on this user's machine):
- `RALPH_HERO_GITHUB_TOKEN` in `~/.claude/settings.json` (the one that expired)
- `GITHUB_TOKEN` in env (separate copy, unread by ralph-hero by deliberate contract)
- `gh auth` keychain (already valid, with `admin:org, project, repo` scopes — ignored)

The `/ralph-hero:setup` skill (`skills/setup/SKILL.md:40-110`) actively steers the user *toward* pasting a PAT into `settings.json` and *away from* `.bashrc`/`.mcp.json`, but never mentions `gh auth login` — so users build the sprawl by following the docs.

`just doctor` (`justfile:224-390`) reports `RALPH_HERO_GITHUB_TOKEN` source from the settings hierarchy but does not check `gh auth status` and cannot show layered resolution.

### Key Discoveries

- **Contract test forbids `GH_TOKEN`/`GITHUB_TOKEN` as MCP env vars** (`mcp-server/src/__tests__/init-config.test.ts:218`). The `gh auth token` output must flow into the **internal `repoToken` variable only**, never back into a forbidden env var name. Constraint preserved by design — we never re-export.
- **Token resolution happens once per process** at `index.ts:316` inside `main()`. Subprocess to `gh` runs at most once. No per-request invocation.
- **No subprocess infrastructure in MCP server today** (verified — zero hits for `execSync`/`spawn`/`child_process` in `src/`). This is the first such call.
- **`just doctor` already exists** (GH-73, closed) with a clean section structure (`--- Environment Variables ---`, `--- Dependencies ---`, `--- API Health Check ---`). The new "Token Resolution" section slots in cleanly.
- **No sibling plugins read GitHub tokens** (`ralph-knowledge`, `ralph-playwright` have no GH token references). No cross-plugin contracts to honor.
- **2026-03-25 research left this exact question open**: "Should ralph-hero optionally read from `gh auth token` as a convenience fallback?" — unresolved. This plan answers it.

## Desired End State

After this plan ships:

1. A user running `gh auth login -s repo,project,read:org` and nothing else can use ralph-hero with no settings.json edits.
2. A user with a valid `gh` keychain whose `RALPH_HERO_GITHUB_TOKEN` expires sees ralph-hero continue to work — startup falls back to `gh auth token`.
3. `just doctor` shows which source resolved each scope and emits the exact rotation command for that source.
4. The setup skill recommends `gh auth login` first; PAT-paste-in-settings.json is documented as the advanced (split-token) path.
5. Existing dual-token users (`RALPH_GH_REPO_TOKEN` + `RALPH_GH_PROJECT_TOKEN`) and existing single-token users (`RALPH_HERO_GITHUB_TOKEN`) both continue to work unchanged.

**Verification**: From a fresh shell with all `RALPH_*_TOKEN` env vars unset and a valid `gh auth` keychain, `npx ralph-hero-mcp-server` starts successfully and `ralph_hero__health_check` returns `auth: ok`.

## What We're NOT Doing

- **Multi-account `--user` delegation** (`RALPH_GH_REPO_USER` / `RALPH_GH_PROJECT_USER` → `gh auth token --user X`). Deferred — same-account is the dominant pattern. Filed as a follow-up issue.
- **`/ralph-hero:doctor` skill wrapper.** Pure shell `just doctor` covers the diagnostic surface; an in-Claude wrapper is deferrable.
- **Removing existing env-var fallbacks.** `RALPH_HERO_GITHUB_TOKEN`, `RALPH_GH_REPO_TOKEN`, `RALPH_GH_PROJECT_TOKEN` all stay. We only *add* a layer; we don't remove any.
- **Auto-rotation / hot-reload.** MCP startup-only resolution remains. Token expiry mid-session still requires Claude Code restart (which is a one-key operation).
- **GitHub App authentication.** Out of scope.
- **Changing the contract test that forbids `GH_TOKEN`/`GITHUB_TOKEN`.** That test stays exactly as-is.

## Implementation Approach

Three phases, each independently shippable:

1. **MCP server**: extend `resolveEnv()` chain with a `gh auth token` fallback. Subprocess invoked once at startup, only when env vars empty. Update error message and source-logging.
2. **`just doctor`**: add a `Token Resolution` section that resolves the source per scope and emits the right rotation command.
3. **Docs**: flip `setup` skill defaults, add README rotation guide, refresh `CLAUDE.md` env-var table.

Phase 1 is the load-bearing change. Phase 2 makes diagnosis possible. Phase 3 prevents future users from rebuilding the sprawl.

---

## Phase 1: MCP Server — `gh auth token` fallback

### Overview

Add a final resolution layer that calls `gh auth token` via `execSync` when all `RALPH_*_TOKEN` env vars are absent. Update startup error and source-logging. Never re-export the resolved value as `GH_TOKEN`/`GITHUB_TOKEN` — assign to internal `repoToken` only.

### Changes Required

#### 1. New helper: `resolveGhAuthToken()`

**File**: `plugin/ralph-hero/mcp-server/src/index.ts` (insert after `resolveEnv()` at line 38)

```typescript
import { execSync } from "node:child_process";

/**
 * Resolve a GitHub token from the local `gh` CLI keychain.
 * Returns undefined if `gh` is not installed, not authenticated, or fails.
 * The result is NEVER re-exported as an env var — it flows into internal
 * token state only (preserves the GH_TOKEN/GITHUB_TOKEN contract test).
 */
let cachedGhAuthToken: string | undefined | null = null; // null = not yet resolved
function resolveGhAuthToken(): string | undefined {
  if (cachedGhAuthToken !== null) return cachedGhAuthToken;
  try {
    const out = execSync("gh auth token", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    cachedGhAuthToken = out || undefined;
  } catch {
    cachedGhAuthToken = undefined;
  }
  return cachedGhAuthToken;
}
```

The `null` sentinel ensures one subprocess call per process even if `resolveGhAuthToken()` is invoked multiple times. Stderr suppressed — failure is signalled by undefined return, not a noisy log line.

#### 2. Extend the resolution chain

**File**: `plugin/ralph-hero/mcp-server/src/index.ts:43`

Replace:
```typescript
const repoToken =
  resolveEnv("RALPH_GH_REPO_TOKEN") || resolveEnv("RALPH_HERO_GITHUB_TOKEN");
```

With:
```typescript
const repoToken =
  resolveEnv("RALPH_GH_REPO_TOKEN") ||
  resolveEnv("RALPH_HERO_GITHUB_TOKEN") ||
  resolveGhAuthToken();
```

`projectToken` (line 47) is unchanged — it still falls back to `repoToken`, which now transitively includes the gh source.

#### 3. Update startup error message

**File**: `plugin/ralph-hero/mcp-server/src/index.ts:49-68`

Replace the error block to lead with `gh auth login`:

```typescript
if (!repoToken) {
  console.error(
    "[ralph-hero] Error: No GitHub token found.\n" +
      "\n" +
      "Quickest fix — authenticate gh (recommended):\n" +
      "\n" +
      "  gh auth login -s repo,project,read:org\n" +
      "\n" +
      "Then restart Claude Code. ralph-hero will read the token from gh's keychain.\n" +
      "\n" +
      "Alternative — paste a PAT into Claude Code settings:\n" +
      "\n" +
      '  ~/.claude/settings.json (user scope) or .claude/settings.local.json (project scope)\n' +
      '  { "env": { "RALPH_HERO_GITHUB_TOKEN": "ghp_..." } }\n' +
      "\n" +
      "Generate a PAT at: https://github.com/settings/tokens (scopes: repo, project, read:org)\n" +
      "\n" +
      "For advanced setups (split repo/project tokens), run /ralph-hero:setup.",
  );
  process.exit(1);
}
```

#### 4. Update token-source logging

**File**: `plugin/ralph-hero/mcp-server/src/index.ts:103-106`

Replace:
```typescript
const repoTokenSource = resolveEnv("RALPH_GH_REPO_TOKEN")
  ? "RALPH_GH_REPO_TOKEN"
  : "RALPH_HERO_GITHUB_TOKEN";
console.error(`[ralph-hero] Repo token: ${repoTokenSource}`);
```

With:
```typescript
const repoTokenSource = resolveEnv("RALPH_GH_REPO_TOKEN")
  ? "RALPH_GH_REPO_TOKEN"
  : resolveEnv("RALPH_HERO_GITHUB_TOKEN")
    ? "RALPH_HERO_GITHUB_TOKEN"
    : "gh auth (keychain)";
console.error(`[ralph-hero] Repo token: ${repoTokenSource}`);
```

#### 5. Update test simulator and add coverage

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/init-config.test.ts`

Update the `resolveTokens()` helper at lines 35-42 to accept an injected `ghAuthToken` parameter (mirrors the new fallback layer):

```typescript
function resolveTokens(opts?: { ghAuthToken?: string }) {
  const repoToken =
    process.env.RALPH_GH_REPO_TOKEN ||
    process.env.RALPH_HERO_GITHUB_TOKEN ||
    opts?.ghAuthToken;

  const projectToken = process.env.RALPH_GH_PROJECT_TOKEN || repoToken;

  return { repoToken, projectToken };
}
```

Add the following test cases under a new `describe("gh auth fallback")` block:

| Case | Setup | Expected |
|------|-------|----------|
| gh keychain is final fallback | no env vars, `ghAuthToken: "ghp_kc"` | `repoToken === "ghp_kc"`, `projectToken === "ghp_kc"` |
| `RALPH_HERO_GITHUB_TOKEN` wins over gh | env set, `ghAuthToken: "ghp_kc"` | `repoToken === "ghp_env"` |
| `RALPH_GH_REPO_TOKEN` wins over gh | env set, `ghAuthToken: "ghp_kc"` | `repoToken === "ghp_repo"` |
| Project-only override works with gh repo | `RALPH_GH_PROJECT_TOKEN` set + gh keychain | `repoToken === "ghp_kc"`, `projectToken === "ghp_proj"` |
| undefined when neither env nor gh | nothing set | `repoToken === undefined` |

Add one `describe("subprocess behavior")` test that imports the actual `resolveGhAuthToken` (export it from `index.ts` for testability) and uses `vi.spyOn(child_process, "execSync")` to verify:
- Returns trimmed token on success
- Returns `undefined` when `execSync` throws
- Caches result (second call does not invoke `execSync`)

**Note**: Exporting `resolveGhAuthToken` requires no behavior change at the call site — it just makes it importable. Add `export` keyword.

### Success Criteria

#### Automated Verification:
- [ ] All existing tests pass: `cd plugin/ralph-hero/mcp-server && npm test`
- [ ] New test cases pass (5 fallback cases + 3 subprocess behavior cases = 8 added)
- [ ] TypeScript build clean: `npm run build`
- [ ] Contract test still forbids `GH_TOKEN`/`GITHUB_TOKEN`: `npx vitest run -t "should only accept RALPH"`

#### Manual Verification:
- [ ] Unset all `RALPH_*_TOKEN` env vars in `~/.claude/settings.json`. Confirm `gh auth status` shows a valid token. Restart Claude Code. Run `ralph_hero__health_check` — `auth: ok`. Startup log shows `[ralph-hero] Repo token: gh auth (keychain)`.
- [ ] Set `RALPH_HERO_GITHUB_TOKEN` to an invalid value, keep `gh auth` valid. Restart Claude Code. Confirm startup uses the env var (and fails) — env vars still take precedence.
- [ ] Unset `RALPH_*_TOKEN` and run `gh auth logout`. Restart Claude Code. Confirm the new error message appears, leading with `gh auth login`.

**Implementation Note**: After Phase 1's automated verification passes, pause here for manual confirmation before proceeding to Phase 2.

---

## Phase 2: `just doctor` — Token Resolution Diagnostics

### Overview

Add a `--- Token Resolution ---` section to the existing `doctor` recipe that reports per-scope source attribution and emits the right rotation command for whatever source is resolved.

### Changes Required

#### 1. Insert "Token Resolution" section in justfile

**File**: `plugin/ralph-hero/justfile` (insert between line 290 `done` of env-vars loop and line 291 `echo ""`)

Insert after the existing env-vars loop (line 290), before the `--- Dependencies ---` section starts at line 292:

```bash
echo ""
echo "--- Token Resolution ---"

# 1. Detect which source would win for repo token
gh_token=""
gh_user=""
gh_scopes=""
gh_status_output=""
if command -v gh &>/dev/null; then
    if gh_token=$(gh auth token 2>/dev/null) && [ -n "$gh_token" ]; then
        gh_status_output=$(gh auth status 2>&1 || true)
        gh_user=$(echo "$gh_status_output" | grep -oE 'account [^ ]+' | head -1 | cut -d' ' -f2)
        gh_scopes=$(echo "$gh_status_output" | grep -oE "Token scopes: '[^']+'" | head -1 | sed "s/Token scopes: '//;s/'//")
    fi
fi

# 2. Determine winning source per scope
repo_source=""
if [ -n "${RALPH_GH_REPO_TOKEN:-}" ]; then
    repo_source="RALPH_GH_REPO_TOKEN (explicit)"
elif [ -n "$resolved_token" ]; then
    repo_source="RALPH_HERO_GITHUB_TOKEN${source_label:-}"
elif [ -n "$gh_token" ]; then
    repo_source="gh auth (user: ${gh_user:-unknown})"
fi

project_source=""
if [ -n "${RALPH_GH_PROJECT_TOKEN:-}" ]; then
    project_source="RALPH_GH_PROJECT_TOKEN (explicit)"
else
    project_source="$repo_source (fallback)"
fi

if [ -n "$repo_source" ]; then
    echo "  OK: repo ops    → $repo_source"
    echo "  OK: project ops → $project_source"
else
    echo "FAIL: no token resolvable"
    errors=$((errors + 1))
fi

# 3. Report gh scopes
if [ -n "$gh_scopes" ]; then
    echo "  gh scopes: $gh_scopes"
    for required in repo project; do
        if ! echo "$gh_scopes" | grep -q "$required"; then
            echo "  WARN: gh keychain missing scope '$required' — run: gh auth refresh -s repo,project,read:org"
            warnings=$((warnings + 1))
        fi
    done
fi

# 4. Probe the winning token
if [ -n "$resolved_token" ] || [ -n "$gh_token" ]; then
    probe_token="${resolved_token:-$gh_token}"
    if probe_login=$(GH_TOKEN="$probe_token" gh api graphql -f query='query{viewer{login}}' --jq .data.viewer.login 2>/dev/null); then
        echo "  OK: token probe — authenticated as $probe_login"
    else
        echo "FAIL: token probe failed (token may be expired or lack required scopes)"
        if [ "$repo_source" = *"gh auth"* ]; then
            echo "      Fix: gh auth refresh -s repo,project,read:org"
        else
            echo "      Fix: regenerate PAT at https://github.com/settings/tokens, update Claude Code settings"
        fi
        errors=$((errors + 1))
    fi
fi

# 5. Rotation hint based on winning source
echo ""
case "$repo_source" in
    *"gh auth"*)
        echo "  Rotation: gh auth refresh -s repo,project,read:org && restart Claude Code"
        ;;
    *"RALPH_GH_REPO_TOKEN"*|*"RALPH_HERO_GITHUB_TOKEN"*)
        echo "  Rotation: regenerate PAT → update Claude Code settings → restart Claude Code"
        echo "  Or migrate to gh auth: gh auth login -s repo,project,read:org && remove the env var"
        ;;
esac
```

**Probe variable note**: the probe uses `GH_TOKEN=` to inject the token into a subshell-only context. This does NOT violate the MCP-server contract test (which is about MCP env vars, not gh CLI invocations).

#### 2. No additional helper scripts needed

`resolve-env.sh` is already sourced at line 229. The new section uses standard shell built-ins and the already-resolved `$resolved_token` variable from line 276.

### Success Criteria

#### Automated Verification:
- [ ] `just doctor` exits 0 when `gh auth` is valid and no env tokens are set
- [ ] `just doctor` exits 0 when `RALPH_HERO_GITHUB_TOKEN` is valid (regression check)
- [ ] `just doctor` exits 1 when no token resolvable (regression check)
- [ ] `bash -n plugin/ralph-hero/justfile` (syntax check; just recipes are bash bodies)

#### Manual Verification:
- [ ] With only `gh auth` set (no env vars), `just doctor` shows `repo ops → gh auth (user: <login>)` and the `gh auth refresh` rotation hint.
- [ ] With `RALPH_HERO_GITHUB_TOKEN` set, `just doctor` shows that source and the "regenerate PAT" rotation hint.
- [ ] With `RALPH_GH_REPO_TOKEN` + `RALPH_GH_PROJECT_TOKEN` set (split-token mode), both lines show the explicit env source.
- [ ] With an expired token, the probe section reports `FAIL: token probe failed` and the right `Fix:` line.
- [ ] With gh missing a scope (e.g., logged in with only `repo`), the WARN line fires for `project`.

**Implementation Note**: Pause for manual confirmation before proceeding to Phase 3.

---

## Phase 3: Setup Skill, README, and CLAUDE.md Updates

### Overview

Flip the documented primary path from "paste a PAT into settings.json" to "run `gh auth login`." Add a 3-line rotation guide to README. Update CLAUDE.md env-var table to reflect the new optional status of `RALPH_HERO_GITHUB_TOKEN`.

### Changes Required

#### 1. Update setup skill

**File**: `plugin/ralph-hero/skills/setup/SKILL.md:36-110`

Replace the "Quick Start (Minimum Viable Config)" section through "Advanced: Split-Owner / Dual-Token" with this revised structure:

```markdown
## Quick Start (Minimum Viable Config)

Ralph needs **one authenticated GitHub identity** and **three settings**.

### 1. Authenticate with `gh` (recommended)

```bash
gh auth login -s repo,project,read:org
```

This stores a token in your system keychain. ralph-hero reads it automatically — no settings.json edits needed for the token.

To rotate later: `gh auth refresh -s repo,project,read:org`. To check status: `just doctor` (or `gh auth status`).

### 1b. Detect Install Scope

Before writing the *non-token* configuration, determine where to write it:

1. Read `~/.claude/plugins/installed_plugins.json`
2. Find the `ralph-hero@ralph-hero` entry
3. Check the `"scope"` field of the latest entry

**If scope is `"user"`:** write env vars to `~/.claude/settings.json` under `"env"`.
**If scope is `"project"`:** write env vars to `<project>/.claude/settings.local.json` under `"env"`.
**If scope cannot be determined:** fall back to `settings.local.json` and warn.

### 2. Add the Three Settings to Claude Code

```json
{
  "env": {
    "RALPH_GH_OWNER": "your-github-username-or-org",
    "RALPH_GH_REPO": "your-repo-name",
    "RALPH_GH_PROJECT_NUMBER": "1"
  }
}
```

If you don't have a project number yet, omit it — this skill will create one.

### 3. Restart Claude Code

The MCP server reads environment + `gh` keychain at startup. Restart Claude Code, then run `/ralph-hero:setup` again.

### Where NOT to put tokens

- **Don't put tokens in `.mcp.json`** — env vars belong in Claude Code settings, not plugin config.
- **Don't commit tokens to git** — settings.local.json is gitignored.

## Advanced: Split-Token Configurations

If you can't use a single `gh` identity (e.g. fine-grained PAT for an org repo + classic PAT for personal project):

```json
{
  "env": {
    "RALPH_GH_REPO_TOKEN": "ghp_repo_only",
    "RALPH_GH_PROJECT_TOKEN": "ghp_project_only",
    "RALPH_GH_OWNER": "...",
    "RALPH_GH_REPO": "...",
    "RALPH_GH_PROJECT_NUMBER": "..."
  }
}
```

Explicit env vars always take precedence over `gh auth`. To rotate, regenerate the PAT and update settings.local.json — `gh auth` does not manage these.

You can also use `RALPH_HERO_GITHUB_TOKEN` as a single-PAT override (legacy form, still supported).
```

#### 2. README rotation guide

**File**: `/Users/dubiel/projects/ralph-hero/README.md`

Insert a new top-level section after "Setup" (or wherever existing token guidance lives — flag during implementation):

```markdown
## Token Expired?

```bash
gh auth refresh -s repo,project,read:org
```

Then restart Claude Code. Run `just doctor` if anything still looks off.

If you're using explicit `RALPH_GH_REPO_TOKEN` / `RALPH_GH_PROJECT_TOKEN` / `RALPH_HERO_GITHUB_TOKEN`: regenerate the PAT at https://github.com/settings/tokens, update `~/.claude/settings.json` (or `.claude/settings.local.json`), restart Claude Code.
```

#### 3. CLAUDE.md env-var table

**File**: `/Users/dubiel/projects/ralph-hero/CLAUDE.md` (the env-var table — currently around the line that says "RALPH_HERO_GITHUB_TOKEN | **Yes**")

Update the row:

```markdown
| `RALPH_HERO_GITHUB_TOKEN` | No (defaults to `gh auth token`) | GitHub PAT with `repo` + `project` scopes. Optional override — if unset, the MCP server falls back to the `gh` CLI keychain. |
```

Update the "Environment Variables" prose paragraph above the table to mention the gh fallback as the default, with env vars as overrides.

### Success Criteria

#### Automated Verification:
- [ ] Markdown lint clean (no broken links, valid frontmatter): `npx markdownlint plugin/ralph-hero/skills/setup/SKILL.md README.md CLAUDE.md` (if configured; otherwise visual review)
- [ ] No CI changes — these are doc-only edits

#### Manual Verification:
- [ ] A new user can follow the updated setup skill end-to-end with only `gh auth login` + 3 settings entries, and ralph-hero starts successfully.
- [ ] `/ralph-hero:setup` (re-run on existing setup) reads correctly and the recommended path is `gh auth login`.
- [ ] README "Token Expired?" section is visible from the repo root and the rotation flow is one command for gh-source users.

**Implementation Note**: Pause for manual confirmation before merging.

---

## Testing Strategy

### Unit Tests

- 5 new cases in `init-config.test.ts` covering the gh-auth fallback layer (each precedence position, undefined-when-nothing case)
- 3 new cases mocking `child_process.execSync` for `resolveGhAuthToken` (success, throw, cache)

### Integration Tests

No new integration tests — the existing `health_check` invocation in `just doctor` already exercises the resolved token end-to-end against the real GitHub API.

### Manual Testing Steps

1. **gh-only path**: `unset RALPH_HERO_GITHUB_TOKEN RALPH_GH_REPO_TOKEN RALPH_GH_PROJECT_TOKEN` → `gh auth login -s repo,project,read:org` → restart Claude Code → run `/ralph-hero:status`. Expect success.
2. **env-var precedence**: With `gh auth` valid, set `RALPH_HERO_GITHUB_TOKEN=invalid_token` in `settings.local.json` → restart → expect 401 from health_check (env wins, gh ignored).
3. **Split-token preserved**: Set `RALPH_GH_REPO_TOKEN` and `RALPH_GH_PROJECT_TOKEN` to two distinct valid tokens → restart → expect both work, `just doctor` reports both as explicit sources.
4. **Doctor diagnostics**: With only `gh auth` configured, `just doctor` shows `repo ops → gh auth (user: <login>)` and a one-line rotation hint.
5. **Expired token diagnosis**: Manually expire the gh token (or use a known-bad PAT) → `just doctor` probe reports FAIL with the correct `Fix:` line for the source.
6. **gh missing**: Test in a container without `gh` installed and without env tokens → expect the new startup error message leading with `gh auth login`.

## Performance Considerations

- One additional subprocess (`gh auth token`) at MCP startup when env vars are empty. Subprocess timeout: 3s. Cached after first call. No per-request impact.
- `just doctor` adds one `gh auth status` and one `gh api graphql` probe — net ~1-2 seconds of extra wall time when running diagnostics. Acceptable.

## Migration Notes

- No data migration. Pure additive change.
- Users with existing `RALPH_HERO_GITHUB_TOKEN` setups see zero behavior change.
- Users on a fresh install can skip the PAT-paste step entirely.
- The 2026-02-13 anti-`GH_TOKEN`-collision invariant is preserved: gh subprocess output flows into internal `repoToken` only; the contract test at `init-config.test.ts:218` continues to forbid `GH_TOKEN`/`GITHUB_TOKEN` env vars.

## References

- Original token-management research: `thoughts/shared/research/2026-03-25-token-management-setup-skill-improvement.md`
- Cross-tool token survey: `thoughts/shared/research/2026-03-25-github-token-management-across-tools.md`
- Doctor command genesis (closed): `thoughts/shared/research/2026-02-21-GH-0073-ralph-doctor-cli-command.md`
- Anti-collision origin: `thoughts/shared/plans/2026-02-13-setup-friction-fixes.md`
- MCP server entry point: `plugin/ralph-hero/mcp-server/src/index.ts:33-125`
- Existing `just doctor` recipe: `plugin/ralph-hero/justfile:224-390`
- Contract test: `plugin/ralph-hero/mcp-server/src/__tests__/init-config.test.ts:218`

## Follow-ups (Not in This Plan)

- **Multi-account `--user` delegation** for true Flavor B (separate GitHub accounts for repo vs project) — file as separate issue once same-account adoption is observed.
- **`/ralph-hero:doctor` skill** wrapping `just doctor` for in-Claude-Code diagnostic UX — file if `just doctor` proves unwieldy in practice.
- **Auto-prompt `gh auth refresh` on 401** during MCP runtime — much larger scope; only worth it if mid-session expiry becomes a recurring pain.
