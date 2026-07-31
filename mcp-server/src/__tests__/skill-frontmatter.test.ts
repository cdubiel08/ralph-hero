import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ralph v2 surface contract (GH-1662): every skill has a description + model;
// every agent has name/description/model and a hard `tools:` allowlist.
// v2 skills consume the board CLI via Bash — no MCP tool grants exist, so the
// old GitHub-MCP-floor assertion is gone with the surface it guarded.
//
// We deliberately avoid strict YAML parsing (Claude Code frontmatter permits
// values a strict parser chokes on); a line-based scan covers what we assert.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = join(__dirname, "..", "..", "..", "ralph");

const SKILLS = ["work", "board"] as const;

function frontmatter(absPath: string): string {
  const raw = readFileSync(absPath, "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`No YAML frontmatter found in ${absPath}`);
  return match[1];
}

function scalar(block: string, key: string): string | undefined {
  for (const line of block.split("\n")) {
    const m = line.match(new RegExp(`^${key}:[ \\t]+(.*)$`));
    if (m) return m[1].trim();
    if (new RegExp(`^${key}:[ \\t]*$`).test(line)) return "<block>";
  }
  return undefined;
}

function listItems(block: string, key: string): string[] {
  const lines = block.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${key}:[ \\t]*$`).test(l));
  if (start === -1) return [];
  const items: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^ {2}- (.+)$/);
    if (!m) break;
    items.push(m[1].trim());
  }
  return items;
}

describe.each(SKILLS)("skill %s frontmatter", (skill) => {
  const block = frontmatter(join(PLUGIN_ROOT, "skills", skill, "SKILL.md"));

  it("has a non-empty description", () => {
    const d = scalar(block, "description");
    expect(d, `${skill} missing description`).toBeTruthy();
    expect(d!.length).toBeGreaterThan(40);
  });

  it("pins a model", () => {
    expect(scalar(block, "model"), `${skill} missing model`).toBeTruthy();
  });

  it("grants no MCP tools — v2 skills reach the board via the CLI", () => {
    const tools = listItems(block, "allowed-tools");
    expect(tools.filter((t) => t.startsWith("mcp__"))).toEqual([]);
  });
});

describe("agents", () => {
  const agentFiles = readdirSync(join(PLUGIN_ROOT, "agents")).filter((f) => f.endsWith(".md"));

  it("the v2 agent surface is exactly the investigator", () => {
    expect(agentFiles.sort()).toEqual(["investigator.md"]);
  });

  describe.each(agentFiles)("agent %s", (file) => {
    const block = frontmatter(join(PLUGIN_ROOT, "agents", file));

    it("has name, description, and model", () => {
      expect(scalar(block, "name")).toBeTruthy();
      expect(scalar(block, "description")).toBeTruthy();
      expect(scalar(block, "model")).toBeTruthy();
    });

    it("has a hard tools allowlist that stays read-only (no Write/Edit)", () => {
      const tools = listItems(block, "tools");
      expect(tools.length).toBeGreaterThan(0);
      expect(tools).not.toContain("Write");
      expect(tools).not.toContain("Edit");
    });
  });
});
