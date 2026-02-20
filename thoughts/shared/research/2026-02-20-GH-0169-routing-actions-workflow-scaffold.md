---
date: 2026-02-20
github_issue: 169
github_url: https://github.com/cdubiel08/ralph-hero/issues/169
status: complete
type: research
---

# GH-169: Create GitHub Actions Workflow Scaffold for Issue Routing Triggers

## Problem Statement

Create `.github/workflows/route-issues.yml` that triggers the routing system on issue and PR events. The workflow must handle authentication correctly (GitHub Projects V2 requires a PAT or GitHub App token — `GITHUB_TOKEN` cannot write to Projects V2), configure all 4 triggers, set up the Node.js environment, and pass the event payload to the routing script from #171.

## Current State Analysis

### Existing Workflow Patterns

The repository has two workflow files to reference:

**`.github/workflows/ci.yml`** — Reference patterns:
- Trigger: `push: branches: [main]` + `pull_request: branches: [main]`
- Job: `ubuntu-latest`, matrix Node.js versions (18, 20, 22)
- Steps: `actions/checkout@v4` → `actions/setup-node` with `cache: npm` → `npm ci` → `npm run build` → `npm test`
- Working directory: `defaults.run.working-directory: plugin/ralph-hero/mcp-server`
- No secrets

**`.github/workflows/release.yml`** — Reference patterns:
- Trigger: `push: branches: [main]` with `paths:` filter + `workflow_dispatch` with choice input
- Concurrency: `group: release`, `cancel-in-progress: false`
- Permissions: `contents: write`, `id-token: write`
- Secrets: `secrets.NPM_TOKEN` (for npm publish), `secrets.GITHUB_TOKEN` (for gh release)
- Step: git config + commit + push pattern for version bumps
- `[skip ci]` tag in commit messages to prevent loop

### Critical Auth Constraint

**`GITHUB_TOKEN` cannot write to GitHub Projects V2.** This is a hard limitation of the `GITHUB_TOKEN` automatic secret — it has project read permissions but not write permissions for Projects V2. The routing workflow requires:

- **`ROUTING_PAT`**: A Personal Access Token with `repo` + `project` scopes, OR
- A GitHub App installation token with `projects` permission

The workflow must use `secrets.ROUTING_PAT` (documented in workflow comments and README).

### Trigger Events

| Trigger | GitHub Actions syntax | Use case |
|---------|-----------------------|----------|
| Issue opened | `issues: types: [opened]` | Route new issues to project |
| Issue labeled | `issues: types: [labeled]` | Re-route when label added |
| PR opened | `pull_request: types: [opened]` | Route new PRs |
| PR ready for review | `pull_request: types: [ready_for_review]` | Route when draft → ready |

### Event Payload Access

GitHub Actions provides event payload via `github.event`. Key fields for routing:
- Issue number: `github.event.issue.number` (issues) or `github.event.pull_request.number` (PR)
- Labels: `github.event.issue.labels` or `github.event.pull_request.labels`
- Repo name: `github.event.repository.name`
- Owner: `github.repository_owner`
- Event type: `github.event_name` (`issues` or `pull_request`)

### Config File Location

`.ralph-routing.yml` must exist in the repository root at workflow run time. The workflow checks it out via `actions/checkout@v4` — no special path needed.

## Implementation Plan

### Workflow File: `.github/workflows/route-issues.yml`

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
    # Required for ROUTING_PAT to write to Projects V2
    # GITHUB_TOKEN alone cannot write to Projects V2 — PAT required
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Route issue or PR
        # Pass event context as environment variables to the routing script.
        # The routing script (scripts/routing/route.js, from #171) reads these
        # to load config and evaluate routing rules.
        env:
          # ROUTING_PAT must be set as a repository secret.
          # Required scopes: repo + project (GITHUB_TOKEN cannot write to Projects V2).
          ROUTING_PAT: ${{ secrets.ROUTING_PAT }}
          GH_OWNER: ${{ github.repository_owner }}
          GH_REPO: ${{ github.event.repository.name }}
          # Issue number (issues event) OR PR number (pull_request event)
          ITEM_NUMBER: ${{ github.event.issue.number || github.event.pull_request.number }}
          # JSON array of label objects: [{ name, color, ... }]
          ITEM_LABELS: ${{ toJSON(github.event.issue.labels || github.event.pull_request.labels) }}
          EVENT_NAME: ${{ github.event_name }}
          # Path to routing config (default: .ralph-routing.yml in repo root)
          RALPH_ROUTING_CONFIG: .ralph-routing.yml
        run: node scripts/routing/route.js
```

### Key Design Decisions

**Concurrency group per item** — prevents two routing runs for the same issue from racing. `cancel-in-progress: false` ensures a routing run that has already started a mutation isn't killed halfway through.

**Environment variable passing** — the routing script (#171) is a standalone Node.js script (not part of the MCP server), so event context is passed via `env`. This is the standard pattern for Actions-invoked scripts.

**`actions/setup-node@v4` without cache** — the routing script (#171) will be a single-file or small script with minimal dependencies. No `npm ci` step needed unless the script has a `package.json`. If it does, add:
```yaml
      - name: Install routing script dependencies
        run: npm ci
        working-directory: scripts/routing
```

**Node.js 20** — matches the minimum supported version from `ci.yml`. LTS at time of writing.

### README Section

Add to repo README (or `docs/routing.md`):

```markdown
## Issue Routing Setup

The `.github/workflows/route-issues.yml` workflow automatically routes new issues and PRs
to GitHub Projects based on rules in `.ralph-routing.yml`.

### Required Secrets

| Secret | Description |
|--------|-------------|
| `ROUTING_PAT` | GitHub Personal Access Token with `repo` + `project` scopes. **`GITHUB_TOKEN` cannot write to Projects V2.** |

### Configuration

Create `.ralph-routing.yml` in the repository root. See [routing config schema](#) for format.
```

### File Changes

| File | Change | Effort |
|------|--------|--------|
| `.github/workflows/route-issues.yml` | NEW — 4 triggers, auth setup, Node.js step | Primary |
| `README.md` (or `docs/routing.md`) | Add secrets setup section | Minor |
| No MCP server changes | Workflow is GitHub Actions infrastructure only | — |

## Dependency Coordination

**GH-169 (this issue)** is the scaffold only — it references `scripts/routing/route.js` which doesn't exist until #171 ships. The workflow file can be created and merged first; the `run: node scripts/routing/route.js` step will fail gracefully until #171 is implemented (the job will error, not the whole repo).

However, the recommended order is to merge #169 scaffold alongside or just before #171 so the workflow is immediately functional.

**Downstream:**
- #171 (routing evaluation script) — reads `ITEM_NUMBER`, `ITEM_LABELS`, `ROUTING_PAT`, `RALPH_ROUTING_CONFIG` env vars set by this workflow
- #173 (audit + error handling) — extends the script invoked by this workflow

## Risks

1. **`GITHUB_TOKEN` scope confusion**: The most common setup mistake. The workflow comments and README section mitigate this with explicit documentation. Recommend a workflow-level check:
   ```yaml
   - name: Verify ROUTING_PAT is set
     run: |
       if [ -z "$ROUTING_PAT" ]; then
         echo "::error::ROUTING_PAT secret is not set. GITHUB_TOKEN cannot write to Projects V2."
         exit 1
       fi
     env:
       ROUTING_PAT: ${{ secrets.ROUTING_PAT }}
   ```

2. **`labeled` event triggers on every label add**: If an issue gets 3 labels simultaneously, 3 routing runs fire. The concurrency group prevents parallel runs but doesn't deduplicate results. Idempotency is handled by #173 (audit trail + duplicate detection).

3. **`pull_request` trigger PAT access**: For forks, `pull_request` events from fork PRs cannot access repository secrets. Use `pull_request_target` if routing fork PRs is needed — but this has security implications. For v1, only route PRs from the same repo (not forks).

4. **Config file missing**: If `.ralph-routing.yml` doesn't exist at workflow run time, the routing script should gracefully skip (return 0). This is handled in #168 (config loader) and #171.

## Recommended Approach

1. Create `.github/workflows/route-issues.yml` with the 4 triggers, concurrency config, and routing step
2. Include `ROUTING_PAT` verification step
3. Add README section documenting required secrets
4. Merge as standalone PR — workflow errors gracefully until #171 routing script exists
5. Pass env vars matching what #171 expects: `ITEM_NUMBER`, `ITEM_LABELS`, `EVENT_NAME`, `GH_OWNER`, `GH_REPO`, `ROUTING_PAT`, `RALPH_ROUTING_CONFIG`
