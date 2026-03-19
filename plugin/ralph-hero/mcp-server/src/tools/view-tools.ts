/**
 * MCP tools for GitHub Projects V2 view management.
 *
 * Copies views from a source project (read via GraphQL) to a target
 * project using the REST API POST endpoint.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolError, toolSuccess } from "../types.js";
import type { GitHubClient } from "../github-client.js";
import type { FieldOptionCache } from "../lib/cache.js";
import type { ProjectV2ViewLayout } from "../types.js";
import { fetchProjectViews } from "./project-tools.js";

/**
 * Convert GraphQL layout enum to REST API layout value.
 * All three variants are handled exhaustively — TypeScript will error
 * at build time if a new layout variant is added and not handled here.
 */
export function toRestLayout(
  layout: ProjectV2ViewLayout,
): "table" | "board" | "roadmap" {
  switch (layout) {
    case "TABLE_LAYOUT":
      return "table";
    case "BOARD_LAYOUT":
      return "board";
    case "ROADMAP_LAYOUT":
      return "roadmap";
  }
}

export function registerViewTools(
  server: McpServer,
  client: GitHubClient,
  _fieldCache: FieldOptionCache,
): void {
  server.tool(
    "ralph_hero__create_views",
    "Copy views from a source GitHub Project V2 to a target project using the REST API. Reads view names, layouts, and filter strings from the source project via GraphQL, then creates matching views in the target. Note: sort/group configuration is not available via API and must be set manually after creation.",
    {
      owner: z
        .string()
        .optional()
        .describe(
          "GitHub owner (user or org). Defaults to RALPH_GH_OWNER env var",
        ),
      sourceProjectNumber: z.coerce
        .number()
        .describe("Project number to copy views FROM"),
      targetProjectNumber: z.coerce
        .number()
        .describe("Project number to copy views INTO"),
    },
    async (args) => {
      const owner =
        args.owner ?? client.config.projectOwner ?? client.config.owner;
      if (!owner) {
        return toolError(
          "owner is required — set RALPH_GH_OWNER or pass owner param",
        );
      }

      // Read views from source project; ownerType drives REST path selection
      let sourceViews;
      let ownerType: "users" | "orgs";
      try {
        const result = await fetchProjectViews(
          client,
          owner,
          args.sourceProjectNumber,
        );
        sourceViews = result.views;
        ownerType = result.ownerType;
      } catch (err) {
        return toolError(
          `Failed to read views from project #${args.sourceProjectNumber}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (sourceViews.length === 0) {
        return toolSuccess({
          created: [],
          failed: [],
          count: 0,
          sourceProject: args.sourceProjectNumber,
          targetProject: args.targetProjectNumber,
          message: "Source project has no views",
        });
      }

      // REST path uses owner login (not numeric ID).
      // filter is a plain top-level string matching the GraphQL field value.
      const basePath =
        ownerType === "users"
          ? `/users/${owner}/projectsV2/${args.targetProjectNumber}/views`
          : `/orgs/${owner}/projectsV2/${args.targetProjectNumber}/views`;

      const created: Array<{ name: string; layout: string; id: string }> = [];
      const failed: Array<{ name: string; error: string }> = [];

      for (const view of sourceViews) {
        const body: Record<string, unknown> = {
          name: view.name,
          layout: toRestLayout(view.layout),
        };
        if (view.filter) {
          body.filter = view.filter;
        }

        try {
          const createdView = await client.restPost<{
            id: string;
            name: string;
            layout: string;
          }>(basePath, body);
          created.push({
            name: createdView.name,
            layout: createdView.layout,
            id: createdView.id,
          });
        } catch (err) {
          failed.push({
            name: view.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return toolSuccess({
        created,
        failed,
        count: created.length,
        sourceProject: args.sourceProjectNumber,
        targetProject: args.targetProjectNumber,
      });
    },
  );
}
