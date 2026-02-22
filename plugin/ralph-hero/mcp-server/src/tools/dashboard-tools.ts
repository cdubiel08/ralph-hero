/**
 * MCP tool for pipeline dashboard and status visualization.
 *
 * Provides a single `ralph_hero__pipeline_dashboard` tool that
 * aggregates project items by workflow phase, detects health issues,
 * and formats output as JSON, markdown, or ASCII.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import { paginateConnection } from "../lib/pagination.js";
import {
  buildDashboard,
  formatMarkdown,
  formatAscii,
  type DashboardItem,
  type HealthConfig,
  DEFAULT_HEALTH_CONFIG,
} from "../lib/dashboard.js";
import { toolSuccess, toolError, resolveProjectOwner, resolveProjectNumbers } from "../types.js";
import { detectWorkStreams, type IssueFileOwnership } from "../lib/work-stream-detection.js";
import { detectStreamPipelinePositions, type IssueState } from "../lib/pipeline-detection.js";
import {
  calculateMetrics,
  DEFAULT_METRICS_CONFIG,
  type MetricsConfig,
} from "../lib/metrics.js";

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

  const project = await fetchProjectForCache(client, owner, projectNumber);
  if (!project) {
    throw new Error(`Project #${projectNumber} not found for owner "${owner}"`);
  }

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
// Raw item shape from GraphQL
// ---------------------------------------------------------------------------

export interface RawDashboardItem {
  id: string;
  type: string;
  content: {
    __typename?: string;
    number?: number;
    title?: string;
    state?: string;
    updatedAt?: string;
    closedAt?: string | null;
    assignees?: { nodes: Array<{ login: string }> };
    trackedInIssues?: { nodes: Array<{ number: number; state: string }> };
  } | null;
  fieldValues: {
    nodes: Array<{
      __typename?: string;
      name?: string;
      field?: { name: string };
    }>;
  };
}

function getFieldValue(
  item: RawDashboardItem,
  fieldName: string,
): string | null {
  const fv = item.fieldValues.nodes.find(
    (n) =>
      n.field?.name === fieldName &&
      n.__typename === "ProjectV2ItemFieldSingleSelectValue",
  );
  return fv?.name ?? null;
}

/**
 * Convert raw GraphQL project items to DashboardItem[].
 * When projectNumber/projectTitle are provided, they are set on each item
 * for multi-project dashboard support.
 */
export function toDashboardItems(
  raw: RawDashboardItem[],
  projectNumber?: number,
  projectTitle?: string,
): DashboardItem[] {
  const items: DashboardItem[] = [];

  for (const r of raw) {
    // Only include issues (not PRs or drafts)
    if (!r.content || r.content.__typename !== "Issue") continue;
    if (r.content.number === undefined) continue;

    items.push({
      number: r.content.number,
      title: r.content.title ?? "(untitled)",
      updatedAt: r.content.updatedAt ?? new Date(0).toISOString(),
      closedAt: r.content.closedAt ?? null,
      workflowState: getFieldValue(r, "Workflow State"),
      priority: getFieldValue(r, "Priority"),
      estimate: getFieldValue(r, "Estimate"),
      assignees:
        r.content.assignees?.nodes?.map((a) => a.login) ?? [],
      blockedBy: [], // blockedBy requires separate queries; omit for now
      ...(projectNumber !== undefined ? { projectNumber } : {}),
      ...(projectTitle !== undefined ? { projectTitle } : {}),
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// GraphQL query for dashboard items
// ---------------------------------------------------------------------------

export const DASHBOARD_ITEMS_QUERY = `query($projectId: ID!, $cursor: String, $first: Int!) {
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
              __typename
              number
              title
              state
              updatedAt
              closedAt
              assignees(first: 5) { nodes { login } }
            }
            ... on PullRequest {
              __typename
              number
              title
              state
            }
            ... on DraftIssue {
              __typename
              title
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
}`;

// ---------------------------------------------------------------------------
// Register dashboard tools
// ---------------------------------------------------------------------------

export function registerDashboardTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  server.tool(
    "ralph_hero__pipeline_dashboard",
    "Generate pipeline status dashboard with issue counts per workflow phase, health indicators, and formatted output. Returns structured data with optional markdown or ASCII rendering.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      projectNumbers: z
        .array(z.coerce.number())
        .optional()
        .describe(
          "Project numbers to include. Defaults to RALPH_GH_PROJECT_NUMBERS or single configured project.",
        ),
      format: z
        .enum(["json", "markdown", "ascii"])
        .optional()
        .default("json")
        .describe("Output format (default: json)"),
      includeHealth: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include health indicators (default: true)"),
      stuckThresholdHours: z
        .number()
        .optional()
        .default(48)
        .describe("Hours before flagging stuck issues (default: 48)"),
      wipLimits: z
        .record(z.coerce.number())
        .optional()
        .describe(
          'Per-state WIP limits, e.g. { "In Progress": 3 }',
        ),
      doneWindowDays: z
        .number()
        .optional()
        .default(7)
        .describe("Only show Done issues from last N days (default: 7)"),
      issuesPerPhase: z
        .number()
        .optional()
        .default(10)
        .describe("Max issues to list per phase (default: 10)"),
      includeMetrics: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Include velocity metrics, risk score, and auto-status (default: false)",
        ),
      velocityWindowDays: z
        .number()
        .optional()
        .default(7)
        .describe(
          "Days to look back for velocity calculation (default: 7)",
        ),
      atRiskThreshold: z
        .number()
        .optional()
        .default(2)
        .describe(
          "Risk score threshold for AT_RISK status (default: 2)",
        ),
      offTrackThreshold: z
        .number()
        .optional()
        .default(6)
        .describe(
          "Risk score threshold for OFF_TRACK status (default: 6)",
        ),
      archiveThresholdDays: z
        .number()
        .optional()
        .default(14)
        .describe(
          "Days in Done/Canceled before eligible for archive (default: 14)",
        ),
      streams: z
        .array(
          z.object({
            id: z.string(),
            issues: z.array(z.number()),
            sharedFiles: z.array(z.string()),
            primaryIssue: z.number(),
          }),
        )
        .optional()
        .describe(
          "Pre-computed stream assignments from detect_work_streams. When provided, dashboard includes a Streams section.",
        ),
    },
    async (args) => {
      try {
        const owner = args.owner || resolveProjectOwner(client.config);
        if (!owner) {
          return toolError("owner is required");
        }

        // Resolve project numbers
        const projectNumbers = args.projectNumbers
          ?? resolveProjectNumbers(client.config);

        if (projectNumbers.length === 0) {
          return toolError(
            "No project numbers configured. Set RALPH_GH_PROJECT_NUMBER or RALPH_GH_PROJECT_NUMBERS.",
          );
        }

        // Fetch items from all projects
        const allItems: DashboardItem[] = [];
        const fetchWarnings: string[] = [];

        for (const pn of projectNumbers) {
          try {
            await ensureFieldCache(client, fieldCache, owner, pn);
          } catch (e) {
            fetchWarnings.push(
              `Project #${pn}: ${e instanceof Error ? e.message : String(e)}, skipping`,
            );
            continue;
          }

          const projectId = fieldCache.getProjectId(pn);
          if (!projectId) {
            fetchWarnings.push(
              `Project #${pn}: could not resolve project ID, skipping`,
            );
            continue;
          }

          // Fetch project title
          let projectTitle: string | undefined;
          try {
            const titleResult = await client.projectQuery<{
              node: { title: string } | null;
            }>(
              `query($projectId: ID!) { node(id: $projectId) { ... on ProjectV2 { title } } }`,
              { projectId },
            );
            projectTitle = titleResult.node?.title;
          } catch {
            // Non-fatal -- proceed without title
          }

          // Fetch items
          const result = await paginateConnection<RawDashboardItem>(
            (q, v) => client.projectQuery(q, v),
            DASHBOARD_ITEMS_QUERY,
            { projectId, first: 100 },
            "node.items",
            { maxItems: 500 },
          );

          const items = toDashboardItems(result.nodes, pn, projectTitle);
          allItems.push(...items);
        }

        // Build health config
        const healthConfig: HealthConfig = {
          ...DEFAULT_HEALTH_CONFIG,
          stuckThresholdHours: args.stuckThresholdHours ?? 48,
          criticalStuckHours: (args.stuckThresholdHours ?? 48) * 2,
          wipLimits: args.wipLimits ?? {},
          doneWindowDays: args.doneWindowDays ?? 7,
          archiveThresholdDays: args.archiveThresholdDays ?? 14,
        };

        // Build dashboard from merged items
        const dashboard = buildDashboard(allItems, healthConfig, undefined, args.streams);

        // Strip health if not requested
        if (!args.includeHealth) {
          dashboard.health = { ok: true, warnings: [] };
        }

        // Truncate issue lists per phase
        const issuesPerPhase = args.issuesPerPhase ?? 10;
        for (const phase of dashboard.phases) {
          phase.issues = phase.issues.slice(0, issuesPerPhase);
        }

        // Compute metrics if requested
        let metrics: ReturnType<typeof calculateMetrics> | undefined;
        if (args.includeMetrics) {
          const metricsConfig: MetricsConfig = {
            ...DEFAULT_METRICS_CONFIG,
            velocityWindowDays: args.velocityWindowDays ?? 7,
            atRiskThreshold: args.atRiskThreshold ?? 2,
            offTrackThreshold: args.offTrackThreshold ?? 6,
          };
          metrics = calculateMetrics(
            allItems,
            dashboard,
            metricsConfig,
          );
        }

        // Format output
        const format = args.format ?? "json";
        let formatted: string | undefined;

        if (format === "markdown") {
          formatted = formatMarkdown(dashboard, issuesPerPhase);
        } else if (format === "ascii") {
          formatted = formatAscii(dashboard);
        }

        return toolSuccess({
          ...dashboard,
          ...(formatted !== undefined ? { formatted } : {}),
          ...(metrics !== undefined ? { metrics } : {}),
          ...(fetchWarnings.length > 0 ? { fetchWarnings } : {}),
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to generate dashboard: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__detect_stream_positions
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__detect_stream_positions",
    "Combined work-stream detection + per-stream pipeline position detection. Takes issue file ownership data and issue workflow states, clusters issues into streams, then detects the pipeline phase for each stream independently.",
    {
      issues: z
        .array(
          z.object({
            number: z.number().describe("Issue number"),
            files: z
              .array(z.string())
              .describe("Will Modify file paths from research doc"),
            blockedBy: z
              .array(z.number())
              .describe("GitHub blockedBy issue numbers"),
          }),
        )
        .describe("List of issues with their file ownership and dependencies"),
      issueStates: z
        .array(
          z.object({
            number: z.number().describe("Issue number"),
            title: z.string().describe("Issue title"),
            workflowState: z.string().describe("Current workflow state"),
            estimate: z.string().nullable().describe("Estimate (XS/S/M/L/XL)"),
            subIssueCount: z
              .number()
              .optional()
              .default(0)
              .describe("Number of sub-issues"),
          }),
        )
        .describe("Workflow state data for each issue"),
    },
    async (args) => {
      try {
        const ownership: IssueFileOwnership[] = args.issues.map((i) => ({
          number: i.number,
          files: i.files,
          blockedBy: i.blockedBy,
        }));

        const streamResult = detectWorkStreams(ownership);

        const states: IssueState[] = args.issueStates.map((s) => ({
          number: s.number,
          title: s.title,
          workflowState: s.workflowState,
          estimate: s.estimate,
          subIssueCount: s.subIssueCount ?? 0,
        }));

        const positions = detectStreamPipelinePositions(
          streamResult.streams,
          states,
        );

        return toolSuccess({
          streams: positions,
          totalStreams: streamResult.totalStreams,
          totalIssues: streamResult.totalIssues,
          rationale: streamResult.rationale,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to detect stream positions: ${message}`);
      }
    },
  );
}
