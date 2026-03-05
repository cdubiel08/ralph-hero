/**
 * Repo registry schema, types, parser, and lookup helpers.
 *
 * Provides structured configuration for multi-repo portfolio management.
 * The registry YAML file maps short repo names to metadata (domain, tech
 * stack, default labels/assignees/estimate) and defines cross-repo
 * decomposition patterns for feature work.
 *
 * Consumers:
 * - server startup: loads registry once from env-specified path
 * - create_issue tool: merges repo defaults into issue creation args
 * - decompose_feature tool: looks up patterns for cross-repo decomposition
 * - pipeline_dashboard: groups issues by repo domain
 */

import { parse as yamlParse } from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Default values applied to issues created in a specific repo.
 * All fields are optional — only specified ones are used.
 *
 * Example YAML:
 *   defaults:
 *     labels: ["backend", "infra"]
 *     assignees: ["cdubiel08"]
 *     estimate: "S"
 */
export const RepoDefaultsSchema = z.object({
  labels: z
    .array(z.string())
    .optional()
    .describe("Default labels to apply to issues in this repo"),
  assignees: z
    .array(z.string())
    .optional()
    .describe("Default assignees for issues in this repo"),
  estimate: z
    .string()
    .optional()
    .describe("Default estimate (e.g., 'XS', 'S', 'M', 'L') for this repo"),
});

/**
 * A single repository entry in the registry.
 *
 * Example YAML:
 *   mcp-server:
 *     owner: cdubiel08
 *     domain: platform
 *     tech: [typescript, node]
 *     defaults:
 *       labels: [backend]
 *     paths: [plugin/ralph-hero/mcp-server]
 */
export const RepoEntrySchema = z.object({
  owner: z
    .string()
    .optional()
    .describe("GitHub owner (user or org); falls back to RALPH_GH_OWNER if omitted"),
  domain: z
    .string()
    .describe("Functional domain this repo belongs to (e.g., 'platform', 'frontend')"),
  tech: z
    .array(z.string())
    .optional()
    .describe("Technology stack tags for this repo (e.g., ['typescript', 'react'])"),
  defaults: RepoDefaultsSchema
    .optional()
    .describe("Default values applied to issues created in this repo"),
  paths: z
    .array(z.string())
    .optional()
    .describe("Monorepo sub-paths owned by this repo (e.g., ['packages/core'])"),
});

/**
 * One step in a cross-repo decomposition pattern.
 *
 * Example YAML:
 *   - repo: mcp-server
 *     role: Implement MCP tool endpoint
 */
export const DecompositionStepSchema = z.object({
  repo: z
    .string()
    .describe("Registry key of the repo responsible for this step"),
  role: z
    .string()
    .describe("Human-readable description of what this repo does in the decomposition"),
});

/**
 * A named cross-repo decomposition pattern for feature work.
 *
 * Example YAML:
 *   full-stack-feature:
 *     description: "Frontend + backend + infra change"
 *     decomposition:
 *       - repo: frontend
 *         role: Build UI
 *       - repo: mcp-server
 *         role: Add API endpoint
 *     dependency-flow:
 *       - mcp-server -> frontend
 */
export const PatternSchema = z.object({
  description: z
    .string()
    .describe("Human-readable description of when to use this pattern"),
  decomposition: z
    .array(DecompositionStepSchema)
    .min(1)
    .describe("Ordered list of repo steps for this pattern (at least one required)"),
  "dependency-flow": z
    .array(z.string())
    .optional()
    .describe("Dependency edges between repos (e.g., 'api -> frontend')"),
});

/**
 * Top-level repo registry configuration.
 *
 * Example YAML:
 *   version: 1
 *   repos:
 *     mcp-server:
 *       domain: platform
 *       tech: [typescript]
 *   patterns:
 *     full-stack:
 *       description: "Full stack feature"
 *       decomposition:
 *         - repo: mcp-server
 *           role: Backend
 */
export const RepoRegistrySchema = z.object({
  version: z
    .literal(1)
    .describe("Schema version for forward compatibility"),
  repos: z
    .record(z.string(), RepoEntrySchema)
    .refine((r) => Object.keys(r).length >= 1, {
      message: "At least one repo entry is required",
    })
    .describe("Map of short repo name to repo metadata"),
  patterns: z
    .record(z.string(), PatternSchema)
    .optional()
    .describe("Named cross-repo decomposition patterns"),
});

// ---------------------------------------------------------------------------
// Inferred TypeScript Types
// ---------------------------------------------------------------------------

export type RepoDefaults = z.infer<typeof RepoDefaultsSchema>;
export type RepoEntry = z.infer<typeof RepoEntrySchema>;
export type DecompositionStep = z.infer<typeof DecompositionStepSchema>;
export type Pattern = z.infer<typeof PatternSchema>;
export type RepoRegistry = z.infer<typeof RepoRegistrySchema>;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a YAML string into a validated RepoRegistry.
 *
 * Throws a descriptive error if:
 * - the YAML is syntactically invalid
 * - the parsed value does not match RepoRegistrySchema
 *
 * @param yamlContent - Raw YAML string (e.g., from fs.readFileSync)
 * @returns Validated RepoRegistry object
 */
export function parseRepoRegistry(yamlContent: string): RepoRegistry {
  let parsed: unknown;
  try {
    parsed = yamlParse(yamlContent);
  } catch (err) {
    throw new Error(
      `Repo registry YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = RepoRegistrySchema.safeParse(parsed);
  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `  ${path}: ${issue.message}`;
      })
      .join("\n");
    throw new Error(`Repo registry schema validation failed:\n${messages}`);
  }

  return result.data;
}

// ---------------------------------------------------------------------------
// Lookup Helpers
// ---------------------------------------------------------------------------

/**
 * Look up a repo entry by name (case-insensitive).
 *
 * @param registry - Parsed registry
 * @param repoName - Repo key to look up (case-insensitive)
 * @returns { name, entry } if found, undefined otherwise
 */
export function lookupRepo(
  registry: RepoRegistry,
  repoName: string,
): { name: string; entry: RepoEntry } | undefined {
  const lower = repoName.toLowerCase();
  for (const [name, entry] of Object.entries(registry.repos)) {
    if (name.toLowerCase() === lower) {
      return { name, entry };
    }
  }
  return undefined;
}

/**
 * Look up a decomposition pattern by name (case-insensitive).
 *
 * @param registry - Parsed registry
 * @param patternName - Pattern key to look up (case-insensitive)
 * @returns { name, pattern } if found, undefined otherwise
 */
export function lookupPattern(
  registry: RepoRegistry,
  patternName: string,
): { name: string; pattern: Pattern } | undefined {
  if (!registry.patterns) return undefined;

  const lower = patternName.toLowerCase();
  for (const [name, pattern] of Object.entries(registry.patterns)) {
    if (name.toLowerCase() === lower) {
      return { name, pattern };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Defaults Merging
// ---------------------------------------------------------------------------

/**
 * Merge repo defaults with caller-supplied args.
 *
 * Merge rules:
 * - **labels**: additive union, deduplicated (args labels + defaults labels)
 * - **assignees**: args win; fall back to defaults if args omit it
 * - **estimate**: args win; fall back to defaults if args omit it
 *
 * @param defaults - Repo-level defaults from registry (may be undefined)
 * @param args - Caller-supplied values (take precedence for non-label fields)
 * @returns Merged object with only the fields that have values
 */
export function mergeDefaults(
  defaults: RepoDefaults | undefined,
  args: { labels?: string[]; assignees?: string[]; estimate?: string },
): { labels?: string[]; assignees?: string[]; estimate?: string } {
  const result: { labels?: string[]; assignees?: string[]; estimate?: string } = {};

  // Labels: additive union, deduplicated
  const allLabels = [
    ...(args.labels ?? []),
    ...(defaults?.labels ?? []),
  ];
  if (allLabels.length > 0) {
    result.labels = [...new Set(allLabels)];
  }

  // Assignees: args win, fall back to defaults
  const assignees = args.assignees ?? defaults?.assignees;
  if (assignees !== undefined) {
    result.assignees = assignees;
  }

  // Estimate: args win, fall back to defaults
  const estimate = args.estimate ?? defaults?.estimate;
  if (estimate !== undefined) {
    result.estimate = estimate;
  }

  return result;
}
