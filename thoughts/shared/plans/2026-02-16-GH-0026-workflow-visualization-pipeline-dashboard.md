---
date: 2026-02-16
status: draft
github_issue: 26
github_url: https://github.com/cdubiel08/ralph-hero/issues/26
---

# Workflow Visualization and Pipeline Status Dashboard

## Overview

Add a `ralph_hero__pipeline_dashboard` MCP tool that generates a pipeline status snapshot with issue counts per workflow phase, per-issue listings, and configurable health indicators (WIP limits, stuck issues, blocked dependencies, pipeline gaps). Support `json`, `markdown`, and `ascii` output formats. Create a lightweight `/ralph-status` skill as the first read-only skill in the plugin.

## Current State Analysis

### Existing Infrastructure (~80% Ready)

| Component | Location | Reuse for Dashboard |
|-----------|----------|-------------------|
| `list_project_items` | [project-tools.ts:379-583](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L379-L583) | GraphQL query pattern for fetching all items with field values |
| `STATE_ORDER` | [workflow-states.ts:12-22](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts#L12-L22) | Canonical phase ordering for snapshot rows |
| `LOCK_STATES`, `TERMINAL_STATES`, `HUMAN_STATES` | [workflow-states.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts) | State classification for health indicators |
| `paginateConnection` | [pagination.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pagination.ts) | Fetch up to 500 items across pages |
| `FieldOptionCache` | [cache.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts) | Resolve field/option names to IDs |
| `SessionCache` | [cache.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts) | Cache dashboard data with short TTL |
| Skill frontmatter pattern | [skills/ralph-setup/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-setup/SKILL.md) | Pattern for `/ralph-status` skill definition |

### What Does NOT Exist

1. **No aggregation** — existing tools return per-issue data, never counts-by-state
2. **No health indicator logic** — no WIP limits, stuck detection, gap analysis
3. **No formatted output** — all tools return raw JSON
4. **No read-only skill** — all 9 existing skills modify state
5. **No time-based analysis** — no "time in state" tracking (`updatedAt` is the best proxy)

## Desired End State

1. `ralph_hero__pipeline_dashboard` tool returns structured snapshot + health data
2. Three output formats: `json` (structured), `markdown` (tables), `ascii` (bar chart)
3. Health indicators detect: WIP exceeded, stuck issues, blocked issues, pipeline gaps, lock collisions, oversized estimates
4. `/ralph-status` skill calls the dashboard tool and displays results
5. Dashboard data cached for 60 seconds to avoid redundant queries

### Verification
- [ ] `npm run build` compiles with no type errors
- [ ] `npm test` passes with new dashboard tests
- [ ] `pipeline_dashboard` with `format: "json"` returns structured data with phase counts
- [ ] `pipeline_dashboard` with `format: "markdown"` returns renderable table
- [ ] `pipeline_dashboard` with `format: "ascii"` returns bar chart
- [ ] Health indicators detect stuck issues (configurable threshold)
- [ ] `/ralph-status` skill invocation displays dashboard output

## What We're NOT Doing

- Not building a web UI — text-based output only (json/markdown/ascii)
- Not adding persistent time-in-state tracking (would need database or GitHub Action; `updatedAt` is sufficient)
- Not creating GitHub Actions for automated status posts
- Not adding trend/historical data (single point-in-time snapshot)
- Not implementing configurable per-project dashboards (single project scope from env vars)

## Implementation Approach

Build a single `pipeline_dashboard` tool in a new `dashboard-tools.ts` module. Extract aggregation and formatting logic into testable pure functions in `lib/dashboard.ts`. Create a minimal `/ralph-status` skill wrapper.

---

## Phase 1: Dashboard Data Aggregation and Health Logic

### Overview

Create the core aggregation and health analysis logic as pure functions in a library module. These functions take raw project items and produce structured dashboard data — no I/O, fully testable.

### Changes Required

#### 1. Create dashboard library module

**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` (NEW)

**Types**:

```typescript
export interface PhaseSnapshot {
  state: string;
  count: number;
  issues: Array<{
    number: number;
    title: string;
    priority: string | null;
    estimate: string | null;
    assignees: string[];
    ageHours: number;        // hours since updatedAt
    isLocked: boolean;
  }>;
}

export interface HealthWarning {
  type: "wip_exceeded" | "stuck_issue" | "blocked" | "pipeline_gap" | "lock_collision" | "oversized_in_pipeline";
  severity: "info" | "warning" | "critical";
  message: string;
  issues: number[];
}

export interface DashboardData {
  generatedAt: string;        // ISO timestamp
  totalIssues: number;
  phases: PhaseSnapshot[];
  health: {
    ok: boolean;
    warnings: HealthWarning[];
  };
}

export interface HealthConfig {
  stuckThresholdHours: number;       // default: 48
  criticalStuckHours: number;        // default: 96
  wipLimits: Record<string, number>; // default: {}
  doneWindowDays: number;            // default: 7 (only show Done from last N days)
}
```

**Functions**:

- `aggregateByPhase(items, now)` — Groups project items by workflow state using `STATE_ORDER` for ordering. Returns `PhaseSnapshot[]`. Each issue includes `ageHours` computed from `now - updatedAt`. Issues within each phase sorted by priority (P0 first). "Done" and "Canceled" filtered to items within `doneWindowDays`.

- `detectHealthIssues(phases, config)` — Scans phases for health problems:
  - **`wip_exceeded`**: Phase count exceeds `wipLimits[state]` — severity `warning`
  - **`stuck_issue`**: Issue `ageHours` > `stuckThresholdHours` in non-terminal, non-human state — severity `warning` (>threshold) or `critical` (>criticalStuckHours)
  - **`blocked`**: Issue has `blockedBy` with non-Done blocker (requires blockedBy data in items) — severity `warning`
  - **`pipeline_gap`**: Non-terminal phase (excluding Backlog and Human Needed) has 0 issues — severity `info`
  - **`lock_collision`**: Multiple issues in same `LOCK_STATE` — severity `critical`
  - **`oversized_in_pipeline`**: Issue with M/L/XL estimate past Backlog state — severity `warning`

- `buildDashboard(items, config, now)` — Orchestrator: calls `aggregateByPhase` then `detectHealthIssues`, returns `DashboardData`.

All functions are pure (no I/O, no side effects). The `items` input matches the shape already returned by the `list_project_items` query pattern (project items with content + field values).

### Success Criteria

#### Automated Verification
- [x] `npm run build` compiles with no type errors
- [ ] Unit tests pass for all aggregation and health detection functions (see Phase 3)

#### Manual Verification
- [x] `aggregateByPhase` groups items by state in `STATE_ORDER` order
- [x] Health detection correctly identifies each indicator type

**Dependencies created for Phase 2**: `DashboardData` types and `buildDashboard` function

---

## Phase 2: MCP Tool and Output Formatters

### Overview

Create the `ralph_hero__pipeline_dashboard` MCP tool in a new `dashboard-tools.ts` module. Implement `json`, `markdown`, and `ascii` output formatters. Register the tool in `index.ts`.

### Changes Required

#### 1. Create output formatters

**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` (add to Phase 1 file)

Add formatting functions:

- `formatMarkdown(data: DashboardData)` — Renders a markdown string with:
  - Header with timestamp
  - Table: Phase | Count | Issues (top 5 per phase by priority, with `#N (P0, XS)` format)
  - Health Warnings section with bullet list
  - Returns `string`

- `formatAscii(data: DashboardData)` — Renders an ASCII bar chart with:
  - Header with timestamp
  - Bar chart: phase name (left-padded to 20 chars) + blocks (`█` × count, proportional to max) + count
  - Health summary: `N warnings` with one-line details
  - Returns `string`

Both formatters are pure functions (string in, string out).

#### 2. Create dashboard tools module

**File**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` (NEW)

**`ralph_hero__pipeline_dashboard` tool**:

**Parameters** (zod schema):
- `owner` (optional string) — GitHub owner, defaults to env
- `format` (optional enum: `"json" | "markdown" | "ascii"`, default: `"json"`) — output format
- `includeHealth` (optional boolean, default: `true`) — include health indicators
- `stuckThresholdHours` (optional number, default: `48`) — hours before flagging stuck issues
- `wipLimits` (optional record of string→number) — per-state WIP limits (e.g., `{ "In Progress": 3 }`)
- `doneWindowDays` (optional number, default: `7`) — only show Done issues from last N days
- `issuesPerPhase` (optional number, default: `10`) — max issues to list per phase

**Logic flow**:

1. Resolve project config (owner, project number)
2. Ensure field cache populated
3. Fetch all project items using same paginated query pattern as `list_project_items` — include `updatedAt`, `closedAt`, `trackedIssues` (blockedBy) in the content fragment
4. Call `buildDashboard(items, config, Date.now())` from `lib/dashboard.ts`
5. Truncate issue lists per phase to `issuesPerPhase`
6. If `format` is `"markdown"` or `"ascii"`, call the corresponding formatter and include as `formatted` field
7. Return `toolSuccess({ ...dashboardData, formatted? })`

#### 3. Register in server

**File**: `plugin/ralph-hero/mcp-server/src/index.ts`

- Add import: `import { registerDashboardTools } from "./tools/dashboard-tools.js";`
- Add registration after batch tools (or after relationship tools if #21 hasn't landed):
  ```typescript
  // Dashboard and pipeline visualization tools
  registerDashboardTools(server, client, fieldCache);
  ```

#### 4. Create /ralph-status skill

**File**: `plugin/ralph-hero/skills/ralph-status/SKILL.md` (NEW)

```markdown
---
description: Display pipeline status dashboard with health indicators. Shows issue counts per workflow phase, identifies stuck issues, WIP violations, and blocked dependencies. First read-only skill - no state changes.
argument-hint: "[optional: markdown|ascii|json]"
model: haiku
env:
  RALPH_COMMAND: "status"
---

# Ralph Pipeline Status

Display the current pipeline status dashboard.

## Usage

Call the `ralph_hero__pipeline_dashboard` tool with the requested format:

1. Parse the argument (if provided) as the output format. Default to `markdown`.
2. Call `ralph_hero__pipeline_dashboard` with:
   - `format`: parsed format or `"markdown"`
   - `includeHealth`: true
3. Display the `formatted` field (for markdown/ascii) or the structured data (for json).
4. If health warnings exist with severity `critical`, highlight them prominently.

## Output

Display the dashboard output directly. Do not add additional commentary unless there are critical health warnings.
```

### Success Criteria

#### Automated Verification
- [x] `npm run build` compiles with no type errors
- [x] `npm test` passes
- [x] `pipeline_dashboard` with `format: "json"` returns structured `DashboardData`
- [x] `pipeline_dashboard` with `format: "markdown"` returns data + `formatted` string with markdown table
- [x] `pipeline_dashboard` with `format: "ascii"` returns data + `formatted` string with bar chart

#### Manual Verification
- [x] Markdown output renders correctly when pasted into GitHub
- [x] ASCII output is readable in terminal
- [x] `/ralph-status` skill displays dashboard
- [x] Health warnings appear when conditions are met

**Depends on**: Phase 1 (aggregation and health logic)

---

## Phase 3: Tests

### Overview

Add unit tests for the dashboard aggregation, health detection, and formatting functions. Since all core logic is in pure functions (`lib/dashboard.ts`), testing is straightforward with no mocking required for the logic layer.

### Changes Required

#### 1. Dashboard unit tests

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts` (NEW)

Test suites:

**`aggregateByPhase`**:
- Groups items correctly by workflow state
- Orders phases by `STATE_ORDER`
- Sorts issues within phase by priority (P0 first)
- Computes `ageHours` correctly from `updatedAt`
- Filters "Done" items to within `doneWindowDays`
- "Canceled" items grouped separately from "Done"
- Items without workflow state grouped into "Unknown"
- Empty project returns empty phases with 0 counts

**`detectHealthIssues`**:
- `wip_exceeded`: detects when phase count > limit
- `wip_exceeded`: no warning when at or below limit
- `stuck_issue` warning: issue > 48h in non-terminal state
- `stuck_issue` critical: issue > 96h
- `stuck_issue`: does not flag terminal states
- `stuck_issue`: does not flag "Human Needed" (human action expected)
- `blocked`: detects issue with open blocker
- `blocked`: ignores resolved (Done) blockers
- `pipeline_gap`: flags empty non-terminal phases (excluding Backlog, Human Needed)
- `pipeline_gap`: does not flag empty Backlog or Human Needed
- `lock_collision`: detects 2+ issues in same lock state
- `lock_collision`: ok with 1 issue per lock state
- `oversized_in_pipeline`: M/L/XL past Backlog flagged
- `oversized_in_pipeline`: M/L/XL in Backlog not flagged
- Multiple warnings returned correctly
- `health.ok` is `true` when no warnings

**`formatMarkdown`**:
- Produces table with Phase/Count/Issues columns
- Includes health warnings section
- Includes timestamp header
- Handles 0-count phases
- Truncates long issue lists with "..."

**`formatAscii`**:
- Produces bar chart with proportional bars
- Shows health summary line
- Handles 0-count phases (shows `░`)
- Includes timestamp header

**`buildDashboard`** (integration of aggregation + health):
- End-to-end: items in → full `DashboardData` out
- With default config
- With custom WIP limits

### Success Criteria

#### Automated Verification
- [ ] `npm test` passes all new tests
- [ ] All health indicator types tested with positive and negative cases
- [ ] Both formatters tested for output structure

#### Manual Verification
- [ ] Test output clean with descriptive names

**Depends on**: Phase 1 (functions under test), Phase 2 (formatters)

---

## Testing Strategy

### Unit Tests (Phase 3)
- Pure function tests for aggregation, health detection, formatting
- No mocking needed for `lib/dashboard.ts` functions
- Mock `GitHubClient` for tool-level integration tests (optional, lower priority)

### Manual Testing
1. Build: `cd plugin/ralph-hero/mcp-server && npm run build`
2. Call `pipeline_dashboard` with `format: "markdown"` — verify table renders
3. Call with `format: "ascii"` — verify bar chart in terminal
4. Call with `format: "json"` — verify structured response
5. Create artificial conditions (stuck issue, WIP overflow) — verify health warnings
6. Invoke `/ralph-status` — verify skill displays output

## Performance Considerations

- Dashboard fetches all project items in 1-5 paginated queries (~5-25 rate limit points)
- Well within 5000 points/hour budget
- Cache dashboard query result for 60 seconds via `SessionCache` to handle repeated calls
- Response size controlled by `issuesPerPhase` parameter (default 10)

## File Ownership Summary

| Phase | Key Files (NEW) | Key Files (MODIFIED) |
|-------|-----------------|---------------------|
| 1 | `lib/dashboard.ts` | — |
| 2 | `tools/dashboard-tools.ts`, `skills/ralph-status/SKILL.md` | `index.ts` |
| 3 | `__tests__/dashboard.test.ts` | — |

## References

- [Issue #26](https://github.com/cdubiel08/ralph-hero/issues/26) — Workflow visualization
- [Research document](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-16-GH-0026-workflow-visualization-pipeline-dashboard.md)
- [list_project_items pattern](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L379-L583)
- [STATE_ORDER](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts#L12-L22)
- [pipeline-detection.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts)
