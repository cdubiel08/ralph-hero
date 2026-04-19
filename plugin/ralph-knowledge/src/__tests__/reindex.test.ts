import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, unlinkSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { findMarkdownFiles } from "../file-scanner.js";
import { FtsSearch } from "../search.js";
import { VectorSearch } from "../vector-search.js";

// Mock embedder so we don't load the real transformer model during tests.
// embedDocument returns one DocumentChunk per call with a constant 384-dim
// embedding; this matches the new chunk-aware reindex flow.
vi.mock("../embedder.js", async () => {
  // Import the real chunker so the mock chunks content the same way as prod.
  const { chunkText } = await import("../chunker.js");
  return {
    embed: vi.fn(async () => new Float32Array(384)),
    embedDocument: vi.fn(async (_title: string, _tags: string[], content: string) => {
      const chunks = content.length === 0
        ? [{ index: 0, content: "", charStart: 0, charEnd: 0 }]
        : chunkText(content);
      return chunks.map(c => ({
        index: c.index,
        content: c.content,
        charStart: c.charStart,
        charEnd: c.charEnd,
        embedding: new Float32Array(384),
      }));
    }),
    prepareTextForEmbedding: vi.fn((title: string, tags: string[], content: string) => {
      const tagLine = tags.length > 0 ? tags.join(", ") : "";
      const parts = [title, tagLine, content].filter(p => p.length > 0);
      return parts.join("\n");
    }),
  };
});

import { embedDocument } from "../embedder.js";
import { reindex } from "../reindex.js";
import { KnowledgeDB } from "../db.js";

const mockedEmbed = vi.mocked(embedDocument);

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

  beforeEach(() => {
    mockedEmbed.mockClear();
    dir = mkdtempSync(join(tmpdir(), "knowledge-reindex-"));
    dbPath = join(dir, "test.db");
  });

  it("scenario 1: unchanged files are skipped on second run", async () => {
    writeFileSync(join(dir, "doc-a.md"), makeDoc("Doc A"));
    writeFileSync(join(dir, "doc-b.md"), makeDoc("Doc B"));

    await reindex([dir], dbPath);
    expect(mockedEmbed).toHaveBeenCalledTimes(2);

    mockedEmbed.mockClear();
    await reindex([dir], dbPath);
    expect(mockedEmbed).toHaveBeenCalledTimes(0);
  });

  it("scenario 2: modified file is re-embedded", async () => {
    const filePath = join(dir, "doc-a.md");
    writeFileSync(filePath, makeDoc("Doc A"));
    writeFileSync(join(dir, "doc-b.md"), makeDoc("Doc B"));

    await reindex([dir], dbPath);
    expect(mockedEmbed).toHaveBeenCalledTimes(2);

    mockedEmbed.mockClear();

    // Update file content and bump mtime by 2 seconds into the future
    writeFileSync(filePath, makeDoc("Doc A Updated"));
    const futureTime = Date.now() / 1000 + 2;
    utimesSync(filePath, futureTime, futureTime);

    await reindex([dir], dbPath);
    expect(mockedEmbed).toHaveBeenCalledTimes(1);
  });

  it("scenario 3: new file is embedded on second run", async () => {
    writeFileSync(join(dir, "doc-a.md"), makeDoc("Doc A"));

    await reindex([dir], dbPath);
    expect(mockedEmbed).toHaveBeenCalledTimes(1);

    mockedEmbed.mockClear();

    // Add a new file
    writeFileSync(join(dir, "doc-new.md"), makeDoc("Doc New"));

    await reindex([dir], dbPath);
    // Only the new file should be embedded
    expect(mockedEmbed).toHaveBeenCalledTimes(1);
  });

  it("scenario 4: deleted file is removed from DB and sync", async () => {
    const filePath = join(dir, "doc-a.md");
    writeFileSync(filePath, makeDoc("Doc A"));
    writeFileSync(join(dir, "doc-b.md"), makeDoc("Doc B"));

    await reindex([dir], dbPath);
    expect(mockedEmbed).toHaveBeenCalledTimes(2);

    // Verify doc-a exists
    const db1 = new KnowledgeDB(dbPath);
    expect(db1.getDocument("doc-a")).toBeTruthy();
    expect(db1.getAllSyncPaths()).toHaveLength(2);
    db1.close();

    mockedEmbed.mockClear();

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
    expect(mockedEmbed).toHaveBeenCalledTimes(0);
  });

  it("scenario 5: forced rebuild after clearAll re-embeds all files", async () => {
    writeFileSync(join(dir, "doc-a.md"), makeDoc("Doc A"));
    writeFileSync(join(dir, "doc-b.md"), makeDoc("Doc B"));

    await reindex([dir], dbPath);
    expect(mockedEmbed).toHaveBeenCalledTimes(2);

    mockedEmbed.mockClear();

    // Simulate forced rebuild: clear the database, then reindex
    const db = new KnowledgeDB(dbPath);
    db.clearAll();
    db.close();

    await reindex([dir], dbPath);
    // All files should be re-embedded since sync table was cleared
    expect(mockedEmbed).toHaveBeenCalledTimes(2);
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
    expect(mockedEmbed).toHaveBeenCalledTimes(2);

    // Verify schema version is set
    const db1 = new KnowledgeDB(dbPath);
    expect(db1.getMeta("schema_version")).toBe("3");
    db1.close();

    mockedEmbed.mockClear();

    // Normal second run — files unchanged, schema version matches
    await reindex([dir], dbPath);
    expect(mockedEmbed).toHaveBeenCalledTimes(0);

    mockedEmbed.mockClear();

    // Simulate schema version change by setting it to an old value
    const db2 = new KnowledgeDB(dbPath);
    db2.setMeta("schema_version", "1");
    db2.close();

    // Reindex should clear sync and re-embed everything
    await reindex([dir], dbPath);
    expect(mockedEmbed).toHaveBeenCalledTimes(2);

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

    // Modify doc-a with new content
    const filePath = join(dir, "doc-a.md");
    writeFileSync(filePath, makeDoc("Alpha Gamma Document"));
    const futureTime = Date.now() / 1000 + 2;
    utimesSync(filePath, futureTime, futureTime);

    await reindex([dir], dbPath);

    // Only doc-a should have been re-embedded
    expect(mockedEmbed).toHaveBeenCalledTimes(1);

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

    // Simulate schema version change
    const db2 = new KnowledgeDB(dbPath);
    db2.setMeta("schema_version", "1");
    db2.close();

    // Reindex — should trigger full re-embed AND full FTS rebuild
    await reindex([dir], dbPath);
    expect(mockedEmbed).toHaveBeenCalledTimes(2);

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
});
