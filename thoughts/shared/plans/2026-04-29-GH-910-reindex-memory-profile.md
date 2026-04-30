---
date: 2026-04-29
status: draft
type: plan
github_issue: 910
github_issues: [910]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/910
primary_issue: 910
tags: [ralph-knowledge, performance, memory-profiling, reindex, embedder, oom]
---

# Profile Reindex Memory Growth and Identify OOM Root Cause - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-26-dreaming-research-trail-and-self-containment]]
- builds_on:: [[2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop]]
- builds_on:: [[2026-03-24-GH-0665-incremental-indexing-mtime]]

## Overview

Single-issue investigation plan with one phase that produces a heap-profile artifact and a research note pinpointing which subsystem is the dominant per-document retainer during `npm run reindex` against the ~1,668-doc corpus.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-910 | Profile reindex memory growth and identify OOM root cause | S |

**Why grouped**: This is the investigation tier of GH-907 — sibling tickets (#911 embedder fix, #912 sqlite-vec fix, #913 regression bench) explicitly state they consume the findings of #910. None of the siblings are in `Ready for Plan`; they are intentionally gated behind this profile so their scopes can be calibrated to the actual dominant retainer.

## Shared Constraints

- **No fix work in this issue.** Output is evidence (heap profile + research note), not source-tree changes to `embedder.ts`, `vector-search.ts`, or `reindex.ts`. Sibling issues #911/#912 own the fix.
- **Reindex against the live corpus on this machine.** The audit at [thoughts/shared/research/2026-04-26-dreaming-research-trail-and-self-containment.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-26-dreaming-research-trail-and-self-containment.md#bug-2-reindex-ooms-the-js-heap) reports `~/.ralph-hero/knowledge.db` already has 1,685 documents and 11,743 chunks. To reproduce the OOM cleanly, drop the DB so the reindex re-embeds every doc from scratch (otherwise mtime skips most files and the leak is not reproduced).
- **Default heap size for the OOM repro.** The acceptance criterion is "OOM with default 4 GB Node heap" — do NOT pass `NODE_OPTIONS="--max-old-space-size=8192"` for the repro run. The 8 GB run is a separate data point for the profile, not the headline OOM proof.
- **`RALPH_CONTEXTUAL_RETRIEVAL=0` for the headline run.** The audit notes that disabling contextual retrieval reduces but does not eliminate the OOM; that is exactly the signal we want — it isolates the leak to the embedder + sqlite-vec + accumulator triad and removes the LLM client as a confound.
- **Working tree must remain clean.** This issue produces (a) a heap snapshot file (kept in `/tmp/` or attached to the issue, not committed unless small enough), (b) a research markdown in `thoughts/shared/research/`, and (c) updates to sibling issue scopes via comments. No source code changes.
- **No new npm dependencies.** Use Node's built-in `--heap-prof` and `process.memoryUsage()` — both are zero-install. `clinic.js` is mentioned as an alternative in the issue body but is NOT required and adds dependency surface.

## Current State Analysis

From the audit (Bug 2: Reindex OOMs the JS heap):

- `npm run reindex` exhausts JS heap on the 1,668-doc corpus. Default Node heap (~4 GB on macOS) hits `FATAL ERROR: Reached heap limit`. Even `--max-old-space-size=8192` (8 GB) OOMs partway through.
- Stack trace: `Builtins_AsyncFunctionAwaitResolveClosure → PromiseFulfillReactionJob → microtask queue exhaustion`.
- Of 14 raw-memory files written by `ingest.py`, only 2 made it into the DB before OOM.

Suspected retainers (from the issue body):

1. `@huggingface/transformers` `FeatureExtractionPipeline` tensor cache. Module-level singleton at [plugin/ralph-knowledge/src/embedder.ts:10](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/embedder.ts#L10) is a fixed cost — not the per-doc retainer. The per-call `output.data` wrapped into `new Float32Array(...)` at [embedder.ts:30](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/embedder.ts#L30) MAY alias the underlying tensor buffer in transformers.js v3 instead of copying.
2. `Float32Array` chunks accumulating in JS heap. Each is 384 floats × 4 bytes = 1.5 KB, but at 11,743 chunks that's ~17 MB total — small unless the underlying tensor stays referenced.
3. `parsedDocs: ParsedDocument[]` accumulator at [plugin/ralph-knowledge/src/reindex.ts:97](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L97). Holds entire `{ id, path, title, content, tags, relationships, untypedEdges, ... }` per file across the whole corpus. Only consumed by `generateIndexes(dirs[0], parsedDocs)` at [reindex.ts:275](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L275). For a corpus where the average doc is ~10 KB of content, this is ~17 MB at 1,700 docs — also small in absolute terms. Higher concern: deep object retention if `relationships` arrays hold strings that share intern pools, etc.
4. sqlite-vec per-chunk `INSERT` allocations. Each chunk does `DELETE FROM documents_vec WHERE id = ?` + `INSERT INTO documents_vec (id, embedding) VALUES (?, ?)` at [vector-search.ts:48-53](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/vector-search.ts#L48-L53), with no transaction batching. better-sqlite3 + sqlite-vec extension may retain Buffer references across statement executions.
5. LLM client `contextualize` response accumulation. Already partially excluded — `RALPH_CONTEXTUAL_RETRIEVAL=0` only reduces the OOM, not eliminates it. So this is at most a contributor, not the dominant retainer.

The promise-chain stack trace strongly suggests microtask queue buildup from the `for (const chunk of chunks) { ... await embed(...) ... }` pattern in `embedDocument()` at [embedder.ts:98-128](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/embedder.ts#L98-L128). Each `await` enqueues a microtask continuation; if the V8 microtask queue is the actual retainer (not the heap data structures), the fix shape changes from "release tensors" to "yield to the macrotask queue between chunks (e.g., `setImmediate`)".

## Desired End State

A research note at `thoughts/shared/research/2026-04-29-reindex-memory-profile.md` (or similar dated filename) that:

- States the doc count at OOM, peak RSS, peak heapUsed, and the per-doc allocation rate (MB/doc).
- Names the dominant retainer class (e.g., "transformer tensor cache", "parsedDocs accumulator", "sqlite-vec buffers") with allocation evidence from a heap snapshot.
- Recommends which sibling issue (#911 embedder fix, #912 sqlite-vec fix, both, or "neither — file new ticket X") owns the fix.
- Includes a heap snapshot file path or commits a summary of the snapshot's top retainers.

### Verification

- [ ] Heap profile artifact (`.heapsnapshot` or `--heap-prof` output) produced, saved to `/tmp/` or `~/Downloads/`, and referenced (with absolute path) in the research note. If small (<1 MB) and not user-data-sensitive, also commit under `thoughts/shared/research/heap-profiles/`.
- [ ] Research note exists in `thoughts/shared/research/` with the dominant retainer named and evidence cited.
- [ ] Recommendation explicitly maps to sibling ticket scope: confirm #911 should land tensor-release + accumulator fix, confirm #912 should land sqlite-vec batching, OR file a new ticket for an unanticipated retainer and update sibling scopes via issue comments.
- [ ] Sibling issues #911, #912, #913 receive a comment linking the research note and updating their scope/priority based on findings.

## What We're NOT Doing

- **Not implementing the fix.** Sibling issues #911 and #912 own the code changes. This issue produces evidence only.
- **Not adding a regression test.** Sibling #913 owns the heap regression bench.
- **Not modifying any source files in `plugin/ralph-knowledge/src/`.** Working tree stays clean except for the research note (and optional heap snapshot artifact).
- **Not introducing new npm dependencies** (no clinic.js, no heapdump, no @memlab). Built-in Node tooling only.
- **Not reproducing on a different machine or smaller corpus.** Use this machine's existing 1,668-doc corpus — that is the definition of the bug.
- **Not fixing the auto-reindex hook in `ingest.py`** (sibling concern, GH-908 line of work).
- **Not addressing the parser's silent `memory_tier` drop** (sibling, GH-906 line of work — the OOM analysis must avoid conflating memory-tier symptoms with the heap leak).

## Implementation Approach

One profiling phase, no fix code. The phase has six tasks: (1) prepare a clean reproduction environment, (2) capture a baseline heap profile at default 4 GB heap to confirm OOM, (3) capture a deeper profile at 8 GB heap to walk further into the corpus before OOM, (4) analyze snapshots to identify the dominant retainer, (5) write the research note, (6) update sibling issue scopes via comments based on findings.

The single phase has no internal phase dependencies (it's atomic). All tasks within the phase are sequential because each builds on the previous task's output (snapshot file → analysis → note → sibling updates).

---

## Phase 1: Profile Reindex Memory and Identify Dominant Retainer

- **depends_on**: null

### Overview

Reproduce the OOM, capture a heap profile, identify the dominant retainer per doc, write findings to a dated research note, and update sibling tickets. No source code changes.

### Tasks

#### Task 1.1: Prepare clean reproduction environment

- **files**: none (operational task; no edits)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `~/.ralph-hero/knowledge.db` is renamed (not deleted) to `~/.ralph-hero/knowledge.db.pre-profile-backup` so the reindex starts from scratch and re-embeds the entire corpus (mtime cache won't short-circuit any docs).
  - [ ] `npm run build` from `plugin/ralph-knowledge/` completes without errors.
  - [ ] `RALPH_CONTEXTUAL_RETRIEVAL=0` is set in the shell for all subsequent reindex runs to isolate the leak from the LLM contextualize path.
  - [ ] Roots config at `~/.ralph/knowledge.config.json` exists and points at the same roots the audit listed (verified with `cat ~/.ralph/knowledge.config.json`).
  - [ ] `du -sh ~/.ralph-hero/knowledge.db.pre-profile-backup` recorded in scratch notes (rough size signal of corpus volume).

#### Task 1.2: Capture baseline OOM with default 4 GB Node heap and `--heap-prof`

- **files**: none (no edits; produces `/tmp/heap-prof-default-*.heapprofile`)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Run executed: `cd plugin/ralph-knowledge && RALPH_CONTEXTUAL_RETRIEVAL=0 node --heap-prof --heap-prof-dir=/tmp dist/reindex.js` (no `--max-old-space-size` override).
  - [ ] Process exits with `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory` or similar OOM signal.
  - [ ] `/tmp/Heap.YYYYMMDD.HHMMSS.PID.0.001.heapprofile` (or similar) file exists.
  - [ ] Recorded data points (in scratch notes): doc count printed before OOM, last "X chunks embedded" log line, wall-clock duration to OOM.
  - [ ] Saved `/tmp/reindex-default-stdout.log` and `/tmp/reindex-default-stderr.log` (use `2>&1 | tee` redirection).

#### Task 1.3: Capture extended-heap profile at 8 GB to deepen the corpus walk

- **files**: none (no edits; produces a second heap profile)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] Run executed: `RALPH_CONTEXTUAL_RETRIEVAL=0 NODE_OPTIONS="--max-old-space-size=8192" node --heap-prof --heap-prof-dir=/tmp dist/reindex.js`.
  - [ ] Either the run completes, or it OOMs at a higher doc count than Task 1.2 (the `--max-old-space-size=8192` audit datapoint).
  - [ ] Second `/tmp/Heap.*.heapprofile` exists, distinguishable by timestamp from Task 1.2's profile.
  - [ ] Recorded: docs processed at OOM (or at completion), peak RSS sampled via a parallel `while sleep 5; do ps -o rss= -p $PID; done` loop in another terminal (PID captured from the launching shell).
  - [ ] Per-doc growth rate computed from the two data points: `(peak_RSS_8gb - peak_RSS_4gb) / (docs_8gb - docs_4gb)` in MB/doc.

#### Task 1.4: Analyze heap profile and identify dominant retainer

- **files**: none (analysis-only; produces scratch notes that feed Task 1.5)
- **tdd**: false
- **complexity**: high
- **depends_on**: [1.2, 1.3]
- **acceptance**:
  - [ ] One of the heap profiles loaded into Chrome DevTools (chrome://inspect → "Open dedicated DevTools for Node" → Memory tab → "Load profile" → select `.heapprofile`) OR analyzed via `npx --yes node-heapdump-analysis` / `node --inspect` post-mortem.
  - [ ] Top 5 retainers by retained size identified, with class names recorded (e.g., `Float32Array`, `Buffer`, `Object (parser.ts:ParsedDocument)`, `Tensor`).
  - [ ] For each top retainer: instance count and total retained bytes captured from the profile.
  - [ ] Dominant retainer named with explicit reasoning (e.g., "transformer Tensor instances at N=X retain Y MB total = Z% of heap, dwarfing parsedDocs at A MB").
  - [ ] Cross-reference: confirm or refute each suspected retainer from the issue body (transformer tensors / Float32Array chunks / parsedDocs / sqlite-vec buffers / LLM contextualize). Mark each as "confirmed dominant", "confirmed contributor", "ruled out", or "indeterminate".
  - [ ] If the dominant retainer is NOT one of the four sibling-mapped suspects, draft language for a follow-up ticket (Task 1.6 will file it).

#### Task 1.5: Write the research note

- **files**: `thoughts/shared/research/2026-04-29-reindex-memory-profile.md` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.4]
- **acceptance**:
  - [ ] File exists at `thoughts/shared/research/2026-04-29-reindex-memory-profile.md` with frontmatter: `date: 2026-04-29`, `type: research`, `status: complete`, `github_issue: 910`, `github_issues: [910, 907, 911, 912, 913]`, `tags: [ralph-knowledge, performance, memory-profiling, reindex, embedder, oom]`.
  - [ ] `## Prior Work` section with `builds_on:: [[2026-04-26-dreaming-research-trail-and-self-containment]]`.
  - [ ] `## Summary` section: 2-4 sentence summary naming the dominant retainer and the recommended sibling-issue mapping.
  - [ ] `## Reproduction` section: exact commands run, environment vars, doc count, peak RSS, peak heapUsed, doc count at OOM, per-doc growth rate (MB/doc).
  - [ ] `## Heap Profile Findings` section: top 5 retainers by retained size with class names, counts, and bytes; dominant retainer named with explicit evidence and supporting numbers.
  - [ ] `## Suspected Retainer Audit` section: each of the five suspects from the issue body classified as "confirmed dominant", "confirmed contributor", "ruled out", or "indeterminate".
  - [ ] `## Recommendation` section: maps findings to sibling tickets (#911 embedder fix, #912 sqlite-vec fix, #913 regression bench). If a non-mapped retainer dominates, names a new follow-up ticket and what its scope should be.
  - [ ] `## Code References` section: at least the four files under analysis with line-level pointers (embedder.ts:23-31, embedder.ts:98-128, reindex.ts:97, reindex.ts:211-240, vector-search.ts:45-54).
  - [ ] `## Heap Profile Artifacts` section: absolute paths to the saved `.heapprofile` files in `/tmp/` (or `thoughts/shared/research/heap-profiles/` if committed).
  - [ ] File committed to `main` (the audit research, this plan, and other recent work all live in `thoughts/shared/research/`).

#### Task 1.6: Update sibling issue scopes via comments

- **files**: none (issue comments via MCP tooling)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.5]
- **acceptance**:
  - [ ] Comment posted on #911 with: link to the research note, confirmation/refutation of the embedder-tensor-leak hypothesis, recommended scope tightening (e.g., "drop parsedDocs accumulator regardless of profile" vs. "only the embedder fix is needed").
  - [ ] Comment posted on #912 with: link to the research note, confirmation/refutation of the sqlite-vec-buffer hypothesis. If the profile shows sqlite-vec is NOT a meaningful retainer, recommend collapsing #912 to a pure throughput optimization or closing it as no-op (per its own "Research Notes" guidance).
  - [ ] Comment posted on #913 with: link to the research note and the heap-threshold recommendation calibrated from the actual peak heapUsed numbers (e.g., "set bench threshold at 600 MB for 500-doc synthetic corpus").
  - [ ] If a non-mapped retainer dominates: new GitHub issue created via the `create_issue` tool with title `bug(ralph-knowledge): [retainer-name] retainer accumulates during reindex`, parent #907, scope drawn from the research note, estimate proposed (XS/S based on retainer class). Sibling issue scopes updated via comment to redirect their work appropriately.
  - [ ] All three sibling issues (and any new ticket) are now ready for the GH-907 followup wave to proceed with calibrated scopes.

### Phase Success Criteria

#### Automated Verification:

- [ ] `cd plugin/ralph-knowledge && npm run build` — no errors (sanity check; nothing should have changed in src/).
- [ ] `cd plugin/ralph-knowledge && npm test` — all tests still passing (sanity check; we should not have touched test code).
- [ ] `git status` shows only the new research markdown file (and optional heap-profile artifacts under `thoughts/shared/research/heap-profiles/`) staged for commit.

#### Manual Verification:

- [ ] Open the heap profile in Chrome DevTools and confirm the dominant retainer matches the research note's claim by inspecting at least two top retainers' retainer paths.
- [ ] Read the research note end-to-end and confirm: the dominant retainer is named, evidence is cited with concrete numbers, the recommendation maps cleanly to sibling tickets.
- [ ] Visit each sibling issue (#911, #912, #913) on GitHub and confirm the scope-update comment is posted and references the research note.
- [ ] If a follow-up ticket was filed: confirm it is labeled `bug`, has parent `#907`, and the new ticket's scope does not overlap with the (now-narrowed) sibling tickets.

**Creates for next phase**: N/A — single phase. Output feeds the GH-907 follow-up wave (#911, #912, #913) which is gated on this profile. Once the research note exists and sibling scopes are updated, those siblings move from `Backlog` to `Ready for Plan` (separate workflow, not part of this plan).

---

## Integration Testing

- [ ] After this plan completes and #910 is moved to `Plan in Review`, verify a human reviewer can read the research note alone (without re-running the profile) and arrive at the same sibling-mapping recommendation.
- [ ] After the human review approves: the sibling tickets #911 and #912 should be plannable using only this research note + their own issue bodies — confirm no information gap by reading those issues post-review.
- [ ] No source-code regression possible from this plan; the only artifacts are markdown and heap snapshots.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/910
- Parent: https://github.com/cdubiel08/ralph-hero/issues/907
- Sibling fix tickets: https://github.com/cdubiel08/ralph-hero/issues/911, https://github.com/cdubiel08/ralph-hero/issues/912, https://github.com/cdubiel08/ralph-hero/issues/913
- Audit: [thoughts/shared/research/2026-04-26-dreaming-research-trail-and-self-containment.md (Bug 2)](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-26-dreaming-research-trail-and-self-containment.md#bug-2-reindex-ooms-the-js-heap)
- Files of interest:
  - [plugin/ralph-knowledge/src/reindex.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts)
  - [plugin/ralph-knowledge/src/embedder.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/embedder.ts)
  - [plugin/ralph-knowledge/src/vector-search.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/vector-search.ts)
- Node `--heap-prof` documentation: https://nodejs.org/api/cli.html#--heap-prof
