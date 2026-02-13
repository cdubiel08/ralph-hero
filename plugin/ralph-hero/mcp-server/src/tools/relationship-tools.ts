/**
 * MCP tools for managing GitHub issue relationships:
 * - Sub-issues (parent/child)
 * - Dependencies (blocking/blocked-by)
 * - Group detection (transitive closure + topological sort)
 *
 * All tools accept human-readable issue numbers and resolve to
 * GitHub node IDs internally via cached lookups.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import { detectGroup } from "../lib/group-detection.js";
import { toolSuccess, toolError } from "../types.js";

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
// Helper: Resolve required owner/repo with defaults from client config
// ---------------------------------------------------------------------------

function resolveConfig(
  client: GitHubClient,
  args: { owner?: string; repo?: string },
): { owner: string; repo: string } {
  const owner = args.owner || client.config.owner;
  const repo = args.repo || client.config.repo;
  if (!owner) throw new Error("owner is required (set GITHUB_OWNER env var or pass explicitly)");
  if (!repo) throw new Error("repo is required (set GITHUB_REPO env var or pass explicitly)");
  return { owner, repo };
}

// ---------------------------------------------------------------------------
// Register relationship tools
// ---------------------------------------------------------------------------

export function registerRelationshipTools(
  server: McpServer,
  client: GitHubClient,
  _fieldCache: FieldOptionCache,
): void {

  // -------------------------------------------------------------------------
  // ralph_hero__add_sub_issue
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__add_sub_issue",
    "Create a parent/child (sub-issue) relationship between two GitHub issues. The parent issue becomes the container for the child issue.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z.string().optional().describe("Repository name. Defaults to GITHUB_REPO env var"),
      parentNumber: z.number().describe("Parent issue number"),
      childNumber: z.number().describe("Child issue number (will become sub-issue of parent)"),
      replaceParent: z.boolean().optional().default(false).describe("If true, move child even if it already has a parent"),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);

        const parentId = await resolveIssueNodeId(client, owner, repo, args.parentNumber);
        const childId = await resolveIssueNodeId(client, owner, repo, args.childNumber);

        const result = await client.mutate<{
          addSubIssue: {
            issue: { id: string; number: number; title: string };
            subIssue: { id: string; number: number; title: string };
          };
        }>(
          `mutation($parentId: ID!, $childId: ID!, $replaceParent: Boolean) {
            addSubIssue(input: {
              issueId: $parentId,
              subIssueId: $childId,
              replaceParent: $replaceParent
            }) {
              issue { id number title }
              subIssue { id number title }
            }
          }`,
          { parentId, childId, replaceParent: args.replaceParent },
        );

        return toolSuccess({
          parent: {
            id: result.addSubIssue.issue.id,
            number: result.addSubIssue.issue.number,
            title: result.addSubIssue.issue.title,
          },
          child: {
            id: result.addSubIssue.subIssue.id,
            number: result.addSubIssue.subIssue.number,
            title: result.addSubIssue.subIssue.title,
          },
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to add sub-issue: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__list_sub_issues
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__list_sub_issues",
    "List all sub-issues (children) of a parent GitHub issue, with completion summary",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z.string().optional().describe("Repository name. Defaults to GITHUB_REPO env var"),
      number: z.number().describe("Parent issue number"),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);

        const result = await client.query<{
          repository: {
            issue: {
              id: string;
              number: number;
              title: string;
              subIssuesSummary: {
                total: number;
                completed: number;
                percentCompleted: number;
              } | null;
              subIssues: {
                nodes: Array<{
                  id: string;
                  number: number;
                  title: string;
                  state: string;
                }>;
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
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
                subIssuesSummary { total completed percentCompleted }
                subIssues(first: 50) {
                  nodes { id number title state }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }`,
          { owner, repo, number: args.number },
        );

        const issue = result.repository?.issue;
        if (!issue) {
          return toolError(`Issue #${args.number} not found in ${owner}/${repo}`);
        }

        return toolSuccess({
          parent: {
            id: issue.id,
            number: issue.number,
            title: issue.title,
          },
          subIssues: issue.subIssues.nodes.map((si) => ({
            id: si.id,
            number: si.number,
            title: si.title,
            state: si.state,
          })),
          summary: issue.subIssuesSummary || {
            total: issue.subIssues.nodes.length,
            completed: issue.subIssues.nodes.filter((si) => si.state === "CLOSED").length,
            percentCompleted: issue.subIssues.nodes.length > 0
              ? Math.round(
                  (issue.subIssues.nodes.filter((si) => si.state === "CLOSED").length /
                    issue.subIssues.nodes.length) *
                    100,
                )
              : 0,
          },
          hasMore: issue.subIssues.pageInfo.hasNextPage,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to list sub-issues: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__add_dependency
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__add_dependency",
    "Create a blocking dependency between two GitHub issues. The 'blockingNumber' issue blocks the 'blockedNumber' issue.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z.string().optional().describe("Repository name. Defaults to GITHUB_REPO env var"),
      blockedNumber: z.number().describe("Issue number that IS blocked (cannot proceed until blocker is done)"),
      blockingNumber: z.number().describe("Issue number that IS the blocker (must be completed first)"),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);

        const blockedId = await resolveIssueNodeId(client, owner, repo, args.blockedNumber);
        const blockingId = await resolveIssueNodeId(client, owner, repo, args.blockingNumber);

        const result = await client.mutate<{
          addBlockedBy: {
            issue: { id: string; number: number; title: string };
            blockingIssue: { id: string; number: number; title: string };
          };
        }>(
          `mutation($blockedId: ID!, $blockingId: ID!) {
            addBlockedBy(input: {
              issueId: $blockedId,
              blockingIssueId: $blockingId
            }) {
              issue { id number title }
              blockingIssue { id number title }
            }
          }`,
          { blockedId, blockingId },
        );

        return toolSuccess({
          blocked: {
            id: result.addBlockedBy.issue.id,
            number: result.addBlockedBy.issue.number,
            title: result.addBlockedBy.issue.title,
          },
          blocking: {
            id: result.addBlockedBy.blockingIssue.id,
            number: result.addBlockedBy.blockingIssue.number,
            title: result.addBlockedBy.blockingIssue.title,
          },
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to add dependency: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__remove_dependency
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__remove_dependency",
    "Remove a blocking dependency between two GitHub issues",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z.string().optional().describe("Repository name. Defaults to GITHUB_REPO env var"),
      blockedNumber: z.number().describe("Issue number that was blocked"),
      blockingNumber: z.number().describe("Issue number that was the blocker"),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);

        const blockedId = await resolveIssueNodeId(client, owner, repo, args.blockedNumber);
        const blockingId = await resolveIssueNodeId(client, owner, repo, args.blockingNumber);

        const result = await client.mutate<{
          removeBlockedBy: {
            issue: { id: string; number: number; title: string };
            blockingIssue: { id: string; number: number; title: string };
          };
        }>(
          `mutation($blockedId: ID!, $blockingId: ID!) {
            removeBlockedBy(input: {
              issueId: $blockedId,
              blockingIssueId: $blockingId
            }) {
              issue { id number title }
              blockingIssue { id number title }
            }
          }`,
          { blockedId, blockingId },
        );

        return toolSuccess({
          blocked: {
            id: result.removeBlockedBy.issue.id,
            number: result.removeBlockedBy.issue.number,
            title: result.removeBlockedBy.issue.title,
          },
          blocking: {
            id: result.removeBlockedBy.blockingIssue.id,
            number: result.removeBlockedBy.blockingIssue.number,
            title: result.removeBlockedBy.blockingIssue.title,
          },
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to remove dependency: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__list_dependencies
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__list_dependencies",
    "List all dependencies (blocking and blocked-by) for a GitHub issue",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z.string().optional().describe("Repository name. Defaults to GITHUB_REPO env var"),
      number: z.number().describe("Issue number"),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);

        const result = await client.query<{
          repository: {
            issue: {
              id: string;
              number: number;
              title: string;
              blocking: {
                nodes: Array<{
                  id: string;
                  number: number;
                  title: string;
                  state: string;
                }>;
                totalCount: number;
              };
              blockedBy: {
                nodes: Array<{
                  id: string;
                  number: number;
                  title: string;
                  state: string;
                }>;
                totalCount: number;
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
                blocking(first: 50) {
                  nodes { id number title state }
                  totalCount
                }
                blockedBy(first: 50) {
                  nodes { id number title state }
                  totalCount
                }
              }
            }
          }`,
          { owner, repo, number: args.number },
        );

        const issue = result.repository?.issue;
        if (!issue) {
          return toolError(`Issue #${args.number} not found in ${owner}/${repo}`);
        }

        return toolSuccess({
          issue: {
            id: issue.id,
            number: issue.number,
            title: issue.title,
          },
          blocking: issue.blocking.nodes.map((i) => ({
            id: i.id,
            number: i.number,
            title: i.title,
            state: i.state,
          })),
          blockedBy: issue.blockedBy.nodes.map((i) => ({
            id: i.id,
            number: i.number,
            title: i.title,
            state: i.state,
          })),
          summary: {
            totalBlocking: issue.blocking.totalCount,
            totalBlockedBy: issue.blockedBy.totalCount,
          },
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to list dependencies: ${message}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // ralph_hero__detect_group
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__detect_group",
    "Detect the group of related issues by traversing sub-issues and dependencies transitively from a seed issue. Returns all group members in topological order (blockers first). Used by Ralph workflow to discover atomic implementation groups.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z.string().optional().describe("Repository name. Defaults to GITHUB_REPO env var"),
      number: z.number().describe("Seed issue number to start group detection from"),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);

        const result = await detectGroup(client, owner, repo, args.number);

        return toolSuccess(result);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to detect group: ${message}`);
      }
    },
  );
}
