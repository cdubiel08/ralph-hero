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
  updateProjectItemField,
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

  // -------------------------------------------------------------------------
  // ralph_hero__create_draft_issue
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__create_draft_issue",
    "Create a draft issue in the project (no repo required). Optionally set workflow state, priority, and estimate after creation. Returns: projectItemId, title, fieldsSet.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
      title: z.string().describe("Draft issue title"),
      body: z.string().optional().describe("Draft issue body (markdown)"),
      workflowState: z.string().optional().describe("Workflow state to set after creation"),
      priority: z.string().optional().describe("Priority to set after creation"),
      estimate: z.string().optional().describe("Estimate to set after creation"),
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

        const result = await client.projectMutate<{
          addProjectV2DraftIssue: {
            projectItem: { id: string };
          };
        }>(
          `mutation($projectId: ID!, $title: String!, $body: String) {
            addProjectV2DraftIssue(input: {
              projectId: $projectId,
              title: $title,
              body: $body
            }) {
              projectItem { id }
            }
          }`,
          { projectId, title: args.title, body: args.body },
        );

        const projectItemId = result.addProjectV2DraftIssue.projectItem.id;
        const fieldsSet: string[] = [];

        if (args.workflowState) {
          await updateProjectItemField(client, fieldCache, projectItemId, "Workflow State", args.workflowState);
          fieldsSet.push("Workflow State");
        }
        if (args.priority) {
          await updateProjectItemField(client, fieldCache, projectItemId, "Priority", args.priority);
          fieldsSet.push("Priority");
        }
        if (args.estimate) {
          await updateProjectItemField(client, fieldCache, projectItemId, "Estimate", args.estimate);
          fieldsSet.push("Estimate");
        }

        return toolSuccess({
          projectItemId,
          title: args.title,
          fieldsSet,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to create draft issue: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__update_draft_issue
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__update_draft_issue",
    "Update title and/or body of an existing draft issue. Requires the draft issue content node ID (DI_...), not the project item ID. Returns: draftIssueId, updated.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
      draftIssueId: z.string().describe("Draft issue content node ID (DI_...)"),
      title: z.string().optional().describe("New title"),
      body: z.string().optional().describe("New body (markdown)"),
    },
    async (args) => {
      try {
        if (!args.title && args.body === undefined) {
          return toolError("At least one of title or body must be provided");
        }

        const { projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        const vars: Record<string, unknown> = { draftIssueId: args.draftIssueId };
        if (args.title !== undefined) vars.title = args.title;
        if (args.body !== undefined) vars.body = args.body;

        await client.projectMutate(
          `mutation($draftIssueId: ID!, $title: String, $body: String) {
            updateProjectV2DraftIssue(input: {
              draftIssueId: $draftIssueId,
              title: $title,
              body: $body
            }) {
              projectItem { id }
            }
          }`,
          vars,
        );

        return toolSuccess({
          draftIssueId: args.draftIssueId,
          updated: true,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to update draft issue: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__reorder_item
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__reorder_item",
    "Set item position within project views. Moves an issue before or after another item. Omit afterNumber to move to the top. Returns: number, position.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
      number: z.number().describe("Issue number to reposition"),
      afterNumber: z.number().optional()
        .describe("Issue number to place after; omit to move to top"),
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

        const itemId = await resolveProjectItemId(
          client,
          fieldCache,
          owner,
          repo,
          args.number,
        );

        let afterId: string | undefined;
        if (args.afterNumber !== undefined) {
          afterId = await resolveProjectItemId(
            client,
            fieldCache,
            owner,
            repo,
            args.afterNumber,
          );
        }

        await client.projectMutate(
          `mutation($projectId: ID!, $itemId: ID!, $afterId: ID) {
            updateProjectV2ItemPosition(input: {
              projectId: $projectId,
              itemId: $itemId,
              afterId: $afterId
            }) {
              items(first: 1) { nodes { id } }
            }
          }`,
          { projectId, itemId, afterId: afterId ?? null },
        );

        return toolSuccess({
          number: args.number,
          position: args.afterNumber ? `after #${args.afterNumber}` : "top",
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to reorder item: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__update_project
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__update_project",
    "Update project settings — title, description, README, visibility, open/closed state. At least one field must be provided. Returns: projectId, updated, fields.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
      title: z.string().optional().describe("New project title"),
      shortDescription: z.string().optional().describe("Short summary for listings"),
      readme: z.string().optional().describe("Full README in markdown"),
      public: z.boolean().optional().describe("Visibility (true=public, false=private)"),
      closed: z.boolean().optional().describe("Close (true) or reopen (false) the project"),
    },
    async (args) => {
      try {
        const updatedFields: string[] = [];
        const vars: Record<string, unknown> = {};
        const varDefs: string[] = ["$projectId: ID!"];
        const inputFields: string[] = ["projectId: $projectId"];

        if (args.title !== undefined) {
          vars.updateTitle = args.title;
          varDefs.push("$updateTitle: String");
          inputFields.push("title: $updateTitle");
          updatedFields.push("title");
        }
        if (args.shortDescription !== undefined) {
          vars.shortDescription = args.shortDescription;
          varDefs.push("$shortDescription: String");
          inputFields.push("shortDescription: $shortDescription");
          updatedFields.push("shortDescription");
        }
        if (args.readme !== undefined) {
          vars.updateReadme = args.readme;
          varDefs.push("$updateReadme: String");
          inputFields.push("readme: $updateReadme");
          updatedFields.push("readme");
        }
        if (args.public !== undefined) {
          vars.publicVisibility = args.public;
          varDefs.push("$publicVisibility: Boolean");
          inputFields.push("public: $publicVisibility");
          updatedFields.push("public");
        }
        if (args.closed !== undefined) {
          vars.closedState = args.closed;
          varDefs.push("$closedState: Boolean");
          inputFields.push("closed: $closedState");
          updatedFields.push("closed");
        }

        if (updatedFields.length === 0) {
          return toolError("At least one field to update must be provided");
        }

        const { projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        const projectId = fieldCache.getProjectId();
        if (!projectId) {
          return toolError("Could not resolve project ID");
        }

        vars.projectId = projectId;

        await client.projectMutate(
          `mutation(${varDefs.join(", ")}) {
            updateProjectV2(input: {
              ${inputFields.join(",\n              ")}
            }) {
              projectV2 { id title }
            }
          }`,
          vars,
        );

        return toolSuccess({
          projectId,
          updated: true,
          fields: updatedFields,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to update project: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__delete_field
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__delete_field",
    "Delete a custom field from the project. Refuses to delete Ralph's required fields (Workflow State, Priority, Estimate, Status). Defaults to dry-run; set confirm=true to execute. Returns: field, deleted or action.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
      field: z.string().describe("Name of the field to delete"),
      confirm: z.boolean().optional().default(false)
        .describe("Must be true to execute deletion; false for dry-run"),
    },
    async (args) => {
      try {
        if (PROTECTED_FIELDS.includes(args.field)) {
          return toolError(
            `Cannot delete protected field "${args.field}". ` +
            `Protected fields: ${PROTECTED_FIELDS.join(", ")}`,
          );
        }

        const { projectNumber, projectOwner } = resolveFullConfig(
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

        if (!args.confirm) {
          return toolSuccess({
            field: args.field,
            fieldId,
            action: "would_delete",
            confirm: false,
            message: "Dry run. Set confirm=true to delete.",
          });
        }

        await client.projectMutate(
          `mutation($projectId: ID!, $fieldId: ID!) {
            deleteProjectV2Field(input: {
              projectId: $projectId,
              fieldId: $fieldId
            }) {
              projectV2Field {
                ... on ProjectV2SingleSelectField { id name }
                ... on ProjectV2Field { id name }
              }
            }
          }`,
          { projectId, fieldId },
        );

        // Invalidate field cache since a field definition was removed
        fieldCache.clear();

        return toolSuccess({
          field: args.field,
          deleted: true,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to delete field: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__update_collaborators
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__update_collaborators",
    "Manage project collaborator access — add, update, or remove users/teams. Each entry needs exactly one of username or teamSlug. Team collaborators require an org-owned project. Returns: updated, collaboratorCount.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
      collaborators: z.array(z.object({
        username: z.string().optional().describe("GitHub username"),
        teamSlug: z.string().optional().describe("Team slug (org projects only)"),
        role: z.enum(["READER", "WRITER", "ADMIN", "NONE"])
          .describe("Permission level (NONE removes access)"),
      })).describe("List of collaborator changes"),
    },
    async (args) => {
      try {
        if (args.collaborators.length === 0) {
          return toolError("At least one collaborator entry must be provided");
        }

        const { projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        const projectId = fieldCache.getProjectId();
        if (!projectId) {
          return toolError("Could not resolve project ID");
        }

        const resolvedCollaborators: Array<{
          userId?: string;
          teamId?: string;
          role: string;
        }> = [];

        for (const entry of args.collaborators) {
          if (entry.username && entry.teamSlug) {
            return toolError(
              `Collaborator entry has both username ("${entry.username}") and ` +
              `teamSlug ("${entry.teamSlug}"). Provide exactly one.`,
            );
          }
          if (!entry.username && !entry.teamSlug) {
            return toolError(
              "Collaborator entry must have either username or teamSlug",
            );
          }

          if (entry.username) {
            const userResult = await client.query<{
              user: { id: string } | null;
            }>(
              `query($login: String!) { user(login: $login) { id } }`,
              { login: entry.username },
              { cache: true, cacheTtlMs: 60 * 60 * 1000 },
            );
            if (!userResult.user) {
              return toolError(`User "${entry.username}" not found`);
            }
            resolvedCollaborators.push({
              userId: userResult.user.id,
              role: entry.role,
            });
          } else if (entry.teamSlug) {
            const teamResult = await client.query<{
              organization: { team: { id: string } | null } | null;
            }>(
              `query($org: String!, $slug: String!) {
                organization(login: $org) {
                  team(slug: $slug) { id }
                }
              }`,
              { org: projectOwner, slug: entry.teamSlug },
              { cache: true, cacheTtlMs: 60 * 60 * 1000 },
            );
            if (!teamResult.organization) {
              return toolError(
                `Team collaborators require an organization-owned project. ` +
                `"${projectOwner}" is not an organization.`,
              );
            }
            if (!teamResult.organization.team) {
              return toolError(
                `Team "${entry.teamSlug}" not found in organization "${projectOwner}"`,
              );
            }
            resolvedCollaborators.push({
              teamId: teamResult.organization.team.id,
              role: entry.role,
            });
          }
        }

        await client.projectMutate(
          `mutation($projectId: ID!, $collaborators: [ProjectV2Collaborator!]!) {
            updateProjectV2Collaborators(input: {
              projectId: $projectId,
              collaborators: $collaborators
            }) {
              collaborators { totalCount }
            }
          }`,
          { projectId, collaborators: resolvedCollaborators },
        );

        return toolSuccess({
          updated: true,
          collaboratorCount: args.collaborators.length,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to update collaborators: ${message}`);
      }
    },
  );
}
