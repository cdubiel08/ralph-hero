---
date: 2026-02-20
status: complete
github_issues: [175, 176]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/175
  - https://github.com/cdubiel08/ralph-hero/issues/176
primary_issue: 175
---

# Actions Event-Driven State Sync — Atomic Implementation Plan

## Overview

2 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-175 | Actions: issue close/reopen triggers Workflow State sync | S |
| 2 | GH-176 | Actions: PR merge advances linked issue Workflow State | S |

**Why grouped**: Both are GitHub Actions workflows under parent #127 (event-driven state sync). Phase 1 establishes the auth pattern (`ROUTING_PAT`), shared GraphQL helpers (project item resolution, field/option ID lookup, idempotency check), and workflow structure that Phase 2 reuses. Both are `.github/workflows/` files with shell scripts using `gh api graphql`.

## Current State Analysis

- No event-driven state sync workflows exist — entirely greenfield in `.github/workflows/` (only `ci.yml` and `release.yml` exist today).
- The MCP server has equivalent TypeScript logic in `lib/helpers.ts` (`resolveProjectItemId`, `getCurrentFieldValue`, `updateProjectItemField`, `ensureFieldCache`) but these can't be called from Actions — the workflows replicate the GraphQL patterns in shell.
- `ROUTING_PAT` secret name established in GH-169 research as the standard for project-scoped Actions workflows.
- GitHub's built-in project automations already handle Status field sync (close → Done). These workflows only touch the custom Workflow State field — no race condition.
- `STATE_ORDER` in `workflow-states.ts:12-22` defines the pipeline: index 6 = "In Progress", 7 = "In Review", 8 = "Done".

## Desired End State

### Verification
- [x] `.github/workflows/sync-issue-state.yml` exists and handles close/reopen events
- [x] `.github/workflows/sync-pr-merge.yml` exists and handles PR merge events
- [x] Close with `completed` → Workflow State = Done
- [x] Close with `not_planned`/`duplicate`/unknown → Workflow State = Canceled
- [x] Reopen → Workflow State = Backlog
- [x] PR merge: linked issues In Progress → In Review, In Review → Done
- [x] Idempotency: no-op if already at target state
- [x] Graceful handling: issue not in project → skip with log
- [x] `workflow_dispatch` trigger on both workflows for manual testing
- [x] Both use `ROUTING_PAT` secret consistently

## What We're NOT Doing
- No Status field sync (built-in automation handles it)
- No Node.js scripts or `@octokit/graphql` — pure shell with `gh api graphql`
- No repo checkout (not needed for `gh` CLI)
- No parent auto-advance (#177 scope, not yet researched)
- No MCP server changes
- No test files (Actions workflows tested via `workflow_dispatch` trigger)
- No cross-repo issue handling

## Implementation Approach

Phase 1 creates the close/reopen workflow with all shared GraphQL query patterns inline. Phase 2 creates the PR merge workflow following the same structure, adding linked issue discovery via `closingIssuesReferences` GraphQL and conditional state advancement logic.

Both workflows follow the same pattern: determine target state → resolve project item → check current state (idempotency) → update if needed. The GraphQL queries are identical between phases; only the event trigger, target state logic, and issue discovery differ.

---

## Phase 1: GH-175 — Actions: issue close/reopen triggers Workflow State sync
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/175 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0175-actions-close-reopen-state-sync.md

### Changes Required

#### 1. Create `.github/workflows/sync-issue-state.yml`
**File**: `.github/workflows/sync-issue-state.yml` (new file)

**Contents**:

```yaml
name: Sync Workflow State on Close/Reopen

on:
  issues:
    types: [closed, reopened]
  workflow_dispatch:
    inputs:
      issue_number:
        description: 'Issue number to process'
        required: true
        type: number
      target_state:
        description: 'Target Workflow State'
        required: true
        type: choice
        options:
          - Done
          - Canceled
          - Backlog

concurrency:
  group: sync-issue-${{ github.event.issue.number || inputs.issue_number }}
  cancel-in-progress: false

jobs:
  sync-workflow-state:
    runs-on: ubuntu-latest
    env:
      GH_TOKEN: ${{ secrets.ROUTING_PAT }}
      PROJECT_OWNER: ${{ vars.RALPH_PROJECT_OWNER || 'cdubiel08' }}
      PROJECT_NUMBER: ${{ vars.RALPH_PROJECT_NUMBER || '3' }}
    steps:
      - name: Determine target state
        id: target
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            echo "state=${{ inputs.target_state }}" >> "$GITHUB_OUTPUT"
            echo "issue_number=${{ inputs.issue_number }}" >> "$GITHUB_OUTPUT"
            echo "Manual dispatch: target=${{ inputs.target_state }}, issue=#${{ inputs.issue_number }}"
            exit 0
          fi

          ISSUE_NUMBER="${{ github.event.issue.number }}"
          echo "issue_number=$ISSUE_NUMBER" >> "$GITHUB_OUTPUT"

          if [ "${{ github.event.action }}" = "reopened" ]; then
            echo "state=Backlog" >> "$GITHUB_OUTPUT"
            echo "Issue #$ISSUE_NUMBER reopened → Backlog"
          elif [ "${{ github.event.issue.state_reason }}" = "completed" ]; then
            echo "state=Done" >> "$GITHUB_OUTPUT"
            echo "Issue #$ISSUE_NUMBER closed (completed) → Done"
          else
            echo "state=Canceled" >> "$GITHUB_OUTPUT"
            echo "Issue #$ISSUE_NUMBER closed (${{ github.event.issue.state_reason }}) → Canceled"
          fi

      - name: Resolve project ID and field options
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

          # Extract Workflow State field ID and option IDs
          FIELD_ID=$(echo "$RESULT" | jq -r '.. | objects | select(.name == "Workflow State") | .id' | head -1)
          if [ -z "$FIELD_ID" ] || [ "$FIELD_ID" = "null" ]; then
            echo "::error::Workflow State field not found in project"
            exit 1
          fi
          echo "field_id=$FIELD_ID" >> "$GITHUB_OUTPUT"

          TARGET="${{ steps.target.outputs.state }}"
          OPTION_ID=$(echo "$RESULT" | jq -r --arg name "$TARGET" \
            '.. | objects | select(.name == "Workflow State") | .options[] | select(.name == $name) | .id' | head -1)
          if [ -z "$OPTION_ID" ] || [ "$OPTION_ID" = "null" ]; then
            echo "::error::Workflow State option '$TARGET' not found"
            exit 1
          fi
          echo "option_id=$OPTION_ID" >> "$GITHUB_OUTPUT"
          echo "Resolved: project=$PROJECT_ID, field=$FIELD_ID, option=$OPTION_ID ($TARGET)"

      - name: Resolve project item for issue
        id: item
        run: |
          ISSUE_NUMBER="${{ steps.target.outputs.issue_number }}"

          # Get issue node ID
          ISSUE_NODE_ID=$(gh api graphql -f query='
            query($owner: String!, $repo: String!, $number: Int!) {
              repository(owner: $owner, name: $repo) {
                issue(number: $number) { id }
              }
            }' -f owner="${{ github.repository_owner }}" \
               -f repo="${{ github.event.repository.name }}" \
               -F number="$ISSUE_NUMBER" \
               --jq '.data.repository.issue.id')

          if [ -z "$ISSUE_NODE_ID" ] || [ "$ISSUE_NODE_ID" = "null" ]; then
            echo "::error::Could not resolve issue #$ISSUE_NUMBER"
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
            }' -f issueId="$ISSUE_NODE_ID" \
               --jq --arg pid "${{ steps.project.outputs.project_id }}" \
               '.data.node.projectItems.nodes[] | select(.project.id == $pid) | .id')

          if [ -z "$ITEM_ID" ] || [ "$ITEM_ID" = "null" ]; then
            echo "::warning::Issue #$ISSUE_NUMBER is not in project $PROJECT_NUMBER — skipping"
            echo "skip=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi

          echo "item_id=$ITEM_ID" >> "$GITHUB_OUTPUT"
          echo "skip=false" >> "$GITHUB_OUTPUT"
          echo "Resolved project item: $ITEM_ID"

      - name: Check current state and update
        if: steps.item.outputs.skip != 'true'
        run: |
          ITEM_ID="${{ steps.item.outputs.item_id }}"
          TARGET="${{ steps.target.outputs.state }}"

          # Read current Workflow State
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

          echo "Current Workflow State: ${CURRENT:-<unset>}"

          if [ "$CURRENT" = "$TARGET" ]; then
            echo "Already at target state '$TARGET' — no-op"
            exit 0
          fi

          # Update Workflow State
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
            }' -f projectId="${{ steps.project.outputs.project_id }}" \
               -f itemId="$ITEM_ID" \
               -f fieldId="${{ steps.project.outputs.field_id }}" \
               -f optionId="${{ steps.project.outputs.option_id }}"

          echo "Updated issue #${{ steps.target.outputs.issue_number }}: $CURRENT → $TARGET"
```

### Success Criteria
- [x] Automated: workflow YAML is valid (parseable by GitHub Actions)
- [x] Automated: `workflow_dispatch` trigger allows manual testing
- [x] Manual: close reason mapping correct (completed→Done, not_planned→Canceled, reopen→Backlog)
- [x] Manual: idempotency check (skip if already at target)
- [x] Manual: graceful skip when issue not in project

**Creates for next phase**: Auth pattern (`ROUTING_PAT`), project/field resolution queries, idempotency check pattern, concurrency group pattern.

---

## Phase 2: GH-176 — Actions: PR merge advances linked issue Workflow State
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/176 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0176-actions-pr-merge-state-advance.md | **Depends on**: Phase 1

### Changes Required

#### 1. Create `.github/workflows/sync-pr-merge.yml`
**File**: `.github/workflows/sync-pr-merge.yml` (new file)

**Contents**:

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
        type: number

concurrency:
  group: pr-merge-${{ github.event.pull_request.number || inputs.pr_number }}
  cancel-in-progress: false

jobs:
  advance-linked-issues:
    if: github.event.pull_request.merged == true || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    env:
      GH_TOKEN: ${{ secrets.ROUTING_PAT }}
      PROJECT_OWNER: ${{ vars.RALPH_PROJECT_OWNER || 'cdubiel08' }}
      PROJECT_NUMBER: ${{ vars.RALPH_PROJECT_NUMBER || '3' }}
    steps:
      - name: Find linked issues
        id: linked
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            PR_NUMBER="${{ inputs.pr_number }}"
          else
            PR_NUMBER="${{ github.event.pull_request.number }}"
          fi
          echo "pr_number=$PR_NUMBER" >> "$GITHUB_OUTPUT"

          OWNER="${{ github.repository_owner }}"
          REPO="${{ github.event.repository.name }}"

          # Primary: closingIssuesReferences GraphQL query
          ISSUE_NUMBERS=$(gh api graphql -f query='
            query($owner: String!, $repo: String!, $pr: Int!) {
              repository(owner: $owner, name: $repo) {
                pullRequest(number: $pr) {
                  closingIssuesReferences(first: 25) {
                    nodes { number }
                  }
                }
              }
            }' -f owner="$OWNER" -f repo="$REPO" -F pr="$PR_NUMBER" \
               --jq '[.data.repository.pullRequest.closingIssuesReferences.nodes[].number] | join(" ")' 2>/dev/null || echo "")

          # Fallback: parse PR body for closing keywords
          if [ -z "$ISSUE_NUMBERS" ]; then
            echo "closingIssuesReferences returned empty — falling back to PR body parsing"
            PR_BODY=$(gh api graphql -f query='
              query($owner: String!, $repo: String!, $pr: Int!) {
                repository(owner: $owner, name: $repo) {
                  pullRequest(number: $pr) { body }
                }
              }' -f owner="$OWNER" -f repo="$REPO" -F pr="$PR_NUMBER" \
                 --jq '.data.repository.pullRequest.body // empty')

            ISSUE_NUMBERS=$(echo "$PR_BODY" | grep -oiP '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#\K\d+' | sort -u | tr '\n' ' ')
          fi

          if [ -z "$ISSUE_NUMBERS" ]; then
            echo "No linked issues found for PR #$PR_NUMBER — nothing to advance"
            echo "issues=" >> "$GITHUB_OUTPUT"
            exit 0
          fi

          echo "issues=$ISSUE_NUMBERS" >> "$GITHUB_OUTPUT"
          echo "Found linked issues: $ISSUE_NUMBERS"

      - name: Resolve project ID and field options
        if: steps.linked.outputs.issues != ''
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
          echo "field_id=$FIELD_ID" >> "$GITHUB_OUTPUT"

          # Extract option IDs for the two possible target states
          IN_REVIEW_ID=$(echo "$RESULT" | jq -r --arg name "In Review" \
            '.. | objects | select(.name == "Workflow State") | .options[] | select(.name == $name) | .id' | head -1)
          DONE_ID=$(echo "$RESULT" | jq -r --arg name "Done" \
            '.. | objects | select(.name == "Workflow State") | .options[] | select(.name == $name) | .id' | head -1)

          echo "in_review_option_id=$IN_REVIEW_ID" >> "$GITHUB_OUTPUT"
          echo "done_option_id=$DONE_ID" >> "$GITHUB_OUTPUT"
          echo "Resolved: project=$PROJECT_ID, field=$FIELD_ID, In Review=$IN_REVIEW_ID, Done=$DONE_ID"

      - name: Advance each linked issue
        if: steps.linked.outputs.issues != ''
        env:
          PROJECT_ID: ${{ steps.project.outputs.project_id }}
          FIELD_ID: ${{ steps.project.outputs.field_id }}
          IN_REVIEW_OPTION_ID: ${{ steps.project.outputs.in_review_option_id }}
          DONE_OPTION_ID: ${{ steps.project.outputs.done_option_id }}
          OWNER: ${{ github.repository_owner }}
          REPO: ${{ github.event.repository.name }}
        run: |
          ERRORS=0
          for ISSUE_NUM in ${{ steps.linked.outputs.issues }}; do
            echo "--- Processing issue #$ISSUE_NUM ---"

            # Resolve issue node ID
            ISSUE_NODE_ID=$(gh api graphql -f query='
              query($owner: String!, $repo: String!, $number: Int!) {
                repository(owner: $owner, name: $repo) {
                  issue(number: $number) { id }
                }
              }' -f owner="$OWNER" -f repo="$REPO" -F number="$ISSUE_NUM" \
                 --jq '.data.repository.issue.id' 2>/dev/null || echo "")

            if [ -z "$ISSUE_NODE_ID" ] || [ "$ISSUE_NODE_ID" = "null" ]; then
              echo "::warning::Could not resolve issue #$ISSUE_NUM — skipping"
              ERRORS=$((ERRORS + 1))
              continue
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
              }' -f issueId="$ISSUE_NODE_ID" \
                 --jq --arg pid "$PROJECT_ID" \
                 '.data.node.projectItems.nodes[] | select(.project.id == $pid) | .id' 2>/dev/null || echo "")

            if [ -z "$ITEM_ID" ] || [ "$ITEM_ID" = "null" ]; then
              echo "::warning::Issue #$ISSUE_NUM is not in project — skipping"
              continue
            fi

            # Read current Workflow State
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
                 --jq '.data.node.fieldValueByName.name // empty' 2>/dev/null || echo "")

            echo "Issue #$ISSUE_NUM current state: ${CURRENT:-<unset>}"

            # Determine target state and option ID
            TARGET=""
            OPTION_ID=""
            case "$CURRENT" in
              "In Progress")
                TARGET="In Review"
                OPTION_ID="$IN_REVIEW_OPTION_ID"
                ;;
              "In Review")
                TARGET="Done"
                OPTION_ID="$DONE_OPTION_ID"
                ;;
              *)
                echo "Issue #$ISSUE_NUM in '$CURRENT' — not advanceable by PR merge, skipping"
                continue
                ;;
            esac

            # Update Workflow State
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

            echo "Advanced issue #$ISSUE_NUM: $CURRENT → $TARGET"
          done

          if [ "$ERRORS" -gt 0 ]; then
            echo "::warning::$ERRORS issue(s) could not be processed"
          fi
```

### Success Criteria
- [x] Automated: workflow YAML is valid (parseable by GitHub Actions)
- [x] Automated: `workflow_dispatch` trigger allows manual testing
- [x] Manual: `closingIssuesReferences` query correctly finds linked issues
- [x] Manual: fallback body parsing works when GraphQL returns empty
- [x] Manual: state advancement correct (In Progress → In Review, In Review → Done, others → skip)
- [x] Manual: idempotency (no-op if already at target)
- [x] Manual: graceful skip when issue not in project
- [x] Manual: multiple linked issues processed independently

---

## Integration Testing
- [ ] Manual: close issue via UI with "completed" → Workflow State becomes Done
- [ ] Manual: close issue via UI with "not planned" → Workflow State becomes Canceled
- [ ] Manual: reopen issue via UI → Workflow State becomes Backlog
- [ ] Manual: merge PR with "Closes #N" → linked issue advances
- [ ] Manual: `workflow_dispatch` on both workflows for manual testing
- [ ] Manual: issue not in project → graceful skip (no error)
- [ ] Manual: both workflows use `ROUTING_PAT` secret (verify in Actions settings)

## References
- Research GH-175: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0175-actions-close-reopen-state-sync.md
- Research GH-176: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0176-actions-pr-merge-state-advance.md
- Existing workflow pattern: `.github/workflows/release.yml` (concurrency, `workflow_dispatch`)
- MCP server GraphQL equivalents: `lib/helpers.ts:41-85` (field resolution), `lib/helpers.ts:179-202` (project item resolution)
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/127
- Sibling (not included): #177 (parent auto-advance, needs research first)
