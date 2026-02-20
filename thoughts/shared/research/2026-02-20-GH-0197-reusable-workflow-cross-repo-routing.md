---
date: 2026-02-20
github_issue: 197
github_url: https://github.com/cdubiel08/ralph-hero/issues/197
status: complete
type: research
---

# GH-197: Add Reusable Workflow Support for Cross-Repo Issue Routing

## Problem Statement

Convert `route-issues.yml` into a reusable workflow (`workflow_call`) so other repositories can invoke it via `uses: cdubiel08/ralph-hero/.github/workflows/route-issues.yml@main` without copying the routing script. Ensure `scripts/routing/route.js` works when called from an external repo context.

## Current State Analysis

### Existing Workflow: `.github/workflows/route-issues.yml`

The current workflow (from GH-169) triggers on `issues: [opened, labeled]` and `pull_request: [opened, ready_for_review]`. It:
1. Checks out the repository (`actions/checkout@v4`)
2. Sets up Node.js 20
3. Runs `npm ci` in `scripts/routing/`
4. Verifies `ROUTING_PAT` secret is set
5. Runs `node scripts/routing/route.js` with env vars: `ROUTING_PAT`, `GH_OWNER`, `GH_REPO`, `ITEM_NUMBER`, `ITEM_LABELS`, `EVENT_NAME`, `RALPH_ROUTING_CONFIG`

### Existing Script: `scripts/routing/route.js`

The routing script (from GH-171) is a standalone Node.js script that:
- Reads env vars set by the workflow
- Loads `.ralph-routing.yml` from the filesystem via `fs.readFileSync(configPath)`
- Evaluates routing rules (stub, to be replaced by GH-167 engine)
- Uses `@octokit/graphql` to add issues to GitHub Projects V2 and set field values

**Dependencies**: `@octokit/graphql` and `yaml` (defined in `scripts/routing/package.json`).

### Critical Cross-Repo Constraint

**`actions/checkout@v4` checks out the CALLER's repository by default in reusable workflows.** When a consuming repo calls `uses: cdubiel08/ralph-hero/.github/workflows/route-issues.yml@main`, the checkout step checks out the consuming repo, not `ralph-hero`. This means:

- The consuming repo has `.ralph-routing.yml` (config) -- this is correct
- The consuming repo does NOT have `scripts/routing/route.js` (the routing script)
- The consuming repo does NOT have `scripts/routing/package.json` (dependencies)

This is the central design challenge for GH-197.

## GitHub Reusable Workflow Mechanics

### `workflow_call` Trigger Syntax

```yaml
on:
  workflow_call:
    inputs:
      config-path:
        required: false
        type: string
        default: '.ralph-routing.yml'
    secrets:
      routing-pat:
        required: true
```

### Combining Triggers

A workflow file can have BOTH `workflow_call` and other triggers (e.g., `issues`, `pull_request`). Each matching trigger fires a separate workflow run. This means `route-issues.yml` can serve dual purposes:
- Direct trigger: fires on issue/PR events in `ralph-hero` itself
- Reusable: called by other repos via `uses:`

### Caller Invocation

```yaml
# In consuming repo: .github/workflows/route-issues.yml
name: Route Issues
on:
  issues:
    types: [opened, labeled]
  pull_request:
    types: [opened, ready_for_review]

jobs:
  route:
    uses: cdubiel08/ralph-hero/.github/workflows/route-issues.yml@main
    with:
      config-path: .ralph-routing.yml
      project-number: '3'
      project-owner: cdubiel08
    secrets:
      routing-pat: ${{ secrets.ROUTING_PAT }}
```

### Context Behavior

- `github.event` in the reusable workflow reflects the CALLER's event
- `actions/checkout` without parameters checks out the CALLER's repo
- Secrets must be explicitly passed (or use `secrets: inherit` for same-org)
- Inputs are accessed via `${{ inputs.config-path }}`, NOT `github.event.inputs`

## Solution Options

### Option A: Dual Checkout (Recommended)

Add a second checkout step that fetches `ralph-hero` for the routing script:

```yaml
steps:
  - name: Checkout caller repository (for config)
    uses: actions/checkout@v4

  - name: Checkout routing script
    uses: actions/checkout@v4
    with:
      repository: cdubiel08/ralph-hero
      path: .ralph-hero
      sparse-checkout: scripts/routing
```

**Pros**: Simple, no new npm package, script stays in-repo, no duplication.
**Cons**: Requires the `ralph-hero` repo to be public (or the PAT to have cross-repo access). Adds ~2s to workflow run for the extra checkout.

The `sparse-checkout` option only fetches `scripts/routing/`, keeping the checkout lightweight.

### Option B: Publish Routing Script as npm Package

Publish `scripts/routing/` as an npm package (e.g., `ralph-hero-router`). The workflow installs it via `npx`.

**Pros**: Clean separation, versioned, works regardless of repo visibility.
**Cons**: Another npm package to maintain, version coordination with workflow, publishing overhead (already have `ralph-hero-mcp-server`).

### Option C: Inline the Script

Move the routing logic into the workflow YAML itself (as a multi-line `run:` step).

**Pros**: Self-contained, no checkout needed.
**Cons**: YAML-embedded JS is unmaintainable, no tests, no linting, hard to read.

### Recommendation: Option A (Dual Checkout)

Option A is the simplest and most maintainable. The `ralph-hero` repo is public, so no extra auth is needed for the checkout. The sparse-checkout keeps it fast. The routing script remains testable in its current location.

## Implementation Plan

### Changes to `.github/workflows/route-issues.yml`

**1. Add `workflow_call` trigger with inputs and secrets:**

```yaml
on:
  issues:
    types: [opened, labeled]
  pull_request:
    types: [opened, ready_for_review]
  workflow_call:
    inputs:
      config-path:
        description: 'Path to .ralph-routing.yml in the caller repo'
        required: false
        type: string
        default: '.ralph-routing.yml'
      project-number:
        description: 'GitHub Projects V2 number (overrides config default)'
        required: false
        type: string
        default: ''
      project-owner:
        description: 'GitHub owner of the project (defaults to repo owner)'
        required: false
        type: string
        default: ''
    secrets:
      routing-pat:
        description: 'GitHub PAT with repo + project scopes'
        required: true
```

**2. Add second checkout step for the routing script (conditional):**

```yaml
- name: Checkout routing script (cross-repo calls)
  if: github.repository != 'cdubiel08/ralph-hero'
  uses: actions/checkout@v4
  with:
    repository: cdubiel08/ralph-hero
    path: .ralph-hero
    sparse-checkout: scripts/routing
```

When called from `ralph-hero` itself, the first checkout already has the script. The `if` condition avoids a redundant checkout.

**3. Update env vars to support both direct and reusable modes:**

```yaml
env:
  ROUTING_PAT: ${{ secrets.routing-pat || secrets.ROUTING_PAT }}
  GH_OWNER: ${{ github.repository_owner }}
  GH_REPO: ${{ github.event.repository.name }}
  ITEM_NUMBER: ${{ github.event.issue.number || github.event.pull_request.number }}
  ITEM_LABELS: ${{ toJSON(github.event.issue.labels || github.event.pull_request.labels) }}
  EVENT_NAME: ${{ github.event_name }}
  RALPH_ROUTING_CONFIG: ${{ inputs.config-path || '.ralph-routing.yml' }}
  RALPH_PROJECT_NUMBER: ${{ inputs.project-number || '' }}
  RALPH_PROJECT_OWNER: ${{ inputs.project-owner || '' }}
```

The `secrets.routing-pat || secrets.ROUTING_PAT` pattern allows the secret to be passed either via `workflow_call` (lowercase kebab-case) or directly (uppercase).

**4. Update run command to handle script path:**

```yaml
run: |
  if [ -d ".ralph-hero/scripts/routing" ]; then
    SCRIPT_DIR=".ralph-hero/scripts/routing"
  else
    SCRIPT_DIR="scripts/routing"
  fi
  cd "$SCRIPT_DIR" && npm ci && node route.js
```

**5. Update concurrency group to include repo:**

```yaml
concurrency:
  group: route-${{ github.repository }}-${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: false
```

Adding `github.repository` prevents cross-repo concurrency collisions.

### Changes to `scripts/routing/route.js`

Minimal changes:
- Read `RALPH_PROJECT_NUMBER` and `RALPH_PROJECT_OWNER` env vars as overrides for rule-level project settings
- Use these overrides when no `projectNumber`/`projectOwner` is specified in the matched rule

### Documentation

Add a section to the repo README (or create `docs/cross-repo-routing.md`) explaining:
1. Create `.ralph-routing.yml` in the consuming repo
2. Create `ROUTING_PAT` secret with `repo` + `project` scopes
3. Create a caller workflow file with the `uses:` invocation
4. Example config format

### File Changes

| File | Change | Effort |
|------|--------|--------|
| `.github/workflows/route-issues.yml` | Add `workflow_call` trigger, dual checkout, env var updates | Primary |
| `scripts/routing/route.js` | Read `RALPH_PROJECT_NUMBER`/`RALPH_PROJECT_OWNER` overrides | Minor (~5 lines) |
| `README.md` or `docs/cross-repo-routing.md` | Cross-repo setup documentation | Minor |

## Dependency Analysis

### Depends On (should be merged first)

- **GH-173** (audit trail + error handling): The issue body says this should be in place first. However, #197 is purely additive (adds a trigger, doesn't change script logic), so it can be implemented independently and merged after #173.

### Downstream

No issues depend on #197. It's the last issue in the GH-126 routing group.

## Risks

1. **Public repo assumption**: The dual-checkout approach requires `ralph-hero` to be public. If the repo goes private, consuming repos would need a PAT with cross-repo access in the checkout step. Mitigation: document this requirement.

2. **`workflow_call` event context**: When called via `workflow_call`, `github.event_name` is `workflow_call`, not `issues` or `pull_request`. The original event data is still in `github.event`, but `EVENT_NAME` would be wrong. Mitigation: the caller workflow's trigger determines the event, and `github.event.issue` / `github.event.pull_request` are still populated correctly. The script should check for the presence of `github.event.issue` rather than relying on `EVENT_NAME`.

3. **Secret naming mismatch**: `workflow_call` secrets use kebab-case (`routing-pat`) while the direct trigger uses `ROUTING_PAT`. The `${{ secrets.routing-pat || secrets.ROUTING_PAT }}` pattern handles this, but it requires the consuming repo to use the exact secret name `routing-pat` when passing secrets.

4. **Sparse checkout with ref pinning**: Consuming repos should pin to a tag or SHA (`@v1.0.0` or `@abc123`) rather than `@main` to avoid breaking changes. Document this best practice.

## Recommended Approach

1. Add `workflow_call` trigger with 3 optional inputs (`config-path`, `project-number`, `project-owner`) and 1 required secret (`routing-pat`)
2. Add conditional second checkout for cross-repo script access (sparse-checkout `scripts/routing`)
3. Update env vars to support both direct and reusable invocation patterns
4. Add cross-repo setup documentation
5. Minimal script changes (env var overrides only)

## Estimate Validation

**XS estimate is appropriate.** The changes are:
- ~20 lines of YAML additions to the workflow file
- ~5 lines of JS for env var overrides in route.js
- Documentation section

No new files, no new dependencies, no architectural changes.
