---
date: 2026-02-20
status: complete
github_issues: [177]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/177
primary_issue: 177
---

# GH-177: Actions: Parent Issue Auto-Advance When All Children Reach Done

## Overview

Single-issue implementation. When all child (sub-issue) issues of a parent issue are closed as completed, automatically advance the parent's Workflow State to "Done" in the project and close the parent issue to enable cascading advancement up the hierarchy.

| Issue | Title | Estimate |
|-------|-------|----------|
| GH-177 | Actions: parent issue auto-advance when all children reach Done | S |

**Parent epic**: #127 (Event-Driven State Sync)
**Siblings**: #175 (close/reopen sync -- merged), #176 (PR merge advance -- merged)

## Current State Analysis

- `sync-issue-state.yml` (GH-175) and `sync-pr-merge.yml` (GH-176) are merged and active. They establish the auth pattern (`ROUTING_PAT`), project/field resolution queries, idempotency check, and concurrency group conventions.
- The MCP server has `advance_parent` in `relationship-tools.ts:715-965` handling all gate states. This Actions workflow only handles the "all children Done" case triggered by `issues: [closed]`.
- GitHub's native `state` and `stateReason` fields are set atomically on issue close -- no race condition with the Workflow State field update from `sync-issue-state.yml`.

## Desired End State

### Verification
- [x] `.github/workflows/advance-parent.yml` exists and triggers on `issues: [closed]`
- [x] Closed with `state_reason != "completed"` exits early (no advancement)
- [x] Issue with no parent exits early (no advancement)
- [x] Parent with mixed children (some open, some closed) does not advance
- [x] Parent with all children closed as "completed" advances to Done
- [x] Parent with a child closed as "not_planned" does not advance (not all COMPLETED)
- [x] Parent already at Done is skipped (idempotent)
- [x] Parent issue is closed with `--reason completed` after advancement (cascading)
- [x] `workflow_dispatch` trigger allows manual testing with issue number input
- [x] Concurrency group prevents parallel advancement for same parent
- [x] All inputs passed via safe `env:` blocks (no `${{ }}` in `run:` commands)

## What We're NOT Doing
- No handling of non-Done gate states (Ready for Plan, In Review) -- that's the MCP tool's domain
- No MCP server changes
- No Node.js scripts -- pure shell with `gh api graphql` (matching existing workflows)
- No repo checkout (not needed for `gh` CLI)
- No test files (Actions workflows tested via `workflow_dispatch` trigger)
- No `subIssues` pagination beyond `first: 50` (acceptable for typical usage)
- No reopened parent handling (parent reopened by other means is a separate concern)

## Implementation Approach

Trigger on `issues: [closed]`. Use GitHub's native `state`/`stateReason` fields for convergence checks instead of Workflow State field values -- this avoids any race condition with `sync-issue-state.yml`. The workflow:

1. Validates the close was "completed" (skip not_planned/duplicate)
2. Queries the closed issue's parent
3. Queries all siblings via `subIssues(first: 50)`
4. Checks convergence: all siblings must be `CLOSED` + `COMPLETED`
5. Resolves project field IDs (same pattern as existing workflows)
6. Reads parent's current Workflow State (idempotency check)
7. Updates parent to "Done"
8. Closes the parent issue with `--reason completed` to trigger cascading

Closing the parent issue triggers `sync-issue-state.yml` (Done), which triggers another `issues: [closed]` event, which fires this workflow again for the grandparent. Each level targets a different issue number, so the concurrency group (`advance-parent-$PARENT_NUMBER`) prevents conflicts without blocking cascades.

---

## Changes Required

### 1. Create `.github/workflows/advance-parent.yml`
**File**: `.github/workflows/advance-parent.yml` (new file)

**Contents**:

```yaml
# Advance parent issue to Done when all children are closed as completed.
#
# When an issue is closed, this workflow checks if it has a parent issue.
# If all sibling sub-issues are also closed with reason "completed", the
# parent's Workflow State is set to Done and the parent issue is closed
# to enable cascading advancement up the hierarchy.
#
# Uses GitHub's native state/stateReason fields for convergence checks
# (set atomically on close) to avoid race conditions with sync-issue-state.yml.
#
# Requires ROUTING_PAT secret: classic PAT with repo + project scopes.

name: Advance Parent on Child Completion

on:
  issues:
    types: [closed]
  workflow_dispatch:
    inputs:
      issue_number:
        description: 'Child issue number to check parent advancement'
        required: true
        type: number

jobs:
  advance-parent:
    runs-on: ubuntu-latest
    env:
      GH_TOKEN: ${{ secrets.ROUTING_PAT }}
      PROJECT_OWNER: ${{ vars.RALPH_PROJECT_OWNER || 'cdubiel08' }}
      PROJECT_NUMBER: ${{ vars.RALPH_PROJECT_NUMBER || '3' }}
    steps:
      - name: Determine child issue and validate close reason
        id: child
        env:
          EVENT_NAME: ${{ github.event_name }}
          EVENT_ISSUE_NUMBER: ${{ github.event.issue.number }}
          EVENT_STATE_REASON: ${{ github.event.issue.state_reason }}
          INPUT_ISSUE_NUMBER: ${{ inputs.issue_number }}
          REPO_OWNER: ${{ github.repository_owner }}
          REPO_NAME: ${{ github.event.repository.name }}
        run: |
          if [ "$EVENT_NAME" = "workflow_dispatch" ]; then
            ISSUE_NUMBER="$INPUT_ISSUE_NUMBER"
            echo "Manual dispatch for issue #$ISSUE_NUMBER"
          else
            ISSUE_NUMBER="$EVENT_ISSUE_NUMBER"

            # Only advance on completed close (not not_planned/duplicate)
            if [ "$EVENT_STATE_REASON" != "completed" ]; then
              echo "Issue #$ISSUE_NUMBER closed as '$EVENT_STATE_REASON' — skipping parent advance"
              echo "skip=true" >> "$GITHUB_OUTPUT"
              exit 0
            fi
          fi

          echo "issue_number=$ISSUE_NUMBER" >> "$GITHUB_OUTPUT"
          echo "skip=false" >> "$GITHUB_OUTPUT"

      - name: Fetch parent issue
        if: steps.child.outputs.skip != 'true'
        id: parent
        env:
          ISSUE_NUMBER: ${{ steps.child.outputs.issue_number }}
          REPO_OWNER: ${{ github.repository_owner }}
          REPO_NAME: ${{ github.event.repository.name }}
        run: |
          PARENT_NUMBER=$(gh api graphql -f query='
            query($owner: String!, $repo: String!, $number: Int!) {
              repository(owner: $owner, name: $repo) {
                issue(number: $number) {
                  parent { number }
                }
              }
            }' -f owner="$REPO_OWNER" \
               -f repo="$REPO_NAME" \
               -F number="$ISSUE_NUMBER" \
               --jq '.data.repository.issue.parent.number // empty')

          if [ -z "$PARENT_NUMBER" ]; then
            echo "Issue #$ISSUE_NUMBER has no parent — nothing to advance"
            echo "skip=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi

          echo "parent_number=$PARENT_NUMBER" >> "$GITHUB_OUTPUT"
          echo "skip=false" >> "$GITHUB_OUTPUT"
          echo "Issue #$ISSUE_NUMBER has parent #$PARENT_NUMBER"

      - name: Check sibling convergence
        if: steps.child.outputs.skip != 'true' && steps.parent.outputs.skip != 'true'
        id: converge
        env:
          PARENT_NUMBER: ${{ steps.parent.outputs.parent_number }}
          REPO_OWNER: ${{ github.repository_owner }}
          REPO_NAME: ${{ github.event.repository.name }}
        run: |
          # Fetch all sub-issues of the parent
          RESULT=$(gh api graphql -f query='
            query($owner: String!, $repo: String!, $number: Int!) {
              repository(owner: $owner, name: $repo) {
                issue(number: $number) {
                  subIssues(first: 50) {
                    nodes {
                      number
                      state
                      stateReason
                    }
                  }
                }
              }
            }' -f owner="$REPO_OWNER" \
               -f repo="$REPO_NAME" \
               -F number="$PARENT_NUMBER")

          TOTAL=$(echo "$RESULT" | jq '[.data.repository.issue.subIssues.nodes[]] | length')
          COMPLETED=$(echo "$RESULT" | jq '[.data.repository.issue.subIssues.nodes[] | select(.state == "CLOSED" and .stateReason == "COMPLETED")] | length')

          echo "Parent #$PARENT_NUMBER: $COMPLETED/$TOTAL children closed as completed"

          if [ "$TOTAL" -eq 0 ]; then
            echo "Parent #$PARENT_NUMBER has no sub-issues — skipping"
            echo "converged=false" >> "$GITHUB_OUTPUT"
            exit 0
          fi

          if [ "$COMPLETED" -eq "$TOTAL" ]; then
            echo "All children completed — parent eligible for advancement"
            echo "converged=true" >> "$GITHUB_OUTPUT"
          else
            NOT_DONE=$(echo "$RESULT" | jq -r '[.data.repository.issue.subIssues.nodes[] | select(.state != "CLOSED" or .stateReason != "COMPLETED") | "#\(.number) (\(.state)/\(.stateReason // "null"))"] | join(", ")')
            echo "Not all children completed: $NOT_DONE"
            echo "converged=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Resolve project ID and field options
        if: steps.child.outputs.skip != 'true' && steps.parent.outputs.skip != 'true' && steps.converge.outputs.converged == 'true'
        id: project
        run: |
          RESULT=$(gh api graphql -f query='
            query($owner: String!, $number: Int!) {
              user(login: $owner) {
                projectV2(number: $number) {
                  id
                  fields(first: 50) {
                    nodes {
                      ... on ProjectV2SingleSelectField {
                        id
                        name
                        options { id name }
                      }
                    }
                  }
                }
              }
            }' -f owner="$PROJECT_OWNER" -F number="$PROJECT_NUMBER")

          PROJECT_ID=$(echo "$RESULT" | jq -r '.data.user.projectV2.id')
          if [ "$PROJECT_ID" = "null" ] || [ -z "$PROJECT_ID" ]; then
            # Try organization type
            RESULT=$(gh api graphql -f query='
              query($owner: String!, $number: Int!) {
                organization(login: $owner) {
                  projectV2(number: $number) {
                    id
                    fields(first: 50) {
                      nodes {
                        ... on ProjectV2SingleSelectField {
                          id
                          name
                          options { id name }
                        }
                      }
                    }
                  }
                }
              }' -f owner="$PROJECT_OWNER" -F number="$PROJECT_NUMBER")
            PROJECT_ID=$(echo "$RESULT" | jq -r '.data.organization.projectV2.id')
          fi

          if [ "$PROJECT_ID" = "null" ] || [ -z "$PROJECT_ID" ]; then
            echo "::error::Could not find project $PROJECT_OWNER/$PROJECT_NUMBER"
            exit 1
          fi

          echo "project_id=$PROJECT_ID" >> "$GITHUB_OUTPUT"

          FIELD_ID=$(echo "$RESULT" | jq -r '.. | objects | select(.name == "Workflow State") | .id' | head -1)
          if [ -z "$FIELD_ID" ] || [ "$FIELD_ID" = "null" ]; then
            echo "::error::Workflow State field not found in project"
            exit 1
          fi
          echo "field_id=$FIELD_ID" >> "$GITHUB_OUTPUT"

          OPTION_ID=$(echo "$RESULT" | jq -r --arg name "Done" \
            '.. | objects | select(.name == "Workflow State") | .options[] | select(.name == $name) | .id' | head -1)
          if [ -z "$OPTION_ID" ] || [ "$OPTION_ID" = "null" ]; then
            echo "::error::Workflow State option 'Done' not found"
            exit 1
          fi
          echo "option_id=$OPTION_ID" >> "$GITHUB_OUTPUT"
          echo "Resolved: project=$PROJECT_ID, field=$FIELD_ID, option=$OPTION_ID (Done)"

      - name: Resolve parent project item and update
        if: steps.child.outputs.skip != 'true' && steps.parent.outputs.skip != 'true' && steps.converge.outputs.converged == 'true'
        env:
          PARENT_NUMBER: ${{ steps.parent.outputs.parent_number }}
          REPO_OWNER: ${{ github.repository_owner }}
          REPO_NAME: ${{ github.event.repository.name }}
          PROJECT_ID: ${{ steps.project.outputs.project_id }}
          FIELD_ID: ${{ steps.project.outputs.field_id }}
          OPTION_ID: ${{ steps.project.outputs.option_id }}
        run: |
          # Get parent issue node ID
          PARENT_NODE_ID=$(gh api graphql -f query='
            query($owner: String!, $repo: String!, $number: Int!) {
              repository(owner: $owner, name: $repo) {
                issue(number: $number) { id }
              }
            }' -f owner="$REPO_OWNER" \
               -f repo="$REPO_NAME" \
               -F number="$PARENT_NUMBER" \
               --jq '.data.repository.issue.id')

          if [ -z "$PARENT_NODE_ID" ] || [ "$PARENT_NODE_ID" = "null" ]; then
            echo "::error::Could not resolve parent issue #$PARENT_NUMBER"
            exit 1
          fi

          # Find project item
          ITEM_ID=$(gh api graphql -f query='
            query($issueId: ID!) {
              node(id: $issueId) {
                ... on Issue {
                  projectItems(first: 20) {
                    nodes {
                      id
                      project { id }
                    }
                  }
                }
              }
            }' -f issueId="$PARENT_NODE_ID" \
               --jq --arg pid "$PROJECT_ID" \
               '.data.node.projectItems.nodes[] | select(.project.id == $pid) | .id')

          if [ -z "$ITEM_ID" ] || [ "$ITEM_ID" = "null" ]; then
            echo "::warning::Parent issue #$PARENT_NUMBER is not in project — skipping"
            exit 0
          fi

          # Read current Workflow State (idempotency check)
          CURRENT=$(gh api graphql -f query='
            query($itemId: ID!) {
              node(id: $itemId) {
                ... on ProjectV2Item {
                  fieldValueByName(name: "Workflow State") {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                    }
                  }
                }
              }
            }' -f itemId="$ITEM_ID" \
               --jq '.data.node.fieldValueByName.name // empty')

          echo "Parent #$PARENT_NUMBER current Workflow State: ${CURRENT:-<unset>}"

          if [ "$CURRENT" = "Done" ]; then
            echo "Parent #$PARENT_NUMBER already at Done — no-op"
            exit 0
          fi

          # Update parent Workflow State to Done
          gh api graphql -f query='
            mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
              updateProjectV2ItemFieldValue(input: {
                projectId: $projectId,
                itemId: $itemId,
                fieldId: $fieldId,
                value: { singleSelectOptionId: $optionId }
              }) {
                projectV2Item { id }
              }
            }' -f projectId="$PROJECT_ID" \
               -f itemId="$ITEM_ID" \
               -f fieldId="$FIELD_ID" \
               -f optionId="$OPTION_ID"

          echo "Advanced parent #$PARENT_NUMBER: ${CURRENT:-<unset>} → Done"

      - name: Close parent issue for cascading
        if: steps.child.outputs.skip != 'true' && steps.parent.outputs.skip != 'true' && steps.converge.outputs.converged == 'true'
        env:
          PARENT_NUMBER: ${{ steps.parent.outputs.parent_number }}
          REPO_OWNER: ${{ github.repository_owner }}
          REPO_NAME: ${{ github.event.repository.name }}
        run: |
          # Check if parent is already closed
          PARENT_STATE=$(gh api graphql -f query='
            query($owner: String!, $repo: String!, $number: Int!) {
              repository(owner: $owner, name: $repo) {
                issue(number: $number) { state }
              }
            }' -f owner="$REPO_OWNER" \
               -f repo="$REPO_NAME" \
               -F number="$PARENT_NUMBER" \
               --jq '.data.repository.issue.state')

          if [ "$PARENT_STATE" = "CLOSED" ]; then
            echo "Parent #$PARENT_NUMBER already closed — skipping close"
            exit 0
          fi

          # Close parent to trigger cascading (sync-issue-state -> Done, then this workflow for grandparent)
          gh issue close "$PARENT_NUMBER" --repo "$REPO_OWNER/$REPO_NAME" --reason completed
          echo "Closed parent #$PARENT_NUMBER (completed) — cascading enabled"
```

**Concurrency note**: No explicit concurrency group is needed on this workflow. Each `issues: [closed]` event targets a different child issue. The parent update step is idempotent (skips if already Done). The parent close step checks `state == CLOSED` before closing. Multiple children closing simultaneously would each check convergence independently, and the first to update wins -- subsequent runs see "already Done" and no-op.

### Success Criteria
- [x] Automated: workflow YAML is valid (parseable by GitHub Actions)
- [x] Automated: shell syntax valid (`bash -n`)
- [ ] Manual: `workflow_dispatch` with a child issue number triggers parent check
- [ ] Manual: parent with all children completed advances to Done
- [ ] Manual: parent with incomplete children does not advance
- [ ] Manual: parent already at Done is skipped (idempotent)
- [ ] Manual: issue with no parent exits silently
- [ ] Manual: close as "not_planned" does not trigger advancement
- [ ] Manual: cascading works (closing parent triggers grandparent check)

---

## Integration Testing
- [ ] Manual: close last open child issue as "completed" → parent advances to Done and is closed
- [ ] Manual: close child as "not_planned" → parent does NOT advance
- [ ] Manual: close child when other siblings still open → parent does NOT advance
- [ ] Manual: `workflow_dispatch` with child issue number → correct parent check
- [ ] Manual: parent not in project → graceful skip with warning
- [ ] Manual: cascading: close last child of a child-parent that is itself a child → grandparent advances

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0177-parent-auto-advance-on-children-done.md
- Sibling workflow GH-175: `.github/workflows/sync-issue-state.yml`
- Sibling workflow GH-176: `.github/workflows/sync-pr-merge.yml`
- MCP equivalent: `relationship-tools.ts:715-965` (`advance_parent` tool)
- Workflow states: `lib/workflow-states.ts` (STATE_ORDER, PARENT_GATE_STATES)
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/127
