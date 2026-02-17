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
import { toolSuccess, toolError, resolveProjectOwner } from "../types.js";
import { resolveState } from "../lib/state-resolution.js";

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
// Project field helpers (duplicated from issue-tools.ts)
// TODO: Replace with import from lib/helpers.ts after #21 merges
// ---------------------------------------------------------------------------

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
            ... on ProjectV2FieldCommon { id name dataType }
            ... on ProjectV2SingleSelectField { id name dataType options { id name } }
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
  if (!nodeId) throw new Error(`Issue #${number} not found in ${owner}/${repo}`);
  client.getCache().set(cacheKey, nodeId, 30 * 60 * 1000);
  return nodeId;
}

async function resolveProjectItemId(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<string> {
  const projectId = fieldCache.getProjectId();
  if (!projectId) throw new Error("Field cache not populated");

  const cacheKey = `project-item-id:${owner}/${repo}#${issueNumber}`;
  const cached = client.getCache().get<string>(cacheKey);
  if (cached) return cached;

  const issueNodeId = await resolveIssueNodeId(client, owner, repo, issueNumber);
  const result = await client.query<{
    node: {
      projectItems: {
        nodes: Array<{ id: string; project: { id: string } }>;
      };
    } | null;
  }>(
    `query($issueId: ID!) {
      node(id: $issueId) {
        ... on Issue {
          projectItems(first: 20) {
            nodes { id project { id } }
          }
        }
      }
    }`,
    { issueId: issueNodeId },
  );

  const items = result.node?.projectItems?.nodes || [];
  const projectItem = items.find((item) => item.project.id === projectId);
  if (!projectItem) {
    throw new Error(`Issue #${issueNumber} is not in the project`);
  }

  client.getCache().set(cacheKey, projectItem.id, 30 * 60 * 1000);
  return projectItem.id;
}

async function updateProjectItemField(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  projectItemId: string,
  fieldName: string,
  optionName: string,
): Promise<void> {
  const projectId = fieldCache.getProjectId();
  if (!projectId) throw new Error("Field cache not populated");

  const fieldId = fieldCache.getFieldId(fieldName);
  if (!fieldId) throw new Error(`Field "${fieldName}" not found in project`);

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
// Node ID resolvers for PR operations
// ---------------------------------------------------------------------------

async function resolvePrNodeId(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  const cacheKey = `pr-node-id:${owner}/${repo}#${prNumber}`;
  const cached = client.getCache().get<string>(cacheKey);
  if (cached) return cached;

  const result = await client.query<{
    repository: { pullRequest: { id: string } | null } | null;
  }>(
    `query($owner: String!, $repo: String!, $prNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) { id }
      }
    }`,
    { owner, repo, prNumber },
  );

  const nodeId = result.repository?.pullRequest?.id;
  if (!nodeId) throw new Error(`PR #${prNumber} not found in ${owner}/${repo}`);
  client.getCache().set(cacheKey, nodeId, 30 * 60 * 1000);
  return nodeId;
}

async function resolveUserNodeId(
  client: GitHubClient,
  login: string,
): Promise<string> {
  const cacheKey = `user-node-id:${login}`;
  const cached = client.getCache().get<string>(cacheKey);
  if (cached) return cached;

  const result = await client.query<{ user: { id: string } | null }>(
    `query($login: String!) { user(login: $login) { id } }`,
    { login },
  );

  const nodeId = result.user?.id;
  if (!nodeId) throw new Error(`GitHub user "${login}" not found`);
  client.getCache().set(cacheKey, nodeId, 60 * 60 * 1000);
  return nodeId;
}

// ---------------------------------------------------------------------------
// Register PR tools
// ---------------------------------------------------------------------------

export function registerPrTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
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

  // -------------------------------------------------------------------------
  // ralph_hero__update_pull_request_state
  // -------------------------------------------------------------------------

  server.tool(
    "ralph_hero__update_pull_request_state",
    "Update PR lifecycle state: mark ready/draft, request reviewers, or merge. Merge action auto-transitions linked issues to Done. Returns: prNumber, action, result details. Recovery: for merge failures, use get_pull_request to check CI/review/conflict status.",
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
      action: z
        .enum(["ready_for_review", "convert_to_draft", "request_reviewers", "merge"])
        .describe("Action to perform"),
      mergeStrategy: z
        .enum(["MERGE", "SQUASH", "REBASE"])
        .optional()
        .default("SQUASH")
        .describe("Merge strategy (default: SQUASH)"),
      reviewers: z
        .array(z.string())
        .optional()
        .describe("GitHub usernames for request_reviewers action"),
      teamReviewers: z
        .array(z.string())
        .optional()
        .describe("Team slugs for request_reviewers action (requires org context)"),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);
        const prNodeId = await resolvePrNodeId(client, owner, repo, args.prNumber);

        // --- ready_for_review ---
        if (args.action === "ready_for_review") {
          await client.mutate(
            `mutation($pullRequestId: ID!) {
              markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
                pullRequest { id isDraft }
              }
            }`,
            { pullRequestId: prNodeId },
          );
          return toolSuccess({
            prNumber: args.prNumber,
            action: "ready_for_review",
            isDraft: false,
          });
        }

        // --- convert_to_draft ---
        if (args.action === "convert_to_draft") {
          await client.mutate(
            `mutation($pullRequestId: ID!) {
              convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) {
                pullRequest { id isDraft }
              }
            }`,
            { pullRequestId: prNodeId },
          );
          return toolSuccess({
            prNumber: args.prNumber,
            action: "convert_to_draft",
            isDraft: true,
          });
        }

        // --- request_reviewers ---
        if (args.action === "request_reviewers") {
          const reviewerLogins = args.reviewers || [];
          const teamSlugs = args.teamReviewers || [];

          if (reviewerLogins.length === 0 && teamSlugs.length === 0) {
            return toolError(
              "At least one reviewer or teamReviewer is required for request_reviewers action",
            );
          }

          const userIds: string[] = [];
          for (const login of reviewerLogins) {
            userIds.push(await resolveUserNodeId(client, login));
          }

          await client.mutate(
            `mutation($pullRequestId: ID!, $userIds: [ID!]!) {
              requestReviews(input: { pullRequestId: $pullRequestId, userIds: $userIds }) {
                pullRequest { id }
              }
            }`,
            { pullRequestId: prNodeId, userIds },
          );

          return toolSuccess({
            prNumber: args.prNumber,
            action: "request_reviewers",
            reviewersRequested: [...reviewerLogins, ...teamSlugs],
          });
        }

        // --- merge ---
        if (args.action === "merge") {
          // Pre-merge check: query PR for mergeable status
          const prCheck = await client.query<{
            repository: {
              pullRequest: {
                mergeable: string;
                body: string | null;
              } | null;
            } | null;
          }>(
            `query($owner: String!, $repo: String!, $prNumber: Int!) {
              repository(owner: $owner, name: $repo) {
                pullRequest(number: $prNumber) {
                  mergeable
                  body
                }
              }
            }`,
            { owner, repo, prNumber: args.prNumber },
          );

          const prData = prCheck.repository?.pullRequest;
          if (!prData) {
            return toolError(`PR #${args.prNumber} not found`);
          }

          if (prData.mergeable === "CONFLICTING") {
            return toolError(
              "Cannot merge: PR has merge conflicts. Update the branch first.",
            );
          }

          // Execute merge
          await client.mutate(
            `mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod) {
              mergePullRequest(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
                pullRequest { id number state merged }
              }
            }`,
            { pullRequestId: prNodeId, mergeMethod: args.mergeStrategy },
          );

          // Post-merge: transition linked issues to Done
          // TODO: Replace with handoff_ticket after #19 merges
          const linkedIssues = parseLinkedIssues(prData.body);
          const linkedIssuesTransitioned: number[] = [];
          const linkedIssuesFailed: Array<{ number: number; error: string }> = [];

          if (linkedIssues.length > 0) {
            const resolved = resolveState("__CLOSE__", "ralph_pr");
            const targetState = resolved.resolvedState;

            const projectOwner = resolveProjectOwner(client.config);
            const projectNumber = client.config.projectNumber;

            if (projectOwner && projectNumber) {
              await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

              for (const issueNum of linkedIssues) {
                try {
                  const itemId = await resolveProjectItemId(
                    client, fieldCache, owner, repo, issueNum,
                  );
                  await updateProjectItemField(
                    client, fieldCache, itemId, "Workflow State", targetState,
                  );
                  linkedIssuesTransitioned.push(issueNum);
                } catch (err: unknown) {
                  const msg = err instanceof Error ? err.message : String(err);
                  linkedIssuesFailed.push({ number: issueNum, error: msg });
                }
              }
            }
          }

          return toolSuccess({
            prNumber: args.prNumber,
            action: "merge",
            merged: true,
            mergeStrategy: args.mergeStrategy,
            linkedIssuesTransitioned,
            linkedIssuesFailed,
          });
        }

        return toolError(`Unknown action: ${args.action}`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to update pull request state: ${message}`);
      }
    },
  );
}
