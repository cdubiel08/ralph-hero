---
date: 2026-02-20
github_issue: 140
github_url: https://github.com/cdubiel08/ralph-hero/issues/140
status: complete
type: research
---

# GH-140: Create `project_report` Skill Definition

## Problem Statement

The Ralph plugin needs a `project_report` skill that auto-generates project status update content by querying the pipeline dashboard (with metrics), composing a markdown report, determining health status, and posting it via `create_status_update`. This is the final piece of the GH-119 trilogy: GH-138 (create_status_update tool, Done), GH-139 (velocity metrics library, In Review), and GH-140 (this skill definition).

## Current State Analysis

### Existing Skill Patterns

Two reference skills provide the patterns to follow:

1. **`ralph-status`** ([skills/ralph-status/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-status/SKILL.md)) — simplest read-only skill. Uses `model: haiku`, no hooks, calls `pipeline_dashboard` and displays output. This is the closest analog but is read-only (no mutations).

2. **`ralph-triage`** ([skills/ralph-triage/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-triage/SKILL.md)) — more complex skill with hooks, fork context, and mutations. Uses branch-gate hooks and state-gate hooks.

### Available MCP Tools

The skill will compose calls to these existing tools:

1. **`ralph_hero__pipeline_dashboard`** ([tools/dashboard-tools.ts:234](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts#L234)) — generates pipeline status with phase counts, health warnings, and formatted output. Key params: `format` (json/markdown/ascii), `includeHealth`, `stuckThresholdHours`, `wipLimits`, `doneWindowDays`, `issuesPerPhase`. After GH-139 merges, adds `includeMetrics`, `velocityWindowDays`, `atRiskThreshold`, `offTrackThreshold`.

2. **`ralph_hero__create_status_update`** ([tools/project-management-tools.ts:905](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L905)) — posts a project-level status update visible in GitHub Projects UI. Params: `status` (ON_TRACK/AT_RISK/OFF_TRACK/INACTIVE/COMPLETE), `body` (markdown), `startDate`, `targetDate`.

3. **`ralph_hero__update_status_update`** ([tools/project-management-tools.ts:991](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L991)) — updates an existing status update.

### Metrics Library (GH-139, In Review via PR #214)

The velocity metrics library adds `lib/metrics.ts` with:
- `calculateVelocity(items, windowDays, now)` — count of Done items within time window
- `calculateRiskScore(warnings, weights)` — weighted sum of health warning severities
- `determineStatus(riskScore, config)` — maps score to ON_TRACK/AT_RISK/OFF_TRACK
- `extractHighlights(data, windowDays, now)` — recently completed and newly added items
- `calculateMetrics(items, data, config, now)` — orchestrator returning `MetricsResult`

The `pipeline_dashboard` tool exposes these via `includeMetrics: true`, returning a `metrics` block with `velocity`, `riskScore`, `status`, and `highlights`.

### Skill Frontmatter Pattern

From existing skills, the SKILL.md frontmatter supports:

| Field | Required | Description |
|-------|----------|-------------|
| `description` | Yes | Shown in skill discovery/help |
| `argument-hint` | No | Shown in autocomplete |
| `model` | No | Override model (haiku/sonnet/opus) |
| `context` | No | `fork` for isolated execution |
| `hooks` | No | PreToolUse/PostToolUse/Stop hooks |
| `env` | No | Environment variables |

## Key Discoveries

### 1. Skill Is Pure Orchestration — No Code Changes

The skill file is a markdown document that instructs the LLM how to compose tool calls. No TypeScript changes needed. The skill will:
1. Call `pipeline_dashboard` with `includeMetrics: true` and `format: "json"`
2. Compose a markdown report body from the structured response
3. Use the `metrics.status` field as the health designation
4. Call `create_status_update` with the composed body and status

### 2. Model Choice: Sonnet Is Appropriate

- `haiku` is used by `ralph-status` (trivial single-tool passthrough)
- `opus` is used by complex multi-step skills with codebase analysis
- `sonnet` is appropriate here: multi-tool orchestration with markdown composition but no codebase analysis or branching logic

### 3. No Hooks Required

The skill is non-destructive from a workflow perspective:
- No branch requirement (it reads project state, not git)
- No workflow state transitions (it posts status updates, not issue state changes)
- No postconditions to enforce beyond the status update being posted
- No fork context needed (stateless, no git operations)

### 4. Report Composition Strategy

The report body should include sections matching the parent issue (#119) requirements:
1. **Pipeline summary** — issue counts per workflow state (from `phases[]`)
2. **Velocity** — issues completed in the time window (from `metrics.velocity`)
3. **Health indicators** — warnings by severity (from `health.warnings[]`)
4. **Highlights** — recently completed and newly added (from `metrics.highlights`)
5. **Status** — auto-determined designation (from `metrics.status`)

### 5. Argument Design

The skill should accept optional arguments for:
- Time window override (default: 7 days from metrics config)
- Status override (to manually specify ON_TRACK/AT_RISK/OFF_TRACK instead of auto-determining)
- Dry run flag (generate report without posting)

The `ralph-status` skill pattern shows arguments are parsed from a simple string (e.g., `"markdown"` or `"json"`). A minimal approach: `[optional: --dry-run] [optional: --window N] [optional: --status ON_TRACK|AT_RISK|OFF_TRACK]`.

### 6. Naming: `ralph-report` vs `ralph-status`

The existing `ralph-status` is a read-only dashboard viewer. The new skill should be named `ralph-report` to distinguish it as the one that generates and posts reports. This aligns with the parent issue title "project_report" and avoids confusion with the read-only status viewer.

### 7. File Location

New file: `plugin/ralph-hero/skills/ralph-report/SKILL.md`

No other files need to be created — the skill is purely a markdown instruction document.

## Potential Approaches

### Approach A: Minimal Single-Step (Recommended)

Single workflow: call `pipeline_dashboard` with metrics, compose body, post status update. No intermediate artifacts or documents.

**Pros**: Simple, fast, XS scope, matches `ralph-status` simplicity.
**Cons**: No persistent report document (only stored as GitHub status update).

### Approach B: Report Document + Post

Write a report markdown file to `thoughts/shared/reports/`, then post the summary.

**Pros**: Creates audit trail of reports.
**Cons**: Overcomplicates an XS task, adds file management, not requested in the issue.

**Recommendation**: Approach A. The status update itself is the report. If users want historical reports, the GitHub Projects UI shows status update history.

## Risks

1. **GH-139 not merged yet** — the `includeMetrics` param won't exist until PR #214 merges. The skill definition can reference it since it will be available by the time the skill is used. If called before merge, the skill should gracefully fall back to dashboard-only data without metrics.

2. **Metric thresholds may need tuning** — the default thresholds (atRisk=2, offTrack=6) from GH-139 are reasonable starting points but may produce noisy results for small projects. The skill should pass thresholds through to the dashboard tool call.

## Recommended Next Steps

1. Create `plugin/ralph-hero/skills/ralph-report/SKILL.md` with:
   - Frontmatter: `model: sonnet`, `description` mentioning status report generation, `argument-hint` for options, `env: RALPH_COMMAND: "report"`
   - Workflow: parse args, call `pipeline_dashboard` (json + includeMetrics), compose markdown body, call `create_status_update`, display confirmation
   - Fallback logic if `includeMetrics` returns no metrics (GH-139 not yet deployed)
   - Dry run support (skip the `create_status_update` call)
