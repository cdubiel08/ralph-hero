/**
 * MCP tools for batch operations on GitHub Projects V2 issues.
 *
 * Provides bulk field-update capabilities using aliased GraphQL queries and
 * mutations for efficient batch processing (one API call per step instead
 * of one per issue). GH-1611 folded the former standalone archive tool
 * into `batch_update` as a second operation kind
 * (`{action: "archive"|"unarchive"}`) with an
 * `issues`/`projectItemIds`/`filter` selector, and ADDS the GH-0870
 * open-children guard server-side to the filter-driven bulk-scan path
 * (mirroring `findArchiveCandidates()` in `lib/hygiene.ts`) — closing a
 * bypass that existed in the standalone tool. Explicit `issues`/
 * `projectItemIds` selection intentionally bypasses the guard (targeted
 * archive/unarchive stays possible without a sub-issue check).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import { isEarlierState, WORKFLOW_STATE_TO_STATUS } from "../lib/workflow-states.js";
import { toolSuccess, toolError } from "../types.js";
import { zBoolish } from "../lib/zod-helpers.js";
import {
  ensureFieldCache,
  resolveFullConfig,
  resolveProjectItemId,
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

/** Raw shape of a project item scanned by the archive filter path. */
interface RawBulkArchiveItem {
  id: string;
  type: string;
  content: {
    number?: number;
    title?: string;
    updatedAt?: string;
    subIssues?: { totalCount: number };
  } | null;
  fieldValues: {
    nodes: Array<{
      __typename?: string;
      name?: string;
      field?: { name: string };
    }>;
  };
}

function getBulkArchiveFieldValue(
  item: RawBulkArchiveItem,
  fieldName: string,
): string | undefined {
  const fieldValue = item.fieldValues.nodes.find(
    (fv) =>
      fv.field?.name === fieldName &&
      fv.__typename === "ProjectV2ItemFieldSingleSelectValue",
  );
  return fieldValue?.name;
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
    valueType?: "singleSelectOptionId" | "iterationId";
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
    const valueKey = update.valueType ?? "singleSelectOptionId";

    varDecls.push(`$${itemVar}: ID!`, `$${fieldVar}: ID!`, `$${optVar}: String!`);
    variables[itemVar] = update.itemId;
    variables[fieldVar] = update.fieldId;
    variables[optVar] = update.optionId;

    aliases.push(
      `${update.alias}: updateProjectV2ItemFieldValue(input: {
        projectId: $projectId,
        itemId: $${itemVar},
        fieldId: $${fieldVar},
        value: { ${valueKey}: $${optVar} }
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

/**
 * Build an aliased mutation to unarchive multiple project items
 * in a single GraphQL call. Mirrors buildBatchArchiveMutation.
 */
export function buildBatchUnarchiveMutation(
  projectId: string,
  itemIds: string[],
): { mutationString: string; variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = { projectId };
  const varDecls = ["$projectId: ID!"];
  const aliases: string[] = [];

  for (let i = 0; i < itemIds.length; i++) {
    const itemVar = `item_u${i}`;
    varDecls.push(`$${itemVar}: ID!`);
    variables[itemVar] = itemIds[i];

    aliases.push(
      `u${i}: unarchiveProjectV2Item(input: {
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
const ARCHIVE_CHUNK_SIZE = 50; // Max aliases per archive/unarchive mutation
const SCAN_CAP = 2000; // Hard limit to prevent runaway pagination in filter mode

type FieldOperation = { field: BatchField; value: string };
type ActionOperation = { action: "archive" | "unarchive" };

function isFieldOperation(
  op: FieldOperation | ActionOperation,
): op is FieldOperation {
  return "field" in op;
}

function isActionOperation(
  op: FieldOperation | ActionOperation,
): op is ActionOperation {
  return "action" in op;
}

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
    "Bulk-update project fields (workflow state, estimate, priority) OR archive/unarchive project items, across multiple issues, in a single call. " +
      "Field-update mode: operations are `{field, value}` and require `issues[]` (1-50). " +
      "Archive mode: exactly one operation `{action: \"archive\"|\"unarchive\"}` (cannot be mixed with field operations) plus a selector — " +
      "`issues[]` and/or `projectItemIds[]` (explicit targeting; works for both archive and unarchive; intentionally bypasses the open-children guard), " +
      "or `filter: {workflowStates, updatedBefore?, maxItems?}` (bulk scan-until-full pagination, archive only, previewable via top-level `dryRun`). " +
      "GH-0870 guard: the `filter` bulk-scan path skips items with any sub-issues (mirrors project_hygiene's findArchiveCandidates) and reports them under `skipped` with reason `open-or-any-children`; explicit issues/projectItemIds selection does not run this check. " +
      "Uses aliased GraphQL for efficiency. Returns (field mode): {succeeded, skipped, errors, summary}. Returns (archive mode): {dryRun, action, archivedCount|wouldArchive, items, skipped, errors, hasMore, totalScanned}. " +
      "Recovery: partial failures don't abort the batch; check errors array for issues that need manual retry.",
    {
      owner: z
        .string()
        .optional()
        .describe("GitHub owner. Defaults to env var"),
      repo: z
        .string()
        .optional()
        .describe("Repository name. Defaults to env var"),
      projectNumber: z.coerce.number().optional()
        .describe("Project number override (defaults to configured project)"),
      issues: z
        .array(z.coerce.number())
        .min(1)
        .max(MAX_ISSUES)
        .optional()
        .describe(
          "Issue numbers (1-50). Required for field operations. For archive/unarchive, an explicit selector (mutually exclusive with `filter`).",
        ),
      projectItemIds: z
        .array(z.string())
        .min(1)
        .optional()
        .describe(
          "Project item IDs to archive/unarchive (for draft items with no issue number). Archive/unarchive selector only; mutually exclusive with `filter`.",
        ),
      filter: z
        .object({
          workflowStates: z
            .array(z.string())
            .min(1)
            .describe('Workflow states to match, e.g. ["Done", "Canceled"]'),
          updatedBefore: z
            .string()
            .optional()
            .describe(
              "ISO 8601 date (UTC). Only match items with updatedAt before this date.",
            ),
          maxItems: z
            .number()
            .optional()
            .describe("Max items to match per invocation (default 50, cap 200)."),
        })
        .optional()
        .describe(
          "Bulk selector for the archive action only (scan-until-full pagination). Mutually exclusive with `issues`/`projectItemIds`.",
        ),
      operations: z
        .array(
          z.union([
            z.object({
              field: z
                .enum(["workflow_state", "estimate", "priority"])
                .describe("Field to update"),
              value: z.string().describe(
                "Target value. " +
                "For workflow_state: Backlog, Research Needed, Research in Progress, Ready for Plan, " +
                "Plan in Progress, Plan in Review, In Progress, In Review, Done, Human Needed, Canceled. " +
                "For estimate: XS, S, M, L, XL. " +
                "For priority: P0, P1, P2, P3. " +
                "Note: 'Todo' is a Status field value, NOT a valid workflow state.",
              ),
            }),
            z.object({
              action: z
                .enum(["archive", "unarchive"])
                .describe(
                  "Archive or unarchive the selected items instead of updating a field.",
                ),
            }),
          ]),
        )
        .min(1)
        .max(MAX_OPERATIONS)
        .describe(
          "1-3 operations: field updates (`{field, value}`) OR exactly one `{action}` archive/unarchive operation. The two kinds cannot be mixed in one call.",
        ),
      skipIfAtOrPast: zBoolish()
        .optional()
        .default(false)
        .describe(
          "For workflow_state operations, skip issues already at or past the target state (default: false)",
        ),
      dryRun: zBoolish()
        .optional()
        .default(false)
        .describe(
          "Archive mode with `filter` only: preview matches without archiving (default: false).",
        ),
    },
    async (args) => {
      try {
        const fieldOps = args.operations.filter(isFieldOperation);
        const actionOps = args.operations.filter(isActionOperation);

        if (fieldOps.length > 0 && actionOps.length > 0) {
          return toolError(
            "Cannot mix field operations with archive/unarchive operations in the same call.",
          );
        }

        if (actionOps.length > 0) {
          if (actionOps.length > 1) {
            return toolError(
              "Only one archive/unarchive operation is allowed per call.",
            );
          }
          return await handleArchiveMode(
            client,
            fieldCache,
            args,
            actionOps[0].action,
          );
        }

        if (!args.issues || args.issues.length === 0) {
          return toolError("Field operations require `issues`.");
        }
        const issues = args.issues;

        // Validate operations
        for (const op of fieldOps) {
          if (!VALID_FIELDS.includes(op.field)) {
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

        const projectId = fieldCache.getProjectId(projectNumber);
        if (!projectId) {
          return toolError("Could not resolve project ID");
        }

        // Validate option names up front (before any API calls)
        for (const op of fieldOps) {
          const projectFieldName = FIELD_NAME_MAP[op.field];
          const optionId = fieldCache.resolveOptionId(projectFieldName, op.value, projectNumber);
          if (!optionId) {
            const validOptions = fieldCache.getOptionNames(projectFieldName, projectNumber);
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
          summary: { total: issues.length, succeeded: 0, skipped: 0, errors: 0 },
        };

        // Step 1: Batch resolve node IDs and project item IDs
        const { queryString: resolveQuery, variables: resolveVars } =
          buildBatchResolveQuery(owner, repo, issues);

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
        for (let i = 0; i < issues.length; i++) {
          const issueNumber = issues[i];
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
        const hasWorkflowStateOp = fieldOps.some(
          (op) => op.field === "workflow_state",
        );

        if (args.skipIfAtOrPast && hasWorkflowStateOp && resolved.size > 0) {
          const wsOp = fieldOps.find((op) => op.field === "workflow_state")!;

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
            for (let opIdx = 0; opIdx < fieldOps.length; opIdx++) {
              const op = fieldOps[opIdx];
              const projectFieldName = FIELD_NAME_MAP[op.field];
              const fieldId = fieldCache.getFieldId(projectFieldName, projectNumber)!;
              const optionId = fieldCache.resolveOptionId(projectFieldName, op.value, projectNumber)!;

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
                  const statusFieldId = fieldCache.getFieldId("Status", projectNumber);
                  const statusOptionId = statusFieldId
                    ? fieldCache.resolveOptionId("Status", targetStatus, projectNumber)
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
              for (const op of fieldOps) {
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

// ---------------------------------------------------------------------------
// Archive / unarchive mode (GH-1611 — folded from the former standalone archive tool)
// ---------------------------------------------------------------------------

interface ArchiveModeArgs {
  owner?: string;
  repo?: string;
  projectNumber?: number;
  issues?: number[];
  projectItemIds?: string[];
  filter?: {
    workflowStates: string[];
    updatedBefore?: string;
    maxItems?: number;
  };
  dryRun?: boolean;
}

async function handleArchiveMode(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  args: ArchiveModeArgs,
  action: "archive" | "unarchive",
) {
  const hasFilter = !!args.filter;
  const hasIssues = !!args.issues && args.issues.length > 0;
  const hasProjectItemIds = !!args.projectItemIds && args.projectItemIds.length > 0;

  if (hasFilter && (hasIssues || hasProjectItemIds)) {
    return toolError(
      "`filter` is mutually exclusive with `issues`/`projectItemIds`.",
    );
  }
  if (!hasFilter && !hasIssues && !hasProjectItemIds) {
    return toolError(
      "Provide `issues`, `projectItemIds`, or `filter` to select items for archive/unarchive.",
    );
  }
  if (action === "unarchive" && hasFilter) {
    return toolError(
      "`filter` is only valid with the `archive` action, not `unarchive`.",
    );
  }

  try {
    const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(
      client,
      args,
    );

    await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

    const projectId = fieldCache.getProjectId(projectNumber);
    if (!projectId) {
      return toolError("Could not resolve project ID");
    }

    if (hasFilter) {
      return await runFilterArchive(
        client,
        projectId,
        args.filter!,
        args.dryRun ?? false,
      );
    }

    return await runExplicitArchiveOrUnarchive(
      client,
      fieldCache,
      owner,
      repo,
      projectNumber,
      projectId,
      action,
      args.issues,
      args.projectItemIds,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`Failed to ${action}: ${message}`);
  }
}

/**
 * Bulk filter-driven archive: scan-until-full pagination over the project's
 * items, matching on workflowStates (+ optional updatedBefore), skipping
 * items with any sub-issues (GH-0870 guard, mirrors
 * `findArchiveCandidates()` in `lib/hygiene.ts`).
 */
async function runFilterArchive(
  client: GitHubClient,
  projectId: string,
  filter: { workflowStates: string[]; updatedBefore?: string; maxItems?: number },
  dryRun: boolean,
) {
  const effectiveMax = Math.min(filter.maxItems || 50, 200);

  // Validate updatedBefore early (before scan loop)
  let updatedBeforeCutoff: number | undefined;
  if (filter.updatedBefore) {
    updatedBeforeCutoff = new Date(filter.updatedBefore).getTime();
    if (isNaN(updatedBeforeCutoff)) {
      return toolError(
        "Invalid updatedBefore date. Use ISO 8601 format (e.g., 2026-02-01T00:00:00Z)",
      );
    }
  }

  // Scan-until-full: fetch pages and filter until we have enough matches or exhaust items
  const matched: RawBulkArchiveItem[] = [];
  const skipped: Array<{ number?: number; reason: string }> = [];
  let cursor: string | null = null;
  let totalScanned = 0;
  let hasMorePages = true;

  while (matched.length < effectiveMax && hasMorePages && totalScanned < SCAN_CAP) {
    const pageSize = Math.min(100, SCAN_CAP - totalScanned);
    const page = await client.projectQuery(
      `query($projectId: ID!, $cursor: String, $first: Int!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: $first, after: $cursor) {
              totalCount
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                type
                content {
                  ... on Issue {
                    number
                    title
                    updatedAt
                    subIssues { totalCount }
                  }
                  ... on PullRequest {
                    number
                    title
                    updatedAt
                  }
                }
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
      { projectId, first: pageSize, cursor },
    );

    const connection = (page as Record<string, unknown>).node as Record<string, unknown>;
    const items = (connection as Record<string, unknown>).items as {
      totalCount: number;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: RawBulkArchiveItem[];
    };

    totalScanned += items.nodes.length;

    for (const item of items.nodes) {
      if (matched.length >= effectiveMax) break;

      const ws = getBulkArchiveFieldValue(item, "Workflow State");
      if (!ws || !filter.workflowStates.includes(ws)) continue;

      if (updatedBeforeCutoff !== undefined) {
        if (!item.content?.updatedAt) continue;
        if (new Date(item.content.updatedAt).getTime() >= updatedBeforeCutoff) continue;
      }

      // GH-0870 guard (server-side, added in GH-1611): skip parents with
      // any sub-issues, mirroring findArchiveCandidates() (hygiene.ts:142).
      // This closes the bypass the former standalone archive tool had —
      // its bulk-scan query never fetched sub-issue data at all.
      const subIssueCount = item.content?.subIssues?.totalCount ?? 0;
      if (subIssueCount > 0) {
        skipped.push({
          number: item.content?.number,
          reason: "open-or-any-children",
        });
        continue;
      }

      matched.push(item);
    }

    hasMorePages = items.pageInfo.hasNextPage && !!items.pageInfo.endCursor;
    cursor = items.pageInfo.endCursor;
  }

  // Determine if more eligible items may exist beyond what we collected
  const hasMore = matched.length >= effectiveMax && hasMorePages;

  if (matched.length === 0) {
    return toolSuccess({
      dryRun,
      action: "archive",
      archivedCount: 0,
      wouldArchive: 0,
      items: [],
      skipped,
      errors: [],
      hasMore: false,
      totalScanned,
    });
  }

  // Dry run: return matched items without archiving
  if (dryRun) {
    return toolSuccess({
      dryRun: true,
      action: "archive",
      wouldArchive: matched.length,
      items: matched.map((m) => ({
        number: m.content?.number,
        title: m.content?.title,
        itemId: m.id,
      })),
      skipped,
      errors: [],
      hasMore,
      totalScanned,
    });
  }

  // Chunk and execute archive mutations
  const itemIds = matched.map((m) => m.id);
  const archived: Array<{ number?: number; title?: string; itemId: string }> = [];
  const errors: string[] = [];

  for (let i = 0; i < itemIds.length; i += ARCHIVE_CHUNK_SIZE) {
    const chunk = itemIds.slice(i, i + ARCHIVE_CHUNK_SIZE);
    const chunkItems = matched.slice(i, i + ARCHIVE_CHUNK_SIZE);
    try {
      const { mutationString, variables } =
        buildBatchArchiveMutation(projectId, chunk);
      await client.projectMutate(mutationString, variables);
      for (const item of chunkItems) {
        archived.push({
          number: item.content?.number,
          title: item.content?.title,
          itemId: item.id,
        });
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(
        `Chunk ${Math.floor(i / ARCHIVE_CHUNK_SIZE) + 1} failed: ${msg}`,
      );
    }
  }

  return toolSuccess({
    dryRun: false,
    action: "archive",
    archivedCount: archived.length,
    items: archived,
    skipped,
    errors,
    hasMore,
    totalScanned,
  });
}

/**
 * Explicit-selection archive/unarchive: `issues[]` (resolved to project
 * item IDs) and/or `projectItemIds[]` (used directly, for draft items).
 * Does NOT run the GH-0870 guard — targeted selection is deliberate.
 */
async function runExplicitArchiveOrUnarchive(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  owner: string,
  repo: string,
  projectNumber: number,
  projectId: string,
  action: "archive" | "unarchive",
  issues: number[] | undefined,
  projectItemIds: string[] | undefined,
) {
  const itemIds: string[] = [];
  const itemMeta: Array<{ number?: number; itemId: string }> = [];
  const errors: string[] = [];

  if (issues) {
    for (const num of issues) {
      try {
        const itemId = await resolveProjectItemId(
          client,
          fieldCache,
          owner,
          repo,
          num,
          projectNumber,
        );
        itemIds.push(itemId);
        itemMeta.push({ number: num, itemId });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        errors.push(`Issue #${num}: ${msg}`);
      }
    }
  }
  if (projectItemIds) {
    for (const itemId of projectItemIds) {
      itemIds.push(itemId);
      itemMeta.push({ itemId });
    }
  }

  if (itemIds.length === 0) {
    return toolSuccess({
      dryRun: false,
      action,
      archivedCount: 0,
      items: [],
      skipped: [],
      errors,
      hasMore: false,
      totalScanned: 0,
    });
  }

  const succeededItems: Array<{ number?: number; itemId: string }> = [];

  for (let i = 0; i < itemIds.length; i += ARCHIVE_CHUNK_SIZE) {
    const chunkIds = itemIds.slice(i, i + ARCHIVE_CHUNK_SIZE);
    const chunkMeta = itemMeta.slice(i, i + ARCHIVE_CHUNK_SIZE);
    try {
      const { mutationString, variables } =
        action === "archive"
          ? buildBatchArchiveMutation(projectId, chunkIds)
          : buildBatchUnarchiveMutation(projectId, chunkIds);
      await client.projectMutate(mutationString, variables);
      succeededItems.push(...chunkMeta);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(
        `Chunk ${Math.floor(i / ARCHIVE_CHUNK_SIZE) + 1} failed: ${msg}`,
      );
    }
  }

  return toolSuccess({
    dryRun: false,
    action,
    archivedCount: succeededItems.length,
    items: succeededItems,
    skipped: [],
    errors,
    hasMore: false,
    totalScanned: 0,
  });
}
