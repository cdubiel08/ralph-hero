---
date: 2026-02-27
github_issue: 441
github_url: https://github.com/cdubiel08/ralph-hero/issues/441
status: complete
type: research
---

# GH-441: Build and Render repoBreakdowns in pipeline_dashboard

## Problem Statement

Once `DashboardItem` carries a `repository` field (added in sibling #440), `pipeline_dashboard` needs to group items by repository and render a "Per-Repository Breakdown" section — analogous to the existing "Per-Project Breakdown". This gives multi-repo enterprise users per-repo phase visibility in a single dashboard call.

## Current State Analysis

### `ProjectBreakdown` Interface (`dashboard.ts:87-91`)

```typescript
export interface ProjectBreakdown {
  projectTitle: string;
  phases: PhaseSnapshot[];
  health: { ok: boolean; warnings: HealthWarning[] };
}
```

`RepoBreakdown` should mirror this exactly, substituting `projectTitle: string` with `repoName: string` (the `nameWithOwner` value).

### `DashboardData` Interface (`dashboard.ts:111-122`)

```typescript
export interface DashboardData {
  generatedAt: string;
  totalIssues: number;
  phases: PhaseSnapshot[];
  health: { ok: boolean; warnings: HealthWarning[] };
  archive: ArchiveStats;
  projectBreakdowns?: Record<number, ProjectBreakdown>;  // numeric key
  streams?: StreamDashboardSection;
}
```

`repoBreakdowns` should use `Record<string, RepoBreakdown>` keyed by `nameWithOwner` (`"owner/repo"` format). This follows the same optional-field pattern but with a string key rather than numeric.

### `buildDashboard()` — projectGroups pattern (`dashboard.ts:622-663`)

**Group construction (lines 622-632):**
```typescript
const projectGroups = new Map<number, DashboardItem[]>();
for (const item of items) {
  if (item.projectNumber !== undefined) {
    const group = projectGroups.get(item.projectNumber);
    if (group) { group.push(item); }
    else { projectGroups.set(item.projectNumber, [item]); }
  }
}
```
Items without `projectNumber` are silently skipped. `repoGroups` follows identically but checks `item.repository` (string, undefined when absent).

**Build block (lines 634-663):**
```typescript
let projectBreakdowns: Record<number, ProjectBreakdown> | undefined;
if (projectGroups.size >= 2) {
  projectBreakdowns = {};
  for (const [pn, projectItems] of projectGroups) {
    const pPhases = aggregateByPhase(projectItems, now, config);
    const pWarnings = detectHealthIssues(pPhases, config);
    projectBreakdowns[pn] = {
      projectTitle: projectItems[0].projectTitle ?? `Project ${pn}`,
      phases: pPhases,
      health: { ok: pWarnings.length === 0, warnings: pWarnings },
    };
  }
  // ... detectCrossProjectHealth appended to top-level warnings
}
```
Trigger is `size >= 2`. Calls `aggregateByPhase()` + `detectHealthIssues()` per group. No `detectCrossRepoHealth` is needed for initial implementation (deferred per issue body).

**Return spread (lines 681-682):**
```typescript
...(projectBreakdowns ? { projectBreakdowns } : {}),
...(streamSection ? { streams: streamSection } : {}),
```
`repoBreakdowns` uses the same ternary-spread pattern after the `projectBreakdowns` line.

### `formatMarkdown()` — Per-Project Breakdown section (`dashboard.ts:770-813`)

```typescript
if (data.projectBreakdowns && Object.keys(data.projectBreakdowns).length > 1) {
  lines.push("## Per-Project Breakdown");
  const sortedProjects = Object.entries(data.projectBreakdowns)
    .map(([pn, bd]) => ({ projectNumber: Number(pn), ...bd }))
    .sort((a, b) => a.projectNumber - b.projectNumber);
  for (const project of sortedProjects) {
    lines.push(`### ${project.projectTitle}`);
    const nonZeroPhases = project.phases.filter((p) => p.count > 0);
    if (nonZeroPhases.length > 0) {
      lines.push("| Phase | Count |");
      lines.push("|-------|------:|");
      for (const phase of nonZeroPhases) {
        lines.push(`| ${phase.state} | ${phase.count} |`);
      }
    } else {
      lines.push("_No active items_");
    }
    // health output
  }
}
```

`repoBreakdowns` section mirrors this exactly:
- Guard: `data.repoBreakdowns && Object.keys(data.repoBreakdowns).length >= 2`
- Header: `## Per-Repository Breakdown`
- Sort: alphabetically by `repoName` (string sort, not numeric)
- Per-repo sub-header: `### ${bd.repoName}`
- Phase table: Phase + Count columns, non-zero phases only
- Health: same warning rendering

### Test Patterns (`dashboard.test.ts:1426-1509`)

All `projectBreakdowns` tests use `makeItem({ projectNumber: 3, projectTitle: "Board A" })` / `makeItem({ projectNumber: 5, projectTitle: "Board B" })`. For `repoBreakdowns`, the analogous pattern is `makeItem({ repository: "owner/repo-a" })` / `makeItem({ repository: "owner/repo-b" })`.

Four test blocks to model after:
1. `describe("buildDashboard multi-project breakdown")` at lines 1426-1482 — 4 test cases
2. `describe("formatMarkdown per-project")` at lines 1488-1509 — 2 test cases
3. `describe("formatAscii per-project")` at lines 1515-1536 — 2 test cases (NOT needed for repoBreakdowns per issue scope)
4. `describe("detectCrossProjectHealth")` at lines 1344-1420 — NOT needed (no cross-repo health in this issue)

### `dashboard-tools.ts` — Tool Response (`dashboard-tools.ts`)

The tool response at the `pipeline_dashboard` tool handler returns the `DashboardData` object directly. Since `repoBreakdowns` is a field on `DashboardData`, it flows through automatically with no changes needed in `dashboard-tools.ts`. The issue body mentions File 4 as a verification step, not an implementation step.

## Key Discoveries

### `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:87-91`
`ProjectBreakdown` interface — `RepoBreakdown` mirrors this with `repoName: string` instead of `projectTitle: string`.

### `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:111-122`
`DashboardData` — add `repoBreakdowns?: Record<string, RepoBreakdown>` after `projectBreakdowns` (string key, not numeric).

### `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:622-663`
`buildDashboard()` projectGroups — `repoGroups` uses `Map<string, DashboardItem[]>`, checks `item.repository`, triggers on `size >= 2`. No `detectCrossRepoHealth` call (deferred). `repoName` = `repoItems[0].repository` — no fallback needed since string items in the group always have `repository` defined.

### `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:672-683`
Return spread — add `...(repoBreakdowns ? { repoBreakdowns } : {})` after `projectBreakdowns` spread.

### `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:770-813`
`formatMarkdown()` project section — `repoBreakdowns` section follows identical structure; sort alphabetically by `repoName` (string) instead of numerically by `projectNumber`; use `## Per-Repository Breakdown` and `### ${bd.repoName}` headers.

### `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts:1426-1509`
Test pattern — `makeItem({ repository: "owner/repo-a" })` for multi-repo items; assert `data.repoBreakdowns` defined/undefined; assert `md.toContain("## Per-Repository Breakdown")`.

## Potential Approaches

### Option A: Mirror projectBreakdowns exactly (Recommended)

Implement `repoBreakdowns` as a direct structural mirror of `projectBreakdowns`:
- `RepoBreakdown` interface (same shape, `repoName` instead of `projectTitle`)
- `Record<string, RepoBreakdown>` (string key instead of numeric)
- `Map<string, DashboardItem[]>` for grouping
- Same aggregation + health per group
- Same spread pattern in return
- Alphabetical sort (string) in `formatMarkdown()`

**Pros:**
- Maximum pattern consistency — no new abstractions
- Test patterns are direct copy-and-adapt from existing test blocks
- `dashboard-tools.ts` requires zero changes
- Defers cross-repo health (as issue specifies)

**Cons:**
- Minor redundancy between `repoName` and `projectTitle` concepts, but they serve different dimensions

### Option B: Unify into generic "dimension breakdowns"

Refactor `projectBreakdowns` and `repoBreakdowns` to share a generic `BreakdownMap<K>` type.

**Pros:** Reduces code duplication if more dimension types are added later
**Cons:** Over-engineering for current scope; breaking change to `DashboardData` type; not requested

## Recommendation

**Option A** — Mirror `projectBreakdowns` exactly. The implementation is 3 source changes (interface + field + buildDashboard logic + formatMarkdown section) and 1 test file update. No `dashboard-tools.ts` changes needed.

## Risks

- **`makeItem()` doesn't have `repository` field yet**: After #440 lands, `makeItem()` will accept `repository` as an override. Test items use `makeItem({ repository: "owner/repo-a" })`. If #440 is not merged before #441 is implemented, tests will need a temporary workaround.
- **Single-repo projects unaffected**: `repoGroups.size < 2` → `repoBreakdowns` is `undefined` → no section rendered. This matches the `projectBreakdowns` behavior exactly.
- **Alphabetical vs. numeric sort**: `repoName` is a string, so `Object.entries` + `.sort((a, b) => a.repoName.localeCompare(b.repoName))` gives stable alphabetical order. No numeric conversion needed.
- **`repoName` key collision**: Repository `nameWithOwner` strings are globally unique (GitHub enforces uniqueness). No collision risk.
- **`formatAscii` not updated**: The issue body's scope only mentions `formatMarkdown()`. `formatAscii` is out of scope for this issue.

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` - Add `RepoBreakdown` interface, add `repoBreakdowns?` to `DashboardData`, add repo grouping in `buildDashboard()`, add "Per-Repository Breakdown" section in `formatMarkdown()`
- `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts` - Add `repoBreakdowns` test blocks mirroring existing multi-project tests

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` - Verify `repoBreakdowns` flows through tool response automatically (no changes expected)
