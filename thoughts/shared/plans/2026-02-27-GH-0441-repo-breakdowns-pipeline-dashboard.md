---
date: 2026-02-27
status: draft
github_issues: [441]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/441
primary_issue: 441
---

# Build and Render repoBreakdowns in pipeline_dashboard - Implementation Plan

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-441 | Build and render repoBreakdowns in pipeline_dashboard | S |

## Current State Analysis

`buildDashboard()` in `dashboard.ts:622-663` groups items by `projectNumber` into `projectGroups`, builds `projectBreakdowns` when 2+ projects exist, then calls `detectCrossProjectHealth()` to merge cross-project warnings into top-level health. `ProjectBreakdown` interface at `dashboard.ts:87-91` has `projectTitle`, `phases: PhaseSnapshot[]`, and `health`. `DashboardData` at `dashboard.ts:111-122` has `projectBreakdowns?: Record<number, ProjectBreakdown>`. `formatMarkdown()` at `dashboard.ts:770-813` renders a "## Per-Project Breakdown" section with `### {projectTitle}` sub-headers, Phase/Count tables (non-zero only), and health warnings. After #440, `DashboardItem` will have `repository?: string` (nameWithOwner format). No repo grouping or `repoBreakdowns` exists yet.

## Desired End State

### Verification
- [ ] `RepoBreakdown` interface defined in `dashboard.ts`
- [ ] `DashboardData` has `repoBreakdowns?: Record<string, RepoBreakdown>`
- [ ] `buildDashboard()` groups items by `item.repository` and builds `repoBreakdowns` when 2+ repos present
- [ ] `formatMarkdown()` renders "## Per-Repository Breakdown" section when `repoBreakdowns` populated
- [ ] Single-repo projects: `repoBreakdowns` is `undefined` (no extra output)
- [ ] Tests cover: multi-repo produces breakdowns, single-repo produces none, formatMarkdown renders/omits section

## What We're NOT Doing

- Not modifying `toDashboardItems()` or `DashboardItem` — that's #440 (sibling, already planned)
- Not adding `detectCrossRepoHealth()` — deferred per issue scope
- Not adding `formatAscii()` per-repo section — issue body only mentions `formatMarkdown()`
- Not modifying `dashboard-tools.ts` — `repoBreakdowns` flows through `DashboardData` automatically
- Not adding Points column to per-repo tables — matching existing per-project table pattern (Phase/Count only)

## Implementation Approach

Four changes in `dashboard.ts` and one test file:
1. Add `RepoBreakdown` interface (mirror `ProjectBreakdown`)
2. Add `repoBreakdowns?` field to `DashboardData` interface
3. Add repo grouping + build block in `buildDashboard()`
4. Add "Per-Repository Breakdown" section in `formatMarkdown()`
5. Add tests mirroring existing `projectBreakdowns` test patterns

---

## Phase 1: Build and render repoBreakdowns
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/441 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0441-repo-breakdowns-pipeline-dashboard.md

### Changes Required

#### 1. Add `RepoBreakdown` interface
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Location**: After `ProjectBreakdown` interface (after line 91)
**Change**: Add new interface mirroring `ProjectBreakdown`:

```typescript
export interface RepoBreakdown {
  repoName: string;
  phases: PhaseSnapshot[];
  health: { ok: boolean; warnings: HealthWarning[] };
}
```

#### 2. Add `repoBreakdowns?` to `DashboardData` interface
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Location**: After `projectBreakdowns?` field (after line 120)
**Change**: Add optional field:

```typescript
  projectBreakdowns?: Record<number, ProjectBreakdown>;
  repoBreakdowns?: Record<string, RepoBreakdown>;  // NEW: string key = nameWithOwner
  streams?: StreamDashboardSection;
```

#### 3. Add repo grouping and build block in `buildDashboard()`
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Location**: After the `projectBreakdowns` build block (after line 663, before the return statement at line 672)
**Change**: Add repo grouping following the exact `projectGroups` pattern:

```typescript
  // Repo breakdown (only for multi-repo projects)
  const repoGroups = new Map<string, DashboardItem[]>();
  for (const item of items) {
    if (item.repository) {
      const group = repoGroups.get(item.repository);
      if (group) {
        group.push(item);
      } else {
        repoGroups.set(item.repository, [item]);
      }
    }
  }

  let repoBreakdowns: Record<string, RepoBreakdown> | undefined;

  if (repoGroups.size >= 2) {
    repoBreakdowns = {};
    for (const [repoName, repoItems] of repoGroups) {
      const rPhases = aggregateByPhase(repoItems, now, config);
      const rWarnings = detectHealthIssues(rPhases, config);
      repoBreakdowns[repoName] = {
        repoName,
        phases: rPhases,
        health: { ok: rWarnings.length === 0, warnings: rWarnings },
      };
    }
  }
```

Then update the return object spread (at line ~681) to include `repoBreakdowns`:

```typescript
  return {
    generatedAt: new Date(now).toISOString(),
    totalIssues: items.length,
    phases,
    health: { ok: warnings.length === 0, warnings },
    archive,
    ...(projectBreakdowns ? { projectBreakdowns } : {}),
    ...(repoBreakdowns ? { repoBreakdowns } : {}),      // NEW
    ...(streamSection ? { streams: streamSection } : {}),
  };
```

#### 4. Add "Per-Repository Breakdown" section in `formatMarkdown()`
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Location**: After the "Per-Project Breakdown" section (after line ~813), before the streams section
**Change**: Add rendering block mirroring the per-project pattern:

```typescript
  // Per-repository breakdown (only for multi-repo)
  if (
    data.repoBreakdowns &&
    Object.keys(data.repoBreakdowns).length > 1
  ) {
    lines.push("");
    lines.push("## Per-Repository Breakdown");

    const sortedRepos = Object.values(data.repoBreakdowns).sort((a, b) =>
      a.repoName.localeCompare(b.repoName),
    );

    for (const repo of sortedRepos) {
      lines.push("");
      lines.push(`### ${repo.repoName}`);
      lines.push("");

      const nonZeroPhases = repo.phases.filter((p) => p.count > 0);
      if (nonZeroPhases.length > 0) {
        lines.push("| Phase | Count |");
        lines.push("|-------|------:|");
        for (const phase of nonZeroPhases) {
          lines.push(`| ${phase.state} | ${phase.count} |`);
        }
      } else {
        lines.push("_No active items_");
      }

      lines.push("");
      if (repo.health.ok) {
        lines.push("**Health**: All clear");
      } else {
        for (const w of repo.health.warnings) {
          const icon =
            w.severity === "critical"
              ? "[CRITICAL]"
              : w.severity === "warning"
                ? "[WARNING]"
                : "[INFO]";
          lines.push(`- ${icon} ${w.message}`);
        }
      }
    }
  }
```

Key differences from per-project section:
- Sort: `localeCompare` (alphabetical) instead of numeric `projectNumber` sort
- Uses `Object.values` + sort by `repoName` instead of `Object.entries` + Number conversion
- Sub-headers use `### ${repo.repoName}` (e.g., `### owner/repo-a`)

#### 5. Add tests for repoBreakdowns
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts`
**Location**: After the `describe("formatAscii per-project", ...)` block (after line ~1536)
**Change**: Add test blocks mirroring existing `projectBreakdowns` patterns:

```typescript
describe("buildDashboard multi-repo breakdown", () => {
  it("omits repoBreakdowns for single-repo items", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Backlog", repository: "owner/repo-a" }),
      makeItem({ number: 2, workflowState: "In Progress", repository: "owner/repo-a" }),
    ];
    const data = buildDashboard(items, DEFAULT_HEALTH_CONFIG, NOW);
    expect(data.repoBreakdowns).toBeUndefined();
  });

  it("omits repoBreakdowns when no repository set", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Backlog" }),
      makeItem({ number: 2, workflowState: "In Progress" }),
    ];
    const data = buildDashboard(items, DEFAULT_HEALTH_CONFIG, NOW);
    expect(data.repoBreakdowns).toBeUndefined();
  });

  it("produces repoBreakdowns with correct per-repo phase counts", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Backlog", repository: "owner/repo-a" }),
      makeItem({ number: 2, workflowState: "Backlog", repository: "owner/repo-a" }),
      makeItem({ number: 3, workflowState: "In Progress", repository: "owner/repo-b" }),
      makeItem({ number: 4, workflowState: "In Progress", repository: "owner/repo-b" }),
      makeItem({ number: 5, workflowState: "In Progress", repository: "owner/repo-b" }),
    ];

    const data = buildDashboard(items, DEFAULT_HEALTH_CONFIG, NOW);
    expect(data.repoBreakdowns).toBeDefined();

    const bdA = data.repoBreakdowns!["owner/repo-a"];
    expect(bdA.repoName).toBe("owner/repo-a");
    expect(bdA.phases.find((p) => p.state === "Backlog")!.count).toBe(2);

    const bdB = data.repoBreakdowns!["owner/repo-b"];
    expect(bdB.repoName).toBe("owner/repo-b");
    expect(bdB.phases.find((p) => p.state === "In Progress")!.count).toBe(3);
  });
});

describe("formatMarkdown per-repo", () => {
  it("renders per-repo section when repoBreakdowns present", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Backlog", repository: "owner/repo-a" }),
      makeItem({ number: 2, workflowState: "In Progress", repository: "owner/repo-b" }),
    ];
    const data = buildDashboard(items, DEFAULT_HEALTH_CONFIG, NOW);
    const md = formatMarkdown(data);
    expect(md).toContain("## Per-Repository Breakdown");
    expect(md).toContain("owner/repo-a");
    expect(md).toContain("owner/repo-b");
  });

  it("omits per-repo section when repoBreakdowns absent", () => {
    const items = [makeItem({ number: 1, workflowState: "Backlog" })];
    const data = buildDashboard(items, DEFAULT_HEALTH_CONFIG, NOW);
    const md = formatMarkdown(data);
    expect(md).not.toContain("## Per-Repository Breakdown");
  });
});
```

### File Ownership Summary

| File | Action |
|------|--------|
| `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` | MODIFY (add `RepoBreakdown` interface after line 91; add `repoBreakdowns?` to `DashboardData` after line 120; add repo grouping block after line 663; add spread at ~681; add formatMarkdown section after ~813) |
| `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts` | MODIFY (add `describe("buildDashboard multi-repo breakdown")` with 3 tests; add `describe("formatMarkdown per-repo")` with 2 tests after ~1536) |

### Success Criteria

- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes
- [ ] Automated: `grep -q "RepoBreakdown" plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` exits 0
- [ ] Automated: `grep -q "repoBreakdowns" plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` exits 0
- [ ] Automated: `grep -q "Per-Repository Breakdown" plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` exits 0
- [ ] Manual: `RepoBreakdown` interface mirrors `ProjectBreakdown` structure with `repoName` instead of `projectTitle`
- [ ] Manual: `repoGroups` uses `Map<string, DashboardItem[]>` (string key, not numeric)
- [ ] Manual: `repoBreakdowns` only populated when `repoGroups.size >= 2` (single-repo = undefined)
- [ ] Manual: `formatMarkdown()` sorts repos alphabetically via `localeCompare`
- [ ] Manual: Per-repo phase table uses Phase/Count columns only (matching per-project table)
- [ ] Manual: `dashboard-tools.ts` is unmodified (repoBreakdowns flows through DashboardData automatically)

## Integration Testing

- [ ] Run full test suite: `cd plugin/ralph-hero/mcp-server && npm test`
- [ ] Verify existing `projectBreakdowns` tests still pass unchanged
- [ ] Verify new tests cover: multi-repo breakdowns with correct per-repo counts, single-repo (undefined), no-repo (undefined), formatMarkdown renders/omits section
- [ ] Verify `buildDashboard` and `formatMarkdown` existing tests pass (repoBreakdowns is optional, no behavior change for existing callers)

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0441-repo-breakdowns-pipeline-dashboard.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/441
- Parent: https://github.com/cdubiel08/ralph-hero/issues/430
- Depends on: https://github.com/cdubiel08/ralph-hero/issues/440 (stamps `repository` on `DashboardItem`)
- Pattern reference: `ProjectBreakdown` at `dashboard.ts:87-91`, `projectGroups` at `dashboard.ts:622-663`, per-project formatMarkdown at `dashboard.ts:770-813`
