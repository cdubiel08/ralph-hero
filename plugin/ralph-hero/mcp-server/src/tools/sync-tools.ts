/**
 * MCP tools for cross-project state synchronization.
 *
 * Provides `ralph_hero__sync_across_projects` to propagate Workflow State
 * changes to all GitHub Projects an issue belongs to. Discovers project
 * memberships via the `projectItems` GraphQL field on Issue nodes.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import { toolSuccess, toolError } from "../types.js";
import { resolveIssueNodeId, resolveConfig } from "../lib/helpers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProjectItemFieldValue {
  __typename?: string;
  name?: string;
  field?: { name?: string };
}

interface ProjectItem {
  id: string;
  project: { id: string; number: number };
  fieldValues: { nodes: ProjectItemFieldValue[] };
}

interface ProjectItemsResult {
  node: {
    projectItems?: { nodes: ProjectItem[] };
  } | null;
}

interface FieldMeta {
  id: string;
  name: string;
  options?: Array<{ id: string; name: string }>;
}

interface ProjectFieldMetaResult {
  node: {
    fields?: { nodes: FieldMeta[] };
  } | null;
}

interface SyncResult {
  projectNumber: number;
  reason?: string;
  currentState?: string | null;
  targetState?: string;
  detail?: string;
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// GraphQL queries and mutations
// ---------------------------------------------------------------------------

const SYNC_PROJECT_ITEMS_QUERY = `query($issueId: ID!) {
  node(id: $issueId) {
    ... on Issue {
      projectItems(first: 20) {
        nodes {
          id
          project { id number }
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
}`;

const PROJECT_FIELD_META_QUERY = `query($projectId: ID!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      fields(first: 20) {
        nodes {
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id name }
          }
        }
      }
    }
  }
}`;

const UPDATE_FIELD_MUTATION = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId,
    itemId: $itemId,
    fieldId: $fieldId,
    value: { singleSelectOptionId: $optionId }
  }) {
    projectV2Item { id }
  }
}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch field metadata for a specific project. Returns only SingleSelectField
 * entries (which have id, name, and options). Does not populate FieldOptionCache
 * to avoid polluting the default project cache.
 */
async function fetchProjectFieldMeta(
  client: GitHubClient,
  projectId: string,
): Promise<Array<{ id: string; name: string; options: Array<{ id: string; name: string }> }>> {
  const result = await client.projectQuery<ProjectFieldMetaResult>(
    PROJECT_FIELD_META_QUERY,
    { projectId },
  );
  return (result.node?.fields?.nodes ?? []).filter(
    (f): f is { id: string; name: string; options: Array<{ id: string; name: string }> } =>
      !!f.id && !!f.options,
  );
}

// ---------------------------------------------------------------------------
// Register sync tools
// ---------------------------------------------------------------------------

export function registerSyncTools(
  server: McpServer,
  client: GitHubClient,
  _fieldCache: FieldOptionCache,
): void {
  server.tool(
    "ralph_hero__sync_across_projects",
    "Propagate a Workflow State change to all GitHub Projects an issue belongs to. " +
      "Queries projectItems to find all project memberships, applies the target state " +
      "to projects where current state differs. Idempotent: skips projects already at " +
      "target state. Returns: list of projects synced and skipped with reasons.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
      number: z.number().describe("Issue number to sync"),
      workflowState: z
        .string()
        .describe('Target Workflow State to propagate (e.g., "In Progress")'),
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, return affected projects without mutating (default: false)"),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);

        // 1. Resolve issue node ID
        const issueNodeId = await resolveIssueNodeId(client, owner, repo, args.number);

        // 2. Fetch all project memberships + current Workflow State
        const projectItemsResult = await client.projectQuery<ProjectItemsResult>(
          SYNC_PROJECT_ITEMS_QUERY,
          { issueId: issueNodeId },
        );
        const projectItems = projectItemsResult.node?.projectItems?.nodes ?? [];

        if (!projectItems.length) {
          return toolSuccess({
            number: args.number,
            message: "Issue is not a member of any GitHub Project",
            synced: [],
            skipped: [],
          });
        }

        const synced: SyncResult[] = [];
        const skipped: SyncResult[] = [];

        for (const item of projectItems) {
          const projectId = item.project.id;
          const projectNumber = item.project.number;

          // Extract current Workflow State from fieldValues
          const currentState =
            item.fieldValues.nodes.find(
              (fv) =>
                fv.__typename === "ProjectV2ItemFieldSingleSelectValue" &&
                fv.field?.name === "Workflow State",
            )?.name ?? null;

          // Idempotency: skip if already at target state
          if (currentState === args.workflowState) {
            skipped.push({
              projectNumber,
              reason: "already_at_target_state",
              currentState,
            });
            continue;
          }

          if (args.dryRun) {
            synced.push({
              projectNumber,
              currentState,
              targetState: args.workflowState,
              dryRun: true,
            });
            continue;
          }

          // Fetch field IDs for this project
          const fieldMeta = await fetchProjectFieldMeta(client, projectId);
          const wfField = fieldMeta.find((f) => f.name === "Workflow State");

          if (!wfField) {
            skipped.push({
              projectNumber,
              reason: "no_workflow_state_field",
              currentState,
            });
            continue;
          }

          const targetOption = wfField.options.find(
            (o) => o.name === args.workflowState,
          );
          if (!targetOption) {
            skipped.push({
              projectNumber,
              reason: "invalid_option",
              currentState,
              detail: `"${args.workflowState}" not found. Valid: ${wfField.options.map((o) => o.name).join(", ")}`,
            });
            continue;
          }

          // Apply the update
          await client.projectMutate(UPDATE_FIELD_MUTATION, {
            projectId,
            itemId: item.id,
            fieldId: wfField.id,
            optionId: targetOption.id,
          });

          synced.push({
            projectNumber,
            currentState,
            targetState: args.workflowState,
          });
        }

        return toolSuccess({
          number: args.number,
          workflowState: args.workflowState,
          dryRun: args.dryRun,
          syncedCount: synced.length,
          skippedCount: skipped.length,
          synced,
          skipped,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to sync across projects: ${message}`);
      }
    },
  );
}
