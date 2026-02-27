---
date: 2026-02-27
status: draft
github_issues: [457]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/457
primary_issue: 457
---

# Update Docs and Clean Up Empty Source Files — Atomic Implementation Plan

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-457 | Update docs, clean up empty source files | XS |

## Current State Analysis

After Phases 1-5 (GH-452 through GH-456), the MCP toolspace has been consolidated from 53 to 26 tools. Skills, agents, and justfile references were updated in Phase 5 (GH-456). What remains is updating the project's `CLAUDE.md` documentation to reflect the new tool surface and verifying that prior phases left no orphans.

**Stale references found in `CLAUDE.md`** (128 lines total):

| Line | Content | Issue |
|------|---------|-------|
| 28 | `└── view-tools.ts` in structure tree | File deleted by Phase 4 (GH-455) |
| 24 | `issue-tools.ts  # Issue CRUD + workflow state + estimates` | Description stale — now also has `save_issue` |
| 26 | `project-management-tools.ts  # Archive, remove, add, link, clear` | Most tools removed; now has `archive_items` + `create_status_update` |
| 109 | `link_repository` reference in RALPH_GH_REPO footnote | Tool removed by Phase 4 |
| 126 | `update_workflow_state` and `advance_children` in Status sync | Replaced by `save_issue` and `advance_issue` |
| 127 | Lists 5 removed tools: `archive_item`, `remove_from_project`, `add_to_project`, `link_repository`, `clear_field` | All removed by Phases 2/4 |

## Desired End State

- `CLAUDE.md` accurately describes the post-consolidation 26-tool surface
- Structure tree reflects actual source files (no `view-tools.ts`, `sync-tools.ts`, `routing-tools.ts`)
- Key Implementation Details section uses current tool names
- No stale tool names remain in any `.md` documentation file
- `npm test` and `npm run build` pass (no source changes, just verification)

### Verification
- [ ] `CLAUDE.md` structure tree matches actual `src/tools/` directory listing
- [ ] No removed tool names appear in `CLAUDE.md`
- [ ] `npm run build` passes (verification only)
- [ ] `npm test` passes (verification only)

## What We're NOT Doing

- Modifying source code (all source changes done in Phases 1-5)
- Updating skills/agents/justfile (done in Phase 5, GH-456)
- Writing new tests (no code changes to test)

## Implementation Approach

Pure documentation update. Edit `CLAUDE.md` to reflect the consolidated toolspace, then run verification commands to confirm no stale references remain anywhere.

---

## Phase 1: GH-457 — Update docs, clean up empty source files

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/457

### Changes Required

#### 1. Update structure tree in CLAUDE.md
**File**: `CLAUDE.md`
**Lines**: 23-28
**Changes**: Update the `tools/` directory listing to reflect actual files after consolidation:

Replace:
```
│       │   ├── tools/              # MCP tool implementations
│       │   │   ├── issue-tools.ts  # Issue CRUD + workflow state + estimates
│       │   │   ├── project-tools.ts
│       │   │   ├── project-management-tools.ts  # Archive, remove, add, link, clear
│       │   │   ├── relationship-tools.ts
│       │   │   └── view-tools.ts
```

With:
```
│       │   ├── tools/              # MCP tool implementations
│       │   │   ├── issue-tools.ts  # Issue CRUD, save_issue, get_issue
│       │   │   ├── project-tools.ts  # setup_project, get_project
│       │   │   ├── project-management-tools.ts  # archive_items, create_status_update
│       │   │   ├── relationship-tools.ts  # Sub-issues, dependencies, advance_issue
│       │   │   ├── batch-tools.ts  # batch_update
│       │   │   └── dashboard-tools.ts  # pipeline_dashboard, detect_stream_positions, project_hygiene
```

**Note**: Verify actual files in `src/tools/` before writing — other tool files like `batch-tools.ts` and `dashboard-tools.ts` should be listed if they exist. Check with `ls plugin/ralph-hero/mcp-server/src/tools/*.ts`.

#### 2. Update RALPH_GH_REPO footnote
**File**: `CLAUDE.md`
**Line**: 109
**Changes**: Replace `link_repository` reference with current mechanism:

Replace:
```
†`RALPH_GH_REPO` is inferred from the repositories linked to the project via `link_repository`. Only set it explicitly as a tiebreaker when multiple repos are linked. Bootstrap: `setup_project` → `link_repository` → repo is inferred. See #23.
```

With:
```
†`RALPH_GH_REPO` is inferred from the repositories linked to the project. Only set it explicitly as a tiebreaker when multiple repos are linked. Bootstrap: `setup_project` → link repo via `gh` CLI → repo is inferred. See #23.
```

#### 3. Update Status sync documentation
**File**: `CLAUDE.md`
**Line**: 126
**Changes**: Replace stale tool names with current equivalents:

Replace:
```
- **Status sync (one-way)**: `update_workflow_state` automatically syncs the default Status field (Todo/In Progress/Done) based on `WORKFLOW_STATE_TO_STATUS` mapping in `workflow-states.ts`. The sync is best-effort: if the Status field is missing or has custom options, the sync silently skips. Mapping: queue states -> Todo, lock/active states -> In Progress, terminal states -> Done. `batch_update` and `advance_children` also sync Status.
```

With:
```
- **Status sync (one-way)**: `save_issue` automatically syncs the default Status field (Todo/In Progress/Done) based on `WORKFLOW_STATE_TO_STATUS` mapping in `workflow-states.ts` when setting `workflowState`. The sync is best-effort: if the Status field is missing or has custom options, the sync silently skips. Mapping: queue states -> Todo, lock/active states -> In Progress, terminal states -> Done. `batch_update` and `advance_issue` also sync Status.
```

#### 4. Update Project management tools documentation
**File**: `CLAUDE.md`
**Line**: 127
**Changes**: Replace stale tool listing with current tools:

Replace:
```
- **Project management tools**: 5 tools in `project-management-tools.ts` for project operations: `archive_item`, `remove_from_project`, `add_to_project`, `link_repository`, `clear_field`. See `thoughts/shared/research/2026-02-18-GH-0066-github-projects-v2-docs-guidance.md` for full tool reference and setup guide.
```

With:
```
- **Project management tools**: `project-management-tools.ts` contains `archive_items` (single + bulk archiving) and `create_status_update`. See `thoughts/shared/research/2026-02-18-GH-0066-github-projects-v2-docs-guidance.md` for full tool reference and setup guide.
```

#### 5. Verify source file cleanup from prior phases
**Commands** (verification only, no changes expected):

```bash
# Verify deleted files don't exist
ls plugin/ralph-hero/mcp-server/src/tools/sync-tools.ts 2>&1    # Should: No such file
ls plugin/ralph-hero/mcp-server/src/tools/routing-tools.ts 2>&1  # Should: No such file
ls plugin/ralph-hero/mcp-server/src/tools/view-tools.ts 2>&1     # Should: No such file

# Verify index.ts has no orphan imports
grep -n "sync-tools\|routing-tools\|view-tools" plugin/ralph-hero/mcp-server/src/index.ts
# Should return empty

# Verify no stale tool names in CLAUDE.md after edits
grep -i "update_workflow_state\|update_estimate\|update_priority\|update_issue\|clear_field\|archive_item\|advance_children\|advance_parent\|list_dependencies\|detect_group\|detect_pipeline_position\|check_convergence\|list_project_items\|detect_work_streams\|remove_from_project\|add_to_project\|link_repository\|link_team\|configure_routing\|sync_across_projects\|update_field_options" CLAUDE.md
# Should return empty
```

#### 6. Final build verification
```bash
cd plugin/ralph-hero/mcp-server
npm run build
npm test
```

### Success Criteria

#### Automated Verification:
- [x] `npm run build` passes
- [x] `npm test` passes
- [x] `grep` for removed tool names in `CLAUDE.md` returns empty
- [x] Deleted source files (`sync-tools.ts`, `routing-tools.ts`, `view-tools.ts`) don't exist
- [x] No orphan imports in `index.ts`

#### Manual Verification:
- [ ] `CLAUDE.md` structure tree matches `ls plugin/ralph-hero/mcp-server/src/tools/`
- [ ] Key Implementation Details section references only current tool names
- [ ] RALPH_GH_REPO footnote makes sense without `link_repository` tool

**Implementation Note**: This is a documentation-only phase. The builder should verify that prior phases actually completed the source cleanup before relying on it. If any source cleanup was missed, include it in this PR.

---

## Key Implementation Notes

1. **Verify before editing**: The builder should `ls plugin/ralph-hero/mcp-server/src/tools/` to get the actual file list before updating the structure tree. Prior phases may have left additional files not listed here (e.g., `batch-tools.ts`, `dashboard-tools.ts`, `draft-issue-tools.ts`).

2. **No source code changes**: This phase only touches `CLAUDE.md`. If the builder discovers that prior phases missed deleting a file or removing an import, include that cleanup in this PR and note it in the PR description.

3. **Structure tree accuracy**: The tree in `CLAUDE.md` should list all `.ts` files in `src/tools/` with brief descriptive comments. Don't list every tool — just enough context to orient developers.

4. **Research doc reference**: Line 127's reference to `thoughts/shared/research/2026-02-18-GH-0066-github-projects-v2-docs-guidance.md` should be preserved — it's still a valid reference for project setup guidance.

## References

- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/451
- Parent plan: `thoughts/shared/plans/2026-02-27-mcp-toolspace-consolidation.md` Phase 6
- `CLAUDE.md`: project root
- Final 26-tool inventory: parent plan lines 666-708
