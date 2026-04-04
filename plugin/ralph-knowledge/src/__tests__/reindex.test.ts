import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, unlinkSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { findMarkdownFiles } from "../file-scanner.js";

vi.mock("../embedder.js", () => ({
  embed: vi.fn(async () => new Float32Array(384)),
  prepareTextForEmbedding: vi.fn((title: string, tags: string[], content: string) => {
    const tagLine = tags.length > 0 ? tags.join(", ") : "";
    const parts = [title, tagLine, content].filter(p => p.length > 0);
    return parts.join("\n").slice(0, 500);
  }),
}));

import { embed } from "../embedder.js";
import { reindex } from "../reindex.js";
import { KnowledgeDB } from "../db.js";

const mockedEmbed = vi.mocked(embed);

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
    expect(db1.getMeta("schema_version")).toBe("2");
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
    expect(db3.getMeta("schema_version")).toBe("2");
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
});
