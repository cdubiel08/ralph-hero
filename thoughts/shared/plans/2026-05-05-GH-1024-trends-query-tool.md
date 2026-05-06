---
date: 2026-05-05
status: draft
type: plan
tags: [metrics, trends, sparklines, mcp-tool, time-series]
github_issue: 1024
github_issues: [1024]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1024
primary_issue: 1024
parent_plan: thoughts/shared/plans/2026-05-05-GH-1019-product-performance-over-time.md
---

# Phase 3: Trend Query Tool (metrics_trends + sparklines) — Implementation Plan

## Prior Work

- builds_on:: [[2026-05-05-GH-1019-product-performance-over-time]]
- builds_on:: [[2026-02-16-GH-0020-pipeline-analytics]]
- builds_on:: [[2026-02-20-GH-0139-velocity-metrics-auto-status]]

## Overview

Single-issue child of epic #1019. This phase reads the per-project JSONL snapshot store created by Phase 1 (#1022) and exposes a structured trend payload with 1d/7d/30d deltas plus 8-bucket Unicode sparklines. The deliverable is one new pure module (`lib/trends.ts`), one new MCP tool (`ralph_hero__metrics_trends` registered in the existing `tools/trends-tools.ts`), and a vitest suite covering delta math, gappy series, insufficient history, and sparkline rendering.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1024 | Phase 3: Trend query tool (metrics_trends + sparklines) | S |

## Shared Constraints

Inherited from parent plan-of-plans (`2026-05-05-GH-1019-product-performance-over-time.md`):

- **Persistence layout**: snapshots live at `~/.ralph-hero/snapshots/<owner>/<projectNumber>.jsonl` (one row per capture, schema-versioned). `readSnapshots(owner, projectNumber, since?)` is the only sanctioned reader (provided by Phase 1).
- **Schema**: `Snapshot.schemaVersion === 1`. Trend code MUST tolerate unknown schema versions by skipping rows (with a warning), not crashing.
- **Multi-project**: snapshots are partitioned by `(owner, projectNumber)`. The tool must respect `RALPH_GH_PROJECT_NUMBER` (default) and accept an explicit `projectNumber` override.
- **No external time-series DB**: JSONL only. No SQLite/DuckDB/etc.
- **No new GraphQL calls**: trend computation is a pure read of local JSONL plus pure arithmetic. No client invocation in `computeTrends`.
- **Additivity**: do not modify `dashboard.ts`, `metrics.ts`, or `transition-comments.ts` signatures.
- **TypeScript strict**: ESM-style `.js` imports, `"type": "module"`. All new files compile under `tsc --strict`.
- **Tool naming**: all MCP tool names use the `ralph_hero__` prefix; responses use `toolSuccess`/`toolError` from `types.ts`.
- **Cycle-time degradation**: `leadTimeP50Hours` may be `null` until Phase 2 (#1023) ships and snapshots accumulate `cycleTime` payloads. Trend code must treat `null` values in the source data as missing samples — neither a 0 nor an error.

Phase 3-specific constraints:

- Sparkline alphabet is fixed as `▁▂▃▄▅▆▇█` (8 buckets, U+2581..U+2588). Empty/all-equal series MUST render deterministically.
- Tool registration goes into the EXISTING `src/tools/trends-tools.ts` file created by Phase 1 (#1022). Do NOT create a new tool module.
- Default `since` window for `metrics_trends` is the last 30 days; the tool also accepts `@today-Nd` date-math via `parseDateMath` from `lib/date-math.ts` for parity with the rest of the codebase.

## Current State Analysis

This phase plugs into a structure that Phase 1 (#1022) creates. Concretely, when Phase 3 starts, the codebase MUST already contain:

- `plugin/ralph-hero/mcp-server/src/lib/snapshots.ts` exporting `Snapshot` (interface), `snapshotPath()`, `appendSnapshot()`, `readSnapshots(owner, projectNumber, since?)`.
- `plugin/ralph-hero/mcp-server/src/tools/trends-tools.ts` registering `ralph_hero__capture_snapshot` and exporting `registerTrendsTools(server, client, fieldCache)`.
- `Snapshot` row shape per parent plan §Phase 1: `{ schemaVersion: 1, capturedAt, owner, projectNumber, velocity, windowDays, riskScore, status, wipByPhase, pointsByPhase, doneInWindow, newInWindow, warnings, cycleTime? }`.

Phase 3 does NOT create those — it consumes them. If the upstream interfaces drift, this plan's Task 3.0 must adapt the import shape, but the tracked metrics list (`velocity`, `riskScore`, `wipTotal`, `leadTimeP50Hours`) is invariant.

Reference modules already on disk this plan reads but does not modify:

- `plugin/ralph-hero/mcp-server/src/types.ts` — `toolSuccess`/`toolError` helpers.
- `plugin/ralph-hero/mcp-server/src/lib/date-math.ts` — `parseDateMath` for `since` parsing.
- `plugin/ralph-hero/mcp-server/src/tools/activity-tools.ts` — example registration pattern (z.string().nullable().default(null), os.homedir(), etc.).
- `plugin/ralph-hero/mcp-server/src/lib/metrics.ts` — semantic source of `velocity` and `riskScore` (read for definitions only; no edits).

## Desired End State

After this phase merges:

- A user with ≥2 snapshots in `~/.ralph-hero/snapshots/<owner>/<project>.jsonl` can call `ralph_hero__metrics_trends` and receive a payload like:
  ```json
  {
    "projectNumber": 3,
    "owner": "cdubiel08",
    "since": "2026-04-05T00:00:00.000Z",
    "now": "2026-05-05T12:00:00.000Z",
    "series": [
      { "metric": "velocity", "points": [...], "delta1d": 1, "delta7d": 4, "delta30d": 9, "sparkline": "▁▂▄▅▆█" },
      ...
    ]
  }
  ```
- Calling with `format: "markdown"` returns a human-readable block with one line per metric, current value, deltas, and an inline sparkline.
- Calling against a fresh project with zero snapshots returns an empty `series` array (not an error).
- `npm test` includes `src/__tests__/trends.test.ts` and passes.

### Verification

- [ ] `npm run build` clean under TypeScript strict mode.
- [ ] `npm test` green; `trends.test.ts` covers: 1d/7d/30d delta math, gappy intervals (missing days), insufficient history (1 snapshot), all-null series (cycleTime not yet populated), sparkline 8-bucket scaling, sparkline empty/single/equal-values edge cases.
- [ ] Manual: with 2+ snapshots, `ralph_hero__metrics_trends` returns non-null `delta1d` and a non-empty sparkline string for at least `velocity`.
- [ ] Manual: markdown format pastes cleanly into a GitHub status update.

## What We're NOT Doing

- Not modifying `lib/snapshots.ts` (Phase 1 owns it; Phase 2 enriches `cycleTime`).
- Not implementing the `/trends` skill or the launchd scheduler (Phase 4, #1025).
- Not adding documentation/CLAUDE.md updates (Phase 5, #1026).
- Not adding a status-update integration via `--with-trends` (Phase 4, #1025, Task 4.3).
- Not computing `leadTimeP90Hours`, per-phase dwell trends, or throughput trends — only the four metrics in the issue spec: `velocity`, `riskScore`, `wipTotal`, `leadTimeP50Hours`.
- Not introducing 24-bucket sparklines, color, or Unicode block-element variants beyond `▁▂▃▄▅▆▇█`.
- Not adding a CLI for the trend tool — this phase only ships the MCP tool surface.

## Implementation Approach

Single phase with three tasks executed in order: (1) write `lib/trends.ts` with `computeTrends()` and unit tests; (2) extend the same module with `renderSparkline()` and update tests; (3) register `ralph_hero__metrics_trends` in the existing `trends-tools.ts`. Tasks 3.0 and 3.1 land in the same file and the same test suite, so they are conceptually back-to-back micro-tasks; we keep them as separate task entries for the dispatchability gates documented by ralph-impl.

The `wipTotal` metric is a derived value: `Object.values(snapshot.wipByPhase).reduce((a,b) => a+b, 0)`. Compute it inside `computeTrends` rather than asking Phase 1 to add it to the snapshot row.

---

## Phase 1: Trend query tool (metrics_trends + sparklines)

- **depends_on**: null

### Overview

Add `lib/trends.ts` (pure module) with `computeTrends()` and `renderSparkline()`, register `ralph_hero__metrics_trends` in `trends-tools.ts`, and ship a vitest suite.

### Tasks

#### Task 1.1: Implement `computeTrends()` and tests

- **files**: `plugin/ralph-hero/mcp-server/src/lib/trends.ts` (create), `plugin/ralph-hero/mcp-server/src/__tests__/trends.test.ts` (create), `plugin/ralph-hero/mcp-server/src/lib/snapshots.ts` (read), `plugin/ralph-hero/mcp-server/src/lib/metrics.ts` (read)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Exports `interface TrendSeries { metric: "velocity" | "riskScore" | "wipTotal" | "leadTimeP50Hours"; points: { capturedAt: string; value: number | null }[]; delta1d: number | null; delta7d: number | null; delta30d: number | null; sparkline?: string }`.
  - [ ] Exports `function computeTrends(snapshots: Snapshot[], now: number): TrendSeries[]` returning exactly four series in the order `[velocity, riskScore, wipTotal, leadTimeP50Hours]`.
  - [ ] Snapshots are sorted ascending by `capturedAt` before delta computation; input order does not affect output.
  - [ ] `wipTotal` is computed per-snapshot as `Object.values(s.wipByPhase).reduce((a,b)=>a+b,0)`.
  - [ ] `leadTimeP50Hours` reads `s.cycleTime?.leadTimeP50Hours ?? null`; when every value is null, the series carries all-null points and `delta1d/7d/30d` are all `null`.
  - [ ] Delta semantics: `delta1d = currentValue - mostRecentValueAtOrBefore(now - 24h)`. Same shape for 7d (168h) and 30d (720h). If no qualifying earlier snapshot exists, the delta is `null`.
  - [ ] Tolerance: snapshots with `schemaVersion !== 1` are skipped (logged via `console.warn`), not thrown.
  - [ ] Tests in `trends.test.ts` cover: (a) empty input → 4 series with empty points and all-null deltas; (b) single snapshot → points length 1, all deltas null; (c) two snapshots 25h apart → `delta1d` is the difference, `delta7d` and `delta30d` null; (d) gappy series (missing day 5 in a 10-day run) → deltas still computed using nearest-prior sample within window; (e) `leadTimeP50Hours` all-null → all-null deltas; (f) input order shuffled → same output as sorted input.

#### Task 1.2: Implement `renderSparkline()` and extend tests

- **files**: `plugin/ralph-hero/mcp-server/src/lib/trends.ts` (modify), `plugin/ralph-hero/mcp-server/src/__tests__/trends.test.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Exports `function renderSparkline(values: (number | null)[]): string`.
  - [ ] Uses exactly the alphabet `▁▂▃▄▅▆▇█` (U+2581..U+2588, 8 buckets).
  - [ ] Empty input → empty string.
  - [ ] All-null input → empty string.
  - [ ] Single value or all-equal values → repeats `▄` (the middle bucket) once per non-null value.
  - [ ] `null` values render as a single space character (`" "`) at their position so x-axis alignment is preserved.
  - [ ] Bucketing maps `min` to bucket 0 and `max` to bucket 7 inclusive, linearly: `bucket = floor((v - min) / (max - min) * 7.999)`.
  - [ ] `computeTrends` populates `series.sparkline` for each TrendSeries by rendering the numeric `points[].value` array; tests assert that `[1,2,3,4,5,6,7,8]` renders to `"▁▂▃▄▅▆▇█"` and `[8,7,6,5,4,3,2,1]` to `"█▇▆▅▄▃▂▁"`.
  - [ ] Tests cover: empty, single value, all-equal, all-null, mixed-null (e.g., `[1,null,3]`), monotonic up, monotonic down, large dynamic range (e.g., `[1, 1000]`).

#### Task 1.3: Register `ralph_hero__metrics_trends` MCP tool

- **files**: `plugin/ralph-hero/mcp-server/src/tools/trends-tools.ts` (modify), `plugin/ralph-hero/mcp-server/src/__tests__/trends-tools.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - [ ] Inside the existing `registerTrendsTools(...)` body, add `server.tool("ralph_hero__metrics_trends", ...)` with Zod params: `{ projectNumber: z.number().optional(), since: z.string().nullable().default(null), format: z.enum(["json","markdown"]).default("json") }`.
  - [ ] Description string mentions: "Read local snapshot JSONL and return 1d/7d/30d deltas plus sparklines for velocity, riskScore, wipTotal, leadTimeP50Hours."
  - [ ] Resolves `owner` and `projectNumber` from env (`RALPH_GH_OWNER`, `RALPH_GH_PROJECT_NUMBER`) when not passed explicitly, mirroring the resolution pattern already used by `ralph_hero__capture_snapshot` in the same file.
  - [ ] Calls `readSnapshots(owner, projectNumber, sinceDate)` where `sinceDate = since ? parseDateMath(since) : new Date(Date.now() - 30*24*60*60*1000)`.
  - [ ] When `format === "json"`: returns `toolSuccess({ owner, projectNumber, since: sinceDate.toISOString(), now: new Date().toISOString(), series })` where `series = computeTrends(snapshots, Date.now())`.
  - [ ] When `format === "markdown"`: returns `toolSuccess({ markdown: <string> })` where the string contains one line per metric in the form `` `velocity:   12  Δ1d=+1  Δ7d=+4  Δ30d=+9  ▁▂▄▅▆█` `` — fixed-width metric label, current value, three deltas (with sign), space, sparkline. Null values render as `n/a`.
  - [ ] Empty snapshot file → `format=json` returns `series: [<4 series with empty points>]`; `format=markdown` returns a single line `"No snapshots yet for cdubiel08/3."` (or the resolved owner/project).
  - [ ] Errors from `readSnapshots` (e.g., ENOENT for the JSONL file) are caught and treated as "no snapshots yet" — not surfaced as tool errors.
  - [ ] `trends-tools.test.ts` adds at least three new cases: (a) JSON format with a fixture of 5 synthetic snapshots → asserts series count, ordering, and one specific delta; (b) markdown format → asserts the output contains the literal string `"velocity"` and at least one sparkline character from the alphabet; (c) ENOENT path → asserts no throw and returns either empty series (json) or the "No snapshots yet" line (markdown).
  - [ ] Existing `ralph_hero__capture_snapshot` tests in the same file continue to pass.

### Phase Success Criteria

#### Automated Verification

- [ ] Automated: `npm run build` (in `plugin/ralph-hero/mcp-server/`) — no TypeScript errors.
- [ ] Automated: `npm test` — all suites green; `trends.test.ts` and updated `trends-tools.test.ts` included.
- [ ] Automated: `npx vitest run src/__tests__/trends.test.ts` — passes in isolation.
- [ ] Automated: `npx vitest run src/__tests__/trends-tools.test.ts` — passes in isolation.

#### Manual Verification

- [ ] After Phase 1 (#1022) lands and at least two `capture_snapshot` calls have been made against the live ralph-hero project (owner `cdubiel08`, project `3`), invoking `ralph_hero__metrics_trends` returns: (a) `series.length === 4`; (b) `series[0].metric === "velocity"` with a non-null `delta1d`; (c) a `sparkline` string of length ≥ 2 made of characters from `▁▂▃▄▅▆▇█`.
- [ ] `format: "markdown"` output, when pasted into a GitHub issue comment preview, renders as monospace-aligned lines with visible sparklines.

**Creates for next phase**: The `ralph_hero__metrics_trends` tool that the Phase 4 `/trends` skill (#1025) will invoke with `format: "markdown"`, and the optional `--with-trends` body section in Phase 4's report skill update.

---

## Integration Testing

- [ ] After Phase 1 (#1022) and Phase 3 (this issue) are both in `main`: run `capture_snapshot` twice, separated by ≥ 1 second (with manually edited `capturedAt` if needed to fake a 24h gap), then call `metrics_trends` and confirm `delta1d` for `velocity` is the arithmetic difference between the two `velocity` values.
- [ ] After Phase 2 (#1023) lands: re-run `capture_snapshot` so that `cycleTime.leadTimeP50Hours` is populated, then confirm `metrics_trends` returns a non-null `leadTimeP50Hours` series.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1024
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/1019
- Parent plan: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-05-GH-1019-product-performance-over-time.md (Phase 3)
- Sibling phases:
  - Phase 1 (snapshot capture): https://github.com/cdubiel08/ralph-hero/issues/1022
  - Phase 2 (cycle-time enrichment): https://github.com/cdubiel08/ralph-hero/issues/1023
  - Phase 4 (trends skill + scheduler): https://github.com/cdubiel08/ralph-hero/issues/1025
  - Phase 5 (docs + CI): https://github.com/cdubiel08/ralph-hero/issues/1026
- Related code: `plugin/ralph-hero/mcp-server/src/lib/metrics.ts`, `plugin/ralph-hero/mcp-server/src/lib/date-math.ts`, `plugin/ralph-hero/mcp-server/src/tools/activity-tools.ts` (registration pattern reference)
