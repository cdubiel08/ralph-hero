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
  OVERSIZED_ESTIMATES,
  type IssueState,
} from "../lib/pipeline-detection.js";
import {
  isValidState,
  isEarlierState,
  VALID_STATES,
  LOCK_STATES,
  TERMINAL_STATES,
  WORKFLOW_STATE_TO_STATUS,
} from "../lib/workflow-states.js";
import { buildBatchMutationQuery } from "./batch-tools.js";
import { resolveState } from "../lib/state-resolution.js";
import { parseDateMath } from "../lib/date-math.js";
import { expandProfile } from "../lib/filter-profiles.js";
import { toolSuccess, toolError } from "../types.js";
import {
  ensureFieldCache,
  resolveIssueNodeId,
  resolveProjectItemId,
  updateProjectItemField,
  getCurrentFieldValue,
  resolveConfig,
  resolveFullConfig,
  resolveFullConfigOptionalRepo,
  syncStatusField,
} from "../lib/helpers.js";

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
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
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
        .describe("Filter by Estimate (XS, S, M, L, XL)"),
      priority: z
        .string()
        .optional()
        .describe("Filter by Priority (P0, P1, P2, P3)"),
      label: z.string().optional().describe("Filter by label name"),
      repoFilter: z
        .string()
        .optional()
        .describe(
          "Filter items to only those from the specified repository. " +
            "Accepts 'name' or 'owner/name' format. Case-insensitive.",
        ),
      query: z.string().optional().describe("Additional search query string"),
      state: z
        .enum(["OPEN", "CLOSED"])
        .optional()
        .default("OPEN")
        .describe("Issue state filter (default: OPEN)"),
      reason: z
        .enum(["completed", "not_planned", "reopened"])
        .optional()
        .describe(
          "Filter by close reason: completed, not_planned, reopened",
        ),
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
      excludeLabels: z
        .array(z.string())
        .optional()
        .describe(
          "Exclude items that have ANY of these labels " +
          '(e.g., ["wontfix", "duplicate"])',
        ),
      updatedSince: z
        .string()
        .optional()
        .describe(
          "Include items updated on or after this date. Supports date-math (@today-7d, @now-24h) or ISO dates (YYYY-MM-DD).",
        ),
      updatedBefore: z
        .string()
        .optional()
        .describe(
          "Include items updated before this date. Supports date-math (@today-7d, @now-24h) or ISO dates (YYYY-MM-DD).",
        ),
      orderBy: z
        .enum(["CREATED_AT", "UPDATED_AT", "COMMENTS"])
        .optional()
        .default("CREATED_AT")
        .describe("Order by field"),
      limit: z
        .coerce.number()
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

        const { owner, repo, projectNumber, projectOwner } = resolveFullConfigOptionalRepo(
          client,
          args,
        );

        // Ensure field cache is populated
        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        const projectId = fieldCache.getProjectId(projectNumber);
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
                        stateReason
                        url
                        createdAt
                        updatedAt
                        labels(first: 10) { nodes { name } }
                        assignees(first: 5) { nodes { login } }
                        repository { name nameWithOwner }
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

        // Filter by close reason (stateReason)
        if (args.reason) {
          const reasonUpper = args.reason.toUpperCase();
          items = items.filter((item) => {
            const content = item.content as Record<string, unknown> | null;
            return content?.stateReason === reasonUpper;
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

        // Filter by repository
        if (args.repoFilter) {
          const rf = args.repoFilter.toLowerCase();
          const useFullName = rf.includes("/");
          items = items.filter((item) => {
            const content = item.content as Record<string, unknown> | null;
            const repo = content?.repository as
              | { name?: string; nameWithOwner?: string }
              | undefined;
            const repoName = useFullName
              ? repo?.nameWithOwner?.toLowerCase()
              : repo?.name?.toLowerCase();
            return repoName === rf;
          });
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

        // Filter by excluded labels
        if (args.excludeLabels && args.excludeLabels.length > 0) {
          items = items.filter((item) => {
            const content = item.content as Record<string, unknown> | null;
            const labels =
              (content?.labels as { nodes: Array<{ name: string }> })?.nodes || [];
            return !labels.some((l) => args.excludeLabels!.includes(l.name));
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
            stateReason: content?.stateReason ?? null,
            url: content?.url,
            updatedAt: content?.updatedAt ?? null,
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
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
      number: z.coerce.number().describe("Issue number"),
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
        const projectNumber = args.projectNumber ?? client.config.projectNumber;

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
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
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
        const projectId = fieldCache.getProjectId(projectNumber);
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
            projectNumber,
          );
        }

        if (args.estimate) {
          await updateProjectItemField(
            client,
            fieldCache,
            projectItemId,
            "Estimate",
            args.estimate,
            projectNumber,
          );
        }

        if (args.priority) {
          await updateProjectItemField(
            client,
            fieldCache,
            projectItemId,
            "Priority",
            args.priority,
            projectNumber,
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
  // ralph_hero__save_issue
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__save_issue",
    "Unified issue mutation: update any combination of issue properties (title, body, labels, assignees, open/close) " +
      "and project field values (workflow state, estimate, priority) in a single call. " +
      "Supports semantic intents (__LOCK__, __COMPLETE__, etc.) for workflowState. " +
      "Auto-closes the GitHub issue when workflowState resolves to a terminal state (Done, Canceled) unless issueState is explicitly set. " +
      "Set estimate or priority to null to clear the field. " +
      "Returns: number, url, changes.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z.string().optional().describe("Repository name. Defaults to GITHUB_REPO env var"),
      projectNumber: z.coerce.number().optional().describe("Project number override (defaults to configured project)"),
      number: z.coerce.number().describe("Issue number"),
      // Issue object fields (GitHub Issue API)
      title: z.string().optional().describe("New issue title"),
      body: z.string().optional().describe("New issue body (Markdown)"),
      labels: z.array(z.string()).optional().describe("Label names (replaces existing labels)"),
      assignees: z.array(z.string()).optional().describe("GitHub usernames to assign (replaces existing)"),
      issueState: z.enum(["OPEN", "CLOSED", "CLOSED_NOT_PLANNED"]).optional()
        .describe("Close or reopen the issue. CLOSED = completed, CLOSED_NOT_PLANNED = not planned, OPEN = reopen"),
      // Project field values (ProjectV2Item API)
      workflowState: z.string().optional()
        .describe("Workflow state: semantic intent (__LOCK__, __COMPLETE__, etc.) or direct name. Requires command when using semantic intents."),
      estimate: z.enum(["XS", "S", "M", "L", "XL"]).nullable().optional()
        .describe("Estimate. Set to null to clear."),
      priority: z.enum(["P0", "P1", "P2", "P3"]).nullable().optional()
        .describe("Priority. Set to null to clear."),
      command: z.string().optional()
        .describe("Ralph command for semantic intent resolution (e.g., 'ralph_impl'). Required when workflowState is a semantic intent."),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);
        const hasIssueFields = args.title !== undefined || args.body !== undefined ||
          args.labels !== undefined || args.assignees !== undefined || args.issueState !== undefined;
        const hasProjectFields = args.workflowState !== undefined ||
          args.estimate !== undefined || args.priority !== undefined;

        if (!hasIssueFields && !hasProjectFields) {
          return toolError("No fields to update. Provide at least one field.");
        }

        const changes: Record<string, unknown> = {};
        let resolvedWorkflowState: string | undefined;

        // 1. Resolve workflow state early (needed for auto-close logic)
        if (args.workflowState !== undefined) {
          if (args.command) {
            const resolution = resolveState(args.workflowState, args.command);
            resolvedWorkflowState = resolution.resolvedState;
            if (resolution.wasIntent) {
              changes.resolvedFrom = resolution.originalState;
            }
          } else {
            // Direct state name without command — validate it's a known state
            if (!isValidState(args.workflowState)) {
              return toolError(
                `Unknown workflow state "${args.workflowState}". ` +
                `Valid states: ${VALID_STATES.join(", ")}. ` +
                `For semantic intents (__LOCK__, __COMPLETE__, etc.), provide the command parameter.`,
              );
            }
            resolvedWorkflowState = args.workflowState;
          }
        }

        // 2. Determine if we need to close/reopen the issue
        let targetState: "OPEN" | "CLOSED" | undefined;
        let stateReason: "COMPLETED" | "NOT_PLANNED" | "REOPENED" | undefined;

        if (args.issueState === "CLOSED") {
          targetState = "CLOSED";
          stateReason = "COMPLETED";
        } else if (args.issueState === "CLOSED_NOT_PLANNED") {
          targetState = "CLOSED";
          stateReason = "NOT_PLANNED";
        } else if (args.issueState === "OPEN") {
          targetState = "OPEN";
          stateReason = "REOPENED";
        }

        // Auto-close: if workflowState is terminal and issueState not explicitly set
        if (!args.issueState && resolvedWorkflowState && TERMINAL_STATES.includes(resolvedWorkflowState)) {
          targetState = "CLOSED";
          stateReason = resolvedWorkflowState === "Canceled" ? "NOT_PLANNED" : "COMPLETED";
          changes.autoClose = true;
        }

        // 3. Issue-object mutation (title, body, labels, assignees, state)
        const needsIssueMutation = hasIssueFields || targetState !== undefined;
        if (needsIssueMutation) {
          const issueId = await resolveIssueNodeId(client, owner, repo, args.number);

          // Resolve label IDs if provided
          let labelIds: string[] | undefined;
          if (args.labels) {
            const labelResult = await client.query<{
              repository: {
                labels: { nodes: Array<{ id: string; name: string }> };
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

          await client.mutate<{
            updateIssue: {
              issue: { number: number; title: string; url: string; state: string; stateReason: string | null };
            };
          }>(
            `mutation($issueId: ID!, $title: String, $body: String, $labelIds: [ID!], $assigneeIds: [ID!], $state: IssueState, $stateReason: IssueClosedStateReason) {
              updateIssue(input: {
                id: $issueId,
                title: $title,
                body: $body,
                labelIds: $labelIds,
                assigneeIds: $assigneeIds,
                state: $state,
                stateReason: $stateReason
              }) {
                issue { number title url state stateReason }
              }
            }`,
            {
              issueId,
              title: args.title ?? null,
              body: args.body ?? null,
              labelIds: labelIds ?? null,
              assigneeIds: null, // Would need username -> ID resolution
              state: targetState ?? null,
              stateReason: stateReason ?? null,
            },
          );

          if (args.title !== undefined) changes.title = args.title;
          if (args.body !== undefined) changes.body = "(updated)";
          if (args.labels !== undefined) changes.labels = args.labels;
          if (args.assignees !== undefined) changes.assignees = args.assignees;
          if (args.issueState !== undefined) changes.issueState = args.issueState;
        }

        // 4. Project-field mutations (aliased batch for workflow state + status sync + estimate + priority)
        if (hasProjectFields) {
          const { projectNumber, projectOwner } = resolveFullConfig(client, args);
          await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

          const projectItemId = await resolveProjectItemId(
            client, fieldCache, owner, repo, args.number, projectNumber,
          );
          const projectId = fieldCache.getProjectId(projectNumber);
          if (!projectId) {
            return toolError("Could not resolve project ID");
          }

          // Collect field updates for aliased batch mutation
          const updates: Array<{ alias: string; itemId: string; fieldId: string; optionId: string }> = [];
          // Collect fields to clear (separate mutations)
          const fieldsToClear: Array<{ fieldName: string; fieldId: string }> = [];
          let opIdx = 0;

          // 4a. Workflow state
          if (resolvedWorkflowState) {
            const fieldId = fieldCache.getFieldId("Workflow State", projectNumber);
            const optionId = fieldId ? fieldCache.resolveOptionId("Workflow State", resolvedWorkflowState, projectNumber) : undefined;
            if (fieldId && optionId) {
              updates.push({ alias: `ws_${opIdx}`, itemId: projectItemId, fieldId, optionId });
              opIdx++;

              // Status sync (inline, same pattern as batch-tools.ts)
              const targetStatus = WORKFLOW_STATE_TO_STATUS[resolvedWorkflowState];
              if (targetStatus) {
                const statusFieldId = fieldCache.getFieldId("Status", projectNumber);
                const statusOptionId = statusFieldId
                  ? fieldCache.resolveOptionId("Status", targetStatus, projectNumber)
                  : undefined;
                if (statusFieldId && statusOptionId) {
                  updates.push({ alias: `ss_${opIdx}`, itemId: projectItemId, fieldId: statusFieldId, optionId: statusOptionId });
                  opIdx++;
                }
              }
            }
            changes.workflowState = resolvedWorkflowState;
          }

          // 4b. Estimate (set or clear)
          if (args.estimate !== undefined) {
            if (args.estimate === null) {
              const fieldId = fieldCache.getFieldId("Estimate", projectNumber);
              if (fieldId) {
                fieldsToClear.push({ fieldName: "Estimate", fieldId });
              }
              changes.estimate = null;
            } else {
              const fieldId = fieldCache.getFieldId("Estimate", projectNumber);
              const optionId = fieldId ? fieldCache.resolveOptionId("Estimate", args.estimate, projectNumber) : undefined;
              if (fieldId && optionId) {
                updates.push({ alias: `est_${opIdx}`, itemId: projectItemId, fieldId, optionId });
                opIdx++;
              }
              changes.estimate = args.estimate;
            }
          }

          // 4c. Priority (set or clear)
          if (args.priority !== undefined) {
            if (args.priority === null) {
              const fieldId = fieldCache.getFieldId("Priority", projectNumber);
              if (fieldId) {
                fieldsToClear.push({ fieldName: "Priority", fieldId });
              }
              changes.priority = null;
            } else {
              const fieldId = fieldCache.getFieldId("Priority", projectNumber);
              const optionId = fieldId ? fieldCache.resolveOptionId("Priority", args.priority, projectNumber) : undefined;
              if (fieldId && optionId) {
                updates.push({ alias: `pri_${opIdx}`, itemId: projectItemId, fieldId, optionId });
                opIdx++;
              }
              changes.priority = args.priority;
            }
          }

          // 4d. Execute aliased batch mutation for non-null field updates
          if (updates.length > 0) {
            const { mutationString, variables } = buildBatchMutationQuery(projectId, updates);
            await client.projectMutate(mutationString, variables);
          }

          // 4e. Execute clear mutations for null fields (separate calls)
          for (const { fieldId } of fieldsToClear) {
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
          }
        }

        return toolSuccess({
          number: args.number,
          url: `https://github.com/${owner}/${repo}/issues/${args.number}`,
          changes,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to save issue: ${message}`);
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
      number: z.coerce.number().describe("Issue number"),
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
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
      number: z.coerce.number().describe("Issue number"),
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
          projectNumber,
        );

        // Resolve project item ID
        const projectItemId = await resolveProjectItemId(
          client,
          fieldCache,
          owner,
          repo,
          args.number,
          projectNumber,
        );

        // Update the field with the resolved state
        await updateProjectItemField(
          client,
          fieldCache,
          projectItemId,
          "Workflow State",
          resolvedState,
          projectNumber,
        );

        // Sync default Status field (best-effort, one-way)
        await syncStatusField(client, fieldCache, projectItemId, resolvedState, projectNumber);

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
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
      number: z.coerce.number().describe("Issue number"),
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
          projectNumber,
        );

        await updateProjectItemField(
          client,
          fieldCache,
          projectItemId,
          "Estimate",
          args.estimate,
          projectNumber,
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
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
      number: z.coerce.number().describe("Issue number"),
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
          projectNumber,
        );

        await updateProjectItemField(
          client,
          fieldCache,
          projectItemId,
          "Priority",
          args.priority,
          projectNumber,
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
      number: z.coerce.number().describe("Issue number"),
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
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
      number: z.coerce.number().describe("Issue number (seed for group detection)"),
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
              subIssueCount: 0,
            };
          }),
        );

        // Fetch sub-issue counts for oversized issues (targeted query, not all issues)
        const oversizedNumbers = issueStates
          .filter((i) => i.estimate !== null && OVERSIZED_ESTIMATES.has(i.estimate))
          .map((i) => i.number);

        if (oversizedNumbers.length > 0) {
          await Promise.all(
            oversizedNumbers.map(async (num) => {
              const subResult = await client.query<{
                repository: {
                  issue: { subIssuesSummary: { total: number } | null } | null;
                } | null;
              }>(
                `query($owner: String!, $repo: String!, $issueNum: Int!) {
                  repository(owner: $owner, name: $repo) {
                    issue(number: $issueNum) {
                      subIssuesSummary { total }
                    }
                  }
                }`,
                { owner, repo, issueNum: num },
              );
              const issueState = issueStates.find((i) => i.number === num);
              if (issueState && subResult.repository?.issue?.subIssuesSummary) {
                issueState.subIssueCount = subResult.repository.issue.subIssuesSummary.total;
              }
            }),
          );
        }

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
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
      number: z.coerce.number().describe("Issue number (any issue in the group)"),
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
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
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

        const projectId = fieldCache.getProjectId(projectNumber);
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
    // Note: getIssueFieldValues is an internal helper called from tools that
    // already resolve the project via ensureFieldCache. The default project
    // context is correct here since callers already populated the cache.
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
