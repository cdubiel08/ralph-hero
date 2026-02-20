---
date: 2026-02-20
status: draft
github_issues: [197]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/197
primary_issue: 197
---

# Add Reusable Workflow Support for Cross-Repo Issue Routing - Implementation Plan

## Overview

1 issue (XS) to convert `route-issues.yml` into a reusable workflow via `workflow_call` trigger, enabling cross-repo invocation without copying the routing script.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-197 | Add reusable workflow support for cross-repo issue routing | XS |

## Current State Analysis

The routing workflow ([`.github/workflows/route-issues.yml`](https://github.com/cdubiel08/ralph-hero/blob/main/.github/workflows/route-issues.yml)) triggers on `issues` and `pull_request` events, runs `scripts/routing/route.js` with env vars, and routes items to GitHub Projects V2.

**Key constraint**: When called cross-repo via `workflow_call`, `actions/checkout@v4` checks out the **caller's** repository by default. The caller has the config file (`.ralph-routing.yml`) but NOT the routing script (`scripts/routing/route.js`). Solution: dual checkout with conditional second checkout of `ralph-hero` via sparse-checkout.

**`EVENT_NAME` issue**: When called via `workflow_call`, `github.event_name` is `"workflow_call"`, not `"issues"` or `"pull_request"`. The script's `fetchContentNodeId()` uses `EVENT_NAME` to choose between `issue` and `pullRequest` GraphQL fields. The fix is to derive the event type from the presence of `github.event.issue` vs `github.event.pull_request` in the workflow env vars rather than relying on `github.event_name`.

## Desired End State

### Verification
- [ ] `route-issues.yml` has `workflow_call` trigger alongside existing `issues`/`pull_request` triggers
- [ ] Consuming repos can invoke via `uses: cdubiel08/ralph-hero/.github/workflows/route-issues.yml@main`
- [ ] Cross-repo calls get the routing script via conditional sparse-checkout of `ralph-hero`
- [ ] Same-repo calls (from `ralph-hero` itself) continue to work unchanged
- [ ] `scripts/routing/route.js` reads `RALPH_PROJECT_NUMBER` and `RALPH_PROJECT_OWNER` env var overrides
- [ ] `EVENT_NAME` correctly resolves for `workflow_call` triggers
- [ ] Cross-repo setup documented in `docs/cross-repo-routing.md`

## What We're NOT Doing

- Core routing logic changes (handled by GH-169, GH-171)
- Audit trail or error handling (handled by GH-173)
- Routing config schema or matching engine (handled by GH-166, GH-167, GH-168)
- Publishing routing script as a separate npm package

## Implementation Approach

All changes are additive. The workflow gains a new trigger and conditional checkout step. The script gains 2 env var overrides and an event-type derivation fix. A new documentation file explains cross-repo setup.

---

## Phase 1: GH-197 - Add Reusable Workflow Support

> **Issue**: [GH-197](https://github.com/cdubiel08/ralph-hero/issues/197) | **Research**: [Research Doc](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0197-reusable-workflow-cross-repo-routing.md)

### Changes Required

#### 1. Add `workflow_call` trigger to workflow
**File**: [`.github/workflows/route-issues.yml`](https://github.com/cdubiel08/ralph-hero/blob/main/.github/workflows/route-issues.yml)
**Changes**:
- Add `workflow_call:` trigger block with 3 inputs and 1 secret to the `on:` section
- Inputs: `config-path` (string, default `.ralph-routing.yml`), `project-number` (string, default `''`), `project-owner` (string, default `''`)
- Secret: `routing-pat` (required)

```yaml
on:
  issues:
    types: [opened, labeled]
  pull_request:
    types: [opened, ready_for_review]
  workflow_call:
    inputs:
      config-path:
        description: 'Path to routing config in the caller repo'
        required: false
        type: string
        default: '.ralph-routing.yml'
      project-number:
        description: 'Default GitHub Projects V2 number (overrides rule-level defaults)'
        required: false
        type: string
        default: ''
      project-owner:
        description: 'GitHub owner of the target project (defaults to repo owner)'
        required: false
        type: string
        default: ''
    secrets:
      routing-pat:
        description: 'GitHub PAT with repo + project scopes'
        required: true
```

#### 2. Update concurrency group to include repository
**File**: `.github/workflows/route-issues.yml`
**Changes**: Add `github.repository` to prevent cross-repo concurrency collisions.

```yaml
concurrency:
  group: route-${{ github.repository }}-${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: false
```

#### 3. Add conditional checkout of ralph-hero for cross-repo calls
**File**: `.github/workflows/route-issues.yml`
**Changes**: Add a second checkout step after the existing one, guarded by `if: github.repository != 'cdubiel08/ralph-hero'`. Uses sparse-checkout to only fetch `scripts/routing/`.

```yaml
      - name: Checkout routing script (cross-repo calls)
        if: github.repository != 'cdubiel08/ralph-hero'
        uses: actions/checkout@v4
        with:
          repository: cdubiel08/ralph-hero
          path: .ralph-hero
          sparse-checkout: scripts/routing
```

#### 4. Update env vars and run command for dual-mode support
**File**: `.github/workflows/route-issues.yml`
**Changes**:
- Update `ROUTING_PAT` to fall back: `${{ secrets.routing-pat || secrets.ROUTING_PAT }}`
- Add `RALPH_ROUTING_CONFIG` from inputs: `${{ inputs.config-path || '.ralph-routing.yml' }}`
- Add `RALPH_PROJECT_NUMBER`: `${{ inputs.project-number || '' }}`
- Add `RALPH_PROJECT_OWNER`: `${{ inputs.project-owner || '' }}`
- Derive `EVENT_NAME` from event payload presence instead of `github.event_name`:
  ```yaml
  EVENT_NAME: ${{ github.event.issue && 'issues' || 'pull_request' }}
  ```
- Update `run:` to detect script location:
  ```yaml
  run: |
    if [ -d ".ralph-hero/scripts/routing" ]; then
      SCRIPT_DIR=".ralph-hero/scripts/routing"
    else
      SCRIPT_DIR="scripts/routing"
    fi
    cd "$SCRIPT_DIR" && npm ci && node route.js
  ```
- Remove the separate "Install routing dependencies" step (now integrated into the run command)
- Update "Verify ROUTING_PAT" step to use the same fallback pattern for the secret

#### 5. Add project override support to route.js
**File**: [`scripts/routing/route.js`](https://github.com/cdubiel08/ralph-hero/blob/main/scripts/routing/route.js)
**Changes**: Read `RALPH_PROJECT_NUMBER` and `RALPH_PROJECT_OWNER` from env vars. Use as defaults when a matched rule's action doesn't specify `projectNumber` or `projectOwner`.

In the env var destructuring (line 12-20), add:
```javascript
const {
  // ... existing vars ...
  RALPH_PROJECT_NUMBER,
  RALPH_PROJECT_OWNER,
} = process.env;
```

In the matched rule loop (line 183-185), apply overrides:
```javascript
const projectNumber = rule.action.projectNumber
  || (RALPH_PROJECT_NUMBER ? parseInt(RALPH_PROJECT_NUMBER, 10) : null);
if (!projectNumber) {
  console.warn(`Rule matched but no projectNumber specified and no RALPH_PROJECT_NUMBER default — skipping`);
  continue;
}
const projectOwner = rule.action.projectOwner || RALPH_PROJECT_OWNER || GH_OWNER;
```

#### 6. Create cross-repo setup documentation
**File**: `docs/cross-repo-routing.md` (NEW)
**Changes**: Create documentation file covering:
- Prerequisites (repo must be able to access `ralph-hero` repo, ROUTING_PAT secret)
- Caller workflow template (complete YAML example)
- Config file format reference (`.ralph-routing.yml`)
- Input parameters reference table
- Secrets reference
- Ref pinning best practice (`@v1.0.0` or `@sha` instead of `@main`)
- Troubleshooting (common issues: missing secret, private repo access, event context)

### Success Criteria

- [x] Automated: `yamllint .github/workflows/route-issues.yml` passes (valid YAML syntax)
- [x] Automated: `node -c scripts/routing/route.js` passes (valid JS syntax)
- [x] Manual: Verify workflow YAML has all 3 triggers (`issues`, `pull_request`, `workflow_call`)
- [x] Manual: Verify conditional checkout step has correct `if` guard
- [x] Manual: Verify `EVENT_NAME` derivation handles `workflow_call` trigger
- [x] Manual: Verify `docs/cross-repo-routing.md` has complete caller workflow example
- [x] Manual: Verify route.js `RALPH_PROJECT_NUMBER`/`RALPH_PROJECT_OWNER` overrides work in the matched rule loop

---

## Integration Testing

- [ ] Verify existing direct-trigger behavior is unchanged (same env var names, same script path for same-repo calls)
- [ ] Verify the `if` condition correctly evaluates: `github.repository != 'cdubiel08/ralph-hero'` is `false` for same-repo, `true` for cross-repo
- [ ] Verify `secrets.routing-pat || secrets.ROUTING_PAT` resolves correctly in both modes
- [ ] Verify `inputs.config-path || '.ralph-routing.yml'` defaults correctly when called directly (inputs is empty)

## References

- Research: [GH-197 Research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0197-reusable-workflow-cross-repo-routing.md)
- Current workflow: [route-issues.yml](https://github.com/cdubiel08/ralph-hero/blob/main/.github/workflows/route-issues.yml)
- Current script: [route.js](https://github.com/cdubiel08/ralph-hero/blob/main/scripts/routing/route.js)
- GitHub docs: [Reuse workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- Related issues: [GH-169](https://github.com/cdubiel08/ralph-hero/issues/169) (scaffold), [GH-171](https://github.com/cdubiel08/ralph-hero/issues/171) (evaluation script), [GH-173](https://github.com/cdubiel08/ralph-hero/issues/173) (audit/error handling)
