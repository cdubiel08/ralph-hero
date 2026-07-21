/**
 * Repo-wide issue search, independent of GitHub Projects V2 board membership.
 *
 * `list_issues`'s default path (`scope: "project"`) enumerates the configured
 * Project V2 board's items — an issue that exists in the repo but was never
 * added to that board is structurally invisible to it (GH-1572). This module
 * hits GitHub's `search(type: ISSUE)` GraphQL API directly against the repo,
 * following the same pattern already established by
 * `directions-tools.ts:fetchOpenPRs` and `debug-tools.ts:findExistingDebugIssue`.
 */

import type { GitHubClient } from "../github-client.js";
import { parseDateMath } from "./date-math.js";

export interface RepoSearchFilters {
  label?: string;
  query?: string;
  state?: "OPEN" | "CLOSED";
  reason?: "completed" | "not_planned" | "reopened";
  excludeLabels?: string[];
  updatedSince?: string;
  updatedBefore?: string;
  orderBy?: "CREATED_AT" | "UPDATED_AT" | "COMMENTS";
}

const REASON_QUALIFIER: Record<
  NonNullable<RepoSearchFilters["reason"]>,
  string
> = {
  completed: "reason:completed",
  not_planned: 'reason:"not planned"',
  reopened: "reason:reopened",
};

const ORDER_BY_SORT: Record<
  NonNullable<RepoSearchFilters["orderBy"]>,
  string
> = {
  CREATED_AT: "sort:created-desc",
  UPDATED_AT: "sort:updated-desc",
  COMMENTS: "sort:comments-desc",
};

/**
 * Quote a search term if it contains whitespace (GitHub search qualifier
 * syntax requires quoting for multi-word values).
 */
function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * Build a GitHub Issues Search API qualifier string from the subset of
 * `list_issues` filters that map onto search qualifiers. Pure function —
 * no I/O, fully unit-testable in isolation from `searchRepoIssues`.
 */
export function buildRepoSearchQuery(
  owner: string,
  repo: string,
  filters: RepoSearchFilters,
): string {
  const parts = [`repo:${owner}/${repo}`, "is:issue"];

  if (filters.state === "OPEN") {
    parts.push("is:open");
  } else if (filters.state === "CLOSED") {
    parts.push("is:closed");
  }

  if (filters.reason) {
    parts.push(REASON_QUALIFIER[filters.reason]);
  }

  if (filters.label) {
    parts.push(`label:${quoteIfNeeded(filters.label)}`);
  }

  for (const excluded of filters.excludeLabels ?? []) {
    parts.push(`-label:${quoteIfNeeded(excluded)}`);
  }

  if (filters.updatedSince) {
    parts.push(`updated:>=${parseDateMath(filters.updatedSince).toISOString()}`);
  }

  if (filters.updatedBefore) {
    parts.push(`updated:<${parseDateMath(filters.updatedBefore).toISOString()}`);
  }

  parts.push(ORDER_BY_SORT[filters.orderBy ?? "CREATED_AT"]);

  if (filters.query) {
    parts.push(`${quoteIfNeeded(filters.query)} in:title,body`);
  }

  return parts.join(" ");
}

/**
 * GraphQL search response shape for `searchRepoIssues`. Field selection
 * mirrors `list_issues`'s project-scope query (`issue-tools.ts` items query)
 * so the two paths' raw node shapes line up before formatting.
 */
export interface RepoSearchIssueNode {
  number: number;
  title: string;
  body?: string;
  state: "OPEN" | "CLOSED";
  stateReason: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  labels: { nodes: Array<{ name: string }> };
  assignees: { nodes: Array<{ login: string }> };
  repository: { name: string; nameWithOwner: string };
}

interface RepoIssueSearchResponse {
  search: {
    issueCount: number;
    nodes: RepoSearchIssueNode[];
  };
}

/**
 * Result of a `searchRepoIssues` call. `nodes` is the fetched page (capped at
 * `limit`); `totalCount` is GitHub's total matching-issue count for the query
 * (independent of `limit`); `truncated` is true when `totalCount` exceeds the
 * number of nodes actually fetched — i.e. more matches exist than were
 * returned. Callers MUST check `truncated` before treating `nodes` as an
 * exhaustive result set (GH-1573 review follow-up).
 */
export interface RepoIssueSearchResult {
  nodes: RepoSearchIssueNode[];
  truncated: boolean;
  totalCount: number;
}

/**
 * Execute a repo-wide issue search via GitHub's `search(type: ISSUE)` API.
 *
 * Unlike `findExistingDebugIssue`'s best-effort contract, this path is NOT
 * best-effort: it is the caller's (`list_issues` `scope: "repo"`) explicit,
 * requested existence check, so a search failure must surface as an error
 * rather than silently returning empty results — a silent-empty-on-error
 * here would recreate the exact bug GH-1572 documents.
 *
 * This is a single-page fetch (`first: $limit`, no pagination/cursor), so the
 * returned `nodes` can be a strict subset of all matching issues. Callers
 * must consult `truncated`/`totalCount` on the result rather than assuming
 * `nodes` is exhaustive — see `RepoIssueSearchResult`.
 */
export async function searchRepoIssues(
  client: GitHubClient,
  owner: string,
  repo: string,
  filters: RepoSearchFilters,
  limit: number,
): Promise<RepoIssueSearchResult> {
  const q = buildRepoSearchQuery(owner, repo, filters);

  try {
    const data = await client.query<RepoIssueSearchResponse>(
      `query RepoIssueSearch($q: String!, $first: Int!) {
        search(query: $q, type: ISSUE, first: $first) {
          issueCount
          nodes {
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
        }
      }`,
      { q, first: limit },
    );
    const nodes = data.search.nodes ?? [];
    const totalCount = data.search.issueCount ?? nodes.length;
    return {
      nodes,
      totalCount,
      truncated: totalCount > nodes.length,
    };
  } catch (error) {
    console.error(
      `[repo-issue-search] searchRepoIssues failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw error;
  }
}
