---
date: 2026-05-07
status: draft
type: plan
tags: [testing, ci, coverage, vitest, mcp-server, ralph-knowledge, ralph-demo]
github_issue: 1120
github_issues: [1120]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1120
primary_issue: 1120
parent_plan: thoughts/shared/plans/2026-05-07-GH-1118-test-coverage-hardening-epic.md
---

# Vitest Coverage Thresholds Across Node Packages — Implementation Plan

## Prior Work

- builds_on:: [[2026-05-07-GH-1118-test-coverage-hardening-epic]]

## Overview

Atomic implementation of Phase 2 of the test coverage hardening epic (GH-1118): install `@vitest/coverage-v8` in all three Node packages (`mcp-server`, `ralph-knowledge`, `ralph-demo/remotion`), measure baseline coverage, and lock per-package thresholds in each `vitest.config.ts`. CI runs with `--coverage` so future threshold drops fail.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1120 | Phase 2: Add vitest coverage thresholds across Node packages | S |

## Shared Constraints

Inherited from parent plan-of-plans (`2026-05-07-GH-1118-test-coverage-hardening-epic.md`):

- **No refactors of code under test.** Any test added asserts current behavior; bugs surfaced get a follow-up issue, not a behavior change inside this epic.
- **No coverage tool other than vitest's built-in `@vitest/coverage-v8`.** Do not introduce nyc, c8, or codecov-action this round (Codecov upload is explicitly out of scope).
- **No new tests written in this phase.** Only plumbing — config, devDep, script changes. New test authoring is deferred to phases 3–8 of the parent epic.
- **All changes are additive.** No existing test or behavior is modified.
- **Threshold numbers are measured, not invented.** Run `npm test` (or `pnpm test`) once locally per package, read coverage summary, set thresholds 2–3 percentage points below the measured value to allow for flake. Document each chosen number with an inline date comment (e.g., `lines: 72, // 2026-05 baseline 75%`).

Phase-specific constraints discovered during research:

- **`vitest@4.x` already installed in all three packages** (mcp-server: `^4.0.18`, ralph-knowledge: `^4.0.0`, ralph-demo: `^4.1.5`). Adding `@vitest/coverage-v8` at the matching major satisfies its peer dep without an upgrade.
- **`ralph-demo/remotion/` uses pnpm**, not npm. The lockfile to update is `pnpm-lock.yaml` (already exists). `pnpm add -D @vitest/coverage-v8` is the correct install command.
- **`ralph-knowledge/vitest.config.ts` does not exist.** The package's `vitest run` currently uses default config (test discovery via `**/*.test.ts`). A new file must be created.
- **CI already runs `npm test` and `pnpm test` for each package** (`.github/workflows/ci.yml:38, 67, 102`). Updating each package's `test` script to `vitest run --coverage` automatically wires CI to enforce thresholds — no CI workflow edit required for this phase.

## Current State Analysis

| Package | Manager | vitest version | vitest.config.ts | `test` script |
|---------|---------|----------------|------------------|---------------|
| `plugin/ralph-hero/mcp-server` | npm | `^4.0.18` | exists, minimal | `vitest run` |
| `plugin/ralph-knowledge` | npm | `^4.0.0` | **missing** | `vitest run` |
| `plugin/ralph-demo/remotion` | pnpm | `^4.1.5` | exists with jsdom + setupFiles | `vitest run` |

No package currently runs with `--coverage` or enforces a threshold. There is no Codecov / external coverage service in CI.

CI surface (from `.github/workflows/ci.yml`):
- `build-and-test-hero` job → `npm test` in `plugin/ralph-hero/mcp-server` (Node 18/20/22).
- `build-and-test-demo` job → `pnpm test` in `plugin/ralph-demo/remotion`.
- `build-and-test-knowledge` job → `npm test` in `plugin/ralph-knowledge`.

## Desired End State

After this PR lands:

1. Each of the three Node packages has `@vitest/coverage-v8` installed at the matching major.
2. Each package's `vitest.config.ts` defines a `coverage` block with: provider `v8`, reporters `text` + `json-summary` + `lcov`, package-appropriate `include`/`exclude` globs, and lines/functions/branches/statements thresholds.
3. Each package's `test` script runs `vitest run --coverage`.
4. Local `npm test` (and `pnpm test` for remotion) emits a coverage summary in each package.
5. CI fails if any threshold is dropped by 1% in a follow-up PR (the threshold gate is provided by vitest itself — no CI edit needed because `npm test`/`pnpm test` already run in CI).
6. Each package emits `coverage/lcov.info`. (No upload step — that's a stretch goal explicitly out of scope.)

### Verification

- [x] `npm test` in `plugin/ralph-hero/mcp-server/` exits 0 and prints a coverage summary table.
- [x] `npm test` in `plugin/ralph-knowledge/` exits 0 and prints a coverage summary table.
- [x] `pnpm test` in `plugin/ralph-demo/remotion/` exits 0 and prints a coverage summary table.
- [x] Each package contains `coverage/lcov.info` after a test run.
- [x] Decreasing any threshold value by 1 in any config (then re-running) causes vitest to exit non-zero with a clear "X% < threshold" message. (Manual sanity check; revert before commit.)

## What We're NOT Doing

- Adding Codecov / external coverage upload service (stretch goal, not this issue).
- Refactors to improve coverage of any specific file.
- Writing new tests (later phases — 3, 4, 6, 7 of the parent epic).
- Changing the CI workflow file (the existing `npm test` / `pnpm test` steps already run in CI; adding `--coverage` to the package script is sufficient).
- Touching `ralph-demo/remotion/`'s test fixtures, setup files, or jsdom env — only the `coverage` block is added.
- Adding a separate `test:coverage` script. The existing `test` script is updated in place so CI inherits coverage automatically.

## Implementation Approach

The work splits cleanly into two passes per package: (a) install devDep + update script; (b) author the coverage block. Because thresholds must be measured first, the natural ordering is:

1. Install devDep + update script in all three packages.
2. Run tests once per package with a temporary placeholder threshold of 0 (or no threshold block) to capture measured baseline numbers.
3. Bake the measured baseline (minus 2–3 points) into each `vitest.config.ts`.

Tasks 1.1–1.3 below collapse the install step per package; Task 1.4 captures the measurement; Tasks 1.5–1.7 lock thresholds. Within Task 1.5–1.7, package configs do not interact, so they could be parallelized — but the work is small enough that linear is fine.

---

## Phase 1: Install, Measure, Lock

- **depends_on**: null

### Overview

Install `@vitest/coverage-v8` in each package, update each `test` script to add `--coverage`, run tests to capture the measured baseline, then bake threshold floors (baseline − 2–3 points) into each `vitest.config.ts`. No CI workflow changes required.

### Tasks

#### Task 1.1: Install @vitest/coverage-v8 in mcp-server
- **files**: `plugin/ralph-hero/mcp-server/package.json` (modify), `plugin/ralph-hero/mcp-server/package-lock.json` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] `package.json` lists `@vitest/coverage-v8` in `devDependencies` at the same major as `vitest` (`^4.0.18` ⇒ `^4`).
  - [x] `package-lock.json` is regenerated by running `npm install` (no manual edits).
  - [x] `package.json` `scripts.test` is `vitest run --coverage`.

#### Task 1.2: Install @vitest/coverage-v8 in ralph-knowledge
- **files**: `plugin/ralph-knowledge/package.json` (modify), `plugin/ralph-knowledge/package-lock.json` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] `package.json` lists `@vitest/coverage-v8` in `devDependencies` at the same major as `vitest` (`^4.0.0` ⇒ `^4`).
  - [x] `package-lock.json` regenerated via `npm install`.
  - [x] `package.json` `scripts.test` is `vitest run --coverage`.

#### Task 1.3: Install @vitest/coverage-v8 in ralph-demo/remotion
- **files**: `plugin/ralph-demo/remotion/package.json` (modify), `plugin/ralph-demo/remotion/pnpm-lock.yaml` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] `package.json` lists `@vitest/coverage-v8` in `devDependencies` at the same major as `vitest` (`^4.1.5` ⇒ `^4`).
  - [x] `pnpm-lock.yaml` regenerated via `pnpm install` (NOT `npm install` — this package uses pnpm).
  - [x] `package.json` `scripts.test` is `vitest run --coverage`.
  - [x] `package-lock.json` is NOT created in this directory.

#### Task 1.4: Measure baseline coverage in each package
- **files**: (no file edits — measurement only) `plugin/ralph-hero/mcp-server/vitest.config.ts` (read), `plugin/ralph-knowledge/vitest.config.ts` (does not exist yet — see Task 1.6), `plugin/ralph-demo/remotion/vitest.config.ts` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2, 1.3]
- **acceptance**:
  - [x] In `plugin/ralph-hero/mcp-server/`: run `npm test` (which now includes `--coverage` from Task 1.1) and capture lines/functions/branches/statements percentages from the printed table.
  - [x] In `plugin/ralph-knowledge/`: run `npm test` and capture the four percentages. (Baseline runs with default config since `vitest.config.ts` is created in Task 1.6.)
  - [x] In `plugin/ralph-demo/remotion/`: run `pnpm test` and capture the four percentages.
  - [x] Record the 12 measured values (3 packages × 4 metrics) for use in Tasks 1.5, 1.6, 1.7.
  - [x] If any package's tests fail under coverage instrumentation (e.g., timing-sensitive tests breaking with the ~20% slowdown), record the failure and stop — flag for human review before locking thresholds.

#### Task 1.5: Add coverage block to mcp-server vitest config
- **files**: `plugin/ralph-hero/mcp-server/vitest.config.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.4]
- **acceptance**:
  - [x] `coverage` block added under `test` with: `provider: "v8"`, `reporter: ["text", "json-summary", "lcov"]`, `include: ["src/**/*.ts"]`, `exclude: ["src/__tests__/**", "src/**/*.d.ts"]`.
  - [x] `thresholds` object includes `lines`, `functions`, `branches`, `statements` — each set to (Task 1.4 baseline value − 2 to − 3 percentage points), rounded down to a whole integer.
  - [x] Each threshold value has an inline trailing comment in the form `// 2026-05 baseline N%` documenting the measured baseline.
  - [x] `npm test` exits 0.

#### Task 1.6: Create coverage-aware vitest config for ralph-knowledge
- **files**: `plugin/ralph-knowledge/vitest.config.ts` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.4]
- **acceptance**:
  - [x] New file `plugin/ralph-knowledge/vitest.config.ts` exports a `defineConfig` from `vitest/config`.
  - [x] `test.include` preserves the package's existing test discovery (e.g., `["**/*.test.ts"]` or matches whatever vitest's default would have picked up — verify by running `npm test` after creation and confirming the same number of test files are picked up as before Task 1.2).
  - [x] `test.coverage` block follows the same shape as Task 1.5: `provider: "v8"`, three reporters, include/exclude appropriate to this package's source layout (`src/**/*.ts` likely), four thresholds at baseline − 2 to − 3 points with inline date comments.
  - [x] `npm test` exits 0 and discovers the same test files as before.

#### Task 1.7: Add coverage block to ralph-demo/remotion vitest config
- **files**: `plugin/ralph-demo/remotion/vitest.config.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.4]
- **acceptance**:
  - [x] Existing `test` block preserved verbatim (`environment: "jsdom"`, `globals: true`, `include: ["src/**/*.test.{ts,tsx}"]`, `setupFiles: ["src/test-setup.tsx"]`).
  - [x] New `coverage` sub-block added under `test`: `provider: "v8"`, `reporter: ["text", "json-summary", "lcov"]`, `include: ["src/**/*.{ts,tsx}"]`, `exclude: ["src/**/*.test.{ts,tsx}", "src/test-setup.tsx", "src/**/*.d.ts"]`.
  - [x] Four thresholds at baseline − 2 to − 3 with inline date comments.
  - [x] `pnpm test` exits 0.

#### Task 1.8: Verify lcov.info emission
- **files**: (no file edits — verification only)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.5, 1.6, 1.7]
- **acceptance**:
  - [x] `plugin/ralph-hero/mcp-server/coverage/lcov.info` exists after `npm test`.
  - [x] `plugin/ralph-knowledge/coverage/lcov.info` exists after `npm test`.
  - [x] `plugin/ralph-demo/remotion/coverage/lcov.info` exists after `pnpm test`.
  - [x] `coverage/` is in `.gitignore` for each package, OR added in this PR if missing (verify before committing — accidentally checking in `coverage/` artifacts is a common regression).

#### Task 1.9: Sanity-check threshold enforcement
- **files**: (no file edits — manual sanity check; revert before commit)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.5, 1.6, 1.7]
- **acceptance**:
  - [x] In one package, temporarily decrease the `lines` threshold by 1 (e.g., 72 → 73 if baseline is 75), run tests, confirm vitest exits non-zero with a clear "X% < threshold" message.
  - [x] Revert the change before committing the PR.
  - [x] Document the sanity-check outcome in the PR description.

### Phase Success Criteria

#### Automated Verification:
- [x] `npm run build` (in `plugin/ralph-hero/mcp-server/`) — no errors. Sanity check that vitest config changes don't break tsc.
- [x] `npm test` (in `plugin/ralph-hero/mcp-server/`) — passes, prints coverage summary, emits `coverage/lcov.info`.
- [x] `npm test` (in `plugin/ralph-knowledge/`) — passes, prints coverage summary, emits `coverage/lcov.info`.
- [x] `pnpm test` (in `plugin/ralph-demo/remotion/`) — passes, prints coverage summary, emits `coverage/lcov.info`.

#### Manual Verification:
- [ ] All three coverage summary tables show four metrics (lines, functions, branches, statements) at or above the locked threshold.
- [ ] Each `vitest.config.ts` `coverage.thresholds` value carries a `// 2026-05 baseline N%` comment.
- [ ] `coverage/` directories are gitignored — no `coverage/` artifacts staged in the PR.
- [ ] Task 1.9 sanity-check confirmed threshold enforcement works (note in PR description).

**Creates for next phase**: Coverage telemetry and threshold floors that Phases 3, 4, 6, 7 of the parent epic will use to demonstrate measurable coverage uplift on the four target lib modules and `index.ts`.

---

## Integration Testing

- [ ] CI runs all three test jobs (`build-and-test-hero`, `build-and-test-demo`, `build-and-test-knowledge`) green on the PR. The CI workflow file is unchanged — it inherits `--coverage` via the package `test` scripts.
- [ ] No new CI minutes overage. Coverage instrumentation adds ~20% to each test job; total CI time should remain under existing job timeouts.

## References

- Parent plan: [thoughts/shared/plans/2026-05-07-GH-1118-test-coverage-hardening-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-07-GH-1118-test-coverage-hardening-epic.md)
- Parent epic issue: https://github.com/cdubiel08/ralph-hero/issues/1118
- Related issues:
  - https://github.com/cdubiel08/ralph-hero/issues/1119 (Phase 1 — completed)
  - https://github.com/cdubiel08/ralph-hero/issues/1121 (Phase 3 — depends on coverage telemetry from this phase)
  - https://github.com/cdubiel08/ralph-hero/issues/1122 (Phase 4 — depends on coverage telemetry from this phase)
- vitest 4.x coverage docs: https://vitest.dev/config/#coverage
- `@vitest/coverage-v8`: https://www.npmjs.com/package/@vitest/coverage-v8
