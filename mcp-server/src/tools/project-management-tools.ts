/**
 * MCP tools for GitHub Projects V2 management operations.
 *
 * Provides tools for archiving/unarchiving items, removing items from projects,
 * adding existing issues to projects, linking repositories, linking teams,
 * clearing field values, managing project status updates (create, update, delete),
 * updating collaborator access, and bulk archiving.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import { toolSuccess, toolError } from "../types.js";
import { buildBatchArchiveMutation } from "./batch-tools.js";
import { zBoolish } from "../lib/zod-helpers.js";
import {
  ensureFieldCache,
  resolveProjectItemId,
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

  // -------------------------------------------------------------------------
  // ralph_hero__archive_items
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__archive_items",
    "Archive or unarchive project items. Single-item mode: provide number or projectItemId (supports unarchive). Bulk mode: provide workflowStates filter to archive multiple items matching those states. Uses aliased GraphQL mutations for efficiency (chunked at 50). Archived items are hidden from views but not deleted.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
      number: z.coerce.number().optional()
        .describe("Archive a single issue by number. Mutually exclusive with workflowStates filter."),
      projectItemId: z.string().optional()
        .describe("Archive by project item ID (for draft issues). Mutually exclusive with number and workflowStates."),
      unarchive: zBoolish().optional().default(false)
        .describe("Unarchive instead of archive. Only works with number or projectItemId (single-item mode)."),
      workflowStates: z
        .array(z.string())
        .optional()
        .describe(
          'Workflow states to archive (e.g., ["Done", "Canceled"]). Required unless number or projectItemId is provided.',
        ),
      maxItems: z
        .number()
        .optional()
        .default(50)
        .describe("Max items to archive per invocation (default 50, cap 200). Bulk mode only."),
      dryRun: zBoolish()
        .optional()
        .default(false)
        .describe(
          "If true, return matching items without archiving them (default: false). Bulk mode only.",
        ),
      updatedBefore: z
        .string()
        .optional()
        .describe(
          "ISO 8601 date (UTC). Only archive items with updatedAt before this date. Composable with workflowStates (AND logic). Bulk mode only.",
        ),
    },
    async (args) => {
      try {
        // Determine mode
        const isSingleItem = args.number !== undefined || args.projectItemId !== undefined;
        const isBulk = args.workflowStates && args.workflowStates.length > 0;

        if (!isSingleItem && !isBulk) {
          return toolError("Provide either 'number'/'projectItemId' (single item) or 'workflowStates' (bulk filter).");
        }
        if (isSingleItem && isBulk) {
          return toolError("Cannot combine number/projectItemId with workflowStates. Use one mode.");
        }
        if (args.unarchive && isBulk) {
          return toolError("Unarchive is only supported for single items (number or projectItemId).");
        }

        // Single-item mode
        if (isSingleItem) {
          if (args.number && args.projectItemId) {
            return toolError("Provide either number or projectItemId, not both");
          }

          const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(
            client,
            args,
          );

          await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

          const projectId = fieldCache.getProjectId(projectNumber);
          if (!projectId) {
            return toolError("Could not resolve project ID");
          }

          const itemId = args.projectItemId
            ? args.projectItemId
            : await resolveProjectItemId(
                client,
                fieldCache,
                owner,
                repo,
                args.number!,
                projectNumber,
              );

          if (args.unarchive) {
            await client.projectMutate(
              `mutation($projectId: ID!, $itemId: ID!) {
                unarchiveProjectV2Item(input: {
                  projectId: $projectId,
                  itemId: $itemId
                }) {
                  item { id }
                }
              }`,
              { projectId, itemId },
            );
          } else {
            await client.projectMutate(
              `mutation($projectId: ID!, $itemId: ID!) {
                archiveProjectV2Item(input: {
                  projectId: $projectId,
                  itemId: $itemId
                }) {
                  item { id }
                }
              }`,
              { projectId, itemId },
            );
          }

          return toolSuccess({
            number: args.number ?? null,
            archived: !args.unarchive,
            projectItemId: itemId,
          });
        }

        // Bulk mode (workflowStates filter)
        const { projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        const projectId = fieldCache.getProjectId(projectNumber);
        if (!projectId) {
          return toolError("Could not resolve project ID");
        }

        const effectiveMax = Math.min(args.maxItems || 50, 200);
        const SCAN_CAP = 2000; // Hard limit to prevent runaway pagination

        // Validate updatedBefore early (before scan loop)
        let updatedBeforeCutoff: number | undefined;
        if (args.updatedBefore) {
          updatedBeforeCutoff = new Date(args.updatedBefore).getTime();
          if (isNaN(updatedBeforeCutoff)) {
            return toolError(
              "Invalid updatedBefore date. Use ISO 8601 format (e.g., 2026-02-01T00:00:00Z)",
            );
          }
        }

        // Scan-until-full: fetch pages and filter until we have enough matches or exhaust items
        const matched: RawBulkArchiveItem[] = [];
        let cursor: string | null = null;
        let totalScanned = 0;
        let hasMorePages = true;

        while (matched.length < effectiveMax && hasMorePages && totalScanned < SCAN_CAP) {
          const pageSize = Math.min(100, SCAN_CAP - totalScanned);
          const page = await client.projectQuery(
            `query($projectId: ID!, $cursor: String, $first: Int!) {
              node(id: $projectId) {
                ... on ProjectV2 {
                  items(first: $first, after: $cursor) {
                    totalCount
                    pageInfo { hasNextPage endCursor }
                    nodes {
                      id
                      type
                      content {
                        ... on Issue {
                          number
                          title
                          updatedAt
                        }
                        ... on PullRequest {
                          number
                          title
                          updatedAt
                        }
                      }
                      fieldValues(first: 20) {
                        nodes {
                          ... on ProjectV2ItemFieldSingleSelectValue {
                            __typename
                            name
                            field { ... on ProjectV2FieldCommon { name } }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }`,
            { projectId, first: pageSize, cursor },
          );

          const connection = (page as Record<string, unknown>).node as Record<string, unknown>;
          const items = (connection as Record<string, unknown>).items as {
            totalCount: number;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: RawBulkArchiveItem[];
          };

          totalScanned += items.nodes.length;

          for (const item of items.nodes) {
            if (matched.length >= effectiveMax) break;

            const ws = getBulkArchiveFieldValue(item, "Workflow State");
            if (!ws || !args.workflowStates!.includes(ws)) continue;

            if (updatedBeforeCutoff) {
              if (!item.content?.updatedAt) continue;
              if (new Date(item.content.updatedAt).getTime() >= updatedBeforeCutoff) continue;
            }

            matched.push(item);
          }

          hasMorePages = items.pageInfo.hasNextPage && !!items.pageInfo.endCursor;
          cursor = items.pageInfo.endCursor;
        }

        // Determine if more eligible items may exist beyond what we collected
        const hasMore = matched.length >= effectiveMax && hasMorePages;

        if (matched.length === 0) {
          return toolSuccess({
            dryRun: args.dryRun,
            archivedCount: 0,
            wouldArchive: 0,
            items: [],
            errors: [],
            hasMore: false,
            totalScanned,
          });
        }

        // Dry run: return matched items without archiving
        if (args.dryRun) {
          return toolSuccess({
            dryRun: true,
            wouldArchive: matched.length,
            items: matched.map((m) => ({
              number: m.content?.number,
              title: m.content?.title,
              itemId: m.id,
            })),
            errors: [],
            hasMore,
            totalScanned,
          });
        }

        // Chunk and execute archive mutations
        const ARCHIVE_CHUNK_SIZE = 50;
        const itemIds = matched.map((m) => m.id);
        const archived: Array<{
          number?: number;
          title?: string;
          itemId: string;
        }> = [];
        const errors: string[] = [];

        for (let i = 0; i < itemIds.length; i += ARCHIVE_CHUNK_SIZE) {
          const chunk = itemIds.slice(i, i + ARCHIVE_CHUNK_SIZE);
          const chunkItems = matched.slice(i, i + ARCHIVE_CHUNK_SIZE);
          try {
            const { mutationString, variables } =
              buildBatchArchiveMutation(projectId, chunk);
            await client.projectMutate(mutationString, variables);
            for (const item of chunkItems) {
              archived.push({
                number: item.content?.number,
                title: item.content?.title,
                itemId: item.id,
              });
            }
          } catch (error: unknown) {
            const msg =
              error instanceof Error ? error.message : String(error);
            errors.push(
              `Chunk ${Math.floor(i / ARCHIVE_CHUNK_SIZE) + 1} failed: ${msg}`,
            );
          }
        }

        return toolSuccess({
          dryRun: false,
          archivedCount: archived.length,
          items: archived,
          errors,
          hasMore,
          totalScanned,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to bulk archive: ${message}`);
      }
    },
  );
}

interface RawBulkArchiveItem {
  id: string;
  type: string;
  content: { number?: number; title?: string; updatedAt?: string } | null;
  fieldValues: {
    nodes: Array<{
      __typename?: string;
      name?: string;
      field?: { name: string };
    }>;
  };
}

function getBulkArchiveFieldValue(
  item: RawBulkArchiveItem,
  fieldName: string,
): string | undefined {
  const fieldValue = item.fieldValues.nodes.find(
    (fv) =>
      fv.field?.name === fieldName &&
      fv.__typename === "ProjectV2ItemFieldSingleSelectValue",
  );
  return fieldValue?.name;
}


