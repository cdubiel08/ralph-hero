---
date: 2026-02-23
status: draft
github_issue: 374
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/374
primary_issue: 374
---

# docs(cli): Create docs/cli.md Documenting Doctor and Quick-* Recipes

## Overview

Single-issue plan to create `docs/cli.md` documenting the `doctor` utility recipe and all `quick-*` recipes that exist in the justfile but are missing from documentation.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-374 | Create docs/cli.md with doctor + quick-* recipes | XS |

## Current State Analysis

- `plugin/ralph-hero/justfile` contains `doctor` (lines 101-181) and 8 `quick-*` recipes (lines 267-324)
- `docs/` directory exists with one file (`cross-repo-routing.md`) - provides style reference
- Research audit (`thoughts/shared/research/2026-02-21-cli-docs-audit.md`) confirms these recipes are implemented but undocumented
- All `quick-*` recipes require mcptools (`mcp call`) for direct MCP server invocation (zero LLM cost)
- `doctor` is a standalone bash script checking env vars, dependencies, plugin files, and API connectivity

## Desired End State

### Verification
- [ ] `docs/cli.md` exists with a Utility Recipes section documenting `doctor`
- [ ] `docs/cli.md` has a Quick Actions section with all 8 `quick-*` recipes
- [ ] Each recipe entry includes: purpose, usage example, key parameters
- [ ] mcptools prerequisite note is present in Quick Actions section

## What We're NOT Doing

- Not documenting workflow recipes (`triage`, `research`, `plan`, `impl`, etc.) - those are covered elsewhere
- Not documenting orchestrator recipes (`hero`, `team`, `loop`)
- Not documenting setup recipes beyond `doctor` (`setup`, `install-cli`, `install-completions`, `completions`)
- Not creating man pages or structured CLI help beyond the markdown doc

## Implementation Approach

Single phase: create `docs/cli.md` with content derived from the justfile recipe definitions and research audit findings.

---

## Phase 1: Create docs/cli.md
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/374 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-cli-docs-audit.md

### Changes Required

#### 1. Create `docs/cli.md`
**File**: `docs/cli.md` (new)
**Changes**: Create documentation file with two main sections:

**Utility Recipes section**:
- `doctor` recipe: purpose (diagnose setup issues), usage (`just doctor`), what it checks (env vars, dependencies, plugin manifest, API connectivity), exit behavior (non-zero on errors)

**Quick Actions section**:
- Prerequisite callout: mcptools required, install instructions (`brew tap f/mcptools && brew install mcp`)
- Note that quick-* recipes use MCP tools directly (no LLM, instant, zero API cost)
- Document each recipe with purpose, usage example, and parameters:
  - `quick-status` — pipeline dashboard, `format` param
  - `quick-move` — move issue to state, `issue` + `state` params
  - `quick-pick` — find next actionable issue, `state` + `max-estimate` params
  - `quick-assign` — assign issue, `issue` + `user` params
  - `quick-issue` — create issue, `title` + optional `label`/`priority`/`estimate`/`state` params
  - `quick-info` — get issue details, `issue` param
  - `quick-comment` — add comment, `issue` + `body` params
  - `quick-draft` — create draft issue, `title` + optional `priority`/`estimate`/`state` params

### Success Criteria
- [x] Automated: `test -f docs/cli.md` exits 0
- [x] Automated: `grep -q "doctor" docs/cli.md` exits 0
- [x] Automated: `grep -c "quick-" docs/cli.md` returns >= 8 (all recipes mentioned)
- [x] Automated: `grep -q "mcptools" docs/cli.md` exits 0
- [x] Manual: Each recipe entry has purpose, usage example, and parameters

---

## File Ownership Summary

| File | Phase | Action |
|------|-------|--------|
| `docs/cli.md` | 1 | Create |

## Integration Testing
- [ ] `docs/cli.md` renders correctly as GitHub-flavored markdown
- [ ] All recipe names match exactly what's in the justfile

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-cli-docs-audit.md
- Justfile: `plugin/ralph-hero/justfile`
- Existing docs pattern: `docs/cross-repo-routing.md`
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/287
