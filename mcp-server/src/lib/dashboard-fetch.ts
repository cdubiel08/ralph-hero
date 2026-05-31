/**
 * Reusable helper for fetching project items as DashboardItem[].
 *
 * Owns the GraphQL query (`DASHBOARD_ITEMS_QUERY`), the raw item shape
 * (`RawDashboardItem`), and the raw→DashboardItem conversion
 * (`toDashboardItems`). Previously these lived inline in
 * `tools/dashboard-tools.ts`; centralising them lets
 * `ralph_hero__capture_snapshot` and any future tool reuse the same
 * fetch path without duplicating the GraphQL or conversion logic.
 *
 * Behaviour mirrors the inline fetch loop the dashboard tool used to
 * run:
 *   - Resolve target project numbers (explicit arg →
 *     projectNumbers config → projectNumber config).
 *   - For each project: ensure field cache, look up project ID, fetch
 *     project title (best-effort), paginate the items connection,
 *     convert to DashboardItems tagged with project metadata.
 *   - Skip a project on field-cache failure or missing project ID;
 *     record a human-readable warning so the caller can surface it.
 */

import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "./cache.js";
import { ensureFieldCache } from "./helpers.js";
import { paginateConnection } from "./pagination.js";
import type { DashboardItem } from "./dashboard.js";
import { resolveProjectNumbers, resolveProjectOwner } from "../types.js";

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
    trackedInIssues?: { nodes: Array<{ number: number; state: string; closedAt: string | null }> };
    trackedIssues?: { nodes: Array<{ number: number; state: string }> };
    blockedBy?: { nodes: Array<{ number: number; state: string }> };
    repository?: { nameWithOwner: string; name: string } | null;
    subIssues?: { totalCount: number };
  } | null;
  fieldValues: {
    nodes: Array<{
      __typename?: string;
      name?: string;
      iterationId?: string;
      title?: string;
      startDate?: string;
      duration?: number;
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

    // Extract iteration value (if any)
    const iterFv = r.fieldValues.nodes.find(
      (n) => n.__typename === "ProjectV2ItemFieldIterationValue",
    );

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
      subIssueCount: r.content.subIssues?.totalCount ?? 0,
      blockedBy: r.content.blockedBy?.nodes?.map((n) => ({
        number: n.number,
        workflowState: n.state === "CLOSED" ? "Done" : null,
      })) ?? [],
      parentNumber: r.content.trackedInIssues?.nodes?.[0]?.number ?? null,
      parentState: r.content.trackedInIssues?.nodes?.[0]?.state ?? null,
      ...(projectNumber !== undefined ? { projectNumber } : {}),
      ...(projectTitle !== undefined ? { projectTitle } : {}),
      ...(r.content.repository ? { repository: r.content.repository.nameWithOwner } : {}),
      ...(iterFv?.iterationId ? {
        iterationId: iterFv.iterationId,
        iterationTitle: iterFv.title ?? undefined,
        iterationStartDate: iterFv.startDate ?? undefined,
        iterationDuration: iterFv.duration ?? undefined,
      } : {}),
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
              repository { nameWithOwner name }
              subIssues { totalCount }
              blockedBy(first: 20) { nodes { number state } }
              trackedInIssues(first: 3) { nodes { number state closedAt } }
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
}`;

// ---------------------------------------------------------------------------
// fetchDashboardItems
// ---------------------------------------------------------------------------

export interface FetchDashboardItemsResult {
  items: DashboardItem[];
  warnings: string[];
}

/**
 * Resolve project numbers to fetch from arg + client config.
 *
 * Priority:
 *   1. Explicit `projectNumber` argument (single project).
 *   2. `client.config.projectNumbers` (multi-project).
 *   3. `client.config.projectNumber` (single project).
 */
function resolveTargetProjectNumbers(
  client: GitHubClient,
  projectNumber?: number,
): number[] {
  if (projectNumber !== undefined) return [projectNumber];
  return resolveProjectNumbers(client.config);
}

/**
 * Fetch dashboard items for one or more projects, returning a flat
 * `DashboardItem[]` plus any per-project fetch warnings.
 *
 * The owner is resolved from `client.config` via `resolveProjectOwner`.
 *
 * Throws if no owner can be resolved or if no project numbers are
 * configured. Per-project failures (missing project, field-cache
 * failure, missing project ID) are non-fatal — those projects are
 * skipped with a warning so a partial dashboard is still produced.
 */
export async function fetchDashboardItems(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  projectNumber?: number,
): Promise<FetchDashboardItemsResult> {
  const owner = resolveProjectOwner(client.config);
  if (!owner) {
    throw new Error("owner is required (set RALPH_GH_OWNER)");
  }

  const projectNumbers = resolveTargetProjectNumbers(client, projectNumber);
  if (projectNumbers.length === 0) {
    throw new Error(
      "No project numbers configured. Set RALPH_GH_PROJECT_NUMBER or RALPH_GH_PROJECT_NUMBERS.",
    );
  }

  const items: DashboardItem[] = [];
  const warnings: string[] = [];

  for (const pn of projectNumbers) {
    try {
      await ensureFieldCache(client, fieldCache, owner, pn);
    } catch (e) {
      warnings.push(
        `Project #${pn}: ${e instanceof Error ? e.message : String(e)}, skipping`,
      );
      continue;
    }

    const projectId = fieldCache.getProjectId(pn);
    if (!projectId) {
      warnings.push(
        `Project #${pn}: could not resolve project ID, skipping`,
      );
      continue;
    }

    // Fetch project title (non-fatal on failure)
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
      // Non-fatal — proceed without title.
    }

    const result = await paginateConnection<RawDashboardItem>(
      (q, v) => client.projectQuery(q, v),
      DASHBOARD_ITEMS_QUERY,
      { projectId, first: 100 },
      "node.items",
      { scanUntilExhausted: true },
    );

    items.push(...toDashboardItems(result.nodes, pn, projectTitle));
  }

  return { items, warnings };
}
