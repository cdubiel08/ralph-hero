import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, unlinkSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { findMarkdownFiles } from "../file-scanner.js";

vi.mock("../embedder.js", () => ({
  embed: vi.fn(async () => new Float32Array(384)),
  prepareTextForEmbedding: vi.fn((title: string, content: string) => `${title}\n${content}`.slice(0, 500)),
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
});
