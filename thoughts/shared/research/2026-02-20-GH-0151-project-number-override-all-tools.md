---
date: 2026-02-20
github_issue: 151
github_url: https://github.com/cdubiel08/ralph-hero/issues/151
status: complete
type: research
---

# GH-151: Add `projectNumber` Override Parameter to All Project-Aware Tools

## Problem Statement

After GH-150 extends `resolveFullConfig` to accept an optional `projectNumber` from args, tools still need their Zod schemas updated to expose this parameter. Currently 16+ tools interact with a project but hardcode the configured project number. Multi-project workflows (cross-project dashboards, syncing across projects) need per-call project targeting.

## Current State Analysis

### Tool Categorization

Tools fall into 4 categories based on how they resolve the project number:

#### Category A: Uses `resolveFullConfig` (14 tools) -- Mechanical change

These tools already call `resolveFullConfig(client, args)`. Once GH-150 adds `projectNumber` to the args type, the only change needed is adding `projectNumber: z.coerce.number().optional()` to each tool's Zod schema.

| # | Tool | File | Line | Notes |
|---|------|------|------|-------|
| 1 | `list_issues` | `issue-tools.ts` | 51 | Schema at line 51-161, `resolveFullConfig` at line 174 |
| 2 | `create_issue` | `issue-tools.ts` | 720 | Schema at line 720-745, `resolveFullConfig` at line 748 |
| 3 | `update_workflow_state` | `issue-tools.ts` | 1044 | Schema at line 1044-1069, `resolveFullConfig` at line 1072 |
| 4 | `update_estimate` | `issue-tools.ts` | 1139 | Schema at line 1139-1153, `resolveFullConfig` at line 1156 |
| 5 | `update_priority` | `issue-tools.ts` | 1193 | Schema at line 1193-1207, `resolveFullConfig` at line 1210 |
| 6 | `detect_pipeline_position` | `issue-tools.ts` | 1309 | Schema at line 1309-1322, `resolveFullConfig` at line 1325 |
| 7 | `check_convergence` | `issue-tools.ts` | 1381 | Schema at line 1381-1397, `resolveFullConfig` at line 1409 |
| 8 | `pick_actionable_issue` | `issue-tools.ts` | 1516 | Schema at line 1516-1538, `resolveFullConfig` at line 1563 |
| 9 | `archive_item` | `project-management-tools.ts` | 44 | Schema at line 44-53, `resolveFullConfig` at line 56 |
| 10 | `remove_from_project` | `project-management-tools.ts` | 117 | Schema at line 117-124, `resolveFullConfig` at line 127 |
| 11 | `add_to_project` | `project-management-tools.ts` | 178 | Schema at line 178-185, `resolveFullConfig` at line 191 |
| 12 | `link_repository` | `project-management-tools.ts` | 247 | Schema at line 247-256, `resolveFullConfig` at line 259 |
| 13 | `clear_field` | `project-management-tools.ts` | 341 | Schema at line 341-349, `resolveFullConfig` at line 352 |
| 14 | `batch_update` | `batch-tools.ts` | ~238 | Uses `resolveFullConfig` |

Additional tools in `project-management-tools.ts` that use `resolveFullConfig` but were not listed in the issue:
- `create_draft_issue` (line 409) -- uses `resolveFullConfig` at line 423
- `update_draft_issue` (line 483) -- uses `resolveFullConfig` at line 499
- `reorder_item` (line 537) -- uses `resolveFullConfig` at line 549
- `update_project` (line 607) -- uses `resolveFullConfig` at line 661
- `delete_field` (line 699) -- uses `resolveFullConfig` at line 722
- `update_collaborators` (line 783) -- uses `resolveFullConfig` at line 803
- `create_status_update` (line 904) -- uses `resolveFullConfig` at line 921
- `update_status_update` (line 990) -- uses `resolveFullConfig` at line 1017
- `delete_status_update` (line 1083) -- uses `resolveFullConfig` at line 1093
- `bulk_archive` (line 1129) -- uses `resolveFullConfig` at line 1149
- `link_team` (line 1267) -- uses `resolveFullConfig` at line 1280

**Total `resolveFullConfig` call sites: ~25** (more than the 14 listed in GH-150 research -- that was an earlier count). All benefit from the same mechanical schema addition.

#### Category B: Uses `resolveConfig` only (no project interaction) -- No change needed

These tools don't interact with projects, only issues. They use `resolveConfig(client, args)` which returns `{ owner, repo }` only. No `projectNumber` override is needed.

| Tool | File | Notes |
|------|------|-------|
| `get_issue` | `issue-tools.ts:424` | Uses `resolveConfig` + reads `client.config.projectNumber` directly for filtering `projectItems` |
| `update_issue` | `issue-tools.ts:934` | Uses `resolveConfig` only, no project fields |
| `create_comment` | `issue-tools.ts:1247` | Uses `resolveConfig` only, no project fields |
| `add_sub_issue` | `relationship-tools.ts:47` | Uses `resolveConfig` only |
| `list_sub_issues` | `relationship-tools.ts:127` | Uses `resolveConfig` only |
| `add_dependency` | `relationship-tools.ts:231` | Uses `resolveConfig` only |
| `remove_dependency` | `relationship-tools.ts:309` | Uses `resolveConfig` only |
| `list_dependencies` | `relationship-tools.ts:381` | Uses `resolveConfig` only |
| `detect_group` | `relationship-tools.ts:486` | Uses `resolveConfig` only |

**Exception: `get_issue`** reads `client.config.projectNumber` directly at line 448 to filter `projectItems`. This is a special case -- see Key Discoveries section.

#### Category C: Manual inline resolution -- Needs refactoring

Two tools manually resolve project config instead of using `resolveFullConfig`:

| Tool | File | Lines | Current Pattern |
|------|------|-------|----------------|
| `advance_children` | `relationship-tools.ts` | 549-563 | `resolveConfig` + manual `client.config.projectNumber` + `resolveProjectOwner` |
| `advance_parent` | `relationship-tools.ts` | 731-746 | Identical manual pattern |

These should be refactored to use `resolveFullConfig(client, args)` instead, which would automatically give them the override.

#### Category D: Already has override -- No change needed

Four tools in `project-tools.ts` and `view-tools.ts` already accept a `number` param for project override:

| Tool | File | Param |
|------|------|-------|
| `get_project` | `project-tools.ts:316` | `number: z.number().optional()` |
| `list_project_items` | `project-tools.ts:392` | `number: z.number().optional()` |
| `list_views` | `view-tools.ts:39` | `number: z.number().optional()` |
| `update_field_options` | `view-tools.ts:126` | `number: z.number().optional()` |

These use `number` (not `projectNumber`) because they don't have an issue-number `number` param. They bypass `resolveFullConfig` with their own inline resolution. Naming alignment to `projectNumber` is a nice-to-have but not required for this issue.

### `get_issue` Special Case

`get_issue` (issue-tools.ts:424-715) uses `resolveConfig` (not `resolveFullConfig`) because it's primarily a repo-level operation. However, it reads `client.config.projectNumber` at line 448 to filter `projectItems`:

```typescript
const projectNumber = client.config.projectNumber;
// ...
const projectItem = projectNumber
  ? issue.projectItems.nodes.find(
      (pi) => pi.project.number === projectNumber,
    )
  : issue.projectItems.nodes[0];
```

To support multi-project, this should accept a `projectNumber` override: `args.projectNumber ?? client.config.projectNumber`. This is a minor change within the handler, not requiring `resolveFullConfig` (since the tool doesn't call `ensureFieldCache` or other project helpers).

## Key Discoveries

### 1. True Tool Count Is ~28, Not 16

The issue title says "16 tools" but the actual count of tools using `resolveFullConfig` is ~25. Adding `get_issue` (Category B special case) and the 2 `advance_*` tools (Category C), the total is ~28 tools that need attention. However, the mechanical change pattern is identical for all -- add one schema field.

### 2. The Change Per Tool Is Truly Mechanical

For every Category A tool, the change is:
```typescript
// Add to schema:
projectNumber: z.coerce.number().optional()
  .describe("Project number override (defaults to configured project)"),
```

No handler code changes needed -- `resolveFullConfig(client, args)` already passes `args` through, and GH-150 will add the `projectNumber` extraction.

For Category C tools (`advance_children`, `advance_parent`), replace the manual pattern:
```typescript
// Before:
const { owner, repo } = resolveConfig(client, args);
const projectNumber = client.config.projectNumber;
const projectOwner = resolveProjectOwner(client.config);

// After:
const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(client, args);
```

For `get_issue`, add one line:
```typescript
const projectNumber = args.projectNumber ?? client.config.projectNumber;
```

### 3. Schema Param Must Be `projectNumber` Not `number`

The existing `number` param in most tools refers to issue number (e.g., `number: z.coerce.number().describe("Issue number")`). Using `projectNumber` as the param name avoids confusion and collision. This aligns with the GH-150 research recommendation.

### 4. Existing Template Pattern in project-tools.ts

`get_project`, `list_project_items`, `list_views`, and `update_field_options` already demonstrate the override pattern. While they use `number` (not `projectNumber`), their approach validates the concept:

```typescript
const projectNumber = args.number || client.config.projectNumber;
```

### 5. `ensureFieldCache` Identity Issue

The current `FieldOptionCache.isPopulated()` check has no project-awareness -- it returns `true` once any project's fields are cached. When `projectNumber` overrides target a different project, the cache may serve stale data from the wrong project.

This is GH-144's responsibility (`FieldOptionCache` keyed by project number). GH-151 should note this dependency but not address it. In practice, single-project usage (the vast majority) is unaffected.

### 6. Batch Tools and Dashboard Tools

`batch_update` in `batch-tools.ts` and tools in `dashboard-tools.ts` also use `resolveFullConfig`. The dashboard tools are particularly relevant for cross-project use cases, but they're part of GH-102's split (#144, #145, #146), not GH-103's split.

## Implementation Plan Summary

### Phase 1: Category C refactoring (2 tools)

Refactor `advance_children` and `advance_parent` to use `resolveFullConfig` instead of inline resolution. This is a prerequisite for the schema addition.

### Phase 2: Schema addition (all tools)

Add `projectNumber: z.coerce.number().optional()` to every tool that uses `resolveFullConfig` and to `get_issue`.

### Phase 3: Tests

Add tests for representative tools (not all 28) verifying:
- When `projectNumber` provided, it overrides config
- When `projectNumber` omitted, config default is used
- `get_issue` filters `projectItems` by override number

## Risks

1. **Depends on GH-150**: `resolveFullConfig` must accept `projectNumber` in args first. Without it, adding the schema param does nothing.
2. **Large number of files touched**: 4 tool files need changes. While each change is mechanical, the diff will be large. Risk of merge conflicts with other PRs.
3. **`FieldOptionCache` identity**: Until GH-144 makes the cache project-aware, overriding `projectNumber` may return incorrect field data for non-default projects. Document this limitation.
4. **Naming divergence**: The 4 existing override tools use `number` while the new 28 will use `projectNumber`. This creates inconsistency. A follow-up could rename the 4 bypass tools, but that's out of scope.

## Recommended Next Steps

1. Implement GH-150 first (blocked by GH-144)
2. Implement GH-151 with the mechanical schema changes
3. Refactor `advance_children` and `advance_parent` to use `resolveFullConfig`
4. Add `projectNumber` override to `get_issue` handler
5. Add tests for 3-4 representative tools
6. Document the `FieldOptionCache` limitation (single-project cache) as a known limitation until GH-144 lands
