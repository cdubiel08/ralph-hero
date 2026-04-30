---
date: 2026-04-29
status: draft
type: plan
tags: [ralph-knowledge, chunker, oom, dream-loop]
github_issue: 916
github_issues: [916]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/916
primary_issue: 916
---

# GH-916: Fix chunker.chunkText() infinite loop on single-atom chunks shorter than chunkOverlap

## Prior Work

- builds_on:: [[2026-04-29-reindex-memory-profile]]
- builds_on:: [[2026-04-29-GH-911-release-embedder-tensors]]

## Overview

`chunkText()` enters an infinite loop and OOMs the JS heap when a chunk consists of a single atom whose length is less than `chunkOverlap` (256). This is the **remaining blocker** for end-to-end dream-loop reindex on the live 1,668-doc corpus — combined with the #911 embedder fix, fixing this enables `npm run reindex` to complete on the full corpus at default 4 GB Node heap.

## Current State Analysis

### Reproduced

Minimal repro: `chunkText(raw)` on the first 18,630 bytes of `landcrawler-ai/thoughts/shared/plans/2025-12-31-oklahoma-permit-raw-migration.md` OOMs at any heap size. Bisection narrowed to slice (0, 18630) — a single byte less (18620) succeeds. The doc is plain markdown with embedded Python code blocks; longest line is 239 chars and longest paragraph is 1933 chars (both well under `chunkSize=2048`).

### Root cause (instrumented trace)

After `flattenToAtoms` produces 74 atoms (correctly), the chunking loop in [`chunkText` chunker.ts:244-276](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/chunker.ts#L244-L276) packs atoms greedily up to `chunkSize`. When it reaches:

- Atom 72: a 230-char paragraph
- Atom 73: an 1,827-char paragraph
- Combined: 230 + 1827 = 2,057 > chunkSize (2048)

The packing loop (line 252) breaks before including atom 73, producing a single-atom chunk for atom 72 alone. Then `findOverlapStartIndex(atoms, 72, 16805, 256)` is called:

- `targetStart = 16805 - 256 = 16549`
- `atoms[72].start = 16575`, which is `>= 16549` → `overlapAtomIdx = 72`
- The walk continues backward to k=71, but `atoms[71].start < 16549` → break
- The guard at [chunker.ts:192-194](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/chunker.ts#L192-L194) checks `overlapAtomIdx > lastEndAtomIndex` (`72 > 72` is false) → guard does not trigger
- Return `overlapAtomIdx = 72`

The caller sets `i = 72` (its previous value). Loop iteration N+1 produces an identical single-atom chunk for atom 72. **Infinite loop.** Each iteration appends a new `Chunk` object to `chunks[]`; the array grows until heap exhausts.

### Why existing tests miss this

The 16 test cases in [`chunker.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/chunker.test.ts) cover empty/short inputs, long documents, overlap behavior, unicode, and separator priority. None construct an input where a chunk would consist of a single atom shorter than `chunkOverlap`. The two long-doc tests use synthetic 8K+ inputs where atoms are uniform-sized, so the packing always produces multi-atom chunks.

### Trigger condition (general)

The bug fires whenever a chunk contains a single atom whose `text.length < chunkOverlap` (default: 256). This happens when:
- Atom N is "short" (< 256 chars; common: a few-line code block, a short sentence, a 1–2 line list item)
- Atom N+1 is "long" enough that `len(N) + len(N+1) > chunkSize` (i.e., len(N+1) > chunkSize - len(N))
- Result: the packer takes only atom N for the current chunk, then `findOverlapStartIndex` returns N → infinite loop

This pattern is common in real markdown (heading → paragraph, short fenced block → long fenced block, short list item → long list item).

### Key Discoveries

- The bug is **algorithmic**, not memory-related. The OOM is a downstream symptom of unbounded loop iterations producing chunk objects.
- `flattenToAtoms` is correct — atoms are produced as expected.
- The infinite loop produces millions of identical chunk objects before the heap exhausts, which matches the `Builtins_StringSubstring → JSEntry` stack trace (each iteration runs `text.slice(charStart, charEnd)` in `buildChunk`).
- The existing "no atoms found" guard ([line 192-194](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/chunker.ts#L192-L194)) is necessary but insufficient. It catches the case where overlap walks past all atoms; it doesn't catch the case where overlap walks back to the previous chunk's start.
- The bug applies to `chunkOverlap > 0` runs only. Setting `chunkOverlap = 0` short-circuits at [line 177-179](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/chunker.ts#L177-L179) and returns `lastEndAtomIndex + 1`, which always makes progress.

## Desired End State

`chunkText()` makes forward progress on every loop iteration regardless of atom layout. Specifically: every call to `chunkText()` returns within bounded time and bounded memory proportional to `text.length`. The 1,668-doc live corpus reindexes successfully via `npm run reindex` at default 4 GB Node heap (combined with the #911 fix already in main).

### Verification

- The minimal repro fixture (a 230-char paragraph followed by an 1,827-char paragraph) chunks correctly with sensible overlap or no overlap.
- The full failing input (`oklahoma-permit-raw-migration.md`, 45 KB) chunks in <1s and produces a sensible chunk count.
- The live 1,668-doc corpus completes `npm run reindex` end-to-end at default 4 GB heap.

## What We're NOT Doing

- **Not changing `DEFAULT_CHUNK_SIZE` or `DEFAULT_CHUNK_OVERLAP`** — these affect embedding semantics; staying at 2048 / 256 preserves embedding compatibility with the existing index.
- **Not refactoring `flattenToAtoms`** — the flatten phase is correct; only the chunking loop needs the fix.
- **Not changing `chunkText`'s public signature** — the existing API contract (input → `Chunk[]` with charStart/charEnd invariants) stays intact.
- **Not streaming the chunker output** — current API returns all chunks; a streaming refactor is a separate enhancement.
- **Not addressing #912 (sqlite-vec batching)** — separate sibling, deprioritized per #910 findings.
- **Not addressing #913 (regression microbenchmark)** — separate sibling that should run AFTER this fix lands so it can use a working full-corpus baseline.

## Implementation Approach

Add a forward-progress guard to the chunking loop. The simplest correct fix is at the call site of `findOverlapStartIndex`: ensure the next chunk's starting atom is strictly greater than the current chunk's starting atom. This preserves the existing overlap semantics whenever overlap is achievable, and falls through to "no overlap, advance to next atom" when the overlap calculation would not produce progress.

Two equivalent fix locations were considered:

1. **At the call site** ([`chunkText` line 275](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/chunker.ts#L275)): clamp `nextStart` to `>= i + 1`. Selected because it makes the progress invariant explicit at the loop control point and doesn't require changing the helper's signature.

2. Inside `findOverlapStartIndex`: pass the previous chunk's first-atom index and clamp internally. Rejected — adds a parameter to a helper for one caller, and the loop control is the natural place to enforce progress.

The fix is one line plus a clarifying comment. Tests for the new invariant cover the trigger pattern explicitly.

## Phase 1: Fix the no-progress case in chunkText's loop

### Overview

Add a forward-progress clamp to the loop that advances `i` after each chunk is emitted. Update the helper's doc comment to clarify the new invariant. Add three regression tests covering the bug.

### Changes Required

#### 1. `plugin/ralph-knowledge/src/chunker.ts`

**Change**: Clamp `nextStart` to ensure `i` strictly advances each iteration.

Current code at lines 268-275:
```typescript
const lastEndAtomIdx = j - 1;
const nextStart = findOverlapStartIndex(
  atoms,
  lastEndAtomIdx,
  chunk.charEnd,
  chunkOverlap,
);
i = nextStart;
```

New code:
```typescript
const lastEndAtomIdx = j - 1;
const nextStart = findOverlapStartIndex(
  atoms,
  lastEndAtomIdx,
  chunk.charEnd,
  chunkOverlap,
);
// Ensure forward progress: when a chunk consists of a single atom shorter
// than chunkOverlap, the overlap walk would land back on the same atom.
// Clamp to i + 1 in that case so we always advance, accepting that the
// resulting chunks will not overlap (this is the only correct option:
// overlap requires that the next chunk start within the previous chunk's
// span, but if the previous chunk has only one atom, there is no earlier
// position within its span to start from).
i = nextStart > i ? nextStart : i + 1;
```

Update the doc comment on `findOverlapStartIndex` (lines 165-170) to note the caller's progress responsibility:

```typescript
/**
 * Compute the start position for the next chunk's atoms given the previous
 * chunk ended at `prevEnd`. We walk backward through the atom list to find
 * the atom whose start >= prevEnd - chunkOverlap; that atom begins the
 * overlap region.
 *
 * NOTE: this function may return an index <= the previous chunk's first atom
 * when the previous chunk consisted of a single atom shorter than chunkOverlap.
 * The caller in chunkText clamps the result to ensure forward progress.
 */
```

### Success Criteria

#### Automated Verification

- [ ] `npm run build` in `plugin/ralph-knowledge/` exits 0
- [ ] `npm test` in `plugin/ralph-knowledge/` exits 0 (all 455+ tests still pass)
- [ ] New tests in `chunker.test.ts` pass (see Phase 2)

#### Manual Verification

- [ ] Repro command from issue body OOMs pre-fix; succeeds post-fix:
  ```bash
  cd plugin/ralph-knowledge
  node --max-old-space-size=512 -e "
    const {chunkText} = require('./dist/chunker.js');
    const fs = require('fs');
    const raw = fs.readFileSync('/Users/dubiel/projects/landcrawler-ai/thoughts/shared/plans/2025-12-31-oklahoma-permit-raw-migration.md','utf-8');
    console.log('chunks:', chunkText(raw).length);
  "
  ```

**Implementation Note**: After Phase 1 + Phase 2 pass automated verification, pause for the manual repro confirmation before continuing to Phase 3.

---

## Phase 2: Add regression tests

### Overview

Add three test cases to `chunker.test.ts` that lock down the fix: the minimal trigger pattern, the post-fix progress invariant on the failing fixture, and a general "every input terminates" property.

### Changes Required

#### 1. `plugin/ralph-knowledge/src/__tests__/chunker.test.ts`

Append a new `describe` block:

```typescript
describe("chunkText — forward progress invariant", () => {
  // Regression test for GH-916. Pre-fix this OOMs.
  it("terminates when a chunk would consist of a single atom shorter than chunkOverlap", () => {
    // Trigger: atom N is short (< 256 chars), atom N+1 is large enough that
    // packing them together would exceed chunkSize (2048).
    const shortAtom = "short paragraph that is under 256 chars.\n\n";
    const longAtom = "x".repeat(1900) + "\n\n";
    const text = shortAtom + longAtom + "tail.";
    const chunks = chunkText(text);
    // We don't care about the exact count; we care that chunkText returns at
    // all (pre-fix it loops forever) and that all chunks have non-empty content.
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(100); // sanity: no runaway
    for (const c of chunks) {
      expect(c.content.length).toBeGreaterThan(0);
    }
  });

  it("makes strict forward progress: chunk[i+1].charStart > chunk[i].charStart", () => {
    // Build an input that triggers many single-atom chunks.
    const blocks = [];
    for (let i = 0; i < 20; i++) {
      blocks.push("short " + i + ".\n\n");
      blocks.push("x".repeat(1900) + "\n\n");
    }
    const chunks = chunkText(blocks.join(""));
    expect(chunks.length).toBeGreaterThan(0);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.charStart).toBeGreaterThan(chunks[i - 1]!.charStart);
    }
  });

  it("chunks the GH-916 fixture file in bounded time and memory", () => {
    // Path-independent fixture: a markdown sample that mirrors the trigger
    // pattern (short paragraphs interspersed with large code blocks).
    const sample = [
      "# Heading\n\n",
      "Short intro paragraph.\n\n",
      "```python\n" + "code line\n".repeat(180) + "```\n\n",
      "Short follow-up.\n\n",
      "```python\n" + "more code\n".repeat(180) + "```\n\n",
      "End.",
    ].join("");
    const start = Date.now();
    const chunks = chunkText(sample);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000); // pre-fix this would not return
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(50); // sanity: no runaway
    // Spot-check the canonical invariant
    for (const c of chunks) {
      expect(sample.slice(c.charStart, c.charEnd)).toBe(c.content);
    }
  });
});
```

### Success Criteria

#### Automated Verification

- [ ] `npx vitest run src/__tests__/chunker.test.ts` exits 0 with all 19+ tests passing (16 existing + 3 new)
- [ ] Pre-fix: confirm at least the first new test hangs/OOMs by reverting Phase 1 in a scratch branch (manual confirmation only, do not commit)

---

## Phase 3: End-to-end verification on the live corpus

### Overview

With #911 (already in main) and Phase 1+2 of this issue, run `npm run reindex` against the live 1,668-doc corpus at default 4 GB Node heap. Append a verification appendix to the existing memory profile research note documenting the result.

### Changes Required

#### 1. Run `npm run reindex` on the live corpus

```bash
# Backup the existing knowledge.db (rename, don't delete)
mv ~/.ralph-hero/knowledge.db ~/.ralph-hero/knowledge.db.pre-916-bak

# Run reindex at default heap with no override
cd plugin/ralph-knowledge
RALPH_CONTEXTUAL_RETRIEVAL=0 npm run reindex 2>&1 | tee /tmp/reindex-post-916.log

# Capture final state
sqlite3 ~/.ralph-hero/knowledge.db "SELECT COUNT(*) FROM documents"
```

Expected: exit 0, document count matches input file count (~1,668), no FATAL ERROR / SIGABRT.

#### 2. Append to research note

Append a new section to [`thoughts/shared/research/2026-04-29-reindex-memory-profile.md`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-29-reindex-memory-profile.md):

```markdown
## End-to-end verification (post-#911 + post-#916)

**Date**: 2026-04-29
**Plugin commit**: <commit sha after Phase 1 lands>
**Node**: v22.22.1 (default 4 GB heap)
**Flags**: `RALPH_CONTEXTUAL_RETRIEVAL=0`

### Result

| Metric | Value |
|---|---|
| Files on disk | 1,668 |
| Documents indexed | <observed> |
| Wall clock | <observed> |
| Peak heap_used | <observed> |
| Peak RSS | <observed> |
| Exit code | 0 |

### Conclusion

The combined fixes from #911 (embedder Tensor disposal + parsedDocs accumulator gate) and #916 (chunker forward-progress guard) close out the parent #907. The dream-loop reindex now works end-to-end at default 4 GB Node heap.
```

### Success Criteria

#### Automated Verification

- [ ] `npm run reindex` exits 0 (no SIGABRT, no FATAL ERROR)
- [ ] `sqlite3 ~/.ralph-hero/knowledge.db "SELECT COUNT(*) FROM documents"` returns >= 1,500 (allowing for some small delta from filesystem-level filtering)
- [ ] Peak `heap_used` observed during the run is < 600 MB (consistent with the #911 acceptance threshold)

#### Manual Verification

- [ ] `dream-now` (the manual end-to-end shortcut from `~/projects/CLAUDE.md`) runs without error
- [ ] `knowledge_search` returns results for a smoke-test query

---

## Testing Strategy

### Unit Tests

- Three new test cases in `chunker.test.ts > "forward progress invariant"`:
  1. Minimal trigger pattern: short atom + long atom causes single-atom chunk → must terminate
  2. General progress invariant: `chunk[i+1].charStart > chunk[i].charStart` always holds
  3. Realistic markdown sample (mirroring the GH-916 fixture pattern) — bounded time, bounded chunk count, content-offset invariant holds

### Integration Tests

- `reindex.test.ts` already exercises `chunkText` via `embedDocument` (existing 33 scenarios). All must continue to pass.

### Manual Testing

1. Run the issue body's repro command pre- and post- fix on a clean clone of `feature/GH-916`. Pre-fix OOMs; post-fix returns `chunks: <number>` quickly.
2. Run the dream-loop end-to-end via `dream-now` from the user's `~/.zshrc`.

## Performance Considerations

The fix is one comparison and one assignment per chunk emitted. No measurable performance impact. The fix may produce slightly fewer chunks (no overlap on single-short-atom chunks vs. infinite chunks), but the change in chunk count is bounded by the number of trigger occurrences in the input — typically <1% of total chunks.

## Migration Notes

No data migration required. The chunker output format is unchanged. Documents that previously failed to chunk (and therefore weren't indexed) will be indexed on the next `reindex` run, naturally adding to the document count.

## References

- Original issue: https://github.com/cdubiel08/ralph-hero/issues/916
- Parent: https://github.com/cdubiel08/ralph-hero/issues/907
- Profile research: [thoughts/shared/research/2026-04-29-reindex-memory-profile.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-29-reindex-memory-profile.md)
- #911 fix (prerequisite, already in main): [thoughts/shared/plans/2026-04-29-GH-911-release-embedder-tensors.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-29-GH-911-release-embedder-tensors.md)
- Chunker source: [plugin/ralph-knowledge/src/chunker.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/chunker.ts)
- Failing fixture: `landcrawler-ai/thoughts/shared/plans/2025-12-31-oklahoma-permit-raw-migration.md` (45 KB markdown, lines 1-end; bisected fail point at first 18,630 bytes)
