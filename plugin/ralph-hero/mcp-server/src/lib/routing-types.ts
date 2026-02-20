/**
 * Routing rules config schema and TypeScript types.
 *
 * Defines the structure for `.ralph-routing.yml` config files used by
 * the issue routing engine. Zod schemas provide runtime validation;
 * TypeScript types are derived via z.infer<> for compile-time safety.
 *
 * Consumers:
 * - #167 matching engine: imports MatchCriteria, RoutingRule types
 * - #168 config loader: imports RoutingConfigSchema for YAML validation
 * - #178 CRUD tool: imports schemas + types for inline validation
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Match Criteria
// ---------------------------------------------------------------------------

/**
 * Defines conditions for matching an issue to a routing rule.
 *
 * At least one criterion must be specified. Multiple criteria are AND'd:
 * all specified conditions must match for the rule to apply.
 *
 * Example YAML:
 *   match:
 *     repo: "cdubiel08/ralph-hero"
 *     labels:
 *       any: ["enhancement", "bug"]
 */
export const MatchCriteriaSchema = z
  .object({
    repo: z
      .string()
      .optional()
      .describe("Repository glob pattern (e.g., 'my-org/*', 'owner/repo')"),
    labels: z
      .object({
        any: z
          .array(z.string())
          .optional()
          .describe("Match if issue has ANY of these labels"),
        all: z
          .array(z.string())
          .optional()
          .describe("Match if issue has ALL of these labels"),
      })
      .optional()
      .describe("Label matching criteria"),
    issueType: z
      .enum(["issue", "pull_request", "draft_issue"])
      .optional()
      .describe("Match by item type"),
    negate: z
      .boolean()
      .optional()
      .default(false)
      .describe("Invert match result — true means 'NOT matching'"),
  })
  .refine((d) => d.repo || d.labels || d.issueType, {
    message: "At least one match criterion must be specified (repo, labels, or issueType)",
  });

// ---------------------------------------------------------------------------
// Routing Action
// ---------------------------------------------------------------------------

/**
 * Defines what happens when a rule matches.
 *
 * At least one action must be specified. Multiple actions execute together.
 *
 * Example YAML:
 *   action:
 *     projectNumber: 3
 *     workflowState: "Backlog"
 *     labels: ["triaged"]
 */
export const RoutingActionSchema = z
  .object({
    projectNumber: z
      .number()
      .optional()
      .describe("Add issue to this project (shorthand for single project)"),
    projectNumbers: z
      .array(z.number())
      .optional()
      .describe("Add issue to multiple projects"),
    workflowState: z
      .string()
      .optional()
      .describe("Set workflow state after routing"),
    labels: z
      .array(z.string())
      .optional()
      .describe("Add these labels to the issue"),
  })
  .refine(
    (d) => d.projectNumber || d.projectNumbers || d.workflowState || d.labels,
    {
      message: "At least one action must be specified (projectNumber, projectNumbers, workflowState, or labels)",
    },
  );

// ---------------------------------------------------------------------------
// Routing Rule
// ---------------------------------------------------------------------------

/**
 * A single routing rule: match criteria + action.
 *
 * Example YAML:
 *   - name: "Route MCP server issues"
 *     match:
 *       repo: "cdubiel08/ralph-hero"
 *     action:
 *       projectNumber: 3
 */
export const RoutingRuleSchema = z.object({
  name: z
    .string()
    .optional()
    .describe("Human-readable rule name for debugging and audit trail"),
  match: MatchCriteriaSchema,
  action: RoutingActionSchema,
  enabled: z
    .boolean()
    .optional()
    .default(true)
    .describe("Toggle rule on/off without removing it"),
});

// ---------------------------------------------------------------------------
// Routing Config
// ---------------------------------------------------------------------------

/**
 * Top-level routing configuration.
 *
 * Example YAML:
 *   version: 1
 *   stopOnFirstMatch: true
 *   rules:
 *     - name: "Route bugs"
 *       match:
 *         labels:
 *           any: ["bug"]
 *       action:
 *         projectNumber: 3
 */
export const RoutingConfigSchema = z.object({
  version: z
    .literal(1)
    .describe("Schema version for forward compatibility"),
  stopOnFirstMatch: z
    .boolean()
    .optional()
    .default(true)
    .describe("Stop evaluating rules after first match (default: true)"),
  rules: z
    .array(RoutingRuleSchema)
    .describe("Ordered list of routing rules — evaluated top to bottom"),
});

// ---------------------------------------------------------------------------
// Inferred TypeScript Types
// ---------------------------------------------------------------------------

export type MatchCriteria = z.infer<typeof MatchCriteriaSchema>;
export type RoutingAction = z.infer<typeof RoutingActionSchema>;
export type RoutingRule = z.infer<typeof RoutingRuleSchema>;
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;

// ---------------------------------------------------------------------------
// Convenience Functions
// ---------------------------------------------------------------------------

/**
 * Validate and parse a routing config object (e.g., from YAML parse output).
 * Throws ZodError with detailed messages on validation failure.
 */
export function validateRoutingConfig(data: unknown): RoutingConfig {
  return RoutingConfigSchema.parse(data);
}
