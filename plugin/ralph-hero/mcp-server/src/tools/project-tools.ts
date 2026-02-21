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
import { expandProfile } from "../lib/filter-profiles.js";
import { toolSuccess, toolError } from "../types.js";
import type {
  ProjectV2,
  ProjectV2Item,
  ProjectV2ItemFieldSingleSelectValue,
  ProjectV2FieldUnion,
  ProjectV2SingleSelectField,
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
    "Create a new GitHub Project V2 with Workflow State, Priority, and Estimate custom fields",
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

  // -------------------------------------------------------------------------
  // ralph_hero__list_projects
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__list_projects",
    "List all GitHub Projects V2 for an owner (user or organization). Returns project summaries with item/field/view counts. Supports open/closed filtering.",
    {
      owner: z
        .string()
        .optional()
        .describe(
          "GitHub owner (user or org). Defaults to RALPH_GH_PROJECT_OWNER or RALPH_GH_OWNER env var",
        ),
      state: z
        .enum(["open", "closed", "all"])
        .optional()
        .default("open")
        .describe(
          'Filter by project state: "open" (default), "closed", or "all"',
        ),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum number of projects to return (default: 50, max: 100)"),
    },
    async (args) => {
      try {
        const owner = args.owner || resolveProjectOwner(client.config);
        if (!owner) {
          return toolError(
            "owner is required (set RALPH_GH_PROJECT_OWNER or RALPH_GH_OWNER env var or pass explicitly)",
          );
        }

        const maxItems = Math.min(args.limit ?? 50, 100);

        const LIST_PROJECTS_QUERY = `
          query($owner: String!, $cursor: String, $first: Int!) {
            OWNER_TYPE(login: $owner) {
              projectsV2(first: $first, after: $cursor, orderBy: {field: TITLE, direction: ASC}) {
                totalCount
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  number
                  title
                  shortDescription
                  public
                  closed
                  url
                  items { totalCount }
                  fields { totalCount }
                  views { totalCount }
                }
              }
            }
          }
        `;

        interface ListProjectNode {
          id: string;
          number: number;
          title: string;
          shortDescription: string | null;
          public: boolean;
          closed: boolean;
          url: string;
          items?: { totalCount: number };
          fields?: { totalCount: number };
          views?: { totalCount: number };
        }

        let allProjects: ListProjectNode[] = [];
        let totalCount: number | undefined;

        for (const ownerType of ["user", "organization"] as const) {
          try {
            const result = await paginateConnection<ListProjectNode>(
              (q, vars) => client.projectQuery(q, vars),
              LIST_PROJECTS_QUERY.replace("OWNER_TYPE", ownerType),
              { owner },
              `${ownerType}.projectsV2`,
              { maxItems },
            );
            allProjects = result.nodes;
            totalCount = result.totalCount;
            break;
          } catch {
            // Try next owner type
          }
        }

        // Client-side state filtering
        const filtered =
          args.state === "all"
            ? allProjects
            : args.state === "closed"
              ? allProjects.filter((p) => p.closed)
              : allProjects.filter((p) => !p.closed);

        const projects = filtered.map((p) => ({
          id: p.id,
          number: p.number,
          title: p.title,
          shortDescription: p.shortDescription,
          public: p.public,
          closed: p.closed,
          url: p.url,
          itemCount: p.items?.totalCount ?? 0,
          fieldCount: p.fields?.totalCount ?? 0,
          viewCount: p.views?.totalCount ?? 0,
        }));

        return toolSuccess({
          owner,
          state: args.state,
          projects,
          totalCount: totalCount ?? projects.length,
          returnedCount: projects.length,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to list projects: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__copy_project
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__copy_project",
    "Copy (duplicate) a GitHub Project V2, preserving views, custom fields, workflows, and insights. Does NOT copy items, collaborators, team links, or repository links.",
    {
      sourceProjectNumber: z
        .number()
        .describe("Project number of the source project to copy"),
      sourceOwner: z
        .string()
        .optional()
        .describe(
          "Owner of the source project. Defaults to RALPH_GH_PROJECT_OWNER or RALPH_GH_OWNER env var",
        ),
      title: z.string().describe("Title for the new project"),
      targetOwner: z
        .string()
        .optional()
        .describe(
          "Owner for the new project. Defaults to sourceOwner. Supports cross-owner copy (e.g., personal to org)",
        ),
      includeDraftIssues: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Include draft issues from the source project in the copy (default: false)",
        ),
    },
    async (args) => {
      try {
        const sourceOwner =
          args.sourceOwner || resolveProjectOwner(client.config);
        if (!sourceOwner) {
          return toolError(
            "sourceOwner is required (set RALPH_GH_PROJECT_OWNER or RALPH_GH_OWNER env var or pass explicitly)",
          );
        }

        // Step 1: Resolve source project node ID via fetchProject
        const sourceProject = await fetchProject(
          client,
          sourceOwner,
          args.sourceProjectNumber,
        );
        if (!sourceProject) {
          return toolError(
            `Source project #${args.sourceProjectNumber} not found for owner "${sourceOwner}"`,
          );
        }

        // Step 2: Resolve target owner node ID (try user first, then org)
        const targetOwnerLogin = args.targetOwner || sourceOwner;
        let targetOwnerId: string | undefined;

        try {
          const userResult = await client.query<{
            user: { id: string } | null;
          }>(
            `query($login: String!) {
              user(login: $login) { id }
            }`,
            { login: targetOwnerLogin },
            { cache: true },
          );
          targetOwnerId = userResult.user?.id;
        } catch {
          // Not a user, try org below
        }

        if (!targetOwnerId) {
          try {
            const orgResult = await client.query<{
              organization: { id: string } | null;
            }>(
              `query($login: String!) {
                organization(login: $login) { id }
              }`,
              { login: targetOwnerLogin },
              { cache: true },
            );
            targetOwnerId = orgResult.organization?.id;
          } catch {
            // Not an org either
          }
        }

        if (!targetOwnerId) {
          return toolError(
            `Target owner "${targetOwnerLogin}" not found as user or organization`,
          );
        }

        // Step 3: Execute copyProjectV2 mutation
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
          `mutation($projectId: ID!, $ownerId: ID!, $title: String!, $includeDraftIssues: Boolean!) {
            copyProjectV2(input: {
              projectId: $projectId
              ownerId: $ownerId
              title: $title
              includeDraftIssues: $includeDraftIssues
            }) {
              projectV2 {
                id
                number
                url
                title
              }
            }
          }`,
          {
            projectId: sourceProject.id,
            ownerId: targetOwnerId,
            title: args.title,
            includeDraftIssues: args.includeDraftIssues ?? false,
          },
        );

        const newProject = copyResult.copyProjectV2.projectV2;

        return toolSuccess({
          project: {
            id: newProject.id,
            number: newProject.number,
            url: newProject.url,
            title: newProject.title,
          },
          copiedFrom: {
            number: args.sourceProjectNumber,
            owner: sourceOwner,
            title: sourceProject.title,
          },
          note: "Copied views, custom fields, workflows, and insights. Items, collaborators, team links, and repository links were NOT copied.",
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to copy project: ${message}`);
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
      profile: z
        .string()
        .optional()
        .describe(
          "Named filter profile (e.g., 'analyst-triage', 'builder-active'). " +
            "Profile filters are defaults; explicit params override them.",
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
      has: z
        .array(z.enum(["workflowState", "estimate", "priority", "labels", "assignees"]))
        .optional()
        .describe(
          "Include only items where these fields are non-empty. " +
          "Valid fields: workflowState, estimate, priority, labels, assignees",
        ),
      no: z
        .array(z.enum(["workflowState", "estimate", "priority", "labels", "assignees"]))
        .optional()
        .describe(
          "Include only items where these fields are empty/absent. " +
          "Valid fields: workflowState, estimate, priority, labels, assignees",
        ),
      excludeWorkflowStates: z
        .array(z.string())
        .optional()
        .describe(
          "Exclude items matching any of these Workflow State names " +
          '(e.g., ["Done", "Canceled"])',
        ),
      excludeEstimates: z
        .array(z.string())
        .optional()
        .describe(
          "Exclude items matching any of these Estimate values " +
          '(e.g., ["M", "L", "XL"])',
        ),
      excludePriorities: z
        .array(z.string())
        .optional()
        .describe(
          "Exclude items matching any of these Priority values " +
          '(e.g., ["P3"])',
        ),
      itemType: z
        .enum(["ISSUE", "PULL_REQUEST", "DRAFT_ISSUE"])
        .optional()
        .describe(
          "Filter by item type (ISSUE, PULL_REQUEST, DRAFT_ISSUE). Omit to include all types.",
        ),
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
        // Expand profile into filter defaults (explicit args override)
        if (args.profile) {
          const profileFilters = expandProfile(args.profile);
          for (const [key, value] of Object.entries(profileFilters)) {
            if (args[key as keyof typeof args] === undefined) {
              (args as Record<string, unknown>)[key] = value;
            }
          }
        }

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

        // When filters are active, fetch more items to ensure adequate results after filtering
        const hasFilters = args.updatedSince || args.updatedBefore || args.itemType ||
          (args.has && args.has.length > 0) ||
          (args.no && args.no.length > 0) ||
          (args.excludeWorkflowStates && args.excludeWorkflowStates.length > 0) ||
          (args.excludeEstimates && args.excludeEstimates.length > 0) ||
          (args.excludePriorities && args.excludePriorities.length > 0);
        const maxItems = hasFilters ? 500 : (args.limit || 50);

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
                        repository { nameWithOwner name owner { login } }
                      }
                      ... on PullRequest {
                        number
                        title
                        state
                        url
                        repository { nameWithOwner name owner { login } }
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

        // Filter by item type (broadest filter first to reduce working set)
        if (args.itemType) {
          items = items.filter((item) => item.type === args.itemType);
        }

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

        // Filter by field presence (has)
        if (args.has && args.has.length > 0) {
          items = items.filter((item) =>
            args.has!.every((field) => hasField(item, field as PresenceField)),
          );
        }

        // Filter by field absence (no)
        if (args.no && args.no.length > 0) {
          items = items.filter((item) =>
            args.no!.every((field) => !hasField(item, field as PresenceField)),
          );
        }

        // Filter by excluded workflow states
        if (args.excludeWorkflowStates && args.excludeWorkflowStates.length > 0) {
          items = items.filter(
            (item) =>
              !args.excludeWorkflowStates!.includes(
                getFieldValue(item, "Workflow State") ?? "",
              ),
          );
        }

        // Filter by excluded estimates
        if (args.excludeEstimates && args.excludeEstimates.length > 0) {
          items = items.filter(
            (item) =>
              !args.excludeEstimates!.includes(
                getFieldValue(item, "Estimate") ?? "",
              ),
          );
        }

        // Filter by excluded priorities
        if (args.excludePriorities && args.excludePriorities.length > 0) {
          items = items.filter(
            (item) =>
              !args.excludePriorities!.includes(
                getFieldValue(item, "Priority") ?? "",
              ),
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
            owner: (content?.repository as { owner?: { login?: string } })?.owner?.login ?? null,
            repo: (content?.repository as { name?: string })?.name ?? null,
            nameWithOwner: (content?.repository as { nameWithOwner?: string })?.nameWithOwner ?? null,
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

  // -------------------------------------------------------------------------
  // ralph_hero__list_project_repos
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__list_project_repos",
    "List all repositories linked to a GitHub Project V2. Returns owner, name, and nameWithOwner for each linked repo.",
    {
      owner: z
        .string()
        .optional()
        .describe(
          "GitHub owner (user or org). Defaults to RALPH_GH_PROJECT_OWNER or RALPH_GH_OWNER env var",
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
        const projectNumber = args.number || client.config.projectNumber;

        if (!owner) {
          return toolError(
            "owner is required (set RALPH_GH_PROJECT_OWNER or RALPH_GH_OWNER env var or pass explicitly)",
          );
        }
        if (!projectNumber) {
          return toolError(
            "number is required (set RALPH_GH_PROJECT_NUMBER env var or pass explicitly)",
          );
        }

        const result = await queryProjectRepositories(
          client,
          owner,
          projectNumber,
        );

        if (!result) {
          return toolError(
            `Project #${projectNumber} not found for owner "${owner}"`,
          );
        }

        return toolSuccess({
          projectId: result.projectId,
          repos: result.repos,
          totalRepos: result.totalRepos,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to list project repos: ${message}`);
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

type PresenceField = "workflowState" | "estimate" | "priority" | "labels" | "assignees";

function hasField(item: RawProjectItem, field: PresenceField): boolean {
  switch (field) {
    case "workflowState":
      return getFieldValue(item, "Workflow State") !== undefined;
    case "estimate":
      return getFieldValue(item, "Estimate") !== undefined;
    case "priority":
      return getFieldValue(item, "Priority") !== undefined;
    case "labels": {
      const content = item.content as Record<string, unknown> | null;
      const labels = (content?.labels as { nodes: Array<{ name: string }> })?.nodes || [];
      return labels.length > 0;
    }
    case "assignees": {
      const content = item.content as Record<string, unknown> | null;
      const assignees = (content?.assignees as { nodes: Array<{ login: string }> })?.nodes || [];
      return assignees.length > 0;
    }
  }
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
  // Invalidate query cache to force fresh API responses for the new project.
  // Do NOT clear fieldCache — other projects' data must be preserved (GH-242).
  client.getCache().invalidatePrefix("query:");
  await ensureFieldCache(client, fieldCache, owner, number);
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
