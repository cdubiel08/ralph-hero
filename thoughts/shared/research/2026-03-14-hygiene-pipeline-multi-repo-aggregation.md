---
date: 2026-03-14
github_issue: 563
github_url: https://github.com/cdubiel08/ralph-hero/issues/563
topic: "Do hygiene and pipeline dashboard properly aggregate issues by repo name for multi-repo projects?"
tags: [research, codebase, hygiene, pipeline-dashboard, multi-repo]
status: complete
type: research
---

# Research: Hygiene vs Pipeline Dashboard Multi-Repo Aggregation

## Research Question

Do the `project_hygiene` and `pipeline_dashboard` tools properly aggregate issues by repository name for multi-repo projects?

## Summary

**Pipeline dashboard handles multi-repo well. Hygiene does not.**

The `pipeline_dashboard` tool has full multi-repo support: it fetches repository metadata from GraphQL, supports a `groupBy: "repo"` parameter, automatically generates per-repo breakdowns when items span 2+ repos, and renders those breakdowns in markdown/ASCII output.

The `project_hygiene` tool has no multi-repo awareness at all: it doesn't support multiple projects, doesn't expose a `groupBy` parameter, and its `HygieneItem` type strips repository information during conversion. Even though the underlying `DashboardItem` data includes repository, it is discarded when building the hygiene report.

## Detailed Findings

### Pipeline Dashboard — Full Multi-Repo Support

1. **Multi-project iteration** (`dashboard-tools.ts:364-365`): Uses `resolveProjectNumbers()` to iterate over all configured projects and merge items.

2. **Repository data extraction** (`dashboard-tools.ts:189`): `toDashboardItems()` unconditionally extracts `repository: r.content.repository.nameWithOwner` from GraphQL responses.

3. **`groupBy: "repo"` parameter** (`dashboard-tools.ts:349-354`): Explicit schema parameter lets callers request per-repo sub-dashboards.

4. **`groupDashboardItemsByRepo()`** (`dashboard.ts:926-936`): Pure function groups items by `repository` field, defaulting to `"(unknown)"`.

5. **Automatic repo breakdowns** (`dashboard.ts:678-704`): `buildDashboard()` automatically computes `repoBreakdowns` when items span 2+ repos, including per-repo health warnings.

6. **Formatted output** (`dashboard.ts:856-899`): `formatMarkdown()` renders a "Per-Repository Breakdown" section with per-repo phase tables and health indicators.

7. **Test coverage**: `dashboard-group-by.test.ts` covers `groupDashboardItemsByRepo()` including edge cases like missing repository.

### Project Hygiene — No Multi-Repo Support

1. **Single-project only** (`hygiene-tools.ts:86-87`): Uses `client.config.projectNumber` directly — no `projectNumbers` parameter, no multi-project iteration.

2. **No projectNumber/projectTitle passed** (`hygiene-tools.ts:113`): Calls `toDashboardItems(result.nodes)` without `projectNumber` or `projectTitle` arguments. Repository data IS still populated (since `toDashboardItems` sets it unconditionally), but there's no code to use it.

3. **Repository info discarded** (`hygiene.ts:78-85`): `toHygieneItem()` maps to `HygieneItem { number, title, workflowState, ageDays }` — the `repository` field from `DashboardItem` is dropped.

4. **No `groupBy` parameter**: The tool schema has no way to request per-repo grouping.

5. **`HygieneReport` lacks repo breakdowns**: The report type has no `repoBreakdowns` field. All sections (archive candidates, stale items, orphans, field gaps, WIP violations, duplicates) are flat lists with no repo context.

6. **`formatHygieneMarkdown()` has no repo sections**: Output is a single flat report regardless of how many repos are on the board.

### Gap Analysis

| Capability | Pipeline Dashboard | Project Hygiene |
|---|---|---|
| Multi-project support (`projectNumbers`) | Yes | No |
| Repository data in items | Yes | Available but unused |
| `groupBy: "repo"` parameter | Yes | No |
| Per-repo breakdowns | Yes (auto when 2+ repos) | No |
| Per-repo health/warnings | Yes | No |
| Repo in output items | Yes | No (stripped by `toHygieneItem`) |
| Markdown per-repo sections | Yes | No |

## Code References

- `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts:349-354` - groupBy schema parameter
- `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts:447-476` - groupBy=repo rendering logic
- `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts:189` - repository extraction in toDashboardItems
- `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:678-704` - automatic repoBreakdowns in buildDashboard
- `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:856-899` - markdown per-repo sections
- `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:926-936` - groupDashboardItemsByRepo helper
- `plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts:86-87` - single projectNumber only
- `plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts:113` - toDashboardItems without project context
- `plugin/ralph-hero/mcp-server/src/lib/hygiene.ts:78-85` - HygieneItem drops repository
- `plugin/ralph-hero/mcp-server/src/lib/hygiene.ts:31-36` - HygieneItem type (no repository field)
- `plugin/ralph-hero/mcp-server/src/lib/hygiene.ts:43-65` - HygieneReport type (no repo breakdowns)

## Open Questions

- Should hygiene support cross-repo duplicate detection (duplicates across repos may be intentional)?
- Should per-repo WIP limits be separate from global WIP limits?
