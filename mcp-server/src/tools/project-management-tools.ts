/**
 * MCP tools for GitHub Projects V2 management operations.
 *
 * Provides `ralph_hero__create_status_update`. GH-1611 folded the former
 * standalone archive tool (archive/unarchive, single-item and bulk-filter
 * modes) into `ralph_hero__batch_update` — see `tools/batch-tools.ts` for
 * that logic, including the server-side GH-0870 open-children guard added
 * to the filter-driven bulk-scan path.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import { toolSuccess, toolError } from "../types.js";
import {
  ensureFieldCache,
  resolveFullConfig,
} from "../lib/helpers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fields that Ralph depends on — delete_field refuses to remove these. */
export const PROTECTED_FIELDS = ["Workflow State", "Priority", "Estimate", "Status"];

// ---------------------------------------------------------------------------
// Register project management tools
// ---------------------------------------------------------------------------

export function registerProjectManagementTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  // -------------------------------------------------------------------------
  // ralph_hero__create_status_update
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__create_status_update",
    "Post a project-level status update with health designation. Visible in GitHub Projects UI header and panel. Returns: id, status, body, startDate, targetDate, createdAt.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
      status: z.enum(["ON_TRACK", "AT_RISK", "OFF_TRACK", "INACTIVE", "COMPLETE"])
        .describe("Project health designation"),
      body: z.string().optional().describe("Status update body (markdown)"),
      startDate: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      targetDate: z.string().optional().describe("Target date (YYYY-MM-DD)"),
    },
    async (args) => {
      try {
        const { projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        const projectId = fieldCache.getProjectId(projectNumber);
        if (!projectId) {
          return toolError("Could not resolve project ID");
        }

        const vars: Record<string, unknown> = {
          projectId,
          statusValue: args.status,
        };
        if (args.body !== undefined) vars.body = args.body;
        if (args.startDate !== undefined) vars.startDate = args.startDate;
        if (args.targetDate !== undefined) vars.targetDate = args.targetDate;

        const result = await client.projectMutate<{
          createProjectV2StatusUpdate: {
            statusUpdate: {
              id: string;
              status: string;
              body: string | null;
              startDate: string | null;
              targetDate: string | null;
              createdAt: string;
            };
          };
        }>(
          `mutation($projectId: ID!, $statusValue: ProjectV2StatusUpdateStatus!, $body: String, $startDate: Date, $targetDate: Date) {
            createProjectV2StatusUpdate(input: {
              projectId: $projectId,
              status: $statusValue,
              body: $body,
              startDate: $startDate,
              targetDate: $targetDate
            }) {
              statusUpdate {
                id
                status
                body
                startDate
                targetDate
                createdAt
              }
            }
          }`,
          vars,
        );

        const su = result.createProjectV2StatusUpdate.statusUpdate;
        return toolSuccess({
          id: su.id,
          status: su.status,
          body: su.body,
          startDate: su.startDate,
          targetDate: su.targetDate,
          createdAt: su.createdAt,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to create status update: ${message}`);
      }
    },
  );

}

