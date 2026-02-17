/**
 * MCP tools for pull request lifecycle management.
 *
 * Provides tools for PR creation, inspection, listing, and state management.
 * Uses GitHub GraphQL API via the shared GitHubClient.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import type { FieldOptionCache } from "../lib/cache.js";
import { paginateConnection } from "../lib/pagination.js";
import { toolSuccess, toolError } from "../types.js";

// ---------------------------------------------------------------------------
// Config resolution (same pattern as issue-tools.ts, relationship-tools.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Pure function: build PR body with issue links
// ---------------------------------------------------------------------------

/**
 * Build the final PR body by prepending `Closes #N` lines for linked issues.
 * Exported for unit testing.
 */
export function buildPrBody(
  userBody: string | undefined,
  linkedIssueNumbers: number[] | undefined,
): string | null {
  const body = userBody || "";
  if (!linkedIssueNumbers || linkedIssueNumbers.length === 0) {
    return body || null;
  }

  const closingRefs = linkedIssueNumbers
    .map((n) => `Closes #${n}`)
    .join("\n");

  return body ? `${closingRefs}\n\n${body}` : closingRefs;
}

// ---------------------------------------------------------------------------
// Pure function: parse linked issues from PR body
// ---------------------------------------------------------------------------

const CLOSING_PATTERN = /(?:closes?|fixes?|resolves?)\s+#(\d+)/gi;

/**
 * Extract issue numbers from `Closes #N`, `Fixes #N`, `Resolves #N` patterns.
 * De-duplicates results. Exported for unit testing.
 */
export function parseLinkedIssues(body: string | null): number[] {
  if (!body) return [];
  const matches = [...body.matchAll(CLOSING_PATTERN)];
  return [...new Set(matches.map((m) => parseInt(m[1], 10)))];
}

// ---------------------------------------------------------------------------
// Pure function: summarize reviews (de-dup by author, keep latest)
// ---------------------------------------------------------------------------

export interface ReviewSummary {
  approved: number;
  changesRequested: number;
  pending: number;
  total: number;
  details: Array<{ login: string; state: string }>;
}

export function summarizeReviews(
  reviews: Array<{ state: string; author: { login: string } | null }>,
): ReviewSummary {
  const byAuthor = new Map<string, string>();
  for (const r of reviews) {
    const login = r.author?.login || "unknown";
    byAuthor.set(login, r.state);
  }

  let approved = 0,
    changesRequested = 0,
    pending = 0;
  for (const state of byAuthor.values()) {
    if (state === "APPROVED") approved++;
    else if (state === "CHANGES_REQUESTED") changesRequested++;
    else pending++;
  }

  const details = [...byAuthor.entries()].map(([login, state]) => ({
    login,
    state,
  }));
  return {
    approved,
    changesRequested,
    pending,
    total: byAuthor.size,
    details,
  };
}

// ---------------------------------------------------------------------------
// Pure function: summarize CI checks
// ---------------------------------------------------------------------------

export interface CheckSummary {
  overall: string | null;
  success: number;
  failure: number;
  pending: number;
  total: number;
}

export function summarizeChecks(
  overallState: string | null,
  contexts: Array<{
    name?: string;
    status?: string;
    conclusion?: string | null;
    context?: string;
    state?: string;
  }>,
): CheckSummary {
  let success = 0,
    failure = 0,
    pending = 0;
  for (const ctx of contexts) {
    if ("conclusion" in ctx && ctx.conclusion !== undefined) {
      if (
        ctx.conclusion === "SUCCESS" ||
        ctx.conclusion === "NEUTRAL" ||
        ctx.conclusion === "SKIPPED"
      )
        success++;
      else if (
        ctx.conclusion === "FAILURE" ||
        ctx.conclusion === "TIMED_OUT" ||
        ctx.conclusion === "CANCELLED"
      )
        failure++;
      else pending++;
    } else if ("state" in ctx) {
      if (ctx.state === "SUCCESS") success++;
      else if (ctx.state === "FAILURE" || ctx.state === "ERROR") failure++;
      else pending++;
    }
  }
  return {
    overall: overallState,
    success,
    failure,
    pending,
    total: success + failure + pending,
  };
}

// ---------------------------------------------------------------------------
// Register PR tools
// ---------------------------------------------------------------------------

export function registerPrTools(
  server: McpServer,
  client: GitHubClient,
  _fieldCache: FieldOptionCache,
): void {
  // -------------------------------------------------------------------------
  // ralph_hero__create_pull_request
  // -------------------------------------------------------------------------

  server.tool(
    "ralph_hero__create_pull_request",
    "Create a pull request with optional auto-linking to issues via Closes #N. Returns: number, url, state, isDraft, headBranch, baseBranch. Recovery: if branch not found, verify the head branch exists on the remote and has been pushed.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to env var"),
      title: z.string().describe("PR title"),
      body: z.string().optional().describe("PR body (Markdown)"),
      baseBranch: z.string().describe("Target branch (e.g., 'main')"),
      headBranch: z
        .string()
        .describe("Source branch (e.g., 'feature/GH-30')"),
      draft: z
        .boolean()
        .optional()
        .default(false)
        .describe("Create as draft PR (default: false)"),
      linkedIssueNumbers: z
        .array(z.number())
        .optional()
        .describe("Issue numbers to auto-link via 'Closes #N' in body"),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);

        // Step 1: Get repository ID (cached)
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

        // Step 2: Build PR body with issue links
        const finalBody = buildPrBody(args.body, args.linkedIssueNumbers);

        // Step 3: Create PR via mutation
        const createResult = await client.mutate<{
          createPullRequest: {
            pullRequest: {
              id: string;
              number: number;
              title: string;
              url: string;
              state: string;
              isDraft: boolean;
              headRefName: string;
              baseRefName: string;
              createdAt: string;
            };
          };
        }>(
          `mutation($repoId: ID!, $title: String!, $body: String, $baseRefName: String!, $headRefName: String!, $draft: Boolean) {
            createPullRequest(input: {
              repositoryId: $repoId,
              title: $title,
              body: $body,
              baseRefName: $baseRefName,
              headRefName: $headRefName,
              draft: $draft
            }) {
              pullRequest {
                id
                number
                title
                url
                state
                isDraft
                headRefName
                baseRefName
                createdAt
              }
            }
          }`,
          {
            repoId,
            title: args.title,
            body: finalBody,
            baseRefName: args.baseBranch,
            headRefName: args.headBranch,
            draft: args.draft ?? false,
          },
        );

        const pr = createResult.createPullRequest.pullRequest;

        return toolSuccess({
          number: pr.number,
          url: pr.url,
          state: pr.state,
          isDraft: pr.isDraft,
          headBranch: pr.headRefName,
          baseBranch: pr.baseRefName,
          linkedIssues: args.linkedIssueNumbers || [],
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to create pull request: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__get_pull_request
  // -------------------------------------------------------------------------

  server.tool(
    "ralph_hero__get_pull_request",
    "Get detailed pull request info: reviews, CI status, merge readiness, linked issues. The mergeable field may return UNKNOWN on first request (GitHub computes lazily) — retry after a few seconds. Returns: number, title, body, url, state, isDraft, author, headBranch, baseBranch, mergeable, reviews, checks, linkedIssues, reviewRequests.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to env var"),
      prNumber: z.number().describe("Pull request number"),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);

        const result = await client.query<{
          repository: {
            pullRequest: {
              id: string;
              number: number;
              title: string;
              body: string | null;
              url: string;
              state: string;
              isDraft: boolean;
              author: { login: string } | null;
              headRefName: string;
              baseRefName: string;
              mergeable: string;
              createdAt: string;
              updatedAt: string;
              mergedAt: string | null;
              closedAt: string | null;
              reviews: {
                nodes: Array<{
                  state: string;
                  author: { login: string } | null;
                }>;
              };
              reviewRequests: {
                nodes: Array<{
                  requestedReviewer:
                    | { login: string; slug?: undefined; name?: undefined }
                    | {
                        slug: string;
                        name: string;
                        login?: undefined;
                      }
                    | null;
                }>;
              };
              commits: {
                nodes: Array<{
                  commit: {
                    statusCheckRollup: {
                      state: string;
                      contexts: {
                        nodes: Array<{
                          name?: string;
                          status?: string;
                          conclusion?: string | null;
                          context?: string;
                          state?: string;
                        }>;
                      };
                    } | null;
                  };
                }>;
              };
            } | null;
          } | null;
        }>(
          `query($owner: String!, $repo: String!, $prNumber: Int!) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $prNumber) {
                id number title body url state isDraft
                author { login }
                headRefName baseRefName
                mergeable
                createdAt updatedAt mergedAt closedAt
                reviews(last: 50) {
                  nodes { state author { login } }
                }
                reviewRequests(first: 10) {
                  nodes {
                    requestedReviewer {
                      ... on User { login }
                      ... on Team { slug name }
                    }
                  }
                }
                commits(last: 1) {
                  nodes {
                    commit {
                      statusCheckRollup {
                        state
                        contexts(first: 50) {
                          nodes {
                            ... on CheckRun { name status conclusion }
                            ... on StatusContext { context state }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }`,
          { owner, repo, prNumber: args.prNumber },
          { cache: true, cacheTtlMs: 60_000 },
        );

        const pr = result.repository?.pullRequest;
        if (!pr) {
          return toolError(
            `Pull request #${args.prNumber} not found in ${owner}/${repo}`,
          );
        }

        const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;

        const reviewRequests: string[] = [];
        for (const rr of pr.reviewRequests.nodes) {
          if (rr.requestedReviewer?.login) {
            reviewRequests.push(rr.requestedReviewer.login);
          } else if (rr.requestedReviewer?.slug) {
            reviewRequests.push(rr.requestedReviewer.slug);
          }
        }

        return toolSuccess({
          number: pr.number,
          title: pr.title,
          body: pr.body,
          url: pr.url,
          state: pr.state,
          isDraft: pr.isDraft,
          author: pr.author?.login || null,
          headBranch: pr.headRefName,
          baseBranch: pr.baseRefName,
          mergeable: pr.mergeable,
          createdAt: pr.createdAt,
          updatedAt: pr.updatedAt,
          mergedAt: pr.mergedAt,
          closedAt: pr.closedAt,
          reviews: summarizeReviews(pr.reviews.nodes),
          checks: summarizeChecks(
            rollup?.state || null,
            rollup?.contexts?.nodes || [],
          ),
          linkedIssues: parseLinkedIssues(pr.body),
          reviewRequests,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to get pull request: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__list_pull_requests
  // -------------------------------------------------------------------------

  server.tool(
    "ralph_hero__list_pull_requests",
    "List pull requests with optional filters. Returns compact summaries with CI and review status. Use get_pull_request for full details on a specific PR.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to env var"),
      state: z
        .enum(["OPEN", "CLOSED", "MERGED"])
        .optional()
        .describe("Filter by PR state (default: OPEN)"),
      author: z
        .string()
        .optional()
        .describe("Filter by author login (client-side filter)"),
      baseBranch: z
        .string()
        .optional()
        .describe("Filter by target branch (e.g., 'main')"),
      limit: z
        .number()
        .optional()
        .default(25)
        .describe("Max results (default: 25)"),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);

        const states = args.state ? [args.state] : ["OPEN"];

        const listQuery = `query($owner: String!, $repo: String!, $states: [PullRequestState!], $baseRefName: String, $first: Int!, $cursor: String) {
          repository(owner: $owner, name: $repo) {
            pullRequests(states: $states, baseRefName: $baseRefName, first: $first, after: $cursor, orderBy: {field: CREATED_AT, direction: DESC}) {
              totalCount
              pageInfo { hasNextPage endCursor }
              nodes {
                number title state isDraft url
                author { login }
                headRefName baseRefName
                createdAt updatedAt
                commits(last: 1) {
                  nodes {
                    commit {
                      statusCheckRollup { state }
                    }
                  }
                }
                reviews(last: 20) {
                  nodes { state author { login } }
                }
              }
            }
          }
        }`;

        interface PrListNode {
          number: number;
          title: string;
          state: string;
          isDraft: boolean;
          url: string;
          author: { login: string } | null;
          headRefName: string;
          baseRefName: string;
          createdAt: string;
          updatedAt: string;
          commits: {
            nodes: Array<{
              commit: {
                statusCheckRollup: { state: string } | null;
              };
            }>;
          };
          reviews: {
            nodes: Array<{
              state: string;
              author: { login: string } | null;
            }>;
          };
        }

        const paginated = await paginateConnection<PrListNode>(
          (q, vars) => client.query(q, vars),
          listQuery,
          {
            owner,
            repo,
            states,
            baseRefName: args.baseBranch || null,
          },
          "repository.pullRequests",
          { maxItems: args.limit, pageSize: Math.min(args.limit, 100) },
        );

        // Client-side author filter
        let filtered = paginated.nodes;
        if (args.author) {
          filtered = filtered.filter(
            (pr) => pr.author?.login === args.author,
          );
        }

        return toolSuccess({
          totalCount: paginated.totalCount ?? 0,
          filteredCount: filtered.length,
          pullRequests: filtered.map((pr) => {
            const rollup =
              pr.commits.nodes[0]?.commit.statusCheckRollup;
            return {
              number: pr.number,
              title: pr.title,
              state: pr.state,
              isDraft: pr.isDraft,
              url: pr.url,
              author: pr.author?.login || null,
              headBranch: pr.headRefName,
              baseBranch: pr.baseRefName,
              createdAt: pr.createdAt,
              updatedAt: pr.updatedAt,
              checks: { overall: rollup?.state || null },
              reviews: summarizeReviews(pr.reviews.nodes),
            };
          }),
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to list pull requests: ${message}`);
      }
    },
  );
}
