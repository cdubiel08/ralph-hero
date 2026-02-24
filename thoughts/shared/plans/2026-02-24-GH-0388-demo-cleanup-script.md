---
date: 2026-02-24
status: draft
github_issues: [388]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/388
primary_issue: 388
---

# GH-388: Create Demo Cleanup Script - Atomic Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-388 | Create demo cleanup script for onboarding showcase | XS |

## Current State Analysis

No cleanup script exists in `plugin/ralph-hero/scripts/`. The sibling `demo-seed.sh` (#387) creates demo issues with a `demo` label, prints issue numbers to stdout, and the cleanup script must consume that output. The cleanup script is a net-new file with no existing code to modify.

Existing script conventions are well-established:
- `ralph-cli.sh` uses `#!/usr/bin/env bash` + `set -euo pipefail` (stricter, preferred for new scripts)
- `ralph-loop.sh` uses `#!/bin/bash` + `set -e` with `case`-based arg parsing
- `team-stop-gate.sh` demonstrates `gh issue list --label` pattern for label-based filtering

## Desired End State

### Verification
- [x] `plugin/ralph-hero/scripts/demo-cleanup.sh` exists and is executable
- [x] Script closes umbrella issue and all sub-issues via `gh issue close`
- [x] Script deletes demo branches (`feature/demo-*`) via `git push origin --delete`
- [x] Script archives issues from the project board via `gh project item-archive`
- [x] Script accepts issue numbers as CLI positional args
- [x] Script auto-detects demo issues by `demo` label when no args provided
- [x] `--hard` flag enables full deletion via `gh issue delete --yes`
- [x] Script prints a confirmation summary on completion
- [x] Script is idempotent (safe to run multiple times)
- [x] Script is pipe-compatible with `demo-seed.sh` output

## What We're NOT Doing
- Modifying `demo-seed.sh` or any other existing script
- Adding MCP server dependency (pure `gh` CLI approach)
- Adding tests (XS scope; the script is a simple shell wrapper around `gh` commands)
- Creating demo issues (handled by `demo-seed.sh`)
- GraphQL fallback for `gh project item-archive` (document min version instead)

## Implementation Approach

Single phase: create the new script following established conventions. The script has four logical stages executed in order: (1) resolve target issues, (2) close issues, (3) delete branches, (4) archive from project board. The `--hard` flag adds a fifth stage: delete issues entirely.

---

## Phase 1: Create `demo-cleanup.sh`
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/388 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-24-GH-0388-demo-cleanup-script.md

### Changes Required

#### 1. Create `plugin/ralph-hero/scripts/demo-cleanup.sh`
**File**: `plugin/ralph-hero/scripts/demo-cleanup.sh` (new)
**Changes**: Create the complete cleanup script with the following structure:

**Header & strict mode**:
```bash
#!/usr/bin/env bash
# demo-cleanup.sh -- tear down demo environment after onboarding showcase
# Usage: ./demo-cleanup.sh [--hard] [--yes] [ISSUE_NUMBER ...]
#        ./demo-seed.sh | ./demo-cleanup.sh  (pipe mode)
set -euo pipefail
```

Follow `ralph-cli.sh` convention (`#!/usr/bin/env bash` + `set -euo pipefail`) as the stricter form preferred for new scripts per research findings.

**Environment defaults**:
```bash
OWNER="${RALPH_GH_OWNER:-cdubiel08}"
REPO="${RALPH_GH_REPO:-ralph-hero}"
PROJECT_NUMBER="${RALPH_GH_PROJECT_NUMBER:-3}"
```

Pattern: match `ralph-loop.sh` env-var-with-defaults style.

**Argument parsing**:
- `--hard` flag: enable full issue deletion after closing
- `--yes` flag: skip confirmation prompt
- Positional args: issue numbers to clean up
- Stdin detection: if no positional args and stdin is not a TTY, read issue numbers from stdin (pipe compatibility with `demo-seed.sh`)
- Fallback: if no args and no stdin, auto-detect via `gh issue list --repo "$OWNER/$REPO" --label "demo" --state open --json number --jq '.[].number'`

Pattern: `case`-based arg parsing from `ralph-loop.sh`.

**Pre-flight confirmation**:
- Print list of issue numbers that will be cleaned
- If `--yes` not set, prompt for confirmation (`read -r -p "Proceed? [y/N] "`)
- If no issues found, print "Nothing to clean up." and exit 0

**Stage 1 -- Close issues**:
```bash
for num in "${ISSUES[@]}"; do
  gh issue close "$num" --repo "$OWNER/$REPO" --reason completed 2>/dev/null || true
  echo "  Closed #$num"
done
```

Pattern: `gh issue close --reason completed` from existing research docs. `|| true` for idempotency (already-closed issues).

**Stage 2 -- Delete demo branches**:
```bash
for num in "${ISSUES[@]}"; do
  git push origin --delete "feature/demo-$num" 2>/dev/null || true
done
```

Also glob-delete any `feature/demo-*` branches on the remote:
```bash
for branch in $(git ls-remote --heads origin 'refs/heads/feature/demo-*' | awk '{print $2}' | sed 's|refs/heads/||'); do
  git push origin --delete "$branch" 2>/dev/null || true
  echo "  Deleted branch $branch"
done
```

Pattern: branch deletion with `|| true` guard from research findings.

**Stage 3 -- Archive from project board**:
```bash
for num in "${ISSUES[@]}"; do
  ITEM_ID=$(gh project item-list "$PROJECT_NUMBER" --owner "$OWNER" \
    --format json 2>/dev/null | jq -r ".items[] | select(.content.number == $num) | .id" 2>/dev/null || echo "")
  if [[ -n "$ITEM_ID" ]]; then
    gh project item-archive "$PROJECT_NUMBER" --owner "$OWNER" --id "$ITEM_ID" 2>/dev/null || true
    echo "  Archived #$num from project board"
  fi
done
```

Pattern: `gh project item-list` + `gh project item-archive` from research Option A.

**Stage 4 (conditional) -- Hard delete**:
Only runs when `--hard` flag is set:
```bash
if [[ "$HARD_DELETE" == true ]]; then
  for num in "${ISSUES[@]}"; do
    gh issue delete "$num" --repo "$OWNER/$REPO" --yes 2>/dev/null || true
    echo "  Deleted #$num"
  done
fi
```

**Summary output**:
Print a completion summary:
```
========================================
  Demo Cleanup Complete
========================================
Issues closed: N
Branches deleted: N
Board items archived: N
Issues deleted: N  (only if --hard)
```

Track counts via counter variables incremented in each stage.

**Make executable**:
```bash
chmod +x plugin/ralph-hero/scripts/demo-cleanup.sh
```

### Success Criteria
- [x] Automated: `bash -n plugin/ralph-hero/scripts/demo-cleanup.sh` passes (syntax check)
- [x] Automated: `shellcheck plugin/ralph-hero/scripts/demo-cleanup.sh` passes (if shellcheck available)
- [x] Manual: `./demo-cleanup.sh --help` or no-args-no-stdin prints usage
- [ ] Manual: `echo "42 43 44" | ./demo-cleanup.sh --yes` processes piped input
- [ ] Manual: `./demo-cleanup.sh --hard --yes 42 43` closes, archives, and deletes issues 42 and 43
- [ ] Manual: Running the script twice on the same issues produces no errors (idempotency)

---

## Integration Testing
- [ ] Pipe integration: `./demo-seed.sh | ./demo-cleanup.sh --yes` creates and immediately tears down demo environment
- [ ] Auto-detection: Run `./demo-seed.sh`, then `./demo-cleanup.sh --yes` (no args) detects issues by `demo` label
- [ ] Hard delete: `./demo-seed.sh | ./demo-cleanup.sh --hard --yes` leaves no trace of demo issues

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-24-GH-0388-demo-cleanup-script.md
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/310
- Sibling (seed script): https://github.com/cdubiel08/ralph-hero/issues/387
- Script conventions: `plugin/ralph-hero/scripts/ralph-cli.sh`, `plugin/ralph-hero/scripts/ralph-loop.sh`
- Label filter pattern: `plugin/ralph-hero/hooks/scripts/team-stop-gate.sh:32`
