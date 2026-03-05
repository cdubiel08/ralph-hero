# Design: Multi-Repo Portfolio Management

**Date:** 2026-03-04
**Status:** Approved
**Author:** Chad Dubiel + Claude

## Problem

A tech lead managing 5-15 microservices on a single GitHub Projects V2 board cannot efficiently create and coordinate work across repos. Features that span 2-3 repos require manual `repo` overrides on every tool call, manual dependency wiring, and remembering per-repo conventions (labels, assignees, estimates). There is no way to describe a feature once and have Ralph decompose it into the right repo-specific issues.

## Solution

Three interconnected capabilities:

1. **Repo Registry** (`.ralph-repos.yml`) — teaches Ralph about your repos, their domains, defaults, and common decomposition patterns
2. **Bootstrap Command** (`setup-repos` skill) — generates the registry by analyzing linked repos via semantic discovery
3. **Feature Decomposition** (`decompose_feature` tool) — splits features across repos using registry + patterns

## Design

### 1. Repo Registry (`.ralph-repos.yml`)

Located in the project's primary repo root. Loaded at MCP server startup.

```yaml
version: 1

repos:
  api-gateway:
    owner: myorg                          # optional, defaults to RALPH_GH_OWNER
    domain: "API gateway, request routing, auth middleware, rate limiting"
    tech: [typescript, express, openapi]
    defaults:
      labels: [service:gateway]
      assignees: [alice, bob]
      estimate: S
    paths:
      - src/routes/
      - src/middleware/

  user-service:
    owner: myorg
    domain: "User management, profiles, authentication, sessions"
    tech: [typescript, prisma, postgresql]
    defaults:
      labels: [service:users]
      assignees: [carol]
    paths:
      - src/models/
      - src/services/user/

  frontend-app:
    owner: myorg
    domain: "React SPA, UI components, client-side state, API integration"
    tech: [typescript, react, vite]
    defaults:
      labels: [frontend, ui]
    paths:
      - src/components/
      - src/pages/

patterns:
  api-feature:
    description: "New API endpoint with frontend UI"
    decomposition:
      - repo: user-service
        role: "Data model and business logic"
      - repo: api-gateway
        role: "Route definition and middleware"
      - repo: frontend-app
        role: "UI components and API client"
    dependency-flow: [user-service, api-gateway, frontend-app]

  backend-only:
    description: "Backend change with no UI"
    decomposition:
      - repo: user-service
        role: "Business logic changes"
      - repo: api-gateway
        role: "Route/middleware updates if needed"
    dependency-flow: [user-service, api-gateway]
```

Key decisions:
- `domain` is natural-language for LLM-based routing when no pattern matches
- `tech` and `paths` are informational — help Ralph write better issue descriptions and help the bootstrap command categorize repos
- `defaults` eliminate the manual override tax on every `create_issue` call
- `patterns` are optional — the system works without them using domain-based reasoning
- Config lives in the "hub" repo (where your project board lives), not duplicated across all repos

### 2. Bootstrap Command (`setup-repos` skill)

A skill (not an MCP tool) that generates `.ralph-repos.yml` by analyzing the project's linked repos.

**Flow:**

1. Query project's linked repositories (GraphQL)
2. For each repo, spawn a parallel sub-agent that:
   - Reads README.md
   - Reads package.json / Cargo.toml / go.mod / etc.
   - Lists top-level directory structure
   - Samples key source directories (src/, lib/, app/)
   - Returns structured analysis: `{ domain, tech, keyPaths, suggestedLabels }`
3. Synthesize analyses into draft `.ralph-repos.yml`:
   - Infer domain descriptions from README + code structure
   - Detect tech stack from manifest files
   - Suggest default labels based on repo naming conventions
   - Propose 2-3 decomposition patterns based on repo relationships
4. Present draft to user for review, flagging low-confidence inferences
5. Write `.ralph-repos.yml` and commit

Key decisions:
- Interactive skill (needs user review), not an MCP tool
- Re-runnable — merges new repos into existing config, preserving hand-edits (diff-and-prompt approach)
- Sub-agent per repo for parallel analysis — uses GitHub MCP tools, no local clone needed
- Pattern inference is best-effort — always presented as suggestions

### 3. Feature Decomposition (`decompose_feature` tool)

New MCP tool that splits a feature description into repo-specific issues.

**Input:**
- `title`: Feature title
- `description`: Feature description
- `pattern`: Optional pattern name from registry
- `dryRun`: Optional, defaults to true — preview without creating issues

**Output:**
- `proposed_issues`: Array of `{ repo, title, body, labels, assignees, estimate, role }`
- `dependency_chain`: Ordered dependency relationships
- `matched_pattern`: Which pattern was used (or "domain-inferred")

**How it works:**

1. **Pattern match** — if `pattern` specified, use it. Otherwise, send feature description + all repo `domain` fields to the LLM and ask which repos are involved and in what roles
2. **Issue generation** — for each repo in the decomposition, generate title and body scoped to that repo's role, incorporating `domain` and `tech` context
3. **Defaults applied** — labels, assignees, estimate pulled from `.ralph-repos.yml`
4. **Dependency wiring** — uses `dependency-flow` from the pattern, or infers ordering from roles (data layer -> API layer -> UI layer)
5. **Dry run by default** — returns the proposal. User confirms, then Ralph calls `create_issue` + `add_dependency` for each

### 4. Enhanced Existing Tools

**`create_issue`** — registry defaults applied automatically:
- Look up repo in `.ralph-repos.yml`
- Resolve owner from registry (no more manual `owner` override)
- Merge defaults: labels are additive (args + registry), assignees/estimate are fallback (only when arg omitted)
- Explicit args always win

**`list_issues`** — new optional `repo` filter parameter:
- Filters project items to only those from the specified repository
- Post-fetch filtering on data Ralph already has — no new API calls

**`pipeline_dashboard`** — new optional `groupBy: "repo"` parameter:
- Groups dashboard output by repository within a project
- Works alongside existing project grouping
- Combinable with `projectNumbers` for cross-project x cross-repo matrix

**`ralph-split` skill** — enhanced for cross-repo decomposition:
- Detects cross-repo concern in large issues
- Consults `.ralph-repos.yml`
- Calls `decompose_feature` under the hood
- Creates sub-issues across repos with dependencies

**`resolveRepoFromProject()`** — tolerates 2+ linked repos:
- With registry loaded: uses first repo in registry as default (or `defaultRepo` field)
- Without registry: existing behavior unchanged

### 5. Config Loading & Error Handling

**Startup flow:**
1. Load env vars (existing)
2. `initGitHubClient()` (existing)
3. `resolveRepoFromProject()` (existing, now tolerates 2+ repos)
4. `loadRepoRegistry()` (NEW) — looks for `.ralph-repos.yml` in primary repo, parses/validates, stores in `client.config.repoRegistry`

**When registry is not found:** everything works exactly as today. Zero breaking changes.

**Error handling:**

| Scenario | Behavior |
|----------|----------|
| Registry references repo not linked to project | Warning at startup, repo still usable via direct API |
| `decompose_feature` with unknown pattern name | Error listing available patterns |
| `decompose_feature` with no pattern + no matching domains | Returns all repos as candidates, asks user to narrow |
| Registry has stale assignee (person left team) | GitHub API error on `create_issue` — surfaced as-is |
| Registry YAML is malformed | Startup error with line number, server starts without registry |

## Out of Scope

- **Cross-repo implementation** — `ralph-impl` still works in one repo at a time. Cross-repo orchestration (multiple worktrees, coordinated PRs) is a future layer.
- **Automatic registry updates** — registry is manually maintained after bootstrap. No file-watcher or auto-sync.
- **PR coordination** — linked PRs across repos for a feature. Each repo's PR lifecycle stays independent.
- **Workflow state per repo** — all repos share the project board's workflow states. No per-repo state machines.

## Change Summary

| Component | Change |
|-----------|--------|
| `.ralph-repos.yml` | New config file (registry + patterns) |
| `setup-repos` skill | New — bootstraps registry from linked repos |
| `decompose_feature` tool | New — splits features across repos |
| `create_issue` tool | Enhanced — registry defaults applied |
| `list_issues` tool | Enhanced — `repo` filter param |
| `pipeline_dashboard` tool | Enhanced — `groupBy: "repo"` |
| `ralph-split` skill | Enhanced — cross-repo decomposition path |
| `resolveRepoFromProject()` | Fixed — tolerates 2+ repos with registry |
| `index.ts` startup | Enhanced — loads registry |
