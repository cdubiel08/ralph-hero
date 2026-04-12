---
date: 2026-03-19
status: draft
type: plan
tags: [ralph-knowledge, obsidian, indexer, frontmatter, type-inference]
---

# Knowledge Type Inference & Frontmatter Fix — Implementation Plan

## Overview

36 documents appear in `_uncategorized.md` in the Obsidian vault despite having obvious types derivable from their directory path or containing `type: spec` which the indexer doesn't recognize. This plan fixes the indexer to infer type from path, adds `spec` as a first-class type, then bulk-patches frontmatter on existing docs for correctness.

## Current State Analysis

`parser.ts:58` sets `type: frontmatter.type ?? null` — no fallback. If a doc lacks `type:` frontmatter, it gets `null` and lands in `_uncategorized.md`.

`generate-indexes.ts:254–260` only recognizes: `research`, `plan`, `idea`, `review`, `report`. Any other value (e.g., `spec`) also lands in uncategorized.

**36 affected documents:**

| Directory | Count | Inferred type |
|-----------|-------|---------------|
| `shared/reports/` | 16 | `report` |
| `shared/plans/` | 11 | `plan` |
| `ideas/` + `shared/ideas/` | 5 | `idea` |
| `shared/research/` | 2 | `research` |
| `shared/plans/` (`type: spec`) | 1 | `spec` (new first-class type) |

## Desired End State

- `_uncategorized.md` is not generated (or is empty) after reindex
- `_index.md` does not link to `_uncategorized`
- All 36 docs appear in their correct type indexes
- New docs added without `type:` frontmatter are automatically categorized by directory
- Plugin tests cover the inference logic

### Verification
- [ ] `_uncategorized.md` does not exist after reindex
- [ ] `_plans.md` includes the 11 formerly-uncategorized plan docs (not the spec)
- [ ] `_specs.md` exists and includes the `debug-mode-observability-spec` doc
- [ ] `_reports.md` includes all 16 ralph-team session reports
- [ ] `_ideas.md` includes the 5 formerly-uncategorized idea docs
- [ ] `_index.md` lists `_specs` in Browse by Type

## What We're NOT Doing

- Not creating a `thoughts/shared/specs/` directory — specs can live in any directory and are typed by frontmatter
- Not changing the directory structure of `thoughts/`
- Not touching `shared/research/` docs that already have correct frontmatter

## Implementation Approach

Three-part fix:
1. **Plugin code** — add path-based type inference in `parser.ts`, add `spec` as a first-class type in `generate-indexes.ts`
2. **Frontmatter patch** — add `type:` to the 35 affected docs so they're correct even without inference
3. **Obsidian config** — add `spec` to graph color groups and Dataview queries

---

## Phase 1: Add type inference to parser.ts

### Changes Required

**File**: `plugin/ralph-knowledge/src/parser.ts`

Add a `inferTypeFromPath()` helper and call it when `frontmatter.type` is absent:

```typescript
const PATH_TYPE_MAP: Array<{ segment: string; type: string }> = [
  { segment: "/research/", type: "research" },
  { segment: "/plans/",    type: "plan" },
  { segment: "/ideas/",    type: "idea" },
  { segment: "/reviews/",  type: "review" },
  { segment: "/reports/",  type: "report" },
];

function inferTypeFromPath(path: string): string | null {
  for (const { segment, type } of PATH_TYPE_MAP) {
    if (path.includes(segment)) return type;
  }
  return null;
}
```

Then in `parseDocument`, replace:
```typescript
type: frontmatter.type ?? null,
```
with:
```typescript
type: (typeof frontmatter.type === "string" && frontmatter.type.length > 0)
  ? frontmatter.type
  : inferTypeFromPath(path),
```

Note: no aliasing — `type: spec` stays as `"spec"` and is handled as a first-class type.

**File**: `plugin/ralph-knowledge/src/generate-indexes.ts`

Add `spec` to all three type registries:

```typescript
// In TYPE_HEADINGS (line 55-61):
const TYPE_HEADINGS: Record<string, string> = {
  research: "Research",
  plan: "Plans",
  spec: "Specs",        // NEW
  idea: "Ideas",
  review: "Reviews",
  report: "Reports",
};

// In TYPE_INDEX_CONFIG (line 254-260):
const TYPE_INDEX_CONFIG: Array<{ type: string; filename: string; heading: string }> = [
  { type: "research", filename: "research", heading: "Research Documents" },
  { type: "plan", filename: "plans", heading: "Implementation Plans" },
  { type: "spec", filename: "specs", heading: "Specifications" },  // NEW
  { type: "idea", filename: "ideas", heading: "Ideas & Drafts" },
  { type: "review", filename: "reviews", heading: "Reviews" },
  { type: "report", filename: "reports", heading: "Reports" },
];
```

Also update `writeMasterIndex` (line 138-144) to add a `_specs` entry:
```typescript
"- [[_specs]] — Specifications",
```

**File**: `plugin/ralph-knowledge/src/__tests__/generate-indexes.test.ts` (or a new `parser.test.ts`)

Add tests covering:
- `inferTypeFromPath("shared/plans/foo.md")` → `"plan"`
- `inferTypeFromPath("shared/research/foo.md")` → `"research"`
- `inferTypeFromPath("shared/reports/foo.md")` → `"report"`
- `type: spec` in frontmatter → stays as `"spec"` (no aliasing)
- Unknown path with no type → `null`

### Success Criteria

#### Automated Verification:
- [ ] `npm test` passes in `plugin/ralph-knowledge/`
- [ ] `npm run build` (TypeScript) passes

#### Manual Verification:
- [ ] Run reindex: `node /tmp/node_modules/ralph-hero-knowledge-index/dist/reindex.js thoughts/`
- [ ] `_uncategorized.md` is absent or empty

---

## Phase 2: Bulk-patch frontmatter on 36 existing docs

Add `type:` frontmatter to each affected file so they're correct in git history independently of inference logic. This is a mechanical sed/script operation.

**Files to patch** (add `type: plan`):
- `thoughts/shared/plans/2026-02-20-ralph-team-worker-redesign.md`
- `thoughts/shared/plans/2026-02-26-GH-0418-interactive-ralph-parity.md`
- `thoughts/shared/plans/2026-02-27-GH-0433-auto-mode-pipeline-detection.md`
- `thoughts/shared/plans/2026-02-27-mcp-toolspace-consolidation.md`
- `thoughts/shared/plans/2026-02-27-ralph-cli-qol-improvements.md`
- `thoughts/shared/plans/2026-02-28-ralph-protocol-specs.md`
- `thoughts/shared/plans/2026-03-02-builder-main-branch-guard.md`
- `thoughts/shared/plans/2026-03-03-group-GH-0519-parent-advancement-dashboard-fix.md`
- `thoughts/shared/plans/2026-03-05-GH-0539-cross-repo-dependency-tooling.md`
- `thoughts/shared/plans/2026-03-18-group-GH-0604-demo-cli-greeting.md`

Note: `2026-02-21-debug-mode-observability-spec.md` already has `type: spec` — no change needed (now a recognized type).

**Files to patch** (add `type: report`):
- `thoughts/shared/reports/2026-02-21-weekly-ship-report.md`
- `thoughts/shared/reports/2026-02-25-idea-hunt-team-diagnostic.md`
- `thoughts/shared/reports/2026-02-27-ralph-team-GH-451.md`
- `thoughts/shared/reports/2026-03-01-ralph-team-431-464-466.md`
- `thoughts/shared/reports/2026-03-01-ralph-team-bugs-and-triage.md`
- `thoughts/shared/reports/2026-03-01-ralph-team-GH-433.md`
- `thoughts/shared/reports/2026-03-01-ralph-team-GH-467.md`
- `thoughts/shared/reports/2026-03-01-ralph-team-GH-477.md`
- `thoughts/shared/reports/2026-03-01-ralph-team-plugin-cleanup.md`
- `thoughts/shared/reports/2026-03-01-ralph-team-triage-oldest-5.md`
- `thoughts/shared/reports/2026-03-02-ralph-team-464-466.md`
- `thoughts/shared/reports/2026-03-02-ralph-team-GH-493.md`
- `thoughts/shared/reports/2026-03-03-ralph-team-gh-0480.md`
- `thoughts/shared/reports/2026-03-04-ralph-team-gh-0519.md`
- `thoughts/shared/reports/2026-03-04-ralph-team-gh-514-515-516.md`
- `thoughts/shared/reports/2026-03-04-ralph-team-pir-batch.md`
- `thoughts/shared/reports/2026-03-05-ralph-team-gh-541-worktree-lifecycle.md`
- `thoughts/shared/reports/2026-03-18-ralph-team-GH-604-demo-cli.md`
- `thoughts/shared/reports/2026-03-19-ralph-team-GH-604-demo-cli-merge.md`

**Files to patch** (add `type: idea`):
- `thoughts/ideas/2026-02-18-github-projects-v2-docs-deep-dive.md`
- `thoughts/ideas/2026-02-21-showcase-demo-onboarding.md`
- `thoughts/ideas/2026-02-22-orchestrator-no-message-on-task-assign.md`
- `thoughts/shared/ideas/2026-02-25-idea-hunt-synthesis.md`
- `thoughts/shared/ideas/2026-03-01-hello-session-briefing.md`

**Files to patch** (add `type: research`):
- `thoughts/shared/research/2026-02-18-GH-0066-github-projects-v2-docs-guidance.md`
- `thoughts/shared/research/2026-02-20-GH-0199-cross-project-sync-audit-trail.md`

### Patch strategy

Insert `type: <TYPE>` after the opening `---` line using a targeted edit for each file. No sed — use Edit tool per file to avoid frontmatter corruption.

### Success Criteria

#### Automated Verification:
- [ ] `grep -rL "^type:" thoughts/shared/plans/ thoughts/shared/reports/ thoughts/ideas/ thoughts/shared/ideas/ thoughts/shared/research/` returns no files

#### Manual Verification:
- [ ] Git diff shows only frontmatter additions, no content changes

---

## Phase 3: Reindex and verify

```bash
node /tmp/node_modules/ralph-hero-knowledge-index/dist/reindex.js thoughts/
```

Check output:
- No `missing frontmatter: type` warnings for the 36 patched files
- `_uncategorized.md` is absent
- `_plans.md`, `_reports.md`, `_ideas.md` lists grow by expected counts

Then rebuild the npm package and publish:
```bash
cd plugin/ralph-knowledge && npm run build && npm test
```

CI will handle publish on merge to main.

---

## References

- `plugin/ralph-knowledge/src/parser.ts:58` — type field assignment
- `plugin/ralph-knowledge/src/generate-indexes.ts:254–260` — TYPE_INDEX_CONFIG
- `plugin/ralph-knowledge/src/generate-indexes.ts:269` — uncategorized filter
