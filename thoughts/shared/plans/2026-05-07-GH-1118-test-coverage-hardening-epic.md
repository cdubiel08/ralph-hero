---
date: 2026-05-07
status: draft
type: plan
tags: [testing, ci, coverage, hooks, mcp-server, ralph-knowledge]
github_issue: 1118
github_issues: [1118]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1118
primary_issue: 1118
---

# Test Coverage Hardening Epic — Implementation Plan

## Prior Work

- builds_on:: conversation-2026-05-07-test-coverage-analysis (synthesized in current session — no prior research doc)

## Overview

Address eight test-coverage gaps identified by an analysis pass over the repo, ordered so that visibility-unblocking work (CI wiring, coverage thresholds) lands first and high-leverage runtime-safety work (hook gates, untested lib modules) lands second. The work is scoped to plumbing and direct unit tests — no refactors of the code under test.

## Current State Analysis

The repo has three Node packages with vitest suites:

- `plugin/ralph-hero/mcp-server/` — 70+ test files against ~37 source files. Strong by file count, but three lib modules with no direct tests: `lib/rate-limiter.ts` (89 LOC), `lib/group-detection.ts` (650 LOC, the largest lib file), `lib/dashboard-fetch.ts` (289 LOC). The 530-LOC `index.ts` has only a smoke test that boots the server (`__tests__/entry-point.test.ts:23`); tool-registration completeness is not asserted. `github-client.ts` tests cover single-token construction only — split-token, project-owner mismatch, mutate paths, and rateLimit fragment injection are unverified.
- `plugin/ralph-knowledge/` — 20 tests for 19 source files (1:1). Already has `npm run eval:retrieval -- --assert` and `npm run bench:heap -- --assert` wired in `.github/workflows/ci.yml:108-110`. Eval corpus at `plugin/ralph-knowledge/__tests__/eval-corpus/` is consumed by `scripts/eval-retrieval.ts` against 8 golden queries — opportunity to expand.
- `plugin/ralph-demo/remotion/` — 7 test files for ~17 source files. Schema/presets/templates/themes/transitions all covered.

Shell-test situation:

- `plugin/ralph-hero/scripts/__tests__/*.bats` (4 files) — already wired in CI as the `test-cli` job (`.github/workflows/ci.yml:112-129`).
- `plugin/ralph-hero/hooks/scripts/__tests__/*.test.sh` (6 files for 69 hook scripts) — **not wired in CI**. The hooks directory has shellcheck wired (`.github/workflows/ci.yml:182-191`) but no behavioral tests run.

No package runs `vitest --coverage` or enforces a coverage threshold. There is no Codecov / coverage reporting service in CI.

### Key Discoveries:

- Existing hook test pattern at `plugin/ralph-hero/hooks/scripts/__tests__/val-postcondition.test.sh:1-65` — pure bash, hand-rolled `assert_eq`, JSONL transcript fixtures via `jq`. Easy to clone for new hooks.
- Existing vitest pattern at `plugin/ralph-hero/mcp-server/src/__tests__/cache.test.ts:1-50` — fixtures defined inline as plain consts, vi-mock for octokit (see `github-client.test.ts:5-12`).
- ralph-knowledge eval pattern at `plugin/ralph-knowledge/scripts/eval-retrieval.ts:1-30` — already follows `--assert` exit-code pattern (matches `bench:heap`); golden queries in `evals/golden-queries.json`.
- CI already has `bats-core/bats-action` integration — adding a hook-test job is the same shape minus path.
- vitest 4.x supports `coverage.thresholds` natively via the `@vitest/coverage-v8` package; no extra config harness needed.

## Desired End State

After all phases land:

1. CI runs hook `.test.sh` files on every PR (currently zero coverage in CI).
2. All three Node packages emit coverage reports and fail CI when line coverage drops below an agreed-upon baseline.
3. The four highest-LOC mcp-server modules with no direct tests (`rate-limiter`, `group-detection`, `dashboard-fetch`, plus deeper `github-client` coverage) have direct unit tests asserting their public contracts.
4. The `In Progress` / `In Review` / `Done` transition gates for `impl`/`pr`/`merge` skills have at least one `.test.sh` per gate covering the happy path and one block path.
5. `index.ts` has a registration-audit test that fails if a `register*Tools()` call is dropped.
6. Top-5 autonomous skills (`ralph-impl`, `ralph-plan`, `ralph-research`, `ralph-pr`, `ralph-merge`) have frontmatter-invariant snapshot tests.
7. ralph-knowledge `evals/golden-queries.json` grows from 8 → 16 queries spanning a wider topic range, and the eval threshold tightens accordingly.

Verification: `npm test`, `pnpm test`, hook test runner, and `eval:retrieval --assert` all pass in CI. `coverage/` artifacts uploaded. No skill-frontmatter regression possible without a failing test.

## What We're NOT Doing

- No refactors of the code under test. Every test added asserts the *current* behavior; if a bug surfaces, it gets a follow-up issue, not a behavior change inside this epic.
- No coverage tool other than vitest's built-in `@vitest/coverage-v8`. Not introducing nyc, c8 separately, or codecov-action this round (Codecov upload is a stretch goal in Phase 2).
- No new skill behavior tests beyond frontmatter/structure invariants. Full prompt-eval rigs are deferred.
- No changes to `ralph-demo/remotion/` test coverage — already proportional. It rides along on the threshold gating only.
- No removal of the `eval-corpus/` directory — corrected from initial framing; the runner exists and is wired.
- No new GitHub Actions linters; existing `actionlint`/`zizmor`/`shellcheck` jobs are sufficient.

## Implementation Approach

Eight phases, ordered so visibility lands before targeted hardening:

1. **CI: hook test runner** — small, unblocks regression detection on the next 60+ hook files.
2. **CI: coverage thresholds** — add `--coverage` and per-package floors; baseline from current run.
3. **mcp-server lib unit tests** — `rate-limiter`, `group-detection`, `dashboard-fetch`.
4. **github-client deep coverage** — split-token, project-owner fallback, mutate, rateLimit injection.
5. **Hook gate tests** — impl/pr/merge state machine.
6. **Tool-registration audit** — index.ts surface lock.
7. **Skill frontmatter snapshots** — top-5 autonomous skills.
8. **ralph-knowledge eval expansion** — 8 → 16 golden queries.

Phases 1–2 must land first (visibility). Phases 3–8 are independent and can land in any order or in parallel; they do not share files.

---

## Phase 1: Wire Hook `.test.sh` Suite Into CI

### Overview

Add a new CI job that runs every `*.test.sh` file under `plugin/ralph-hero/hooks/scripts/__tests__/`. The job uses the same Ubuntu runner pattern as `test-cli` and aggregates pass/fail across all test files.

### Changes Required:

#### 1. CI workflow
**File**: `.github/workflows/ci.yml`
**Changes**: Add `test-hooks` job after `test-cli` (line ~129).

```yaml
  test-hooks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1

      - name: Install jq (already present on ubuntu-latest, but assert)
        run: jq --version

      - name: Run hook tests
        run: |
          set -euo pipefail
          fail=0
          for t in plugin/ralph-hero/hooks/scripts/__tests__/*.test.sh; do
            echo "=== $t ==="
            if ! bash "$t"; then
              fail=1
            fi
          done
          exit "$fail"
```

#### 2. Test runner exit-code contract
**File**: `plugin/ralph-hero/hooks/scripts/__tests__/_runner.sh` (new helper, optional)
**Changes**: If aggregating pass/fail counts in CI is preferred over per-file shellout, factor a small runner that reads each file's `PASS`/`FAIL` counters. Skip this if the inline loop above is sufficient.

### Success Criteria:

#### Automated Verification:
- [ ] `test-hooks` CI job runs on PR
- [ ] All 6 existing `.test.sh` files pass under the new job
- [ ] Intentionally failing test causes the job to exit non-zero (verified by toggling one assertion locally before merge)

#### Manual Verification:
- [ ] CI summary shows `test-hooks` as a separate job alongside `test-cli`

**Implementation Note**: Pause here for manual confirmation before Phase 2.

---

## Phase 2: Add Vitest Coverage Thresholds

### Overview

Install `@vitest/coverage-v8` in all three Node packages, configure thresholds in each `vitest.config.ts`, and add `npm run test:coverage` (or augment `test`) so CI runs with coverage. Bake in a baseline threshold derived from a measurement pass — do not invent numbers.

### Changes Required:

#### 1. mcp-server vitest config
**File**: `plugin/ralph-hero/mcp-server/vitest.config.ts`
**Changes**:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/**/*.d.ts"],
      thresholds: {
        lines: 70,      // measure first, then set
        functions: 70,
        branches: 60,
        statements: 70,
      },
    },
  },
});
```

#### 2. mcp-server package.json
**File**: `plugin/ralph-hero/mcp-server/package.json`
**Changes**: Add `@vitest/coverage-v8` to devDependencies; update `test` script to `vitest run --coverage`.

#### 3. ralph-knowledge — same pattern
**File**: `plugin/ralph-knowledge/vitest.config.ts` (currently empty / no file)
**Changes**: Create config with same coverage block. Knowledge package test script also gets `--coverage`.

#### 4. ralph-demo — same pattern
**File**: `plugin/ralph-demo/remotion/vitest.config.ts:1-9`
**Changes**: Add coverage block to existing `defineConfig`. Note: the package uses pnpm; `pnpm add -D @vitest/coverage-v8` lands in `pnpm-lock.yaml`.

#### 5. Threshold baseline measurement
Before opening the PR, run `npm test` once locally in each package, read the coverage summary, and set thresholds 2–3 percentage points below the measured value to allow for flake. Document the chosen numbers inline in each config with a brief one-line comment (e.g., `lines: 72, // 2026-05 baseline 75%`).

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` in each package emits a coverage summary
- [ ] Lowering any threshold by 1% in a follow-up PR causes CI to fail
- [ ] CI artifact upload step (optional) attaches `coverage/lcov.info` per package

#### Manual Verification:
- [ ] Coverage HTML report renders locally via `npx vite preview` of `coverage/index.html` (one-time spot-check)

**Implementation Note**: Pause for manual confirmation. The chosen threshold numbers are a judgment call — confirm with reviewer before locking.

---

## Phase 3: Direct Unit Tests for Untested mcp-server Lib Modules

### Overview

Add `rate-limiter.test.ts`, `group-detection.test.ts`, `dashboard-fetch.test.ts` covering the public API of each module. Pattern: inline fixtures + vi-mocked octokit when the module reaches the network.

### Changes Required:

#### 1. rate-limiter.test.ts
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/rate-limiter.test.ts`
**Changes**: Cover (a) under-100-remaining warning, (b) under-50-remaining block, (c) reset-time pass-through, (d) clean state when `rateLimit` is absent from a response.

```typescript
import { describe, it, expect, vi } from "vitest";
import { checkRateLimit, /* etc */ } from "../lib/rate-limiter.js";

describe("rate-limiter", () => {
  it("warns when remaining < 100 but >= 50", () => { /* ... */ });
  it("throws (or returns block) when remaining < 50", () => { /* ... */ });
  it("no-ops when rateLimit field missing", () => { /* ... */ });
});
```

#### 2. group-detection.test.ts
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/group-detection.test.ts`
**Changes**: 650-LOC module — focus on the module's exported entry points (parent-group classification, child completion thresholds, group-state derivation). Use the same "issues fixture array" pattern as `dashboard.test.ts`.

#### 3. dashboard-fetch.test.ts
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/dashboard-fetch.test.ts`
**Changes**: Already exercised transitively from `hygiene.test.ts`; this test asserts the module's own contract — pagination handling, multi-project fan-out, error path when a project is missing. Mock `client.projectQuery` directly.

### Success Criteria:

#### Automated Verification:
- [ ] Three new test files run in `npm test`
- [ ] Coverage of `lib/rate-limiter.ts`, `lib/group-detection.ts`, `lib/dashboard-fetch.ts` each exceeds 80% lines (measured post-Phase-2)

#### Manual Verification:
- [ ] Tests still pass after a no-op refactor of the modules (sanity that they assert behavior, not implementation)

**Implementation Note**: Pause for manual confirmation.

---

## Phase 4: Deepen `github-client.ts` Coverage

### Overview

`github-client.test.ts` currently asserts construction of single-token clients only. Extend it to cover the four uncovered behaviors.

### Changes Required:

#### 1. Extend github-client.test.ts
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/github-client.test.ts`
**Changes**: Add four `describe` blocks:

- `split-token mode` — `createGitHubClient({ token, repoToken, projectToken })` routes `query` through `repoToken`, `projectQuery` through `projectToken`. Assert via `vi.mocked(graphql.defaults).mock.calls`.
- `project-owner fallback` — when `projectOwner` is omitted, falls back to `owner`; when both `user` and `organization` GraphQL queries are needed, the resolver tries both shapes.
- `mutate / projectMutate` — exposes correct callable, passes payload through.
- `rateLimit fragment injection` — non-mutation queries get `rateLimit { remaining cost resetAt }` injected; mutations do not.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` passes
- [ ] `lib/github-client.ts` line coverage exceeds 85%
- [ ] All four behaviors covered by named `it(...)` cases

#### Manual Verification:
- [ ] Toggling rateLimit injection off in source causes the new test to fail (one-time sanity)

**Implementation Note**: Pause for manual confirmation.

---

## Phase 5: Hook Gate Tests for `impl` / `pr` / `merge` State Machine

### Overview

Add `.test.sh` coverage for the highest-leverage gates that protect the workflow's safety guarantees. Scope: 8 hooks. Pattern: clone the structure of `val-postcondition.test.sh:1-65` — `mktemp` test dir, JSONL transcript fixture, assert exit code.

### Changes Required:

#### 1. New hook test files
**Files** (all in `plugin/ralph-hero/hooks/scripts/__tests__/`):
- `impl-staging-gate.test.sh`
- `impl-plan-required.test.sh`
- `impl-state-gate.test.sh`
- `impl-postcondition.test.sh`
- `impl-worktree-gate.test.sh`
- `pr-state-gate.test.sh`
- `merge-state-gate.test.sh`
- `lock-claim-validator.test.sh`

Each covers: (a) happy path → exit 0, (b) one block path → exit 2 with message on stderr, (c) `stop_hook_active=true` short-circuit if applicable.

#### 2. Reference the existing helpers
The pattern in `val-postcondition.test.sh` constructs the `SCRIPT` path from `dirname` and uses `assert_eq`. Mirror it. No new helper module.

### Success Criteria:

#### Automated Verification:
- [ ] All 8 new `.test.sh` files pass under the Phase-1 CI job
- [ ] Each test file has at least 3 cases
- [ ] Intentionally regressing one gate (locally) causes its test to fail

#### Manual Verification:
- [ ] Spot-read each new test file to confirm it asserts behavior described by the script's leading comment

**Implementation Note**: Pause for manual confirmation. This is the largest phase — consider splitting into 2 PRs (impl gates and pr/merge gates).

---

## Phase 6: Tool-Registration Audit Test

### Overview

`index.ts` (530 LOC) is only smoke-tested. Add a test that boots the server in-process and asserts the registered tool names match an expected manifest.

### Changes Required:

#### 1. New test file
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/tool-registration.test.ts`
**Changes**:

```typescript
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Capture registered tool names
const registered: string[] = [];
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/sdk/server/mcp.js")>();
  return {
    ...actual,
    McpServer: class extends actual.McpServer {
      tool(name: string, ...rest: unknown[]) {
        registered.push(name);
        return super.tool(name, ...(rest as [string, never, never]));
      }
    },
  };
});

describe("tool registration", () => {
  it("registers the full ralph_hero__* tool surface", async () => {
    await import("../index.js"); // triggers all register*Tools() calls
    const expected = [
      "ralph_hero__list_issues",
      "ralph_hero__get_issue",
      // ... pull this list from the current registration audit
    ];
    for (const name of expected) {
      expect(registered).toContain(name);
    }
  });
});
```

The expected list is generated once by running the test in record mode (or by inspecting `tools/*.ts` `server.tool(...)` calls) and locked in.

### Success Criteria:

#### Automated Verification:
- [x] Test passes against current `index.ts`
- [x] Removing one `register*Tools()` call locally causes the test to fail with a clear "missing tool: X" message

#### Manual Verification:
- [x] When a new tool is added to a `tools/*.ts` module, the test failure reminder is clear enough to update the manifest

**Implementation Note**: Pause for manual confirmation.

---

## Phase 7: Skill Frontmatter Snapshot Tests for Top-5 Autonomous Skills

### Overview

Lightweight invariant tests that the five most-dispatched autonomous skills have the required frontmatter fields, the `tools:` allowlist contains the minimum set, and the `model:` field is set. These are not behavior evals — they are "did someone delete a required field" guards.

### Changes Required:

#### 1. New test file
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/skill-frontmatter.test.ts` (or under a new `plugin/ralph-hero/skills/__tests__/` if the team prefers; either works since vitest discovery is per-package).
**Changes**:

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const skillsRoot = join(__dirname, "../../../skills");
const skills = ["ralph-impl", "ralph-plan", "ralph-research", "ralph-pr", "ralph-merge"];

function readFrontmatter(skillName: string): Record<string, unknown> {
  const content = readFileSync(join(skillsRoot, skillName, "SKILL.md"), "utf8");
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error(`No frontmatter in ${skillName}`);
  return parseYaml(m[1]);
}

describe.each(skills)("skill frontmatter: %s", (skill) => {
  const fm = readFrontmatter(skill);
  it("has name + description + model + tools", () => {
    expect(fm.name).toBeDefined();
    expect(fm.description).toBeDefined();
    expect(fm.model).toBeDefined();
    expect(Array.isArray(fm.tools)).toBe(true);
  });
  it("declares the GitHub MCP tools it needs", () => {
    expect(fm.tools).toContain("mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue");
  });
});
```

The exact expected tools list is per-skill. Pull from the agent definition files in `plugin/ralph-hero/agents/` to avoid drift.

### Success Criteria:

#### Automated Verification:
- [ ] All 5 skills pass invariants
- [ ] Removing `tools:` from any skill locally causes the test to fail

#### Manual Verification:
- [ ] Test failure messages clearly identify which skill and which field

**Implementation Note**: Pause for manual confirmation.

---

## Phase 8: Expand ralph-knowledge Retrieval Eval Suite

### Overview

`evals/golden-queries.json` has 8 queries; `eval:retrieval` already gates on Hit@5 ≥ 5/8. Double the suite to 16 queries spanning more of the corpus topics, then re-tune the threshold so it still represents real regression sensitivity (not false reassurance).

### Changes Required:

#### 1. Add 8 new golden queries
**File**: `plugin/ralph-knowledge/evals/golden-queries.json`
**Changes**: Source query topics from existing eval-corpus document titles in `plugin/ralph-knowledge/__tests__/eval-corpus/`:
- chunked embeddings dream-loop
- context handoff topology
- backend hardening postmortem
- RRF calibration
- MMR diversity reranking
- wikilink extractor
- softmax + rerank calibration
- embedder tensor release

Each query gets 1–3 expected document IDs.

#### 2. Tighten threshold
**File**: `plugin/ralph-knowledge/scripts/eval-retrieval.ts`
**Changes**: After expansion, run the eval, observe Hit@5 on 16 queries, set the new threshold to (observed − 1) to leave one-query slack. Document the chosen threshold in a code comment with the date.

### Success Criteria:

#### Automated Verification:
- [ ] `npm run eval:retrieval -- --assert` passes on main with 16 queries
- [ ] Removing one expected doc ID locally drops Hit@5 below threshold and exits 1

#### Manual Verification:
- [ ] The new queries are not trivially answered by exact title match — at least half should require semantic matching

**Implementation Note**: Pause for manual confirmation.

---

## Testing Strategy

### Unit Tests

Phases 3, 4, 6, 7 add direct unit tests with inline fixtures. No new test framework — vitest 4.x throughout.

### Integration Tests

Phase 5 hook tests are integration tests in spirit (they invoke the actual hook script via bash). Phase 6's tool-registration test boots the real server module.

### Manual Testing Steps

1. After Phase 2: open the local `coverage/index.html` for each package, confirm the report renders and the threshold lines are highlighted.
2. After Phase 5: run `bash plugin/ralph-hero/hooks/scripts/__tests__/impl-staging-gate.test.sh` locally, then deliberately corrupt the gate and re-run to confirm exit-2.
3. After Phase 8: open the eval output, scan the Hit@5 misses, confirm they represent semantic-search edge cases (not corpus content gaps).

## Performance Considerations

- Coverage instrumentation slows vitest by ~20%. CI minutes per package will increase modestly. Acceptable.
- Hook test job adds < 30 seconds total — runs serially over 12 files at most.
- ralph-knowledge eval already takes ~1 min in CI; doubling queries adds another minute. Within the existing 10-minute timeout.

## Migration Notes

None. All changes are additive — no existing test or hook is modified, no behavior changes.

## References

- Test coverage analysis (in-session): the conversation that produced this plan.
- Existing hook test reference: `plugin/ralph-hero/hooks/scripts/__tests__/val-postcondition.test.sh:1-65`
- Existing vitest pattern: `plugin/ralph-hero/mcp-server/src/__tests__/cache.test.ts:1-50`
- ralph-knowledge eval runner: `plugin/ralph-knowledge/scripts/eval-retrieval.ts:1-30`
- CI workflow: `.github/workflows/ci.yml:1-200`
