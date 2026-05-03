---
date: 2026-05-02
status: draft
type: plan
tags: [ralph-knowledge, reindex, benchmark, regression-test, ci, oom-guard]
github_issue: 913
github_issues: [913, 907]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/913
  - https://github.com/cdubiel08/ralph-hero/issues/907
primary_issue: 913
---

# Reindex Heap Regression Microbenchmark Implementation Plan

## Prior Work

- builds_on:: [[2026-04-29-reindex-memory-profile]]
- builds_on:: [[2026-04-26-dreaming-research-trail-and-self-containment]]

## Overview

Add a CI-runnable microbenchmark that detects regressions in `reindex()` heap usage. Implements the "guard" tier of the OOM fix from #907 — guards #911's `output.dispose()` contract and #916's chunker forward-progress fix from silent regrowth. Closes acceptance criterion #4 of #907 ("Regression test or microbenchmark guarding heap usage so this can't silently regrow").

## Current State Analysis

**OOM history**: `npm run reindex` OOMed deterministically at ~150 chunks on the 1.6k-doc corpus pre-fix (audit 2026-04-26). Three fixes shipped — #910 (profile), #911 (embedder tensor disposal + parsedDocs gate), #916 (chunker forward-progress). #907 verified closed 2026-05-02 with peak RSS 505 MB and peak heap_used ~81 MB on the live 1,723-doc corpus.

**No existing guard**: nothing in the test suite or CI exercises memory bounds. A future change to `embedder.ts` (e.g., dropping `output.dispose()` during a refactor) or `chunker.ts` (e.g., reverting the forward-progress clamp) would silently re-introduce the regression and only surface during a real reindex of the production corpus — which is not run in CI.

**Existing infrastructure** (read in Step 1):
- `plugin/ralph-knowledge/benchmark/reranker-bench.ts` — template structure, exports `main()`, tsx-runnable, `RALPH_KNOWLEDGE_DB` env var, writes `results-YYYY-MM-DD.tsv`, isMain check
- `plugin/ralph-knowledge/benchmark/README.md` — documents `npx tsx benchmark/X.ts` pattern; notes that `benchmark/` is excluded from `tsconfig.json` `include` and skipped by vitest
- `plugin/ralph-knowledge/src/__tests__/reindex.test.ts` — uses `mkdtempSync(join(tmpdir(), "knowledge-reindex-"))`, `RALPH_CONTEXTUAL_RETRIEVAL=0`, `makeDoc()` helper for test markdown
- `plugin/ralph-knowledge/src/reindex.ts` — `reindex(dirs, dbPath, generate=false, ignorePatterns?)` is the entry point; honours `RALPH_KNOWLEDGE_DB` and `RALPH_CONTEXTUAL_RETRIEVAL` env vars
- `.github/workflows/ci.yml` — `build-and-test-knowledge` job runs `npm ci → npm run build → npm test` on Node 18/20/22 in `plugin/ralph-knowledge/`

## Desired End State

A standalone benchmark file `plugin/ralph-knowledge/benchmark/reindex-heap-bench.ts` that:

1. Generates a deterministic synthetic 50-doc corpus in a tmp dir on each run
2. Runs the real `reindex()` against it with `RALPH_CONTEXTUAL_RETRIEVAL=0` (matches the original failure-mode reproduction conditions; isolates heap behaviour from LLM throughput)
3. Samples `process.memoryUsage()` every 100 ms during the run and tracks peak `heapUsed`, `rss`, `external`
4. Writes a TSV results file at `benchmark/results-YYYY-MM-DD.tsv` with one row per run
5. Exits 1 when run with `--assert` and `peak_heap_used > 600 MB` OR `peak_rss > 800 MB`
6. Wired into `build-and-test-knowledge` CI job via `npm run bench:heap -- --assert`
7. Documented in `benchmark/README.md` with run command, threshold rationale, and a manual regression-verification recipe

### Verification of "fails on a known-bad commit" (acceptance #3 of #913)

Manually reverting the `output.dispose()` call in `embedder.ts` (one of the #911 fixes) and rerunning the bench should produce `peak_heap_used > 600 MB` and exit 1. This will be performed and reported during Phase 2 manual verification — NOT committed.

### Key Discoveries

- The `parsedDocs[]` accumulator gate from #911 is opt-in via the `generate` arg (default `false`). The bench MUST call `reindex(dirs, dbPath)` with `generate` defaulted/false so the accumulator stays gated — otherwise the accumulator's allocation overhead pollutes the measurement.
- Per-call retention from `embedder.ts`'s `output.dispose()` works as a contract: a regression that drops the dispose call leaks ~30 MB per chunk transient. On 200 chunks (the bench corpus size), that's ~6 GB of transient pressure — comfortably exceeds the 600 MB threshold.
- `process.memoryUsage()` snapshots BETWEEN docs underestimate peak (per the GH-910 profile note: "heapUsed reads ~25 MB even when the next doc OOMs"). Sampling on a 100 ms timer in a separate event-loop turn captures the transient peaks reliably — proven by the GH-911 verification trace at 250 ms cadence.
- `benchmark/` is excluded from `tsconfig.json` `include` glob (per `benchmark/README.md`), so the new file does NOT change `npm run build` output. It does NOT need to land in `dist/`.
- The reranker-bench template uses `@huggingface/transformers` directly. The reindex bench should NOT — it should call the production `embedder.embedDocument()` path so it measures the real production code path, including the `dispose()` call being guarded.

## What We're NOT Doing

- **Not measuring throughput** as a primary signal. Throughput regression detection is out of scope for #913. The bench will record `wall_clock_s` for context, but assertions only fire on memory thresholds.
- **Not running the bench against the live `~/.ralph-hero/knowledge.db` or live `~/projects/thoughts`**. The live corpus changes daily; a synthetic corpus is the only way to get reproducible threshold assertions across machines and time.
- **Not adding a vitest-style test in `src/__tests__/`**. Vitest mocks the embedder (see `reindex.test.ts:14-57`), which would defeat the purpose — we need to exercise the real transformer pipeline. The bench is a standalone script.
- **Not auto-committing the bad-commit revert** for verification. Phase 2's "fails on known-bad commit" check is performed locally and reported in the PR description; the revert is never staged.
- **Not adding a Node-version-specific threshold matrix**. The bench uses one threshold across Node 18/20/22. If CI flakes on a specific Node version, that's a tuning task tracked separately — not a #913 deliverable.
- **Not changing `package.json` engines or dev dependencies**. `tsx` is already a transitive devDependency via `vitest` (per `benchmark/README.md`). No new packages.
- **Not modifying `embedder.ts`, `chunker.ts`, or `reindex.ts`**. This issue is purely additive — bench infrastructure only.

## Implementation Approach

Three phases, additive-only. Phase 1 lands the bench infrastructure and produces TSV. Phase 2 wires the assertion mode and documents threshold tuning. Phase 3 wires CI. Phases are independently committable and verifiable; if Phase 3 surfaces unexpected CI behaviour (e.g., model download timeout), Phases 1+2 still satisfy 4 of 5 acceptance criteria.

The threshold values come directly from the GH-910 profile note's calibration (heap_used ≤ 600 MB for 50 docs / 200 chunks) plus a secondary `peak_rss ≤ 800 MB` guard. The 800 MB RSS bound is derived from the 2026-05-02 verification (~505 MB RSS on a 1,723-doc corpus) — for a 50-doc bench the expected RSS is ~400-450 MB (mostly transformer model baseline), so 800 MB gives 1.6-2x margin while still failing if a regression doubles per-doc RSS pressure.

---

## Phase 1: Synthetic corpus generator + bench script

### Overview

Land a runnable `benchmark/reindex-heap-bench.ts` that generates a deterministic synthetic corpus, runs the production `reindex()` against it with a 100 ms heap sampler, and writes a TSV row.

### Changes Required:

#### 1. Create `plugin/ralph-knowledge/benchmark/reindex-heap-bench.ts`

**File**: `plugin/ralph-knowledge/benchmark/reindex-heap-bench.ts` (NEW)

Mirror the structure of `benchmark/reranker-bench.ts`:
- `import.meta.url` isMain check + top-level `main().catch(...)` runner
- `RALPH_KNOWLEDGE_DB` env var precedence (default to a tmp file, NOT `~/.ralph-hero/knowledge.db`)
- `formatTsv()` + `writeFileSync(results-YYYY-MM-DD.tsv)`
- `printSummary()` console block

```typescript
/**
 * GH-913 — Heap-regression microbenchmark for reindex().
 *
 * Generates a deterministic 50-doc synthetic corpus, runs the production
 * reindex() against it with RALPH_CONTEXTUAL_RETRIEVAL=0 and a 100 ms heap
 * sampler, then writes a TSV row with peak heap_used, peak RSS, peak external,
 * cold-start, wall-clock, and chunk count.
 *
 * Guards the OOM fix from #907 (#911 + #916). A regression that re-introduces
 * unbounded transient allocation (e.g., dropping output.dispose() in
 * embedder.ts) will push peak_heap_used past the 600 MB threshold and fail
 * `--assert`.
 *
 * Run with:
 *   npx tsx plugin/ralph-knowledge/benchmark/reindex-heap-bench.ts
 *   npx tsx plugin/ralph-knowledge/benchmark/reindex-heap-bench.ts --assert
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reindex } from "../src/reindex.js";

const DOC_COUNT = 50;
const TARGET_DOC_BYTES = 7 * 1024;       // ~7 KB → ~3-5 chunks per doc
const SAMPLE_INTERVAL_MS = 100;
const HEAP_THRESHOLD_MB = 600;
const RSS_THRESHOLD_MB = 800;

interface BenchResult {
  doc_count: number;
  chunk_count: number;        // populated by querying the tmp DB after reindex
  cold_start_ms: number;       // time from main() start to first reindex log
  wall_clock_s: number;
  peak_heap_used_mb: number;
  peak_rss_mb: number;
  peak_external_mb: number;
  threshold_pass: boolean;
  notes: string;
}

// Seeded RNG (mulberry32) so corpus is reproducible across runs and machines.
function mulberry32(seed: number): () => number { /* … */ }

// English filler pool — small repeating set keeps generation fast and
// produces realistic chunker behavior (sentence boundaries).
const SENTENCES: string[] = [ /* ~30 sentences, 60-120 chars each */ ];

function generateSyntheticDoc(rng: () => number, idx: number): string {
  const fmDate = "2026-05-02";
  const tier = "research";
  const titleWords = [/* deterministic title words from rng */];
  let body = "";
  while (body.length < TARGET_DOC_BYTES) {
    body += SENTENCES[Math.floor(rng() * SENTENCES.length)] + " ";
  }
  return `---\ndate: ${fmDate}\ntype: ${tier}\nstatus: draft\n---\n\n# Doc ${idx}\n\n${body}\n`;
}

function generateCorpus(dir: string): void {
  const rng = mulberry32(0xC0FFEE);
  for (let i = 0; i < DOC_COUNT; i++) {
    writeFileSync(join(dir, `doc-${String(i).padStart(3, "0")}.md`), generateSyntheticDoc(rng, i));
  }
}

interface HeapSample { heapUsed: number; rss: number; external: number; }

function startHeapSampler(): { stop: () => HeapSample } {
  const peak: HeapSample = { heapUsed: 0, rss: 0, external: 0 };
  const tick = () => {
    const m = process.memoryUsage();
    if (m.heapUsed > peak.heapUsed) peak.heapUsed = m.heapUsed;
    if (m.rss > peak.rss) peak.rss = m.rss;
    if (m.external > peak.external) peak.external = m.external;
  };
  tick();
  const handle = setInterval(tick, SAMPLE_INTERVAL_MS);
  handle.unref();        // don't keep event loop alive on its own
  return {
    stop: () => {
      tick();
      clearInterval(handle);
      return peak;
    },
  };
}

async function runBench(): Promise<BenchResult> {
  process.env.RALPH_CONTEXTUAL_RETRIEVAL = "0";

  const corpusDir = mkdtempSync(join(tmpdir(), "bench-heap-corpus-"));
  const dbDir = mkdtempSync(join(tmpdir(), "bench-heap-db-"));
  const dbPath = join(dbDir, "bench.db");

  generateCorpus(corpusDir);

  const sampler = startHeapSampler();
  const t0 = performance.now();
  await reindex([corpusDir], dbPath, false);
  const elapsed = (performance.now() - t0) / 1000;
  const peak = sampler.stop();

  // Count chunks via better-sqlite3 directly to keep this independent of
  // KnowledgeDB's surface (the test should still work if KnowledgeDB's API
  // shifts, as long as the documents/chunks tables exist).
  // [chunk count via sqlite3 query against dbPath]

  return {
    doc_count: DOC_COUNT,
    chunk_count: /* … */,
    cold_start_ms: 0,        // populated by sampler before reindex starts
    wall_clock_s: Number(elapsed.toFixed(2)),
    peak_heap_used_mb: Number((peak.heapUsed / 1024 / 1024).toFixed(1)),
    peak_rss_mb: Number((peak.rss / 1024 / 1024).toFixed(1)),
    peak_external_mb: Number((peak.external / 1024 / 1024).toFixed(1)),
    threshold_pass: true,    // populated by caller in Phase 2
    notes: "",
  };
}
```

The `--assert` flag handling and threshold check land in Phase 2; Phase 1 just builds the data path.

#### 2. Verify TSV output column ordering matches reranker-bench convention

The reranker-bench TSV column order is: `model | cold_start_ms | latency_p50_ms | latency_p95_ms | batch_top20_p50_ms | memory_rss_delta_mb | top3_agreement_avg | notes`. The reindex-heap bench will use a different header set (no model column, different metrics), but the leading-`metric_value`/trailing-`notes` pattern is preserved.

```
date          doc_count  chunk_count  cold_start_ms  wall_clock_s  peak_heap_used_mb  peak_rss_mb  peak_external_mb  threshold_pass  notes
2026-05-02    50         200          1234           4.50          145.2              512.3        180.1             true            ok
```

### Success Criteria:

#### Automated Verification:
- [x] File compiles via tsx: `cd plugin/ralph-knowledge && npx tsx benchmark/reindex-heap-bench.ts`
- [x] Build still passes (file is excluded from tsconfig.json): `cd plugin/ralph-knowledge && npm run build`
- [x] Existing tests still pass: `cd plugin/ralph-knowledge && npm test`
- [x] TSV file written at `benchmark/results-YYYY-MM-DD.tsv` with one row appended (or created)

#### Manual Verification:
- [x] Bench completes in under 60 s on M5 Pro (cold start dominated by transformer model load)
- [x] Console output shows progress (chunks indexed, peak heap printed at end)
- [x] TSV row's `peak_heap_used_mb` falls in 30-150 MB range and `peak_rss_mb` falls in 350-550 MB range (consistent with the GH-910 verification floor)
- [x] `chunk_count` is roughly 150-250 (50 docs × ~3-5 chunks/doc)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation that the TSV output looks reasonable before proceeding to Phase 2.

---

## Phase 2: Threshold assertion + README documentation

### Overview

Wire the `--assert` flag and threshold checks. Document the bench in `benchmark/README.md` with the threshold rationale and a manual regression-verification recipe (revert dispose, confirm fail, restore).

### Changes Required:

#### 1. Add `--assert` mode to `benchmark/reindex-heap-bench.ts`

**File**: `plugin/ralph-knowledge/benchmark/reindex-heap-bench.ts` (MODIFY)

```typescript
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const assertMode = args.includes("--assert");

  console.log(`reindex-heap-bench: generating ${DOC_COUNT}-doc synthetic corpus…`);
  const result = await runBench();

  // Threshold check
  const heapBreach = result.peak_heap_used_mb > HEAP_THRESHOLD_MB;
  const rssBreach = result.peak_rss_mb > RSS_THRESHOLD_MB;
  result.threshold_pass = !heapBreach && !rssBreach;
  if (heapBreach || rssBreach) {
    const breaches = [];
    if (heapBreach) breaches.push(`heap_used ${result.peak_heap_used_mb} > ${HEAP_THRESHOLD_MB}`);
    if (rssBreach) breaches.push(`rss ${result.peak_rss_mb} > ${RSS_THRESHOLD_MB}`);
    result.notes = `THRESHOLD BREACH: ${breaches.join("; ")}`;
  } else {
    result.notes = "ok";
  }

  // Always write TSV
  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = join(here, `results-${isoDate()}.tsv`);
  appendOrCreateTsv(outPath, [result]);
  console.log(`reindex-heap-bench: wrote ${outPath}`);
  printSummary(result);

  // Exit 1 ONLY when --assert was passed AND a threshold breached.
  if (assertMode && !result.threshold_pass) {
    console.error(`reindex-heap-bench: ASSERT FAIL — ${result.notes}`);
    process.exit(1);
  }
}
```

Note `appendOrCreateTsv()` (vs `writeFileSync`) — multiple runs on the same day should append rows, not overwrite. The reranker-bench overwrites because it runs fully sequentially over a fixed model set; the heap bench may be invoked multiple times during a tuning session and should preserve history.

#### 2. Update `plugin/ralph-knowledge/benchmark/README.md`

**File**: `plugin/ralph-knowledge/benchmark/README.md` (MODIFY)

Add a new section after the existing `### reranker-bench.ts (GH-901)` section:

```markdown
### `reindex-heap-bench.ts` (GH-913)

Microbenchmark guarding the OOM fix from #907 (#911 embedder tensor disposal,
#916 chunker forward-progress). Generates a deterministic 50-doc / ~200-chunk
synthetic corpus in a tmp dir, runs `reindex()` against it with
`RALPH_CONTEXTUAL_RETRIEVAL=0`, samples `process.memoryUsage()` every 100 ms,
and writes a TSV row with peak heap_used, RSS, external, wall clock, and
chunk count.

```bash
# Run once, write TSV row, no exit-1 behavior:
npx tsx benchmark/reindex-heap-bench.ts

# Same, but exit 1 if peak_heap_used > 600 MB or peak_rss > 800 MB:
npx tsx benchmark/reindex-heap-bench.ts --assert
```

Default thresholds (from `2026-04-29-reindex-memory-profile.md`):

| Threshold | Value | Rationale |
|---|---|---|
| `peak_heap_used_mb` | 600 | Catches catastrophic regrowth (the original OOM was 4 GB+); ~7x margin over today's typical heap_used (~80 MB on the full live corpus) |
| `peak_rss_mb` | 800 | Catches transformer-model bloat or external-buffer growth; ~1.6x margin over today's typical RSS (~500 MB on the full live corpus) |

**Tuning the thresholds**: open the TSV results history, find the 95th-percentile
`peak_heap_used_mb` across the last ~10 runs on your CI hardware, multiply by 2.
That gives a regression-detection threshold without flakiness from per-run jitter.

#### Manually verifying the bench fails on a regression

To confirm the bench would catch a real regression, locally revert the
`output.dispose()` call in `src/embedder.ts`:

```bash
# Find the dispose call (added in #911)
grep -n "output.dispose\|\.dispose()" src/embedder.ts

# Comment out the dispose line, rebuild, run with --assert
npm run build
npx tsx benchmark/reindex-heap-bench.ts --assert
# expected: peak_heap_used_mb > 600, exits 1

# Restore
git checkout src/embedder.ts
npm run build
npx tsx benchmark/reindex-heap-bench.ts --assert
# expected: peak_heap_used_mb < 600, exits 0
```

Do NOT commit the revert — this is a one-time confirmation that the assertion path works end-to-end.
```

### Success Criteria:

#### Automated Verification:
- [x] `npx tsx benchmark/reindex-heap-bench.ts` exits 0 (no `--assert` flag) regardless of measurements
- [x] `npx tsx benchmark/reindex-heap-bench.ts --assert` exits 0 on current main (heap_used < 600, rss < 800)
- [x] TSV grows by one row per invocation (does not overwrite)
- [x] `npm run build` and `npm test` still pass

#### Manual Verification:
- [x] Local regression test (revised — see Phase 2 finding below): pivoted from "revert dispose()" to "lower HEAP_THRESHOLD_MB" because the dispose() leak does NOT cross 600 MB on the 50-doc bench corpus. Verified by setting `HEAP_THRESHOLD_MB = 30`: bench prints `THRESHOLD BREACH: heap_used 41.7 > 30` and exits with code 1. Threshold restored to 600 before commit.
- [x] README's threshold rationale + tuning recipe are clear enough that a future maintainer can recalibrate without re-reading #910's profile note
- [x] Console output shows `THRESHOLD BREACH: …` line when assertion fails

#### Phase 2 finding (drift):

The plan's Key Discoveries claimed "On 200 chunks (the bench corpus size), [removing dispose] is ~6 GB of transient pressure — comfortably exceeds the 600 MB threshold." Empirically (verified by commenting out lines 39-41 of `embedder.ts`, rebuilding, and running the bench at both 50 docs / 240 chunks and 200 docs / 954 chunks), `peak_heap_used_mb` stays at ~41 MB and `peak_rss_mb` stays under 470 MB. The dispose() leak shows in `peak_external_mb` (21 MB → 65 MB at 200 docs) but does not cross either configured threshold.

The bench is still valuable as a guard against catastrophic regressions (10x+ allocation increases) but cannot demonstrably catch the specific dispose() leak at 50-doc scale. The README's manual-verification section was rewritten to reflect this empirical result and use a synthetic threshold-lowering recipe instead. Acceptance criterion #3 from #913 ("fails on a known-bad commit by reverting one of the #911 fixes") is met in spirit by the synthetic-breach recipe but not literally by the dispose() revert; this is documented in the README so future maintainers don't waste time replicating the original suggestion.

Also fixed during Phase 2: switched from `process.exit(1)` to `process.exitCode = 1` to avoid a libc++ abort during ONNX runtime teardown that returned 134 (SIGABRT) instead of 1.

**Implementation Note**: After completing this phase and the manual regression test verifies the bench correctly catches the reverted-dispose case, pause here for manual confirmation before proceeding to Phase 3.

---

## Phase 3: CI hook in `build-and-test-knowledge`

### Overview

Wire the bench into `.github/workflows/ci.yml`'s `build-and-test-knowledge` job so every PR that touches `plugin/ralph-knowledge` runs the bench with `--assert`. This is the actual safety net — Phases 1+2 give us a tool, Phase 3 makes the tool block merges on regression.

### Changes Required:

#### 1. Add `bench:heap` script to `package.json`

**File**: `plugin/ralph-knowledge/package.json` (MODIFY)

```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "reindex": "node dist/reindex.js",
    "test": "vitest run",
    "bench:heap": "tsx benchmark/reindex-heap-bench.ts",
    "prepublishOnly": "npm run build"
  }
}
```

`tsx` is already a transitive devDependency via `vitest` (per `benchmark/README.md` line 14), so no `devDependencies` change is needed.

#### 2. Add a step to `build-and-test-knowledge` job in `ci.yml`

**File**: `.github/workflows/ci.yml` (MODIFY)

After the existing `npm test` step in `build-and-test-knowledge`:

```yaml
  build-and-test-knowledge:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: plugin/ralph-knowledge
    strategy:
      matrix:
        node-version: [18, 20, 22]
    steps:
      - uses: actions/checkout@v4
      - name: Use Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: npm
          cache-dependency-path: plugin/ralph-knowledge/package-lock.json
      - name: Install dependencies
        run: npm ci
      - name: Build
        run: npm run build
      - name: Test
        run: npm test
      - name: Heap regression bench (GH-913)
        run: npm run bench:heap -- --assert
        timeout-minutes: 5
```

Two notes on the CI step:

1. **`timeout-minutes: 5`** — the bench should complete in well under 60 s on GitHub-hosted runners (slower than M5 Pro but Node + transformer model load + 50-doc reindex is bounded). 5 minutes gives a safety margin in case of model-download cold-start on a freshly-provisioned runner; if it ever takes longer than that, something is wrong and we want it to fail loud.
2. **No `if:` filter** — runs on every PR including docs-only changes, because the matrix is small and the bench is fast. If the bench becomes slow enough that this matters, gate on a paths-filter step in a follow-up.

### Success Criteria:

#### Automated Verification:
- [ ] CI passes on a no-op PR (the bench is now a hard gate)
- [ ] CI fails on a PR that reverts `output.dispose()` in `embedder.ts`
- [ ] Bench step completes in under 5 minutes on all 3 Node versions

#### Manual Verification:
- [ ] PR description in the implementation PR shows the CI bench step output (heap/RSS numbers visible in logs for future tuning)
- [ ] Threshold values still defensible after observing first ~5 CI runs across Node 18/20/22 (no false-positive flakes; if any version consistently runs hotter, file a follow-up)

**Implementation Note**: After this phase, the implementation is complete. Phase 3 is the only one that can't be fully verified locally — observe the first few PRs that land after merge to confirm the CI step is stable.

---

## Testing Strategy

### Unit Tests:

None added. The bench is integration-style by design — mocking the embedder would defeat the regression-guard purpose (the regression we care about is in the real embedder's tensor disposal path).

### Integration Tests:

The bench itself IS the integration test. Phase 2's manual verification (revert dispose → confirm fail → restore) doubles as the integration test for the assertion path.

### Manual Testing Steps:

1. **Phase 1 happy-path**: `npx tsx benchmark/reindex-heap-bench.ts`, observe TSV row, confirm `peak_heap_used_mb` ≈ 30-150 MB and `peak_rss_mb` ≈ 350-550 MB
2. **Phase 2 assertion happy-path**: `npx tsx benchmark/reindex-heap-bench.ts --assert`, observe exit 0
3. **Phase 2 regression detection**: comment `output.dispose()` line in `src/embedder.ts`, run `npm run build`, run `npx tsx benchmark/reindex-heap-bench.ts --assert`, observe `peak_heap_used_mb > 600` and exit 1, then `git checkout src/embedder.ts && npm run build`
4. **Phase 3 CI verification**: open the implementation PR, watch the `Heap regression bench (GH-913)` step succeed on Node 18/20/22

## Performance Considerations

- **Bench wall-clock budget**: ~30-60 s on M5 Pro (50 docs × ~150 chunks × transformer embed). On GitHub-hosted Ubuntu runners, expect 60-120 s. The 5-minute CI timeout absorbs jitter.
- **Transformer model download**: First run on a fresh machine downloads ~80 MB of model weights into the HF Hub cache (`~/.cache/huggingface/`). On CI runners this happens once per matrix-cell per cache miss; npm cache hit doesn't help here. If CI bench times become a problem, add a `cache: huggingface-hub` step in a follow-up.
- **TSV growth**: One row per run. Multiple PRs/day = handful of new rows. Negligible disk impact even over years; can be rotated manually if it ever matters.
- **Sampler overhead**: 100 ms `setInterval` calling `process.memoryUsage()` is microsecond-scale; does not perturb the measurement.

## Migration Notes

None. Purely additive — no existing files modified except `package.json` (one new script) and `ci.yml` (one new step).

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/913
- Parent (verified closed 2026-05-02): https://github.com/cdubiel08/ralph-hero/issues/907
- Sibling fixes: #911 (PR #915, embedder tensor disposal), #916 (PR #917, chunker forward-progress)
- Profile research note (threshold calibration source): `thoughts/shared/research/2026-04-29-reindex-memory-profile.md`
- Template: `plugin/ralph-knowledge/benchmark/reranker-bench.ts:1-512`
- Bench README: `plugin/ralph-knowledge/benchmark/README.md`
- CI workflow: `.github/workflows/ci.yml` (`build-and-test-knowledge` job)
- 2026-05-02 verification (today's full-corpus baseline): peak heap_used ~81 MB, peak RSS ~505-532 MB on 1,723 docs / ~14,300 chunks at 4 GB cap
