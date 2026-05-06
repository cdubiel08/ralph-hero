---
date: 2026-05-05
status: draft
type: plan
tags: [documentation, fixtures, ci, snapshots, trends]
github_issue: 1026
github_issues: [1026]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1026
primary_issue: 1026
parent_plan: thoughts/shared/plans/2026-05-05-GH-1019-product-performance-over-time.md
---

# Phase 5: Documentation, fixtures & CI verification — Implementation Plan

## Prior Work

- builds_on:: [[2026-05-05-GH-1019-product-performance-over-time]]
- builds_on:: [[2026-05-05-GH-1019-critique-v2]]
- builds_on:: [[2026-05-05-GH-1022-snapshot-capture-jsonl]]
- builds_on:: [[2026-05-05-GH-1023-cycle-time-enrichment]]
- builds_on:: [[2026-05-05-GH-1024-trends-query-tool]]
- builds_on:: [[2026-05-05-GH-1025-trends-skill-launchd-scheduler]]

## Overview

Final phase of the GH-1019 product-performance-over-time epic. Pure documentation, test fixture, and CI verification work — no behavior changes. Three tasks:

1. Document the new feature in `CLAUDE.md` (Architecture subsection) and `plugin/ralph-hero/README.md` (user-facing Trends section).
2. Add a 30-line synthetic JSONL fixture under `mcp-server/src/__tests__/fixtures/` consumable by `trends.test.ts` and usable as a documentation example.
3. Verify the existing CI workflow (`.github/workflows/ci.yml`) auto-discovers the new test files added by Phases 1–3 and runs them green on Node 18 / 20 / 22 — no `ci.yml` edit expected.

| Phase | Issue   | Title                                              | Estimate |
|-------|---------|----------------------------------------------------|----------|
| 1     | GH-1026 | Phase 5: Documentation, fixtures & CI verification | XS       |

## Shared Constraints

Inherited verbatim from the parent plan-of-plans (`2026-05-05-GH-1019-product-performance-over-time.md`):

- Storage location: `~/.ralph-hero/snapshots/<owner>/<projectNumber>.jsonl`. Logs under `~/.ralph-hero/snapshots/run.log`.
- Snapshot rows are line-delimited JSON with `schemaVersion: 1`. Schema fields per parent plan §Phase 1: `schemaVersion`, `capturedAt` (ISO 8601), `owner`, `projectNumber`, `velocity`, `windowDays`, `riskScore`, `status`, `wipByPhase`, `pointsByPhase`, `doneInWindow`, `newInWindow`, `warnings`, `cycleTime?`.
- No new MCP tools, no behavior changes — Phase 5 is documentation, fixtures, and CI verification only.
- No retention/compaction policy is added in v1.
- Plan-of-plans Out-of-Scope items remain out of scope (no SQLite, no web UI, no Langfuse/OpenTelemetry, etc.).

Phase-specific constraints (discovered while reading the codebase):

- `.github/workflows/ci.yml` already runs `npm test` and `npm run build` for `plugin/ralph-hero/mcp-server` across Node 18, 20, 22 (job `build-and-test-hero`). It picks up any test file under `src/__tests__/**` automatically because vitest auto-discovers; no workflow edit is required.
- The fixtures directory is `plugin/ralph-hero/mcp-server/src/__tests__/fixtures/` (already exists, currently holds YAML registry fixtures). The new JSONL fixture lives alongside them.
- `CLAUDE.md` Architecture section currently has subsections in this order: Plugin System → Per-Phase Agents → MCP Server Internals → Workflow State Machine → Caching Strategy. The new "Performance tracking over time" subsection should be appended at the end of `## Architecture` (after Caching Strategy) so it doesn't disturb existing anchors that other docs may link to.
- `plugin/ralph-hero/README.md` is user-facing and uses prose + fenced bash blocks. The existing structure includes Prerequisites → Installation → Setup → (skills/usage) sections. The new "Trends" section should sit alongside other skill-usage sections, not under Architecture (which is the developer-facing repo-root `CLAUDE.md`).
- The fixture must round-trip cleanly through `readSnapshots()` (Phase 1 / GH-1022) and produce non-null deltas in `computeTrends()` (Phase 3 / GH-1024). This implies: 30 chronological days of `capturedAt`, monotone-ish but with variance so sparklines render distinguishable buckets.
- This issue depends conceptually on Phases 1–4 having shipped (the things being documented must exist), but its file changes do not collide with those phases — `CLAUDE.md`, `README.md`, and the new `fixtures/snapshots.fixture.jsonl` are not edited by Phases 1–4. Therefore this plan can be **written and committed** in parallel with Phase 1–4 implementation, but task acceptance criteria reference the symbols (`Snapshot` type, `metrics_trends` tool, `/ralph-hero:trends` skill) those phases ship.

## Current State Analysis

- `CLAUDE.md` at the repo root has a `## Architecture` section with five subsections; the last is `### Caching Strategy` ending at the line before `## Key Implementation Gotchas`.
- `plugin/ralph-hero/README.md` has no "Trends" or snapshot-related content.
- `plugin/ralph-hero/mcp-server/src/__tests__/fixtures/` exists and contains YAML files (`empty-rules.yml`, `invalid-schema.yml`, `invalid-yaml.yml`, `no-version.yml`, `valid-config.yml`) — registry-loader fixtures. No JSONL fixture exists yet.
- `.github/workflows/ci.yml` job `build-and-test-hero` (lines 10–35) runs `npm ci`, `npm run build`, `npm test` against `plugin/ralph-hero/mcp-server` on Node 18 / 20 / 22. It does not enumerate test files; vitest discovers them automatically. Therefore no workflow edit is needed for Phases 1–4 tests to run — only verification that they actually run green.
- The parent plan §Phase 5 task table (rows 5.0, 5.1, 5.2) is the source of truth and matches the issue body acceptance criteria.

## Desired End State

After this phase ships, a developer or user can:

1. Open `CLAUDE.md`, find a "Performance tracking over time" subsection under Architecture, and learn: the snapshot store layout, partitioning by `(owner, projectNumber)`, the JSONL schema, the two new MCP tools (`capture_snapshot`, `metrics_trends`), and pointer to the trends skill.
2. Open `plugin/ralph-hero/README.md`, find a "Trends" section, see a usage example for `/ralph-hero:trends`, and understand the optional launchd-scheduling story (with a pointer to the template).
3. Open `plugin/ralph-hero/mcp-server/src/__tests__/fixtures/snapshots.fixture.jsonl` and see 30 schema-valid synthetic snapshot rows; `trends.test.ts` consumes the fixture for delta and sparkline assertions.
4. Open the most recent CI run on `main`, see the `build-and-test-hero` matrix green on Node 18 / 20 / 22 with the new test files (`snapshots.test.ts`, `cycle-times.test.ts`, `trends.test.ts`, `trends-tools.test.ts`) executed.

### Verification

- [ ] `CLAUDE.md` contains a `### Performance tracking over time` subsection under `## Architecture` describing the snapshot store and the two tools.
- [ ] `plugin/ralph-hero/README.md` contains a `## Trends` (or sub-section under usage) with a `/ralph-hero:trends` example.
- [ ] `plugin/ralph-hero/mcp-server/src/__tests__/fixtures/snapshots.fixture.jsonl` exists with exactly 30 lines, each parsing as a valid `Snapshot` (schemaVersion 1, all required fields present).
- [ ] `npm test` (in `plugin/ralph-hero/mcp-server/`) green; `npm run build` clean.
- [ ] CI run on the merge commit (or PR) shows `build-and-test-hero` green on Node 18, 20, 22.

## What We're NOT Doing

- No new MCP tools, no behavior changes.
- No edits to `.github/workflows/ci.yml` (existing job auto-discovers new tests; an edit would be noise).
- No new tests authored in this phase — `trends.test.ts` (owned by GH-1024 / Phase 3) is the consumer of the fixture; this phase only produces the data file.
- No screenshots in the README in v1 (parent plan mentioned "one screenshot of the markdown output" as optional polish; defer to a follow-up if the markdown output proves visually noisy).
- No CHANGELOG / release-notes edits — release automation handles version bumps via the `release.yml` workflow.
- No documentation of internal-only types (`TrendSeries`, `CycleTimeRollup`) in user-facing README; keep `CLAUDE.md` for developer detail.

## Implementation Approach

Single phase, three independent tasks. All three can be performed in any order; no internal dependencies. Task 1.2 (fixture) is the only one whose acceptance is verifiable by an automated check (`npm test` exercising `trends.test.ts`); Tasks 1.1 (docs) and 1.3 (CI verification) are reviewed by humans + CI status, respectively.

The fixture must be hand-authored to be schema-valid AND produce a non-trivial trend signal so `trends.test.ts` (GH-1024) has meaningful assertions. The pattern used: 30 daily rows with `capturedAt` walking backwards from a fixed `2026-05-04` anchor, `velocity` and `riskScore` varying in a sinusoidal-ish pattern so sparklines render with distinguishable buckets, and `cycleTime` populated on most rows (a few null to exercise the `delta1d=null` path).

---

## Phase 1: Documentation, fixture & CI verification (GH-1026)

- **depends_on**: [GH-1022, GH-1024, GH-1025]

### Overview

Land the docs, ship the fixture, and confirm CI is green for the snapshot/trends feature added across Phases 1–4.

### Tasks

#### Task 1.1: Update CLAUDE.md and README (parent task 5.0)
- **files**: `CLAUDE.md` (modify), `plugin/ralph-hero/README.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `CLAUDE.md` gains a new `### Performance tracking over time` subsection appended at the end of `## Architecture` (after `### Caching Strategy`, before `## Key Implementation Gotchas`).
  - [ ] The CLAUDE.md subsection covers, in ≤25 lines: (a) what the feature does (point-in-time JSONL snapshots of pipeline metrics + cycle times), (b) storage location `~/.ralph-hero/snapshots/<owner>/<projectNumber>.jsonl` and partitioning rationale, (c) the two MCP tools `ralph_hero__capture_snapshot` and `ralph_hero__metrics_trends` with one-line descriptions, (d) pointer to `plugin/ralph-hero/skills/trends/SKILL.md` and the launchd template path, (e) note that snapshots are append-only with `schemaVersion: 1`.
  - [ ] `plugin/ralph-hero/README.md` gains a new top-level section `## Trends` (placement: after the Setup section / among other usage sections — match existing README flow; do not insert under Prerequisites or Installation).
  - [ ] The README Trends section includes: (a) one paragraph describing the user-visible feature, (b) a fenced bash block showing `claude "/ralph-hero:trends"` (and the `--since 30d` variant), (c) a fenced bash block showing the manual `claude "/ralph-hero:report --with-trends"` invocation, (d) an "Optional: scheduled capture" note pointing at `plugin/ralph-hero/scripts/snapshot/launchd/com.ralph.snapshot.plist.template` with the standard hand-edit-paths-then-`launchctl load` instruction.
  - [ ] No edits to other top-level sections of either document (existing anchor links remain stable).
  - [ ] `markdownlint` is not configured in this repo, but the file ends with a single trailing newline and uses ATX headings consistent with surrounding content.

#### Task 1.2: Create snapshots fixture JSONL (parent task 5.1)
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/fixtures/snapshots.fixture.jsonl` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [GH-1022]  # depends on `Snapshot` type having shipped so the fixture validates against it
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/mcp-server/src/__tests__/fixtures/snapshots.fixture.jsonl`.
  - [ ] Exactly 30 non-empty lines, each a single self-contained JSON object (no pretty-printing, no trailing commas).
  - [ ] Every line has `schemaVersion: 1` and includes all required fields per the `Snapshot` interface (parent plan §Phase 1): `schemaVersion`, `capturedAt`, `owner`, `projectNumber`, `velocity`, `windowDays`, `riskScore`, `status`, `wipByPhase`, `pointsByPhase`, `doneInWindow`, `newInWindow`, `warnings`. `cycleTime` is present on at least 25 of the 30 rows (some null/absent to exercise null-handling in `computeTrends`).
  - [ ] `capturedAt` values are ISO 8601 UTC strings, monotonically increasing across the 30 rows, spaced approximately 24h apart, ending at `2026-05-04T06:00:00Z`.
  - [ ] `owner` is `"cdubiel08"` and `projectNumber` is `3` on every row (matches the dev project; documents the partition convention).
  - [ ] `velocity` and `riskScore` vary across the 30 rows with at least 4 distinct values each so a sparkline renders with multiple bucket characters (not flat-line).
  - [ ] `wipByPhase` keys include at least `"In Progress"`, `"In Review"`, and `"Plan in Progress"`; values are non-negative integers.
  - [ ] `npx vitest run src/__tests__/trends.test.ts` (after Phase 3 / GH-1024 ships) passes when consuming this fixture; no malformed-line warnings in test output.
  - [ ] Each line, when piped through `node -e 'process.stdin.on("data",d=>JSON.parse(d))'`, parses without error. (Manual sanity-check: `while read l; do echo "$l" | jq . > /dev/null; done < <fixture>` exits cleanly.)
  - [ ] File is committed as text (LF line endings).

#### Task 1.3: Verify CI is green (parent task 5.2)
- **files**: `.github/workflows/ci.yml` (read only — no edit expected)
- **tdd**: false
- **complexity**: low
- **depends_on**: [GH-1022, GH-1023, GH-1024]
- **acceptance**:
  - [ ] No edits to `.github/workflows/ci.yml`. (If an edit becomes necessary — e.g., a new external dependency or a longer test timeout — escalate before changing CI surface.)
  - [ ] After this plan's PR is opened (or after the merge commit lands), the `build-and-test-hero` job on the PR / push is green for all three Node versions (18, 20, 22).
  - [ ] The new test files (`snapshots.test.ts`, `cycle-times.test.ts`, `trends.test.ts`, `trends-tools.test.ts`) appear in vitest's reporter output during the CI `Test` step on at least one of the matrix runs (verifiable via the GitHub Actions log).
  - [ ] `npm run build` step in CI emits no TypeScript warnings.
  - [ ] If CI is red, the implementer must record the failure mode in a PR comment and either fix the cause or escalate (this issue does NOT cover fixing test breakage from prior phases — that belongs to whichever phase introduced the regression).

### Phase Success Criteria

#### Automated Verification:
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` — green locally; new fixture file does not break any existing suite.
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` — clean.
- [ ] `wc -l plugin/ralph-hero/mcp-server/src/__tests__/fixtures/snapshots.fixture.jsonl` reports `30`.
- [ ] `jq -c . plugin/ralph-hero/mcp-server/src/__tests__/fixtures/snapshots.fixture.jsonl > /dev/null` exits 0 (every line is valid JSON).
- [ ] `grep -c '"schemaVersion":1' plugin/ralph-hero/mcp-server/src/__tests__/fixtures/snapshots.fixture.jsonl` returns `30`.
- [ ] `grep -n "Performance tracking over time" CLAUDE.md` returns exactly one match under `## Architecture`.
- [ ] `grep -n "^## Trends" plugin/ralph-hero/README.md` returns exactly one match.
- [ ] CI `build-and-test-hero` job green on Node 18 / 20 / 22 on the PR.

#### Manual Verification:
- [ ] Render `plugin/ralph-hero/README.md` on GitHub (or locally with `glow`) — Trends section renders with correct headings and code blocks.
- [ ] Render `CLAUDE.md` on GitHub — new subsection shows under Architecture and reads cleanly.
- [ ] Spot-check 3 random fixture lines: each is valid against the `Snapshot` type (open `mcp-server/src/lib/snapshots.ts` and eyeball-match field names).
- [ ] Confirm the launchd template path mentioned in the README actually exists at `plugin/ralph-hero/scripts/snapshot/launchd/com.ralph.snapshot.plist.template` (Phase 4 / GH-1025 ships it).

**Closes the epic**: With Phase 5 merged, GH-1019 advances from In Progress to Done (its sub-issues #1022–#1026 will all be closed). No further work is planned for the snapshot/trends feature in this epic.

---

## Integration Testing

- [ ] On a fresh checkout post-merge, run `npm ci && npm test` in `plugin/ralph-hero/mcp-server/` — all suites pass including any test that consumes `snapshots.fixture.jsonl`.
- [ ] Open the merged PR's CI run, confirm all three Node matrix entries are green.
- [ ] Smoke: `cat plugin/ralph-hero/mcp-server/src/__tests__/fixtures/snapshots.fixture.jsonl | head -1 | jq '.schemaVersion, .capturedAt, .velocity'` returns `1`, an ISO date, and a number.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1026
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/1019
- Parent plan: `thoughts/shared/plans/2026-05-05-GH-1019-product-performance-over-time.md` (Phase 5, lines 320–358)
- Plan critique (v2, APPROVED): `thoughts/shared/reviews/2026-05-05-GH-1019-critique-v2.md`
- Sibling plans (preceding phases):
  - GH-1022 — `thoughts/shared/plans/2026-05-05-GH-1022-snapshot-capture-jsonl.md` (defines `Snapshot` schema consumed by the fixture)
  - GH-1023 — `thoughts/shared/plans/2026-05-05-GH-1023-cycle-time-enrichment.md` (defines `CycleTimeRollup` referenced in fixture rows)
  - GH-1024 — `thoughts/shared/plans/2026-05-05-GH-1024-trends-query-tool.md` (its `trends.test.ts` consumes this fixture)
  - GH-1025 — `thoughts/shared/plans/2026-05-05-GH-1025-trends-skill-launchd-scheduler.md` (provides the `/ralph-hero:trends` skill + launchd template referenced in README)
- CI workflow: `.github/workflows/ci.yml` (job `build-and-test-hero`, lines 10–35)
- Fixtures dir precedent: `plugin/ralph-hero/mcp-server/src/__tests__/fixtures/`
- CLAUDE.md target section: `## Architecture` (the new subsection appends after `### Caching Strategy`)
