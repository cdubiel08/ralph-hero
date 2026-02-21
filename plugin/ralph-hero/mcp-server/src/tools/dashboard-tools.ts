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
import { toolSuccess, toolError, resolveProjectOwner } from "../types.js";
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
  if (fieldCache.isPopulated()) return;

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
 */
export function toDashboardItems(raw: RawDashboardItem[]): DashboardItem[] {
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
    },
    async (args) => {
      try {
        const owner = args.owner || resolveProjectOwner(client.config);
        const projectNumber = client.config.projectNumber;

        if (!owner) {
          return toolError("owner is required");
        }
        if (!projectNumber) {
          return toolError("project number is required");
        }

        // Ensure field cache
        await ensureFieldCache(client, fieldCache, owner, projectNumber);

        const projectId = fieldCache.getProjectId();
        if (!projectId) {
          return toolError("Could not resolve project ID");
        }

        // Fetch all project items
        const result = await paginateConnection<RawDashboardItem>(
          (q, v) => client.projectQuery(q, v),
          DASHBOARD_ITEMS_QUERY,
          { projectId, first: 100 },
          "node.items",
          { maxItems: 500 },
        );

        // Convert to dashboard items
        const dashboardItems = toDashboardItems(result.nodes);

        // Build health config
        const healthConfig: HealthConfig = {
          ...DEFAULT_HEALTH_CONFIG,
          stuckThresholdHours: args.stuckThresholdHours ?? 48,
          criticalStuckHours: (args.stuckThresholdHours ?? 48) * 2,
          wipLimits: args.wipLimits ?? {},
          doneWindowDays: args.doneWindowDays ?? 7,
        };

        // Build dashboard
        const dashboard = buildDashboard(dashboardItems, healthConfig);

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
            dashboardItems,
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
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to generate dashboard: ${message}`);
      }
    },
  );
}
