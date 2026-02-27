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
import { paginateConnection } from "../lib/pagination.js";
import { buildBatchArchiveMutation } from "./batch-tools.js";
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
  // ralph_hero__remove_from_project
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__remove_from_project",
    "Remove an item from the project. This deletes the project item (not the issue itself). Accepts either number (for issues) or projectItemId (for draft items). WARNING: For draft issues, this permanently destroys the draft content — there is no undo. Returns: number, removed, projectItemId.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
      number: z.coerce.number().optional().describe("Issue number (provide this or projectItemId)"),
      projectItemId: z.string().optional()
        .describe("Project item node ID (PVTI_...) — use instead of number for draft items"),
    },
    async (args) => {
      try {
        if (!args.number && !args.projectItemId) {
          return toolError("Either number or projectItemId must be provided");
        }
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

        await client.projectMutate(
          `mutation($projectId: ID!, $itemId: ID!) {
            deleteProjectV2Item(input: {
              projectId: $projectId,
              itemId: $itemId
            }) {
              deletedItemId
            }
          }`,
          { projectId, itemId },
        );

        // Invalidate cached project item ID since it no longer exists
        if (args.number) {
          client.getCache().invalidate(
            `project-item-id:${owner}/${repo}#${args.number}`,
          );
        }

        return toolSuccess({
          number: args.number ?? null,
          removed: true,
          projectItemId: itemId,
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
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
      number: z.coerce.number().describe("Issue number"),
    },
    async (args) => {
      try {
        const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        const projectId = fieldCache.getProjectId(projectNumber);
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
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
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

        const projectId = fieldCache.getProjectId(projectNumber);
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
  // ralph_hero__create_draft_issue
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__create_draft_issue",
    "Create a draft issue in the project (no repo required). Optionally set workflow state, priority, and estimate after creation. Returns: projectItemId, title, fieldsSet.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
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

        const projectId = fieldCache.getProjectId(projectNumber);
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
          await updateProjectItemField(client, fieldCache, projectItemId, "Workflow State", args.workflowState, projectNumber);
          fieldsSet.push("Workflow State");
        }
        if (args.priority) {
          await updateProjectItemField(client, fieldCache, projectItemId, "Priority", args.priority, projectNumber);
          fieldsSet.push("Priority");
        }
        if (args.estimate) {
          await updateProjectItemField(client, fieldCache, projectItemId, "Estimate", args.estimate, projectNumber);
          fieldsSet.push("Estimate");
        }

        // Fetch the DI_ content node ID so callers can use update_draft_issue
        let draftIssueId: string | null = null;
        try {
          const itemResult = await client.projectQuery<{
            node: {
              content: { id: string } | null;
            } | null;
          }>(
            `query($itemId: ID!) {
              node(id: $itemId) {
                ... on ProjectV2Item {
                  content {
                    ... on DraftIssue { id }
                  }
                }
              }
            }`,
            { itemId: projectItemId },
          );
          draftIssueId = itemResult.node?.content?.id ?? null;
        } catch {
          // Best-effort: if the query fails, return without draftIssueId
        }

        return toolSuccess({
          projectItemId,
          draftIssueId,
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
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
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
              draftIssue { id title }
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
  // ralph_hero__convert_draft_issue
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__convert_draft_issue",
    "Convert a draft issue to a real repository issue. Requires the project item ID (PVTI_...) returned by create_draft_issue. CAVEAT: This mutation fails with fine-grained PATs (known GitHub bug, unresolved as of early 2026). Use a classic PAT with repo+project scopes. Returns: projectItemId, converted.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
      projectItemId: z.string().describe("Project item node ID (PVTI_...) of the draft issue"),
      repositoryId: z.string().optional()
        .describe("Repository node ID (R_...). Auto-fetched from configured repo if omitted"),
    },
    async (args) => {
      try {
        const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        // Resolve repository node ID if not provided
        let repoId = args.repositoryId;
        if (!repoId) {
          const repoResult = await client.query<{
            repository: { id: string } | null;
          }>(
            `query($repoOwner: String!, $repoName: String!) {
              repository(owner: $repoOwner, name: $repoName) { id }
            }`,
            { repoOwner: owner, repoName: repo },
            { cache: true, cacheTtlMs: 60 * 60 * 1000 },
          );

          repoId = repoResult.repository?.id;
          if (!repoId) {
            return toolError(`Repository ${owner}/${repo} not found`);
          }
        }

        await client.projectMutate(
          `mutation($itemId: ID!, $repositoryId: ID!) {
            convertProjectV2DraftIssueItemToIssue(input: {
              itemId: $itemId,
              repositoryId: $repositoryId
            }) {
              item { id }
            }
          }`,
          { itemId: args.projectItemId, repositoryId: repoId },
        );

        return toolSuccess({
          projectItemId: args.projectItemId,
          converted: true,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to convert draft issue: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__get_draft_issue
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__get_draft_issue",
    "Get the full content of one or more draft issues. Accepts DI_ (content node) or PVTI_ (project item) IDs — auto-detected by prefix. PVTI_ IDs also return project field values. Returns: array of { draftIssueId, projectItemId, title, body, creator, createdAt, updatedAt, workflowState?, estimate?, priority? }.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
      ids: z.union([
        z.string().describe("Single draft issue ID (DI_... or PVTI_...)"),
        z.array(z.string()).describe("Array of draft issue IDs"),
      ]).describe("One or more draft issue IDs. DI_ prefix fetches content only. PVTI_ prefix also fetches project field values."),
    },
    async (args) => {
      try {
        const idList = Array.isArray(args.ids) ? args.ids : [args.ids];

        if (idList.length === 0) {
          return toolError("At least one ID must be provided");
        }

        // Validate all IDs have valid prefixes
        const invalidIds = idList.filter(
          (id) => !id.startsWith("DI_") && !id.startsWith("PVTI_"),
        );
        if (invalidIds.length > 0) {
          return toolError(
            `Invalid ID prefix(es): ${invalidIds.join(", ")}. IDs must start with DI_ or PVTI_.`,
          );
        }

        // Partition into DI_ and PVTI_ groups
        const diIds: { id: string; index: number }[] = [];
        const pvtiIds: { id: string; index: number }[] = [];
        for (let i = 0; i < idList.length; i++) {
          if (idList[i].startsWith("DI_")) {
            diIds.push({ id: idList[i], index: i });
          } else {
            pvtiIds.push({ id: idList[i], index: i });
          }
        }

        // Build aliased GraphQL query
        const queryParts: string[] = [];
        const variables: Record<string, string> = {};
        const variableDecls: string[] = [];

        for (let i = 0; i < diIds.length; i++) {
          const varName = `diId${i}`;
          variableDecls.push(`$${varName}: ID!`);
          variables[varName] = diIds[i].id;
          queryParts.push(`
            draft${i}: node(id: $${varName}) {
              ... on DraftIssue {
                id
                title
                body
                creator { login }
                createdAt
                updatedAt
              }
            }
          `);
        }

        for (let i = 0; i < pvtiIds.length; i++) {
          const varName = `pvtiId${i}`;
          variableDecls.push(`$${varName}: ID!`);
          variables[varName] = pvtiIds[i].id;
          queryParts.push(`
            item${i}: node(id: $${varName}) {
              ... on ProjectV2Item {
                id
                content {
                  ... on DraftIssue {
                    id
                    title
                    body
                    creator { login }
                    createdAt
                    updatedAt
                  }
                }
                fieldValues(first: 20) {
                  nodes {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      field { ... on ProjectV2FieldCommon { name } }
                    }
                  }
                }
              }
            }
          `);
        }

        const fullQuery = `query(${variableDecls.join(", ")}) {\n${queryParts.join("\n")}\n}`;

        const result = await client.projectQuery<Record<string, unknown>>(
          fullQuery,
          variables,
        );

        // Map results into uniform response array
        type DraftResult = {
          draftIssueId: string;
          projectItemId: string | null;
          title: string;
          body: string | null;
          creator: string | null;
          createdAt: string | null;
          updatedAt: string | null;
          workflowState?: string;
          estimate?: string;
          priority?: string;
          error?: string;
        };

        const drafts: (DraftResult | { id: string; error: string })[] = [];

        // Process DI_ results
        for (let i = 0; i < diIds.length; i++) {
          const node = result[`draft${i}`] as {
            id?: string;
            title?: string;
            body?: string;
            creator?: { login: string };
            createdAt?: string;
            updatedAt?: string;
          } | null;

          if (!node || !node.id) {
            drafts.push({ id: diIds[i].id, error: "Not found" });
          } else {
            drafts.push({
              draftIssueId: node.id,
              projectItemId: null,
              title: node.title ?? "",
              body: node.body ?? null,
              creator: node.creator?.login ?? null,
              createdAt: node.createdAt ?? null,
              updatedAt: node.updatedAt ?? null,
            });
          }
        }

        // Process PVTI_ results
        for (let i = 0; i < pvtiIds.length; i++) {
          const node = result[`item${i}`] as {
            id?: string;
            content?: {
              id?: string;
              title?: string;
              body?: string;
              creator?: { login: string };
              createdAt?: string;
              updatedAt?: string;
            } | null;
            fieldValues?: {
              nodes: Array<{
                name?: string;
                field?: { name?: string };
              }>;
            };
          } | null;

          if (!node || !node.id) {
            drafts.push({ id: pvtiIds[i].id, error: "Not found" });
          } else if (!node.content || !node.content.id) {
            drafts.push({ id: pvtiIds[i].id, error: "Not a draft issue" });
          } else {
            // Extract field values
            let workflowState: string | undefined;
            let estimate: string | undefined;
            let priority: string | undefined;

            if (node.fieldValues?.nodes) {
              for (const fv of node.fieldValues.nodes) {
                const fieldName = fv.field?.name;
                if (fieldName === "Workflow State") workflowState = fv.name;
                else if (fieldName === "Estimate") estimate = fv.name;
                else if (fieldName === "Priority") priority = fv.name;
              }
            }

            drafts.push({
              draftIssueId: node.content.id,
              projectItemId: pvtiIds[i].id,
              title: node.content.title ?? "",
              body: node.content.body ?? null,
              creator: node.content.creator?.login ?? null,
              createdAt: node.content.createdAt ?? null,
              updatedAt: node.content.updatedAt ?? null,
              ...(workflowState !== undefined && { workflowState }),
              ...(estimate !== undefined && { estimate }),
              ...(priority !== undefined && { priority }),
            });
          }
        }

        return toolSuccess({ drafts });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to get draft issue(s): ${message}`);
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
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
      number: z.coerce.number().describe("Issue number to reposition"),
      afterNumber: z.coerce.number().optional()
        .describe("Issue number to place after; omit to move to top"),
    },
    async (args) => {
      try {
        const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        const projectId = fieldCache.getProjectId(projectNumber);
        if (!projectId) {
          return toolError("Could not resolve project ID");
        }

        const itemId = await resolveProjectItemId(
          client,
          fieldCache,
          owner,
          repo,
          args.number,
          projectNumber,
        );

        let afterId: string | undefined;
        if (args.afterNumber !== undefined) {
          afterId = await resolveProjectItemId(
            client,
            fieldCache,
            owner,
            repo,
            args.afterNumber,
            projectNumber,
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
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
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

        const projectId = fieldCache.getProjectId(projectNumber);
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
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
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

        const projectId = fieldCache.getProjectId(projectNumber);
        if (!projectId) {
          return toolError("Could not resolve project ID");
        }

        const fieldId = fieldCache.getFieldId(args.field, projectNumber);
        if (!fieldId) {
          const validFields = fieldCache.getFieldNames(projectNumber);
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
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
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

        const projectId = fieldCache.getProjectId(projectNumber);
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
  // ralph_hero__update_status_update
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__update_status_update",
    "Update an existing project status update. Modify body, status designation, or dates. Returns: id, status, body, startDate, targetDate, updatedAt.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
      statusUpdateId: z.string().describe("Node ID of the status update to modify"),
      status: z.enum(["ON_TRACK", "AT_RISK", "OFF_TRACK", "INACTIVE", "COMPLETE"]).optional()
        .describe("Updated project health designation"),
      body: z.string().optional().describe("Updated body (markdown)"),
      startDate: z.string().optional().describe("Updated start date (YYYY-MM-DD)"),
      targetDate: z.string().optional().describe("Updated target date (YYYY-MM-DD)"),
    },
    async (args) => {
      try {
        if (
          args.status === undefined &&
          args.body === undefined &&
          args.startDate === undefined &&
          args.targetDate === undefined
        ) {
          return toolError(
            "At least one field to update is required (status, body, startDate, targetDate)",
          );
        }

        const { projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        const vars: Record<string, unknown> = {
          statusUpdateId: args.statusUpdateId,
        };
        if (args.status !== undefined) vars.statusValue = args.status;
        if (args.body !== undefined) vars.body = args.body;
        if (args.startDate !== undefined) vars.startDate = args.startDate;
        if (args.targetDate !== undefined) vars.targetDate = args.targetDate;

        const result = await client.projectMutate<{
          updateProjectV2StatusUpdate: {
            statusUpdate: {
              id: string;
              status: string;
              body: string | null;
              startDate: string | null;
              targetDate: string | null;
              updatedAt: string;
            };
          };
        }>(
          `mutation($statusUpdateId: ID!, $statusValue: ProjectV2StatusUpdateStatus, $body: String, $startDate: Date, $targetDate: Date) {
            updateProjectV2StatusUpdate(input: {
              statusUpdateId: $statusUpdateId,
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
                updatedAt
              }
            }
          }`,
          vars,
        );

        const su = result.updateProjectV2StatusUpdate.statusUpdate;
        return toolSuccess({
          id: su.id,
          status: su.status,
          body: su.body,
          startDate: su.startDate,
          targetDate: su.targetDate,
          updatedAt: su.updatedAt,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to update status update: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__delete_status_update
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__delete_status_update",
    "Delete a project status update. This action cannot be undone. Returns: deletedStatusUpdateId.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
      statusUpdateId: z.string().describe("Node ID of the status update to delete"),
    },
    async (args) => {
      try {
        const { projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        const result = await client.projectMutate<{
          deleteProjectV2StatusUpdate: {
            deletedStatusUpdateId: string;
          };
        }>(
          `mutation($statusUpdateId: ID!) {
            deleteProjectV2StatusUpdate(input: {
              statusUpdateId: $statusUpdateId
            }) {
              deletedStatusUpdateId
            }
          }`,
          { statusUpdateId: args.statusUpdateId },
        );

        return toolSuccess({
          deletedStatusUpdateId:
            result.deleteProjectV2StatusUpdate.deletedStatusUpdateId,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to delete status update: ${message}`);
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
      unarchive: z.boolean().optional().default(false)
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
      dryRun: z
        .boolean()
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

        // Query project items with field values
        const itemsResult = await paginateConnection<RawBulkArchiveItem>(
          (q, v) => client.projectQuery(q, v),
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
          { projectId, first: 100 },
          "node.items",
          { maxItems: effectiveMax * 3 },
        );

        // Validate updatedBefore if provided
        let updatedBeforeCutoff: number | undefined;
        if (args.updatedBefore) {
          updatedBeforeCutoff = new Date(args.updatedBefore).getTime();
          if (isNaN(updatedBeforeCutoff)) {
            return toolError(
              "Invalid updatedBefore date. Use ISO 8601 format (e.g., 2026-02-01T00:00:00Z)",
            );
          }
        }

        // Filter by workflow state and optional date
        const matched = itemsResult.nodes
          .filter((item) => {
            const ws = getBulkArchiveFieldValue(item, "Workflow State");
            return ws && args.workflowStates!.includes(ws);
          })
          .filter((item) => {
            if (!updatedBeforeCutoff) return true;
            if (!item.content?.updatedAt) return false;
            return new Date(item.content.updatedAt).getTime() < updatedBeforeCutoff;
          })
          .slice(0, effectiveMax);

        if (matched.length === 0) {
          return toolSuccess({
            dryRun: args.dryRun,
            archivedCount: 0,
            wouldArchive: 0,
            items: [],
            errors: [],
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
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to bulk archive: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__link_team
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__link_team",
    "Link or unlink a project from a GitHub team. Makes the project visible on the team's Projects page (org-owned projects only). Distinct from update_collaborators which controls access roles. Returns: team, linked.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
      teamSlug: z.string().describe("Team slug (e.g., 'engineering')"),
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

        const projectId = fieldCache.getProjectId(projectNumber);
        if (!projectId) {
          return toolError("Could not resolve project ID");
        }

        // Resolve team slug to node ID via organization query
        const teamResult = await client.query<{
          organization: { team: { id: string } | null } | null;
        }>(
          `query($org: String!, $slug: String!) {
            organization(login: $org) {
              team(slug: $slug) { id }
            }
          }`,
          { org: projectOwner, slug: args.teamSlug },
          { cache: true, cacheTtlMs: 60 * 60 * 1000 },
        );

        if (!teamResult.organization) {
          return toolError(
            `Team linking requires an organization-owned project. ` +
            `"${projectOwner}" is not an organization.`,
          );
        }
        if (!teamResult.organization.team) {
          return toolError(
            `Team "${args.teamSlug}" not found in organization "${projectOwner}"`,
          );
        }

        const teamId = teamResult.organization.team.id;

        if (args.unlink) {
          await client.projectMutate(
            `mutation($projectId: ID!, $teamId: ID!) {
              unlinkProjectV2FromTeam(input: {
                projectId: $projectId,
                teamId: $teamId
              }) {
                team { id }
              }
            }`,
            { projectId, teamId },
          );
        } else {
          await client.projectMutate(
            `mutation($projectId: ID!, $teamId: ID!) {
              linkProjectV2ToTeam(input: {
                projectId: $projectId,
                teamId: $teamId
              }) {
                team { id }
              }
            }`,
            { projectId, teamId },
          );
        }

        return toolSuccess({
          team: args.teamSlug,
          linked: !args.unlink,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to ${args.unlink ? "unlink" : "link"} team: ${message}`);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Internal types for bulk_archive
// ---------------------------------------------------------------------------

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
