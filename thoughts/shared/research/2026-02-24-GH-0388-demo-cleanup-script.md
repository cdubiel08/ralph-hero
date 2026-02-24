---
date: 2026-02-24
github_issue: 388
github_url: https://github.com/cdubiel08/ralph-hero/issues/388
status: complete
type: research
---

# GH-388: Create Demo Cleanup Script for Onboarding Showcase

## Problem Statement

The onboarding showcase demo creates temporary GitHub issues, sub-issues, and branches to demonstrate the ralph-hero plugin lifecycle end-to-end (see #310, #387). After each recording session (or a failed attempt), these demo artifacts pollute the real repository. Issue #388 tasks us with creating `plugin/ralph-hero/scripts/demo-cleanup.sh` — a teardown companion to `demo-seed.sh` (#387) that closes issues, deletes branches, archives project board items, and optionally hard-deletes issues.

The cleanup script must be safe, idempotent, and provide clear confirmation output so a human can verify what was torn down.

## Current State Analysis

### No Cleanup Script Exists

`plugin/ralph-hero/scripts/` currently contains five scripts:
- `ralph-cli.sh` — global CLI wrapper
- `ralph-completions.bash` / `ralph-completions.zsh` — shell completions
- `ralph-loop.sh` — autonomous pipeline loop
- `ralph-team-loop.sh` — multi-agent orchestrator

No `demo-cleanup.sh` exists. It must be created as a net-new script.

### Sibling Script Contract (demo-seed.sh, #387)

The seed script (`plugin/ralph-hero/scripts/demo-seed.sh`, created by #387) will:
- Create an umbrella issue and 3 XS sub-issues via `gh issue create`
- Link them as sub-issues (parent/child)
- Add them to the GitHub Project board
- Print created issue numbers to stdout

The cleanup script is designed to consume this output: it accepts issue numbers as CLI arguments (the numbers seed.sh prints) or falls back to auto-detection by label.

### Available gh CLI Patterns

The codebase uses `gh issue close` in existing plans and research:

```bash
gh issue close $ISSUE_NUMBER --repo "$OWNER/$REPO" --reason completed
```

This is the established pattern for closing issues (from `thoughts/shared/research/2026-02-20-GH-0177-parent-auto-advance-on-children-done.md`).

The `gh issue list --label` pattern is used in `plugin/ralph-hero/hooks/scripts/team-stop-gate.sh:32` to filter issues by label.

### MCP archive_item Tool

The `ralph_hero__archive_item` MCP tool archives project items:
```
ralph_hero__archive_item(number: <issue_number>)
```
Signature: `number` (issue number) OR `projectItemId` (PVTI_... node ID), optional `unarchive` flag.

However, since `demo-cleanup.sh` is a shell script (not an MCP skill), it should use the `gh` CLI directly rather than requiring MCP server access. The appropriate `gh api` or `gh project item-archive` commands should be used for project board archiving. The `gh project item-archive` subcommand is available in recent gh CLI versions.

### Branch Deletion Pattern

The issue specifies deleting `feature/demo-*` branches. The standard pattern in ralph-hero for branch cleanup is:

```bash
git push origin --delete feature/demo-NNN 2>/dev/null || true
git branch -d feature/demo-NNN 2>/dev/null || true
```

The `|| true` guards ensure failures (e.g., branch doesn't exist) don't abort the script.

### Hard Delete Consideration

GitHub's API supports issue deletion only via GraphQL with `deleteIssue` mutation — the REST API and `gh issue delete` require the `delete_repo` scope which is broader than needed. The `gh issue delete` CLI command does exist but prompts for confirmation without `--yes`. The `--hard` flag design must handle this gracefully.

## Key Discoveries

### File Path References

- `plugin/ralph-hero/scripts/ralph-loop.sh` — Script structure pattern (set -e, arg parsing, env var defaults)
- `plugin/ralph-hero/hooks/scripts/team-stop-gate.sh:32` — `gh issue list --label` pattern
- `plugin/ralph-hero/hooks/scripts/hook-utils.sh` — Utility functions (not needed by standalone script)
- `thoughts/shared/research/2026-02-20-GH-0177-parent-auto-advance-on-children-done.md` — `gh issue close --reason completed` pattern
- `thoughts/ideas/2026-02-21-showcase-demo-onboarding.md` — Original demo spec: seed template, issue structure
- `thoughts/shared/plans/2026-02-22-demo-recording-skills.md` — Demo recording plan context

### Script Header Convention

All existing scripts in `plugin/ralph-hero/scripts/` use:
```bash
#!/bin/bash
# <script-name>
# <description>
# Usage: ...
set -e
```

The cleanup script should follow `#!/bin/bash` (not `#!/usr/bin/env bash`) to match `ralph-loop.sh` and `ralph-team-loop.sh` conventions. However `ralph-cli.sh` uses `#!/usr/bin/env bash` with `set -euo pipefail`. The stricter form is preferable for new scripts.

### Auto-Detection by Label

The issue requires auto-detection by label when no issue numbers are provided as args. The `demo-seed.sh` script (per #387 acceptance criteria) adds a `demo` label to created issues. The cleanup script can query:
```bash
gh issue list --repo "$OWNER/$REPO" --label "demo" --state open --json number --jq '.[].number'
```

This is consistent with the `team-stop-gate.sh` pattern.

### Idempotency Requirements

The script must be idempotent:
- Closing an already-closed issue is a no-op (gh CLI handles gracefully)
- Deleting a non-existent branch produces an error that must be suppressed
- Archiving an already-archived project item is a no-op
- Deleting a non-existent issue produces an error that must be suppressed

All destructive commands should use `|| true` or explicit existence checks.

## Potential Approaches

### Option A: Pure gh CLI (Recommended)

Use only `gh` CLI commands — no MCP server dependency.

**For project board archiving**, use `gh project item-list` + `gh project item-archive`:
```bash
# Get project item ID for the issue
ITEM_ID=$(gh project item-list "$PROJECT_NUMBER" --owner "$OWNER" \
  --format json | jq -r ".items[] | select(.content.number == $ISSUE_NUM) | .id")
# Archive it
gh project item-archive "$PROJECT_NUMBER" --owner "$OWNER" --id "$ITEM_ID"
```

**Pros**: Self-contained, no MCP server required, works in any shell context
**Cons**: `gh project item-archive` may not exist in all gh CLI versions (added in gh v2.x). Need version guard.

### Option B: MCP Tool for Archive + gh CLI for rest

Use `ralph_hero__archive_item` for project archiving (via MCP), `gh issue close` and git for the rest.

**Pros**: Leverages existing tested MCP tool
**Cons**: Script becomes dependent on MCP server being configured and running — not suitable for a standalone shell script

### Option C: Pure gh CLI with GraphQL fallback

Use `gh project item-archive` with fallback to `gh api graphql -f query='mutation { archiveProjectV2Item(...) }'` if the subcommand is unavailable.

**Pros**: Handles older gh CLI versions
**Cons**: More complex script

**Recommendation**: Option A (pure gh CLI). Version-check `gh` at script startup and document the minimum required version. This keeps the script portable and independent.

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `gh project item-archive` not available in user's gh version | Medium | Add version check at startup; document min version requirement (gh >= 2.31) |
| `gh issue delete --yes` scope issue | Low | `--hard` flag documents that `delete_repo` scope is needed; closes as default behavior |
| Auto-detection picks up non-demo issues | Low | Strict `demo` label filter; print list before proceeding |
| Script deletes wrong branches | Low | `feature/demo-*` glob is specific; only act on issues passed as args or found by label |
| Seed script hasn't run (nothing to clean) | Low | Idempotency handles this gracefully; script reports "nothing to clean" |
| Race condition: PR open on demo branch | Medium | Check for open PRs before deleting branch; skip with warning |

## Recommended Next Steps

1. **Implement** `plugin/ralph-hero/scripts/demo-cleanup.sh` with:
   - `#!/usr/bin/env bash` + `set -euo pipefail`
   - Argument parsing: issue numbers as positional args OR `--hard` flag
   - Auto-detection fallback: `gh issue list --label "demo" --state open`
   - Pre-flight: print list of issues to be cleaned and confirm (or use `--yes` to skip)
   - Close all issues: `gh issue close $N --repo "$OWNER/$REPO" --reason completed`
   - Delete branches: `git push origin --delete feature/demo-$N 2>/dev/null || true`
   - Archive from project board: `gh project item-archive` with version guard
   - `--hard` flag: `gh issue delete $N --yes` for full deletion
   - Summary output: confirmation table of actions taken

2. **Verify** the interface contract with #387: cleanup script must accept the issue numbers that seed script prints to stdout (pipe-compatible: `./demo-seed.sh | ./demo-cleanup.sh` should work)

3. **Add `demo` label** handling: if seed script uses a `demo` label, cleanup auto-detects without needing explicit issue numbers

## Group Context

This issue is part of a 4-issue group under parent #310:

| # | Title | Order |
|---|-------|-------|
| #387 | Create demo seed script | 1 (primary) |
| **#388** | **Create demo cleanup script** | **2 (this issue)** |
| #389 | Record annotated showcase demo | 3 |
| #390 | Add onboarding demo section to README/wiki | 4 |

**Dependency analysis**: #388 is logically dependent on #387 being complete — the cleanup script's primary usage is to clean up what the seed script creates. However, since both are standalone scripts with no shared code, they can be implemented in parallel. The interface contract (issue numbers as positional args, `demo` label for auto-detection) must be consistent.

**Implementation order recommendation**: #387 first (establishes the label name, issue structure, and output format), then #388. No code changes are needed to implement #388 independently if the label name (`demo`) is assumed stable.

## Files Affected

### Will Modify
- `plugin/ralph-hero/scripts/demo-cleanup.sh` - New script: closes demo issues, deletes branches, archives project items, supports --hard flag for full deletion

### Will Read (Dependencies)
- `plugin/ralph-hero/scripts/ralph-loop.sh` - Script header/arg-parsing pattern reference
- `plugin/ralph-hero/scripts/ralph-team-loop.sh` - Script structure reference
- `plugin/ralph-hero/hooks/scripts/team-stop-gate.sh` - `gh issue list --label` pattern reference
