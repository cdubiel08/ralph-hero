/**
 * Routing config loader and live validation.
 *
 * Two-phase validation:
 * 1. Structural: YAML parse + Zod schema validation (loadRoutingConfig)
 * 2. Referential: field option checks against FieldOptionCache (validateRulesLive)
 *
 * Consumers:
 * - #178 configure_routing tool: loads config for CRUD operations
 * - #179 validate_rules operation: calls validateRulesLive
 */

import { readFile } from "fs/promises";
import { parse as yamlParse } from "yaml";
import { RoutingConfigSchema, type RoutingConfig } from "./routing-types.js";
import type { FieldOptionCache } from "./cache.js";

const DEFAULT_CONFIG: RoutingConfig = {
  version: 1,
  stopOnFirstMatch: true,
  rules: [],
};

export interface ConfigError {
  phase: "yaml_parse" | "schema_validation" | "live_validation";
  path: string[];
  message: string;
}

export type LoadResult =
  | { status: "loaded"; config: RoutingConfig; filePath: string }
  | { status: "missing"; config: RoutingConfig }
  | { status: "error"; errors: ConfigError[] };

/**
 * Load and validate a routing config file.
 *
 * Returns a discriminated union:
 * - "loaded": valid config parsed from file
 * - "missing": file not found, returns default empty config
 * - "error": YAML parse or schema validation errors
 */
export async function loadRoutingConfig(
  configPath: string,
): Promise<LoadResult> {
  // Read file — gracefully handle missing files
  let contents: string;
  try {
    contents = await readFile(configPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing", config: DEFAULT_CONFIG };
    }
    throw err;
  }

  // Parse YAML
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

  // Validate against Zod schema
  const result = RoutingConfigSchema.safeParse(parsed);
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

/**
 * Validate routing rules against live project field data.
 *
 * Checks that referenced workflow states exist in the FieldOptionCache.
 * The caller must ensure the cache is populated (via ensureFieldCache)
 * before calling this function.
 *
 * Skips disabled rules (enabled === false).
 */
export function validateRulesLive(
  config: RoutingConfig,
  fieldCache: FieldOptionCache,
): ConfigError[] {
  const errors: ConfigError[] = [];

  for (let i = 0; i < config.rules.length; i++) {
    const rule = config.rules[i];

    // Skip disabled rules
    if (rule.enabled === false) continue;

    // Validate workflowState references
    if (rule.action.workflowState) {
      const optionId = fieldCache.resolveOptionId(
        "Workflow State",
        rule.action.workflowState,
      );
      if (optionId === undefined) {
        const valid = fieldCache.getOptionNames("Workflow State");
        errors.push({
          phase: "live_validation",
          path: ["rules", String(i), "action", "workflowState"],
          message: `Workflow state "${rule.action.workflowState}" not found in project. Valid: ${valid.join(", ")}`,
        });
      }
    }
  }

  return errors;
}
