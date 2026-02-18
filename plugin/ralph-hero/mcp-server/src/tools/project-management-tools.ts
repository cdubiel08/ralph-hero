/**
 * MCP tools for GitHub Projects V2 management operations.
 *
 * Provides tools for archiving/unarchiving items, removing items from projects,
 * adding existing issues to projects, linking repositories, and clearing field values.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import { toolSuccess, toolError } from "../types.js";
import {
  ensureFieldCache,
  resolveIssueNodeId,
  resolveProjectItemId,
  resolveFullConfig,
} from "../lib/helpers.js";

// ---------------------------------------------------------------------------
// Register project management tools
// ---------------------------------------------------------------------------

export function registerProjectManagementTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  // -------------------------------------------------------------------------
  // ralph_hero__archive_item
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__archive_item",
    "Archive or unarchive a project item. Archived items are hidden from default views but not deleted. Returns: number, archived, projectItemId.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
      number: z.number().describe("Issue number"),
      unarchive: z.boolean().optional().default(false)
        .describe("If true, unarchive instead of archive (default: false)"),
    },
    async (args) => {
      try {
        const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        const projectId = fieldCache.getProjectId();
        if (!projectId) {
          return toolError("Could not resolve project ID");
        }

        const projectItemId = await resolveProjectItemId(
          client,
          fieldCache,
          owner,
          repo,
          args.number,
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
            { projectId, itemId: projectItemId },
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
            { projectId, itemId: projectItemId },
          );
        }

        return toolSuccess({
          number: args.number,
          archived: !args.unarchive,
          projectItemId,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to ${args.unarchive ? "unarchive" : "archive"} item: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__remove_from_project
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__remove_from_project",
    "Remove an issue from the project. This deletes the project item (not the issue itself). Returns: number, removed.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
      number: z.number().describe("Issue number"),
    },
    async (args) => {
      try {
        const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        const projectId = fieldCache.getProjectId();
        if (!projectId) {
          return toolError("Could not resolve project ID");
        }

        const projectItemId = await resolveProjectItemId(
          client,
          fieldCache,
          owner,
          repo,
          args.number,
        );

        await client.projectMutate(
          `mutation($projectId: ID!, $itemId: ID!) {
            deleteProjectV2Item(input: {
              projectId: $projectId,
              itemId: $itemId
            }) {
              deletedItemId
            }
          }`,
          { projectId, itemId: projectItemId },
        );

        // Invalidate cached project item ID since it no longer exists
        client.getCache().invalidate(
          `project-item-id:${owner}/${repo}#${args.number}`,
        );

        return toolSuccess({
          number: args.number,
          removed: true,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to remove from project: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__add_to_project
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__add_to_project",
    "Add an existing issue to the project. The issue must already exist in the repository. Returns: number, projectItemId, added.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
      number: z.number().describe("Issue number"),
    },
    async (args) => {
      try {
        const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        const projectId = fieldCache.getProjectId();
        if (!projectId) {
          return toolError("Could not resolve project ID");
        }

        const issueNodeId = await resolveIssueNodeId(
          client,
          owner,
          repo,
          args.number,
        );

        const result = await client.projectMutate<{
          addProjectV2ItemById: {
            item: { id: string };
          };
        }>(
          `mutation($projectId: ID!, $contentId: ID!) {
            addProjectV2ItemById(input: {
              projectId: $projectId,
              contentId: $contentId
            }) {
              item { id }
            }
          }`,
          { projectId, contentId: issueNodeId },
        );

        const projectItemId = result.addProjectV2ItemById.item.id;

        // Cache the new project item ID
        client.getCache().set(
          `project-item-id:${owner}/${repo}#${args.number}`,
          projectItemId,
          30 * 60 * 1000,
        );

        return toolSuccess({
          number: args.number,
          projectItemId,
          added: true,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to add to project: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__link_repository
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__link_repository",
    "Link or unlink a repository to/from the project. Linked repositories enable auto-add workflows and issue filtering. Returns: repository, linked.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repoToLink: z.string()
        .describe("Repository to link, as 'owner/name' or just 'name' (uses default owner)"),
      unlink: z.boolean().optional().default(false)
        .describe("If true, unlink instead of link (default: false)"),
    },
    async (args) => {
      try {
        const { projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        const projectId = fieldCache.getProjectId();
        if (!projectId) {
          return toolError("Could not resolve project ID");
        }

        // Parse repoToLink: "owner/name" or just "name" (using default owner)
        let repoOwner: string;
        let repoName: string;
        if (args.repoToLink.includes("/")) {
          const parts = args.repoToLink.split("/");
          repoOwner = parts[0];
          repoName = parts[1];
        } else {
          repoOwner = client.config.owner || projectOwner;
          repoName = args.repoToLink;
        }

        // Resolve repository node ID
        const repoResult = await client.query<{
          repository: { id: string } | null;
        }>(
          `query($repoOwner: String!, $repoName: String!) {
            repository(owner: $repoOwner, name: $repoName) { id }
          }`,
          { repoOwner, repoName },
          { cache: true, cacheTtlMs: 60 * 60 * 1000 },
        );

        const repoId = repoResult.repository?.id;
        if (!repoId) {
          return toolError(
            `Repository ${repoOwner}/${repoName} not found`,
          );
        }

        if (args.unlink) {
          await client.projectMutate(
            `mutation($projectId: ID!, $repositoryId: ID!) {
              unlinkProjectV2FromRepository(input: {
                projectId: $projectId,
                repositoryId: $repositoryId
              }) {
                repository { id }
              }
            }`,
            { projectId, repositoryId: repoId },
          );
        } else {
          await client.projectMutate(
            `mutation($projectId: ID!, $repositoryId: ID!) {
              linkProjectV2ToRepository(input: {
                projectId: $projectId,
                repositoryId: $repositoryId
              }) {
                repository { id }
              }
            }`,
            { projectId, repositoryId: repoId },
          );
        }

        return toolSuccess({
          repository: `${repoOwner}/${repoName}`,
          linked: !args.unlink,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to ${args.unlink ? "unlink" : "link"} repository: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__clear_field
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__clear_field",
    "Clear a field value on a project item. Works for any single-select field (Workflow State, Estimate, Priority, Status, etc.). Returns: number, field, cleared.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
      number: z.number().describe("Issue number"),
      field: z.string().describe("Field name to clear (e.g., 'Estimate', 'Priority', 'Workflow State')"),
    },
    async (args) => {
      try {
        const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        const projectId = fieldCache.getProjectId();
        if (!projectId) {
          return toolError("Could not resolve project ID");
        }

        const fieldId = fieldCache.getFieldId(args.field);
        if (!fieldId) {
          const validFields = fieldCache.getFieldNames();
          return toolError(
            `Field "${args.field}" not found in project. ` +
            `Valid fields: ${validFields.join(", ")}`,
          );
        }

        const projectItemId = await resolveProjectItemId(
          client,
          fieldCache,
          owner,
          repo,
          args.number,
        );

        await client.projectMutate(
          `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
            clearProjectV2ItemFieldValue(input: {
              projectId: $projectId,
              itemId: $itemId,
              fieldId: $fieldId
            }) {
              projectV2Item { id }
            }
          }`,
          { projectId, itemId: projectItemId, fieldId },
        );

        return toolSuccess({
          number: args.number,
          field: args.field,
          cleared: true,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to clear field: ${message}`);
      }
    },
  );
}
