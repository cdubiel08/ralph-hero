import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, unlinkSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { findMarkdownFiles } from "../file-scanner.js";
import { FtsSearch } from "../search.js";
import { VectorSearch } from "../vector-search.js";

// Mock embedder so we don't load the real transformer model during tests.
//
// GH-1203: the reindex loop now calls `embedChunks(texts)` directly (batch
// primitive) instead of `embedDocument()` per file. The mock exposes both:
// `embedChunks` for the batched path used by reindex, and a back-compat
// `embedDocument()` for callers outside the reindex path.
//
// The existing test scenarios assert `mockedEmbed.toHaveBeenCalledTimes(N)`
// where N was the number of documents (each docs.embedDocument call = 1
// invocation). To preserve those assertions without churning every test,
// `mockedEmbed` now tracks the count of UNIQUE documents whose chunks
// passed through `embedChunks` — i.e. an `embedChunks` flush that contains
// chunks from K docs increments the doc-counter by K. This keeps the
// "embedded N docs" semantics the tests assert against.
const mockedEmbedDocs = new Set<string>();
let mockedEmbedDocCount = 0;
vi.mock("../embedder.js", () => {
  return {
    embed: vi.fn(async () => new Float32Array(384)),
    // GH-1203 batch primitive — used by the new reindex loop.
    embedChunks: vi.fn(async (texts: string[]) => {
      return texts.map(() => new Float32Array(384));
    }),
    // Back-compat — still used by callers outside the reindex path.
    embedDocument: vi.fn(async () => []),
    prepareTextForEmbedding: vi.fn((title: string, tags: string[], content: string) => {
      const tagLine = tags.length > 0 ? tags.join(", ") : "";
      const parts = [title, tagLine, content].filter(p => p.length > 0);
      return parts.join("\n");
    }),
  };
});

// Suppress unused-warning placeholders for the doc-tracking shims above;
// they're exported via module-scope and accessed indirectly from tests.
void mockedEmbedDocs;
void mockedEmbedDocCount;

// Mock the LLM client so tests can deterministically control availability and
// contextualize() return values without touching the network.
const mockLlmAvailable = vi.fn(async () => true);
const mockLlmContextualize = vi.fn(async (_fullDoc: string, _chunk: string) => "");
vi.mock("../llm-client.js", () => ({
  createLlmClient: vi.fn(() => ({
    available: mockLlmAvailable,
    contextualize: mockLlmContextualize,
  })),
}));

// GH-911: mock generateIndexes so we can assert the parsedDocs[] accumulator
// gate. When generate=false (the default CLI path), the accumulator is skipped
// entirely and generateIndexes is not called. When generate=true, the
// accumulator is populated and generateIndexes is invoked with a non-empty
// ParsedDocument[].
//
// `vi.hoisted()` is required because `vi.mock` factory bodies are hoisted to
// the top of the file before regular `const` declarations run. Hoisting the
// mock fn keeps it accessible from both the factory and the test body.
const { mockGenerateIndexes } = vi.hoisted(() => ({
  mockGenerateIndexes: vi.fn(),
}));
vi.mock("../generate-indexes.js", () => ({
  generateIndexes: mockGenerateIndexes,
}));

import { embedChunks, embedDocument } from "../embedder.js";
import { reindex } from "../reindex.js";
import { KnowledgeDB } from "../db.js";

// GH-1203: the reindex loop now calls `embedChunks(texts)` per batch
// instead of `embedDocument()` per file. `mockedEmbed` is retained as an
// alias for `embedDocument` (still used by callers outside reindex).
// Tests that previously asserted "N docs embedded" via
// `mockedEmbed.toHaveBeenCalledTimes(N)` are migrated to inspect the
// `chunks` table directly via `countEmbeddedDocs(dbPath)`.
const mockedEmbed = vi.mocked(embedDocument);
const mockedEmbedChunks = vi.mocked(embedChunks);

function countEmbeddedDocs(p: string): number {
  const db = new KnowledgeDB(p);
  try {
    const row = db.db
      .prepare("SELECT COUNT(DISTINCT document_id) AS n FROM chunks")
      .get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

/**
 * GH-1203: counts the number of UNIQUE documents whose chunks appeared in
 * `embedChunks` invocations since the last `mockClear()`. The chunk-buffer
 * embeds the doc title at the start of each `embedText` (format:
 * `${title}\n${tagLine}\n${chunk.content}`), so we extract the first line.
 * Tests built around `makeDoc("Doc X")` produce unique titles, making this
 * sufficient as a doc-cardinality proxy.
 */
function countEmbedChunkDocs(): number {
  const titles = new Set<string>();
  for (const call of mockedEmbedChunks.mock.calls) {
    const texts = call[0] as string[];
    for (const t of texts) {
      const firstLine = t.split("\n")[0] ?? "";
      if (firstLine.length > 0) titles.add(firstLine);
    }
  }
  return titles.size;
}

function makeDoc(title: string): string {
  return `---\ndate: 2026-03-24\ntype: research\nstatus: draft\n---\n\n# ${title}\n\nContent for ${title}.`;
}

describe("findMarkdownFiles", () => {
  it("finds .md files recursively", () => {
    const dir = mkdtempSync(join(tmpdir(), "knowledge-test-"));
    writeFileSync(join(dir, "a.md"), "# A");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "b.md"), "# B");
    writeFileSync(join(dir, "c.txt"), "not markdown");

    const files = findMarkdownFiles(dir);
    expect(files).toHaveLength(2);
    expect(files.every(f => f.endsWith(".md"))).toBe(true);
  });

  it("skips dot-directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "knowledge-test-"));
    mkdirSync(join(dir, ".hidden"));
    writeFileSync(join(dir, ".hidden", "secret.md"), "# Hidden");
    writeFileSync(join(dir, "visible.md"), "# Visible");

    const files = findMarkdownFiles(dir);
    expect(files).toHaveLength(1);
  });

  it("returns empty for empty directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "knowledge-test-"));
    const files = findMarkdownFiles(dir);
    expect(files).toHaveLength(0);
  });
});

describe("incremental reindex", () => {
  let dir: string;
  let dbPath: string;
  const originalFlag = process.env.RALPH_CONTEXTUAL_RETRIEVAL;

  beforeEach(() => {
    mockedEmbed.mockClear();
    mockedEmbedChunks.mockClear();
    // Reset LLM mocks to defaults: available returns true, contextualize returns "".
    // Individual tests override these before calling `reindex(...)`.
    mockLlmAvailable.mockReset();
    mockLlmAvailable.mockResolvedValue(true);
    mockLlmContextualize.mockReset();
    mockLlmContextualize.mockResolvedValue("");
    // Reset the GH-911 generateIndexes mock so per-test call counts are clean.
    mockGenerateIndexes.mockClear();
    // Default the flag to disabled for legacy tests so the existing 17 scenarios
    // don't accidentally call the mocked LLM — the Phase 6 tests opt back in
    // explicitly via `process.env.RALPH_CONTEXTUAL_RETRIEVAL = "1"`.
    process.env.RALPH_CONTEXTUAL_RETRIEVAL = "0";
    dir = mkdtempSync(join(tmpdir(), "knowledge-reindex-"));
    dbPath = join(dir, "test.db");
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.RALPH_CONTEXTUAL_RETRIEVAL;
    } else {
      process.env.RALPH_CONTEXTUAL_RETRIEVAL = originalFlag;
    }
  });

  it("scenario 1: unchanged files are skipped on second run", async () => {
    writeFileSync(join(dir, "doc-a.md"), makeDoc("Doc A"));
    writeFileSync(join(dir, "doc-b.md"), makeDoc("Doc B"));

    await reindex([dir], dbPath);
    expect(countEmbedChunkDocs()).toBe(2);

    mockedEmbed.mockClear();
    mockedEmbedChunks.mockClear();
    await reindex([dir], dbPath);
    expect(countEmbedChunkDocs()).toBe(0);
  });

  it("scenario 2: modified file is re-embedded", async () => {
    const filePath = join(dir, "doc-a.md");
    writeFileSync(filePath, makeDoc("Doc A"));
    writeFileSync(join(dir, "doc-b.md"), makeDoc("Doc B"));

    await reindex([dir], dbPath);
    expect(countEmbedChunkDocs()).toBe(2);

    mockedEmbed.mockClear();
    mockedEmbedChunks.mockClear();

    // Update file content and bump mtime by 2 seconds into the future
    writeFileSync(filePath, makeDoc("Doc A Updated"));
    const futureTime = Date.now() / 1000 + 2;
    utimesSync(filePath, futureTime, futureTime);

    await reindex([dir], dbPath);
    expect(countEmbedChunkDocs()).toBe(1);
  });

  it("scenario 3: new file is embedded on second run", async () => {
    writeFileSync(join(dir, "doc-a.md"), makeDoc("Doc A"));

    await reindex([dir], dbPath);
    expect(countEmbedChunkDocs()).toBe(1);

    mockedEmbed.mockClear();
    mockedEmbedChunks.mockClear();

    // Add a new file
    writeFileSync(join(dir, "doc-new.md"), makeDoc("Doc New"));

    await reindex([dir], dbPath);
    // Only the new file should be embedded
    expect(countEmbedChunkDocs()).toBe(1);
  });

  it("scenario 4: deleted file is removed from DB and sync", async () => {
    const filePath = join(dir, "doc-a.md");
    writeFileSync(filePath, makeDoc("Doc A"));
    writeFileSync(join(dir, "doc-b.md"), makeDoc("Doc B"));

    await reindex([dir], dbPath);
    expect(countEmbedChunkDocs()).toBe(2);

    // Verify doc-a exists
    const db1 = new KnowledgeDB(dbPath);
    expect(db1.getDocument("doc-a")).toBeTruthy();
    expect(db1.getAllSyncPaths()).toHaveLength(2);
    db1.close();

    mockedEmbed.mockClear();
    mockedEmbedChunks.mockClear();

    // Delete the file
    unlinkSync(filePath);

    await reindex([dir], dbPath);

    // doc-a should be removed, doc-b should remain
    const db2 = new KnowledgeDB(dbPath);
    expect(db2.getDocument("doc-a")).toBeUndefined();
    expect(db2.getDocument("doc-b")).toBeTruthy();
    const syncPaths = db2.getAllSyncPaths();
    expect(syncPaths).toHaveLength(1);
    expect(syncPaths.some(p => p.includes("doc-a"))).toBe(false);
    db2.close();

    // embed should not have been called since doc-b is unchanged
    expect(countEmbedChunkDocs()).toBe(0);
  });

  it("scenario 5: forced rebuild after clearAll re-embeds all files", async () => {
    writeFileSync(join(dir, "doc-a.md"), makeDoc("Doc A"));
    writeFileSync(join(dir, "doc-b.md"), makeDoc("Doc B"));

    await reindex([dir], dbPath);
    expect(countEmbedChunkDocs()).toBe(2);

    mockedEmbed.mockClear();
    mockedEmbedChunks.mockClear();

    // Simulate forced rebuild: clear the database, then reindex
    const db = new KnowledgeDB(dbPath);
    db.clearAll();
    db.close();

    await reindex([dir], dbPath);
    // All files should be re-embedded since sync table was cleared
    expect(countEmbedChunkDocs()).toBe(2);
  });

  it("scenario 6: stub created for unresolved wikilink target, not for real documents", async () => {
    // File A references file B via wikilink; both exist on disk
    writeFileSync(join(dir, "doc-a.md"), `---\ndate: 2026-03-24\ntype: research\nstatus: draft\n---\n\n# Doc A\n\nSee also builds_on:: [[doc-b]]\n`);
    writeFileSync(join(dir, "doc-b.md"), makeDoc("Doc B"));

    await reindex([dir], dbPath);

    const db = new KnowledgeDB(dbPath);
    // doc-b is a real document — should NOT be a stub
    const docB = db.getDocument("doc-b");
    expect(docB).toBeTruthy();
    expect(docB!.isStub).toBe(0);
    db.close();
  });

  it("scenario 7: schema version change clears sync records and forces full re-embed", async () => {
    writeFileSync(join(dir, "doc-a.md"), makeDoc("Doc A"));
    writeFileSync(join(dir, "doc-b.md"), makeDoc("Doc B"));

    await reindex([dir], dbPath);
    expect(countEmbedChunkDocs()).toBe(2);

    // Verify schema version is set
    const db1 = new KnowledgeDB(dbPath);
    expect(db1.getMeta("schema_version")).toBe("3");
    db1.close();

    mockedEmbed.mockClear();
    mockedEmbedChunks.mockClear();

    // Normal second run — files unchanged, schema version matches
    await reindex([dir], dbPath);
    expect(countEmbedChunkDocs()).toBe(0);

    mockedEmbed.mockClear();
    mockedEmbedChunks.mockClear();

    // Simulate schema version change by setting it to an old value
    const db2 = new KnowledgeDB(dbPath);
    db2.setMeta("schema_version", "1");
    db2.close();

    // Reindex should clear sync and re-embed everything
    await reindex([dir], dbPath);
    expect(countEmbedChunkDocs()).toBe(2);

    // Verify version was updated
    const db3 = new KnowledgeDB(dbPath);
    expect(db3.getMeta("schema_version")).toBe("3");
    db3.close();
  });

  it("scenario 8: stub survives incremental reindex when referencing file is skipped", async () => {
    // File A references non-existent target "phantom"
    writeFileSync(join(dir, "doc-a.md"), `---\ndate: 2026-03-24\ntype: research\nstatus: draft\n---\n\n# Doc A\n\nSee builds_on:: [[phantom]]\n`);

    await reindex([dir], dbPath);

    // Verify stub was created
    const db1 = new KnowledgeDB(dbPath);
    expect(db1.documentExists("phantom")).toBe(true);
    const phantomDoc = db1.getDocument("phantom");
    expect(phantomDoc!.isStub).toBe(1);
    db1.close();

    mockedEmbed.mockClear();
    mockedEmbedChunks.mockClear();

    // Add a new file (doc-a is unchanged and will be skipped)
    writeFileSync(join(dir, "doc-c.md"), makeDoc("Doc C"));
    await reindex([dir], dbPath);

    // phantom stub should still exist even though doc-a was skipped
    const db2 = new KnowledgeDB(dbPath);
    expect(db2.documentExists("phantom")).toBe(true);
    const phantomDoc2 = db2.getDocument("phantom");
    expect(phantomDoc2!.isStub).toBe(1);
    db2.close();
  });

  it("scenario 9: incremental reindex updates only changed file's FTS entry", async () => {
    writeFileSync(join(dir, "doc-a.md"), makeDoc("Alpha Document"));
    writeFileSync(join(dir, "doc-b.md"), makeDoc("Beta Document"));

    await reindex([dir], dbPath);

    // Both documents should be searchable via FTS
    const db1 = new KnowledgeDB(dbPath);
    const fts1 = new FtsSearch(db1);
    fts1.ensureTable();
    expect(fts1.search("Alpha").some(r => r.id === "doc-a")).toBe(true);
    expect(fts1.search("Beta").some(r => r.id === "doc-b")).toBe(true);
    db1.close();

    mockedEmbed.mockClear();
    mockedEmbedChunks.mockClear();

    // Modify doc-a with new content
    const filePath = join(dir, "doc-a.md");
    writeFileSync(filePath, makeDoc("Alpha Gamma Document"));
    const futureTime = Date.now() / 1000 + 2;
    utimesSync(filePath, futureTime, futureTime);

    await reindex([dir], dbPath);

    // Only doc-a should have been re-embedded
    expect(countEmbedChunkDocs()).toBe(1);

    // FTS should reflect the update: "Gamma" now searchable, "Beta" still searchable
    const db2 = new KnowledgeDB(dbPath);
    const fts2 = new FtsSearch(db2);
    fts2.ensureTable();
    expect(fts2.search("Gamma").some(r => r.id === "doc-a")).toBe(true);
    expect(fts2.search("Beta").some(r => r.id === "doc-b")).toBe(true);
    db2.close();
  });

  it("scenario 10: deleted files are removed from FTS results", async () => {
    const filePath = join(dir, "doc-a.md");
    writeFileSync(filePath, makeDoc("Searchable Alpha"));
    writeFileSync(join(dir, "doc-b.md"), makeDoc("Searchable Beta"));

    await reindex([dir], dbPath);

    // Both searchable
    const db1 = new KnowledgeDB(dbPath);
    const fts1 = new FtsSearch(db1);
    fts1.ensureTable();
    expect(fts1.search("Searchable").length).toBe(2);
    db1.close();

    mockedEmbed.mockClear();
    mockedEmbedChunks.mockClear();

    // Delete doc-a
    unlinkSync(filePath);

    await reindex([dir], dbPath);

    // Only doc-b should remain in FTS
    const db2 = new KnowledgeDB(dbPath);
    const fts2 = new FtsSearch(db2);
    fts2.ensureTable();
    const results = fts2.search("Searchable");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("doc-b");
    db2.close();
  });

  it("scenario 11: full FTS rebuild occurs on schema version change", async () => {
    writeFileSync(join(dir, "doc-a.md"), makeDoc("Doc A"));
    writeFileSync(join(dir, "doc-b.md"), makeDoc("Doc B"));

    await reindex([dir], dbPath);

    // Verify FTS works
    const db1 = new KnowledgeDB(dbPath);
    const fts1 = new FtsSearch(db1);
    fts1.ensureTable();
    expect(fts1.search("Doc").length).toBe(2);
    db1.close();

    mockedEmbed.mockClear();
    mockedEmbedChunks.mockClear();

    // Simulate schema version change
    const db2 = new KnowledgeDB(dbPath);
    db2.setMeta("schema_version", "1");
    db2.close();

    // Reindex — should trigger full re-embed AND full FTS rebuild
    await reindex([dir], dbPath);
    expect(countEmbedChunkDocs()).toBe(2);

    // FTS should still work after full rebuild
    const db3 = new KnowledgeDB(dbPath);
    const fts3 = new FtsSearch(db3);
    fts3.ensureTable();
    expect(fts3.search("Doc").length).toBe(2);
    db3.close();
  });

  it("scenario 12: new documents on first index get FTS entries correctly", async () => {
    writeFileSync(join(dir, "fresh-doc.md"), makeDoc("Fresh Content Here"));

    await reindex([dir], dbPath);

    // Should be searchable
    const db1 = new KnowledgeDB(dbPath);
    const fts1 = new FtsSearch(db1);
    fts1.ensureTable();
    const results = fts1.search("Fresh");
    expect(results.some(r => r.id === "fresh-doc")).toBe(true);
    db1.close();
  });

  it("scenario 13: 8K-char document produces >= 4 chunk rows", async () => {
    const longBody = "A".repeat(8000);
    writeFileSync(
      join(dir, "long-doc.md"),
      `---\ndate: 2026-03-24\ntype: research\nstatus: draft\n---\n\n# Long Doc\n\n${longBody}`,
    );

    await reindex([dir], dbPath);

    const db = new KnowledgeDB(dbPath);
    const row = db.db
      .prepare("SELECT COUNT(*) as n FROM chunks WHERE document_id = ?")
      .get("long-doc") as { n: number };
    expect(row.n).toBeGreaterThanOrEqual(4);
    db.close();
  });

  it("scenario 14: documents_vec row count equals total chunk count", async () => {
    writeFileSync(join(dir, "doc-a.md"), makeDoc("Doc A"));
    writeFileSync(join(dir, "doc-b.md"), makeDoc("Doc B"));
    const longBody = "A".repeat(6000);
    writeFileSync(
      join(dir, "long-doc.md"),
      `---\ndate: 2026-03-24\ntype: research\nstatus: draft\n---\n\n# Long Doc\n\n${longBody}`,
    );

    await reindex([dir], dbPath);

    const db = new KnowledgeDB(dbPath);
    // Instantiating VectorSearch loads sqlite-vec so documents_vec is queryable.
    new VectorSearch(db).createIndex();
    const chunksRow = db.db.prepare("SELECT COUNT(*) as n FROM chunks").get() as {
      n: number;
    };
    const vecRow = db.db
      .prepare("SELECT COUNT(*) as n FROM documents_vec")
      .get() as { n: number };
    expect(vecRow.n).toBe(chunksRow.n);
    expect(chunksRow.n).toBeGreaterThanOrEqual(3); // at least one per doc
    db.close();
  });

  it("scenario 15: chunk ids follow pattern {docId}#c{index}", async () => {
    const longBody = "A".repeat(6000);
    writeFileSync(
      join(dir, "long-doc.md"),
      `---\ndate: 2026-03-24\ntype: research\nstatus: draft\n---\n\n# Long Doc\n\n${longBody}`,
    );

    await reindex([dir], dbPath);

    const db = new KnowledgeDB(dbPath);
    new VectorSearch(db).createIndex();
    const rows = db.db
      .prepare("SELECT id, chunk_index FROM chunks WHERE document_id = ? ORDER BY chunk_index")
      .all("long-doc") as Array<{ id: string; chunk_index: number }>;
    expect(rows.length).toBeGreaterThan(1);
    const idPattern = /^long-doc#c\d+$/;
    for (const r of rows) {
      expect(r.id).toMatch(idPattern);
      expect(r.id).toBe(`long-doc#c${r.chunk_index}`);
    }
    // Verify documents_vec ids also follow the pattern for this doc.
    const vecRows = db.db
      .prepare("SELECT id FROM documents_vec WHERE id GLOB ?")
      .all("long-doc#c*") as Array<{ id: string }>;
    expect(vecRows.length).toBe(rows.length);
    for (const v of vecRows) {
      expect(v.id).toMatch(idPattern);
    }
    db.close();
  });

  it("scenario 16: deleting source file removes its chunks and vec rows", async () => {
    const filePath = join(dir, "disposable.md");
    const longBody = "A".repeat(6000);
    writeFileSync(
      filePath,
      `---\ndate: 2026-03-24\ntype: research\nstatus: draft\n---\n\n# Disposable\n\n${longBody}`,
    );
    writeFileSync(join(dir, "keeper.md"), makeDoc("Keeper"));

    await reindex([dir], dbPath);

    const db1 = new KnowledgeDB(dbPath);
    new VectorSearch(db1).createIndex();
    const chunksBefore = db1.db
      .prepare("SELECT COUNT(*) as n FROM chunks WHERE document_id = ?")
      .get("disposable") as { n: number };
    expect(chunksBefore.n).toBeGreaterThan(1);
    const vecsBefore = db1.db
      .prepare("SELECT COUNT(*) as n FROM documents_vec WHERE id GLOB ?")
      .get("disposable#c*") as { n: number };
    expect(vecsBefore.n).toBe(chunksBefore.n);
    db1.close();

    unlinkSync(filePath);
    await reindex([dir], dbPath);

    const db2 = new KnowledgeDB(dbPath);
    new VectorSearch(db2).createIndex();
    // Document gone -> chunks cascaded.
    expect(db2.getDocument("disposable")).toBeUndefined();
    const chunksAfter = db2.db
      .prepare("SELECT COUNT(*) as n FROM chunks WHERE document_id = ?")
      .get("disposable") as { n: number };
    expect(chunksAfter.n).toBe(0);
    // Vec rows for the deleted doc are gone (GLOB-based cleanup).
    const vecsAfter = db2.db
      .prepare("SELECT COUNT(*) as n FROM documents_vec WHERE id GLOB ?")
      .get("disposable#c*") as { n: number };
    expect(vecsAfter.n).toBe(0);
    // The kept doc still has its chunks.
    const keeperChunks = db2.db
      .prepare("SELECT COUNT(*) as n FROM chunks WHERE document_id = ?")
      .get("keeper") as { n: number };
    expect(keeperChunks.n).toBeGreaterThanOrEqual(1);
    db2.close();
  });

  it("scenario 17: re-indexing same file does not duplicate chunks", async () => {
    const filePath = join(dir, "stable.md");
    const body = "A".repeat(6000);
    writeFileSync(
      filePath,
      `---\ndate: 2026-03-24\ntype: research\nstatus: draft\n---\n\n# Stable\n\n${body}`,
    );

    await reindex([dir], dbPath);
    const db1 = new KnowledgeDB(dbPath);
    const firstCount = (db1.db
      .prepare("SELECT COUNT(*) as n FROM chunks WHERE document_id = ?")
      .get("stable") as { n: number }).n;
    db1.close();
    expect(firstCount).toBeGreaterThan(1);

    // Bump mtime to force re-embed.
    const future = Date.now() / 1000 + 2;
    utimesSync(filePath, future, future);

    await reindex([dir], dbPath);
    const db2 = new KnowledgeDB(dbPath);
    new VectorSearch(db2).createIndex();
    const secondCount = (db2.db
      .prepare("SELECT COUNT(*) as n FROM chunks WHERE document_id = ?")
      .get("stable") as { n: number }).n;
    // Stale deletion before insert means chunk count stays the same, not 2x.
    expect(secondCount).toBe(firstCount);
    // And vec rows should match.
    const vecCount = (db2.db
      .prepare("SELECT COUNT(*) as n FROM documents_vec WHERE id GLOB ?")
      .get("stable#c*") as { n: number }).n;
    expect(vecCount).toBe(secondCount);
    db2.close();
  });

  // ---- Phase 6 (GH-767): Contextual Retrieval wiring ----

  it("scenario 18: RALPH_CONTEXTUAL_RETRIEVAL=0 skips LLM entirely", async () => {
    process.env.RALPH_CONTEXTUAL_RETRIEVAL = "0";
    mockLlmContextualize.mockResolvedValue("SHOULD NOT APPEAR");

    writeFileSync(join(dir, "doc-a.md"), makeDoc("Doc A"));

    await reindex([dir], dbPath);

    // Zero LLM activity when the flag is off.
    expect(mockLlmAvailable).not.toHaveBeenCalled();
    expect(mockLlmContextualize).not.toHaveBeenCalled();

    // All chunks should have empty context_prefix.
    const db = new KnowledgeDB(dbPath);
    const rows = db.db
      .prepare("SELECT context_prefix FROM chunks WHERE document_id = ?")
      .all("doc-a") as Array<{ context_prefix: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.context_prefix).toBe("");
    }
    db.close();
  });

  it("scenario 19: flag on + LLM unreachable -> empty context_prefix + single warning", async () => {
    process.env.RALPH_CONTEXTUAL_RETRIEVAL = "1";
    mockLlmAvailable.mockResolvedValue(false);
    // contextualize should never be called because available() returned false.
    mockLlmContextualize.mockResolvedValue("UNREACHED");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      writeFileSync(join(dir, "doc-a.md"), makeDoc("Doc A"));
      writeFileSync(join(dir, "doc-b.md"), makeDoc("Doc B"));

      await reindex([dir], dbPath);

      // available() probed exactly once per reindex call.
      expect(mockLlmAvailable).toHaveBeenCalledTimes(1);
      // contextualize() never invoked on the fail-open path.
      expect(mockLlmContextualize).not.toHaveBeenCalled();

      // Exactly one "unreachable" warning (other warnings like frontmatter are allowed).
      const unreachableWarnings = warnSpy.mock.calls.filter(args =>
        args.some(a => typeof a === "string" && /LLM endpoint unreachable/.test(a)),
      );
      expect(unreachableWarnings).toHaveLength(1);

      const db = new KnowledgeDB(dbPath);
      const rows = db.db
        .prepare("SELECT context_prefix FROM chunks")
        .all() as Array<{ context_prefix: string }>;
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.context_prefix).toBe("");
      }
      db.close();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("scenario 20: flag on + reachable LLM -> non-empty context_prefix persisted", async () => {
    process.env.RALPH_CONTEXTUAL_RETRIEVAL = "1";
    mockLlmAvailable.mockResolvedValue(true);
    mockLlmContextualize.mockResolvedValue("GENERATED CONTEXT");

    writeFileSync(join(dir, "doc-a.md"), makeDoc("Doc A"));

    await reindex([dir], dbPath);

    expect(mockLlmAvailable).toHaveBeenCalledTimes(1);
    expect(mockLlmContextualize).toHaveBeenCalled();

    const db = new KnowledgeDB(dbPath);
    const rows = db.db
      .prepare("SELECT context_prefix FROM chunks WHERE document_id = ?")
      .all("doc-a") as Array<{ context_prefix: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.context_prefix).toBe("GENERATED CONTEXT");
    }
    db.close();
  });

  it("scenario 21: flag defaults on (undefined env) and probes LLM", async () => {
    delete process.env.RALPH_CONTEXTUAL_RETRIEVAL;
    mockLlmAvailable.mockResolvedValue(true);
    mockLlmContextualize.mockResolvedValue("DEFAULT ON");

    writeFileSync(join(dir, "doc-a.md"), makeDoc("Doc A"));

    await reindex([dir], dbPath);

    // available() probed because flag was not "0" / "false".
    expect(mockLlmAvailable).toHaveBeenCalledTimes(1);
    expect(mockLlmContextualize).toHaveBeenCalled();
  });

  it("scenario 22: 'false' also disables contextual retrieval", async () => {
    process.env.RALPH_CONTEXTUAL_RETRIEVAL = "false";
    mockLlmContextualize.mockResolvedValue("SHOULD NOT APPEAR");

    writeFileSync(join(dir, "doc-a.md"), makeDoc("Doc A"));

    await reindex([dir], dbPath);

    expect(mockLlmAvailable).not.toHaveBeenCalled();
    expect(mockLlmContextualize).not.toHaveBeenCalled();
  });

  it("scenario 23: re-running with unchanged content reuses cached context_prefix (no new LLM calls)", async () => {
    process.env.RALPH_CONTEXTUAL_RETRIEVAL = "1";
    mockLlmAvailable.mockResolvedValue(true);
    mockLlmContextualize.mockResolvedValue("INITIAL CTX");

    const filePath = join(dir, "doc-a.md");
    writeFileSync(filePath, makeDoc("Doc A"));

    await reindex([dir], dbPath);
    const firstCallCount = mockLlmContextualize.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    // Bump mtime without changing content — this defeats the outer mtime skip
    // and forces the inner content-hash cache check to fire.
    const future = Date.now() / 1000 + 2;
    utimesSync(filePath, future, future);

    mockLlmContextualize.mockClear();
    // Swap the mock return so we can prove cached prefixes were reused: if the
    // cache missed and a live call happened, the new return value would show up
    // in the DB.
    mockLlmContextualize.mockResolvedValue("LIVE (SHOULD NOT OCCUR)");

    await reindex([dir], dbPath);

    // Zero fresh calls because content hash matched the meta cache.
    expect(mockLlmContextualize).not.toHaveBeenCalled();

    const db = new KnowledgeDB(dbPath);
    const rows = db.db
      .prepare("SELECT context_prefix FROM chunks WHERE document_id = ?")
      .all("doc-a") as Array<{ context_prefix: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.context_prefix).toBe("INITIAL CTX");
    }
    db.close();
  });

  // ---- GH-906: memory_tier write path round-trip ----
  //
  // These scenarios exercise the full parser -> upsertDocument -> documents.memory_tier
  // path on real disk + real DB. They do NOT use ":memory:" and do NOT hand-craft
  // INSERT statements — the bug was that frontmatter values were silently dropped
  // before reaching the DB, so any test that bypasses parseDocument or upsertDocument
  // is unable to catch a regression here.

  it("scenario 24: memory_tier from frontmatter is persisted to the documents table", async () => {
    writeFileSync(
      join(dir, "raw-memory.md"),
      `---\ndate: 2026-04-29\ntype: research\nstatus: draft\nmemory_tier: raw\n---\n\n# Raw Memory Sample\n\nDream-loop raw memory body.`,
    );

    await reindex([dir], dbPath);

    const db = new KnowledgeDB(dbPath);
    try {
      expect(db.getMemoryTier("raw-memory")).toBe("raw");
      // Belt-and-suspenders: assert against raw SQL too, in case getMemoryTier
      // semantics ever change (e.g., column-existence guard, alias drift).
      const row = db.db
        .prepare("SELECT memory_tier FROM documents WHERE id = ?")
        .get("raw-memory") as { memory_tier: string };
      expect(row.memory_tier).toBe("raw");
    } finally {
      db.close();
    }
  });

  it("scenario 25: memory_tier: reflection round-trips through reindex", async () => {
    writeFileSync(
      join(dir, "reflection-doc.md"),
      `---\ndate: 2026-04-29\ntype: research\nstatus: draft\nmemory_tier: reflection\n---\n\n# Reflection Sample\n\nSynthesized reflection body.`,
    );

    await reindex([dir], dbPath);

    const db = new KnowledgeDB(dbPath);
    try {
      expect(db.getMemoryTier("reflection-doc")).toBe("reflection");
    } finally {
      db.close();
    }
  });

  it("scenario 26: missing memory_tier defaults to 'doc' end-to-end", async () => {
    writeFileSync(
      join(dir, "default-doc.md"),
      `---\ndate: 2026-04-29\ntype: research\nstatus: draft\n---\n\n# Default Doc\n\nNo memory_tier in frontmatter.`,
    );

    await reindex([dir], dbPath);

    const db = new KnowledgeDB(dbPath);
    try {
      expect(db.getMemoryTier("default-doc")).toBe("doc");
    } finally {
      db.close();
    }
  });

  it("scenario 27: invalid memory_tier in frontmatter coerces to 'doc'", async () => {
    writeFileSync(
      join(dir, "garbage-tier.md"),
      `---\ndate: 2026-04-29\ntype: research\nstatus: draft\nmemory_tier: garbage\n---\n\n# Garbage Tier\n\nInvalid memory_tier value.`,
    );

    await reindex([dir], dbPath);

    const db = new KnowledgeDB(dbPath);
    try {
      expect(db.getMemoryTier("garbage-tier")).toBe("doc");
    } finally {
      db.close();
    }
  });

  // ---- GH-911: parsedDocs[] accumulator gating ----
  //
  // The accumulator is only consumed by `generateIndexes()` when `generate=true`.
  // Phase 2 wraps `parsedDocs.push(parsed)` in `if (generate)` so the
  // unbounded array isn't built up under the default `generate=false` CLI path.
  // These tests exercise both branches via the mocked `generateIndexes`.

  it("scenario 28: generate=false skips generateIndexes entirely", async () => {
    writeFileSync(join(dir, "doc-a.md"), makeDoc("Doc A"));
    writeFileSync(join(dir, "doc-b.md"), makeDoc("Doc B"));

    // Default generate=false (third positional arg omitted).
    await reindex([dir], dbPath);

    expect(mockGenerateIndexes).not.toHaveBeenCalled();
  });

  it("scenario 29: generate=true invokes generateIndexes with a non-empty ParsedDocument[]", async () => {
    writeFileSync(join(dir, "doc-a.md"), makeDoc("Doc A"));
    writeFileSync(join(dir, "doc-b.md"), makeDoc("Doc B"));

    await reindex([dir], dbPath, true);

    expect(mockGenerateIndexes).toHaveBeenCalledTimes(1);
    const callArgs = mockGenerateIndexes.mock.calls[0];
    // First arg: outDir (the first directory passed to reindex).
    expect(callArgs[0]).toBe(dir);
    // Second arg: ParsedDocument[] populated with both docs.
    const parsedDocs = callArgs[1] as Array<{ id: string }>;
    expect(parsedDocs).toHaveLength(2);
    const ids = parsedDocs.map((d) => d.id).sort();
    expect(ids).toEqual(["doc-a", "doc-b"]);
  });

  it("scenario 30: generate=false produces same DB state as generate=true (only the index files differ)", async () => {
    writeFileSync(join(dir, "doc-a.md"), makeDoc("Doc A"));
    writeFileSync(join(dir, "doc-b.md"), makeDoc("Doc B"));

    await reindex([dir], dbPath, false);

    const db = new KnowledgeDB(dbPath);
    try {
      expect(db.getDocument("doc-a")).toBeTruthy();
      expect(db.getDocument("doc-b")).toBeTruthy();
      // Embedding rows should be present even though the accumulator was skipped.
      const chunkCount = (db.db
        .prepare("SELECT COUNT(*) as n FROM chunks")
        .get() as { n: number }).n;
      expect(chunkCount).toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
    }
    // generateIndexes was correctly skipped under the false path.
    expect(mockGenerateIndexes).not.toHaveBeenCalled();
  });

  // ---- GH-1203: cross-doc chunk buffering + EMBED_BATCH_SIZE ----
  //
  // The reindex loop now buffers chunks across documents and flushes via
  // `embedChunks(buffer)` at EMBED_BATCH_SIZE. These scenarios assert the
  // pipeline-invocation cardinality drop from O(chunks) to ceil(chunks/batch).

  it("scenario 31: pipeline invoked ceil(N_chunks/EMBED_BATCH_SIZE) times for many short docs", async () => {
    // 50 short docs, each producing exactly 1 chunk = 50 total chunks.
    // With EMBED_BATCH_SIZE=4 (default), expect ceil(50/4) = 13 flushes.
    delete process.env.EMBED_BATCH_SIZE;
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(dir, `doc-${i}.md`), makeDoc(`Doc ${i}`));
    }

    await reindex([dir], dbPath);

    // 50 distinct documents observed (titles unique).
    expect(countEmbedChunkDocs()).toBe(50);
    // Exactly ceil(50/4) = 13 pipeline invocations (vs 50 in the legacy path).
    expect(mockedEmbedChunks).toHaveBeenCalledTimes(13);
  });

  it("scenario 32: EMBED_BATCH_SIZE env override changes flush cardinality", async () => {
    process.env.EMBED_BATCH_SIZE = "5";
    try {
      for (let i = 0; i < 17; i++) {
        writeFileSync(join(dir, `doc-${i}.md`), makeDoc(`Doc ${i}`));
      }

      await reindex([dir], dbPath);

      // ceil(17 / 5) = 4 flushes.
      expect(mockedEmbedChunks).toHaveBeenCalledTimes(4);
    } finally {
      delete process.env.EMBED_BATCH_SIZE;
    }
  });

  it("scenario 33: EMBED_BATCH_SIZE invalid value falls back to default 4", async () => {
    process.env.EMBED_BATCH_SIZE = "not-a-number";
    try {
      for (let i = 0; i < 50; i++) {
        writeFileSync(join(dir, `doc-${i}.md`), makeDoc(`Doc ${i}`));
      }

      await reindex([dir], dbPath);

      // ceil(50/4) = 13 — same as default behavior.
      expect(mockedEmbedChunks).toHaveBeenCalledTimes(13);
    } finally {
      delete process.env.EMBED_BATCH_SIZE;
    }
  });

  it("scenario 34: buffer flushes partial batch on final iteration (no chunks dropped)", async () => {
    // 3 docs * 1 chunk each = 3 chunks; with default batch=16, all 3 flush
    // in a single tail-end flush at end-of-loop.
    delete process.env.EMBED_BATCH_SIZE;
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(dir, `doc-${i}.md`), makeDoc(`Doc ${i}`));
    }

    await reindex([dir], dbPath);

    expect(mockedEmbedChunks).toHaveBeenCalledTimes(1);
    // All 3 docs' chunks made it to the DB.
    const db = new KnowledgeDB(dbPath);
    try {
      const row = db.db
        .prepare("SELECT COUNT(*) as n FROM chunks")
        .get() as { n: number };
      expect(row.n).toBe(3);
    } finally {
      db.close();
    }
  });

  it("scenario 35: contextual retrieval prefix is part of embedText buffered (cache fast-path preserved)", async () => {
    process.env.RALPH_CONTEXTUAL_RETRIEVAL = "1";
    mockLlmAvailable.mockResolvedValue(true);
    mockLlmContextualize.mockResolvedValue("CTX-PREFIX");

    writeFileSync(join(dir, "doc-a.md"), makeDoc("Doc A"));

    await reindex([dir], dbPath);

    // embedChunks was invoked with the contextualize prefix prepended.
    const allTexts = mockedEmbedChunks.mock.calls.flatMap(c => c[0] as string[]);
    const matchingTexts = allTexts.filter(t => t.startsWith("CTX-PREFIX\n"));
    expect(matchingTexts.length).toBeGreaterThan(0);
  });
});
