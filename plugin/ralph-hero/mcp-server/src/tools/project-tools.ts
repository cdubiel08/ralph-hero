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
import { toolSuccess, toolError } from "../types.js";
import type {
  ProjectV2,
  ProjectV2Item,
  ProjectV2ItemFieldSingleSelectValue,
  ProjectV2FieldUnion,
  ProjectV2SingleSelectField,
  ProjectV2View,
} from "../types.js";
import { resolveProjectOwner } from "../types.js";
import { queryProjectRepositories } from "../lib/helpers.js";

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
  if (fieldCache.isPopulated(projectNumber)) return;

  const project = await fetchProject(client, owner, projectNumber);
  if (!project) {
    throw new Error(`Project #${projectNumber} not found for owner "${owner}"`);
  }

  populateFieldCache(fieldCache, project, projectNumber);
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
  projectNumber: number,
): void {
  fieldCache.populate(
    projectNumber,
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
    "Create a new GitHub Project V2 with Workflow State, Priority, Estimate, and optional Sprint iteration fields",
    {
      owner: z.string().describe("GitHub owner (user or org)"),
      title: z.string().describe("Project title").default("Ralph Workflow"),
      templateProjectNumber: z
        .number()
        .optional()
        .describe(
          "Template project number to copy from. Overrides RALPH_GH_TEMPLATE_PROJECT env var. " +
            "When set, copies the template project (views, fields, automations) instead of creating blank.",
        ),
      createIterationField: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'When true, creates a "Sprint" iteration field with 2-week duration starting next Monday. ' +
            "Only applies to blank project creation (ignored when using template).",
        ),
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

        // Resolve template project number: arg > config > undefined (blank)
        const templatePN =
          args.templateProjectNumber ?? client.config.templateProjectNumber;

        let project: {
          id: string;
          number: number;
          url: string;
          title: string;
        };
        let fieldResults: Record<string, { id: string; options: string[] }>;

        if (templatePN) {
          // --- Copy path: clone template project ---
          // 1. Resolve template project node ID
          const templateProject = await fetchProject(
            client,
            owner,
            templatePN,
          );
          if (!templateProject) {
            return toolError(
              `Template project #${templatePN} not found for owner "${owner}"`,
            );
          }

          // 2. Copy via copyProjectV2
          const copyResult = await client.projectMutate<{
            copyProjectV2: {
              projectV2: {
                id: string;
                number: number;
                url: string;
                title: string;
              };
            };
          }>(
            `mutation($projectId: ID!, $ownerId: ID!, $title: String!) {
              copyProjectV2(input: {
                projectId: $projectId
                ownerId: $ownerId
                title: $title
                includeDraftIssues: false
              }) {
                projectV2 { id number url title }
              }
            }`,
            {
              projectId: templateProject.id,
              ownerId,
              title: args.title,
            },
          );
          project = copyResult.copyProjectV2.projectV2;

          // 3. Fetch fields from the copied project to build fieldResults
          const copiedProject = await fetchProject(
            client,
            owner,
            project.number,
          );
          if (!copiedProject) {
            return toolError(
              `Copied project #${project.number} not found after creation`,
            );
          }
          fieldResults = {};
          for (const f of copiedProject.fields.nodes) {
            if (f.options) {
              fieldResults[f.name] = {
                id: f.id,
                options: f.options.map((o) => o.name),
              };
            }
          }
        } else {
          // --- Blank path: existing createProjectV2 + field creation ---
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

          project = createResult.createProjectV2.projectV2;

          fieldResults = {};

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

          // Optional: Sprint iteration field
          if (args.createIterationField) {
            const iterField = await createIterationField(
              client,
              project.id,
              "Sprint",
              14,
            );
            fieldResults["Sprint"] = {
              id: iterField.id,
              options: [`Sprint 1 (${iterField.startDate}, ${iterField.durationDays}d)`],
            };
          }
        }

        // Shared: cache hydration (both paths)
        await ensureFieldCacheForNewProject(
          client,
          fieldCache,
          owner,
          project.number,
        );

        // Link configured repo to new project (best-effort, both paths)
        let repoLink: { linked: boolean; repository: string } | undefined;
        const configOwner = client.config.owner;
        const configRepo = client.config.repo;
        if (configOwner && configRepo) {
          try {
            repoLink = await linkRepoAfterSetup(
              client,
              project.id,
              configOwner,
              configRepo,
            );
          } catch {
            // Best-effort - don't fail setup if linking fails
          }
        }

        return toolSuccess({
          project: {
            id: project.id,
            number: project.number,
            url: project.url,
            title: project.title,
          },
          fields: fieldResults,
          ...(templatePN && {
            copiedFrom: { templateProjectNumber: templatePN },
          }),
          ...(repoLink && { repositoryLink: repoLink }),
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
        populateFieldCache(fieldCache, result, number);

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

// ---------------------------------------------------------------------------
// View Queries (for create_views tool)
// ---------------------------------------------------------------------------

interface ViewsQueryResult {
  user?: { projectV2: { views: { nodes: ProjectV2View[] } } | null } | null;
  organization?: {
    projectV2: { views: { nodes: ProjectV2View[] } } | null;
  } | null;
}

const VIEWS_QUERY_USER = `
  query($login: String!, $number: Int!) {
    user(login: $login) {
      projectV2(number: $number) {
        views(first: 50) {
          nodes { id name number layout filter }
        }
      }
    }
  }
`;

const VIEWS_QUERY_ORG = `
  query($login: String!, $number: Int!) {
    organization(login: $login) {
      projectV2(number: $number) {
        views(first: 50) {
          nodes { id name number layout filter }
        }
      }
    }
  }
`;

export interface FetchProjectViewsResult {
  views: ProjectV2View[];
  ownerType: "users" | "orgs";
}

/**
 * Fetch project views via GraphQL with user→org fallback.
 * Returns views AND the resolved ownerType so callers can construct
 * the correct REST API path without a separate round-trip.
 */
export async function fetchProjectViews(
  client: GitHubClient,
  owner: string,
  projectNumber: number,
): Promise<FetchProjectViewsResult> {
  // Try user first
  try {
    const result = await client.projectQuery<ViewsQueryResult>(
      VIEWS_QUERY_USER,
      { login: owner, number: projectNumber },
    );
    const nodes = result.user?.projectV2?.views?.nodes;
    if (nodes) return { views: nodes, ownerType: "users" };
  } catch {
    // fall through to org
  }

  // Try org
  const result = await client.projectQuery<ViewsQueryResult>(
    VIEWS_QUERY_ORG,
    { login: owner, number: projectNumber },
  );
  const nodes = result.organization?.projectV2?.views?.nodes;
  if (!nodes) {
    throw new Error(
      `Project #${projectNumber} not found for owner "${owner}"`,
    );
  }
  return { views: nodes, ownerType: "orgs" };
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
  // Invalidate query cache to force fresh API responses for the new project.
  // Do NOT clear fieldCache — other projects' data must be preserved (GH-242).
  client.getCache().invalidatePrefix("query:");
  await ensureFieldCache(client, fieldCache, owner, number);
}

/**
 * Compute the next Monday on or after a given date.
 * Used to set a sensible default start date for new iteration fields.
 */
function getNextMonday(from: Date = new Date()): string {
  const d = new Date(from);
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const daysUntilMonday = day === 0 ? 1 : day === 1 ? 0 : 8 - day;
  d.setDate(d.getDate() + daysUntilMonday);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function createIterationField(
  client: GitHubClient,
  projectId: string,
  name: string = "Sprint",
  durationDays: number = 14,
  startDate?: string,
): Promise<{ id: string; name: string; startDate: string; durationDays: number }> {
  const start = startDate || getNextMonday();

  const result = await client.projectMutate<{
    createProjectV2Field: {
      projectV2Field: {
        id: string;
        name: string;
        configuration: {
          iterations: Array<{ startDate: string; duration: number }>;
        };
      };
    };
  }>(
    `mutation($projectId: ID!, $name: String!, $dataType: ProjectV2CustomFieldType!, $config: ProjectV2IterationFieldConfigurationInput!) {
      createProjectV2Field(input: {
        projectId: $projectId,
        dataType: $dataType,
        name: $name,
        iterationConfiguration: $config
      }) {
        projectV2Field {
          ... on ProjectV2IterationField {
            id
            name
            configuration {
              iterations { startDate duration }
            }
          }
        }
      }
    }`,
    {
      projectId,
      name,
      dataType: "ITERATION",
      config: {
        duration: durationDays,
        startDate: start,
        iterations: [
          { startDate: start, duration: durationDays },
        ],
      },
    },
  );

  const field = result.createProjectV2Field.projectV2Field;
  const firstIter = field.configuration?.iterations?.[0];
  return {
    id: field.id,
    name: field.name || name,
    startDate: firstIter?.startDate ?? start,
    durationDays: firstIter?.duration ?? durationDays,
  };
}

async function linkRepoAfterSetup(
  client: GitHubClient,
  projectId: string,
  repoOwner: string,
  repoName: string,
): Promise<{ linked: boolean; repository: string }> {
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
    return { linked: false, repository: `${repoOwner}/${repoName}` };
  }

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

  return { linked: true, repository: `${repoOwner}/${repoName}` };
}


