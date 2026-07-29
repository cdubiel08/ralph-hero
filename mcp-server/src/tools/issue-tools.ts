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
  isParentGateState,
  isLegalTransition,
  legalNextStates,
  VALID_STATES,
  LOCK_STATES,
  TERMINAL_STATES,
  WORKFLOW_STATE_TO_STATUS,
  ISSUE_STATE_TO_TERMINAL_WORKFLOW,
} from "../lib/workflow-states.js";
import { buildBatchMutationQuery } from "./batch-tools.js";
import { resolveState } from "../lib/state-resolution.js";
import { parseDateMath } from "../lib/date-math.js";
import { expandProfile } from "../lib/filter-profiles.js";
import { toolSuccess, toolError } from "../types.js";
import { zBoolish } from "../lib/zod-helpers.js";
import {
  ensureFieldCache,
  resolveIssueNodeId,
  resolveProjectItemId,
  updateProjectItemField,
  getFieldValueDetail,
  resolveConfig,
  resolveFullConfig,
  resolveFullConfigOptionalRepo,
  syncStatusField,
  autoAdvanceParent,
  resolveIterationId,
} from "../lib/helpers.js";
import { lookupRepo, mergeDefaults } from "../lib/repo-registry.js";
import {
  isLockConflict,
  isGuardedLockRelease,
  isHeldSinceStale,
  describeLockConflict,
  describeGuardedRelease,
} from "../lib/lock-guard.js";
import { resolveLockStaleHours } from "../lib/thresholds.js";
import { searchRepoIssues } from "../lib/repo-issue-search.js";

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
    "SCOPE WARNING: by default (scope: \"project\") this tool only sees issues that are items on the configured GitHub Projects V2 board — an issue that exists in the repo but was never added to that board (created by a bot/App via the REST API, predates project automation, or was manually removed from the board) will NOT appear here regardless of filters. A clean/empty result means \"not on the board\", NOT \"doesn't exist in the repo\". Pass scope: \"repo\" to search the repository directly via GitHub's Issue Search API instead, independent of Project V2 membership — use this for any \"does this issue already exist\" existence check before filing a new one. List issues from a GitHub repository with optional filters. Fetches all project items (full project scan, no silent 500-cap) and applies filters client-side, so items at any board position are visible regardless of default ordering. By default returns issues in any state (both OPEN and CLOSED) so visibility matches the dashboard family (pipeline_dashboard, next_actions, project_hygiene); pass the `state` parameter (\"OPEN\" or \"CLOSED\") to narrow. Returns: number, title, state, workflowState, estimate, priority, iteration, labels, assignees. Use workflowState filter to find issues in a specific phase. Use iteration filter with @current/@next or sprint title. Recovery: if no results, broaden filters, check that issues exist in the project, or retry with scope: \"repo\" for a repo-wide check.",
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
      scope: z
        .enum(["project", "repo"])
        .optional()
        .default("project")
        .describe(
          '"project" (default) returns items on the configured Projects V2 board only. ' +
            '"repo" searches the repository directly via GitHub\'s Issue Search API, independent ' +
            "of Project V2 membership — use this to check whether an issue exists in the repo " +
            'regardless of board status. scope: "repo" is incompatible with project-only filters ' +
            "(workflowState, estimate, priority, iteration, has, no, excludeWorkflowStates, " +
            "excludeEstimates, excludePriorities, profile, repoFilter) — combining them returns a " +
            "toolError. Repo-scope results always return workflowState/estimate/priority/iteration as null.",
        ),
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
      iteration: z
        .string()
        .optional()
        .describe(
          "Filter by iteration/sprint. Accepts iteration title (e.g., 'Sprint 1'), " +
          "@current (active sprint), or @next (upcoming sprint).",
        ),
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
        .describe(
          "Issue state filter. When omitted, returns issues in any state " +
          "(matches dashboard-family behavior). Pass 'OPEN' or 'CLOSED' to narrow.",
        ),
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
        // scope: "repo" — search the repository directly via GitHub's Issue
        // Search API, independent of Project V2 membership (GH-1572). This
        // branch is checked before profile expansion since `profile` is
        // itself a project-only filter.
        if (args.scope === "repo") {
          const PROJECT_ONLY_FILTERS: Array<[string, unknown]> = [
            ["workflowState", args.workflowState],
            ["estimate", args.estimate],
            ["priority", args.priority],
            ["iteration", args.iteration],
            ["has", args.has],
            ["no", args.no],
            ["excludeWorkflowStates", args.excludeWorkflowStates],
            ["excludeEstimates", args.excludeEstimates],
            ["excludePriorities", args.excludePriorities],
            ["profile", args.profile],
            ["repoFilter", args.repoFilter],
          ];
          const offending = PROJECT_ONLY_FILTERS.filter(
            ([, value]) =>
              value !== undefined &&
              !(Array.isArray(value) && value.length === 0),
          ).map(([key]) => key);
          if (offending.length > 0) {
            return toolError(
              `scope: "repo" is incompatible with project-only filter(s): ${offending.join(", ")}. ` +
                'These are Project V2 field values with no repo-side equivalent. Remove them or use scope: "project" (default).',
            );
          }

          const { owner, repo } = resolveConfig(client, args);
          try {
            const { nodes, truncated, totalCount } = await searchRepoIssues(
              client,
              owner,
              repo,
              {
                label: args.label,
                query: args.query,
                state: args.state,
                reason: args.reason,
                excludeLabels: args.excludeLabels,
                updatedSince: args.updatedSince,
                updatedBefore: args.updatedBefore,
                orderBy: args.orderBy,
              },
              args.limit ?? 50,
            );
            const formattedItems = nodes.map((node) => ({
              number: node.number,
              title: node.title,
              state: node.state,
              stateReason: node.stateReason ?? null,
              url: node.url,
              updatedAt: node.updatedAt ?? null,
              workflowState: null,
              estimate: null,
              priority: null,
              iteration: null,
              labels: node.labels?.nodes?.map((l) => l.name) ?? [],
              assignees: node.assignees?.nodes?.map((a) => a.login) ?? [],
            }));
            return toolSuccess({
              filteredCount: formattedItems.length,
              items: formattedItems,
              // Signal when more matches exist than were fetched (GH-1573
              // review follow-up) so callers don't mistake a capped page for
              // an exhaustive result set.
              ...(truncated
                ? {
                    incomplete: true,
                    totalCount,
                    warning: `Result truncated: ${totalCount} issue(s) matched but only ${formattedItems.length} were returned (limit ${args.limit ?? 50}). Raise limit or narrow filters to see the rest.`,
                  }
                : {}),
            });
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return toolError(`Failed to search repo issues: ${message}`);
          }
        }

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
                        ... on ProjectV2ItemFieldIterationValue {
                          __typename
                          iterationId
                          title
                          startDate
                          duration
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
          { scanUntilExhausted: true }, // Fetch all project items then filter client-side; full project scan
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

        // Filter by iteration
        if (args.iteration) {
          // Discover the iteration field name from cache
          const fieldNames = fieldCache.getFieldNames(projectNumber);
          const iterFieldName = fieldNames.find((name) => {
            const iters = fieldCache.getIterations(name, projectNumber);
            return iters !== undefined && iters.length > 0;
          });

          if (iterFieldName) {
            // Resolve the target iteration ID from title or token
            const targetIterationId = resolveIterationId(
              fieldCache, projectNumber, iterFieldName, args.iteration,
            );

            if (targetIterationId) {
              items = items.filter((item) => {
                const iterVal = getIterationValue(item);
                return iterVal?.iterationId === targetIterationId;
              });
            } else {
              // Token/title did not resolve - no items can match
              items = [];
            }
          } else {
            // No iteration field configured - no items can match
            items = [];
          }
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
          const iterVal = getIterationValue(item);
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
            iteration: iterVal
              ? { title: iterVal.title, startDate: iterVal.startDate, duration: iterVal.duration }
              : null,
            labels: (
              content?.labels as { nodes: Array<{ name: string }> }
            )?.nodes?.map((l) => l.name),
            assignees: (
              content?.assignees as { nodes: Array<{ login: string }> }
            )?.nodes?.map((a) => a.login),
          };
        });

        return toolSuccess({
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
      includeGroup: zBoolish()
        .optional()
        .default(true)
        .describe(
          "Include group detection results (default: true). Set to false to skip group detection and save API calls when group context is not needed.",
        ),
      includePipeline: zBoolish()
        .optional()
        .default(false)
        .describe(
          "Include pipeline position: phase, convergence, member states, remaining phases. Auto-enables includeGroup.",
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
              blocking: {
                nodes: Array<{ number: number; title: string; state: string }>;
              };
              blockedBy: {
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
                blocking(first: 20) {
                  nodes { number title state }
                }
                blockedBy(first: 20) {
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

        // Force includeGroup when includePipeline is requested
        const shouldIncludeGroup = args.includePipeline || args.includeGroup !== false;

        if (shouldIncludeGroup) {
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

        // Optionally detect pipeline position
        let pipeline: {
          phase: string;
          reason: string;
          remainingPhases: string[];
          convergence: unknown;
          memberStates: unknown[];
          suggestedRoster: unknown;
        } | null = null;

        if (args.includePipeline) {
          try {
            // Need resolveFullConfig for project field lookups
            const { owner: cfgOwner, repo: cfgRepo } = resolveConfig(client, args);
            const { projectNumber: pn, projectOwner: po } = resolveFullConfig(client, args);
            await ensureFieldCache(client, fieldCache, po, pn);

            // Force group if not already detected
            if (!group) {
              const groupResult = await detectGroup(client, cfgOwner, cfgRepo, args.number);
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
            }

            // Build IssueState[] from group members
            const issueStates: IssueState[] = await Promise.all(
              (group.members || []).map(async (member) => {
                if (member.number === args.number) {
                  // Use already-fetched values for the seed issue
                  return {
                    number: member.number,
                    title: member.title,
                    workflowState: workflowState || "unknown",
                    estimate: estimate || null,
                    subIssueCount: 0,
                  };
                }
                // Fetch field values for non-seed members
                const state = await getIssueFieldValues(client, fieldCache, cfgOwner, cfgRepo, member.number);
                return {
                  number: member.number,
                  title: member.title,
                  workflowState: state.workflowState || "unknown",
                  estimate: state.estimate || null,
                  subIssueCount: 0,
                };
              }),
            );

            // Fetch sub-issue counts for M/L/XL estimates
            const oversized = issueStates.filter(
              (s) => s.estimate && OVERSIZED_ESTIMATES.has(s.estimate),
            );
            if (oversized.length > 0) {
              await Promise.all(
                oversized.map(async (s) => {
                  try {
                    const subResult = await client.query<{
                      repository: {
                        issue: { subIssuesSummary: { total: number } | null } | null;
                      } | null;
                    }>(
                      `query($owner: String!, $repo: String!, $issueNum: Int!) {
                        repository(owner: $owner, name: $repo) {
                          issue(number: $issueNum) { subIssuesSummary { total } }
                        }
                      }`,
                      { owner: cfgOwner, repo: cfgRepo, issueNum: s.number },
                    );
                    if (subResult.repository?.issue?.subIssuesSummary) {
                      s.subIssueCount = subResult.repository.issue.subIssuesSummary.total;
                    }
                  } catch {
                    // Best-effort, leave at 0
                  }
                }),
              );
            }

            // Run pipeline detection
            const pipelineResult = detectPipelinePosition(
              issueStates,
              group.isGroup,
              group.primary?.number ?? null,
              { autoMode: client.config.autoMode },
            );

            pipeline = {
              phase: pipelineResult.phase,
              reason: pipelineResult.reason,
              remainingPhases: pipelineResult.remainingPhases,
              convergence: pipelineResult.convergence,
              memberStates: pipelineResult.issues,
              suggestedRoster: pipelineResult.suggestedRoster,
            };
          } catch {
            pipeline = null; // Best-effort, same as includeGroup
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
          blocking: issue.blocking.nodes.map((i) => ({
            number: i.number,
            title: i.title,
            state: i.state,
          })),
          blockedBy: issue.blockedBy.nodes.map((i) => ({
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
          ...(pipeline !== null ? { pipeline } : {}),
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
    "Create a GitHub issue and add it to the project with optional field values. By default, runs a pre-creation exact-title duplicate check against open issues (case-insensitive, whitespace-normalized) via GitHub's Issue Search API — a match returns a toolError naming the existing issue instead of creating a duplicate; pass skipDedupeCheck: true to bypass. A dedup-search failure is logged and swallowed, falling through to normal creation. Returns: number, id, title, url, projectItemId, fieldsSet. Recovery: if field value fails, verify the option name matches exactly (case-sensitive).",
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
        .min(
          1,
          'workflowState must be a non-empty state name; omit it to default to "Backlog"',
        )
        .optional()
        .describe('Initial Workflow State name (defaults to "Backlog")'),
      estimate: z.string().optional().describe("Estimate (XS, S, M, L, XL)"),
      priority: z.string().optional().describe("Priority (P0, P1, P2, P3)"),
      skipDedupeCheck: zBoolish()
        .optional()
        .default(false)
        .describe(
          "Skip the pre-creation exact-title duplicate check (default false — the check runs by default). " +
            "The check searches open issues for an exact case-insensitive, whitespace-normalized title match " +
            "via GitHub's Issue Search API and refuses creation on a match, naming the existing issue. " +
            "Pass true to bypass (e.g. known-intentional re-use of a title, bulk-seeding scripts).",
        ),
    },
    async (args) => {
      try {
        // Resolve owner from registry for repo shorthand
        let resolvedArgs = { ...args };
        const registry = client.config.repoRegistry;
        if (registry && args.repo && !args.owner) {
          const repoLookup = lookupRepo(registry, args.repo);
          if (repoLookup?.entry.owner) {
            resolvedArgs = { ...args, owner: repoLookup.entry.owner };
          }
        }

        const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(
          client,
          resolvedArgs,
        );

        // Apply registry defaults if available
        let effectiveLabels = args.labels;
        let effectiveAssignees = args.assignees;
        let effectiveEstimate = args.estimate;
        const effectiveState = args.workflowState ?? "Backlog";

        // GH-1615: create_issue is the sixth Workflow State writer and had no
        // validity check at all — effectiveState reached updateProjectItemField
        // (below) unchecked. No transition check is needed (the issue was
        // created milliseconds earlier, so current state is empty by
        // construction) — just refuse an unknown state name up front, before
        // any mutation.
        if (!isValidState(effectiveState)) {
          return toolError(
            `Unknown workflow state "${effectiveState}". ` +
              `Valid states: ${VALID_STATES.join(", ")}. ` +
              `Recovery: retry with a valid state name, or omit workflowState to default to "Backlog".`,
          );
        }

        if (registry) {
          const repoLookup = lookupRepo(registry, repo);
          if (repoLookup) {
            const merged = mergeDefaults(repoLookup.entry.defaults, {
              labels: effectiveLabels,
              assignees: effectiveAssignees,
              estimate: effectiveEstimate,
            });
            effectiveLabels = merged.labels;
            effectiveAssignees = merged.assignees;
            effectiveEstimate = merged.estimate;
          }
        }

        // Ensure field cache is populated
        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        // Pre-creation exact-title dedup check (GH-1572 Phase 3), on by
        // default. Best-effort per findExistingDebugIssue's established
        // contract: a search failure is logged and swallowed, falling
        // through to normal creation rather than blocking it.
        if (!args.skipDedupeCheck) {
          try {
            const dedupLimit = 10;
            const { nodes: candidates, truncated, totalCount } =
              await searchRepoIssues(
                client,
                owner,
                repo,
                { query: args.title, state: "OPEN" },
                dedupLimit,
              );
            const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
            const targetTitle = normalize(args.title);
            const match = candidates.find(
              (c) => normalize(c.title) === targetTitle,
            );
            if (match) {
              return toolError(
                `An open issue with this exact title already exists: #${match.number} (${match.url}). ` +
                  "Pass skipDedupeCheck: true to create anyway.",
              );
            }
            // Truncated + no match among the fetched page means the check
            // was incomplete, not exhaustive — an exact duplicate could be
            // ranked outside the fetched page. Refuse to silently proceed as
            // if the dedup check cleared (GH-1573 review follow-up); this is
            // NOT best-effort like a search failure, since we DID get a
            // result, it's just possibly incomplete.
            if (truncated) {
              return toolError(
                `More than ${dedupLimit} open issue(s) matched a title-based search for "${args.title}" ` +
                  `(${totalCount} total matches), so an exact-duplicate check could not be reached ` +
                  "exhaustively within the fetched page. Narrow the title further, or pass " +
                  "skipDedupeCheck: true if you're confident this isn't a duplicate.",
              );
            }
          } catch (error) {
            console.error(
              `[create_issue] dedup search failed (falling through to creation): ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }

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
        if (effectiveLabels && effectiveLabels.length > 0) {
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
          labelIds = effectiveLabels
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
        await updateProjectItemField(
          client,
          fieldCache,
          projectItemId,
          "Workflow State",
          effectiveState,
          projectNumber,
        );
        await syncStatusField(
          client,
          fieldCache,
          projectItemId,
          effectiveState,
          projectNumber,
        );

        if (effectiveEstimate) {
          await updateProjectItemField(
            client,
            fieldCache,
            projectItemId,
            "Estimate",
            effectiveEstimate,
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
            workflowState: effectiveState,
            estimate: effectiveEstimate || null,
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
      "and project field values (workflow state, estimate, priority, iteration) in a single call. " +
      "Supports semantic intents (__LOCK__, __COMPLETE__, etc.) for workflowState. " +
      "Auto-closes the GitHub issue when workflowState resolves to a terminal state (Done, Canceled) unless issueState is explicitly set. " +
      "Reverse inference: when issueState closes the issue (CLOSED→Done, CLOSED_NOT_PLANNED→Canceled) and no workflowState is provided, the board is advanced to the matching terminal state automatically. Explicit workflowState always wins. " +
      "Set estimate, priority, or iteration to null to clear the field. Use @current/@next tokens for iteration. " +
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
      iteration: z.string().nullable().optional()
        .describe("Iteration/sprint title (e.g., 'Sprint 1'), @current, @next, or null to clear."),
      command: z.string().optional()
        .describe("Ralph command for semantic intent resolution (e.g., 'ralph_impl'). Required when workflowState is a semantic intent."),
      force: zBoolish().optional()
        .describe("Bypass lock guard. Use only for recovery when an agent crash left an issue stuck in a lock state."),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);
        const hasIssueFields = args.title !== undefined || args.body !== undefined ||
          args.labels !== undefined || args.assignees !== undefined || args.issueState !== undefined;
        const hasProjectFields = args.workflowState !== undefined ||
          args.estimate !== undefined || args.priority !== undefined ||
          args.iteration !== undefined;

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
        let stateReason: "COMPLETED" | "NOT_PLANNED" | undefined;

        if (args.issueState === "CLOSED") {
          targetState = "CLOSED";
          stateReason = "COMPLETED";
        } else if (args.issueState === "CLOSED_NOT_PLANNED") {
          targetState = "CLOSED";
          stateReason = "NOT_PLANNED";
        } else if (args.issueState === "OPEN") {
          targetState = "OPEN";
          // reopenIssue mutation has no stateReason parameter
        }

        // Auto-close: if workflowState is terminal and issueState not explicitly set
        if (!args.issueState && resolvedWorkflowState && TERMINAL_STATES.includes(resolvedWorkflowState)) {
          targetState = "CLOSED";
          stateReason = resolvedWorkflowState === "Canceled" ? "NOT_PLANNED" : "COMPLETED";
          changes.autoClose = true;
        }

        // Reverse inference: if issueState closes the issue and no explicit workflowState,
        // default the board to the matching terminal workflow state (Done or Canceled).
        // This is the symmetric inverse of the forward auto-close path above.
        // Explicit workflowState always wins — this only fires when args.workflowState is absent.
        let inferredFromClose = false;
        if (args.workflowState === undefined && targetState === "CLOSED") {
          const key = `CLOSED:${stateReason ?? ""}`;
          const inferred = ISSUE_STATE_TO_TERMINAL_WORKFLOW[key];
          if (inferred) {
            resolvedWorkflowState = inferred;
            inferredFromClose = true;
            changes.workflowStateInferred = inferred;
          }
        }

        // 2b. GH-1615: transition legality check, hoisted ahead of ALL
        // mutation (issue AND project-field). Placement is load-bearing:
        // save_issue mutates the GitHub issue first (close/reopen/title/
        // body/labels/assignees at "3. Issue state mutations" below) and
        // only reaches the project-field block at "4." — checking at "4."
        // would let an illegal-transition call reopen/close the issue and
        // THEN refuse, leaving GitHub and the board split-brained. This
        // block hoists the project-context resolution that "4." used to do
        // at its own head, so a pre-mutation current-state read is possible
        // at all — project fields, lock guard, and transition legality now
        // share one resolution instead of three.
        //
        // Also covers the reverse-inference terminal-source case uniformly:
        // resolvedWorkflowState set via inferredFromClose runs through the
        // exact same isLegalTransition check as an explicit workflowState,
        // so re-classifying an already-terminal issue (Done -> Canceled via
        // issueState: "CLOSED_NOT_PLANNED", or the reverse) is refused
        // without force like any other illegal transition — there is no
        // "legal by construction" exemption.
        let projectContext: ReturnType<typeof resolveFullConfig> | undefined;
        let currentWorkflowState: string | undefined;
        // GH-1616: set when a same-state lock re-claim needs the Workflow
        // State field cleared then re-set in step 4a to force a fresh
        // `updatedAt` (see the clear-then-reset comment at that site for
        // why a same-value write alone does not refresh the claim clock).
        let refreshLockClaimClock = false;

        if (hasProjectFields || inferredFromClose) {
          projectContext = resolveFullConfig(client, args);
          await ensureFieldCache(client, fieldCache, projectContext.projectOwner, projectContext.projectNumber);

          if (resolvedWorkflowState !== undefined) {
            // GH-1616: getFieldValueDetail replaces the bare getCurrentFieldValue
            // read — the same fetch now also carries the field value's
            // creator/updatedAt, which is BOTH the lock guard's holder/claim-time
            // enrichment below AND (unchanged) the "could this be read at all"
            // fail-closed signal Phase 1 established (throws on a real fetch
            // failure; returns an empty detail for "genuinely unset").
            let currentFieldDetail: { name?: string; updatedAt?: string; creator?: string };
            try {
              currentFieldDetail = await getFieldValueDetail(
                client, fieldCache, owner, repo, args.number, "Workflow State", projectContext.projectNumber,
              );
            } catch (error: unknown) {
              // Fail closed: a query error or an unresolvable item is NOT the
              // same as "genuinely unset" (which isLegalTransition treats as
              // legal). Zero mutations have happened at this point.
              const message = error instanceof Error ? error.message : String(error);
              return toolError(
                `Could not determine the current state of issue #${args.number} to validate the transition: ${message}. ` +
                  `No changes were made. Recovery: verify the issue is on the project board and retry.`,
              );
            }
            currentWorkflowState = currentFieldDetail.name;

            // 2b-i. Transition legality (GH-1615).
            const illegal = !isLegalTransition(currentWorkflowState, resolvedWorkflowState);

            if (illegal && !args.force) {
              const fromLabel = currentWorkflowState ?? "(unset)";
              const legal = legalNextStates(currentWorkflowState ?? "");
              return toolError(
                `Illegal transition for #${args.number}: "${fromLabel}" -> "${resolvedWorkflowState}". ` +
                  `Legal next states from "${fromLabel}": ${legal.length > 0 ? legal.join(", ") : "(none — terminal state)"}. ` +
                  `Recovery: move through the pipeline via one of the legal states, or — for human repair ` +
                  `(e.g. reopening a closed issue) — retry with force=true; the override is recorded in the response.`,
              );
            }

            if (illegal && args.force) {
              changes.forcedTransition = { from: currentWorkflowState ?? null, to: resolvedWorkflowState };
              if (process.env.RALPH_DEBUG === "true") {
                console.error(
                  `[ralph_hero__save_issue] forced illegal transition on #${args.number}: ` +
                    `"${currentWorkflowState ?? "(unset)"}" -> "${resolvedWorkflowState}"`,
                );
              }
            }

            // 2b-ii. Guarded lock release (GH-1616 §4b) — closes the two-call
            // takeover recipe. Only the two BACKWARD release edges Phase 1
            // added are gated; completion, escalation, and terminal exits
            // (including the illegal-transition branch above, which already
            // requires force) stay unconditional. Runs even when the
            // transition above was legal — a release edge IS a legal
            // transition; legality alone does not make a live release safe.
            if (isGuardedLockRelease(currentWorkflowState, resolvedWorkflowState)) {
              const thresholdHours = resolveLockStaleHours();
              const stale = isHeldSinceStale(currentFieldDetail.updatedAt, thresholdHours);
              if (!stale && !args.force) {
                return toolError(
                  describeGuardedRelease(
                    args.number, currentWorkflowState!, resolvedWorkflowState,
                    currentFieldDetail.updatedAt, thresholdHours,
                  ),
                );
              }
              changes.lockReleased = {
                previousState: currentWorkflowState,
                heldSince: currentFieldDetail.updatedAt ?? null,
                forced: !stale && !!args.force,
              };
              if (process.env.RALPH_DEBUG === "true") {
                console.error(
                  `[ralph_hero__save_issue] lock released on #${args.number}: ` +
                    `"${currentWorkflowState}" -> "${resolvedWorkflowState}" (stale=${stale}, forced=${!!args.force})`,
                );
              }
            }

            // 2b-iii. Lock conflict guard (GH-652, enriched GH-1616). Moved
            // here from the old "4. Project-field mutations" block — that
            // placement let an illegal-lock-conflict call already run the
            // issue mutation (step 3, below) before refusing, the same
            // split-brain class Phase 1 fixed for transition legality.
            if (resolvedWorkflowState && LOCK_STATES.includes(resolvedWorkflowState)) {
              if (currentWorkflowState === resolvedWorkflowState) {
                // Same-state re-claim: visible, not silent (Design Decisions).
                changes.lockReclaim = { heldSince: currentFieldDetail.updatedAt ?? null };
                refreshLockClaimClock = true;
              } else if (isLockConflict(currentWorkflowState, resolvedWorkflowState)) {
                if (!args.force) {
                  return toolError(
                    describeLockConflict(
                      args.number, currentWorkflowState!, resolvedWorkflowState,
                      currentFieldDetail.creator, currentFieldDetail.updatedAt,
                    ),
                  );
                }
                changes.forcedLockOverride = {
                  previousState: currentWorkflowState,
                  holder: currentFieldDetail.creator ?? null,
                  heldSince: currentFieldDetail.updatedAt ?? null,
                };
                if (process.env.RALPH_DEBUG === "true") {
                  console.error(
                    `[ralph_hero__save_issue] forced lock override on #${args.number}: ` +
                      `"${currentWorkflowState}" -> "${resolvedWorkflowState}" (holder=${currentFieldDetail.creator ?? "unknown"})`,
                  );
                }
              }
            }
          }
        }

        // 3. Issue state mutations (close/reopen) - use dedicated mutations
        const hasMetadataFields = args.title !== undefined || args.body !== undefined ||
          args.labels !== undefined || args.assignees !== undefined;
        const needsIssueMutation = hasMetadataFields || targetState !== undefined;

        if (needsIssueMutation) {
          const issueId = await resolveIssueNodeId(client, owner, repo, args.number);

          // 3a. Close issue (uses closeIssue mutation which accepts stateReason)
          if (targetState === "CLOSED") {
            await client.mutate<{
              closeIssue: {
                issue: { number: number; state: string; stateReason: string | null };
              };
            }>(
              `mutation($issueId: ID!, $stateReason: IssueClosedStateReason) {
                closeIssue(input: { issueId: $issueId, stateReason: $stateReason }) {
                  issue { number state stateReason }
                }
              }`,
              { issueId, stateReason: stateReason ?? null },
            );
            if (args.issueState !== undefined) changes.issueState = args.issueState;
          }

          // 3b. Reopen issue (uses reopenIssue mutation, no stateReason)
          if (targetState === "OPEN") {
            await client.mutate<{
              reopenIssue: {
                issue: { number: number; state: string };
              };
            }>(
              `mutation($issueId: ID!) {
                reopenIssue(input: { issueId: $issueId }) {
                  issue { number state }
                }
              }`,
              { issueId },
            );
            if (args.issueState !== undefined) changes.issueState = args.issueState;
          }

          // 3c. Metadata update (uses updateIssue, NO state/stateReason fields)
          if (hasMetadataFields) {
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

            // Resolve assignee IDs if provided
            let assigneeIds: string[] | undefined;
            if (args.assignees) {
              assigneeIds = [];
              for (const username of args.assignees) {
                const userResult = await client.query<{
                  user: { id: string } | null;
                }>(
                  `query($login: String!) { user(login: $login) { id } }`,
                  { login: username },
                  { cache: true, cacheTtlMs: 5 * 60 * 1000 },
                );
                if (userResult.user) {
                  assigneeIds.push(userResult.user.id);
                }
              }
            }

            // Build mutation dynamically to avoid sending null for unprovided fields
            // (GitHub treats null as "clear" not "leave unchanged")
            const varDefs: string[] = ["$issueId: ID!"];
            const inputFields: string[] = ["id: $issueId"];
            const variables: Record<string, unknown> = { issueId };

            if (args.title !== undefined) {
              varDefs.push("$title: String");
              inputFields.push("title: $title");
              variables.title = args.title;
            }
            if (args.body !== undefined) {
              varDefs.push("$body: String");
              inputFields.push("body: $body");
              variables.body = args.body;
            }
            if (labelIds !== undefined) {
              varDefs.push("$labelIds: [ID!]");
              inputFields.push("labelIds: $labelIds");
              variables.labelIds = labelIds;
            }
            if (assigneeIds !== undefined) {
              varDefs.push("$assigneeIds: [ID!]");
              inputFields.push("assigneeIds: $assigneeIds");
              variables.assigneeIds = assigneeIds;
            }

            await client.mutate<{
              updateIssue: {
                issue: { number: number; title: string; url: string };
              };
            }>(
              `mutation(${varDefs.join(", ")}) {
                updateIssue(input: { ${inputFields.join(", ")} }) {
                  issue { number title url }
                }
              }`,
              variables,
            );

            if (args.title !== undefined) changes.title = args.title;
            if (args.body !== undefined) changes.body = "(updated)";
            if (args.labels !== undefined) changes.labels = args.labels;
            if (args.assignees !== undefined) changes.assignees = args.assignees;
          }
        }

        // 4. Project-field mutations (aliased batch for workflow state + status sync + estimate + priority)
        // Also fires when workflowState was inferred from issueState (reverse-close inference).
        if (hasProjectFields || inferredFromClose) {
          // GH-1615: projectContext was already resolved above (step 2b), ahead
          // of the issue-mutation block — reused here rather than re-resolved.
          const { projectNumber } = projectContext!;

          const projectItemId = await resolveProjectItemId(
            client, fieldCache, owner, repo, args.number, projectNumber,
          );
          const projectId = fieldCache.getProjectId(projectNumber);
          if (!projectId) {
            return toolError("Could not resolve project ID");
          }

          // GH-1616: the lock-conflict guard, the guarded-release gate, and
          // the transition-legality check all now run in step 2b, ahead of
          // the issue-mutation block (step 3) — NOT here. Checking here (the
          // pre-GH-1616 placement) let an illegal-lock-conflict call already
          // run the GitHub issue mutation before refusing, split-braining
          // GitHub and the board exactly like the transition-legality bug
          // Phase 1 fixed. See step 2b-ii/2b-iii above.

          // Collect field updates for aliased batch mutation
          const updates: Array<{ alias: string; itemId: string; fieldId: string; optionId: string; valueType?: "singleSelectOptionId" | "iterationId" }> = [];
          // Collect fields to clear (separate mutations)
          const fieldsToClear: Array<{ fieldName: string; fieldId: string }> = [];
          let opIdx = 0;

          // 4a. Workflow state
          if (resolvedWorkflowState) {
            const fieldId = fieldCache.getFieldId("Workflow State", projectNumber);
            const optionId = fieldId ? fieldCache.resolveOptionId("Workflow State", resolvedWorkflowState, projectNumber) : undefined;
            if (fieldId && optionId) {
              // GH-1617 calibration: writing the SAME option value twice via
              // `updateProjectV2ItemFieldValue` does NOT bump the field
              // value's `updatedAt` — confirmed empirically against a live
              // project item (a same-value Priority write left `updatedAt`
              // unchanged). A same-state lock re-claim would therefore keep
              // reading as its ORIGINAL claim time indefinitely, eventually
              // reading as stale under GH-1616's release gate even for an
              // agent actively resuming its own work. Clearing the field
              // first makes the following aliased mutation create a
              // genuinely NEW field-value record (fresh createdAt/updatedAt)
              // instead of a same-value no-op write — this is the only
              // reliable way to refresh the claim clock on the API surface
              // observed. Scoped to lock re-claims only (see
              // `refreshLockClaimClock` at step 2b-iii); every other write
              // path is unaffected.
              if (refreshLockClaimClock) {
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
                // The field is UNSET right now. Deferring the re-set to the
                // aliased batch at step 4e leaves a window where a failure
                // there (rate limit, 502, token expiry) unwinds to the outer
                // catch with the lock DESTROYED — and an absent state is
                // permissive to both isLegalTransition and isLockConflict, so
                // any agent could then claim the issue. Re-set immediately and
                // adjacently instead, and if that fails, say so in terms the
                // caller can act on rather than reporting a generic error.
                try {
                  await updateProjectItemField(
                    client,
                    fieldCache,
                    projectItemId,
                    "Workflow State",
                    resolvedWorkflowState,
                    projectNumber,
                  );
                } catch (refreshError: unknown) {
                  const cause =
                    refreshError instanceof Error
                      ? refreshError.message
                      : String(refreshError);
                  return toolError(
                    `Lock-claim refresh on #${args.number} cleared "Workflow State" but failed to ` +
                      `restore it — the field may currently be unset, which leaves the issue ` +
                      `claimable by any agent. Recovery: re-run ` +
                      `save_issue(number: ${args.number}, workflowState: "${resolvedWorkflowState}"). ` +
                      `Cause: ${cause}`,
                  );
                }
                // Re-set already applied above; do not queue a duplicate write
                // into the aliased batch. `changes.lockReclaim` was recorded at
                // step 2b-iii and `changes.workflowState` is set below for both
                // branches.
              } else {
                updates.push({ alias: `ws_${opIdx}`, itemId: projectItemId, fieldId, optionId });
                opIdx++;
              }

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

          // 4d. Iteration (set, resolve token, or clear)
          if (args.iteration !== undefined) {
            const fieldNames = fieldCache.getFieldNames(projectNumber);
            const iterFieldName = fieldNames.find((name) => {
              const iters = fieldCache.getIterations(name, projectNumber);
              return iters !== undefined && iters.length > 0;
            });

            if (iterFieldName) {
              const fieldId = fieldCache.getFieldId(iterFieldName, projectNumber);
              if (args.iteration === null) {
                // Clear the iteration field
                if (fieldId) {
                  fieldsToClear.push({ fieldName: iterFieldName, fieldId });
                }
                changes.iteration = null;
              } else {
                // Set iteration by title or token (@current, @next)
                const iterationId = resolveIterationId(
                  fieldCache, projectNumber, iterFieldName, args.iteration,
                );
                if (fieldId && iterationId) {
                  updates.push({
                    alias: `iter_${opIdx}`,
                    itemId: projectItemId,
                    fieldId,
                    optionId: iterationId,
                    valueType: "iterationId",
                  });
                  opIdx++;
                }
                changes.iteration = args.iteration;
              }
            }
          }

          // 4e. Execute aliased batch mutation for non-null field updates
          if (updates.length > 0) {
            const { mutationString, variables } = buildBatchMutationQuery(projectId, updates);
            await client.projectMutate(mutationString, variables);
          }

          // 4f. Execute clear mutations for null fields (separate calls)
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

          // 4g. Auto-advance parent if we just moved to a gate state
          if (resolvedWorkflowState && isParentGateState(resolvedWorkflowState)) {
            try {
              const advanceResult = await autoAdvanceParent(
                client,
                fieldCache,
                owner,
                repo,
                args.number,
                resolvedWorkflowState,
                projectNumber,
              );
              if (advanceResult?.advanced) {
                changes.parentAdvanced = {
                  number: advanceResult.parentNumber,
                  toState: advanceResult.toState,
                };
              } else if (advanceResult?.skippedReason) {
                // A parent-gate refusal is a silent no-op otherwise: the caller
                // sees the child advance and reasonably assumes the parent
                // followed. Surfacing the reason is what makes "escalated" /
                // "locked" / "unrecognized" parents diagnosable without digging
                // through the debug log.
                changes.parentAdvanceSkipped = {
                  number: advanceResult.parentNumber,
                  reason: advanceResult.skippedReason,
                };
              }
            } catch {
              // Best-effort: don't fail the primary save_issue operation
            }
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
      iterationId?: string;
      title?: string;
      startDate?: string;
      duration?: number;
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

function getIterationValue(
  item: RawProjectItem,
): { iterationId: string; title: string; startDate: string; duration: number; fieldName: string } | undefined {
  const fv = item.fieldValues.nodes.find(
    (fv) => fv.__typename === "ProjectV2ItemFieldIterationValue",
  );
  if (fv?.iterationId && fv.title && fv.startDate != null && fv.duration != null && fv.field?.name) {
    return {
      iterationId: fv.iterationId,
      title: fv.title,
      startDate: fv.startDate,
      duration: fv.duration,
      fieldName: fv.field.name,
    };
  }
  return undefined;
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

