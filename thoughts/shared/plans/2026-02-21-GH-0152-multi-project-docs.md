---
date: 2026-02-21
status: draft
github_issue: 152
github_url: https://github.com/cdubiel08/ralph-hero/issues/152
primary_issue: 152
---

# GH-152: Document Multi-Project Configuration in CLAUDE.md

## Overview

Single issue implementation: GH-152 -- Add multi-project configuration documentation to CLAUDE.md.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-152 | Document multi-project configuration in CLAUDE.md | XS |

## Current State Analysis

- Multi-project infrastructure fully shipped: #144 (cache/config), #150 (config parsing), #151 (tool overrides) -- all CLOSED
- `CLAUDE.md` env var table (lines 84-92) lists 7 variables; `RALPH_GH_PROJECT_NUMBERS` is missing
- No multi-project configuration example exists
- No documentation of how single-project vs multi-project modes interact
- The `projectNumber` per-call override is self-documenting in tool descriptions (no per-tool docs needed)

## Desired End State

### Verification
- [x] `RALPH_GH_PROJECT_NUMBERS` row added to env var table
- [x] Multi-project example block added after existing single-project example
- [x] "Multi-Project Configuration" subsection added after env var table
- [x] No code changes -- docs only

## What We're NOT Doing

- Not modifying `.mcp.json` (multi-project config belongs in `settings.local.json`)
- Not documenting internal implementation details (`resolveFullConfig`, `FieldOptionCache` keying)
- Not documenting per-tool `projectNumber` parameter (self-documenting in tool descriptions)
- Not adding a separate docs file -- all changes go in the existing `CLAUDE.md`

## Implementation Approach

Three targeted edits to `CLAUDE.md`: one new env var row, one example block, one subsection. Total ~20 lines added.

---

## Phase 1: GH-152 -- Document multi-project configuration
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/152 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0152-multi-project-docs.md

### Changes Required

#### 1. Add `RALPH_GH_PROJECT_NUMBERS` to env var table
**File**: `CLAUDE.md`
**Where**: After the `RALPH_GH_PROJECT_NUMBER` row (line 89), before `RALPH_GH_REPO_TOKEN`

Add one row:
```markdown
| `RALPH_GH_PROJECT_NUMBERS` | No | `settings.local.json` | Comma-separated project numbers for cross-project dashboard (e.g., `"3,5,7"`) |
```

#### 2. Add multi-project example block
**File**: `CLAUDE.md`
**Where**: After the existing `settings.local.json` example (after line 80), before the "Do NOT put tokens" warning

Add labeled example:
```markdown
For multi-project setups (cross-project dashboard, multiple boards):

```json
{
  "env": {
    "RALPH_HERO_GITHUB_TOKEN": "ghp_xxx",
    "RALPH_GH_OWNER": "cdubiel08",
    "RALPH_GH_REPO": "ralph-hero",
    "RALPH_GH_PROJECT_NUMBER": "3",
    "RALPH_GH_PROJECT_NUMBERS": "3,5,7"
  }
}
```
```

#### 3. Add "Multi-Project Configuration" subsection
**File**: `CLAUDE.md`
**Where**: After the env var table footnote (after line 94), before "### Key Implementation Details"

Add subsection:
```markdown
### Multi-Project Configuration

Ralph supports managing multiple GitHub Projects V2 boards from a single instance:

- **`RALPH_GH_PROJECT_NUMBER`** remains the default/primary project for all tools
- **`RALPH_GH_PROJECT_NUMBERS`** (comma-separated) enables cross-project aggregation -- the `pipeline_dashboard` tool auto-aggregates across all listed projects
- **Per-call override**: All project-aware tools accept an optional `projectNumber` parameter to target a specific project, regardless of defaults
- Single-project mode (no `RALPH_GH_PROJECT_NUMBERS`) continues to work unchanged
```

### File Ownership

| File | Owner |
|------|-------|
| `CLAUDE.md` | GH-152 (env var row + example + subsection) |

### Success Criteria

#### Automated Verification
- [x] No build/test impact (docs-only change)

#### Manual Verification
- [x] `RALPH_GH_PROJECT_NUMBERS` appears in env var table with correct description
- [x] Multi-project example block shows all 5 env vars including `RALPH_GH_PROJECT_NUMBERS`
- [x] Subsection explains single vs multi-project modes and per-call override
- [x] Existing documentation is unchanged (no regressions)

---

## Testing Strategy

1. **Manual review**: Read through the updated CLAUDE.md to verify formatting, accuracy, and flow
2. **No automated tests**: Docs-only change has no test impact

## References

- [Issue #152](https://github.com/cdubiel08/ralph-hero/issues/152)
- [Research document](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0152-multi-project-docs.md)
- [Parent issue #103: Multi-project environment configuration](https://github.com/cdubiel08/ralph-hero/issues/103)
- Closed siblings: [#144](https://github.com/cdubiel08/ralph-hero/issues/144) (config/cache), [#150](https://github.com/cdubiel08/ralph-hero/issues/150) (config parsing), [#151](https://github.com/cdubiel08/ralph-hero/issues/151) (tool overrides)
