/**
 * MCP tools for GitHub Projects V2 management.
 *
 * Provides tools for creating projects with custom fields,
 * querying project details, and listing/filtering project items.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import { paginateConnection } from "../lib/pagination.js";
import { parseDateMath } from "../lib/date-math.js";
import { toolSuccess, toolError } from "../types.js";
import type {
  ProjectV2,
  ProjectV2Item,
  ProjectV2ItemFieldSingleSelectValue,
  ProjectV2FieldUnion,
  ProjectV2SingleSelectField,
} from "../types.js";
import { resolveProjectOwner } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

interface FieldOption {
  name: string;
  color: string;
  description: string;
}

const WORKFLOW_STATE_OPTIONS: FieldOption[] = [
  { name: "Backlog", color: "GRAY", description: "Awaiting triage" },
  {
    name: "Research Needed",
    color: "PURPLE",
    description: "Needs investigation before planning",
  },
  {
    name: "Research in Progress",
    color: "PURPLE",
    description: "Investigation underway (locked)",
  },
  {
    name: "Ready for Plan",
    color: "BLUE",
    description: "Research complete, ready for planning",
  },
  {
    name: "Plan in Progress",
    color: "BLUE",
    description: "Plan being written (locked)",
  },
  {
    name: "Plan in Review",
    color: "BLUE",
    description: "Plan awaiting approval",
  },
  {
    name: "In Progress",
    color: "ORANGE",
    description: "Implementation underway",
  },
  {
    name: "In Review",
    color: "YELLOW",
    description: "PR created, awaiting code review",
  },
  { name: "Done", color: "GREEN", description: "Completed and merged" },
  {
    name: "Human Needed",
    color: "RED",
    description: "Escalated - requires human intervention",
  },
  {
    name: "Canceled",
    color: "GRAY",
    description: "Ticket canceled or superseded",
  },
];

const PRIORITY_OPTIONS: FieldOption[] = [
  {
    name: "P0",
    color: "RED",
    description: "Critical - Drop everything, fix now",
  },
  { name: "P1", color: "ORANGE", description: "High - Must do this sprint" },
  { name: "P2", color: "YELLOW", description: "Medium - Should do soon" },
  { name: "P3", color: "GRAY", description: "Low - Nice to have" },
];

const ESTIMATE_OPTIONS: FieldOption[] = [
  { name: "XS", color: "BLUE", description: "Extra Small (1)" },
  { name: "S", color: "GREEN", description: "Small (2)" },
  { name: "M", color: "YELLOW", description: "Medium (3)" },
  { name: "L", color: "ORANGE", description: "Large (4)" },
  { name: "XL", color: "RED", description: "Extra Large (5)" },
];

// ---------------------------------------------------------------------------
// Helper: Ensure field option cache is populated
// ---------------------------------------------------------------------------

async function ensureFieldCache(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  owner: string,
  projectNumber: number,
): Promise<void> {
  if (fieldCache.isPopulated()) return;

  const project = await fetchProject(client, owner, projectNumber);
  if (!project) {
    throw new Error(`Project #${projectNumber} not found for owner "${owner}"`);
  }

  populateFieldCache(fieldCache, project);
}

interface ProjectResponse {
  id: string;
  title: string;
  number: number;
  url: string;
  fields: {
    nodes: Array<{
      id: string;
      name: string;
      dataType: string;
      options?: Array<{
        id: string;
        name: string;
        color?: string;
        description?: string;
      }>;
    }>;
  };
}

function populateFieldCache(
  fieldCache: FieldOptionCache,
  project: ProjectResponse,
): void {
  fieldCache.populate(
    project.id,
    project.fields.nodes.map((f) => ({
      id: f.id,
      name: f.name,
      options: f.options,
    })),
  );
}

// ---------------------------------------------------------------------------
// Register project tools
// ---------------------------------------------------------------------------

export function registerProjectTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  // -------------------------------------------------------------------------
  // ralph_hero__setup_project
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__setup_project",
    "Create a new GitHub Project V2 with Workflow State, Priority, and Estimate custom fields",
    {
      owner: z.string().describe("GitHub owner (user or org)"),
      title: z.string().describe("Project title").default("Ralph Workflow"),
    },
    async (args) => {
      try {
        const owner = args.owner || resolveProjectOwner(client.config);
        if (!owner) {
          return toolError(
            "owner is required (set RALPH_GH_PROJECT_OWNER or RALPH_GH_OWNER env var or pass explicitly)",
          );
        }

        // Step 1: Get owner node ID (try user first, then org)
        let ownerId: string | undefined;

        try {
          const userResult = await client.query<{
            user: { id: string } | null;
          }>(
            `query($login: String!) {
              user(login: $login) { id }
            }`,
            { login: owner },
            { cache: true },
          );
          ownerId = userResult.user?.id;
        } catch {
          // Not a user, try org below
        }

        if (!ownerId) {
          try {
            const orgResult = await client.query<{
              organization: { id: string } | null;
            }>(
              `query($login: String!) {
                organization(login: $login) { id }
              }`,
              { login: owner },
              { cache: true },
            );
            ownerId = orgResult.organization?.id;
          } catch {
            // Not an org either
          }
        }

        if (!ownerId) {
          return toolError(
            `Owner "${owner}" not found as user or organization`,
          );
        }

        // Step 2: Create project (project operation)
        const createResult = await client.projectMutate<{
          createProjectV2: {
            projectV2: {
              id: string;
              number: number;
              url: string;
              title: string;
            };
          };
        }>(
          `mutation($ownerId: ID!, $title: String!) {
            createProjectV2(input: { ownerId: $ownerId, title: $title }) {
              projectV2 {
                id
                number
                url
                title
              }
            }
          }`,
          { ownerId, title: args.title },
        );

        const project = createResult.createProjectV2.projectV2;

        // Step 3: Create custom fields
        const fieldResults: Record<string, { id: string; options: string[] }> =
          {};

        // Workflow State field
        const wsField = await createSingleSelectField(
          client,
          project.id,
          "Workflow State",
          WORKFLOW_STATE_OPTIONS,
        );
        fieldResults["Workflow State"] = wsField;

        // Priority field
        const prioField = await createSingleSelectField(
          client,
          project.id,
          "Priority",
          PRIORITY_OPTIONS,
        );
        fieldResults["Priority"] = prioField;

        // Estimate field
        const estField = await createSingleSelectField(
          client,
          project.id,
          "Estimate",
          ESTIMATE_OPTIONS,
        );
        fieldResults["Estimate"] = estField;

        // Populate the field cache for this project
        await ensureFieldCacheForNewProject(
          client,
          fieldCache,
          owner,
          project.number,
        );

        return toolSuccess({
          project: {
            id: project.id,
            number: project.number,
            url: project.url,
            title: project.title,
          },
          fields: fieldResults,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to set up project: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__get_project
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__get_project",
    "Get a GitHub Project V2 with all fields and their options",
    {
      owner: z
        .string()
        .optional()
        .describe(
          "GitHub owner (user or org). Defaults to GITHUB_OWNER env var",
        ),
      number: z
        .number()
        .optional()
        .describe(
          "Project number. Defaults to RALPH_GH_PROJECT_NUMBER env var",
        ),
    },
    async (args) => {
      try {
        const owner = args.owner || resolveProjectOwner(client.config);
        const number = args.number || client.config.projectNumber;

        if (!owner) {
          return toolError(
            "owner is required (set RALPH_GH_PROJECT_OWNER or RALPH_GH_OWNER env var or pass explicitly)",
          );
        }
        if (!number) {
          return toolError(
            "number is required (set RALPH_GH_PROJECT_NUMBER env var or pass explicitly)",
          );
        }

        // Try user first, then organization
        const result = await fetchProject(client, owner, number);

        if (!result) {
          return toolError(`Project #${number} not found for owner "${owner}"`);
        }

        // Populate field cache
        populateFieldCache(fieldCache, result);

        // Format response
        const fields = result.fields.nodes.map((f) => ({
          id: f.id,
          name: f.name,
          dataType: f.dataType,
          options: f.options?.map((o) => ({
            id: o.id,
            name: o.name,
            color: o.color,
          })),
        }));

        return toolSuccess({
          id: result.id,
          title: result.title,
          number: result.number,
          url: result.url,
          fields,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to get project: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__list_project_items
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__list_project_items",
    "List items in a GitHub Project V2, optionally filtered by Workflow State, Estimate, or Priority",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      number: z
        .number()
        .optional()
        .describe(
          "Project number. Defaults to RALPH_GH_PROJECT_NUMBER env var",
        ),
      workflowState: z
        .string()
        .optional()
        .describe("Filter by Workflow State name"),
      estimate: z
        .string()
        .optional()
        .describe("Filter by Estimate name (XS, S, M, L, XL)"),
      priority: z
        .string()
        .optional()
        .describe("Filter by Priority name (P0, P1, P2, P3)"),
      updatedSince: z
        .string()
        .optional()
        .describe(
          "Include items updated on or after this date. Supports date-math (@today-7d, @now-24h) or ISO dates.",
        ),
      updatedBefore: z
        .string()
        .optional()
        .describe(
          "Include items updated before this date. Supports date-math (@today-7d, @now-24h) or ISO dates.",
        ),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Max items to return (default 50)"),
    },
    async (args) => {
      try {
        const owner = args.owner || resolveProjectOwner(client.config);
        const projectNumber = args.number || client.config.projectNumber;

        if (!owner) {
          return toolError("owner is required");
        }
        if (!projectNumber) {
          return toolError("number is required");
        }

        // Ensure field cache is populated
        await ensureFieldCache(client, fieldCache, owner, projectNumber);

        const projectId = fieldCache.getProjectId();
        if (!projectId) {
          return toolError("Could not resolve project ID");
        }

        // When date filters are active, fetch more items to ensure adequate results after filtering
        const hasDateFilters = args.updatedSince || args.updatedBefore;
        const maxItems = hasDateFilters ? 500 : (args.limit || 50);

        // Fetch all project items with field values
        const itemsResult = await paginateConnection<RawProjectItem>(
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
                        state
                        url
                        updatedAt
                        labels(first: 10) { nodes { name } }
                        assignees(first: 5) { nodes { login } }
                      }
                      ... on PullRequest {
                        number
                        title
                        state
                        url
                      }
                      ... on DraftIssue {
                        title
                        body
                      }
                    }
                    fieldValues(first: 20) {
                      nodes {
                        ... on ProjectV2ItemFieldSingleSelectValue {
                          __typename
                          name
                          optionId
                          field { ... on ProjectV2FieldCommon { name } }
                        }
                        ... on ProjectV2ItemFieldTextValue {
                          __typename
                          text
                          field { ... on ProjectV2FieldCommon { name } }
                        }
                        ... on ProjectV2ItemFieldNumberValue {
                          __typename
                          number
                          field { ... on ProjectV2FieldCommon { name } }
                        }
                      }
                    }
                  }
                }
              }
            }
          }`,
          { projectId, first: Math.min(maxItems, 100) },
          "node.items",
          { maxItems },
        );

        // Filter items by field values
        let items = itemsResult.nodes;

        if (args.workflowState) {
          items = items.filter(
            (item) =>
              getFieldValue(item, "Workflow State") === args.workflowState,
          );
        }

        if (args.estimate) {
          items = items.filter(
            (item) => getFieldValue(item, "Estimate") === args.estimate,
          );
        }

        if (args.priority) {
          items = items.filter(
            (item) => getFieldValue(item, "Priority") === args.priority,
          );
        }

        // Filter by updatedSince
        if (args.updatedSince) {
          const since = parseDateMath(args.updatedSince).getTime();
          items = items.filter((item) => {
            const content = item.content as Record<string, unknown> | null;
            const updatedAt = content?.updatedAt as string | undefined;
            return updatedAt ? new Date(updatedAt).getTime() >= since : false;
          });
        }

        // Filter by updatedBefore
        if (args.updatedBefore) {
          const before = parseDateMath(args.updatedBefore).getTime();
          items = items.filter((item) => {
            const content = item.content as Record<string, unknown> | null;
            const updatedAt = content?.updatedAt as string | undefined;
            return updatedAt ? new Date(updatedAt).getTime() < before : false;
          });
        }

        // Apply limit after filtering
        items = items.slice(0, args.limit || 50);

        // Format response
        const formattedItems = items.map((item) => {
          const content = item.content as Record<string, unknown> | null;
          return {
            itemId: item.id,
            type: item.type,
            number: content?.number,
            title: content?.title,
            state: content?.state,
            url: content?.url,
            updatedAt: content?.updatedAt ?? null,
            workflowState: getFieldValue(item, "Workflow State"),
            estimate: getFieldValue(item, "Estimate"),
            priority: getFieldValue(item, "Priority"),
            labels: (
              content?.labels as { nodes: Array<{ name: string }> }
            )?.nodes?.map((l: { name: string }) => l.name),
            assignees: (
              content?.assignees as { nodes: Array<{ login: string }> }
            )?.nodes?.map((a: { login: string }) => a.login),
          };
        });

        return toolSuccess({
          totalCount: itemsResult.totalCount,
          filteredCount: formattedItems.length,
          items: formattedItems,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to list project items: ${message}`);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface RawProjectItem {
  id: string;
  type: string;
  content: Record<string, unknown> | null;
  fieldValues: {
    nodes: Array<{
      __typename?: string;
      name?: string;
      optionId?: string;
      text?: string;
      number?: number;
      field?: { name: string };
    }>;
  };
}

function getFieldValue(
  item: RawProjectItem,
  fieldName: string,
): string | undefined {
  const fieldValue = item.fieldValues.nodes.find(
    (fv) =>
      fv.field?.name === fieldName &&
      fv.__typename === "ProjectV2ItemFieldSingleSelectValue",
  );
  return fieldValue?.name;
}

async function fetchProject(
  client: GitHubClient,
  owner: string,
  number: number,
): Promise<ProjectResponse | null> {
  // Try user query first
  try {
    const result = await client.projectQuery<{
      user: { projectV2: ProjectResponse | null };
    }>(
      `query($owner: String!, $number: Int!) {
        user(login: $owner) {
          projectV2(number: $number) {
            id
            title
            number
            url
            fields(first: 50) {
              nodes {
                ... on ProjectV2FieldCommon {
                  id
                  name
                  dataType
                }
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  dataType
                  options {
                    id
                    name
                    color
                    description
                  }
                }
              }
            }
          }
        }
      }`,
      { owner, number },
      { cache: true, cacheTtlMs: 10 * 60 * 1000 },
    );

    if (result.user?.projectV2) {
      return result.user.projectV2;
    }
  } catch {
    // User not found, try organization
  }

  // Try organization query
  try {
    const result = await client.projectQuery<{
      organization: { projectV2: ProjectResponse | null };
    }>(
      `query($owner: String!, $number: Int!) {
        organization(login: $owner) {
          projectV2(number: $number) {
            id
            title
            number
            url
            fields(first: 50) {
              nodes {
                ... on ProjectV2FieldCommon {
                  id
                  name
                  dataType
                }
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  dataType
                  options {
                    id
                    name
                    color
                    description
                  }
                }
              }
            }
          }
        }
      }`,
      { owner, number },
      { cache: true, cacheTtlMs: 10 * 60 * 1000 },
    );

    if (result.organization?.projectV2) {
      return result.organization.projectV2;
    }
  } catch {
    // Organization not found either
  }

  return null;
}

async function createSingleSelectField(
  client: GitHubClient,
  projectId: string,
  fieldName: string,
  options: FieldOption[],
): Promise<{ id: string; options: string[] }> {
  const result = await client.projectMutate<{
    createProjectV2Field: {
      projectV2Field: {
        id: string;
        name: string;
        options?: Array<{ id: string; name: string }>;
      };
    };
  }>(
    `mutation($projectId: ID!, $name: String!, $dataType: ProjectV2CustomFieldType!, $singleSelectOptions: [ProjectV2SingleSelectFieldOptionInput!]) {
      createProjectV2Field(input: {
        projectId: $projectId,
        dataType: $dataType,
        name: $name,
        singleSelectOptions: $singleSelectOptions
      }) {
        projectV2Field {
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id name }
          }
        }
      }
    }`,
    {
      projectId,
      name: fieldName,
      dataType: "SINGLE_SELECT",
      singleSelectOptions: options.map((o) => ({
        name: o.name,
        color: o.color,
        description: o.description,
      })),
    },
  );

  const field = result.createProjectV2Field.projectV2Field;
  return {
    id: field.id,
    options: field.options?.map((o) => o.name) || options.map((o) => o.name),
  };
}

async function ensureFieldCacheForNewProject(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  owner: string,
  number: number,
): Promise<void> {
  // Clear any stale cache and force refresh
  fieldCache.clear();
  client.getCache().clear();
  await ensureFieldCache(client, fieldCache, owner, number);
}
