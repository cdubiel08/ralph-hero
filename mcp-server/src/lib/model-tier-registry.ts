/**
 * Capability-tier model config schema, loader, and resolver (GH-1593).
 *
 * Mirrors the `.ralph-routing.yml` / `routing-types.ts` / `routing-config.ts`
 * dual-consumer pattern structurally: repo-root YAML -> Zod schema -> pure
 * loader with a built-in default on ENOENT -> `resolveTier()` for lookups.
 *
 * This is the typed reference implementation of `.ralph-models.yml`. It has
 * no registered MCP tool consumer today (see the plan's Design Decisions —
 * the standalone `scripts/model-tiers/render.js` checker is the enforcement
 * surface); it exists so any future MCP-side consumer has a validated,
 * typed loader ready, and so the AC-2 "default mapping reproduces today's
 * pins" regression is pinned from two independent parsers of the same file
 * (this loader + the renderer's own YAML parse), catching drift between them.
 */

import { readFile } from "fs/promises";
import { parse as yamlParse } from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Tier / surface vocabulary
// ---------------------------------------------------------------------------

export const TIER_NAMES = ["cheap", "standard", "capable", "frontier"] as const;
export const SURFACES = ["skill", "agent"] as const;

export type Tier = (typeof TIER_NAMES)[number];
export type Surface = (typeof SURFACES)[number];

// Skill-session frontmatter accepts the entitlement-aware `best` alias in
// addition to the four concrete Claude Code model ids/aliases used today.
const SkillModelValueSchema = z.enum(["haiku", "sonnet", "opus", "fable", "best"]);

// Agent frontmatter and Agent(model=...) dispatch params use a closed enum
// that does NOT include `best` (GH-1487 failure class — the Zod schema
// rejects `best` on an agent surface outright, per the plan's Risks section).
const AgentModelValueSchema = z.enum(["haiku", "sonnet", "opus", "fable"]);

// ---------------------------------------------------------------------------
// Harness tier table
// ---------------------------------------------------------------------------

const TierSurfaceValueSchema = z.object({
  skill: SkillModelValueSchema,
  agent: AgentModelValueSchema,
});

const HarnessTiersSchema = z.object({
  cheap: TierSurfaceValueSchema,
  standard: TierSurfaceValueSchema,
  capable: TierSurfaceValueSchema,
  frontier: TierSurfaceValueSchema,
});

// ---------------------------------------------------------------------------
// Sites / hard pins
// ---------------------------------------------------------------------------

const TierNameSchema = z.enum(TIER_NAMES);
const SiteKindSchema = z.enum(["skill", "agent", "dispatch"]);

const SiteSchema = z.object({
  path: z.string(),
  kind: SiteKindSchema,
  tier: TierNameSchema,
  count: z.number().int().positive().optional(),
});

const HardPinSchema = z.object({
  path: z.string(),
  kind: SiteKindSchema,
  value: z.string(),
  count: z.number().int().positive().optional(),
  reason: z.string(),
});

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

const OverrideSchema = z.object({
  env: z.string(),
  default: TierNameSchema,
});

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

export const ModelTierConfigSchema = z
  .object({
    version: z.literal(1),
    defaultHarness: z.string(),
    harnesses: z.record(z.string(), HarnessTiersSchema),
    overrides: z.record(z.string(), OverrideSchema).optional().default({}),
    sites: z.array(SiteSchema),
    hardPins: z.array(HardPinSchema).optional().default([]),
  })
  .refine((cfg) => cfg.defaultHarness in cfg.harnesses, {
    message: "defaultHarness must reference a key present in harnesses",
  });

export type ModelTierConfig = z.infer<typeof ModelTierConfigSchema>;
export type Site = z.infer<typeof SiteSchema>;
export type HardPin = z.infer<typeof HardPinSchema>;

/**
 * Validate and parse a model-tier config object (e.g., from YAML parse
 * output). Throws ZodError with detailed messages on validation failure.
 */
export function validateModelTierConfig(data: unknown): ModelTierConfig {
  return ModelTierConfigSchema.parse(data);
}

// ---------------------------------------------------------------------------
// Built-in default — reproduces the shipped `.ralph-models.yml` claude-code
// harness exactly (AC-2: zero-config behavior stays byte-identical to today).
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL_TIERS: ModelTierConfig = {
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
  overrides: {
    impl: { env: "RALPH_IMPL_MODEL", default: "standard" },
  },
  sites: [],
  hardPins: [],
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export interface ConfigError {
  phase: "yaml_parse" | "schema_validation";
  path: string[];
  message: string;
}

export type LoadResult =
  | { status: "loaded"; config: ModelTierConfig; filePath: string }
  | { status: "missing"; config: ModelTierConfig }
  | { status: "error"; errors: ConfigError[] };

/**
 * Load and validate a `.ralph-models.yml`-shaped config file.
 *
 * Returns a discriminated union:
 * - "loaded": valid config parsed from file
 * - "missing": file not found (ENOENT) -> DEFAULT_MODEL_TIERS
 * - "error": YAML parse or schema validation errors
 */
export async function loadModelTierConfig(
  configPath: string,
): Promise<LoadResult> {
  let contents: string;
  try {
    contents = await readFile(configPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing", config: DEFAULT_MODEL_TIERS };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = yamlParse(contents);
  } catch (err) {
    return {
      status: "error",
      errors: [
        {
          phase: "yaml_parse",
          path: [],
          message: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }

  const result = ModelTierConfigSchema.safeParse(parsed);
  if (!result.success) {
    const errors: ConfigError[] = result.error.issues.map((issue) => ({
      phase: "schema_validation" as const,
      path: issue.path.map(String),
      message: issue.message,
    }));
    return { status: "error", errors };
  }

  return { status: "loaded", config: result.data, filePath: configPath };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export class UnknownHarnessError extends Error {
  constructor(harness: string) {
    super(`Unknown harness "${harness}" — not present in config.harnesses`);
    this.name = "UnknownHarnessError";
  }
}

/**
 * Resolve a tier name to its concrete model literal for a given harness and
 * surface. Pure function — throws UnknownHarnessError on an unknown harness.
 * `tier`/`surface` are closed unions at the type level, so a bad tier/surface
 * name is a compile-time error for TypeScript callers; the schema itself
 * additionally rejects unknown tier names anywhere they appear in config
 * (sites[].tier, overrides[].default) at load time.
 */
export function resolveTier(
  config: ModelTierConfig,
  tier: Tier,
  harness: string,
  surface: Surface,
): string {
  const harnessTiers = config.harnesses[harness];
  if (!harnessTiers) {
    throw new UnknownHarnessError(harness);
  }
  return harnessTiers[tier][surface];
}
