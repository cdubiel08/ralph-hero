---
date: 2026-05-05
status: draft
type: plan
tags: [metrics, dashboard, time-series, observability, snapshots]
github_issue: 1019
github_issues: [1019]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1019
primary_issue: 1019
---

# Track Product Performance Over Time Implementation Plan

## Prior Work

- builds_on:: [[2026-02-16-GH-0020-pipeline-analytics]]
- builds_on:: [[2026-02-20-GH-0139-velocity-metrics-auto-status]]
- builds_on:: [[2026-02-21-GH-0146-cross-project-aggregation-health]]

## Overview

Add a lightweight time-series capture layer so any product (GitHub Project) using ralph-hero can be tracked over time: velocity, throughput per phase, cycle time, WIP, and health/risk score. Snapshots are written as append-only JSONL under `~/.ralph-hero/snapshots/`, queried by a new MCP tool, and surfaced through a `trends` skill that renders week-over-week deltas and ASCII sparklines.

## Current State Analysis

ralph-hero already produces all the data needed for performance tracking — it just doesn't persist it.

- `lib/dashboard.ts:buildDashboard()` returns a complete `DashboardData` per call (phases, WIP, health, archive stats).
- `lib/metrics.ts:calculateMetrics()` (`mcp-server/src/lib/metrics.ts:147`) returns `{ velocity, riskScore, status, highlights }` for a configurable window (default 7d).
- `lib/transition-comments.ts` (shipped under GH-20) exposes `parseAllTransitions()` which yields `{ from, to, at }` per issue — sufficient for cycle-time math, but no caller uses it for analytics yet.
- `create_status_update` posts a status update to GitHub Projects V2; GitHub stores the history but the body is freeform markdown — not a structured time series.
- The `report` skill composes a one-shot status post; there is no record of prior snapshots and no trend computation.
- No local persistence layer exists (the codebase is otherwise stateless against the GitHub source of truth).

Reference deps in the project: dream-loop already establishes the `~/.ralph-hero/<thing>` convention (`~/.ralph-hero/knowledge.db`, `~/.ralph-hero/cursors/`) and a launchd plist template pattern at `scripts/dream/launchd/com.dubiel.dream-loop.plist.template`.

### Key Discoveries

- `DashboardData.phases[].issues[]` already includes `ageHours`, `closedAt`, `updatedAt` — adequate for derived throughput without extra GraphQL calls.
- `parseAllTransitions()` returns timestamps but only for issues that already have `<!-- ralph-transition: ... -->` or audit-format comments — so cycle time is best-effort and improves over time as transitions accumulate.
- `MetricsConfig` is already extracted as a pure-functions module — a snapshotting wrapper does not need to touch the existing dashboard tool.
- Multi-project support is keyed by `projectNumber`; snapshots must be partitioned by `(owner, projectNumber)` to support `RALPH_GH_PROJECT_NUMBERS`.
- Status updates posted via `create_status_update` are visible in the GitHub UI but not queryable as structured time-series — local JSONL is the simpler primary store.

## Desired End State

A user running ralph-hero against any GitHub Project can:

1. Run `/ralph-hero:trends` (or call `metrics_trends` directly) and see velocity, throughput, cycle-time, WIP, and risk-score trends with 1d / 7d / 30d deltas plus ASCII sparklines.
2. Optionally install a launchd plist that captures a snapshot daily at 06:00 local time.
3. Inspect the raw JSONL at `~/.ralph-hero/snapshots/<owner>/<project>.jsonl` (one row per snapshot, schema-versioned).

Verifiable end state:

- `npm test` passes including new suites in `mcp-server/src/__tests__/snapshots.test.ts`, `cycle-times.test.ts`, `trends.test.ts`.
- `ralph_hero__capture_snapshot` writes a JSONL line and returns the row.
- `ralph_hero__metrics_trends` reads the JSONL and returns a structured trend payload.
- `/ralph-hero:trends` prints a markdown report with deltas and sparklines.
- launchd plist template loads cleanly (`launchctl load …`) and produces a snapshot row on the next fire.

## What We're NOT Doing

- No SQLite, DuckDB, or external time-series DB. JSONL is sufficient for the volumes involved (≤365 rows/year per project).
- No web UI, no Grafana, no Chart.js — markdown + ASCII sparklines only.
- No backfill of pre-existing history beyond what `parseAllTransitions()` can recover from past comments.
- No Langfuse / OpenTelemetry integration. (The langfuse harness in `~/projects/langfuse/` is for agent observability, not project metrics.)
- No changes to `pipeline_dashboard` or `metrics.ts` signatures — snapshots wrap them, do not modify them.
- No retention/compaction policy in v1; revisit once a project accumulates >2 years of daily rows.

## Implementation Approach

Five phases, additive throughout. Each phase is a self-contained module + test suite + tool registration. Phases 1–3 are the MCP server core; Phase 4 is the user surface (skill + scheduler); Phase 5 is documentation and CI hookup.

Each phase is independently shippable: Phase 1 alone delivers value (capture-only); Phase 2 enriches (cycle time); Phase 3 surfaces (trend tool); Phase 4 schedules + skill; Phase 5 documents. This issue is a strong candidate for `/ralph-hero:ralph-split` — running split would create five XS/S sub-issues, each mapping to one phase, with the dependencies in the per-phase task tables (1.0 → 1.1 → 1.2 → 1.3 → 2.0 → ... → 5.x) preserved as `depends_on` edges.

---

## Phase 1: Snapshot capture & JSONL persistence

### Overview
Introduce a pure persistence layer plus an MCP tool that captures a single point-in-time snapshot of the dashboard + metrics and appends it to JSONL.

### Tasks

| id   | files                                                                                              | tdd | complexity | depends_on | acceptance                                                                                                                  |
|------|----------------------------------------------------------------------------------------------------|-----|------------|------------|-----------------------------------------------------------------------------------------------------------------------------|
| 1.0  | `plugin/ralph-hero/mcp-server/src/lib/dashboard-fetch.ts` (create); `src/tools/dashboard-tools.ts` (modify) | yes | S          | —          | Extracted `fetchDashboardItems(client, projectNumber?)` returns `DashboardItem[]`; `dashboard-tools.ts` calls the helper instead of inline fetch; existing `dashboard.test.ts` still passes. |
| 1.1  | `plugin/ralph-hero/mcp-server/src/lib/snapshots.ts` (create); `src/__tests__/snapshots.test.ts` (create) | yes | S          | —          | `Snapshot` type, `snapshotPath()`, `appendSnapshot()`, `readSnapshots()` exported; round-trip + malformed-line + partitioning tests pass; uses `fs/promises` only. |
| 1.2  | `plugin/ralph-hero/mcp-server/src/tools/trends-tools.ts` (create); `src/__tests__/trends-tools.test.ts` (create) | yes | S          | 1.0, 1.1   | `ralph_hero__capture_snapshot` registered; calling it with mocked client appends exactly one JSONL line and returns the snapshot row.                  |
| 1.3  | `plugin/ralph-hero/mcp-server/src/index.ts` (modify)                                               | no  | XS         | 1.2        | `registerTrendsTools(server, client, fieldCache)` invoked alongside other registrations; `npm run build` clean.             |

### Changes Required

#### 1. Extract dashboard-fetch helper (Task 1.0)
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard-fetch.ts` (new)
**Changes**: Move the items-fetch logic currently inline in `dashboard-tools.ts` (around line 440-464, ahead of the `buildDashboard()` call) into a reusable `fetchDashboardItems(client, projectNumber?)` returning `DashboardItem[]`. Update `dashboard-tools.ts` to call the helper.

#### 2. New persistence module (Task 1.1)
**File**: `plugin/ralph-hero/mcp-server/src/lib/snapshots.ts`
**Changes**: Define `Snapshot` type, `snapshotPath(owner, projectNumber)`, `appendSnapshot(snapshot)`, `readSnapshots(owner, projectNumber, since?)`. All file I/O via `fs/promises`. Snapshot rows are line-delimited JSON with `schemaVersion: 1`.

```typescript
export interface Snapshot {
  schemaVersion: 1;
  capturedAt: string;            // ISO 8601
  owner: string;
  projectNumber: number;
  velocity: number;              // items moved to Done in window
  windowDays: number;
  riskScore: number;
  status: ProjectHealthStatus;
  wipByPhase: Record<string, number>;          // phase -> open count
  pointsByPhase: Record<string, number>;       // phase -> sum of estimate points
  doneInWindow: number;
  newInWindow: number;
  warnings: { critical: number; warning: number; info: number };
  cycleTime?: CycleTimeRollup;   // populated by Phase 2
}

export function snapshotPath(owner: string, projectNumber: number): string {
  const home = process.env.HOME ?? "";
  return path.join(home, ".ralph-hero", "snapshots", owner, `${projectNumber}.jsonl`);
}
```

#### 3. New MCP tool (Task 1.2)
**File**: `plugin/ralph-hero/mcp-server/src/tools/trends-tools.ts`
**Changes**: Register `ralph_hero__capture_snapshot`. Calls the new `fetchDashboardItems` helper from Task 1.0 and reuses `buildDashboard()` + `calculateMetrics()` so there is one source of truth.

```typescript
import { fetchDashboardItems } from "../lib/dashboard-fetch.js";
import { buildDashboard } from "../lib/dashboard.js";
import { calculateMetrics, DEFAULT_METRICS_CONFIG } from "../lib/metrics.js";
import { appendSnapshot, toSnapshot } from "../lib/snapshots.js";

server.tool(
  "ralph_hero__capture_snapshot",
  "Capture a point-in-time snapshot of pipeline metrics to local JSONL.",
  { projectNumber: z.number().optional(), windowDays: z.number().default(7) },
  async ({ projectNumber, windowDays }) => {
    const items = await fetchDashboardItems(client, projectNumber);
    const data = buildDashboard(items, { /* default health config */ });
    const m = calculateMetrics(items, data, { ...DEFAULT_METRICS_CONFIG, velocityWindowDays: windowDays });
    const snapshot = toSnapshot({ owner, projectNumber, data, metrics: m, windowDays });
    await appendSnapshot(snapshot);
    return toolSuccess(snapshot);
  },
);
```

#### 4. Wire registration (Task 1.3)
**File**: `plugin/ralph-hero/mcp-server/src/index.ts`
**Changes**: Call `registerTrendsTools(server, client, fieldCache)` alongside the other `registerXyzTools` blocks.

### Success Criteria

#### Automated Verification
- [ ] `npm test` passes including new `src/__tests__/snapshots.test.ts` (round-trip write/read, malformed line tolerance, partitioning by `(owner, projectNumber)`).
- [ ] `npm run build` succeeds with strict TypeScript.
- [ ] Calling `ralph_hero__capture_snapshot` against a fixture client appends exactly one line to the expected path.

#### Manual Verification
- [ ] Running `capture_snapshot` against the live ralph-hero project writes `~/.ralph-hero/snapshots/cdubiel08/3.jsonl` with one row.
- [ ] Re-running it appends a second row without rewriting the first.

**Implementation Note**: Pause for confirmation that the JSONL row looks correct before starting Phase 2.

---

## Phase 2: Cycle-time enrichment

### Overview
Use `parseAllTransitions()` to compute lead-time and per-phase dwell-time, roll them up to averages, and include them in `Snapshot.cycleTime`.

### Tasks

| id   | files                                                                                                | tdd | complexity | depends_on | acceptance                                                                                                                  |
|------|------------------------------------------------------------------------------------------------------|-----|------------|------------|-----------------------------------------------------------------------------------------------------------------------------|
| 2.0  | `plugin/ralph-hero/mcp-server/src/lib/cycle-times.ts` (create); `src/__tests__/cycle-times.test.ts` (create) | yes | M          | —          | `rollupCycleTimes(records, now)` returns `CycleTimeRollup` with correct p50/p90 lead time and per-phase dwell; tests cover empty, single-issue, multi-issue, out-of-order. |
| 2.1  | `plugin/ralph-hero/mcp-server/src/lib/snapshots.ts` (modify)                                         | yes | S          | 2.0        | `fetchTransitionedIssues(client, doneItems)` fetches comments and returns `TransitionedIssue[]`; ignores issues without transition comments without throwing.        |
| 2.2  | `plugin/ralph-hero/mcp-server/src/lib/snapshots.ts` (modify); `src/tools/trends-tools.ts` (modify)   | yes | XS         | 2.1, 1.2   | `Snapshot.cycleTime` populated by `capture_snapshot` when at least one Done issue has transitions; null otherwise.          |

### Changes Required

#### 1. New cycle-time module (Task 2.0)
**File**: `plugin/ralph-hero/mcp-server/src/lib/cycle-times.ts`
**Changes**: Pure functions over a list of `{ issueNumber, transitions: TransitionRecord[], closedAt? }`. Outputs:

```typescript
export interface CycleTimeRollup {
  leadTimeP50Hours: number | null;     // null when no Done items have transitions
  leadTimeP90Hours: number | null;
  perPhaseDwellHours: Record<string, { p50: number; p90: number; n: number }>;
  sampleSize: number;
}

export function rollupCycleTimes(records: TransitionedIssue[], now: number): CycleTimeRollup;
```

#### 2. Transition fetch helper (Task 2.1)
**File**: `plugin/ralph-hero/mcp-server/src/lib/snapshots.ts`
**Changes**: Helper `fetchTransitionedIssues(client, doneItems)` that fetches comments for the recently-Done issues and runs `parseAllTransitions()`. Best-effort — issues without transition comments are skipped.

#### 3. Snapshot integration (Task 2.2)
**File**: `plugin/ralph-hero/mcp-server/src/lib/snapshots.ts`
**Changes**: When building the snapshot, call `rollupCycleTimes(records, Date.now())` over Done issues completed in the window. Hydrate `Snapshot.cycleTime`.

### Success Criteria

#### Automated Verification
- [ ] `src/__tests__/cycle-times.test.ts` passes (synthetic transitions: 1 issue, multiple issues, missing transitions, out-of-order timestamps).
- [ ] Existing `transition-comments.test.ts` continues to pass.
- [ ] `npm test` and `npm run build` succeed.

#### Manual Verification
- [ ] On the live project, `cycleTime.sampleSize` is non-zero and per-phase dwell numbers look plausible (e.g., Plan in Progress dwell < In Progress dwell).

**Implementation Note**: Pause for confirmation that cycle-time numbers look reasonable before Phase 3.

---

## Phase 3: Trend query tool

### Overview
Read the JSONL and return structured trends with 1d/7d/30d deltas and per-metric series suitable for sparkline rendering.

### Tasks

| id   | files                                                                                          | tdd | complexity | depends_on | acceptance                                                                                                  |
|------|------------------------------------------------------------------------------------------------|-----|------------|------------|-------------------------------------------------------------------------------------------------------------|
| 3.0  | `plugin/ralph-hero/mcp-server/src/lib/trends.ts` (create); `src/__tests__/trends.test.ts` (create) | yes | M          | 1.1        | `computeTrends(snapshots, now)` returns `TrendSeries[]` with correct 1d/7d/30d deltas; handles gaps + insufficient history; tests pass. |
| 3.1  | `plugin/ralph-hero/mcp-server/src/lib/trends.ts` (modify); same test file                       | yes | S          | 3.0        | `renderSparkline(values)` produces an 8-bucket Unicode sparkline string; round-trip with snapshot data renders correctly. |
| 3.2  | `plugin/ralph-hero/mcp-server/src/tools/trends-tools.ts` (modify)                              | yes | S          | 3.0, 3.1   | `ralph_hero__metrics_trends` registered with params `{projectNumber?, since?, format}`; markdown format embeds sparklines per metric. |

### Changes Required

#### 1. Trend computation (Tasks 3.0 + 3.1)
**File**: `plugin/ralph-hero/mcp-server/src/lib/trends.ts`
**Changes**: Pure functions:

```typescript
export interface TrendSeries {
  metric: "velocity" | "riskScore" | "wipTotal" | "leadTimeP50Hours";
  points: { capturedAt: string; value: number | null }[];
  delta1d: number | null;
  delta7d: number | null;
  delta30d: number | null;
}

export function computeTrends(snapshots: Snapshot[], now: number): TrendSeries[];
```

#### 2. New MCP tool (Task 3.2)
**File**: `plugin/ralph-hero/mcp-server/src/tools/trends-tools.ts`
**Changes**: Register `ralph_hero__metrics_trends` with params `{ projectNumber?, since?, format: "json"|"markdown" }`. Markdown format renders ASCII sparklines (`▁▂▃▄▅▆▇█`) inline per metric.

### Success Criteria

#### Automated Verification
- [ ] `src/__tests__/trends.test.ts` passes (deltas with insufficient history, missing series, gappy time intervals, sparkline rendering).
- [ ] `npm test` and `npm run build` succeed.

#### Manual Verification
- [ ] After capturing 2+ snapshots, `metrics_trends` returns non-null `delta1d` and a sparkline string.
- [ ] Markdown output is human-readable when pasted into a status update.

**Implementation Note**: Pause for confirmation before Phase 4.

---

## Phase 4: Trends skill + scheduler

### Overview
Surface trends to the user as a skill and provide an opt-in launchd template for daily capture.

### Tasks

| id   | files                                                                                                | tdd | complexity | depends_on | acceptance                                                                                                  |
|------|------------------------------------------------------------------------------------------------------|-----|------------|------------|-------------------------------------------------------------------------------------------------------------|
| 4.0  | `plugin/ralph-hero/skills/trends/SKILL.md` (create)                                                  | no  | XS         | 3.2        | Frontmatter has `model: haiku`, `allowed-tools: ralph_hero__capture_snapshot, ralph_hero__metrics_trends`; behavior captures fresh snapshot then prints markdown trends; accepts `--since 30d`. |
| 4.1  | `plugin/ralph-hero/scripts/snapshot/run.sh` (create)                                                 | no  | S          | 1.2        | `bash -n` clean; resolves env via `resolve-env.sh`; invokes capture; logs to `~/.ralph-hero/snapshots/run.log`. |
| 4.2  | `plugin/ralph-hero/scripts/snapshot/launchd/com.ralph.snapshot.plist.template` (create)              | no  | XS         | 4.1        | After env substitution, `plutil -lint` passes; mirrors dream-loop plist template structure; daily 06:00 schedule. |
| 4.3  | `plugin/ralph-hero/skills/report/SKILL.md` (modify)                                                  | no  | S          | 3.2        | New `--with-trends` flag (default off); when set + ≥2 snapshots exist, status update body appends a "Trends" section produced via `metrics_trends`. |

### Changes Required

#### 1. New skill (Task 4.0)
**File**: `plugin/ralph-hero/skills/trends/SKILL.md`
**Changes**: New skill with frontmatter `model: haiku`, `allowed-tools: ralph_hero__capture_snapshot, ralph_hero__metrics_trends`. Behavior: capture a fresh snapshot, then call `metrics_trends` with `format: markdown` and print to the user. Accepts optional `--since 30d` arg.

#### 2. Snapshot runner (Task 4.1)
**File**: `plugin/ralph-hero/scripts/snapshot/run.sh`
**Changes**: Bash script that resolves env via existing `resolve-env.sh` and invokes the MCP tool through a small helper. Logs to `~/.ralph-hero/snapshots/run.log` with rotation matching dream-loop conventions.

#### 3. CLI scheduler template (Task 4.2)
**File**: `plugin/ralph-hero/scripts/snapshot/launchd/com.ralph.snapshot.plist.template`
**Changes**: launchd plist mirroring `scripts/dream/launchd/com.dubiel.dream-loop.plist.template` — runs daily at 06:00, invokes `scripts/snapshot/run.sh`.

#### 4. Update report skill (Task 4.3)
**File**: `plugin/ralph-hero/skills/report/SKILL.md`
**Changes**: When composing the status update body, optionally append a "Trends" section produced by `metrics_trends` if at least 2 prior snapshots exist. Behind a `--with-trends` flag (default off in v1).

### Success Criteria

#### Automated Verification
- [ ] `plutil -lint` on the rendered plist (after env substitution) succeeds.
- [ ] `bash -n scripts/snapshot/run.sh` parses cleanly.
- [ ] Skill markdown lints (frontmatter fields present, no unknown allowed-tools).

#### Manual Verification
- [ ] `/ralph-hero:trends` produces a sensible markdown report on a project with 2+ snapshots.
- [ ] Loading the launchd plist (`launchctl load …`) succeeds; one fire writes a snapshot row.
- [ ] `launchctl list | grep ralph-snapshot` shows status `0` after a successful run.

**Implementation Note**: Pause for confirmation that scheduled capture works end-to-end before Phase 5.

---

## Phase 5: Documentation & CI

### Overview
Make the feature discoverable and prevent regressions.

### Tasks

| id   | files                                                                                       | tdd | complexity | depends_on              | acceptance                                                                                          |
|------|---------------------------------------------------------------------------------------------|-----|------------|-------------------------|-----------------------------------------------------------------------------------------------------|
| 5.0  | `CLAUDE.md` (modify); `plugin/ralph-hero/README.md` (modify)                                | no  | XS         | 4.0                     | New "Performance tracking over time" section in CLAUDE.md; new "Trends" section in README with usage example. |
| 5.1  | `plugin/ralph-hero/mcp-server/src/__tests__/fixtures/snapshots.fixture.jsonl` (create)      | no  | XS         | 1.1                     | 30 lines of synthetic snapshots, schema-valid, used by `trends.test.ts`.                            |
| 5.2  | `.github/workflows/ci.yml` (verify only — no edit expected)                                 | no  | XS         | 1.1, 2.0, 3.0           | Existing `npm test` job picks up new test files automatically; confirm green on Node 18/20/22.      |

### Changes Required

#### 1. CLAUDE.md and README updates (Task 5.0)
**File**: `CLAUDE.md`
**Changes**: Add a "Performance tracking over time" subsection under Architecture describing the snapshot store, partitioning, and the trends/capture tools.

**File**: `plugin/ralph-hero/README.md`
**Changes**: Add a "Trends" section with the `/trends` skill usage and one screenshot of the markdown output.

#### 2. Sample data fixture (Task 5.1)
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/fixtures/snapshots.fixture.jsonl`
**Changes**: 30 days of synthetic snapshots used by `trends.test.ts` and as a documentation example.

#### 3. CI hooks (Task 5.2)
**File**: `.github/workflows/ci.yml`
**Changes**: No new job. Existing `npm test` job already covers the new test files because they live under `mcp-server/src/__tests__/`.

### Success Criteria

#### Automated Verification
- [ ] All test suites pass on Node 18, 20, 22 (existing CI matrix).
- [ ] `npm run build` produces no warnings.

#### Manual Verification
- [ ] README "Trends" section renders correctly on GitHub.
- [ ] CLAUDE.md update is concise and accurate.

---

## Testing Strategy

### Unit Tests
- `snapshots.test.ts`: append/read round-trip, missing directory creation, malformed-line tolerance, partitioning.
- `cycle-times.test.ts`: empty input, single-phase issue, multi-phase issue, out-of-order transitions, percentile math.
- `trends.test.ts`: delta computation across 1/7/30-day windows, gappy series, sparkline characters.

### Integration Tests
- `trends-tools.test.ts`: end-to-end registration, calling `capture_snapshot` then `metrics_trends` against an in-memory `GitHubClient` mock.

### Manual Testing Steps
1. Run `capture_snapshot` once; confirm JSONL file exists and contains one row.
2. Wait a day (or override `capturedAt` for testing); run again.
3. Run `/ralph-hero:trends` and verify deltas + sparklines render.
4. Install launchd plist; verify next-day fire produces a row.
5. Inspect `~/.ralph-hero/snapshots/run.log` for clean run.

## Performance Considerations

- Snapshot capture is one dashboard query + N comment queries (only for Done items in the window). Worst case ~10 GraphQL calls per snapshot — well under any rate-limit concern at daily cadence.
- JSONL append is O(1) per row; read is O(rows) but bounded (≤365/year/project).
- Sparkline rendering is O(points), trivially cheap.

## Migration Notes

- No migration needed — feature is additive. Existing installs gain functionality once they upgrade past the release that includes Phases 1–4.
- Users who never run `capture_snapshot` see no new files and no behavior change.
- If schema needs to evolve (e.g., add `cycleTime.p99`), bump `schemaVersion` and have `readSnapshots` filter unknown versions with a warning rather than crashing.

## References

- Existing dashboard: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
- Existing metrics: `plugin/ralph-hero/mcp-server/src/lib/metrics.ts:147`
- Transition parser (cycle-time source): `plugin/ralph-hero/mcp-server/src/lib/transition-comments.ts`
- Status update tool: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
- launchd template precedent: `scripts/dream/launchd/com.dubiel.dream-loop.plist.template`
- Closed predecessor: GH-20 (pipeline analytics)
- Related research: `thoughts/shared/research/2026-02-16-GH-0020-pipeline-analytics.md`, `thoughts/shared/research/2026-02-20-GH-0139-velocity-metrics-auto-status.md`
