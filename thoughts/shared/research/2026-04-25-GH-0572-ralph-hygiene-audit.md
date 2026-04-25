---
date: 2026-04-25
github_issue: 572
github_url: https://github.com/cdubiel08/ralph-hero/issues/572
status: complete
type: research
tags: [ralph-hygiene, skill-audit, board-cleanup, mcp-tools, archive]
---

# Audit ralph-hygiene skill — eval board cleanup effectiveness

## Prior Work

- builds_on:: None identified.
- tensions:: None identified.

## Problem Statement

Phase 2 of the skill audit series (parent #566) requires a deep evaluation of the `ralph-hygiene` skill. Phase 1 (PR #565) fixed three systemic bugs across all skills: wrong sub-agent tool name, missing MCP tools in allowed-tools, and interactive/autonomous description confusion. Phase 2 for this skill specifically asks: are the cleanup recommendations high quality? Is archive candidate identification accurate? Is the skill's description well-tuned for triggering?

The issue carries an XS estimate, signaling the expectation that the audit is narrower than peers — a focused eval rather than a structural overhaul.

## Current State Analysis

### SKILL.md structure

`plugin/ralph-hero/skills/ralph-hygiene/SKILL.md` is a 5-step workflow:

1. Run `pipeline_dashboard` with `format: "markdown"`, `includeHealth: true`, `archiveThresholdDays: 14`.
2. Report archive eligibility summary from the dashboard `archive` section.
3. Optionally call `project_hygiene` for a detailed report — the step includes a fallback message referencing "GH-158" as an unimplemented dependency. GH-158 is now implemented (the `project_hygiene` MCP tool exists and is registered), so this fallback message is stale.
4. Auto-archive only when `RALPH_HYGIENE_DRY_RUN=false` AND eligible count exceeds `RALPH_HYGIENE_THRESHOLD` (default 10). Default mode is dry-run.
5. Output a final summary with items scanned, archive eligible, archived count, and health warnings.

The skill is `user-invocable: false` with `context: fork`. It requires `main` branch via the `set-skill-env.sh` SessionStart hook. Tools allowed: Read, Glob, Bash, `pipeline_dashboard`, `project_hygiene`, `archive_items`.

### project_hygiene MCP tool

`plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts` implements `ralph_hero__project_hygiene`. It surfaces seven data categories:

| Category | Detection Logic |
|---|---|
| Archive candidates | Done/Canceled items with `closedAt ?? updatedAt` older than `archiveDays` (default 14) |
| Stale items | Non-terminal items not updated within `staleDays` (default 7) |
| Orphaned items | Backlog-only, no assignees, older than `orphanDays` (default 14) |
| Field gaps | Non-terminal items missing `estimate` or `priority` |
| WIP violations | States exceeding caller-supplied `wipLimits` (no default limits configured) |
| Duplicate candidates | Non-terminal item pairs with `titleSimilarity >= 0.8` via Levenshtein |
| Summary stats | Aggregate counts + `fieldCoveragePercent` |

The tool uses `DASHBOARD_ITEMS_QUERY` and `toDashboardItems()` from `dashboard-tools.ts`, reusing the same GraphQL pagination path (up to 500 items). JSON and markdown output formats are both supported.

All hygiene logic is pure-function (`src/lib/hygiene.ts`) with comprehensive unit tests in `src/__tests__/hygiene.test.ts` covering all six detection functions plus formatters.

### archive_items tool

`src/tools/project-management-tools.ts` registers `ralph_hero__archive_items`. It supports:
- Single-item mode: archive or unarchive by issue number or project item ID.
- Bulk mode: filter by `workflowStates` array with optional `updatedBefore` date cutoff and `dryRun` flag. Chunks mutations at 50. Scans up to 2000 items, caps at 200 archived per call.

The bulk mode `dryRun: true` returns matching items without archiving, enabling a preview-then-confirm flow.

## Key Discoveries

### Finding 1: Stale fallback message in Step 3

`SKILL.md` line 65–71 contains a conditional: "If the tool is NOT available (expected until #158 is implemented)..." — this dead branch is now always false. The `project_hygiene` tool is registered and in the allowed-tools list. The fallback message creates confusion about whether the tool is available and should be removed.

### Finding 2: Step 3 is framed as optional when it should be primary

The skill currently calls `pipeline_dashboard` first and treats `project_hygiene` as optional "for a more detailed report." In practice:
- `pipeline_dashboard` provides archive stats via `computeArchiveStats()` (Done/Canceled beyond threshold).
- `project_hygiene` provides the same archive stats PLUS stale, orphaned, field gaps, WIP violations, and duplicate detection.

The two tools overlap on archive candidates. The skill should lead with `project_hygiene` and optionally supplement with `pipeline_dashboard` for the health warnings section (which `project_hygiene` does not generate). Currently the workflow is inverted.

### Finding 3: WIP limits are unconfigured by default

`findWipViolations()` requires caller-supplied `wipLimits`. The skill never passes them, so WIP violation detection is always empty unless the skill passes explicit values. The SKILL.md workflow has no step for configuring WIP limits, so this hygiene category is structurally dead for the default invocation.

### Finding 4: Duplicate detection threshold has a length-skew guard that may over-suppress

`findDuplicateCandidates()` skips pairs where the normalized length difference exceeds 50% of `maxLen`. This prevents "Add caching" from matching "Add caching to all API endpoints" — a correct guard for very different-length titles. However, for medium-length titles (e.g., 20 vs 30 chars), the skew guard may silently suppress real duplicates. The SKILL.md does not document this behavior, so operators cannot tune it.

### Finding 5: Archive confidence is timestamp-based, not context-aware

Archive candidates are selected purely by `closedAt/updatedAt` age against a hard 14-day threshold. There is no check for:
- Whether the issue has an open PR linked to it.
- Whether the issue is a parent with open sub-issues.
- Whether the issue has recent comments (activity after close).

The `DashboardItem` type does not carry these fields, so the current hygiene library cannot evaluate them without a schema extension.

### Finding 6: Skill description is not user-invocable but mentions triggering accuracy

The SKILL.md frontmatter sets `user-invocable: false`. The issue description references "description triggering quality" in the audit scope. For a non-user-invocable skill, the description field is not used for triggering — it matters only for skill catalog display. The description is: "Run project hygiene check - identify archive candidates, stale items, and board health issues. Use when you want to clean the board, check hygiene, find stale items, or archive old issues." This is accurate for catalog discovery, but the "Use when" phrasing is vestigial from user-invocable skills.

### Finding 7: XS estimate is appropriate

The skill has a narrow scope (one workflow, backed by two well-tested MCP tools). The improvements are content-level edits to SKILL.md (remove stale fallback, reorder steps, add WIP limit guidance) rather than new logic. XS is correct.

## Comparison to the 5-Step Audit Process (from #566)

| Audit Step | Status |
|---|---|
| 1. Read and analyze skill content for structural issues | Complete — findings 1, 2, 3 above |
| 2. Create 2-3 eval scenarios and run with/without skill | Not done (out of scope for research phase) |
| 3. Grade outputs against assertions | Not done (plan phase) |
| 4. Apply content improvements based on findings | Not done (impl phase) |
| 5. Optimize description for triggering accuracy | Identified: description is accurate for catalog but phrasing is off for non-user-invocable |

The research phase maps to step 1 and part of step 5.

## Potential Approaches for Plan Phase

### Approach A: Minimal content fix (recommended for XS)
- Remove the stale GH-158 fallback message from Step 3.
- Promote `project_hygiene` to the primary tool in Step 1; move `pipeline_dashboard` health warnings to a supplementary step.
- Add a WIP limits configuration note (e.g., "If RALPH_HYGIENE_WIP_LIMITS is set, pass parsed JSON as wipLimits parameter").
- Update "Use when" description phrasing to match non-user-invocable convention.

Pros: Stays within XS. Fixes the most visible staleness and workflow inversion.
Cons: Does not address archive confidence or duplicate detection gaps.

### Approach B: Extend with archive confidence signal
- Extend `DashboardItem` to include `subIssueCount` for archive context (already present — see `dashboard.ts` line 47).
- Add a check in `findArchiveCandidates()` to skip items where `subIssueCount > 0`.
- Update SKILL.md to surface this.

Pros: Reduces false positives (parents with open children should not be archived).
Cons: Requires library change + test; may push to S estimate.

### Approach C: WIP limits via env var
- Add `RALPH_HYGIENE_WIP_LIMITS` env var (JSON string) to the skill configuration block.
- Parse and pass to `project_hygiene` call.

Pros: Unblocks WIP violation detection for operators who want it.
Cons: JSON env vars are error-prone; low usage evidence.

## Risks

- Approach B (sub-issue check) notes that `subIssueCount` is already on `DashboardItem`, but `findArchiveCandidates()` in `hygiene.ts` receives a `DashboardItem[]` — it has access to the field. No schema change is needed; only a filter predicate change. Risk is low.
- The stale GH-158 fallback message is dead code — removing it is safe and lowers risk of operator confusion.
- Reordering steps 1 and 3 in SKILL.md changes which tool runs first. Both paths end at the same archive report; the risk of regression is low.

## Recommended Next Steps (for Plan)

1. Remove GH-158 fallback text from Step 3 of SKILL.md.
2. Restructure workflow: Step 1 → `project_hygiene` (primary), Step 2 → report all hygiene sections, Step 3 → supplement with `pipeline_dashboard` for health warnings only.
3. Add a note in the "Configuration" block documenting that WIP violations require explicit `wipLimits` — out of scope for XS but should be documented.
4. Optionally (if estimate expands to S): add sub-issue guard in `findArchiveCandidates()` to skip parents with `subIssueCount > 0`.
5. Clean up "Use when" description phrasing to match non-user-invocable skills.

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md` - Remove stale fallback, restructure step order, update description phrasing

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts` - project_hygiene tool registration and parameters
- `plugin/ralph-hero/mcp-server/src/lib/hygiene.ts` - Detection logic and types
- `plugin/ralph-hero/mcp-server/src/__tests__/hygiene.test.ts` - Test coverage baseline
- `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts` - archive_items tool behavior
- `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` - DashboardItem type, computeArchiveStats, ArchiveStats shape
