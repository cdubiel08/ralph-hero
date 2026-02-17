/**
 * MCP tools for pull request lifecycle management.
 *
 * Provides `ralph_hero__create_pull_request` tool that creates PRs via
 * GraphQL with optional auto-linking to issues via `Closes #N` keywords.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import type { FieldOptionCache } from "../lib/cache.js";
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
// Register PR tools
// ---------------------------------------------------------------------------

export function registerPrTools(
  server: McpServer,
  client: GitHubClient,
  _fieldCache: FieldOptionCache,
): void {
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
      baseBranch: z
        .string()
        .describe("Target branch (e.g., 'main')"),
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
}
