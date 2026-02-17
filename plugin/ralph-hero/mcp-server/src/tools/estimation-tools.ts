/**
 * MCP tools for heuristic issue estimation.
 *
 * Fetches issue data via GraphQL and delegates to the pure
 * estimation engine for size suggestion with confidence scoring.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import {
  suggestEstimate,
  type IssueData,
} from "../lib/estimation-engine.js";
import { toolSuccess, toolError } from "../types.js";
import { resolveConfig } from "../lib/helpers.js";

// ---------------------------------------------------------------------------
// Helper: Extract IssueData from GraphQL response
// ---------------------------------------------------------------------------

interface EstimationQueryResult {
  repository: {
    issue: {
      title: string;
      body: string;
      labels: { nodes: Array<{ name: string }> };
      subIssuesSummary: { total: number } | null;
      trackedInIssues: { totalCount: number };
      trackedIssues: { totalCount: number };
      comments: { totalCount: number };
      projectItems: {
        nodes: Array<{
          project: { number: number };
          fieldValues: {
            nodes: Array<{
              __typename?: string;
              name?: string;
              field?: { name: string };
            }>;
          };
        }>;
      };
    } | null;
  } | null;
}

export function extractIssueData(
  issue: NonNullable<NonNullable<EstimationQueryResult["repository"]>["issue"]>,
): IssueData {
  return {
    title: issue.title,
    body: issue.body || "",
    labels: issue.labels.nodes.map((l) => l.name),
    subIssueCount: issue.subIssuesSummary?.total ?? 0,
    dependencyCount:
      issue.trackedInIssues.totalCount + issue.trackedIssues.totalCount,
    commentCount: issue.comments.totalCount,
  };
}

// ---------------------------------------------------------------------------
// Register estimation tools
// ---------------------------------------------------------------------------

export function registerEstimationTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  server.tool(
    "ralph_hero__suggest_estimate",
    "Analyze issue content and suggest an XS/S/M/L/XL estimate with confidence scoring and transparent signal breakdown. Advisory only — triage agents decide whether to accept. Returns: suggestedEstimate, confidence (0-1), signals (factor/value/impact/weight for each), currentEstimate, oversized flag. Recovery: if issue not found, verify the issue number.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to env var"),
      number: z.number().describe("Issue number to estimate"),
    },
    async (args) => {
      try {
        const { owner, repo } = resolveConfig(client, args);
        const projectNumber = client.config.projectNumber;

        const result = await client.query<EstimationQueryResult>(
          `query($owner: String!, $repo: String!, $number: Int!) {
            repository(owner: $owner, name: $repo) {
              issue(number: $number) {
                title
                body
                labels(first: 20) { nodes { name } }
                subIssuesSummary { total }
                trackedInIssues(first: 1) { totalCount }
                trackedIssues(first: 1) { totalCount }
                comments(last: 1) { totalCount }
                projectItems(first: 10) {
                  nodes {
                    project { number }
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
          }`,
          { owner, repo, number: args.number },
        );

        const issue = result.repository?.issue;
        if (!issue) {
          return toolError(
            `Issue #${args.number} not found in ${owner}/${repo}`,
          );
        }

        // Extract IssueData for the engine
        const issueData = extractIssueData(issue);

        // Run estimation engine
        const estimation = suggestEstimate(issueData);

        // Extract current estimate from project field values
        let currentEstimate: string | null = null;
        const projectItem = projectNumber
          ? issue.projectItems.nodes.find(
              (pi) => pi.project.number === projectNumber,
            )
          : issue.projectItems.nodes[0];

        if (projectItem) {
          const estField = projectItem.fieldValues.nodes.find(
            (fv) =>
              fv.field?.name === "Estimate" &&
              fv.__typename === "ProjectV2ItemFieldSingleSelectValue",
          );
          currentEstimate = estField?.name ?? null;
        }

        return toolSuccess({
          number: args.number,
          suggestedEstimate: estimation.suggestedEstimate,
          confidence: estimation.confidence,
          signals: estimation.signals,
          rawScore: estimation.rawScore,
          currentEstimate,
          oversized: estimation.oversized,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to suggest estimate: ${message}`);
      }
    },
  );
}
