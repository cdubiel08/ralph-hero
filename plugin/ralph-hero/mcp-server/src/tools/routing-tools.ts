/**
 * MCP tool for managing routing rules in .ralph-routing.yml.
 *
 * Provides a single `ralph_hero__configure_routing` tool with four
 * CRUD operations: list_rules, add_rule, update_rule, remove_rule.
 */

import fs from "node:fs/promises";
import { parse, stringify } from "yaml";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import { toolSuccess, toolError } from "../types.js";

// Temporary inline types — will be replaced by import from lib/routing-types.ts (#166)
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
  _client: GitHubClient,
  _fieldCache: FieldOptionCache,
): void {
  server.tool(
    "ralph_hero__configure_routing",
    "Manage routing rules in .ralph-routing.yml. CRUD operations: list, add, update, remove rules. Config path: configPath arg > RALPH_ROUTING_CONFIG env var > .ralph-routing.yml. Returns: updated rule list and configPath.",
    {
      operation: z
        .enum(["list_rules", "add_rule", "update_rule", "remove_rule"])
        .describe("CRUD operation to perform"),
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
            projectNumber: z.number().optional(),
          }),
        })
        .optional()
        .describe("Rule definition (required for add_rule, update_rule)"),
      ruleIndex: z
        .number()
        .optional()
        .describe(
          "Zero-based rule index (required for update_rule, remove_rule)",
        ),
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
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to configure routing: ${message}`);
      }
    },
  );
}
