# Design: Remove artifact-metadata-validator hook

**Date:** 2026-03-06
**Issue:** #542 — Plan/research creation blocked when no GitHub issue exists yet

## Problem

`artifact-metadata-validator.sh` hard-blocks (exit 2) writing any file to `thoughts/shared/{research,plans,reviews,reports}/` unless the filename contains `GH-NNNN` and frontmatter includes `github_issue`/`github_issues`. This prevents the interactive plan/research flow where you think first and ticket later.

The hook has never caught a real problem — naming conventions are followed via skill prompts, not enforcement.

## Decision

Remove the validator entirely. Add rename-on-link to interactive skills so downstream glob-based hooks (`artifact-discovery.sh`, `impl-plan-required.sh`) continue to work.

## Changes

### 1. Remove artifact-metadata-validator

- Delete `plugin/ralph-hero/hooks/scripts/artifact-metadata-validator.sh`
- Remove the Write matcher block from `plugin/ralph-hero/hooks/hooks.json` (lines 109-117)

### 2. Update plan skill — rename on link (Step 6)

In `plugin/ralph-hero/skills/plan/SKILL.md`, update Step 6 (GitHub Integration) to rename the file when linking to an issue:

```
2026-03-06-improve-error-handling.md
  -> 2026-03-06-GH-0542-improve-error-handling.md
```

Use `Bash(mv old new)` then update frontmatter and post artifact comment with the new path.

### 3. Update research skill — rename on link (Step 8)

Same rename-on-link pattern in `plugin/ralph-hero/skills/research/SKILL.md` Step 8.

## What stays unchanged

- `artifact-discovery.sh` — glob discovery works (renamed files have GH-NNNN)
- `impl-plan-required.sh` — glob works after rename
- `plan-research-required.sh` — extracts GH from path; allows if absent (line 28)
- Autonomous skills (`ralph-plan`, `ralph-research`) — always start from an issue, always create GH-NNNN filenames
- `specs/artifact-metadata.md` — naming conventions remain documented

## Alternatives considered

- **Warn-only**: Downgrade to warning instead of block. Rejected: warning fatigue.
- **Draft pattern**: Accept `YYYY-MM-DD-draft-{slug}.md`. Rejected: introduces a rename workflow nobody will remember.
- **Accept the gap**: Don't rename. Rejected: interactive plans regularly flow into autonomous implementation.
