---
date: 2026-02-16
github_issue: 26
github_url: https://github.com/cdubiel08/ralph-hero/issues/26
status: complete
type: research
---

# Research: GH-26 - Workflow Visualization and Pipeline Status Dashboard

## Problem Statement

There is no quick-glance way to understand the current state of the Ralph pipeline. Users must manually query individual issues or scan GitHub Projects boards to assess pipeline health, identify bottlenecks, and track progress. The issue proposes:

1. A **pipeline snapshot** showing issue counts per workflow phase
2. An **issue flow board** with Kanban-style text representation
3. **Health indicators** for WIP limits, stuck issues, blocked dependencies, and pipeline gaps
4. A new MCP tool `ralph_hero__pipeline_dashboard` and a `/ralph-status` skill

## Current State Analysis

### Existing Data Infrastructure

The MCP server already has extensive data query and pipeline analysis tools that can serve as the foundation for a dashboard:

#### Data Retrieval Tools

| Tool | Location | Returns | Dashboard Use |
|------|----------|---------|---------------|
| `list_project_items` | [project-tools.ts:379-583](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L379-L583) | All project items with workflowState, estimate, priority, labels, assignees | Core data source - all issues with field values |
| `list_issues` | [issue-tools.ts:376-583](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L376-L583) | Filtered issues with sorting, up to 500 items | Filtered views by state/estimate/priority |
| `get_issue` | [issue-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts) | Single issue with full context, relationships, comments, group | Drill-down on specific issues |
| `list_sub_issues` | [relationship-tools.ts:170-269](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L170-L269) | Child issues with `subIssuesSummary` (total, completed, percentCompleted) | Epic/parent progress tracking |

#### Pipeline Analysis Tools

| Tool | Location | Returns | Dashboard Use |
|------|----------|---------|---------------|
| `detect_pipeline_position` | [issue-tools.ts:1468-1537](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1468-L1537) | Phase, convergence, remaining phases, group states | Per-issue/group pipeline position |
| `check_convergence` | [issue-tools.ts:1540-1672](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1540-L1672) | Converged status, blocking issues with `distanceToTarget` | Bottleneck identification |
| `pick_actionable_issue` | [issue-tools.ts:1675-1906](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1675-L1906) | Highest-priority unblocked issue, alternatives count | Work queue depth |
| `detect_group` | [relationship-tools.ts:529-557](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L529-L557) | Group members in topological order | Group progress tracking |

#### State Machine Constants

[workflow-states.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts) provides:
- `STATE_ORDER`: Canonical progression (Backlog -> Research Needed -> ... -> Done) - 9 ordered states
- `TERMINAL_STATES`: Done, Canceled
- `LOCK_STATES`: Research in Progress, Plan in Progress, In Progress
- `HUMAN_STATES`: Human Needed, Plan in Review
- `VALID_STATES`: All 11 states
- Helper functions: `stateIndex()`, `compareStates()`, `isEarlierState()`

#### Pipeline Detection Logic

[pipeline-detection.ts:98-323](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L98-L323) implements priority-based phase detection with 12 rules and convergence tracking via `ConvergenceInfo`:
```typescript
interface ConvergenceInfo {
  required: boolean;
  met: boolean;
  blocking: Array<{ number: number; state: string }>;
  recommendation: "proceed" | "wait" | "escalate";
}
```

### What Does NOT Exist

1. **No aggregation across all issues** - existing tools query per-issue or per-filter, never aggregate counts by state
2. **No health indicator logic** - no WIP limits, no "stuck issue" detection, no pipeline gap analysis
3. **No formatted output** - all tools return raw JSON, no markdown/ASCII rendering
4. **No `/ralph-status` skill** - would be the first read-only skill in the system (all 9 existing skills modify state)
5. **No time-based analysis** - no tracking of how long issues have been in a state

## Key Discoveries

### 1. `list_project_items` is the Natural Data Source

The `list_project_items` tool ([project-tools.ts:379-583](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L379-L583)) already fetches all project items with their workflow state, estimate, priority, labels, and assignees. A dashboard tool can:
- Call the same underlying GraphQL query
- Group items by `workflowState` to produce counts per phase
- Calculate derived metrics (WIP, blocked counts, etc.)

The pagination system ([pagination.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pagination.ts)) supports fetching up to 500 items, which is sufficient for most projects.

### 2. Tool Registration Pattern is Well-Established

From [index.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts), tools follow a consistent pattern:
- Registration functions: `registerXTools(server, client, fieldCache)`
- Schema validation via Zod
- Response via `toolSuccess()` / `toolError()` from [types.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts)
- Error handling: `try/catch` with typed error narrowing

A new `pipeline_dashboard` tool could either:
- Be added to `issue-tools.ts` alongside other pipeline tools, or
- Live in a new `dashboard-tools.ts` file registered from `index.ts`

### 3. Skill Frontmatter Pattern is Lightweight

All skills in `plugin/ralph-hero/skills/` are single `SKILL.md` files with YAML frontmatter. A read-only `/ralph-status` skill would be the simplest skill definition:
```yaml
---
description: Display pipeline status dashboard with health indicators
argument-hint: [optional: format (markdown|ascii|json)]
model: haiku
env:
  RALPH_COMMAND: "status"
---
```

No hooks needed (no state mutations). The skill body would simply instruct Claude to call `pipeline_dashboard` and format the output.

### 4. `updatedAt` Enables "Stuck Issue" Detection

The `list_project_items` and `list_issues` responses include `updatedAt` timestamps. Comparing `Date.now() - updatedAt` against a configurable threshold (e.g., 48 hours) identifies stale issues in non-terminal states. The `createdAt` field can track overall cycle time.

### 5. Rate Limit Considerations

A dashboard fetching all project items in one call costs approximately:
- 1 paginated query (~1-5 pages at 100 items each) = ~5-25 rate limit points
- This is well within the 5000 points/hour budget
- The rate limiter ([rate-limiter.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/rate-limiter.ts)) auto-pauses when quota is low
- Session cache ([cache.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts)) can cache dashboard data with a short TTL (e.g., 60 seconds)

### 6. No External Dependencies Needed

The dashboard can be built entirely with existing infrastructure:
- GitHub Projects V2 GraphQL API (already integrated)
- Existing pagination, caching, and rate limiting systems
- `STATE_ORDER` constant for canonical phase ordering
- `LOCK_STATES`, `TERMINAL_STATES`, `HUMAN_STATES` for classification

## Potential Approaches

### Approach A: Single MCP Tool with Format Parameter (Recommended)

Create one `ralph_hero__pipeline_dashboard` tool that returns structured data with optional formatted output.

**Parameters:**
- `format`: `"json"` | `"markdown"` | `"ascii"` (default: `"json"`)
- `include_health`: boolean (default: `true`)
- `stuck_threshold_hours`: number (default: `48`)
- `wip_limits`: optional object (`{ "In Progress": 3, "Research in Progress": 2 }`)

**Response structure:**
```typescript
{
  snapshot: {
    generated_at: string,
    total_issues: number,
    phases: Array<{
      state: string,
      count: number,
      issues: Array<{ number, title, priority, estimate, assignees, age_hours }>
    }>
  },
  health: {
    ok: boolean,
    warnings: Array<{
      type: "wip_exceeded" | "stuck_issue" | "blocked" | "pipeline_gap" | "lock_collision",
      severity: "warning" | "critical",
      message: string,
      issues?: number[]
    }>
  },
  formatted?: string  // Pre-rendered markdown/ASCII if format != "json"
}
```

**Pros:**
- Single tool serves all use cases (CLI, skill, programmatic)
- Structured JSON enables downstream processing
- Optional formatted output avoids forcing Claude to render tables
- Health checks are configurable per project

**Cons:**
- Larger response payload
- Format rendering logic adds complexity

### Approach B: Separate Tools for Snapshot and Health

Split into `pipeline_snapshot` (counts + board) and `pipeline_health` (warnings + analysis).

**Pros:**
- Smaller, focused responses
- Can call health check independently without full snapshot

**Cons:**
- Two API calls to get full dashboard
- Duplicate data fetching (both need all issues)
- More tool surface area to maintain

### Approach C: Enhance Existing Tools

Add aggregation options to `list_project_items` (e.g., `group_by: "workflowState"`) and health checks to `detect_pipeline_position`.

**Pros:**
- No new tools
- Builds on proven implementations

**Cons:**
- Overloads existing tools with orthogonal concerns
- `list_project_items` is for listing, not aggregating
- Harder to evolve independently

## Implementation Considerations

### Dashboard Data Flow

```
list_project_items (GraphQL)
  → fetch all items with field values
  → group by workflowState
  → compute counts per phase
  → detect health issues (stuck, WIP, blocked, gaps)
  → format output (json/markdown/ascii)
```

### Health Indicator Logic

| Indicator | Detection Method | Severity |
|-----------|-----------------|----------|
| WIP limit exceeded | `count(state) > wip_limits[state]` | warning |
| Stuck issue | `now - updatedAt > threshold` in non-terminal state | warning (>48h) / critical (>96h) |
| Blocked issue | Issue has `blockedBy` with non-Done blocker | warning |
| Pipeline gap | A non-terminal phase has 0 issues | info |
| Lock collision | Multiple issues in same LOCK_STATE | critical |
| Oversized in pipeline | M/L/XL estimate past Backlog | warning |

### Markdown Format Example

```markdown
## Pipeline Status (2026-02-16 14:30 UTC)

| Phase | Count | Issues |
|-------|-------|--------|
| Backlog | 12 | #42, #43, #44... |
| Research Needed | 4 | #38, #39, #40, #41 |
| Research in Progress | 2 | #36 (P1), #37 (P2) |
| Ready for Plan | 3 | #33, #34, #35 |
| Plan in Progress | 1 | #32 (P1) |
| Plan in Review | 0 | - |
| In Progress | 2 | #30 (P0), #31 (P1) |
| In Review | 1 | #29 |
| Done (this week) | 6 | #23-#28 |

### Health Warnings
- **WIP exceeded**: In Progress has 2 issues (limit: 1)
- **Stuck**: #36 has been in Research in Progress for 72 hours
- **Blocked**: #40 blocked by #39 (Research Needed)
```

### ASCII Format Example

```
Pipeline Status (2026-02-16)
════════════════════════════
Backlog          ████████████ 12
Research Needed  ████ 4
Research in Prog ██ 2
Ready for Plan   ███ 3
Plan in Progress █ 1
Plan in Review   ░ 0
In Progress      ██ 2
In Review        █ 1
Done (this week) ██████ 6

Health: 2 warnings
  ⚠ WIP exceeded: In Progress (2/1)
  ⚠ Stuck: #36 in Research in Progress (72h)
```

### File Placement

- **MCP tool**: `mcp-server/src/tools/dashboard-tools.ts` (new file, following existing pattern)
- **Registration**: Add `registerDashboardTools(server, client, fieldCache)` to `index.ts`
- **Skill**: `skills/ralph-status/SKILL.md` (new directory + file)

### Skill Design

The `/ralph-status` skill would be the **first read-only skill** in the ralph-hero plugin. It needs no hooks, no branch validation, and no state transitions. The skill body instructs Claude to:
1. Call `ralph_hero__pipeline_dashboard` with the requested format
2. Display the output to the user
3. Optionally highlight critical health warnings

## Risks and Considerations

1. **Response size**: A project with 100+ issues could produce a large response. The tool should support a `limit` parameter for per-phase issue listing and default to showing only counts with top issues by priority.

2. **Cache staleness**: Dashboard data should use short-lived caching (60s TTL) to balance freshness with rate limits. The `SessionCache` already supports configurable TTL.

3. **"Done" filtering**: Completed issues accumulate indefinitely. The tool should filter "Done" issues to a recent window (e.g., last 7 days) to keep the snapshot relevant. `closedAt` timestamp can be used for this.

4. **Format rendering in MCP**: The MCP protocol returns JSON strings. Formatted markdown/ASCII must be embedded as a string field in the JSON response. Claude can then display it directly.

5. **No time-tracking fields in GitHub Projects**: GitHub Projects V2 doesn't have native "time in state" tracking. The tool must infer staleness from `updatedAt`, which may not reflect the last state change specifically. A more accurate approach would track state change timestamps via audit comments (which #19's `handoff_ticket` would provide).

6. **NPM publish required**: Adding a new tool requires building and publishing a new version of `ralph-hero-mcp-server`.

7. **Dependency on #19**: If `handoff_ticket` (#19) lands first and adds audit comments on every state transition, the dashboard could parse these comments for precise "time in state" calculations. Without #19, `updatedAt` is the best available proxy.

## Recommended Next Steps

1. **Phase 1**: Create `dashboard-tools.ts` with `ralph_hero__pipeline_dashboard` tool. Implement snapshot (counts per phase, issue listing) and health indicators (stuck, WIP, blocked, gaps). Support `json`, `markdown`, and `ascii` output formats.

2. **Phase 2**: Create `skills/ralph-status/SKILL.md` as a minimal read-only skill that calls the dashboard tool and displays results.

3. **Phase 3**: Add tests for dashboard aggregation logic, health indicator detection, and format rendering.

4. **Phase 4**: Build, bump version, publish.

The implementation should reuse existing pagination and field extraction patterns from `list_project_items` and leverage `STATE_ORDER` from `workflow-states.ts` for canonical phase ordering.
