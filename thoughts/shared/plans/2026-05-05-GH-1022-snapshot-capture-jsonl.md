---
date: 2026-05-05
status: draft
type: plan
tags: [snapshots, persistence, jsonl, mcp-server, metrics]
github_issue: 1022
github_issues: [1022]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1022
primary_issue: 1022
parent_plan: thoughts/shared/plans/2026-05-05-GH-1019-product-performance-over-time.md
---

# Phase 1: Snapshot Capture & JSONL Persistence — Implementation Plan

## Prior Work

- builds_on:: [[2026-05-05-GH-1019-product-performance-over-time]]
- builds_on:: [[2026-02-16-GH-0020-pipeline-analytics]]
- builds_on:: [[2026-02-20-GH-0139-velocity-metrics-auto-status]]

## Overview

Single-issue plan for GH-1022 (child of epic GH-1019). Introduces a pure persistence layer plus an MCP tool that captures a single point-in-time snapshot of the dashboard + metrics and appends it to JSONL at `~/.ralph-hero/snapshots/<owner>/<projectNumber>.jsonl`. This is Phase 1 of 5 in the GH-1019 epic; later phases (1023-1026) build on the persistence module and `capture_snapshot` tool established here.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1022 | Phase 1: Snapshot capture & JSONL persistence | S |

## Shared Constraints

Inherited from parent plan-of-plans (`2026-05-05-GH-1019-product-performance-over-time.md`):

- **Storage**: Local JSONL only — no SQLite/DuckDB/external TSDB. Append-only, schema-versioned (`schemaVersion: 1`).
- **Path convention**: `~/.ralph-hero/snapshots/<owner>/<projectNumber>.jsonl` (mirrors existing `~/.ralph-hero/knowledge.db`, `~/.ralph-hero/cursors/` precedent).
- **Multi-project partitioning**: Snapshots keyed by `(owner, projectNumber)` to support `RALPH_GH_PROJECT_NUMBERS`.
- **Additive only**: Do NOT modify `pipeline_dashboard` or `metrics.ts` signatures — wrap them.
- **Pure functions where possible**: Persistence module exposes pure helpers + a single I/O boundary (`appendSnapshot`, `readSnapshots`).
- **TypeScript strict mode**: All new files must compile clean under `tsc` strict.
- **ESM imports**: All internal imports require `.js` extensions.
- **Tool naming**: `ralph_hero__capture_snapshot` (prefix convention).

Phase-1-specific extensions:

- The `Snapshot.cycleTime` field is reserved (optional) — Phase 1 leaves it unset; Phase 2 (GH-1023) populates it.
- `fetchDashboardItems` extraction must not change behavior of existing `pipeline_dashboard` tool — verified by existing `dashboard.test.ts`.

## Current State Analysis

ralph-hero already produces every input needed for snapshotting:

- **Dashboard data**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:buildDashboard()` returns a complete `DashboardData` (phases, WIP, health, archive stats) per call.
- **Metrics**: `plugin/ralph-hero/mcp-server/src/lib/metrics.ts:147` (`calculateMetrics`) returns `{ velocity, riskScore, status, highlights }` over a configurable window (default 7d).
- **Item fetch**: Currently inline in `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` around L440-450 (`paginateConnection<RawDashboardItem>` → `toDashboardItems`). Needs extraction so the new `capture_snapshot` tool can reuse the same fetch path.
- **Tool registration pattern**: `plugin/ralph-hero/mcp-server/src/index.ts:454-486` shows the `registerXyzTools(server, client, fieldCache)` convention. New `registerTrendsTools` slots in next to existing registrations.
- **Test infrastructure**: `vitest run` from `mcp-server/`; all tests live in `src/__tests__/`. Existing `dashboard.test.ts` covers the inline fetch indirectly.

No local persistence layer exists — the codebase is otherwise stateless against the GitHub source of truth.

### Key Files

Reading list (extracted from research doc + parent plan):
- `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` (read + modify, L420-465)
- `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` (read — `buildDashboard`, `DashboardItem`, `DashboardData`, `HealthConfig`, `DEFAULT_HEALTH_CONFIG`)
- `plugin/ralph-hero/mcp-server/src/lib/metrics.ts` (read — `calculateMetrics`, `DEFAULT_METRICS_CONFIG`, `MetricsResult`, `ProjectHealthStatus`)
- `plugin/ralph-hero/mcp-server/src/index.ts` (modify — add `registerTrendsTools` import + call)
- `plugin/ralph-hero/mcp-server/src/types.ts` (read — `toolSuccess`, `toolError`)
- `plugin/ralph-hero/mcp-server/src/github-client.ts` (read — `GitHubClient` shape)
- `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts` (read — pattern for fixture client + tests)

## Desired End State

- New module `lib/snapshots.ts` exports `Snapshot` type, `snapshotPath()`, `appendSnapshot()`, `readSnapshots()` and a `toSnapshot()` builder.
- New module `lib/dashboard-fetch.ts` exposes `fetchDashboardItems(client, projectNumber?)` returning `DashboardItem[]`. `dashboard-tools.ts` calls this helper instead of inline fetch.
- New tool `ralph_hero__capture_snapshot` registered. Calling it appends exactly one JSONL line to the partitioned path and returns the snapshot row.
- `~/.ralph-hero/snapshots/cdubiel08/3.jsonl` exists after a live run with one row.
- `Snapshot.cycleTime` is reserved (optional field) but unset in Phase 1.

### Verification

- [ ] `npm test` passes including new `snapshots.test.ts` and `trends-tools.test.ts`
- [ ] `npm run build` succeeds with strict TypeScript
- [ ] Existing `dashboard.test.ts` still passes after fetch extraction
- [ ] Live invocation: `~/.ralph-hero/snapshots/cdubiel08/3.jsonl` contains exactly one row after first call, two rows after second call (append-only)

## What We're NOT Doing

- No cycle-time computation (Phase 2 / GH-1023)
- No trend query tool (Phase 3 / GH-1024)
- No skill or scheduler (Phase 4 / GH-1025)
- No documentation updates (Phase 5 / GH-1026)
- No retention/compaction policy
- No backfill of historical data
- No changes to `buildDashboard()` or `calculateMetrics()` signatures

## Implementation Approach

Four atomic tasks executed in dependency order: extract the fetch helper (1.0), build the persistence module (1.1, can run in parallel with 1.0), wire the new tool (1.2 — depends on both), then register it on the server (1.3). Tasks 1.0 and 1.1 are independent; 1.2 needs both; 1.3 is the wiring step.

---

## Phase 1: GH-1022 Snapshot capture & JSONL persistence
- **depends_on**: null

### Overview

Extract the dashboard items fetch into a reusable helper, build a JSONL persistence module under `lib/snapshots.ts`, register a new MCP tool `ralph_hero__capture_snapshot`, and wire it into the server entry point.

### Tasks

#### Task 1.1: Extract `fetchDashboardItems` helper
- **files**: `plugin/ralph-hero/mcp-server/src/lib/dashboard-fetch.ts` (create), `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] New file `src/lib/dashboard-fetch.ts` exports `fetchDashboardItems(client: GitHubClient, projectNumber?: number): Promise<DashboardItem[]>`
  - [ ] Logic moved verbatim from `dashboard-tools.ts` (currently around L440-450, the `paginateConnection<RawDashboardItem>` block plus `toDashboardItems` conversion)
  - [ ] When `projectNumber` undefined, helper resolves from `client.config.projectNumbers ?? [client.config.projectNumber]` (mirrors existing pipeline_dashboard logic)
  - [ ] Helper returns merged `DashboardItem[]` across all projects when multiple project numbers configured
  - [ ] `dashboard-tools.ts` imports and calls `fetchDashboardItems` in the handler — no behavior change
  - [ ] `npx vitest run src/__tests__/dashboard.test.ts` passes unchanged
  - [ ] `npm run build` succeeds

#### Task 1.2: Snapshot persistence module
- **files**: `plugin/ralph-hero/mcp-server/src/lib/snapshots.ts` (create), `plugin/ralph-hero/mcp-server/src/__tests__/snapshots.test.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Exports `Snapshot` interface with fields: `schemaVersion: 1`, `capturedAt: string` (ISO 8601), `owner: string`, `projectNumber: number`, `velocity: number`, `windowDays: number`, `riskScore: number`, `status: ProjectHealthStatus`, `wipByPhase: Record<string, number>`, `pointsByPhase: Record<string, number>`, `doneInWindow: number`, `newInWindow: number`, `warnings: { critical: number; warning: number; info: number }`, `cycleTime?: CycleTimeRollup` (optional, Phase 2)
  - [ ] Exports `snapshotPath(owner: string, projectNumber: number): string` returning `path.join(os.homedir(), ".ralph-hero", "snapshots", owner, `${projectNumber}.jsonl`)` — uses `os.homedir()` not `process.env.HOME` for cross-platform safety
  - [ ] Exports `async appendSnapshot(snapshot: Snapshot): Promise<void>` — creates parent directory recursively (`fs.mkdir({ recursive: true })`) before append; one JSON-stringified row per line ending in `\n`
  - [ ] Exports `async readSnapshots(owner: string, projectNumber: number, since?: Date): Promise<Snapshot[]>` — reads file (returns `[]` on ENOENT), splits lines, JSON-parses each, skips malformed lines without throwing, filters by `capturedAt >= since` if provided, filters out unknown `schemaVersion` with a `console.warn`
  - [ ] Exports `toSnapshot({ owner, projectNumber, data, metrics, windowDays }): Snapshot` builder — derives `wipByPhase`, `pointsByPhase`, `doneInWindow`, `newInWindow`, `warnings` counts from `DashboardData` + `MetricsResult`
  - [ ] Test `snapshots.test.ts` covers: round-trip write/read, missing-directory creation, malformed-line tolerance (one bad line + one good line → returns 1), partitioning (different owner/project pairs write to different files), `since` filter, unknown schemaVersion skip
  - [ ] Tests use a tmpdir via `os.tmpdir()` + `fs.mkdtemp` and override path resolution by injecting `HOME` env or by exporting an internal `__setSnapshotRoot` test hook
  - [ ] All file I/O via `fs/promises`
  - [ ] `npm test` passes; `npm run build` succeeds

#### Task 1.3: `ralph_hero__capture_snapshot` MCP tool
- **files**: `plugin/ralph-hero/mcp-server/src/tools/trends-tools.ts` (create), `plugin/ralph-hero/mcp-server/src/__tests__/trends-tools.test.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - [ ] Exports `registerTrendsTools(server: McpServer, client: GitHubClient, fieldCache: FieldOptionCache): void`
  - [ ] Registers `ralph_hero__capture_snapshot` with Zod schema `{ projectNumber: z.number().optional(), windowDays: z.number().int().positive().default(7) }`
  - [ ] Handler resolves `owner` from `client.config.owner`; resolves `projectNumber` from arg or `client.config.projectNumber`; errors via `toolError("RALPH_GH_OWNER and RALPH_GH_PROJECT_NUMBER required")` if missing
  - [ ] Handler calls `fetchDashboardItems(client, projectNumber)` → `buildDashboard(items, DEFAULT_HEALTH_CONFIG)` → `calculateMetrics(items, data, { ...DEFAULT_METRICS_CONFIG, velocityWindowDays: windowDays })` → `toSnapshot({...})` → `appendSnapshot(snapshot)` → `toolSuccess(snapshot)`
  - [ ] Test `trends-tools.test.ts` mocks `GitHubClient` (returns 3 fixture items), invokes the registered tool handler, asserts: exactly one JSONL line written, returned snapshot matches the written line, `wipByPhase` reflects fixture data
  - [ ] Test uses `appendSnapshot` against a tmpdir (HOME override or test-hook)
  - [ ] Re-invocation of the tool appends a second line — first line preserved
  - [ ] `npm test` passes; `npm run build` succeeds

#### Task 1.4: Wire `registerTrendsTools` into server entry point
- **files**: `plugin/ralph-hero/mcp-server/src/index.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] Import added: `import { registerTrendsTools } from "./tools/trends-tools.js";`
  - [ ] Call added in `main()` next to other `registerXyzTools(server, client, fieldCache)` invocations (e.g., after `registerActivityTools(server)`)
  - [ ] `npm run build` succeeds — confirms server still compiles
  - [ ] `npm test` (full suite) passes — no regressions

### Phase Success Criteria

#### Automated Verification:
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` — all suites pass including new `snapshots.test.ts` and `trends-tools.test.ts`
- [ ] `npx vitest run src/__tests__/dashboard.test.ts` — still passes after fetch extraction (no regressions)
- [ ] `npx vitest run src/__tests__/snapshots.test.ts` — new tests pass
- [ ] `npx vitest run src/__tests__/trends-tools.test.ts` — new tests pass

#### Manual Verification:
- [ ] Running `ralph_hero__capture_snapshot` against the live ralph-hero project (owner `cdubiel08`, project 3) creates `~/.ralph-hero/snapshots/cdubiel08/3.jsonl` with one well-formed JSON row
- [ ] Re-running the tool appends a second row without rewriting the first
- [ ] Inspecting the row shows non-zero `velocity`, populated `wipByPhase` keys matching active workflow states, and `cycleTime` absent (Phase 2 territory)

**Creates for next phase**: `Snapshot` type with optional `cycleTime` field, `appendSnapshot`/`readSnapshots` for use by Phase 3 trend tool, and a working `capture_snapshot` tool that Phase 4 scheduler invokes.

---

## Integration Testing
- [ ] Live capture against project 3 produces a JSONL row whose JSON parses cleanly and contains all required fields
- [ ] Two consecutive captures yield two distinct rows (capturedAt timestamps differ; file is append-only)

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1022
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/1019
- Parent plan-of-plans: `thoughts/shared/plans/2026-05-05-GH-1019-product-performance-over-time.md`
- Sibling phase issues: GH-1023 (cycle-time), GH-1024 (trends tool), GH-1025 (skill+scheduler), GH-1026 (docs)
- Source files (read context): `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`, `lib/metrics.ts:147`, `tools/dashboard-tools.ts:440-465`, `src/index.ts:454-486`
