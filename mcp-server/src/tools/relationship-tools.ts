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
import {
  isValidState,
  isEarlierState,
  isLegalTransition,
  legalNextStates,
  isLegalParentGateAdvance,
  VALID_STATES,
  PARENT_GATE_STATES,
  LOCK_STATES,
  isParentGateState,
  stateIndex,
} from "../lib/workflow-states.js";
import { toolSuccess, toolError } from "../types.js";
import {
  ensureFieldCache,
  resolveIssueNodeId,
  resolveProjectItemId,
  updateProjectItemField,
  getCurrentFieldValue,
  getFieldValueDetail,
  resolveConfig,
  resolveFullConfig,
  syncStatusField,
} from "../lib/helpers.js";
import { isLockConflict, describeLockConflict } from "../lib/lock-guard.js";
import { zBoolish } from "../lib/zod-helpers.js";

// ---------------------------------------------------------------------------
// Sub-issue tree helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Recursively build the GraphQL selection set for nested sub-issues.
 * At the leaf level (currentDepth >= maxDepth), returns only base fields.
 * At inner levels, includes subIssuesSummary and nested subIssues.
 */
export function buildSubIssueFragment(
  currentDepth: number,
  maxDepth: number,
): string {
  const base = "id number title state";
  if (currentDepth >= maxDepth) return base;
  return `${base}
    subIssuesSummary { total completed percentCompleted }
    subIssues(first: 50) {
      nodes { ${buildSubIssueFragment(currentDepth + 1, maxDepth)} }
    }`;
}

interface SubIssueNode {
  id: string;
  number: number;
  title: string;
  state: string;
  subIssues?: SubIssueNode[];
  subIssuesSummary?: {
    total: number;
    completed: number;
    percentCompleted: number;
  };
}

/**
 * Recursively map raw GraphQL sub-issue nodes into typed SubIssueNode[].
 * Adds subIssues/subIssuesSummary fields when currentDepth < maxDepth.
 */
export function mapSubIssueNodes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nodes: any[],
  currentDepth: number,
  maxDepth: number,
): SubIssueNode[] {
  return nodes.map((node) => {
    const mapped: SubIssueNode = {
      id: node.id,
      number: node.number,
      title: node.title,
      state: node.state,
    };
    if (currentDepth < maxDepth && node.subIssues?.nodes) {
      mapped.subIssues = mapSubIssueNodes(
        node.subIssues.nodes,
        currentDepth + 1,
        maxDepth,
      );
      mapped.subIssuesSummary = node.subIssuesSummary || {
        total: node.subIssues.nodes.length,
        completed: node.subIssues.nodes.filter(
          (si: { state: string }) => si.state === "CLOSED",
        ).length,
        percentCompleted:
          node.subIssues.nodes.length > 0
            ? Math.round(
                (node.subIssues.nodes.filter(
                  (si: { state: string }) => si.state === "CLOSED",
                ).length /
                  node.subIssues.nodes.length) *
                  100,
              )
            : 0,
      };
    }
    return mapped;
  });
}

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
      parentNumber: z.coerce.number().describe("Parent issue number"),
      childNumber: z
        .coerce.number()
        .describe("Child issue number (will become sub-issue of parent)"),
      replaceParent: zBoolish()
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
    "List all sub-issues (children) of a parent GitHub issue, with completion summary. Use depth parameter (1-3) to fetch nested sub-issue trees in a single call. Default depth=1 returns direct children only.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to GITHUB_REPO env var"),
      number: z.coerce.number().describe("Parent issue number"),
      depth: z.coerce
        .number()
        .optional()
        .default(1)
        .describe(
          "How many levels of sub-issues to fetch (1=direct children, 2=children+grandchildren, max 3)",
        ),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);
        const depth = Math.min(Math.max(args.depth, 1), 3);

        const subIssueFields = buildSubIssueFragment(1, depth);
        const queryStr = `query($owner: String!, $repo: String!, $number: Int!) {
            repository(owner: $owner, name: $repo) {
              issue(number: $number) {
                id
                number
                title
                subIssuesSummary { total completed percentCompleted }
                subIssues(first: 50) {
                  nodes { ${subIssueFields} }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }`;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await client.query<any>(
          queryStr,
          { owner, repo, number: args.number },
        );

        const issue = result.repository?.issue;
        if (!issue) {
          return toolError(
            `Issue #${args.number} not found in ${owner}/${repo}`,
          );
        }

        const mappedSubIssues = mapSubIssueNodes(
          issue.subIssues.nodes,
          1,
          depth,
        );

        return toolSuccess({
          parent: {
            id: issue.id,
            number: issue.number,
            title: issue.title,
          },
          subIssues: mappedSubIssues,
          summary: issue.subIssuesSummary || {
            total: issue.subIssues.nodes.length,
            completed: issue.subIssues.nodes.filter(
              (si: { state: string }) => si.state === "CLOSED",
            ).length,
            percentCompleted:
              issue.subIssues.nodes.length > 0
                ? Math.round(
                    (issue.subIssues.nodes.filter(
                      (si: { state: string }) => si.state === "CLOSED",
                    ).length /
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
    "Create a blocking dependency between two GitHub issues. Supports cross-repo: " +
      "the blocked and blocking issues can be in different repositories. " +
      "The 'blockingNumber' issue blocks the 'blockedNumber' issue.",
    {
      owner: z
        .string()
        .optional()
        .describe("Default GitHub owner for both issues. Defaults to GITHUB_OWNER env var"),
      repo: z
        .string()
        .optional()
        .describe("Default repository for both issues. Defaults to GITHUB_REPO env var"),
      blockedNumber: z
        .number()
        .describe(
          "Issue number that IS blocked (cannot proceed until blocker is done)",
        ),
      blockedOwner: z
        .string()
        .optional()
        .describe("GitHub owner for the blocked issue. Defaults to 'owner' param"),
      blockedRepo: z
        .string()
        .optional()
        .describe("Repository for the blocked issue. Defaults to 'repo' param"),
      blockingNumber: z
        .number()
        .describe("Issue number that IS the blocker (must be completed first)"),
      blockingOwner: z
        .string()
        .optional()
        .describe("GitHub owner for the blocking issue. Defaults to 'owner' param"),
      blockingRepo: z
        .string()
        .optional()
        .describe("Repository for the blocking issue. Defaults to 'repo' param"),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);

        const bOwner = args.blockedOwner || owner;
        const bRepo = args.blockedRepo || repo;
        const kOwner = args.blockingOwner || owner;
        const kRepo = args.blockingRepo || repo;

        const blockedId = await resolveIssueNodeId(client, bOwner, bRepo, args.blockedNumber);
        const blockingId = await resolveIssueNodeId(client, kOwner, kRepo, args.blockingNumber);

        const result = await client.mutate<{
          addBlockedBy: {
            issue: { id: string; number: number; title: string; repository: { nameWithOwner: string } };
            blockingIssue: { id: string; number: number; title: string; repository: { nameWithOwner: string } };
          };
        }>(
          `mutation($blockedId: ID!, $blockingId: ID!) {
            addBlockedBy(input: {
              issueId: $blockedId,
              blockingIssueId: $blockingId
            }) {
              issue { id number title repository { nameWithOwner } }
              blockingIssue { id number title repository { nameWithOwner } }
            }
          }`,
          { blockedId, blockingId },
        );

        return toolSuccess({
          blocked: {
            id: result.addBlockedBy.issue.id,
            number: result.addBlockedBy.issue.number,
            title: result.addBlockedBy.issue.title,
            repository: result.addBlockedBy.issue.repository.nameWithOwner,
          },
          blocking: {
            id: result.addBlockedBy.blockingIssue.id,
            number: result.addBlockedBy.blockingIssue.number,
            title: result.addBlockedBy.blockingIssue.title,
            repository: result.addBlockedBy.blockingIssue.repository.nameWithOwner,
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
    "Remove a blocking dependency between two GitHub issues. Supports cross-repo: " +
      "the blocked and blocking issues can be in different repositories.",
    {
      owner: z
        .string()
        .optional()
        .describe("Default GitHub owner for both issues. Defaults to GITHUB_OWNER env var"),
      repo: z
        .string()
        .optional()
        .describe("Default repository for both issues. Defaults to GITHUB_REPO env var"),
      blockedNumber: z.coerce.number().describe("Issue number that was blocked"),
      blockedOwner: z
        .string()
        .optional()
        .describe("GitHub owner for the blocked issue. Defaults to 'owner' param"),
      blockedRepo: z
        .string()
        .optional()
        .describe("Repository for the blocked issue. Defaults to 'repo' param"),
      blockingNumber: z.coerce.number().describe("Issue number that was the blocker"),
      blockingOwner: z
        .string()
        .optional()
        .describe("GitHub owner for the blocking issue. Defaults to 'owner' param"),
      blockingRepo: z
        .string()
        .optional()
        .describe("Repository for the blocking issue. Defaults to 'repo' param"),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);

        const bOwner = args.blockedOwner || owner;
        const bRepo = args.blockedRepo || repo;
        const kOwner = args.blockingOwner || owner;
        const kRepo = args.blockingRepo || repo;

        const blockedId = await resolveIssueNodeId(client, bOwner, bRepo, args.blockedNumber);
        const blockingId = await resolveIssueNodeId(client, kOwner, kRepo, args.blockingNumber);

        const result = await client.mutate<{
          removeBlockedBy: {
            issue: { id: string; number: number; title: string; repository: { nameWithOwner: string } };
            blockingIssue: { id: string; number: number; title: string; repository: { nameWithOwner: string } };
          };
        }>(
          `mutation($blockedId: ID!, $blockingId: ID!) {
            removeBlockedBy(input: {
              issueId: $blockedId,
              blockingIssueId: $blockingId
            }) {
              issue { id number title repository { nameWithOwner } }
              blockingIssue { id number title repository { nameWithOwner } }
            }
          }`,
          { blockedId, blockingId },
        );

        return toolSuccess({
          blocked: {
            id: result.removeBlockedBy.issue.id,
            number: result.removeBlockedBy.issue.number,
            title: result.removeBlockedBy.issue.title,
            repository: result.removeBlockedBy.issue.repository.nameWithOwner,
          },
          blocking: {
            id: result.removeBlockedBy.blockingIssue.id,
            number: result.removeBlockedBy.blockingIssue.number,
            title: result.removeBlockedBy.blockingIssue.title,
            repository: result.removeBlockedBy.blockingIssue.repository.nameWithOwner,
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
    "List all blocking dependencies for a GitHub issue. Returns both 'blocking' " +
      "(issues this issue blocks) and 'blockedBy' (issues blocking this issue) " +
      "with full cross-repo context including repository name.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to GITHUB_REPO env var"),
      number: z.coerce.number().describe("Issue number to query dependencies for"),
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
              state: string;
              blocking: {
                nodes: Array<{
                  id: string;
                  number: number;
                  title: string;
                  state: string;
                  repository: { nameWithOwner: string };
                }>;
              };
              blockedBy: {
                nodes: Array<{
                  id: string;
                  number: number;
                  title: string;
                  state: string;
                  repository: { nameWithOwner: string };
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
                state
                blocking(first: 50) {
                  nodes {
                    id number title state
                    repository { nameWithOwner }
                  }
                }
                blockedBy(first: 50) {
                  nodes {
                    id number title state
                    repository { nameWithOwner }
                  }
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
            state: issue.state,
            repository: `${owner}/${repo}`,
          },
          blocking: issue.blocking.nodes.map((n) => ({
            id: n.id,
            number: n.number,
            title: n.title,
            state: n.state,
            repository: n.repository.nameWithOwner,
          })),
          blockedBy: issue.blockedBy.nodes.map((n) => ({
            id: n.id,
            number: n.number,
            title: n.title,
            state: n.state,
            repository: n.repository.nameWithOwner,
          })),
          summary: {
            blockingCount: issue.blocking.nodes.length,
            blockedByCount: issue.blockedBy.nodes.length,
            isBlocked: issue.blockedBy.nodes.length > 0,
            isBlocking: issue.blocking.nodes.length > 0,
          },
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to list dependencies: ${message}`);
      }
    },
  );

// ralph_hero__advance_issue
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__advance_issue",
    "Advance workflow state for related issues. " +
      "direction='children': advance sub-issues (or explicit list) to targetState, skipping those already at/past it. " +
      "direction='parent': check if all siblings reached a gate state and advance parent if so.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
      projectNumber: z.coerce.number().optional().describe("Project number override"),
      direction: z.enum(["children", "parent"])
        .describe("'children' advances sub-issues to targetState; 'parent' auto-detects gate state from siblings"),
      number: z.coerce.number().describe("Parent issue number (for children) or child issue number (for parent)"),
      // children-specific params
      targetState: z.string().optional()
        .describe("Target state to advance children to. Required when direction='children'."),
      issues: z.array(z.coerce.number()).optional()
        .describe("Explicit issue list instead of sub-issues. Only used with direction='children'."),
    },
    async (args) => {
      if (args.direction === "children") {
        // Validate targetState is provided
        if (!args.targetState) {
          return toolError("targetState is required when direction='children'.");
        }

        try {
          // Validate: at least number or issues must be provided
          if (args.number === undefined && (!args.issues || args.issues.length === 0)) {
            return toolError(
              "Either 'number' (parent issue) or 'issues' (explicit list) is required. " +
                "Recovery: provide one of these parameters.",
            );
          }

          // Validate target state
          if (!isValidState(args.targetState)) {
            return toolError(
              `Unknown target state '${args.targetState}'. ` +
                `Valid states: ${VALID_STATES.join(", ")}. ` +
                `Recovery: retry with a valid state name.`,
            );
          }

          const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(client, args);

          // Ensure field cache is populated
          await ensureFieldCache(
            client,
            fieldCache,
            projectOwner,
            projectNumber,
          );

          // Build issue list: from explicit `issues` param or from parent's sub-issues
          let issueNumbers: number[];

          if (args.issues && args.issues.length > 0) {
            // Explicit issue list takes precedence
            issueNumbers = args.issues;
          } else {
            // Fetch sub-issues from parent
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
              { owner, repo, number: args.number! },
            );

            const parentIssue = result.repository?.issue;
            if (!parentIssue) {
              return toolError(
                `Issue #${args.number} not found in ${owner}/${repo}`,
              );
            }

            issueNumbers = parentIssue.subIssues.nodes.map((si) => si.number);
          }

          if (issueNumbers.length === 0) {
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

          for (const issueNum of issueNumbers) {
            try {
              // Get current workflow state. GH-1616: getFieldValueDetail
              // (not the bare getCurrentFieldValue) so the lock-conflict
              // check below can name the holder + claim time, same as
              // save_issue's enriched refusal.
              const currentFieldDetail = await getFieldValueDetail(
                client,
                fieldCache,
                owner,
                repo,
                issueNum,
                "Workflow State",
                projectNumber,
              );
              const currentState = currentFieldDetail.name;

              if (!currentState) {
                skipped.push({
                  number: issueNum,
                  currentState: "unknown",
                  reason: "No workflow state set on issue",
                });
                continue;
              }

              // Only advance if issue is in an earlier state
              if (!isEarlierState(currentState, args.targetState)) {
                skipped.push({
                  number: issueNum,
                  currentState,
                  reason:
                    currentState === args.targetState
                      ? "Already at target state"
                      : "Already at or past target state",
                });
                continue;
              }

              // GH-1615: transition legality — the forward-only check above is
              // a weak monotonicity guard (it allows any earlier-to-later move,
              // including multi-gate skips like Research Needed -> In Progress,
              // and can set lock states with no lock-guard consultation). Per-
              // issue refusal, same refusal text as save_issue; batch continues.
              if (!isLegalTransition(currentState, args.targetState)) {
                const legal = legalNextStates(currentState);
                errors.push({
                  number: issueNum,
                  error:
                    `Illegal transition for #${issueNum}: "${currentState}" -> "${args.targetState}". ` +
                    `Legal next states from "${currentState}": ${legal.length > 0 ? legal.join(", ") : "(none — terminal state)"}. ` +
                    `Recovery: move through the pipeline via one of the legal states, or repair this issue ` +
                    `individually via save_issue(force: true).`,
                });
                continue;
              }

              // GH-1616: lock-conflict guard — the third of the three
              // unguarded side doors. A legal transition is not
              // automatically lock-safe (e.g. "Plan in Progress" -> "In
              // Progress" is a legal JSON edge but still a lock-to-lock
              // conflict). advance_issue has no `force` param; repair goes
              // through save_issue(force: true) one issue at a time.
              if (LOCK_STATES.includes(args.targetState) && isLockConflict(currentState, args.targetState)) {
                errors.push({
                  number: issueNum,
                  error: describeLockConflict(
                    issueNum, currentState, args.targetState,
                    currentFieldDetail.creator, currentFieldDetail.updatedAt,
                  ),
                });
                continue;
              }

              // Advance the issue
              const projectItemId = await resolveProjectItemId(
                client,
                fieldCache,
                owner,
                repo,
                issueNum,
                projectNumber,
              );
              await updateProjectItemField(
                client,
                fieldCache,
                projectItemId,
                "Workflow State",
                args.targetState,
                projectNumber,
              );

              // Sync default Status field (best-effort, one-way)
              await syncStatusField(client, fieldCache, projectItemId, args.targetState, projectNumber);

              advanced.push({
                number: issueNum,
                fromState: currentState,
                toState: args.targetState,
              });
            } catch (error: unknown) {
              const message =
                error instanceof Error ? error.message : String(error);
              errors.push({
                number: issueNum,
                error: `Failed to update: ${message}. Recovery: retry advance_issue or update this issue manually.`,
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
      } else {
        // direction === "parent"
        try {
          const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(client, args);

          await ensureFieldCache(
            client,
            fieldCache,
            projectOwner,
            projectNumber,
          );

          // Fetch child issue to find its parent
          const childResult = await client.query<{
            repository: {
              issue: {
                number: number;
                title: string;
                parent: {
                  number: number;
                  title: string;
                  state: string;
                } | null;
              } | null;
            } | null;
          }>(
            `query($owner: String!, $repo: String!, $issueNumber: Int!) {
              repository(owner: $owner, name: $repo) {
                issue(number: $issueNumber) {
                  number
                  title
                  parent { number title state }
                }
              }
            }`,
            { owner, repo, issueNumber: args.number },
          );

          const childIssue = childResult.repository?.issue;
          if (!childIssue) {
            return toolError(
              `Issue #${args.number} not found in ${owner}/${repo}`,
            );
          }

          if (!childIssue.parent) {
            return toolSuccess({
              advanced: false,
              reason: "Issue has no parent",
              child: { number: childIssue.number, title: childIssue.title },
            });
          }

          const parentNumber = childIssue.parent.number;

          // Fetch all siblings (sub-issues of the parent)
          const siblingResult = await client.query<{
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
            `query($owner: String!, $repo: String!, $parentNum: Int!) {
              repository(owner: $owner, name: $repo) {
                issue(number: $parentNum) {
                  number
                  title
                  subIssues(first: 50) {
                    nodes { id number title state }
                  }
                }
              }
            }`,
            { owner, repo, parentNum: parentNumber },
          );

          const parentIssue = siblingResult.repository?.issue;
          if (!parentIssue) {
            return toolError(
              `Parent issue #${parentNumber} not found in ${owner}/${repo}`,
            );
          }

          const siblings = parentIssue.subIssues.nodes;
          if (siblings.length === 0) {
            return toolSuccess({
              advanced: false,
              reason: "Parent has no sub-issues",
              parent: { number: parentNumber, title: parentIssue.title },
            });
          }

          // Get workflow state for each sibling and find the minimum
          const childStates: Array<{
            number: number;
            title: string;
            workflowState: string;
          }> = [];
          let minStateIdx = Infinity;

          for (const sibling of siblings) {
            const currentState = await getCurrentFieldValue(
              client,
              fieldCache,
              owner,
              repo,
              sibling.number,
              "Workflow State",
              projectNumber,
            );

            const state = currentState || "unknown";
            childStates.push({
              number: sibling.number,
              title: sibling.title,
              workflowState: state,
            });

            const idx = stateIndex(state);
            // States not in STATE_ORDER (Human Needed, Canceled, unknown) block advancement
            if (idx === -1) {
              return toolSuccess({
                advanced: false,
                reason: `Child #${sibling.number} is in state "${state}" which is outside the pipeline -- blocks parent advancement`,
                parent: { number: parentNumber, title: parentIssue.title },
                childStates,
              });
            }

            if (idx < minStateIdx) {
              minStateIdx = idx;
            }
          }

          // Find the minimum state name
          const minState = siblings.length > 0
            ? childStates.reduce((min, cs) => {
                const idx = stateIndex(cs.workflowState);
                const minIdx = stateIndex(min.workflowState);
                return idx < minIdx ? cs : min;
              }).workflowState
            : "unknown";

          // Check if the minimum state is a gate state
          if (!isParentGateState(minState)) {
            return toolSuccess({
              advanced: false,
              reason: "Not all children at a gate state",
              minimumChildState: minState,
              gateStates: [...PARENT_GATE_STATES],
              parent: { number: parentNumber, title: parentIssue.title },
              childStates,
            });
          }

          // Get parent's current workflow state
          const parentState = await getCurrentFieldValue(
            client,
            fieldCache,
            owner,
            repo,
            parentNumber,
            "Workflow State",
            projectNumber,
          );

          // GH-1615: parent-gate advance legality. The previous guard was a
          // bare `stateIndex(parent) >= stateIndex(gate)` comparison —
          // stateIndex returns -1 for Human Needed / Canceled / unset, so
          // "-1 >= n" is false and the old check always "advanced" from
          // those states, silently overwriting an escalation or writing
          // straight over a parent holding a live lock with no lock-guard
          // consultation. isLegalParentGateAdvance keeps the legitimate
          // multi-hop gate-jump carve-out (a parent at Backlog whose
          // children all reach In Review should still advance — the
          // children's own now-validated transitions are the legality
          // evidence) while refusing those two cases explicitly.
          const gateCheck = isLegalParentGateAdvance(parentState, minState);
          if (!gateCheck.ok) {
            return toolSuccess({
              advanced: false,
              reason: gateCheck.reason,
              parent: {
                number: parentNumber,
                title: parentIssue.title,
                currentState: parentState,
              },
              targetState: minState,
              childStates,
            });
          }

          // Advance the parent
          const projectItemId = await resolveProjectItemId(
            client,
            fieldCache,
            owner,
            repo,
            parentNumber,
            projectNumber,
          );
          await updateProjectItemField(
            client,
            fieldCache,
            projectItemId,
            "Workflow State",
            minState,
            projectNumber,
          );
          await syncStatusField(client, fieldCache, projectItemId, minState, projectNumber);

          return toolSuccess({
            advanced: true,
            parent: {
              number: parentNumber,
              title: parentIssue.title,
              fromState: parentState || "unknown",
              toState: minState,
            },
            childStates,
          });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return toolError(`Failed to advance parent: ${message}`);
        }
      }
    },
  );

}