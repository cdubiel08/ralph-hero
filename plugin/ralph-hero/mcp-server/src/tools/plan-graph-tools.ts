/**
 * MCP tool for syncing plan dependency graphs to GitHub.
 *
 * Reads a plan markdown document, extracts dependency edges via parsePlanGraph,
 * diffs against existing GitHub blockedBy edges, and adds/removes edges to
 * converge the graph.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "fs/promises";
import type { GitHubClient } from "../github-client.js";
import { parsePlanGraph } from "../lib/plan-graph.js";
import type { DependencyEdge } from "../lib/plan-graph.js";
import { toolSuccess, toolError } from "../types.js";
import { resolveIssueNodeId, resolveConfig } from "../lib/helpers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EdgeDiff {
  added: DependencyEdge[];
  removed: DependencyEdge[];
  unchanged: DependencyEdge[];
}

// ---------------------------------------------------------------------------
// Pure function: diffDependencyEdges
// ---------------------------------------------------------------------------

/**
 * Compute the diff between declared edges (from the plan) and existing edges
 * (from GitHub), scoped to plan issues only.
 *
 * - added: edges in declared but not in existing
 * - removed: edges in existing but not in declared, where BOTH endpoints are plan issues
 * - unchanged: edges present in both declared and existing
 *
 * External edges (where one endpoint is outside the plan) are left alone.
 *
 * @param declared - Edges parsed from the plan document
 * @param existing - Edges currently on GitHub (blockedBy relationships)
 * @param planIssues - The set of issue numbers that belong to this plan
 */
export function diffDependencyEdges(
  declared: DependencyEdge[],
  existing: DependencyEdge[],
  planIssues: Set<number>,
): EdgeDiff {
  const edgeKey = (e: DependencyEdge): string =>
    `${e.blocked}:${e.blocking}`;

  const declaredSet = new Set(declared.map(edgeKey));
  const existingSet = new Set(existing.map(edgeKey));

  const added = declared.filter((e) => !existingSet.has(edgeKey(e)));
  const unchanged = declared.filter((e) => existingSet.has(edgeKey(e)));
  const removed = existing.filter(
    (e) =>
      !declaredSet.has(edgeKey(e)) &&
      planIssues.has(e.blocked) &&
      planIssues.has(e.blocking),
  );

  return { added, removed, unchanged };
}

// ---------------------------------------------------------------------------
// Register plan graph tools
// ---------------------------------------------------------------------------

export function registerPlanGraphTools(
  server: McpServer,
  client: GitHubClient,
): void {
  // -------------------------------------------------------------------------
  // ralph_hero__sync_plan_graph
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__sync_plan_graph",
    "Sync a plan document's dependency graph to GitHub blockedBy edges. " +
      "Reads the plan file, extracts dependency edges, diffs against existing GitHub edges " +
      "scoped to plan issues, and adds missing / removes stale edges. " +
      "Use dryRun=true to preview changes without mutating (default: false).",
    {
      planPath: z
        .string()
        .describe("Absolute path to the plan markdown document"),
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "When true, report what would change without mutating GitHub. Default: false.",
        ),
    },
    async (args) => {
      try {
        // Step 1: Read the plan file
        let content: string;
        try {
          content = await readFile(args.planPath, "utf-8");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return toolError(`Failed to read plan file: ${message}`);
        }

        // Step 2: Parse the dependency graph
        const graph = parsePlanGraph(content);
        if (graph.issues.length === 0) {
          return toolError(
            "Plan has no github_issues in frontmatter. Cannot sync dependencies.",
          );
        }

        const planIssues = new Set(graph.issues);
        const { owner, repo } = resolveConfig(client, {});

        // Step 3: Query existing blockedBy edges for all plan issues
        const existingEdges: DependencyEdge[] = [];
        for (const issueNum of graph.issues) {
          try {
            const result = await client.query<{
              repository: {
                issue: {
                  blockedBy: {
                    nodes: Array<{ number: number }>;
                  };
                } | null;
              } | null;
            }>(
              `query($owner: String!, $repo: String!, $number: Int!) {
                repository(owner: $owner, name: $repo) {
                  issue(number: $number) {
                    blockedBy(first: 50) {
                      nodes { number }
                    }
                  }
                }
              }`,
              { owner, repo, number: issueNum },
            );

            const blockers =
              result.repository?.issue?.blockedBy?.nodes ?? [];
            for (const blocker of blockers) {
              existingEdges.push({
                blocked: issueNum,
                blocking: blocker.number,
                source: "phase-level", // source doesn't matter for existing edges
              });
            }
          } catch (err) {
            // If we can't query an issue, skip it — it may not exist yet
            const message = err instanceof Error ? err.message : String(err);
            console.error(
              `[ralph-hero] Warning: could not query blockedBy for #${issueNum}: ${message}`,
            );
          }
        }

        // Step 4: Diff
        const diff = diffDependencyEdges(graph.edges, existingEdges, planIssues);

        // Step 5: If dryRun, return diff without mutating
        if (args.dryRun) {
          return toolSuccess({
            dryRun: true,
            planPath: args.planPath,
            planType: graph.type,
            planIssues: graph.issues,
            added: diff.added.map((e) => ({
              blocked: e.blocked,
              blocking: e.blocking,
            })),
            removed: diff.removed.map((e) => ({
              blocked: e.blocked,
              blocking: e.blocking,
            })),
            unchanged: diff.unchanged.map((e) => ({
              blocked: e.blocked,
              blocking: e.blocking,
            })),
            errors: [],
          });
        }

        // Step 6: Apply mutations
        const errors: Array<{ edge: string; error: string }> = [];

        // Add missing edges
        for (const edge of diff.added) {
          try {
            const blockedId = await resolveIssueNodeId(
              client,
              owner,
              repo,
              edge.blocked,
            );
            const blockingId = await resolveIssueNodeId(
              client,
              owner,
              repo,
              edge.blocking,
            );
            await client.mutate(
              `mutation($blockedId: ID!, $blockingId: ID!) {
                addBlockedBy(input: {
                  issueId: $blockedId,
                  blockingIssueId: $blockingId
                }) {
                  issue { id number }
                  blockingIssue { id number }
                }
              }`,
              { blockedId, blockingId },
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            errors.push({
              edge: `#${edge.blocked} blocked by #${edge.blocking}`,
              error: `addBlockedBy failed: ${message}`,
            });
          }
        }

        // Remove stale edges
        for (const edge of diff.removed) {
          try {
            const blockedId = await resolveIssueNodeId(
              client,
              owner,
              repo,
              edge.blocked,
            );
            const blockingId = await resolveIssueNodeId(
              client,
              owner,
              repo,
              edge.blocking,
            );
            await client.mutate(
              `mutation($blockedId: ID!, $blockingId: ID!) {
                removeBlockedBy(input: {
                  issueId: $blockedId,
                  blockingIssueId: $blockingId
                }) {
                  issue { id number }
                  blockingIssue { id number }
                }
              }`,
              { blockedId, blockingId },
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            errors.push({
              edge: `#${edge.blocked} blocked by #${edge.blocking}`,
              error: `removeBlockedBy failed: ${message}`,
            });
          }
        }

        return toolSuccess({
          dryRun: false,
          planPath: args.planPath,
          planType: graph.type,
          planIssues: graph.issues,
          added: diff.added.map((e) => ({
            blocked: e.blocked,
            blocking: e.blocking,
          })),
          removed: diff.removed.map((e) => ({
            blocked: e.blocked,
            blocking: e.blocking,
          })),
          unchanged: diff.unchanged.map((e) => ({
            blocked: e.blocked,
            blocking: e.blocking,
          })),
          errors,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to sync plan graph: ${message}`);
      }
    },
  );
}
