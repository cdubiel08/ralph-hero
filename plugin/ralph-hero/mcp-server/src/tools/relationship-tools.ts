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
import {
  isValidState,
  isEarlierState,
  VALID_STATES,
} from "../lib/workflow-states.js";
import { toolSuccess, toolError, resolveProjectOwner } from "../types.js";
import {
  ensureFieldCache,
  resolveIssueNodeId,
  resolveProjectItemId,
  updateProjectItemField,
  getCurrentFieldValue,
  resolveConfig,
  syncStatusField,
} from "../lib/helpers.js";

// ---------------------------------------------------------------------------
// Register relationship tools
// ---------------------------------------------------------------------------

export function registerRelationshipTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  // -------------------------------------------------------------------------
  // ralph_hero__add_sub_issue
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__add_sub_issue",
    "Create a parent/child (sub-issue) relationship between two GitHub issues. The parent issue becomes the container for the child issue.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to GITHUB_REPO env var"),
      parentNumber: z.number().describe("Parent issue number"),
      childNumber: z
        .number()
        .describe("Child issue number (will become sub-issue of parent)"),
      replaceParent: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, move child even if it already has a parent"),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);

        const parentId = await resolveIssueNodeId(
          client,
          owner,
          repo,
          args.parentNumber,
        );
        const childId = await resolveIssueNodeId(
          client,
          owner,
          repo,
          args.childNumber,
        );

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
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to GITHUB_REPO env var"),
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
          return toolError(
            `Issue #${args.number} not found in ${owner}/${repo}`,
          );
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
            completed: issue.subIssues.nodes.filter(
              (si) => si.state === "CLOSED",
            ).length,
            percentCompleted:
              issue.subIssues.nodes.length > 0
                ? Math.round(
                    (issue.subIssues.nodes.filter((si) => si.state === "CLOSED")
                      .length /
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
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to GITHUB_REPO env var"),
      blockedNumber: z
        .number()
        .describe(
          "Issue number that IS blocked (cannot proceed until blocker is done)",
        ),
      blockingNumber: z
        .number()
        .describe("Issue number that IS the blocker (must be completed first)"),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);

        const blockedId = await resolveIssueNodeId(
          client,
          owner,
          repo,
          args.blockedNumber,
        );
        const blockingId = await resolveIssueNodeId(
          client,
          owner,
          repo,
          args.blockingNumber,
        );

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
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to GITHUB_REPO env var"),
      blockedNumber: z.number().describe("Issue number that was blocked"),
      blockingNumber: z.number().describe("Issue number that was the blocker"),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);

        const blockedId = await resolveIssueNodeId(
          client,
          owner,
          repo,
          args.blockedNumber,
        );
        const blockingId = await resolveIssueNodeId(
          client,
          owner,
          repo,
          args.blockingNumber,
        );

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
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to GITHUB_REPO env var"),
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
          return toolError(
            `Issue #${args.number} not found in ${owner}/${repo}`,
          );
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
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to GITHUB_REPO env var"),
      number: z
        .number()
        .describe("Seed issue number to start group detection from"),
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

  // -------------------------------------------------------------------------
  // ralph_hero__advance_children
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__advance_children",
    "Advance all child/sub-issues of a parent to match the parent's new state. Only advances children that are in earlier workflow states. Returns what changed, what was skipped, and any errors.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to GITHUB_REPO env var"),
      number: z.number().describe("Parent issue number"),
      targetState: z
        .string()
        .describe(
          "State to advance children to (e.g., 'Research Needed', 'Ready for Plan')",
        ),
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

        const { owner, repo } = resolveConfig(client, args);

        // Need full config for project operations
        const projectNumber = client.config.projectNumber;
        if (!projectNumber) {
          return toolError(
            "projectNumber is required (set RALPH_GH_PROJECT_NUMBER env var)",
          );
        }
        const projectOwner = resolveProjectOwner(client.config);
        if (!projectOwner) {
          return toolError(
            "projectOwner is required (set RALPH_GH_PROJECT_OWNER or RALPH_GH_OWNER env var)",
          );
        }

        // Ensure field cache is populated
        await ensureFieldCache(
          client,
          fieldCache,
          projectOwner,
          projectNumber,
        );

        // Fetch sub-issues
        const result = await client.query<{
          repository: {
            issue: {
              number: number;
              title: string;
              subIssues: {
                nodes: Array<{
                  id: string;
                  number: number;
                  title: string;
                  state: string;
                }>;
              };
            } | null;
          } | null;
        }>(
          `query($owner: String!, $repo: String!, $number: Int!) {
            repository(owner: $owner, name: $repo) {
              issue(number: $number) {
                number
                title
                subIssues(first: 50) {
                  nodes { id number title state }
                }
              }
            }
          }`,
          { owner, repo, number: args.number },
        );

        const parentIssue = result.repository?.issue;
        if (!parentIssue) {
          return toolError(
            `Issue #${args.number} not found in ${owner}/${repo}`,
          );
        }

        const subIssues = parentIssue.subIssues.nodes;
        if (subIssues.length === 0) {
          return toolSuccess({
            advanced: [],
            skipped: [],
            errors: [],
          });
        }

        const advanced: Array<{
          number: number;
          fromState: string;
          toState: string;
        }> = [];
        const skipped: Array<{
          number: number;
          currentState: string;
          reason: string;
        }> = [];
        const errors: Array<{ number: number; error: string }> = [];

        for (const child of subIssues) {
          try {
            // Get current workflow state
            const currentState = await getCurrentFieldValue(
              client,
              fieldCache,
              owner,
              repo,
              child.number,
              "Workflow State",
            );

            if (!currentState) {
              skipped.push({
                number: child.number,
                currentState: "unknown",
                reason: "No workflow state set on issue",
              });
              continue;
            }

            // Only advance if child is in an earlier state
            if (!isEarlierState(currentState, args.targetState)) {
              skipped.push({
                number: child.number,
                currentState,
                reason:
                  currentState === args.targetState
                    ? "Already at target state"
                    : "Already at or past target state",
              });
              continue;
            }

            // Advance the child
            const projectItemId = await resolveProjectItemId(
              client,
              fieldCache,
              owner,
              repo,
              child.number,
            );
            await updateProjectItemField(
              client,
              fieldCache,
              projectItemId,
              "Workflow State",
              args.targetState,
            );

            // Sync default Status field (best-effort, one-way)
            await syncStatusField(client, fieldCache, projectItemId, args.targetState);

            advanced.push({
              number: child.number,
              fromState: currentState,
              toState: args.targetState,
            });
          } catch (error: unknown) {
            const message =
              error instanceof Error ? error.message : String(error);
            errors.push({
              number: child.number,
              error: `Failed to update: ${message}. Recovery: retry advance_children or update this child manually via update_workflow_state.`,
            });
          }
        }

        return toolSuccess({
          advanced,
          skipped,
          errors,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to advance children: ${message}`);
      }
    },
  );
}

