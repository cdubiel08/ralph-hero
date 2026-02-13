---
date: 2026-02-13
status: draft
github_issue: null
github_url: null
---

# Setup Friction Fixes - Implementation Plan

## Overview

Six issues discovered during real-world setup where repo owner (org) != project owner (user), tokens have different scopes, and validation is missing. This plan addresses all six friction points from the setup report.

## Current State Analysis

- **Token handling** (`index.ts:23-29`): Single token chain `RALPH_HERO_GITHUB_TOKEN → GITHUB_PERSONAL_ACCESS_TOKEN → GITHUB_TOKEN → GH_TOKEN`. One token used for everything.
- **Owner config** (`types.ts:248-253`): `GitHubClientConfig` has single `owner` field. Used for both `repository(owner:)` and `user/org(login:).projectV2(number:)` GraphQL queries.
- **`.mcp.json`** passes `GITHUB_TOKEN` and `GH_TOKEN` from environment, which collides with `gh` CLI's OAuth token.
- **`ensureFieldCache`** in both `project-tools.ts:65` and `issue-tools.ts:19` uses `owner` for project lookups. `resolveFullConfig` in `issue-tools.ts:310` uses `owner` for both repo and project.
- **`ralph-setup` skill** does a health check but never validates repo access or project access separately.
- **`ralph-team` skill** spawns discovery agents immediately with no pre-flight check for empty projects.

## Desired End State

A user with an org repo (`centerpoint-energy/repo`) and a personal project (`chad-a-dubiel_cpe` project #3) can configure ralph-hero with separate credentials and owners, get clear validation at setup time, and see immediate feedback if something is misconfigured.

### Verification
- [ ] Can configure separate repo token and project token
- [ ] Can configure separate repo owner and project owner
- [ ] `.mcp.json` does not set `GITHUB_TOKEN` or `GH_TOKEN`
- [ ] `ralph-setup` validates repo access, project access, and field existence
- [ ] `ralph-team` detects empty project before spawning agents
- [ ] Startup logs clearly show which tokens and owners are in use

## What We're NOT Doing

- OAuth flow or token generation (user creates PATs manually)
- Hot-reload of MCP servers (Claude Code limitation — just document restart requirement)
- Automatic token scope detection via GitHub API (scopes aren't exposed in GraphQL)
- Changes to the GraphQL client layer itself (just config threading)

## Implementation Approach

Bottom-up: fix the data model first (Phase 1), then the env/config layer (Phase 2), then clean up `.mcp.json` (Phase 3), then add validation (Phase 4), then fix the skills (Phase 5-6).

---

## Phase 1: Separate Project Owner in Config & Client

### Overview
Add `projectOwner` to `GitHubClientConfig` so project GraphQL queries can target a different user/org than the repo owner.

### Changes Required

#### 1. Add `projectOwner` to config type
**File**: `plugin/ralph-hero/mcp-server/src/types.ts`
**Changes**: Add `projectOwner?: string` to `GitHubClientConfig` (line 248-253). When unset, falls back to `owner`.

```typescript
export interface GitHubClientConfig {
  token: string;
  owner?: string;
  repo?: string;
  projectNumber?: number;
  projectOwner?: string;  // Defaults to owner if unset
}
```

#### 2. Add helper to resolve project owner
**File**: `plugin/ralph-hero/mcp-server/src/types.ts`
**Changes**: Add utility function:

```typescript
export function resolveProjectOwner(config: GitHubClientConfig): string | undefined {
  return config.projectOwner || config.owner;
}
```

#### 3. Update `initGitHubClient` to read `RALPH_GH_PROJECT_OWNER`
**File**: `plugin/ralph-hero/mcp-server/src/index.ts`
**Changes**: Add env var reading (after line 47):

```typescript
const projectOwner = process.env.RALPH_GH_PROJECT_OWNER || owner;
```

Pass to `createGitHubClient`:
```typescript
return createGitHubClient({
  token,
  owner: owner || undefined,
  repo: repo || undefined,
  projectNumber,
  projectOwner: projectOwner || undefined,
});
```

#### 4. Update all project-query callsites to use `projectOwner`

**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`
- `ensureFieldCache` (line 65): Change `owner` param to `resolveProjectOwner(client.config)`
- `fetchProject` (line 482): Already receives owner as param — callers need to pass project owner
- `ralph_hero__get_project` (line 248): Use `args.owner || resolveProjectOwner(client.config)` for project queries
- `ralph_hero__list_project_items` (line 306): Same — use project owner for project queries
- `ralph_hero__setup_project` (line 122): Use args.owner for project creation (this IS the project owner)

**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
- `ensureFieldCache` (line 19): Receives owner param — callers must pass project owner
- `resolveFullConfig` (line 310): Add `projectOwner` to return type, resolving from config
- All tools calling `ensureFieldCache`: Pass `projectOwner` instead of `owner` for the field cache

**File**: `plugin/ralph-hero/mcp-server/src/tools/view-tools.ts`
- Same pattern: use project owner for project/field queries

**Key principle**: `owner` + `repo` = repository queries. `projectOwner` + `projectNumber` = project queries. Never mix them.

### Success Criteria

#### Automated Verification
- [x] `npm run build` succeeds with no type errors

#### Manual Verification
- [ ] With `RALPH_GH_OWNER=centerpoint-energy` and `RALPH_GH_PROJECT_OWNER=chad-a-dubiel_cpe`, `ralph_hero__get_project` returns the personal project
- [ ] `ralph_hero__list_issues` still uses `centerpoint-energy` for repo queries

---

## Phase 2: Two-Token Support

### Overview
Support separate tokens for repo operations vs project operations. This handles the case where the repo PAT (org-scoped) doesn't have `project` scope, and the project PAT (personal) doesn't have org repo access.

### Changes Required

#### 1. Add `projectToken` to config
**File**: `plugin/ralph-hero/mcp-server/src/types.ts`
**Changes**: Add to `GitHubClientConfig`:

```typescript
export interface GitHubClientConfig {
  token: string;
  projectToken?: string;  // Separate token for project operations. Falls back to token.
  owner?: string;
  repo?: string;
  projectNumber?: number;
  projectOwner?: string;
}
```

#### 2. Create dual-client architecture
**File**: `plugin/ralph-hero/mcp-server/src/github-client.ts`
**Changes**: `createGitHubClient` creates a second `graphqlWithAuth` instance when `projectToken` differs from `token`. Expose two query methods:

```typescript
export interface GitHubClient {
  /** Execute a GraphQL query for REPO operations */
  query: <T>(...) => Promise<T>;
  /** Execute a GraphQL query for PROJECT operations */
  projectQuery: <T>(...) => Promise<T>;
  /** Execute a mutation for REPO operations */
  mutate: <T>(...) => Promise<T>;
  /** Execute a mutation for PROJECT operations */
  projectMutate: <T>(...) => Promise<T>;
  // ... rest unchanged
}
```

When `projectToken` is not set, `projectQuery` and `projectMutate` delegate to `query` and `mutate` (single-token behavior preserved).

#### 3. Update `initGitHubClient` for two tokens
**File**: `plugin/ralph-hero/mcp-server/src/index.ts`
**Changes**:

```typescript
// Repo token: for repository operations (issues, PRs, comments)
const repoToken =
  process.env.RALPH_GH_REPO_TOKEN ||
  process.env.RALPH_HERO_GITHUB_TOKEN ||
  process.env.GITHUB_PERSONAL_ACCESS_TOKEN ||
  process.env.GITHUB_TOKEN ||
  process.env.GH_TOKEN;

// Project token: for Projects V2 operations (fields, workflow state)
// Falls back to repo token if not set
const projectToken =
  process.env.RALPH_GH_PROJECT_TOKEN || repoToken;
```

Log which tokens are in use:
```typescript
console.error(`[ralph-hero] Repo token: ${repoTokenSource}`);
if (projectToken !== repoToken) {
  console.error(`[ralph-hero] Project token: ${projectTokenSource} (separate)`);
}
```

#### 4. Update tool callsites
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`
- `fetchProject`: Use `client.projectQuery` instead of `client.query`
- `createSingleSelectField`: Use `client.projectMutate` instead of `client.mutate`
- `ralph_hero__setup_project`: Uses `client.projectMutate` for project creation
- `ralph_hero__list_project_items`: Uses `client.projectQuery` for item fetches

**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
- `fetchProjectForCache`: Use `client.projectQuery`
- `resolveIssueNodeId`, `ralph_hero__list_issues`, etc.: Keep using `client.query` (repo operations)
- `ralph_hero__update_workflow_state`, `ralph_hero__update_issue_field`: Use `client.projectMutate` for field mutations
- `ralph_hero__add_to_project`: Use `client.projectMutate`

**File**: `plugin/ralph-hero/mcp-server/src/tools/view-tools.ts`
- All view operations: Use `client.projectQuery`/`client.projectMutate`

**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`
- Sub-issues, dependencies: Keep using `client.query` (repo operations)

### Success Criteria

#### Automated Verification
- [x] `npm run build` succeeds
- [x] Single-token config still works (backward compatible — projectQuery/projectMutate delegate to query/mutate when no separate token)

#### Manual Verification
- [ ] With separate `RALPH_GH_REPO_TOKEN` (org PAT) and `RALPH_GH_PROJECT_TOKEN` (personal PAT), can both list issues and update workflow state

---

## Phase 3: Clean Up `.mcp.json` (Token Collision Fix)

### Overview
Stop passing `GITHUB_TOKEN` and `GH_TOKEN` through `.mcp.json` to prevent colliding with `gh` CLI's OAuth token.

### Changes Required

#### 1. Update `.mcp.json`
**File**: `plugin/ralph-hero/.mcp.json`
**Changes**:

```json
{
  "mcpServers": {
    "ralph-github": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.js"],
      "env": {
        "RALPH_GH_REPO_TOKEN": "${RALPH_GH_REPO_TOKEN}",
        "RALPH_GH_PROJECT_TOKEN": "${RALPH_GH_PROJECT_TOKEN}",
        "RALPH_HERO_GITHUB_TOKEN": "${RALPH_HERO_GITHUB_TOKEN}",
        "RALPH_GH_OWNER": "${RALPH_GH_OWNER}",
        "RALPH_GH_REPO": "${RALPH_GH_REPO}",
        "RALPH_GH_PROJECT_OWNER": "${RALPH_GH_PROJECT_OWNER}",
        "RALPH_GH_PROJECT_NUMBER": "${RALPH_GH_PROJECT_NUMBER}"
      }
    }
  }
}
```

**Removed**: `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`
**Added**: `RALPH_GH_REPO_TOKEN`, `RALPH_GH_PROJECT_TOKEN`, `RALPH_GH_PROJECT_OWNER`
**Kept**: `RALPH_HERO_GITHUB_TOKEN` as single-token fallback

#### 2. Update token resolution in `index.ts`
**File**: `plugin/ralph-hero/mcp-server/src/index.ts`
**Changes**: Simplify the chain. Inside the MCP server process, only ralph-prefixed vars are available:

```typescript
const repoToken =
  process.env.RALPH_GH_REPO_TOKEN ||
  process.env.RALPH_HERO_GITHUB_TOKEN;

const projectToken =
  process.env.RALPH_GH_PROJECT_TOKEN ||
  repoToken;

if (!repoToken) {
  console.error(
    "[ralph-hero] Error: No GitHub token found.\n\n" +
    "Set one of these environment variables:\n" +
    "  RALPH_GH_REPO_TOKEN      - Token with 'repo' scope (for issues/PRs)\n" +
    "  RALPH_GH_PROJECT_TOKEN   - Token with 'project' scope (for project fields)\n" +
    "  RALPH_HERO_GITHUB_TOKEN  - Single token with both scopes\n\n" +
    "For org repos where project is owned by a different user:\n" +
    "  RALPH_GH_REPO_TOKEN    = PAT with org repo access\n" +
    "  RALPH_GH_PROJECT_TOKEN = PAT with personal project access\n\n" +
    "Generate tokens at: https://github.com/settings/tokens\n" +
    "Required scopes: 'repo' and/or 'project'"
  );
  process.exit(1);
}
```

### Success Criteria

#### Automated Verification
- [x] `npm run build` succeeds
- [x] `GITHUB_TOKEN` is not set in MCP server's process env (removed from .mcp.json)

#### Manual Verification
- [ ] `gh project list` still works in the parent shell after MCP server starts
- [ ] MCP server works with only `RALPH_HERO_GITHUB_TOKEN` set (single-token mode)
- [ ] MCP server works with separate `RALPH_GH_REPO_TOKEN` and `RALPH_GH_PROJECT_TOKEN`

---

## Phase 4: Enhanced Health Check & Setup Validation

### Overview
Upgrade `ralph_hero__health_check` to validate repo access, project access, and field existence separately. Update `ralph-setup` skill to run this validation.

### Changes Required

#### 1. Expand health check tool
**File**: `plugin/ralph-hero/mcp-server/src/index.ts`
**Changes**: Replace simple health check with comprehensive validation:

```typescript
server.tool(
  "ralph_hero__health_check",
  "Validate GitHub API connectivity, token permissions, repo access, project access, and required fields",
  {},
  async () => {
    const checks: Record<string, { status: string; detail?: string }> = {};

    // 1. Auth check (repo token)
    try {
      const login = await client.getAuthenticatedUser();
      checks.auth = { status: "ok", detail: `Authenticated as ${login}` };
    } catch (e) {
      checks.auth = { status: "fail", detail: `Auth failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    // 2. Repo access check
    if (client.config.owner && client.config.repo) {
      try {
        await client.query(
          `query($owner: String!, $repo: String!) {
            repository(owner: $owner, name: $repo) { nameWithOwner }
          }`,
          { owner: client.config.owner, repo: client.config.repo },
        );
        checks.repoAccess = { status: "ok", detail: `${client.config.owner}/${client.config.repo}` };
      } catch (e) {
        checks.repoAccess = { status: "fail", detail: `Cannot access repo: ${e instanceof Error ? e.message : String(e)}. Token may lack 'repo' scope or org access.` };
      }
    } else {
      checks.repoAccess = { status: "skip", detail: "RALPH_GH_OWNER/RALPH_GH_REPO not set" };
    }

    // 3. Project access check (uses project token + project owner)
    const projOwner = resolveProjectOwner(client.config);
    const projNum = client.config.projectNumber;
    if (projOwner && projNum) {
      try {
        // Try user, then org
        const project = await fetchProject(client, projOwner, projNum);
        if (project) {
          checks.projectAccess = { status: "ok", detail: `${project.title} (#${projNum})` };

          // 4. Required fields check
          const requiredFields = ["Workflow State", "Priority", "Estimate"];
          const fieldNames = project.fields.nodes.map(f => f.name);
          const missing = requiredFields.filter(f => !fieldNames.includes(f));
          if (missing.length === 0) {
            checks.requiredFields = { status: "ok", detail: "All required fields present" };
          } else {
            checks.requiredFields = { status: "fail", detail: `Missing fields: ${missing.join(", ")}. Run /ralph-setup.` };
          }

          // 5. Project items check
          // (uses the existing list_project_items logic, limit 1)
          checks.projectItems = { status: "ok", detail: `Project has items` };
          // If 0 items:
          // checks.projectItems = { status: "warn", detail: "Project has 0 items. Add issues first." };
        } else {
          checks.projectAccess = { status: "fail", detail: `Project #${projNum} not found for owner "${projOwner}". Check RALPH_GH_PROJECT_OWNER.` };
        }
      } catch (e) {
        checks.projectAccess = { status: "fail", detail: `Project access failed: ${e instanceof Error ? e.message : String(e)}. Token may lack 'project' scope.` };
      }
    } else {
      checks.projectAccess = { status: "skip", detail: "RALPH_GH_PROJECT_NUMBER not set" };
    }

    // Summary
    const allOk = Object.values(checks).every(c => c.status === "ok" || c.status === "skip");
    return toolSuccess({
      status: allOk ? "ok" : "issues_found",
      checks,
      config: {
        repoOwner: client.config.owner || "(not set)",
        repo: client.config.repo || "(not set)",
        projectOwner: resolveProjectOwner(client.config) || "(not set)",
        projectNumber: client.config.projectNumber || "(not set)",
        tokenMode: client.config.projectToken ? "dual-token" : "single-token",
      },
    });
  },
);
```

Note: The actual implementation won't inline `fetchProject` here — it will import the shared helper or duplicate a minimal version. The pseudocode above shows the logic.

#### 2. Update `ralph-setup` skill
**File**: `plugin/ralph-hero/skills/ralph-setup/SKILL.md`
**Changes**:
- Step 1 (Validate Environment): Call the enhanced `ralph_hero__health_check` and display all check results
- If `repoAccess` fails: Stop with clear message about token scopes
- If `projectAccess` fails but `repoAccess` passes: Suggest setting `RALPH_GH_PROJECT_TOKEN` and `RALPH_GH_PROJECT_OWNER`
- Add new Step 1.5: "Fix Configuration" — if checks fail, prompt user for missing values

### Success Criteria

#### Automated Verification
- [x] `npm run build` succeeds
- [x] Health check returns structured JSON with all check results

#### Manual Verification
- [ ] With valid token: all checks pass
- [ ] With repo-only token: `repoAccess: ok`, `projectAccess: fail` with clear message
- [ ] With no token: clear error on startup

---

## Phase 5: Documentation & Restart Guidance

### Overview
Document the restart requirement and update `ralph-setup` to halt on health check failures. Agents call `ralph_hero__health_check` directly — no separate skill needed.

### Changes Required

#### 1. Update ralph-setup to halt on failure
**File**: `plugin/ralph-hero/skills/ralph-setup/SKILL.md`
**Changes**:
- Frontmatter: Change `model: opus` to `model: haiku` (setup is mechanical — just MCP tool calls and formatting)
- Step 1: Call `ralph_hero__health_check`. If any check has `status: "fail"`, **STOP** immediately and display the failing checks with remediation steps. Do not proceed to project creation.
- Step 7 (Final Report): Add restart note:

```markdown
**Important**: After changing environment variables, you must restart Claude Code
for the MCP server to pick up the new values. The MCP server reads environment
variables at startup and cannot be reloaded.
```

#### 2. Update README
**File**: `plugin/ralph-hero/README.md`
**Changes**: Add configuration section with all env vars:

```markdown
## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `RALPH_HERO_GITHUB_TOKEN` | Yes* | Single token with repo + project scopes |
| `RALPH_GH_REPO_TOKEN` | No | Separate token for repo operations |
| `RALPH_GH_PROJECT_TOKEN` | No | Separate token for project operations |
| `RALPH_GH_OWNER` | Yes | Repository owner (user or org) |
| `RALPH_GH_REPO` | Yes | Repository name |
| `RALPH_GH_PROJECT_OWNER` | No | Project owner if different from repo owner |
| `RALPH_GH_PROJECT_NUMBER` | Yes | GitHub Project V2 number |

*Either `RALPH_HERO_GITHUB_TOKEN` or `RALPH_GH_REPO_TOKEN` must be set.
```

### Success Criteria

#### Manual Verification
- [ ] `ralph-setup` halts with clear error when health check fails
- [x] README documents all env vars

---

## Testing Strategy

### Unit Tests (future)
- Token resolution with various env var combinations
- `resolveProjectOwner` fallback logic

### Integration Tests (manual)
1. **Single-token, same owner**: Set only `RALPH_HERO_GITHUB_TOKEN` + `RALPH_GH_OWNER` — should work as before
2. **Single-token, separate project owner**: Add `RALPH_GH_PROJECT_OWNER` — project queries go to different owner
3. **Dual-token, separate owners**: Full enterprise setup — repo token for org, project token for personal
4. **Missing token**: Clear error with all options listed
5. **Wrong scopes**: `repoAccess: fail` or `projectAccess: fail` with actionable message

## References

- Setup friction report (user feedback)
- `plugin/ralph-hero/mcp-server/src/index.ts` — token resolution
- `plugin/ralph-hero/mcp-server/src/types.ts` — GitHubClientConfig
- `plugin/ralph-hero/mcp-server/src/github-client.ts` — GraphQL client
- `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts` — project queries using owner
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` — issue queries + field cache
- `plugin/ralph-hero/skills/ralph-setup/SKILL.md` — setup workflow
- `plugin/ralph-hero/skills/ralph-team/SKILL.md` — team coordinator
