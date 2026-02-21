/**
 * MCP tool for managing routing rules in .ralph-routing.yml.
 *
 * Provides a single `ralph_hero__configure_routing` tool with six
 * operations: list_rules, add_rule, update_rule, remove_rule,
 * validate_rules, dry_run.
 */

import fs from "node:fs/promises";
import { parse, stringify } from "yaml";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import { toolSuccess, toolError, resolveProjectOwner } from "../types.js";
import { ensureFieldCache } from "../lib/helpers.js";
import { validateRoutingConfig } from "../lib/routing-types.js";
import { evaluateRules, type IssueContext } from "../lib/routing-engine.js";

// Temporary inline types for CRUD operations — CRUD uses loose typing
// since rules come from user YAML input (not Zod-parsed).
// validate_rules and dry_run parse through validateRoutingConfig() for strict types.
interface RoutingRule {
  match: { labels?: string[]; repo?: string };
  action: { workflowState?: string; projectNumber?: number };
}
interface RoutingConfig {
  rules: RoutingRule[];
}

// ---------------------------------------------------------------------------
// Register routing tools
// ---------------------------------------------------------------------------

export function registerRoutingTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  server.tool(
    "ralph_hero__configure_routing",
    "Manage routing rules in .ralph-routing.yml. Operations: list_rules, add_rule, update_rule, remove_rule (CRUD), validate_rules (check field references), dry_run (simulate matching for an issue). Config path: configPath arg > RALPH_ROUTING_CONFIG env var > .ralph-routing.yml.",
    {
      operation: z
        .enum([
          "list_rules",
          "add_rule",
          "update_rule",
          "remove_rule",
          "validate_rules",
          "dry_run",
        ])
        .describe("Operation to perform"),
      configPath: z
        .string()
        .optional()
        .describe(
          "Path to routing config file. Defaults to RALPH_ROUTING_CONFIG env var or .ralph-routing.yml",
        ),
      rule: z
        .object({
          match: z.object({
            labels: z.array(z.string()).optional(),
            repo: z.string().optional(),
          }),
          action: z.object({
            workflowState: z.string().optional(),
            projectNumber: z.coerce.number().optional(),
          }),
        })
        .optional()
        .describe("Rule definition (required for add_rule, update_rule)"),
      ruleIndex: z
        .coerce.number()
        .optional()
        .describe(
          "Zero-based rule index (required for update_rule, remove_rule)",
        ),
      issueNumber: z
        .number()
        .optional()
        .describe("Issue number (required for dry_run)"),
    },
    async (args) => {
      const configPath =
        args.configPath ??
        process.env.RALPH_ROUTING_CONFIG ??
        ".ralph-routing.yml";

      try {
        const raw = await fs.readFile(configPath, "utf-8").catch(() => "");
        const config: RoutingConfig = raw
          ? (parse(raw) as RoutingConfig)
          : { rules: [] };
        if (!config.rules) config.rules = [];

        switch (args.operation) {
          case "list_rules":
            return toolSuccess({ rules: config.rules, configPath });

          case "add_rule":
            if (!args.rule)
              return toolError("rule is required for add_rule operation");
            config.rules = [...config.rules, args.rule as RoutingRule];
            await fs.writeFile(configPath, stringify(config, { lineWidth: 0 }));
            return toolSuccess({ rules: config.rules, configPath });

          case "update_rule":
            if (args.ruleIndex == null || !args.rule)
              return toolError(
                "ruleIndex and rule are required for update_rule operation",
              );
            if (args.ruleIndex < 0 || args.ruleIndex >= config.rules.length)
              return toolError(
                `Rule index ${args.ruleIndex} out of range (0-${config.rules.length - 1})`,
              );
            config.rules[args.ruleIndex] = args.rule as RoutingRule;
            await fs.writeFile(configPath, stringify(config, { lineWidth: 0 }));
            return toolSuccess({ rules: config.rules, configPath });

          case "remove_rule":
            if (args.ruleIndex == null)
              return toolError(
                "ruleIndex is required for remove_rule operation",
              );
            if (args.ruleIndex < 0 || args.ruleIndex >= config.rules.length)
              return toolError(
                `Rule index ${args.ruleIndex} out of range (0-${config.rules.length - 1})`,
              );
            config.rules = config.rules.filter(
              (_, i) => i !== args.ruleIndex,
            );
            await fs.writeFile(configPath, stringify(config, { lineWidth: 0 }));
            return toolSuccess({ rules: config.rules, configPath });

          case "validate_rules": {
            const errors: Array<{
              ruleIndex: number;
              field: string;
              message: string;
            }> = [];

            // Populate field cache for the default project
            const projectOwner = resolveProjectOwner(client.config);
            const projectNumber = client.config.projectNumber;
            if (projectOwner && projectNumber) {
              await ensureFieldCache(
                client,
                fieldCache,
                projectOwner,
                projectNumber,
              );
            }

            for (let i = 0; i < config.rules.length; i++) {
              const rule = config.rules[i];

              if (rule.action.workflowState) {
                const optionId = fieldCache.resolveOptionId(
                  "Workflow State",
                  rule.action.workflowState,
                  projectNumber,
                );
                if (optionId === undefined) {
                  const valid = fieldCache.getOptionNames("Workflow State", projectNumber);
                  errors.push({
                    ruleIndex: i,
                    field: "action.workflowState",
                    message: `"${rule.action.workflowState}" is not a valid Workflow State. Valid: ${valid.join(", ")}`,
                  });
                }
              }
            }

            return toolSuccess({
              valid: errors.length === 0,
              ruleCount: config.rules.length,
              errors,
              configPath,
            });
          }

          case "dry_run": {
            if (!args.issueNumber) {
              return toolError(
                "issueNumber is required for dry_run operation",
              );
            }

            const owner = client.config.owner;
            const repo = client.config.repo;
            if (!owner || !repo) {
              return toolError(
                "owner and repo must be configured (set RALPH_GH_OWNER and RALPH_GH_REPO env vars)",
              );
            }

            // Parse config through Zod for proper RoutingConfig type
            const typedConfig = validateRoutingConfig(
              raw ? parse(raw) : { version: 1, rules: [] },
            );

            // Fetch issue details
            const issueResult = await client.query<{
              repository: {
                issue: {
                  number: number;
                  title: string;
                  labels: { nodes: Array<{ name: string }> };
                  repository: { nameWithOwner: string };
                } | null;
              };
            }>(
              `query($owner: String!, $repo: String!, $issueNum: Int!) {
                repository(owner: $owner, name: $repo) {
                  issue(number: $issueNum) {
                    number
                    title
                    labels(first: 20) { nodes { name } }
                    repository { nameWithOwner }
                  }
                }
              }`,
              { owner, repo, issueNum: args.issueNumber },
            );

            const issue = issueResult.repository?.issue;
            if (!issue) {
              return toolError(
                `Issue #${args.issueNumber} not found in ${owner}/${repo}`,
              );
            }

            const issueContext: IssueContext = {
              repo: issue.repository.nameWithOwner,
              labels: issue.labels.nodes.map((l) => l.name),
              issueType: "issue",
            };

            const evalResult = evaluateRules(typedConfig, issueContext);

            return toolSuccess({
              issueNumber: args.issueNumber,
              issueTitle: issue.title,
              issueContext,
              matchedRules: evalResult.matchedRules,
              stoppedEarly: evalResult.stoppedEarly,
              note: "No mutations performed -- dry run only",
              configPath,
            });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to configure routing: ${message}`);
      }
    },
  );
}
