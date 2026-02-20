---
date: 2026-02-20
status: draft
github_issues: [140]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/140
primary_issue: 140
---

# Create `project_report` Skill Definition - Atomic Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-140 | Create `project_report` skill definition | XS |

## Current State Analysis

The Ralph plugin has two reference skill patterns:
- **`ralph-status`** (`skills/ralph-status/SKILL.md`): Simplest skill. Model: haiku, no hooks, single tool call to `pipeline_dashboard`, read-only display. This is the closest analog.
- **`ralph-triage`** (`skills/ralph-triage/SKILL.md`): Complex skill with hooks, fork context, branch gates, state gates. Used for mutation-heavy workflows.

Dependencies for GH-140 are resolved:
- **GH-138** (Done): `ralph_hero__create_status_update` tool in `project-management-tools.ts` — accepts `status` enum (ON_TRACK/AT_RISK/OFF_TRACK/INACTIVE/COMPLETE), `body` (markdown), optional `startDate`/`targetDate`
- **GH-139** (In Review, PR #214): `pipeline_dashboard` gains `includeMetrics: true` returning `metrics` block with `velocity`, `riskScore`, `status` (ProjectHealthStatus), and `highlights` (recentlyCompleted/newlyAdded)

## Desired End State
### Verification
- [ ] `skills/ralph-report/SKILL.md` exists with valid YAML frontmatter
- [ ] Frontmatter includes: description, argument-hint, model (sonnet), env (RALPH_COMMAND: "report")
- [ ] Workflow steps reference correct MCP tool names and parameters
- [ ] Report template includes all 5 required sections: pipeline summary, velocity, health indicators, highlights, status
- [ ] Dry-run mode documented (generate without posting)
- [ ] Graceful fallback when `includeMetrics` is unavailable

## What We're NOT Doing
- TypeScript code changes (pure skill definition file)
- Hooks (non-destructive skill, no workflow state transitions)
- Fork context (stateless, no git operations)
- Persistent report documents (status update IS the report)
- Historical report archives

## Implementation Approach

Create a single SKILL.md file following the `ralph-status` pattern but with multi-step orchestration: parse arguments, call `pipeline_dashboard` with metrics, compose a markdown report body, call `create_status_update`, display confirmation. Use model `sonnet` (multi-tool orchestration without codebase analysis).

---

## Phase 1: GH-140 — Create `project_report` Skill Definition
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/140 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0140-project-report-skill-definition.md

### Changes Required

#### 1. New file: `skills/ralph-report/SKILL.md`
**File**: `plugin/ralph-hero/skills/ralph-report/SKILL.md`

**Frontmatter:**
```yaml
---
description: Generate and post a project status report. Queries pipeline dashboard with velocity metrics, composes a markdown report, auto-determines health status, and posts via GitHub Projects V2 status updates.
argument-hint: "[optional: --dry-run] [optional: --window N] [optional: --status ON_TRACK|AT_RISK|OFF_TRACK]"
model: sonnet
env:
  RALPH_COMMAND: "report"
---
```

Key decisions:
- **model: sonnet** — multi-tool orchestration with markdown composition, no codebase analysis needed
- **No hooks** — non-destructive (reads pipeline, posts status update, no workflow state changes)
- **No `context: fork`** — stateless, no git operations
- **RALPH_COMMAND: "report"** — distinguishes from "status" (read-only dashboard viewer)

**Workflow steps in the SKILL.md body:**

1. **Parse arguments**: Extract `--dry-run`, `--window N` (default 7), `--status OVERRIDE` from argument string
2. **Fetch dashboard with metrics**: Call `ralph_hero__pipeline_dashboard` with:
   - `format: "json"`
   - `includeHealth: true`
   - `includeMetrics: true`
   - `doneWindowDays: N` (from `--window` arg or default 7)
   - `velocityWindowDays: N` (same value)
3. **Handle metrics fallback**: If response has no `metrics` field (GH-139 not deployed), compute basic status from `health.ok` (true = ON_TRACK, false with critical warnings = OFF_TRACK, else AT_RISK)
4. **Compose markdown report body** with these sections:
   - **Pipeline Summary**: Table of non-empty phases with counts from `phases[]`
   - **Velocity**: `metrics.velocity` items completed in last N days
   - **Health Indicators**: List `health.warnings[]` grouped by severity
   - **Highlights**: `metrics.highlights.recentlyCompleted` and `metrics.highlights.newlyAdded`
   - **Status**: The auto-determined designation from `metrics.status`
5. **Determine status**: Use `metrics.status` unless `--status` override provided
6. **Post or display**:
   - If `--dry-run`: Display the composed report and determined status without posting
   - Otherwise: Call `ralph_hero__create_status_update` with `status` and `body`
7. **Display confirmation**: Show the posted status update ID, status, and a truncated preview of the body

**Report body template** (to be included in SKILL.md):
```markdown
# Project Status Report

_Generated: {generatedAt}_

## Pipeline Summary

| Phase | Count |
|-------|------:|
| {state} | {count} |
...

**Total**: {totalIssues} issues

## Velocity

{velocity} issues completed in the last {windowDays} days.

## Health Indicators

{if warnings exist: list by severity}
{if no warnings: "All clear - no health warnings."}

## Highlights

**Recently Completed:**
{list recentlyCompleted items or "None in this window."}

**Newly Added:**
{list newlyAdded items or "None in this window."}

## Status: {STATUS}

Auto-determined based on risk score: {riskScore}
```

### Success Criteria
- [ ] Automated: File exists at `plugin/ralph-hero/skills/ralph-report/SKILL.md`
- [ ] Automated: YAML frontmatter is valid (parseable)
- [ ] Manual: Skill appears in `/ralph-report` autocomplete
- [ ] Manual: `/ralph-report --dry-run` generates report without posting
- [ ] Manual: `/ralph-report` posts status update to GitHub Projects

---

## Integration Testing
- [ ] Skill file exists and has valid frontmatter
- [ ] Skill is discoverable via Claude Code skill system
- [ ] Dry-run produces report output without side effects
- [ ] Full run posts to GitHub Projects V2 status updates

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0140-project-report-skill-definition.md
- Reference skill: [plugin/ralph-hero/skills/ralph-status/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-status/SKILL.md)
- Dashboard tool: [plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts)
- Status update tool: [plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts:905](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L905)
- Metrics library: [plugin/ralph-hero/mcp-server/src/lib/metrics.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/metrics.ts) (PR #214)
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/119
- Related: GH-138 (create_status_update tool, Done), GH-139 (velocity metrics, PR #214)
