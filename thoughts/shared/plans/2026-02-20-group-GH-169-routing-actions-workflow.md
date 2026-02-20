---
date: 2026-02-20
status: draft
github_issues: [169, 171]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/169
  - https://github.com/cdubiel08/ralph-hero/issues/171
primary_issue: 169
---

# Routing Actions Workflow - Atomic Implementation Plan

## Overview
2 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-169 | Create GitHub Actions workflow scaffold for issue routing triggers | XS |
| 2 | GH-171 | Implement routing evaluation and project field assignment in Actions | S |

**Why grouped**: GH-171's routing script is invoked by GH-169's workflow. The workflow env vars and the script's env var reads are tightly coupled — merging separately would leave a non-functional workflow. Shipping together ensures the workflow is immediately operational.

## Current State Analysis

- `.github/workflows/` has `ci.yml` and `release.yml` as reference patterns — no routing workflow
- `scripts/` directory has 4 shell scripts — no `scripts/routing/` directory
- No `.ralph-routing.yml` exists anywhere in the repo
- No standalone Node.js scripts outside `node_modules`/`dist` — GH-171 creates the first
- `GITHUB_TOKEN` cannot write to Projects V2 — must use `ROUTING_PAT` secret with `repo` + `project` scopes
- `release.yml` uses `concurrency: { group: release, cancel-in-progress: false }` — same pattern needed for routing
- `ci.yml` uses `actions/checkout@v4`, `actions/setup-node@v4` with npm cache — same actions apply
- Dependencies #167 (matching engine) and #168 (config loader) are not yet complete — use inline stubs

## Desired End State

### Verification
- [ ] `.github/workflows/route-issues.yml` triggers on `issues: [opened, labeled]` and `pull_request: [opened, ready_for_review]`
- [ ] Workflow uses `ROUTING_PAT` secret (not `GITHUB_TOKEN`) for Projects V2 access
- [ ] Workflow validates `ROUTING_PAT` is set before running routing script
- [ ] Concurrency group prevents parallel routing for the same issue/PR
- [ ] `scripts/routing/route.js` reads env vars set by workflow
- [ ] Script resolves issue/PR node ID, adds to project, sets field values
- [ ] Script handles both user and organization project owners
- [ ] Stub `evaluateRules` matches on labels (replaced by #167)
- [ ] Stub `loadConfig` reads YAML config (replaced by #168)
- [ ] `addProjectV2ItemById` is idempotent — no duplicate handling needed
- [ ] Script exits cleanly when no config file or no rules match

## What We're NOT Doing
- No formal matching engine (that's #167)
- No validated config loader (that's #168)
- No audit trail or error reporting (that's #173)
- No fork PR routing (`pull_request` from forks can't access secrets)
- No TypeScript for the routing script (plain CJS for zero build step)
- No tests for GraphQL mutation logic (requires live API; pure function tests only)
- No `.ralph-routing.yml` example file (created by `configure_routing` tool from #178)

## Implementation Approach

Phase 1 creates the GitHub Actions workflow YAML with triggers, auth, and env var setup. Phase 2 creates the standalone Node.js routing script that the workflow invokes, plus updates the workflow to add `npm ci` for script dependencies.

---

## Phase 1: GH-169 — Create GitHub Actions workflow scaffold
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/169 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0169-routing-actions-workflow-scaffold.md

### Changes Required

#### 1. Create workflow file
**File**: `.github/workflows/route-issues.yml` (NEW)

**Changes**: Create GitHub Actions workflow:

```yaml
name: Route Issues

on:
  issues:
    types: [opened, labeled]
  pull_request:
    types: [opened, ready_for_review]

# Prevent concurrent routing for the same issue/PR.
# cancel-in-progress: false ensures a routing run isn't killed mid-mutation.
concurrency:
  group: route-${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  route:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Verify ROUTING_PAT is set
        run: |
          if [ -z "$ROUTING_PAT" ]; then
            echo "::error::ROUTING_PAT secret is not set. GITHUB_TOKEN cannot write to Projects V2."
            exit 1
          fi
        env:
          ROUTING_PAT: ${{ secrets.ROUTING_PAT }}

      - name: Route issue or PR
        env:
          ROUTING_PAT: ${{ secrets.ROUTING_PAT }}
          GH_OWNER: ${{ github.repository_owner }}
          GH_REPO: ${{ github.event.repository.name }}
          ITEM_NUMBER: ${{ github.event.issue.number || github.event.pull_request.number }}
          ITEM_LABELS: ${{ toJSON(github.event.issue.labels || github.event.pull_request.labels) }}
          EVENT_NAME: ${{ github.event_name }}
          RALPH_ROUTING_CONFIG: .ralph-routing.yml
        run: node scripts/routing/route.js
```

Key design decisions:
- 4 triggers matching the research: `issues: [opened, labeled]`, `pull_request: [opened, ready_for_review]`
- Concurrency group per item number — prevents racing mutations on the same issue
- `cancel-in-progress: false` — running routing is never interrupted mid-mutation
- `ROUTING_PAT` verification step before main routing step
- All env vars match what GH-171's script expects

### Success Criteria
- [x] Automated: YAML syntax valid (checked by GitHub on push)
- [ ] Manual: Workflow appears in Actions tab after merge

**Creates for next phase**: Workflow scaffold that invokes `scripts/routing/route.js` (created in Phase 2)

---

## Phase 2: GH-171 — Implement routing evaluation script
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/171 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0171-routing-evaluation-actions-script.md | **Depends on**: Phase 1 (workflow provides env vars)

### Changes Required

#### 1. Create routing script package
**File**: `scripts/routing/package.json` (NEW)

**Changes**:
```json
{
  "name": "ralph-routing",
  "version": "1.0.0",
  "private": true,
  "description": "GitHub Actions routing script for issue/PR project assignment",
  "dependencies": {
    "@octokit/graphql": "^9.0.3",
    "yaml": "^2.7.0"
  }
}
```

Note: Uses same `@octokit/graphql` version as the MCP server for consistency. `yaml` for config parsing.

#### 2. Create routing script
**File**: `scripts/routing/route.js` (NEW)

**Changes**: Create standalone CommonJS Node.js script with the following structure:

- **Env var reading** (lines 1-20): Read `ROUTING_PAT`, `GH_OWNER`, `GH_REPO`, `ITEM_NUMBER`, `ITEM_LABELS`, `EVENT_NAME`, `RALPH_ROUTING_CONFIG` from `process.env`. Validate `ROUTING_PAT` is present (exit 1 with `::error::` annotation if not). Initialize `graphql.defaults()` with auth header.
- **`loadConfig(configPath)`** function: Read YAML file via `fs.readFileSync`, parse with `yaml.parse`. Return `{ rules: [] }` if file missing. Marked with `// TODO: replace with import from #168 config loader`.
- **`evaluateRules(rules, issueContext)`** function: Simple label-matching stub — returns rules where any `rule.match.labels` value is found in `issueContext.labels`. Marked with `// TODO: replace with import from #167 matching engine`.
- **`fetchContentNodeId(gql, owner, repo, number, eventName)`** function: GraphQL query resolving issue or PR number to node ID. Uses `repository.issue(number:)` or `repository.pullRequest(number:)` based on `eventName`.
- **`fetchProjectMeta(gql, owner, projectNumber)`** function: Resolves project node ID + field IDs + option IDs. Tries both `user` and `organization` owner types (same pattern as MCP server's `fetchProjectForCache`). Returns `{ projectId, fields }` where fields is a map of field name -> `{ id, options }`.
- **`addToProject(gql, projectId, contentId)`** function: Calls `addProjectV2ItemById` mutation. Returns project item node ID. Idempotent — re-adding returns existing item.
- **`setField(gql, projectId, itemId, fields, fieldName, optionName)`** function: Calls `updateProjectV2ItemFieldValue` mutation. Warns and skips if field or option not found.
- **`main()`** async function: Load config → build issue context from env → evaluate rules → for each matched rule: fetch content ID, fetch project meta, add to project, set field values (workflowState, priority, estimate). Console.log progress. Catch and `process.exit(1)` on failure.

#### 3. Update workflow to install script dependencies
**File**: `.github/workflows/route-issues.yml`
**Where**: After "Setup Node.js" step, before "Verify ROUTING_PAT is set"

**Changes**: Add `npm ci` step:
```yaml
      - name: Install routing dependencies
        run: npm ci
        working-directory: scripts/routing
```

#### 4. Generate package-lock.json
Run `cd scripts/routing && npm install` to generate `package-lock.json` (required for `npm ci` in the workflow).

### Success Criteria
- [x] Automated: `node -c scripts/routing/route.js` passes syntax check
- [x] Automated: `cd scripts/routing && npm install` succeeds
- [ ] Manual: Script runs when triggered by workflow (requires `ROUTING_PAT` secret configured)
- [ ] Manual: Script exits cleanly when `.ralph-routing.yml` doesn't exist

---

## Integration Testing
- [x] Workflow YAML is syntactically valid
- [x] Routing script passes `node -c` syntax check
- [x] `scripts/routing/package.json` dependencies install cleanly
- [x] Script env var names match workflow env var names exactly
- [x] Concurrency group uses correct expression for issue/PR number
- [x] `ROUTING_PAT` verification step exits 1 when secret missing
- [ ] End-to-end: Issue opened triggers workflow → script routes to project (requires ROUTING_PAT secret)

## References
- Research GH-169: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0169-routing-actions-workflow-scaffold.md
- Research GH-171: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0171-routing-evaluation-actions-script.md
- Workflow patterns: `.github/workflows/ci.yml` (checkout, setup-node, npm ci), `.github/workflows/release.yml` (concurrency, secrets)
- GraphQL mutations: `project-management-tools.ts:204-218` (addProjectV2ItemById), `helpers.ts:248-260` (updateProjectV2ItemFieldValue)
- Owner type resolution: MCP server's `fetchProjectForCache` tries both `user` and `organization`
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/126 (GitHub Actions routing workflow)
