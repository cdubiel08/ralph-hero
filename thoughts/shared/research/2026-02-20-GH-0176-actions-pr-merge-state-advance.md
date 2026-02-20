---
date: 2026-02-20
github_issue: 176
github_url: https://github.com/cdubiel08/ralph-hero/issues/176
status: complete
type: research
---

# GH-176: Actions — PR Merge Advances Linked Issue Workflow State

## Problem Statement

When a PR is merged, linked issues (referenced via `Closes #N`, `Fixes #N`, etc.) should have their Workflow State advanced. GitHub auto-closes linked issues on merge, but this only affects the GitHub issue `state` and the default Status field — the custom Workflow State field is not updated. A GitHub Actions workflow is needed to advance linked issues from In Progress → In Review or In Review → Done based on the merge event.

## Current State Analysis

### GitHub's Built-in Merge Behavior

When a PR with closing keywords is merged into the default branch:
1. GitHub auto-closes all linked issues (platform-level, not Actions)
2. Built-in project automations set Status = Done
3. Custom fields (Workflow State, Priority, Estimate) are **not** touched

This means after a PR merge, an issue's GitHub `state` is "closed" and Status is "Done", but its Workflow State could still be "In Progress" — a desynchronized state.

### Closing Keywords

Nine case-insensitive keywords in three families:

| Family | Keywords |
|--------|----------|
| close | `close`, `closes`, `closed` |
| fix | `fix`, `fixes`, `fixed` |
| resolve | `resolve`, `resolves`, `resolved` |

**Syntax**: `Keyword #N`, `Keyword: #N`, `Keyword org/repo#N`. Case-insensitive. Optional colon. Only parsed from PR **body** and commit messages — not from PR title.

**Critical constraint**: Keywords only trigger auto-close when the PR targets the **default branch**. PRs to other branches silently ignore keywords.

### `pull_request.closed` Event Payload

```
github.event.action              → "closed" (both merged and not-merged)
github.event.pull_request.merged → true | false  ← discriminator
github.event.pull_request.body   → PR description (where closing keywords live)
github.event.pull_request.number → PR number
github.event.pull_request.head.ref → source branch
github.event.pull_request.base.ref → target branch
```

No `merged` action type exists — only `closed`. Must use `if: github.event.pull_request.merged == true`.

### `closingIssuesReferences` GraphQL Field

```graphql
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      closingIssuesReferences(first: 25) {
        nodes { number title state url }
      }
    }
  }
}
```

Returns issues that will be closed when the PR is merged. **Timing caveat**: may return empty after merge completes. Query immediately in the `pull_request: closed` handler.

### State Ordering in MCP Server

[`workflow-states.ts:12-22`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts#L12): `STATE_ORDER` defines the pipeline:

```
0:Backlog → 1:Research Needed → 2:Research in Progress → 3:Ready for Plan →
4:Plan in Progress → 5:Plan in Review → 6:In Progress → 7:In Review → 8:Done
```

`isEarlierState(a, b)` returns `true` if `stateIndex(a) < stateIndex(b)`. Used by `advance_children` ([`relationship-tools.ts:654`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L654)) to skip issues already at or past target.

### `advance_children` Pattern

[`relationship-tools.ts:519-710`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L519) — the closest existing pattern. For each child:
1. Read current Workflow State via `getCurrentFieldValue`
2. Check `isEarlierState(current, target)` — skip if already at/past target
3. Update via `updateProjectItemField`
4. Sync Status via `syncStatusField`

The Actions workflow uses the same logic but in shell/GraphQL rather than TypeScript.

### Sibling GH-175 Patterns

[GH-175 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0175-actions-close-reopen-state-sync.md) establishes:
- Auth: `secrets.ROUTING_PAT` (classic PAT with `repo` + `project`)
- Project item resolution: `node(id: $issueId) ... projectItems(first: 20)`
- Idempotency: Query current field value before mutation
- Concurrency: Per-item group with `cancel-in-progress: false`

## Key Discoveries

### 1. Two Approaches to Find Linked Issues

**Option A: `closingIssuesReferences` GraphQL query**

```bash
LINKED=$(gh api graphql -f query='
  query($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        closingIssuesReferences(first: 25) {
          nodes { number title }
        }
      }
    }
  }' -f owner="$OWNER" -f repo="$REPO" -F pr=$PR_NUMBER \
  --jq '.data.repository.pullRequest.closingIssuesReferences.nodes')
```

**Pros:** Authoritative, handles all keyword variants, cross-repo references.
**Cons:** May return empty after merge; only populated for default-branch PRs; manually-linked issues (UI sidebar) not included.

**Option B: Regex parsing of PR body**

```bash
ISSUES=$(echo "$PR_BODY" | grep -oiP '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[\s:]+#(\d+)' | grep -oP '\d+')
```

**Pros:** Always works regardless of timing, no extra API call, handles all nine keywords.
**Cons:** Doesn't handle cross-repo references, may false-positive on commented-out keywords.

**Recommendation**: Use Option A as primary (GraphQL query), with Option B as fallback if GraphQL returns empty. This covers the timing edge case.

### 2. State Transition Logic

The issue specifies:
- If currently In Progress (index 6) → advance to In Review (index 7)
- If already In Review (index 7) → advance to Done (index 8)

This is a **conditional advance based on current state**, not a fixed target. The workflow must:
1. Read current Workflow State for each linked issue
2. Determine the next state based on current position
3. Only advance forward, never backward

```
Current State      → Target State
In Progress (6)    → In Review (7)
In Review (7)      → Done (8)
Done (8)           → skip (already terminal)
Plan in Review (5) → skip (too early in pipeline)
Any earlier state  → skip (PR merge doesn't affect pre-implementation states)
```

### 3. GitHub Auto-Close Interaction

GitHub's auto-close fires in parallel with (or slightly before) the `pull_request: closed` event. By the time the workflow runs:
- The issue's GitHub `state` may already be `closed`
- The built-in automation may have set Status = Done

This is **harmless** — the workflow only writes to the custom Workflow State field, which neither GitHub auto-close nor built-in automations touch. No race condition.

### 4. Multiple Linked Issues Per PR

A PR can reference multiple issues: `Closes #1, fixes #2, resolves #3`. The workflow must loop over all linked issues and process each independently. Failures on one issue should not block processing of others.

### 5. Concurrency Scope

GH-175 uses per-issue concurrency. For PR merge events, the scope should be per-PR:

```yaml
concurrency:
  group: pr-merge-${{ github.event.pull_request.number }}
  cancel-in-progress: false
```

### 6. Non-Default Branch PRs

Closing keywords only work for PRs targeting the default branch. For PRs targeting other branches (e.g., `develop`):
- `closingIssuesReferences` returns empty
- No auto-close happens
- The workflow should detect this and skip gracefully

Check `github.event.pull_request.base.ref` against the repo's default branch.

### 7. Workflow Can Share File with GH-175

The issue mentions "add to existing sync workflow" as an option. Since both #175 and #176 are Actions workflows in the same `.github/workflows/` directory:

**Option A: Separate files** — `sync-issue-state.yml` (close/reopen) + `sync-pr-merge.yml` (PR merge)
**Option B: Single file** — one workflow with multiple triggers

**Recommendation**: Separate files. The triggers are different (`issues: [closed, reopened]` vs `pull_request: [closed]`), the logic is different (state reason mapping vs linked issue parsing), and combining them adds complexity with no benefit.

## Implementation Sketch

```yaml
name: Advance Linked Issues on PR Merge

on:
  pull_request:
    types: [closed]
  workflow_dispatch:
    inputs:
      pr_number:
        description: 'PR number to process'
        required: true

jobs:
  advance-linked-issues:
    if: github.event.pull_request.merged == true || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    env:
      GH_TOKEN: ${{ secrets.ROUTING_PAT }}
      PROJECT_OWNER: cdubiel08
      PROJECT_NUMBER: 3
    steps:
      - name: Find linked issues
        id: linked
        run: |
          PR_NUMBER="${{ github.event.pull_request.number || inputs.pr_number }}"
          # Query closingIssuesReferences via GraphQL
          # Fallback: parse PR body for closing keywords
          # Output: ISSUE_NUMBERS as space-separated list

      - name: Advance each linked issue
        run: |
          for ISSUE_NUM in $ISSUE_NUMBERS; do
            # 1. Resolve project item via issue node_id
            # 2. Read current Workflow State
            # 3. Determine target:
            #    "In Progress" → "In Review"
            #    "In Review" → "Done"
            #    Other → skip
            # 4. Update Workflow State field
          done
```

## Group Context

Parent #127 has 3 children:
1. **#175** — Close/reopen → Workflow State (Ready for Plan, research complete)
2. **#176** — PR merge → advance linked issues (this issue)
3. **#177** — Parent auto-advance when all children Done

**Shared patterns** established by #175: `ROUTING_PAT` auth, project item resolution via `node_id`, idempotency check, field/option ID resolution.

## Risks

1. **`closingIssuesReferences` empty after merge**: The GraphQL field may clear after merge completes. Mitigate with body-parsing fallback.
2. **Non-default branch PRs**: Keywords are ignored for non-default branch targets. The workflow should check `base.ref` and skip gracefully.
3. **Cross-repo references**: `Fixes owner/other-repo#N` — the linked issue is in a different repo. The workflow can only update issues in repos where the PAT has access and that belong to the configured project.
4. **Multiple PRs for same issue**: If two PRs reference the same issue, both merge events fire. With idempotency (check current state before advancing), the second event is a no-op.
5. **PR body parsing false positives**: `> Closes #10` in a quoted block or code fence is not a real keyword reference. The regex approach doesn't distinguish context. `closingIssuesReferences` handles this correctly.

## Recommended Next Steps

1. Create `.github/workflows/sync-pr-merge.yml` with `pull_request: [closed]` trigger
2. Add `if: github.event.pull_request.merged == true` guard
3. Use `closingIssuesReferences` GraphQL query with body-parsing fallback
4. For each linked issue: read current Workflow State, advance if In Progress → In Review or In Review → Done
5. Log decisions per issue (advanced, skipped, error)
6. Use `ROUTING_PAT` secret (same as #175)
7. Add `workflow_dispatch` for manual testing
8. Handle non-default branch PRs gracefully (skip with log)
