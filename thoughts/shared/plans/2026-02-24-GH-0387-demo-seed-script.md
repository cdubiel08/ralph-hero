---
date: 2026-02-24
status: draft
github_issues: [387]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/387
primary_issue: 387
---

# Demo Seed Script - Atomic Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-387 | Create demo seed script for onboarding showcase | XS |

## Current State Analysis

The `plugin/ralph-hero/scripts/` directory contains 5 scripts (`ralph-cli.sh`, `ralph-loop.sh`, `ralph-team-loop.sh`, and two completion scripts). No demo, seed, or fixture scripts exist yet. This is net-new work.

Existing script conventions:
- Shebang: `#!/bin/bash` (loop scripts) or `#!/usr/bin/env bash` (cli script)
- Error handling: `set -e` minimum, `set -euo pipefail` preferred
- Argument parsing: manual `case "$arg" in` loop
- Environment variables with defaults, no hardcoded values
- Output: plain echo to stdout with visual separators (`===`)
- Dependencies: only `gh`, `git`, and standard shell builtins

Key technical findings from research:
- Sub-issue linking requires `gh api graphql` with the `addSubIssue` mutation (no native `gh` CLI flag)
- Project board addition via `gh project item-add PROJECT_NUMBER --owner OWNER --url ISSUE_URL`
- Idempotency via a `ralph-demo` label: check for existing open issues with that label before creating
- Node IDs for GraphQL resolved via `gh api repos/OWNER/REPO/issues/NNN --jq '.node_id'`

## Desired End State

A single executable script at `plugin/ralph-hero/scripts/demo-seed.sh` that:
1. Creates a demo umbrella issue and 3 XS sub-issues via `gh` CLI
2. Links sub-issues to the umbrella via GraphQL `addSubIssue` mutation
3. Adds all issues to the configured GitHub Project board
4. Prints created issue numbers to stdout for piping to `demo-cleanup.sh`
5. Is idempotent (checks for existing `ralph-demo` labeled issues before creating)

### Verification
- [ ] `bash plugin/ralph-hero/scripts/demo-seed.sh` creates 4 issues (1 umbrella + 3 sub-issues)
- [ ] Sub-issues are linked as children of the umbrella issue on GitHub
- [ ] All 4 issues appear on the GitHub Project board
- [ ] Issue numbers are printed to stdout (space-separated)
- [ ] Running the script a second time exits cleanly without creating duplicates
- [ ] Script uses environment variables `RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER` with sensible defaults

## What We're NOT Doing
- Cleanup of demo issues (handled by sibling issue #388)
- Recording setup or documentation (separate sub-issues #389, #390)
- Setting project field values (Estimate, Priority, Workflow State) on demo issues -- the showcase demonstrates Ralph doing that
- Writing to a `.demo-issues` state file -- stdout output is sufficient for piping to cleanup script
- MCP server changes -- this is pure shell script work

## Implementation Approach

Single phase: create the shell script following established conventions from `ralph-loop.sh` and `ralph-cli.sh`. The script uses a sequential flow: validate prerequisites, check idempotency, create issues, link relationships, add to project, output results.

---

## Phase 1: Create `demo-seed.sh`
> **Issue**: [GH-387](https://github.com/cdubiel08/ralph-hero/issues/387) | **Research**: [GH-0387 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-24-GH-0387-demo-seed-script.md)

### Changes Required

#### 1. New file: `plugin/ralph-hero/scripts/demo-seed.sh`

**File**: `plugin/ralph-hero/scripts/demo-seed.sh`

**Structure** (following conventions from `ralph-loop.sh` and `ralph-cli.sh`):

```bash
#!/usr/bin/env bash
# demo-seed.sh -- Seed demo issues for onboarding showcase
#
# Creates an umbrella issue with 3 XS sub-issues for the Ralph Hero
# onboarding demo. Issues are added to the GitHub Project board and
# linked as parent/child relationships.
#
# Usage: ./scripts/demo-seed.sh [--force]
#
# Environment:
#   RALPH_GH_OWNER           GitHub owner (default: cdubiel08)
#   RALPH_GH_REPO            Repository name (default: ralph-hero)
#   RALPH_GH_PROJECT_NUMBER  Project board number (default: 3)
#
# Output: Space-separated issue numbers (umbrella first, then sub-issues)
#         e.g., "42 43 44 45"

set -euo pipefail
```

**Sections to implement:**

1. **Environment variables with defaults**:
   ```bash
   OWNER="${RALPH_GH_OWNER:-cdubiel08}"
   REPO="${RALPH_GH_REPO:-ralph-hero}"
   PROJECT="${RALPH_GH_PROJECT_NUMBER:-3}"
   LABEL="ralph-demo"
   ```

2. **Argument parsing** (`--force` flag to skip idempotency check):
   ```bash
   FORCE=false
   for arg in "$@"; do
       case "$arg" in
           --force) FORCE=true ;;
       esac
   done
   ```

3. **Prerequisite check** (verify `gh` CLI is authenticated):
   ```bash
   if ! gh auth status &>/dev/null; then
       echo "Error: gh CLI not authenticated. Run: gh auth login"
       exit 1
   fi
   ```

4. **Idempotency check** (scan for existing open `ralph-demo` labeled issues):
   ```bash
   if [ "$FORCE" = "false" ]; then
       EXISTING=$(gh issue list --repo "$OWNER/$REPO" \
           --label "$LABEL" --state open \
           --json number --jq 'length')
       if [ "$EXISTING" -gt 0 ]; then
           echo "Demo issues already exist ($EXISTING open with label '$LABEL')."
           echo "Run demo-cleanup.sh first, or use --force to skip this check."
           exit 0
       fi
   fi
   ```

5. **Ensure label exists** (create `ralph-demo` label if it doesn't exist):
   ```bash
   if ! gh label list --repo "$OWNER/$REPO" --json name --jq '.[].name' | grep -qx "$LABEL"; then
       gh label create "$LABEL" --repo "$OWNER/$REPO" \
           --description "Demo issues for onboarding showcase" \
           --color "D4C5F9"
   fi
   ```

6. **Create umbrella issue**:
   ```bash
   UMBRELLA_URL=$(gh issue create --repo "$OWNER/$REPO" \
       --title "Demo: Add greeting message to CLI" \
       --body "Umbrella issue for onboarding demo.\n\n### Sub-issues (XS each)\n- [ ] Add 'Welcome to Ralph' banner on first run\n- [ ] Add --version flag to ralph-cli.sh\n- [ ] Add --help flag with usage summary" \
       --label "$LABEL")
   UMBRELLA_NUM=$(echo "$UMBRELLA_URL" | grep -oE '[0-9]+$')
   ```

7. **Create 3 sub-issues** (titles from issue #387 spec):
   ```bash
   SUB_TITLES=(
       "Add Welcome to Ralph banner on first run"
       "Add --version flag to ralph-cli.sh"
       "Add --help flag with usage summary"
   )
   SUB_NUMS=()
   for title in "${SUB_TITLES[@]}"; do
       url=$(gh issue create --repo "$OWNER/$REPO" \
           --title "$title" \
           --body "XS sub-issue for onboarding demo. Part of umbrella #$UMBRELLA_NUM." \
           --label "$LABEL")
       num=$(echo "$url" | grep -oE '[0-9]+$')
       SUB_NUMS+=("$num")
   done
   ```

8. **Link sub-issues to umbrella via GraphQL** (resolve node IDs, then call `addSubIssue`):
   ```bash
   UMBRELLA_NODE_ID=$(gh api "repos/$OWNER/$REPO/issues/$UMBRELLA_NUM" --jq '.node_id')
   for num in "${SUB_NUMS[@]}"; do
       CHILD_NODE_ID=$(gh api "repos/$OWNER/$REPO/issues/$num" --jq '.node_id')
       gh api graphql -f query='
           mutation($parentId: ID!, $childId: ID!) {
               addSubIssue(input: { issueId: $parentId, subIssueId: $childId }) {
                   issue { number }
                   subIssue { number }
               }
           }' -f parentId="$UMBRELLA_NODE_ID" -f childId="$CHILD_NODE_ID" --silent
   done
   ```

9. **Add all issues to the project board** (graceful skip if project number unset):
   ```bash
   if [ -n "$PROJECT" ]; then
       for num in "$UMBRELLA_NUM" "${SUB_NUMS[@]}"; do
           gh project item-add "$PROJECT" \
               --owner "$OWNER" \
               --url "https://github.com/$OWNER/$REPO/issues/$num" 2>/dev/null || \
               echo "Warning: Could not add #$num to project $PROJECT"
       done
   fi
   ```

10. **Output results** (parseable for piping to cleanup script):
    ```bash
    echo ""
    echo "=========================================="
    echo "  Demo issues created successfully"
    echo "=========================================="
    echo "Umbrella: #$UMBRELLA_NUM"
    for i in "${!SUB_NUMS[@]}"; do
        echo "Sub-issue $((i+1)): #${SUB_NUMS[$i]} - ${SUB_TITLES[$i]}"
    done
    echo ""
    echo "$UMBRELLA_NUM ${SUB_NUMS[*]}"
    ```
    The final line is the machine-readable output (space-separated numbers) for piping.

**Make executable**: `chmod +x plugin/ralph-hero/scripts/demo-seed.sh`

### Success Criteria
- [x] Automated: `bash -n plugin/ralph-hero/scripts/demo-seed.sh` passes syntax check (no parse errors)
- [x] Automated: `shellcheck plugin/ralph-hero/scripts/demo-seed.sh` passes with no errors (if shellcheck available)
- [ ] Manual: Running the script creates 4 issues on GitHub with correct titles and labels
- [ ] Manual: Sub-issues appear as children of the umbrella issue in GitHub's sub-issue UI
- [ ] Manual: All 4 issues appear on GitHub Project #3
- [ ] Manual: Running a second time exits with "Demo issues already exist" message
- [ ] Manual: `--force` flag bypasses idempotency check

---

## Integration Testing
- [ ] Run `demo-seed.sh` and verify 4 issues created with `ralph-demo` label
- [ ] Verify sub-issue relationships visible on the umbrella issue page
- [ ] Verify issues appear on GitHub Project board
- [ ] Capture output, verify it contains space-separated issue numbers on last line
- [ ] Run again without `--force`, verify it exits cleanly
- [ ] Run `demo-cleanup.sh` (once implemented by #388) with the output numbers

## References
- Research: [GH-0387 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-24-GH-0387-demo-seed-script.md)
- Idea doc: [showcase-demo-onboarding](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/ideas/2026-02-21-showcase-demo-onboarding.md)
- Parent issue: [GH-310](https://github.com/cdubiel08/ralph-hero/issues/310)
- Script conventions: [ralph-loop.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/scripts/ralph-loop.sh), [ralph-cli.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/scripts/ralph-cli.sh)
- GraphQL mutation reference: [relationship-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts)
