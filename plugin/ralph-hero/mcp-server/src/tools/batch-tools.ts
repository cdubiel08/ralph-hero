/**
 * MCP tools for batch operations on GitHub Projects V2 issues.
 *
 * Provides bulk-update capabilities using aliased GraphQL queries and
 * mutations for efficient batch processing (one API call per step
 * instead of one per issue).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import { isEarlierState, WORKFLOW_STATE_TO_STATUS } from "../lib/workflow-states.js";
import { toolSuccess, toolError } from "../types.js";
import {
  ensureFieldCache,
  resolveConfig,
  resolveFullConfig,
} from "../lib/helpers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ResolvedIssue {
  number: number;
  nodeId: string;
  projectItemId: string;
}

interface BatchResult {
  succeeded: Array<{ number: number; updates: Record<string, string> }>;
  skipped: Array<{ number: number; reason: string }>;
  errors: Array<{ number: number; error: string }>;
  summary: { total: number; succeeded: number; skipped: number; errors: number };
}

// ---------------------------------------------------------------------------
// Aliased GraphQL builders
// ---------------------------------------------------------------------------

/**
 * Build an aliased query to resolve issue node IDs and project item IDs
 * in a single GraphQL call.
 */
export function buildBatchResolveQuery(
  owner: string,
  repo: string,
  issueNumbers: number[],
): { queryString: string; variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = {
    owner,
    repo,
  };

  const varDecls = ["$owner: String!", "$repo: String!"];
  const aliases: string[] = [];

  for (let i = 0; i < issueNumbers.length; i++) {
    const varName = `n${i}`;
    varDecls.push(`$${varName}: Int!`);
    variables[varName] = issueNumbers[i];
    aliases.push(
      `i${i}: repository(owner: $owner, name: $repo) {
        issue(number: $${varName}) {
          id
          projectItems(first: 5) {
            nodes {
              id
              project { id }
            }
          }
        }
      }`,
    );
  }

  const queryString = `query(${varDecls.join(", ")}) {\n  ${aliases.join("\n  ")}\n}`;
  return { queryString, variables };
}

/**
 * Build an aliased mutation to update multiple project item fields
 * in a single GraphQL call.
 */
export function buildBatchMutationQuery(
  projectId: string,
  updates: Array<{
    alias: string;
    itemId: string;
    fieldId: string;
    optionId: string;
  }>,
): { mutationString: string; variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = {
    projectId,
  };

  const varDecls = ["$projectId: ID!"];
  const aliases: string[] = [];

  for (const update of updates) {
    const itemVar = `item_${update.alias}`;
    const fieldVar = `field_${update.alias}`;
    const optVar = `opt_${update.alias}`;

    varDecls.push(`$${itemVar}: ID!`, `$${fieldVar}: ID!`, `$${optVar}: String!`);
    variables[itemVar] = update.itemId;
    variables[fieldVar] = update.fieldId;
    variables[optVar] = update.optionId;

    aliases.push(
      `${update.alias}: updateProjectV2ItemFieldValue(input: {
        projectId: $projectId,
        itemId: $${itemVar},
        fieldId: $${fieldVar},
        value: { singleSelectOptionId: $${optVar} }
      }) {
        projectV2Item { id }
      }`,
    );
  }

  const mutationString = `mutation(${varDecls.join(", ")}) {\n  ${aliases.join("\n  ")}\n}`;
  return { mutationString, variables };
}

/**
 * Build an aliased query to fetch current field values for multiple
 * project items.
 */
export function buildBatchFieldValueQuery(
  projectItemIds: Array<{ alias: string; itemId: string }>,
): { queryString: string; variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = {};
  const varDecls: string[] = [];
  const aliases: string[] = [];

  for (const { alias, itemId } of projectItemIds) {
    const varName = `id_${alias}`;
    varDecls.push(`$${varName}: ID!`);
    variables[varName] = itemId;
    aliases.push(
      `${alias}: node(id: $${varName}) {
        ... on ProjectV2Item {
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
      }`,
    );
  }

  const queryString = `query(${varDecls.join(", ")}) {\n  ${aliases.join("\n  ")}\n}`;
  return { queryString, variables };
}

/**
 * Build an aliased mutation to archive multiple project items
 * in a single GraphQL call.
 */
export function buildBatchArchiveMutation(
  projectId: string,
  itemIds: string[],
): { mutationString: string; variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = { projectId };
  const varDecls = ["$projectId: ID!"];
  const aliases: string[] = [];

  for (let i = 0; i < itemIds.length; i++) {
    const itemVar = `item_a${i}`;
    varDecls.push(`$${itemVar}: ID!`);
    variables[itemVar] = itemIds[i];

    aliases.push(
      `a${i}: archiveProjectV2Item(input: {
        projectId: $projectId,
        itemId: $${itemVar}
      }) {
        item { id }
      }`,
    );
  }

  const mutationString = `mutation(${varDecls.join(", ")}) {\n  ${aliases.join("\n  ")}\n}`;
  return { mutationString, variables };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_FIELDS = ["workflow_state", "estimate", "priority"] as const;
type BatchField = (typeof VALID_FIELDS)[number];

const FIELD_NAME_MAP: Record<BatchField, string> = {
  workflow_state: "Workflow State",
  estimate: "Estimate",
  priority: "Priority",
};

const MAX_ISSUES = 50;
const MAX_OPERATIONS = 3;
const MUTATION_CHUNK_SIZE = 50; // Max aliases per mutation

// ---------------------------------------------------------------------------
// Register batch tools
// ---------------------------------------------------------------------------

export function registerBatchTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  server.tool(
    "ralph_hero__batch_update",
    "Bulk-update project fields (workflow state, estimate, priority) across multiple issues in a single call. Uses aliased GraphQL for efficiency (~2 API calls instead of 3N). Returns: succeeded, skipped, errors arrays with per-issue status. Recovery: partial failures don't abort the batch; check errors array for issues that need manual retry.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to env var"),
      issues: z
        .array(z.coerce.number())
        .min(1)
        .max(MAX_ISSUES)
        .describe("Issue numbers to update (1-50)"),
      operations: z
        .array(
          z.object({
            field: z
              .enum(["workflow_state", "estimate", "priority"])
              .describe("Field to update"),
            value: z.string().describe("Target value (e.g., 'Research Needed', 'XS', 'P1')"),
          }),
        )
        .min(1)
        .max(MAX_OPERATIONS)
        .describe("Field updates to apply to all issues (1-3)"),
      skipIfAtOrPast: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "For workflow_state operations, skip issues already at or past the target state (default: false)",
        ),
    },
    async (args) => {
      try {
        // Validate operations
        for (const op of args.operations) {
          if (!VALID_FIELDS.includes(op.field as BatchField)) {
            return toolError(
              `Invalid field "${op.field}". Valid fields: ${VALID_FIELDS.join(", ")}`,
            );
          }
        }

        const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        // Ensure field cache is populated
        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        const projectId = fieldCache.getProjectId();
        if (!projectId) {
          return toolError("Could not resolve project ID");
        }

        // Validate option names up front (before any API calls)
        for (const op of args.operations) {
          const projectFieldName = FIELD_NAME_MAP[op.field as BatchField];
          const optionId = fieldCache.resolveOptionId(projectFieldName, op.value);
          if (!optionId) {
            const validOptions = fieldCache.getOptionNames(projectFieldName);
            return toolError(
              `Invalid value "${op.value}" for field "${op.field}". ` +
                `Valid options: ${validOptions.join(", ")}`,
            );
          }
        }

        const result: BatchResult = {
          succeeded: [],
          skipped: [],
          errors: [],
          summary: { total: args.issues.length, succeeded: 0, skipped: 0, errors: 0 },
        };

        // Step 1: Batch resolve node IDs and project item IDs
        const { queryString: resolveQuery, variables: resolveVars } =
          buildBatchResolveQuery(owner, repo, args.issues);

        let resolveResult: Record<string, {
          issue: {
            id: string;
            projectItems: {
              nodes: Array<{ id: string; project: { id: string } }>;
            };
          } | null;
        }>;

        try {
          resolveResult = await client.query(resolveQuery, resolveVars);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return toolError(`Failed to resolve issues: ${message}`);
        }

        // Parse resolved issues
        const resolved: Map<number, ResolvedIssue> = new Map();
        for (let i = 0; i < args.issues.length; i++) {
          const issueNumber = args.issues[i];
          const alias = `i${i}`;
          const data = resolveResult[alias];

          if (!data?.issue) {
            result.errors.push({
              number: issueNumber,
              error: `Issue #${issueNumber} not found in ${owner}/${repo}`,
            });
            continue;
          }

          const projectItem = data.issue.projectItems.nodes.find(
            (item) => item.project.id === projectId,
          );

          if (!projectItem) {
            result.errors.push({
              number: issueNumber,
              error: `Issue #${issueNumber} is not in the project`,
            });
            continue;
          }

          // Cache the resolved IDs
          client.getCache().set(
            `issue-node-id:${owner}/${repo}#${issueNumber}`,
            data.issue.id,
            30 * 60 * 1000,
          );
          client.getCache().set(
            `project-item-id:${owner}/${repo}#${issueNumber}`,
            projectItem.id,
            30 * 60 * 1000,
          );

          resolved.set(issueNumber, {
            number: issueNumber,
            nodeId: data.issue.id,
            projectItemId: projectItem.id,
          });
        }

        // Step 2: Pre-filter with skipIfAtOrPast
        const hasWorkflowStateOp = args.operations.some(
          (op) => op.field === "workflow_state",
        );

        if (args.skipIfAtOrPast && hasWorkflowStateOp && resolved.size > 0) {
          const wsOp = args.operations.find((op) => op.field === "workflow_state")!;

          // Build batch query for current field values
          const itemsToCheck = Array.from(resolved.entries()).map(
            ([num, issue]) => ({
              alias: `fv${num}`,
              itemId: issue.projectItemId,
            }),
          );

          const { queryString: fvQuery, variables: fvVars } =
            buildBatchFieldValueQuery(itemsToCheck);

          try {
            const fvResult = await client.query<
              Record<string, {
                fieldValues?: {
                  nodes: Array<{
                    __typename?: string;
                    name?: string;
                    field?: { name: string };
                  }>;
                };
              } | null>
            >(fvQuery, fvVars);

            for (const [num, issue] of resolved) {
              const alias = `fv${num}`;
              const fvData = fvResult[alias];
              const wsValue = fvData?.fieldValues?.nodes?.find(
                (fv) =>
                  fv.field?.name === "Workflow State" &&
                  fv.__typename === "ProjectV2ItemFieldSingleSelectValue",
              )?.name;

              if (wsValue && !isEarlierState(wsValue, wsOp.value)) {
                result.skipped.push({
                  number: num,
                  reason:
                    wsValue === wsOp.value
                      ? "Already at target state"
                      : "Already past target state",
                });
                resolved.delete(num);
              }
            }
          } catch {
            // If field value fetch fails, proceed without filtering
          }
        }

        // Step 3: Build and execute aliased mutations
        if (resolved.size > 0) {
          const updates: Array<{
            alias: string;
            itemId: string;
            fieldId: string;
            optionId: string;
            issueNumber: number;
            field: string;
            value: string;
          }> = [];

          for (const [num, issue] of resolved) {
            for (let opIdx = 0; opIdx < args.operations.length; opIdx++) {
              const op = args.operations[opIdx];
              const projectFieldName = FIELD_NAME_MAP[op.field as BatchField];
              const fieldId = fieldCache.getFieldId(projectFieldName)!;
              const optionId = fieldCache.resolveOptionId(projectFieldName, op.value)!;

              updates.push({
                alias: `u${num}_${opIdx}`,
                itemId: issue.projectItemId,
                fieldId,
                optionId,
                issueNumber: num,
                field: op.field,
                value: op.value,
              });

              // For workflow_state operations, also sync the default Status field
              if (op.field === "workflow_state") {
                const targetStatus = WORKFLOW_STATE_TO_STATUS[op.value];
                if (targetStatus) {
                  const statusFieldId = fieldCache.getFieldId("Status");
                  const statusOptionId = statusFieldId
                    ? fieldCache.resolveOptionId("Status", targetStatus)
                    : undefined;
                  if (statusFieldId && statusOptionId) {
                    updates.push({
                      alias: `s${num}_${opIdx}`,
                      itemId: issue.projectItemId,
                      fieldId: statusFieldId,
                      optionId: statusOptionId,
                      issueNumber: num,
                      field: "status_sync",
                      value: targetStatus,
                    });
                  }
                }
              }
            }
          }

          // Chunk mutations if needed
          const chunks: typeof updates[] = [];
          for (let i = 0; i < updates.length; i += MUTATION_CHUNK_SIZE) {
            chunks.push(updates.slice(i, i + MUTATION_CHUNK_SIZE));
          }

          const failedIssues = new Set<number>();

          for (const chunk of chunks) {
            const { mutationString, variables: mutVars } = buildBatchMutationQuery(
              projectId,
              chunk,
            );

            try {
              await client.projectMutate(mutationString, mutVars);
              // All aliases in this chunk succeeded
            } catch (error: unknown) {
              // Batch mutation failed — treat entire chunk as failed
              // and fall back to recording errors per-issue
              const message = error instanceof Error ? error.message : String(error);
              for (const update of chunk) {
                failedIssues.add(update.issueNumber);
              }
              // Only add one error per issue (not per operation)
              const issuesInChunk = new Set(chunk.map((u) => u.issueNumber));
              for (const num of issuesInChunk) {
                if (!result.errors.some((e) => e.number === num)) {
                  result.errors.push({
                    number: num,
                    error: `Mutation failed: ${message}`,
                  });
                }
              }
            }
          }

          // Record succeeded issues
          for (const [num] of resolved) {
            if (!failedIssues.has(num)) {
              const issueUpdates: Record<string, string> = {};
              for (const op of args.operations) {
                issueUpdates[op.field] = op.value;
              }
              result.succeeded.push({ number: num, updates: issueUpdates });
            }
          }
        }

        // Compute summary
        result.summary.succeeded = result.succeeded.length;
        result.summary.skipped = result.skipped.length;
        result.summary.errors = result.errors.length;

        return toolSuccess(result);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to batch update: ${message}`);
      }
    },
  );
}
