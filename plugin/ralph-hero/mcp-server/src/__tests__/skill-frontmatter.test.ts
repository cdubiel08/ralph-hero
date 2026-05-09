import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// Note: we deliberately avoid full YAML parsing. Several real skill SKILL.md
// files contain frontmatter values that are valid Claude Code frontmatter but
// not valid strict YAML (e.g., `argument-hint: [optional-issue-number] [--plan-doc path]`
// — a bare `[...]` is read as a flow sequence and chokes a strict parser).
// We only need a few top-level scalar fields, so we extract them with a
// line-based scan that handles `key: value` and `key:` (block scalar) forms.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Walk up from src/__tests__/ to plugin/ralph-hero/
const PLUGIN_ROOT = join(__dirname, "..", "..", "..");

const SKILLS = [
  "ralph-impl",
  "ralph-plan",
  "ralph-research",
  "ralph-pr",
  "ralph-merge",
] as const;

const AGENTS = [
  "impl-agent",
  "plan-agent",
  "research-agent",
  "pr-agent",
  "merge-agent",
] as const;

// Minimum GitHub MCP tool floor — every autonomous agent under test must keep these.
// Per-agent extras (list_sub_issues, create_comment, etc.) are intentionally NOT
// asserted to avoid drift; this guards the floor only.
const REQUIRED_AGENT_TOOLS = [
  "mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue",
  "mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue",
];

function readFrontmatterBlock(absPath: string): string {
  const raw = readFileSync(absPath, "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error(`No YAML frontmatter found in ${absPath}`);
  }
  return match[1];
}

/**
 * Extract a top-level scalar field value from a frontmatter block. Returns
 * `undefined` if the key is absent. For `key:` lines with no inline value
 * (block scalar, list, or nested map) returns the literal string `"<block>"`
 * to indicate "present but not a scalar" — callers that only check presence
 * (`tools` may be a comma string or YAML list) can distinguish from missing.
 *
 * Handles single/double-quoted scalars by stripping the wrapping quotes.
 * Only inspects top-level keys (no leading whitespace).
 */
function getTopLevelField(block: string, key: string): string | undefined {
  const lines = block.split("\n");
  const re = new RegExp(`^${key}:(?:[ \\t]+(.*))?$`);
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    const val = m[1];
    if (val == null || val.trim() === "") return "<block>";
    let v = val.trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    return v;
  }
  return undefined;
}

/**
 * Extract a `tools:` field as either an inline comma-separated string OR a
 * block YAML list (`- item`). Returns the normalized list of tool names, or
 * `undefined` if the key is missing entirely.
 */
function getToolsList(block: string): string[] | undefined {
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inline = line.match(/^tools:[ \t]+(.*)$/);
    if (inline) {
      return inline[1]
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }
    if (/^tools:[ \t]*$/.test(line)) {
      // Block list form: collect subsequent `- name` lines.
      const out: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const item = lines[j].match(/^[ \t]+-[ \t]+(.*)$/);
        if (item) {
          out.push(item[1].trim());
          continue;
        }
        // Stop at next top-level key or blank line.
        if (/^\S/.test(lines[j]) || lines[j].trim() === "") break;
      }
      return out;
    }
  }
  return undefined;
}

describe.each(SKILLS)("skill frontmatter: %s", (skillName) => {
  const skillPath = join(PLUGIN_ROOT, "skills", skillName, "SKILL.md");
  const block = readFrontmatterBlock(skillPath);

  it(`${skillName}: has non-empty description`, () => {
    const v = getTopLevelField(block, "description");
    expect(
      typeof v === "string" && v !== "<block>" && v.length > 0,
      `${skillName} SKILL.md is missing 'description' (got: ${JSON.stringify(v)})`,
    ).toBe(true);
  });

  it(`${skillName}: has model`, () => {
    const v = getTopLevelField(block, "model");
    expect(
      typeof v === "string" && v !== "<block>" && v.length > 0,
      `${skillName} SKILL.md is missing 'model' (got: ${JSON.stringify(v)})`,
    ).toBe(true);
  });
});

describe.each(AGENTS)("agent frontmatter: %s", (agentName) => {
  const agentPath = join(PLUGIN_ROOT, "agents", `${agentName}.md`);
  const block = readFrontmatterBlock(agentPath);

  it(`${agentName}: name matches file basename`, () => {
    const v = getTopLevelField(block, "name");
    expect(
      v,
      `${agentName} agent file should have name === "${agentName}" (got: ${JSON.stringify(v)})`,
    ).toBe(agentName);
  });

  it(`${agentName}: has non-empty description`, () => {
    const v = getTopLevelField(block, "description");
    expect(
      typeof v === "string" && v !== "<block>" && v.length > 0,
      `${agentName} agent is missing 'description' (got: ${JSON.stringify(v)})`,
    ).toBe(true);
  });

  it(`${agentName}: has model`, () => {
    const v = getTopLevelField(block, "model");
    expect(
      typeof v === "string" && v !== "<block>" && v.length > 0,
      `${agentName} agent is missing 'model' (got: ${JSON.stringify(v)})`,
    ).toBe(true);
  });

  it(`${agentName}: has tools defined (string or list)`, () => {
    const tools = getToolsList(block);
    expect(
      Array.isArray(tools) && tools.length > 0,
      `${agentName} agent is missing 'tools' allowlist (got: ${JSON.stringify(tools)})`,
    ).toBe(true);
  });

  it(`${agentName}: tools allowlist contains the required GitHub MCP floor`, () => {
    const tools = getToolsList(block) ?? [];
    for (const required of REQUIRED_AGENT_TOOLS) {
      expect(
        tools.includes(required),
        `${agentName} agent 'tools' is missing required entry "${required}". Current tools: ${JSON.stringify(tools)}`,
      ).toBe(true);
    }
  });
});
