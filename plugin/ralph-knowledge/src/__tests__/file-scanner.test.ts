import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findMarkdownFiles } from "../file-scanner.js";
import { loadIgnoreForRoot } from "../ignore.js";

describe("findMarkdownFiles with IgnoreMatcher", () => {
  it("excludes files matched by a .ralphignore entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-ignore-"));
    writeFileSync(join(dir, "a.md"), "# A");
    writeFileSync(join(dir, "b.md"), "# B");
    writeFileSync(join(dir, "c.md"), "# C");
    writeFileSync(join(dir, ".ralphignore"), "b.md\n");

    const matcher = loadIgnoreForRoot(dir);
    const files = findMarkdownFiles(dir, matcher);
    expect(files).toHaveLength(2);
    expect(files.some(f => f.endsWith("a.md"))).toBe(true);
    expect(files.some(f => f.endsWith("c.md"))).toBe(true);
    expect(files.some(f => f.endsWith("b.md"))).toBe(false);
  });

  it("skips a whole subdirectory covered by subdir/** pattern", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-ignore-"));
    writeFileSync(join(dir, "keep.md"), "# keep");
    mkdirSync(join(dir, "subdir"));
    writeFileSync(join(dir, "subdir", "skip.md"), "# skip");
    writeFileSync(join(dir, "subdir", "also-skip.md"), "# skip2");
    writeFileSync(join(dir, ".ralphignore"), "subdir/**\n");

    const matcher = loadIgnoreForRoot(dir);
    const files = findMarkdownFiles(dir, matcher);
    expect(files).toHaveLength(1);
    expect(files[0].endsWith("keep.md")).toBe(true);
  });

  it("honors caller-supplied global patterns via loadIgnoreForRoot", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-ignore-"));
    writeFileSync(join(dir, "readme.md"), "# r");
    mkdirSync(join(dir, "drafts"));
    writeFileSync(join(dir, "drafts", "wip.md"), "# wip");

    const matcher = loadIgnoreForRoot(dir, ["drafts/**"]);
    const files = findMarkdownFiles(dir, matcher);
    expect(files).toHaveLength(1);
    expect(files[0].endsWith("readme.md")).toBe(true);
  });

  it("preserves back-compat when called without a matcher", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-ignore-"));
    writeFileSync(join(dir, "a.md"), "# A");
    writeFileSync(join(dir, "b.md"), "# B");
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "c.md"), "# C");

    const files = findMarkdownFiles(dir);
    expect(files).toHaveLength(3);
    expect(files.every(f => f.endsWith(".md"))).toBe(true);
  });

  it("still skips dot- and underscore-prefixed directories even without a matcher", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-ignore-"));
    writeFileSync(join(dir, "top.md"), "# top");
    mkdirSync(join(dir, ".hidden"));
    writeFileSync(join(dir, ".hidden", "hidden.md"), "# h");
    mkdirSync(join(dir, "_private"));
    writeFileSync(join(dir, "_private", "private.md"), "# p");

    const files = findMarkdownFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0].endsWith("top.md")).toBe(true);
  });

  it("applies default ignore globals (node_modules/, dist/) via loadIgnoreForRoot", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-ignore-"));
    writeFileSync(join(dir, "root.md"), "# root");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "pkg.md"), "# pkg");
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "out.md"), "# out");

    const matcher = loadIgnoreForRoot(dir);
    const files = findMarkdownFiles(dir, matcher);
    expect(files).toHaveLength(1);
    expect(files[0].endsWith("root.md")).toBe(true);
  });
});
