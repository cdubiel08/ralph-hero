import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { loadConfig, expandHome, resolveConfigPath } from "../config.js";

describe("expandHome", () => {
  it("returns input unchanged when it does not start with ~", () => {
    expect(expandHome("/absolute/path")).toBe("/absolute/path");
    expect(expandHome("relative/path")).toBe("relative/path");
    expect(expandHome("")).toBe("");
  });

  it("expands a lone ~", () => {
    expect(expandHome("~")).toBe(homedir());
  });

  it("expands ~/ prefix to homedir/rest", () => {
    expect(expandHome("~/thoughts")).toBe(join(homedir(), "thoughts"));
    expect(expandHome("~/foo/bar")).toBe(join(homedir(), "foo/bar"));
  });
});

describe("loadConfig", () => {
  let originalEnv: string | undefined;
  let tmpDir: string;

  beforeEach(() => {
    originalEnv = process.env.RALPH_KNOWLEDGE_CONFIG;
    tmpDir = mkdtempSync(join(tmpdir(), "ralph-config-"));
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.RALPH_KNOWLEDGE_CONFIG;
    } else {
      process.env.RALPH_KNOWLEDGE_CONFIG = originalEnv;
    }
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns {} when the config file is missing", () => {
    // Point env var at a nonexistent path so we don't read the real ~/.ralph file.
    process.env.RALPH_KNOWLEDGE_CONFIG = join(tmpDir, "nope.json");
    expect(loadConfig()).toEqual({});
  });

  it("returns {} and warns on malformed JSON", () => {
    const configPath = join(tmpDir, "broken.json");
    writeFileSync(configPath, "{ not: valid json");
    process.env.RALPH_KNOWLEDGE_CONFIG = configPath;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = loadConfig();
    expect(result).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain("Malformed JSON");
    warn.mockRestore();
  });

  it("returns {} and warns when top-level is not an object", () => {
    const configPath = join(tmpDir, "array.json");
    writeFileSync(configPath, JSON.stringify(["not", "an", "object"]));
    process.env.RALPH_KNOWLEDGE_CONFIG = configPath;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadConfig()).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("expands ~ prefixes in roots[] to absolute paths", () => {
    const configPath = join(tmpDir, "tilde.json");
    writeFileSync(
      configPath,
      JSON.stringify({ roots: ["~/thoughts", "/absolute/dir"] }),
    );
    process.env.RALPH_KNOWLEDGE_CONFIG = configPath;
    const cfg = loadConfig();
    expect(cfg.roots).toEqual([
      join(homedir(), "thoughts"),
      "/absolute/dir",
    ]);
  });

  it("expands ~ in dbPath", () => {
    const configPath = join(tmpDir, "db.json");
    writeFileSync(
      configPath,
      JSON.stringify({ dbPath: "~/.ralph-hero/knowledge.db" }),
    );
    process.env.RALPH_KNOWLEDGE_CONFIG = configPath;
    const cfg = loadConfig();
    expect(cfg.dbPath).toBe(join(homedir(), ".ralph-hero/knowledge.db"));
  });

  it("loads ignorePatterns as provided (no expansion)", () => {
    const configPath = join(tmpDir, "ignore.json");
    writeFileSync(
      configPath,
      JSON.stringify({ ignorePatterns: ["**/drafts/**", "*.bak"] }),
    );
    process.env.RALPH_KNOWLEDGE_CONFIG = configPath;
    const cfg = loadConfig();
    expect(cfg.ignorePatterns).toEqual(["**/drafts/**", "*.bak"]);
  });

  it("honors RALPH_KNOWLEDGE_CONFIG env var override", () => {
    const configPath = join(tmpDir, "override.json");
    writeFileSync(
      configPath,
      JSON.stringify({ roots: ["/x"], ignorePatterns: ["y/**"], dbPath: "/z.db" }),
    );
    process.env.RALPH_KNOWLEDGE_CONFIG = configPath;
    const cfg = loadConfig();
    expect(cfg).toEqual({
      roots: ["/x"],
      ignorePatterns: ["y/**"],
      dbPath: "/z.db",
    });
  });

  it("drops non-string roots and ignorePatterns entries", () => {
    const configPath = join(tmpDir, "mixed.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        roots: ["/a", 42, null, "/b"],
        ignorePatterns: ["good", 7, "more"],
      }),
    );
    process.env.RALPH_KNOWLEDGE_CONFIG = configPath;
    const cfg = loadConfig();
    expect(cfg.roots).toEqual(["/a", "/b"]);
    expect(cfg.ignorePatterns).toEqual(["good", "more"]);
  });
});

describe("resolveConfigPath", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.RALPH_KNOWLEDGE_CONFIG;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.RALPH_KNOWLEDGE_CONFIG;
    } else {
      process.env.RALPH_KNOWLEDGE_CONFIG = originalEnv;
    }
  });

  it("defaults to ~/.ralph/knowledge.config.json when env var is unset", () => {
    delete process.env.RALPH_KNOWLEDGE_CONFIG;
    expect(resolveConfigPath()).toBe(
      join(homedir(), ".ralph", "knowledge.config.json"),
    );
  });

  it("expands ~ prefix in RALPH_KNOWLEDGE_CONFIG", () => {
    process.env.RALPH_KNOWLEDGE_CONFIG = "~/custom/knowledge.json";
    expect(resolveConfigPath()).toBe(
      join(homedir(), "custom/knowledge.json"),
    );
  });

  it("uses RALPH_KNOWLEDGE_CONFIG absolute path verbatim", () => {
    process.env.RALPH_KNOWLEDGE_CONFIG = "/etc/ralph/knowledge.json";
    expect(resolveConfigPath()).toBe("/etc/ralph/knowledge.json");
  });
});
