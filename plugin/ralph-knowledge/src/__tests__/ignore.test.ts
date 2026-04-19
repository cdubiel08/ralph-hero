import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadIgnoreForRoot, DEFAULT_IGNORE_PATTERNS } from "../ignore.js";

describe("loadIgnoreForRoot", () => {
  it("applies default globals when no .ralphignore and no caller globals are provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-ignore-"));
    const matcher = loadIgnoreForRoot(dir);
    expect(matcher.isIgnored("node_modules/foo.js")).toBe(true);
    expect(matcher.isIgnored(".claude/settings.json")).toBe(true);
    expect(matcher.isIgnored("dist/index.js")).toBe(true);
    expect(matcher.isIgnored("debug.log")).toBe(true);
    expect(matcher.isIgnored("thoughts/research/doc.md")).toBe(false);
  });

  it("honors glob pattern **/node_modules/** against nested paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-ignore-"));
    writeFileSync(join(dir, ".ralphignore"), "**/node_modules/**\n");
    const matcher = loadIgnoreForRoot(dir);
    expect(matcher.isIgnored("foo/node_modules/bar.js")).toBe(true);
  });

  it("honors negation that overrides an earlier *.md pattern", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-ignore-"));
    writeFileSync(join(dir, ".ralphignore"), "*.md\n!keep-me.md\n");
    const matcher = loadIgnoreForRoot(dir);
    expect(matcher.isIgnored("foo.md")).toBe(true);
    expect(matcher.isIgnored("keep-me.md")).toBe(false);
  });

  it("treats directory-only patterns as directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-ignore-"));
    writeFileSync(join(dir, ".ralphignore"), "dist/\n");
    const matcher = loadIgnoreForRoot(dir);
    // `dist/file.js` matches the directory pattern
    expect(matcher.isIgnored("dist/file.js")).toBe(true);
    // A file literally named `dist` should NOT be matched by the directory-only pattern
    expect(matcher.isIgnored("dist")).toBe(false);
  });

  it("honors caller-provided globals when .ralphignore is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-ignore-"));
    const matcher = loadIgnoreForRoot(dir, ["custom/**"]);
    expect(matcher.isIgnored("custom/inside.md")).toBe(true);
    expect(matcher.isIgnored("other/inside.md")).toBe(false);
  });

  it("does not throw when the .ralphignore file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-ignore-"));
    expect(() => loadIgnoreForRoot(dir)).not.toThrow();
    const matcher = loadIgnoreForRoot(dir);
    // Baseline defaults still apply
    expect(matcher.isIgnored("node_modules/x.js")).toBe(true);
  });

  it("combines default globals, caller globals, and .ralphignore file together", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-ignore-"));
    writeFileSync(join(dir, ".ralphignore"), "local/**\n");
    const matcher = loadIgnoreForRoot(dir, ["global/**"]);
    // From defaults
    expect(matcher.isIgnored("node_modules/y.js")).toBe(true);
    // From caller globals
    expect(matcher.isIgnored("global/a.md")).toBe(true);
    // From per-root file
    expect(matcher.isIgnored("local/b.md")).toBe(true);
    // Unmatched
    expect(matcher.isIgnored("thoughts/keep.md")).toBe(false);
  });

  it("returns false for empty or root-level relative paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-ignore-"));
    const matcher = loadIgnoreForRoot(dir);
    expect(matcher.isIgnored("")).toBe(false);
    expect(matcher.isIgnored("/")).toBe(false);
  });

  it("exports the documented default patterns", () => {
    expect(DEFAULT_IGNORE_PATTERNS).toContain(".claude/");
    expect(DEFAULT_IGNORE_PATTERNS).toContain("node_modules/");
    expect(DEFAULT_IGNORE_PATTERNS).toContain("dist/");
    expect(DEFAULT_IGNORE_PATTERNS).toContain(".git/");
    expect(DEFAULT_IGNORE_PATTERNS).toContain("*.log");
  });
});
