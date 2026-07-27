import { describe, it, expect } from "vitest";
import { join } from "path";
import { fileURLToPath } from "url";
import {
  loadModelTierConfig,
  validateModelTierConfig,
  resolveTier,
  DEFAULT_MODEL_TIERS,
  ModelTierConfigSchema,
  type ModelTierConfig,
} from "../lib/model-tier-registry.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const fixtures = join(__dirname, "fixtures");

// Repo-root `.ralph-models.yml` — three levels up from mcp-server/src/__tests__.
const REPO_ROOT_CONFIG = join(__dirname, "../../../.ralph-models.yml");

// ---------------------------------------------------------------------------
// Schema acceptance / rejection
// ---------------------------------------------------------------------------

describe("ModelTierConfigSchema", () => {
  it("accepts a well-formed config", () => {
    const parsed = validateModelTierConfig({
      version: 1,
      defaultHarness: "claude-code",
      harnesses: {
        "claude-code": {
          cheap: { skill: "haiku", agent: "haiku" },
          standard: { skill: "sonnet", agent: "sonnet" },
          capable: { skill: "best", agent: "opus" },
          frontier: { skill: "fable", agent: "fable" },
        },
      },
      sites: [{ path: "ralph/skills/research/SKILL.md", kind: "skill", tier: "standard" }],
    });
    expect(parsed.defaultHarness).toBe("claude-code");
    expect(parsed.hardPins).toEqual([]);
  });

  it("rejects a bad tier name on a site", () => {
    const result = ModelTierConfigSchema.safeParse({
      version: 1,
      defaultHarness: "claude-code",
      harnesses: {
        "claude-code": {
          cheap: { skill: "haiku", agent: "haiku" },
          standard: { skill: "sonnet", agent: "sonnet" },
          capable: { skill: "best", agent: "opus" },
          frontier: { skill: "fable", agent: "fable" },
        },
      },
      sites: [{ path: "x.md", kind: "skill", tier: "ultra" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a harness tier table missing a required tier (missing surface)", () => {
    const result = ModelTierConfigSchema.safeParse({
      version: 1,
      defaultHarness: "claude-code",
      harnesses: {
        "claude-code": {
          cheap: { skill: "haiku", agent: "haiku" },
          standard: { skill: "sonnet", agent: "sonnet" },
          capable: { skill: "best", agent: "opus" },
          // frontier omitted
        },
      },
      sites: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects `best` as an agent-surface value (GH-1487 failure class)", () => {
    const result = ModelTierConfigSchema.safeParse({
      version: 1,
      defaultHarness: "claude-code",
      harnesses: {
        "claude-code": {
          cheap: { skill: "haiku", agent: "haiku" },
          standard: { skill: "sonnet", agent: "sonnet" },
          capable: { skill: "best", agent: "best" },
          frontier: { skill: "fable", agent: "fable" },
        },
      },
      sites: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects defaultHarness not present in harnesses", () => {
    const result = ModelTierConfigSchema.safeParse({
      version: 1,
      defaultHarness: "nonexistent",
      harnesses: {
        "claude-code": {
          cheap: { skill: "haiku", agent: "haiku" },
          standard: { skill: "sonnet", agent: "sonnet" },
          capable: { skill: "best", agent: "opus" },
          frontier: { skill: "fable", agent: "fable" },
        },
      },
      sites: [],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadModelTierConfig
// ---------------------------------------------------------------------------

describe("loadModelTierConfig", () => {
  it("returns loaded status for a valid fixture", async () => {
    const result = await loadModelTierConfig(join(fixtures, "model-tiers-valid.yml"));
    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") throw new Error("expected loaded");
    expect(result.config.defaultHarness).toBe("claude-code");
    expect(result.config.sites).toHaveLength(1);
    expect(result.config.hardPins).toHaveLength(1);
  });

  it("returns missing status (built-in default) for a non-existent file", async () => {
    const result = await loadModelTierConfig(join(fixtures, "does-not-exist.yml"));
    expect(result.status).toBe("missing");
    if (result.status !== "missing") throw new Error("expected missing");
    expect(result.config).toEqual(DEFAULT_MODEL_TIERS);
  });

  it("returns error for invalid YAML", async () => {
    const result = await loadModelTierConfig(join(fixtures, "model-tiers-invalid-yaml.yml"));
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");
    expect(result.errors[0].phase).toBe("yaml_parse");
  });

  it("returns error for invalid schema (missing tier)", async () => {
    const result = await loadModelTierConfig(join(fixtures, "model-tiers-invalid-schema.yml"));
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");
    expect(result.errors.some((e) => e.phase === "schema_validation")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveTier
// ---------------------------------------------------------------------------

describe("resolveTier", () => {
  const config: ModelTierConfig = DEFAULT_MODEL_TIERS;

  it("resolves every tier x surface combination for the default harness", () => {
    expect(resolveTier(config, "cheap", "claude-code", "skill")).toBe("haiku");
    expect(resolveTier(config, "cheap", "claude-code", "agent")).toBe("haiku");
    expect(resolveTier(config, "standard", "claude-code", "skill")).toBe("sonnet");
    expect(resolveTier(config, "standard", "claude-code", "agent")).toBe("sonnet");
    expect(resolveTier(config, "capable", "claude-code", "skill")).toBe("best");
    expect(resolveTier(config, "capable", "claude-code", "agent")).toBe("opus");
    expect(resolveTier(config, "frontier", "claude-code", "skill")).toBe("fable");
    expect(resolveTier(config, "frontier", "claude-code", "agent")).toBe("fable");
  });

  it("throws UnknownHarnessError on an unknown harness", () => {
    expect(() => resolveTier(config, "standard", "nonexistent-harness", "skill")).toThrow(
      /Unknown harness/,
    );
  });
});

// ---------------------------------------------------------------------------
// AC-2 regression: the shipped repo-root .ralph-models.yml's claude-code
// mapping reproduces today's exact pin inventory, byte-for-byte.
// ---------------------------------------------------------------------------

describe("AC-2 regression — repo-root .ralph-models.yml reproduces current pins", () => {
  it("loads successfully from the real repo root", async () => {
    const result = await loadModelTierConfig(REPO_ROOT_CONFIG);
    expect(result.status).toBe("loaded");
  });

  it("resolves the exact literal inventory verified in the current tree", async () => {
    const result = await loadModelTierConfig(REPO_ROOT_CONFIG);
    if (result.status !== "loaded") throw new Error("expected loaded");
    const { config } = result;
    const harness = config.defaultHarness;

    // Skill-frontmatter surface.
    expect(resolveTier(config, "cheap", harness, "skill")).toBe("haiku");
    expect(resolveTier(config, "standard", harness, "skill")).toBe("sonnet");
    expect(resolveTier(config, "capable", harness, "skill")).toBe("best");
    expect(resolveTier(config, "frontier", harness, "skill")).toBe("fable");

    // Agent-frontmatter / dispatch surface.
    expect(resolveTier(config, "cheap", harness, "agent")).toBe("haiku");
    expect(resolveTier(config, "standard", harness, "agent")).toBe("sonnet");
    expect(resolveTier(config, "capable", harness, "agent")).toBe("opus");
    expect(resolveTier(config, "frontier", harness, "agent")).toBe("fable");
  });

  it("carries a non-empty site manifest", async () => {
    const result = await loadModelTierConfig(REPO_ROOT_CONFIG);
    if (result.status !== "loaded") throw new Error("expected loaded");
    expect(result.config.sites.length).toBeGreaterThan(0);
    expect(result.config.hardPins.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — the claude-code-opus second mapping, resolved from the real
// repo-root .ralph-models.yml. The renderer's fixture test
// (scripts/model-tiers/render.test.js) proves the file-level rewrite; this
// pins the same resolution at the typed-loader layer so the two parsers of
// one YAML (mcp-server loader + standalone renderer) can't silently drift
// on what the second harness resolves to (the plan's own "two parsers"
// risk row).
// ---------------------------------------------------------------------------

describe("claude-code-opus resolution — GH-1593 Phase 3 second mapping", () => {
  it("is present in the shipped config and ships dormant (defaultHarness stays claude-code)", async () => {
    const result = await loadModelTierConfig(REPO_ROOT_CONFIG);
    if (result.status !== "loaded") throw new Error("expected loaded");
    expect(Object.keys(result.config.harnesses)).toContain("claude-code-opus");
    expect(result.config.defaultHarness).toBe("claude-code");
  });

  it("frontier resolves to opus on both surfaces under claude-code-opus", async () => {
    const result = await loadModelTierConfig(REPO_ROOT_CONFIG);
    if (result.status !== "loaded") throw new Error("expected loaded");
    const { config } = result;
    expect(resolveTier(config, "frontier", "claude-code-opus", "skill")).toBe("opus");
    expect(resolveTier(config, "frontier", "claude-code-opus", "agent")).toBe("opus");
  });

  it("cheap/standard/capable are byte-identical to claude-code — only frontier moves", async () => {
    const result = await loadModelTierConfig(REPO_ROOT_CONFIG);
    if (result.status !== "loaded") throw new Error("expected loaded");
    const { config } = result;
    for (const tier of ["cheap", "standard", "capable"] as const) {
      for (const surface of ["skill", "agent"] as const) {
        expect(resolveTier(config, tier, "claude-code-opus", surface)).toBe(
          resolveTier(config, tier, "claude-code", surface),
        );
      }
    }
    // frontier is the one tier that genuinely differs between harnesses.
    expect(resolveTier(config, "frontier", "claude-code-opus", "agent")).not.toBe(
      resolveTier(config, "frontier", "claude-code", "agent"),
    );
  });
});
