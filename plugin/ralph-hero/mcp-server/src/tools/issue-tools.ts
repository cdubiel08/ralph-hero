/**
 * MCP tools for GitHub issue management with integrated Projects V2 field updates.
 *
 * Each tool abstracts the multi-step GitHub process (issue operation + project
 * field update) into single tool calls that accept human-readable names.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import { paginateConnection } from "../lib/pagination.js";
import { detectGroup } from "../lib/group-detection.js";
import {
  detectPipelinePosition,
  type IssueState,
} from "../lib/pipeline-detection.js";
import {
  isValidState,
  isEarlierState,
  VALID_STATES,
  LOCK_STATES,
} from "../lib/workflow-states.js";
import { resolveState } from "../lib/state-resolution.js";
import { toolSuccess, toolError, resolveProjectOwner } from "../types.js";

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

  // Fetch project to populate cache - try user first, then org
  const project = await fetchProjectForCache(client, owner, projectNumber);
  if (!project) {
    throw new Error(`Project #${projectNumber} not found for owner "${owner}"`);
  }

  fieldCache.populate(
    project.id,
    project.fields.nodes.map((f) => ({
      id: f.id,
      name: f.name,
      options: f.options,
    })),
  );
}

interface ProjectCacheResponse {
  id: string;
  fields: {
    nodes: Array<{
      id: string;
      name: string;
      dataType: string;
      options?: Array<{ id: string; name: string }>;
    }>;
  };
}

async function fetchProjectForCache(
  client: GitHubClient,
  owner: string,
  number: number,
): Promise<ProjectCacheResponse | null> {
  const QUERY = `query($owner: String!, $number: Int!) {
    OWNER_TYPE(login: $owner) {
      projectV2(number: $number) {
        id
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
              options { id name }
            }
          }
        }
      }
    }
  }`;

  for (const ownerType of ["user", "organization"]) {
    try {
      const result = await client.projectQuery<
        Record<string, { projectV2: ProjectCacheResponse | null }>
      >(
        QUERY.replace("OWNER_TYPE", ownerType),
        { owner, number },
        { cache: true, cacheTtlMs: 10 * 60 * 1000 },
      );
      const project = result[ownerType]?.projectV2;
      if (project) return project;
    } catch {
      // Try next owner type
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: Resolve issue number to node ID (with caching)
// ---------------------------------------------------------------------------

async function resolveIssueNodeId(
  client: GitHubClient,
  owner: string,
  repo: string,
  number: number,
): Promise<string> {
  const cacheKey = `issue-node-id:${owner}/${repo}#${number}`;
  const cached = client.getCache().get<string>(cacheKey);
  if (cached) return cached;

  const result = await client.query<{
    repository: { issue: { id: string } | null } | null;
  }>(
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) { id }
      }
    }`,
    { owner, repo, number },
  );

  const nodeId = result.repository?.issue?.id;
  if (!nodeId) {
    throw new Error(`Issue #${number} not found in ${owner}/${repo}`);
  }

  client.getCache().set(cacheKey, nodeId, 30 * 60 * 1000); // Cache 30 min
  return nodeId;
}

// ---------------------------------------------------------------------------
// Helper: Resolve issue's project item ID (for field updates)
// ---------------------------------------------------------------------------

async function resolveProjectItemId(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<string> {
  const projectId = fieldCache.getProjectId();
  if (!projectId) {
    throw new Error(
      "Field cache not populated - cannot resolve project item ID",
    );
  }

  const cacheKey = `project-item-id:${owner}/${repo}#${issueNumber}`;
  const cached = client.getCache().get<string>(cacheKey);
  if (cached) return cached;

  // Query the issue's project items to find the one matching our project
  const issueNodeId = await resolveIssueNodeId(
    client,
    owner,
    repo,
    issueNumber,
  );

  const result = await client.query<{
    node: {
      projectItems: {
        nodes: Array<{
          id: string;
          project: { id: string };
        }>;
      };
    } | null;
  }>(
    `query($issueId: ID!) {
      node(id: $issueId) {
        ... on Issue {
          projectItems(first: 20) {
            nodes {
              id
              project { id }
            }
          }
        }
      }
    }`,
    { issueId: issueNodeId },
  );

  const items = result.node?.projectItems?.nodes || [];
  const projectItem = items.find((item) => item.project.id === projectId);

  if (!projectItem) {
    throw new Error(
      `Issue #${issueNumber} is not in the project (projectId: ${projectId}). ` +
        `Add it to the project first using ralph_hero__create_issue or add it manually.`,
    );
  }

  client.getCache().set(cacheKey, projectItem.id, 30 * 60 * 1000);
  return projectItem.id;
}

// ---------------------------------------------------------------------------
// Helper: Update a single-select field value on a project item
// ---------------------------------------------------------------------------

async function updateProjectItemField(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  projectItemId: string,
  fieldName: string,
  optionName: string,
): Promise<void> {
  const projectId = fieldCache.getProjectId();
  if (!projectId) {
    throw new Error("Field cache not populated");
  }

  const fieldId = fieldCache.getFieldId(fieldName);
  if (!fieldId) {
    throw new Error(`Field "${fieldName}" not found in project`);
  }

  const optionId = fieldCache.resolveOptionId(fieldName, optionName);
  if (!optionId) {
    const validOptions = fieldCache.getOptionNames(fieldName);
    throw new Error(
      `Option "${optionName}" not found for field "${fieldName}". ` +
        `Valid options: ${validOptions.join(", ")}`,
    );
  }

  await client.projectMutate(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId,
        itemId: $itemId,
        fieldId: $fieldId,
        value: { singleSelectOptionId: $optionId }
      }) {
        projectV2Item { id }
      }
    }`,
    { projectId, itemId: projectItemId, fieldId, optionId },
  );
}

// ---------------------------------------------------------------------------
// Helper: Get current field value for an issue's project item
// ---------------------------------------------------------------------------

async function getCurrentFieldValue(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  owner: string,
  repo: string,
  issueNumber: number,
  fieldName: string,
): Promise<string | undefined> {
  const projectItemId = await resolveProjectItemId(
    client,
    fieldCache,
    owner,
    repo,
    issueNumber,
  );

  const result = await client.query<{
    node: {
      fieldValues: {
        nodes: Array<{
          __typename?: string;
          name?: string;
          field?: { name: string };
        }>;
      };
    } | null;
  }>(
    `query($itemId: ID!) {
      node(id: $itemId) {
        ... on ProjectV2Item {
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
    }`,
    { itemId: projectItemId },
  );

  const fieldValue = result.node?.fieldValues?.nodes?.find(
    (fv) =>
      fv.field?.name === fieldName &&
      fv.__typename === "ProjectV2ItemFieldSingleSelectValue",
  );
  return fieldValue?.name;
}

// ---------------------------------------------------------------------------
// Helper: Resolve required owner/repo/projectNumber with defaults
// ---------------------------------------------------------------------------

interface ResolvedConfig {
  owner: string;
  repo: string;
  projectNumber: number;
  projectOwner: string;
}

function resolveConfig(
  client: GitHubClient,
  args: { owner?: string; repo?: string },
): { owner: string; repo: string } {
  const owner = args.owner || client.config.owner;
  const repo = args.repo || client.config.repo;
  if (!owner)
    throw new Error(
      "owner is required (set RALPH_GH_OWNER env var or pass explicitly)",
    );
  if (!repo)
    throw new Error(
      "repo is required (set RALPH_GH_REPO env var or pass explicitly)",
    );
  return { owner, repo };
}

function resolveFullConfig(
  client: GitHubClient,
  args: { owner?: string; repo?: string },
): ResolvedConfig {
  const { owner, repo } = resolveConfig(client, args);
  const projectNumber = client.config.projectNumber;
  if (!projectNumber) {
    throw new Error(
      "projectNumber is required (set RALPH_GH_PROJECT_NUMBER env var)",
    );
  }
  const projectOwner = resolveProjectOwner(client.config);
  if (!projectOwner) {
    throw new Error(
      "projectOwner is required (set RALPH_GH_PROJECT_OWNER or RALPH_GH_OWNER env var)",
    );
  }
  return { owner, repo, projectNumber, projectOwner };
}

// ---------------------------------------------------------------------------
// Register issue tools
// ---------------------------------------------------------------------------

export function registerIssueTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  // -------------------------------------------------------------------------
  // ralph_hero__list_issues
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__list_issues",
    "List issues from a GitHub repository with optional filters. Returns: number, title, state, workflowState, estimate, priority, labels, assignees. Use workflowState filter to find issues in a specific phase. Recovery: if no results, broaden filters or check that issues exist in the project.",
    {
      owner: z
        .string()
        .optional()
        .describe(
          "GitHub owner (user or org). Defaults to GITHUB_OWNER env var",
        ),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to GITHUB_REPO env var"),
      workflowState: z
        .string()
        .optional()
        .describe("Filter by Workflow State name"),
      estimate: z
        .string()
        .optional()
        .describe("Filter by Estimate (XS, S, M, L, XL)"),
      priority: z
        .string()
        .optional()
        .describe("Filter by Priority (P0, P1, P2, P3)"),
      label: z.string().optional().describe("Filter by label name"),
      query: z.string().optional().describe("Additional search query string"),
      state: z
        .enum(["OPEN", "CLOSED"])
        .optional()
        .default("OPEN")
        .describe("Issue state filter (default: OPEN)"),
      orderBy: z
        .enum(["CREATED_AT", "UPDATED_AT", "COMMENTS"])
        .optional()
        .default("CREATED_AT")
        .describe("Order by field"),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Max items to return (default 50)"),
    },
    async (args) => {
      try {
        const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        // Ensure field cache is populated
        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        const projectId = fieldCache.getProjectId();
        if (!projectId) {
          return toolError("Could not resolve project ID");
        }

        // Fetch project items with issue content and field values
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
                        body
                        state
                        url
                        createdAt
                        updatedAt
                        labels(first: 10) { nodes { name } }
                        assignees(first: 5) { nodes { login } }
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
                      }
                    }
                  }
                }
              }
            }
          }`,
          { projectId, first: 100 },
          "node.items",
          { maxItems: 500 }, // Fetch up to 500 then filter client-side
        );

        // Filter items
        let items = itemsResult.nodes.filter(
          (item) => item.type === "ISSUE" && item.content,
        );

        // Filter by issue state
        if (args.state) {
          items = items.filter((item) => {
            const content = item.content as Record<string, unknown> | null;
            return content?.state === args.state;
          });
        }

        // Filter by workflow state
        if (args.workflowState) {
          items = items.filter(
            (item) =>
              getFieldValue(item, "Workflow State") === args.workflowState,
          );
        }

        // Filter by estimate
        if (args.estimate) {
          items = items.filter(
            (item) => getFieldValue(item, "Estimate") === args.estimate,
          );
        }

        // Filter by priority
        if (args.priority) {
          items = items.filter(
            (item) => getFieldValue(item, "Priority") === args.priority,
          );
        }

        // Filter by label
        if (args.label) {
          items = items.filter((item) => {
            const content = item.content as Record<string, unknown> | null;
            const labels =
              (content?.labels as { nodes: Array<{ name: string }> })?.nodes ||
              [];
            return labels.some((l) => l.name === args.label);
          });
        }

        // Filter by search query (simple title/body substring match)
        if (args.query) {
          const q = args.query.toLowerCase();
          items = items.filter((item) => {
            const content = item.content as Record<string, unknown> | null;
            const title = ((content?.title as string) || "").toLowerCase();
            const body = ((content?.body as string) || "").toLowerCase();
            return title.includes(q) || body.includes(q);
          });
        }

        // Sort
        items.sort((a, b) => {
          const ac = a.content as Record<string, unknown> | null;
          const bc = b.content as Record<string, unknown> | null;
          const field =
            args.orderBy === "UPDATED_AT" ? "updatedAt" : "createdAt";
          const aVal = (ac?.[field] as string) || "";
          const bVal = (bc?.[field] as string) || "";
          return bVal.localeCompare(aVal); // Descending (newest first)
        });

        // Limit
        items = items.slice(0, args.limit || 50);

        // Format response
        const formattedItems = items.map((item) => {
          const content = item.content as Record<string, unknown> | null;
          return {
            number: content?.number,
            title: content?.title,
            state: content?.state,
            url: content?.url,
            workflowState: getFieldValue(item, "Workflow State"),
            estimate: getFieldValue(item, "Estimate"),
            priority: getFieldValue(item, "Priority"),
            labels: (
              content?.labels as { nodes: Array<{ name: string }> }
            )?.nodes?.map((l) => l.name),
            assignees: (
              content?.assignees as { nodes: Array<{ login: string }> }
            )?.nodes?.map((a) => a.login),
          };
        });

        return toolSuccess({
          totalCount: itemsResult.totalCount,
          filteredCount: formattedItems.length,
          items: formattedItems,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to list issues: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__get_issue
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__get_issue",
    "Get a single GitHub issue with full context: properties, project field values, relationships (parent, sub-issues, blocking, blocked-by), recent comments, and optional group detection. Returns group data by default so callers don't need a separate detect_group call. Key fields: number, title, workflowState, estimate, priority, parent, subIssues, blocking, blockedBy, comments, group.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to GITHUB_REPO env var"),
      number: z.number().describe("Issue number"),
      includeGroup: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Include group detection results (default: true). Set to false to skip group detection and save API calls when group context is not needed.",
        ),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);
        const projectNumber = client.config.projectNumber;

        const result = await client.query<{
          repository: {
            issue: {
              id: string;
              number: number;
              title: string;
              body: string;
              state: string;
              stateReason: string | null;
              url: string;
              createdAt: string;
              updatedAt: string;
              closedAt: string | null;
              labels: { nodes: Array<{ name: string; color: string }> };
              assignees: { nodes: Array<{ login: string }> };
              parent: { number: number; title: string; state: string } | null;
              subIssuesSummary: {
                total: number;
                completed: number;
                percentCompleted: number;
              } | null;
              subIssues: {
                nodes: Array<{ number: number; title: string; state: string }>;
              };
              trackedInIssues: {
                nodes: Array<{ number: number; title: string; state: string }>;
              };
              trackedIssues: {
                nodes: Array<{ number: number; title: string; state: string }>;
              };
              comments: {
                nodes: Array<{
                  id: string;
                  body: string;
                  author: { login: string } | null;
                  createdAt: string;
                }>;
              };
              projectItems: {
                nodes: Array<{
                  id: string;
                  project: { id: string; number: number };
                  fieldValues: {
                    nodes: Array<{
                      __typename?: string;
                      name?: string;
                      optionId?: string;
                      field?: { name: string };
                    }>;
                  };
                }>;
              };
            } | null;
          } | null;
        }>(
          `query($owner: String!, $repo: String!, $number: Int!) {
            repository(owner: $owner, name: $repo) {
              issue(number: $number) {
                id
                number
                title
                body
                state
                stateReason
                url
                createdAt
                updatedAt
                closedAt
                labels(first: 20) { nodes { name color } }
                assignees(first: 10) { nodes { login } }
                parent { number title state }
                subIssuesSummary { total completed percentCompleted }
                subIssues(first: 50) {
                  nodes { number title state }
                }
                trackedInIssues(first: 20) {
                  nodes { number title state }
                }
                trackedIssues(first: 20) {
                  nodes { number title state }
                }
                comments(last: 10) {
                  nodes {
                    id
                    body
                    author { login }
                    createdAt
                  }
                }
                projectItems(first: 10) {
                  nodes {
                    id
                    project { id number }
                    fieldValues(first: 20) {
                      nodes {
                        ... on ProjectV2ItemFieldSingleSelectValue {
                          __typename
                          name
                          optionId
                          field { ... on ProjectV2FieldCommon { name } }
                        }
                      }
                    }
                  }
                }
              }
            }
          }`,
          { owner, repo, number: args.number },
        );

        const issue = result.repository?.issue;
        if (!issue) {
          return toolError(
            `Issue #${args.number} not found in ${owner}/${repo}`,
          );
        }

        // Cache the node ID
        client
          .getCache()
          .set(
            `issue-node-id:${owner}/${repo}#${issue.number}`,
            issue.id,
            30 * 60 * 1000,
          );

        // Extract project field values (find matching project if we know the project number)
        let workflowState: string | undefined;
        let estimate: string | undefined;
        let priority: string | undefined;

        const projectItem = projectNumber
          ? issue.projectItems.nodes.find(
              (pi) => pi.project.number === projectNumber,
            )
          : issue.projectItems.nodes[0]; // Use first project item if no project configured

        if (projectItem) {
          // Cache the project item ID
          client
            .getCache()
            .set(
              `project-item-id:${owner}/${repo}#${issue.number}`,
              projectItem.id,
              30 * 60 * 1000,
            );

          for (const fv of projectItem.fieldValues.nodes) {
            if (
              fv.__typename === "ProjectV2ItemFieldSingleSelectValue" &&
              fv.field
            ) {
              switch (fv.field.name) {
                case "Workflow State":
                  workflowState = fv.name;
                  break;
                case "Estimate":
                  estimate = fv.name;
                  break;
                case "Priority":
                  priority = fv.name;
                  break;
              }
            }
          }
        }

        // Optionally detect group context
        let group: {
          isGroup: boolean;
          primary: { number: number; title: string };
          members: Array<{
            number: number;
            title: string;
            state: string;
            order: number;
          }>;
          totalTickets: number;
        } | null = null;

        if (args.includeGroup !== false) {
          try {
            const { owner: cfgOwner, repo: cfgRepo } = resolveConfig(
              client,
              args,
            );
            const groupResult = await detectGroup(
              client,
              cfgOwner,
              cfgRepo,
              args.number,
            );
            group = {
              isGroup: groupResult.isGroup,
              primary: {
                number: groupResult.groupPrimary.number,
                title: groupResult.groupPrimary.title,
              },
              members: groupResult.groupTickets.map((t) => ({
                number: t.number,
                title: t.title,
                state: t.state,
                order: t.order,
              })),
              totalTickets: groupResult.totalTickets,
            };
          } catch {
            // Group detection is best-effort; don't fail the whole request
            group = null;
          }
        }

        return toolSuccess({
          number: issue.number,
          id: issue.id,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          stateReason: issue.stateReason,
          url: issue.url,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
          closedAt: issue.closedAt,
          workflowState,
          estimate,
          priority,
          labels: issue.labels.nodes.map((l) => l.name),
          assignees: issue.assignees.nodes.map((a) => a.login),
          parent: issue.parent
            ? {
                number: issue.parent.number,
                title: issue.parent.title,
                state: issue.parent.state,
              }
            : null,
          subIssuesSummary: issue.subIssuesSummary,
          subIssues: issue.subIssues.nodes.map((si) => ({
            number: si.number,
            title: si.title,
            state: si.state,
          })),
          blocking: issue.trackedInIssues.nodes.map((i) => ({
            number: i.number,
            title: i.title,
            state: i.state,
          })),
          blockedBy: issue.trackedIssues.nodes.map((i) => ({
            number: i.number,
            title: i.title,
            state: i.state,
          })),
          comments: issue.comments.nodes.map((c) => ({
            id: c.id,
            body: c.body,
            author: c.author?.login || "unknown",
            createdAt: c.createdAt,
          })),
          group,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to get issue: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__create_issue
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__create_issue",
    "Create a GitHub issue and add it to the project with optional field values. Returns: number, id, title, url, projectItemId, fieldsSet. Recovery: if field value fails, verify the option name matches exactly (case-sensitive).",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to GITHUB_REPO env var"),
      title: z.string().describe("Issue title"),
      body: z.string().optional().describe("Issue body (Markdown)"),
      labels: z.array(z.string()).optional().describe("Label names to apply"),
      assignees: z
        .array(z.string())
        .optional()
        .describe("GitHub usernames to assign"),
      workflowState: z
        .string()
        .optional()
        .describe("Initial Workflow State name"),
      estimate: z.string().optional().describe("Estimate (XS, S, M, L, XL)"),
      priority: z.string().optional().describe("Priority (P0, P1, P2, P3)"),
    },
    async (args) => {
      try {
        const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        // Ensure field cache is populated
        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        // Step 1: Get repository ID
        const repoResult = await client.query<{
          repository: { id: string } | null;
        }>(
          `query($owner: String!, $repo: String!) {
            repository(owner: $owner, name: $repo) { id }
          }`,
          { owner, repo },
          { cache: true, cacheTtlMs: 60 * 60 * 1000 },
        );

        const repoId = repoResult.repository?.id;
        if (!repoId) {
          return toolError(`Repository ${owner}/${repo} not found`);
        }

        // Step 2: Resolve label IDs if provided
        let labelIds: string[] | undefined;
        if (args.labels && args.labels.length > 0) {
          const labelResult = await client.query<{
            repository: {
              labels: {
                nodes: Array<{ id: string; name: string }>;
              };
            };
          }>(
            `query($owner: String!, $repo: String!) {
              repository(owner: $owner, name: $repo) {
                labels(first: 100) {
                  nodes { id name }
                }
              }
            }`,
            { owner, repo },
            { cache: true, cacheTtlMs: 5 * 60 * 1000 },
          );

          const allLabels = labelResult.repository.labels.nodes;
          labelIds = args.labels
            .map((name) => allLabels.find((l) => l.name === name)?.id)
            .filter((id): id is string => id !== undefined);
        }

        // Step 3: Create the issue
        const createResult = await client.mutate<{
          createIssue: {
            issue: {
              id: string;
              number: number;
              title: string;
              url: string;
            };
          };
        }>(
          `mutation($repoId: ID!, $title: String!, $body: String, $labelIds: [ID!], $assigneeIds: [ID!]) {
            createIssue(input: {
              repositoryId: $repoId,
              title: $title,
              body: $body,
              labelIds: $labelIds,
              assigneeIds: $assigneeIds
            }) {
              issue {
                id
                number
                title
                url
              }
            }
          }`,
          {
            repoId,
            title: args.title,
            body: args.body || null,
            labelIds: labelIds || null,
            assigneeIds: null, // We'd need to resolve usernames to IDs; skip for now
          },
        );

        const issue = createResult.createIssue.issue;

        // Cache the node ID
        client
          .getCache()
          .set(
            `issue-node-id:${owner}/${repo}#${issue.number}`,
            issue.id,
            30 * 60 * 1000,
          );

        // Step 4: Add to project
        const projectId = fieldCache.getProjectId();
        if (!projectId) {
          return toolError(
            "Could not resolve project ID for adding issue to project",
          );
        }

        const addResult = await client.projectMutate<{
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
          { projectId, contentId: issue.id },
        );

        const projectItemId = addResult.addProjectV2ItemById.item.id;

        // Cache project item ID
        client
          .getCache()
          .set(
            `project-item-id:${owner}/${repo}#${issue.number}`,
            projectItemId,
            30 * 60 * 1000,
          );

        // Step 5: Set field values
        if (args.workflowState) {
          await updateProjectItemField(
            client,
            fieldCache,
            projectItemId,
            "Workflow State",
            args.workflowState,
          );
        }

        if (args.estimate) {
          await updateProjectItemField(
            client,
            fieldCache,
            projectItemId,
            "Estimate",
            args.estimate,
          );
        }

        if (args.priority) {
          await updateProjectItemField(
            client,
            fieldCache,
            projectItemId,
            "Priority",
            args.priority,
          );
        }

        return toolSuccess({
          number: issue.number,
          id: issue.id,
          title: issue.title,
          url: issue.url,
          projectItemId,
          fieldsSet: {
            workflowState: args.workflowState || null,
            estimate: args.estimate || null,
            priority: args.priority || null,
          },
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to create issue: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__update_issue
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__update_issue",
    "Update a GitHub issue's basic properties (title, body, labels, assignees). Returns: number, title, url. Use update_workflow_state for state changes, update_estimate for estimates, update_priority for priorities.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to GITHUB_REPO env var"),
      number: z.number().describe("Issue number"),
      title: z.string().optional().describe("New issue title"),
      body: z.string().optional().describe("New issue body (Markdown)"),
      labels: z
        .array(z.string())
        .optional()
        .describe("Label names (replaces existing labels)"),
      assignees: z
        .array(z.string())
        .optional()
        .describe("GitHub usernames to assign (replaces existing)"),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);

        const issueId = await resolveIssueNodeId(
          client,
          owner,
          repo,
          args.number,
        );

        // Resolve label IDs if provided
        let labelIds: string[] | undefined;
        if (args.labels) {
          const labelResult = await client.query<{
            repository: {
              labels: {
                nodes: Array<{ id: string; name: string }>;
              };
            };
          }>(
            `query($owner: String!, $repo: String!) {
              repository(owner: $owner, name: $repo) {
                labels(first: 100) {
                  nodes { id name }
                }
              }
            }`,
            { owner, repo },
            { cache: true, cacheTtlMs: 5 * 60 * 1000 },
          );

          const allLabels = labelResult.repository.labels.nodes;
          labelIds = args.labels
            .map((name) => allLabels.find((l) => l.name === name)?.id)
            .filter((id): id is string => id !== undefined);
        }

        const result = await client.mutate<{
          updateIssue: {
            issue: {
              number: number;
              title: string;
              url: string;
            };
          };
        }>(
          `mutation($issueId: ID!, $title: String, $body: String, $labelIds: [ID!], $assigneeIds: [ID!]) {
            updateIssue(input: {
              id: $issueId,
              title: $title,
              body: $body,
              labelIds: $labelIds,
              assigneeIds: $assigneeIds
            }) {
              issue {
                number
                title
                url
              }
            }
          }`,
          {
            issueId,
            title: args.title || null,
            body: args.body || null,
            labelIds: labelIds || null,
            assigneeIds: null, // Would need username -> ID resolution
          },
        );

        return toolSuccess({
          number: result.updateIssue.issue.number,
          title: result.updateIssue.issue.title,
          url: result.updateIssue.issue.url,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to update issue: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__update_workflow_state
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__update_workflow_state",
    "Change an issue's Workflow State using semantic intents or direct state names. Returns: number, previousState, newState, command. Semantic intents: __LOCK__ (lock for processing), __COMPLETE__ (mark done), __ESCALATE__ (needs human), __CLOSE__, __CANCEL__. Recovery: if state transition fails, verify the issue is in the project and the state name is valid.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to GITHUB_REPO env var"),
      number: z.number().describe("Issue number"),
      state: z
        .string()
        .describe(
          "Target state: semantic intent (__LOCK__, __COMPLETE__, __ESCALATE__, __CLOSE__, __CANCEL__) " +
            "or direct state name (e.g., 'Research Needed', 'In Progress')",
        ),
      command: z
        .string()
        .describe(
          "Ralph command making this transition (e.g., 'ralph_research', 'ralph_plan'). " +
            "Required for validation and semantic intent resolution.",
        ),
    },
    async (args) => {
      try {
        const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        // Resolve semantic intent or validate direct state
        const { resolvedState, wasIntent, originalState } = resolveState(
          args.state,
          args.command,
        );

        // Ensure field cache is populated
        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        // Get current state for the response
        const previousState = await getCurrentFieldValue(
          client,
          fieldCache,
          owner,
          repo,
          args.number,
          "Workflow State",
        );

        // Resolve project item ID
        const projectItemId = await resolveProjectItemId(
          client,
          fieldCache,
          owner,
          repo,
          args.number,
        );

        // Update the field with the resolved state
        await updateProjectItemField(
          client,
          fieldCache,
          projectItemId,
          "Workflow State",
          resolvedState,
        );

        const result: Record<string, unknown> = {
          number: args.number,
          previousState: previousState || "(unknown)",
          newState: resolvedState,
          command: args.command,
        };

        if (wasIntent) {
          result.resolvedFrom = originalState;
        }

        return toolSuccess(result);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to update workflow state: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__update_estimate
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__update_estimate",
    "Change an issue's Estimate in the project. Returns: number, estimate. Valid values: XS, S, M, L, XL. Recovery: if the issue is not in the project, add it first via create_issue.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to GITHUB_REPO env var"),
      number: z.number().describe("Issue number"),
      estimate: z.string().describe("Estimate value (XS, S, M, L, XL)"),
    },
    async (args) => {
      try {
        const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        const projectItemId = await resolveProjectItemId(
          client,
          fieldCache,
          owner,
          repo,
          args.number,
        );

        await updateProjectItemField(
          client,
          fieldCache,
          projectItemId,
          "Estimate",
          args.estimate,
        );

        return toolSuccess({
          number: args.number,
          estimate: args.estimate,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to update estimate: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__update_priority
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__update_priority",
    "Change an issue's Priority in the project. Returns: number, priority. Valid values: P0, P1, P2, P3. Recovery: if the issue is not in the project, add it first via create_issue.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to GITHUB_REPO env var"),
      number: z.number().describe("Issue number"),
      priority: z.string().describe("Priority value (P0, P1, P2, P3)"),
    },
    async (args) => {
      try {
        const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        const projectItemId = await resolveProjectItemId(
          client,
          fieldCache,
          owner,
          repo,
          args.number,
        );

        await updateProjectItemField(
          client,
          fieldCache,
          projectItemId,
          "Priority",
          args.priority,
        );

        return toolSuccess({
          number: args.number,
          priority: args.priority,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to update priority: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__create_comment
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__create_comment",
    "Add a comment to a GitHub issue. Returns: commentId, issueNumber. Recovery: if issue not found, verify the issue number exists in the repository.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to GITHUB_REPO env var"),
      number: z.number().describe("Issue number"),
      body: z.string().describe("Comment body (Markdown)"),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);

        const issueId = await resolveIssueNodeId(
          client,
          owner,
          repo,
          args.number,
        );

        const result = await client.mutate<{
          addComment: {
            commentEdge: {
              node: {
                id: string;
              };
            };
          };
        }>(
          `mutation($subjectId: ID!, $body: String!) {
            addComment(input: {
              subjectId: $subjectId,
              body: $body
            }) {
              commentEdge {
                node { id }
              }
            }
          }`,
          { subjectId: issueId, body: args.body },
        );

        return toolSuccess({
          commentId: result.addComment.commentEdge.node.id,
          issueNumber: args.number,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to create comment: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__detect_pipeline_position
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__detect_pipeline_position",
    "Determine which workflow phase to execute next for an issue or its group. Returns: phase (SPLIT/TRIAGE/RESEARCH/PLAN/REVIEW/IMPLEMENT/COMPLETE/HUMAN_GATE/TERMINAL), convergence status with recommendation (proceed/wait/escalate), all group member states, and remaining phases. Call this INSTEAD of separate detect_group + check_convergence calls. Recovery: if issue not found, verify the issue number and that it has been added to the project.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to GITHUB_REPO env var"),
      number: z.number().describe("Issue number (seed for group detection)"),
    },
    async (args) => {
      try {
        const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        // Ensure field cache is populated
        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        // Detect group from seed issue
        const group = await detectGroup(client, owner, repo, args.number);

        // Fetch workflow state and estimate for each group member
        const issueStates: IssueState[] = await Promise.all(
          group.groupTickets.map(async (ticket) => {
            const state = await getIssueFieldValues(
              client,
              fieldCache,
              owner,
              repo,
              ticket.number,
            );
            return {
              number: ticket.number,
              title: ticket.title,
              workflowState: state.workflowState || "unknown",
              estimate: state.estimate || null,
            };
          }),
        );

        // Detect pipeline position
        const position = detectPipelinePosition(
          issueStates,
          group.isGroup,
          group.groupPrimary.number,
        );

        return toolSuccess(position);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        // Check if it's a "not found" error
        if (message.includes("not found")) {
          return toolError(
            `Issue #${args.number} not found in project. ` +
              `Recovery: verify the issue number is correct and the issue has been added to the project ` +
              `via ralph_hero__create_issue or ralph_hero__get_issue.`,
          );
        }
        return toolError(`Failed to detect pipeline position: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__check_convergence
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__check_convergence",
    "Check if all issues in a group have reached the required state for the next phase. Returns: converged, targetState, total, ready, blocking (with distanceToTarget), recommendation (proceed/wait/escalate). Note: detect_pipeline_position already includes convergence data; use this only when checking convergence against a specific target state not covered by pipeline detection.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to GITHUB_REPO env var"),
      number: z.number().describe("Issue number (any issue in the group)"),
      targetState: z
        .string()
        .describe("The state all issues must be in (e.g., 'Ready for Plan')"),
    },
    async (args) => {
      try {
        // Validate target state
        if (!isValidState(args.targetState)) {
          return toolError(
            `Unknown target state '${args.targetState}'. ` +
              `Valid states: ${VALID_STATES.join(", ")}. ` +
              `Recovery: retry with a valid state name.`,
          );
        }

        const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        // Ensure field cache is populated
        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        // Detect group from seed issue
        const group = await detectGroup(client, owner, repo, args.number);

        // Single issue trivially converges
        if (!group.isGroup) {
          const state = await getIssueFieldValues(
            client,
            fieldCache,
            owner,
            repo,
            args.number,
          );
          const atTarget = state.workflowState === args.targetState;
          return toolSuccess({
            converged: atTarget,
            targetState: args.targetState,
            total: 1,
            ready: atTarget ? 1 : 0,
            blocking: atTarget
              ? []
              : [
                  {
                    number: args.number,
                    title: group.groupPrimary.title,
                    currentState: state.workflowState || "unknown",
                    distanceToTarget: computeDistance(
                      state.workflowState || "unknown",
                      args.targetState,
                    ),
                  },
                ],
            recommendation: atTarget ? "proceed" : "wait",
          });
        }

        // Check each group member
        const blocking: Array<{
          number: number;
          title: string;
          currentState: string;
          distanceToTarget: number;
        }> = [];

        let readyCount = 0;

        for (const ticket of group.groupTickets) {
          const state = await getIssueFieldValues(
            client,
            fieldCache,
            owner,
            repo,
            ticket.number,
          );
          const currentState = state.workflowState || "unknown";

          if (currentState === args.targetState) {
            readyCount++;
          } else {
            blocking.push({
              number: ticket.number,
              title: ticket.title,
              currentState,
              distanceToTarget: computeDistance(currentState, args.targetState),
            });
          }
        }

        const converged = blocking.length === 0;
        const hasHumanNeeded = blocking.some(
          (b) => b.currentState === "Human Needed",
        );

        let recommendation: "proceed" | "wait" | "escalate";
        if (converged) {
          recommendation = "proceed";
        } else if (hasHumanNeeded) {
          recommendation = "escalate";
        } else {
          recommendation = "wait";
        }

        return toolSuccess({
          converged,
          targetState: args.targetState,
          total: group.totalTickets,
          ready: readyCount,
          blocking,
          recommendation,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to check convergence: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__pick_actionable_issue
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__pick_actionable_issue",
    "Find the highest-priority issue matching a workflow state that is not blocked or locked. Returns: found, issue (with number, title, workflowState, estimate, priority, group context), alternatives count. Used by dispatch loop to find work for idle teammates. Recovery: if no issues found, try a different workflowState or increase maxEstimate.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to GITHUB_REPO env var"),
      workflowState: z
        .string()
        .describe(
          "Target workflow state (e.g., 'Research Needed', 'Ready for Plan')",
        ),
      maxEstimate: z
        .string()
        .optional()
        .default("S")
        .describe("Maximum estimate to include (XS, S, M, L, XL). Default: S"),
    },
    async (args) => {
      try {
        // Validate workflow state
        if (!isValidState(args.workflowState)) {
          return toolError(
            `Unknown workflow state '${args.workflowState}'. ` +
              `Valid states: ${VALID_STATES.join(", ")}. ` +
              `Recovery: retry with a valid state name. ` +
              `Common states for dispatch: 'Research Needed' (for researchers), ` +
              `'Ready for Plan' (for planners), 'Plan in Review' (for reviewers).`,
          );
        }

        // Validate estimate
        const validEstimates = ["XS", "S", "M", "L", "XL"];
        const maxEstimate = args.maxEstimate || "S";
        if (!validEstimates.includes(maxEstimate)) {
          return toolError(
            `Unknown estimate '${maxEstimate}'. ` +
              `Valid estimates: ${validEstimates.join(", ")}. ` +
              `Recovery: retry with a valid estimate or omit for default (S).`,
          );
        }

        const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        // Ensure field cache is populated
        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        const projectId = fieldCache.getProjectId();
        if (!projectId) {
          return toolError("Could not resolve project ID");
        }

        // Fetch all project items
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
                        body
                        state
                        url
                        labels(first: 10) { nodes { name } }
                        trackedIssues(first: 10) {
                          nodes { number state }
                        }
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
                      }
                    }
                  }
                }
              }
            }
          }`,
          { projectId, first: 100 },
          "node.items",
          { maxItems: 500 },
        );

        // Filter to matching items
        let candidates = itemsResult.nodes.filter((item) => {
          if (item.type !== "ISSUE" || !item.content) return false;
          const content = item.content as Record<string, unknown>;
          if (content.state !== "OPEN") return false;

          // Check workflow state
          const ws = getFieldValue(item, "Workflow State");
          if (ws !== args.workflowState) return false;

          // Check estimate
          const est = getFieldValue(item, "Estimate");
          if (est) {
            const estIdx = validEstimates.indexOf(est);
            const maxIdx = validEstimates.indexOf(maxEstimate);
            if (estIdx > maxIdx) return false;
          }

          return true;
        });

        // Filter out locked issues (in a lock state - shouldn't happen if matching target state, but safety check)
        candidates = candidates.filter((item) => {
          const ws = getFieldValue(item, "Workflow State");
          return !ws || !LOCK_STATES.includes(ws);
        });

        // Filter out issues with unresolved blockers
        candidates = candidates.filter((item) => {
          const content = item.content as Record<string, unknown>;
          const blockedBy = content.trackedIssues as
            | { nodes: Array<{ number: number; state: string }> }
            | undefined;
          if (!blockedBy?.nodes || blockedBy.nodes.length === 0) return true;
          // Issue is blocked if any blocker is still OPEN
          return !blockedBy.nodes.some((dep) => dep.state === "OPEN");
        });

        // Sort by priority (P0 > P1 > P2 > P3 > none)
        const priorityOrder: Record<string, number> = {
          P0: 0,
          P1: 1,
          P2: 2,
          P3: 3,
        };
        candidates.sort((a, b) => {
          const pA = getFieldValue(a, "Priority");
          const pB = getFieldValue(b, "Priority");
          const orderA = pA ? (priorityOrder[pA] ?? 99) : 99;
          const orderB = pB ? (priorityOrder[pB] ?? 99) : 99;
          return orderA - orderB;
        });

        if (candidates.length === 0) {
          return toolSuccess({
            found: false,
            issue: null,
            alternatives: 0,
          });
        }

        const best = candidates[0];
        const content = best.content as Record<string, unknown>;
        const issueNumber = content.number as number;

        // Detect group context for the picked issue (best-effort)
        let group: {
          isGroup: boolean;
          primary: { number: number; title: string };
          members: Array<{
            number: number;
            title: string;
            state: string;
            order: number;
          }>;
          totalTickets: number;
        } | null = null;

        try {
          const groupResult = await detectGroup(
            client,
            owner,
            repo,
            issueNumber,
          );
          group = {
            isGroup: groupResult.isGroup,
            primary: {
              number: groupResult.groupPrimary.number,
              title: groupResult.groupPrimary.title,
            },
            members: groupResult.groupTickets.map((t) => ({
              number: t.number,
              title: t.title,
              state: t.state,
              order: t.order,
            })),
            totalTickets: groupResult.totalTickets,
          };
        } catch {
          // Group detection is best-effort
          group = null;
        }

        return toolSuccess({
          found: true,
          issue: {
            number: issueNumber,
            title: content.title,
            description: content.body || "",
            workflowState: getFieldValue(best, "Workflow State"),
            estimate: getFieldValue(best, "Estimate") || null,
            priority: getFieldValue(best, "Priority") || null,
            isLocked: false,
            blockedBy: [],
          },
          group,
          alternatives: candidates.length - 1,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to pick actionable issue: ${message}`);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Internal types and helpers
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

// ---------------------------------------------------------------------------
// Helper: Get workflow state and estimate for a single issue
// ---------------------------------------------------------------------------

async function getIssueFieldValues(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<{
  workflowState: string | undefined;
  estimate: string | undefined;
  priority: string | undefined;
}> {
  const projectItemId = await resolveProjectItemId(
    client,
    fieldCache,
    owner,
    repo,
    issueNumber,
  );

  const result = await client.query<{
    node: {
      fieldValues: {
        nodes: Array<{
          __typename?: string;
          name?: string;
          field?: { name: string };
        }>;
      };
    } | null;
  }>(
    `query($itemId: ID!) {
      node(id: $itemId) {
        ... on ProjectV2Item {
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
    }`,
    { itemId: projectItemId },
  );

  let workflowState: string | undefined;
  let estimate: string | undefined;
  let priority: string | undefined;

  for (const fv of result.node?.fieldValues?.nodes || []) {
    if (fv.__typename === "ProjectV2ItemFieldSingleSelectValue" && fv.field) {
      switch (fv.field.name) {
        case "Workflow State":
          workflowState = fv.name;
          break;
        case "Estimate":
          estimate = fv.name;
          break;
        case "Priority":
          priority = fv.name;
          break;
      }
    }
  }

  return { workflowState, estimate, priority };
}

// ---------------------------------------------------------------------------
// Helper: Compute "distance" between two states in the pipeline
// ---------------------------------------------------------------------------

import { stateIndex } from "../lib/workflow-states.js";

function computeDistance(currentState: string, targetState: string): number {
  const currentIdx = stateIndex(currentState);
  const targetIdx = stateIndex(targetState);
  if (currentIdx === -1 || targetIdx === -1) return -1;
  return targetIdx - currentIdx;
}
