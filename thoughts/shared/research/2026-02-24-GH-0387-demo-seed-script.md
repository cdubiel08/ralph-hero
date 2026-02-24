---
date: 2026-02-24
github_issue: 387
github_url: https://github.com/cdubiel08/ralph-hero/issues/387
status: complete
type: research
---

# GH-387: Create Demo Seed Script for Onboarding Showcase

## Problem Statement

New contributors to ralph-hero need a repeatable way to spin up a clean demo environment for the onboarding showcase recording. Issue #387 asks for a shell script (`demo-seed.sh`) that:

1. Creates an umbrella "Demo" issue and 3 XS sub-issues via the `gh` CLI
2. Links the sub-issues as GitHub sub-issues (parent/child) of the umbrella
3. Adds all created issues to the configured GitHub Project board
4. Outputs created issue numbers to stdout for use by the cleanup script (#388)
5. Is idempotent — does not re-create issues if they already exist

This is part of a 4-issue group under parent #310:
- **#387** (this): demo-seed.sh (XS) — parallel with #388
- **#388**: demo-cleanup.sh (XS) — parallel with #387
- **#389**: Record demo (S) — depends on #387 + #388
- **#390**: README/wiki onboarding section (XS) — depends on #389

---

## Current State Analysis

### Existing Scripts

The `plugin/ralph-hero/scripts/` directory contains 5 scripts:

| File | Purpose |
|------|---------|
| `ralph-cli.sh` | Global CLI entry point, delegates to `just` |
| `ralph-loop.sh` | Autonomous workflow loop (sequential phases) |
| `ralph-team-loop.sh` | Multi-agent team orchestrator launcher |
| `ralph-completions.bash` | Bash tab completions |
| `ralph-completions.zsh` | Zsh tab completions |

**No demo, seed, or fixture scripts exist yet.** This is net-new work.

### Script Conventions in the Codebase

All existing scripts follow these patterns (from `ralph-loop.sh`, `ralph-team-loop.sh`):
- Shebang: `#!/bin/bash` (not `#!/usr/bin/env bash`, though either works)
- Error handling: `set -e` at minimum; `ralph-cli.sh` uses `set -euo pipefail`
- Argument parsing: manual `case "$arg" in` loop over `"$@"`
- Environment variables: read from env, no hardcoded values
- Output: plain echo to stdout with visual separators (`=====`)
- No external dependencies beyond `gh`, `git`, and standard shell builtins

### `gh` CLI Capabilities

The `gh` CLI (v2.79.0) provides all required operations:

**Issue creation** (`gh issue create`):
```bash
gh issue create --repo OWNER/REPO \
  --title "title" \
  --body "body" \
  --label "demo"
# Returns the URL of the created issue
```

**Adding to project** (`gh project item-add`):
```bash
gh project item-add PROJECT_NUMBER \
  --owner OWNER \
  --url https://github.com/OWNER/REPO/issues/NNN
```

**Sub-issue relationship** — requires GraphQL (no direct `gh issue` subcommand):
```bash
gh api graphql -f query='
  mutation($parentId: ID!, $childId: ID!) {
    addSubIssue(input: { issueId: $parentId, subIssueId: $childId }) {
      issue { number }
      subIssue { number }
    }
  }
' -f parentId="$PARENT_NODE_ID" -f childId="$CHILD_NODE_ID"
```

Node IDs can be resolved via:
```bash
gh api repos/OWNER/REPO/issues/NNN --jq '.node_id'
```

**Idempotency — detecting existing demo issues by label**:
```bash
gh issue list --repo OWNER/REPO --label "demo" --state open --json number,title
```

### GitHub Project #3 ("Ralph Workflow")

- Project number: **3**
- Owner: **cdubiel08**
- Fields include: Workflow State (single select), Priority, Estimate, Status
- Workflow State options: Backlog, Research Needed, Research in Progress, Ready for Plan, Plan in Progress, Plan in Review, In Progress, In Review, Done, Human Needed, Canceled
- The `gh issue create --project "Ralph Workflow"` flag can add to a project by title at creation time, but this requires the `project` scope on the token. Using `gh project item-add` post-creation is more reliable and explicit.

### Environment Variables (from CLAUDE.md)

Scripts should read from the same env vars used by the MCP server:
- `RALPH_GH_OWNER` — GitHub owner (default: `cdubiel08`)
- `RALPH_GH_REPO` — Repository name (default: `ralph-hero`)
- `RALPH_GH_PROJECT_NUMBER` — Project number (default: `3`)

These are already established conventions in this project.

### MCP Server Sub-Issue Implementation Reference

The MCP server's `ralph_hero__add_sub_issue` tool (in `relationship-tools.ts`) uses the `addSubIssue` GraphQL mutation:

```graphql
mutation($parentId: ID!, $childId: ID!, $replaceParent: Boolean) {
  addSubIssue(input: {
    issueId: $parentId,
    subIssueId: $childId,
    replaceParent: $replaceParent
  }) {
    issue { id number title }
    subIssue { id number title }
  }
}
```

The shell script can replicate this via `gh api graphql`.

---

## Key Discoveries

### 1. Idempotency Strategy

The issue body specifies "checks for existing demo issues before creating." Best approach is a dedicated label (e.g., `ralph-demo`) that the script applies at creation and checks before re-creating. The existing labels are: `bug`, `documentation`, `duplicate`, `enhancement`, `good first issue`, `help wanted`, `invalid`, `question`, `wontfix`, `needs-iteration`, `ralph-triage`. A new `ralph-demo` label should be created by the script if it doesn't exist.

Pattern:
```bash
EXISTING=$(gh issue list --repo "$OWNER/$REPO" \
  --label "ralph-demo" --state open \
  --json number,title --jq 'length')
if [ "$EXISTING" -gt 0 ]; then
  echo "Demo issues already exist. Run demo-cleanup.sh first."
  exit 0
fi
```

### 2. Sub-Issue Linking Requires GraphQL

There is no `gh issue set-parent` or equivalent in the `gh` CLI. Sub-issue parent/child relationships must be set via the `addSubIssue` GraphQL mutation. The node IDs for the issues can be fetched with `gh api repos/$OWNER/$REPO/issues/$NUMBER --jq '.node_id'`.

### 3. Project Board Addition

`gh project item-add PROJECT_NUMBER --owner OWNER --url ISSUE_URL` is the simplest approach. It requires the `project` scope on the GitHub token. The script should check token scope or gracefully handle failures here with a clear error message.

### 4. Issue Number Output

The issue body says "outputs issue numbers to stdout for use by the cleanup script." The script should write the created issue numbers to stdout in a parseable format (one per line or space-separated) and optionally to a local state file (e.g., `.demo-issues`) for use by the cleanup script.

### 5. Umbrella Issue Body Should Match the Demo Narrative

From the idea doc (`thoughts/ideas/2026-02-21-showcase-demo-onboarding.md`), the seed template is:
- Umbrella: `"Demo: Add greeting message to CLI"`
- Sub-issues: `"Add 'Welcome to Ralph' banner on first run"`, `"Add --version flag to ralph-cli.sh"`, `"Add --help flag with usage summary"`

Issue #387's own body specifies slightly different titles (adds `ralph-cli.sh` context). The issue body's version should be treated as the authoritative spec.

### 6. Estimate Field on Project Board

The script may need to set the `Estimate` field on sub-issues to `XS` via `gh project item-edit`. This ensures the demo issues appear correctly in filtered board views. This is optional but aligns with the showcase narrative (which emphasizes XS issues completing quickly).

---

## Potential Approaches

### Approach A: Pure `gh` CLI (Recommended)

Use `gh issue create`, `gh project item-add`, and `gh api graphql` (for sub-issue linking). No additional dependencies.

**Pros:**
- Matches existing script conventions
- All operations are reversible
- `gh` is already a required dependency for ralph workflows
- Clear error messages from gh CLI

**Cons:**
- Sub-issue linking requires explicit GraphQL call (one extra step)
- Three separate operations per sub-issue (create → add to project → link to parent)

### Approach B: `gh` CLI with `--project` flag at creation

Create issues using `gh issue create --project "Ralph Workflow"` to add to project in one step, then use GraphQL for sub-issue linking.

**Pros:**
- Fewer API calls for project addition

**Cons:**
- Requires exact project title (fragile if project is renamed)
- Requires `project` scope — same as `gh project item-add`
- Less explicit / harder to observe what happened

**Recommendation:** Approach A. Explicit steps are easier to debug, and `gh project item-add` with a project number is more stable than relying on the project title string.

---

## Risks

1. **Token scope**: Adding to a GitHub Projects V2 board requires the `project` OAuth scope. The `RALPH_HERO_GITHUB_TOKEN` used by the MCP server has this scope, but a user's default `gh auth` token may not. Script should check and provide a helpful error message.

2. **`addSubIssue` GraphQL availability**: This is a GitHub Projects-era API. It should be available for any GitHub.com repo, but the script should handle the case where it's not (e.g., GitHub Enterprise with older API version).

3. **Idempotency edge cases**: If a previous run partially succeeded (umbrella created, 1 of 3 sub-issues created), the naive "check by label count" approach will skip re-creation but won't complete the partial setup. A more robust approach checks for the umbrella specifically by title.

4. **Project board not configured**: If `RALPH_GH_PROJECT_NUMBER` is not set or the project doesn't exist, the script should skip project board addition with a warning rather than failing entirely.

---

## Recommended Next Steps

1. Create `plugin/ralph-hero/scripts/demo-seed.sh` with the structure:
   - Header comment block (usage, description, env vars)
   - `set -euo pipefail`
   - Read `RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER` from env with defaults
   - Idempotency check: scan for open `ralph-demo` labeled issues
   - Create `ralph-demo` label if it doesn't exist
   - Create umbrella issue with `--label "ralph-demo"` → capture issue number
   - Create 3 sub-issues with `--label "ralph-demo"` → capture issue numbers
   - For each issue: `gh project item-add` (with graceful skip if project number is unset)
   - For each sub-issue: GraphQL `addSubIssue` to link to umbrella
   - Output all issue numbers to stdout (`echo "$UMBRELLA_NUMBER $SUB1 $SUB2 $SUB3"`)
   - Optionally write `.demo-issues` state file for cleanup script

2. No changes to MCP server code — this is pure shell script work.

3. The script should be executable (`chmod +x`) — this is likely handled by the implementation PR.

---

## Files Affected

### Will Modify
- `plugin/ralph-hero/scripts/demo-seed.sh` - New shell script (net-new file)

### Will Read (Dependencies)
- `plugin/ralph-hero/scripts/ralph-loop.sh` - Script conventions and pattern reference
- `plugin/ralph-hero/scripts/ralph-team-loop.sh` - Script conventions and pattern reference
- `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts` - `addSubIssue` GraphQL mutation reference
- `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts` - `addProjectV2ItemById` GraphQL reference
