/**
 * MCP tool for creating a batch of sub-issues under a single parent in one
 * call: create the child issues, link them under the parent, add each to the
 * project board, set project fields, and wire intra-batch dependency edges.
 *
 * Runs in four aliased-GraphQL stages so the whole tree lands in a handful of
 * API calls. Partial-failure aware: each stage records per-child status so a
 * caller can repair (link/field/edge) without re-creating issues.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import { WORKFLOW_STATE_TO_STATUS } from "../lib/workflow-states.js";
import { toolSuccess, toolError } from "../types.js";
import {
  ensureFieldCache,
  resolveFullConfig,
  resolveIssueNodeId,
} from "../lib/helpers.js";
import { buildBatchMutationQuery } from "./batch-tools.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CHILDREN = 50;
const MUTATION_CHUNK_SIZE = 50; // Max aliases per aliased mutation

const FIELD_NAME_MAP = {
  workflowState: "Workflow State",
  estimate: "Estimate",
  priority: "Priority",
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChildInput {
  title: string;
  body?: string;
  estimate?: string;
  priority?: string;
  workflowState?: string;
  dependsOn?: number[];
}

interface ChildStatus {
  index: number;
  title: string;
  number?: number;
  url?: string;
  projectItemId?: string;
  created: boolean;
  linked: boolean;
  fieldsSet: boolean;
  edgesWired: boolean;
  error?: string;
  // Internal-only: node id of the created issue, used across stages.
  nodeId?: string;
}

// ---------------------------------------------------------------------------
// Aliased GraphQL builders (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Build an aliased mutation that creates multiple issues in one repo in a
 * single GraphQL call. Each issue gets per-alias title/body variables so
 * their values never collide.
 */
export function buildCreateIssuesMutation(
  repoId: string,
  issues: Array<{ alias: string; title: string; body?: string }>,
): { mutationString: string; variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = { repoId };
  const varDecls = ["$repoId: ID!"];
  const aliases: string[] = [];

  for (const { alias, title, body } of issues) {
    const titleVar = `title_${alias}`;
    const bodyVar = `body_${alias}`;
    varDecls.push(`$${titleVar}: String!`, `$${bodyVar}: String`);
    variables[titleVar] = title;
    variables[bodyVar] = body ?? null;

    aliases.push(
      `${alias}: createIssue(input: {
        repositoryId: $repoId,
        title: $${titleVar},
        body: $${bodyVar}
      }) {
        issue { id number url title }
      }`,
    );
  }

  const mutationString = `mutation(${varDecls.join(", ")}) {\n  ${aliases.join("\n  ")}\n}`;
  return { mutationString, variables };
}

/**
 * Build an aliased mutation that links multiple children under one parent
 * issue via addSubIssue in a single GraphQL call.
 */
export function buildAddSubIssuesMutation(
  parentId: string,
  subIssues: Array<{ alias: string; childId: string }>,
): { mutationString: string; variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = { parentId };
  const varDecls = ["$parentId: ID!"];
  const aliases: string[] = [];

  for (const { alias, childId } of subIssues) {
    const childVar = `child_${alias}`;
    varDecls.push(`$${childVar}: ID!`);
    variables[childVar] = childId;

    aliases.push(
      `${alias}: addSubIssue(input: {
        issueId: $parentId,
        subIssueId: $${childVar}
      }) {
        issue { id }
        subIssue { id number }
      }`,
    );
  }

  const mutationString = `mutation(${varDecls.join(", ")}) {\n  ${aliases.join("\n  ")}\n}`;
  return { mutationString, variables };
}

/**
 * Build an aliased mutation that adds multiple issues to one project via
 * addProjectV2ItemById in a single GraphQL call.
 */
export function buildAddToProjectMutation(
  projectId: string,
  items: Array<{ alias: string; contentId: string }>,
): { mutationString: string; variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = { projectId };
  const varDecls = ["$projectId: ID!"];
  const aliases: string[] = [];

  for (const { alias, contentId } of items) {
    const contentVar = `content_${alias}`;
    varDecls.push(`$${contentVar}: ID!`);
    variables[contentVar] = contentId;

    aliases.push(
      `${alias}: addProjectV2ItemById(input: {
        projectId: $projectId,
        contentId: $${contentVar}
      }) {
        item { id }
      }`,
    );
  }

  const mutationString = `mutation(${varDecls.join(", ")}) {\n  ${aliases.join("\n  ")}\n}`;
  return { mutationString, variables };
}

/**
 * Build an aliased mutation that wires multiple blocked/blocking dependency
 * edges via addBlockedBy in a single GraphQL call. Per-alias variable names
 * (`blocked_${alias}`, `blocking_${alias}`) keep node IDs collision-free.
 */
export function buildDependencyEdgesMutation(
  edges: Array<{ alias: string; blockedId: string; blockingId: string }>,
): { mutationString: string; variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = {};
  const varDecls: string[] = [];
  const aliases: string[] = [];

  for (const { alias, blockedId, blockingId } of edges) {
    const blockedVar = `blocked_${alias}`;
    const blockingVar = `blocking_${alias}`;
    varDecls.push(`$${blockedVar}: ID!`, `$${blockingVar}: ID!`);
    variables[blockedVar] = blockedId;
    variables[blockingVar] = blockingId;

    aliases.push(
      `${alias}: addBlockedBy(input: {
        issueId: $${blockedVar},
        blockingIssueId: $${blockingVar}
      }) {
        issue { id }
        blockingIssue { id }
      }`,
    );
  }

  const mutationString = `mutation(${varDecls.join(", ")}) {\n  ${aliases.join("\n  ")}\n}`;
  return { mutationString, variables };
}

// ---------------------------------------------------------------------------
// Cycle detection over sibling-index dependsOn references
// ---------------------------------------------------------------------------

/**
 * Detect a cycle among sibling-index `dependsOn` references within a single
 * create_sub_issues call. Only values `< children.length` are treated as
 * sibling indices (larger values are existing GH issue numbers and can never
 * form an intra-batch cycle). Returns the cycle members (child indices) if a
 * cycle exists, otherwise null.
 */
export function detectSiblingCycle(
  children: Array<{ title?: string; dependsOn?: number[] }>,
): number[] | null {
  const n = children.length;
  const adj: number[][] = children.map((c) =>
    (c.dependsOn ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d < n),
  );

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Array<number>(n).fill(WHITE);
  const stack: number[] = [];
  let cycle: number[] | null = null;

  const dfs = (u: number): boolean => {
    color[u] = GRAY;
    stack.push(u);
    for (const v of adj[u]) {
      if (color[v] === GRAY) {
        const idx = stack.indexOf(v);
        cycle = stack.slice(idx);
        return true;
      }
      if (color[v] === WHITE && dfs(v)) return true;
    }
    stack.pop();
    color[u] = BLACK;
    return false;
  };

  for (let i = 0; i < n; i++) {
    if (color[i] === WHITE && dfs(i)) break;
  }
  return cycle;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appendError(existing: string | undefined, message: string): string {
  return existing ? `${existing}; ${message}` : message;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Register tree tools
// ---------------------------------------------------------------------------

export function registerTreeTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  server.tool(
    "ralph_hero__create_sub_issues",
    "Create a batch of sub-issues under one parent in a single call. Runs four aliased-GraphQL stages: " +
      "(1) create the child issues, (2) link each under the parent and add it to the project board, " +
      "(3) set project fields (workflowState/estimate/priority), (4) wire intra-batch dependency edges. " +
      "Partial-failure aware: returns per-child status {number, url, projectItemId, created, linked, fieldsSet, edgesWired, error} " +
      "so a caller can repair without re-creating. estimate/priority/workflowState are passthrough " +
      "(policy gating lives in hooks). Returns partialFailure:true when any stage partially failed.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
      projectNumber: z.coerce
        .number()
        .optional()
        .describe("Project number override (defaults to configured project)"),
      parentNumber: z.coerce
        .number()
        .describe("Parent issue number the created children are linked under"),
      children: z
        .array(
          z.object({
            title: z.string().min(1).describe("Issue title (required)"),
            body: z.string().optional().describe("Issue body (markdown)"),
            estimate: z
              .enum(["XS", "S", "M", "L", "XL"])
              .optional()
              .describe("Estimate (passthrough; policy gating lives in hooks)"),
            priority: z
              .enum(["P0", "P1", "P2", "P3"])
              .optional()
              .describe("Priority"),
            workflowState: z
              .string()
              .optional()
              .describe("Initial workflow state (e.g. 'Backlog', 'Research Needed')"),
            dependsOn: z
              .array(z.coerce.number())
              .optional()
              .describe(
                "Dependency references. A value < the children array length is a " +
                  "sibling index into THIS call's children array; a value >= the " +
                  "children array length is an existing GitHub issue number. Each " +
                  "reference means this child is blocked by (depends on) the target.",
              ),
          }),
        )
        .min(1)
        .max(MAX_CHILDREN)
        .describe("Child issues to create (1-50)"),
    },
    async (args) => {
      try {
        const children = args.children as ChildInput[];

        // ---- Cycle validation (before any mutation) --------------------
        const cycle = detectSiblingCycle(children);
        if (cycle) {
          const members = cycle
            .map((i) => `#${i} (${children[i].title})`)
            .join(" -> ");
          return toolError(
            `Dependency cycle among children (sibling-index dependsOn): ${members}. ` +
              `Break the cycle before creating.`,
          );
        }

        const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);

        const projectId = fieldCache.getProjectId(projectNumber);
        if (!projectId) {
          return toolError("Could not resolve project ID");
        }

        // Resolve repository node ID (cached) for createIssue.
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

        // Resolve parent node ID (needed for addSubIssue links).
        let parentId: string;
        try {
          parentId = await resolveIssueNodeId(
            client,
            owner,
            repo,
            args.parentNumber,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return toolError(`Parent issue #${args.parentNumber}: ${message}`);
        }

        const statuses: ChildStatus[] = children.map((c, i) => ({
          index: i,
          title: c.title,
          created: false,
          linked: false,
          fieldsSet: false,
          edgesWired: false,
        }));

        let partialFailure = false;
        let firstCreateError: string | undefined;

        // ---- Stage 1: create issues (aliased, chunked at 50) -----------
        for (const chunkIndices of chunk(
          children.map((_, i) => i),
          MUTATION_CHUNK_SIZE,
        )) {
          const issues = chunkIndices.map((i) => ({
            alias: `c${i}`,
            title: children[i].title,
            body: children[i].body,
          }));
          const { mutationString, variables } = buildCreateIssuesMutation(
            repoId,
            issues,
          );

          try {
            const res = await client.mutate<
              Record<string, { issue: { id: string; number: number; url: string } } | null>
            >(mutationString, variables);
            for (const i of chunkIndices) {
              const issue = res[`c${i}`]?.issue;
              if (issue) {
                statuses[i].number = issue.number;
                statuses[i].url = issue.url;
                statuses[i].nodeId = issue.id;
                statuses[i].created = true;
              } else {
                statuses[i].error = appendError(
                  statuses[i].error,
                  "Stage 1 (create): no issue returned",
                );
                partialFailure = true;
              }
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            firstCreateError = firstCreateError ?? message;
            for (const i of chunkIndices) {
              statuses[i].error = appendError(
                statuses[i].error,
                `Stage 1 (create) failed: ${message}`,
              );
            }
            partialFailure = true;
          }
        }

        const created = statuses.filter((s) => s.created && s.nodeId);

        // Stage-1 total failure returns toolError (nothing to repair).
        if (created.length === 0) {
          return toolError(
            `Failed to create any sub-issues${
              firstCreateError ? `: ${firstCreateError}` : ""
            }`,
          );
        }

        // ---- Stage 2: link under parent + add to project --------------
        // 2a: addSubIssue (repo endpoint)
        for (const chunkStatuses of chunk(created, MUTATION_CHUNK_SIZE)) {
          const subs = chunkStatuses.map((s) => ({
            alias: `l${s.index}`,
            childId: s.nodeId!,
          }));
          const { mutationString, variables } = buildAddSubIssuesMutation(
            parentId,
            subs,
          );
          try {
            await client.mutate(mutationString, variables);
            for (const s of chunkStatuses) s.linked = true;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            for (const s of chunkStatuses) {
              s.error = appendError(s.error, `Stage 2 (link) failed: ${message}`);
            }
            partialFailure = true;
          }
        }

        // 2b: addProjectV2ItemById (project endpoint)
        for (const chunkStatuses of chunk(created, MUTATION_CHUNK_SIZE)) {
          const items = chunkStatuses.map((s) => ({
            alias: `p${s.index}`,
            contentId: s.nodeId!,
          }));
          const { mutationString, variables } = buildAddToProjectMutation(
            projectId,
            items,
          );
          try {
            const res = await client.projectMutate<
              Record<string, { item: { id: string } } | null>
            >(mutationString, variables);
            for (const s of chunkStatuses) {
              const item = res[`p${s.index}`]?.item;
              if (item) {
                s.projectItemId = item.id;
                client
                  .getCache()
                  .set(
                    `project-item-id:${owner}/${repo}#${s.number}`,
                    item.id,
                    30 * 60 * 1000,
                  );
              } else {
                s.error = appendError(
                  s.error,
                  "Stage 2 (add to project): no item returned",
                );
                partialFailure = true;
              }
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            for (const s of chunkStatuses) {
              s.error = appendError(
                s.error,
                `Stage 2 (add to project) failed: ${message}`,
              );
            }
            partialFailure = true;
          }
        }

        // ---- Stage 3: project field updates ----------------------------
        // Only children that made it onto the board can have fields set.
        const withItems = statuses.filter((s) => s.projectItemId);
        const fieldUpdates: Array<{
          alias: string;
          itemId: string;
          fieldId: string;
          optionId: string;
          childIndex: number;
        }> = [];
        // Track which children requested at least one resolvable field.
        const requestedFields = new Set<number>();

        for (const s of withItems) {
          const child = children[s.index];
          const pairs: Array<{ key: keyof typeof FIELD_NAME_MAP; value?: string }> = [
            { key: "workflowState", value: child.workflowState },
            { key: "estimate", value: child.estimate },
            { key: "priority", value: child.priority },
          ];
          for (const { key, value } of pairs) {
            if (!value) continue;
            const fieldName = FIELD_NAME_MAP[key];
            const fieldId = fieldCache.getFieldId(fieldName, projectNumber);
            const optionId = fieldCache.resolveOptionId(
              fieldName,
              value,
              projectNumber,
            );
            if (!fieldId || !optionId) {
              s.error = appendError(
                s.error,
                `Stage 3: could not resolve ${fieldName}="${value}"`,
              );
              partialFailure = true;
              continue;
            }
            requestedFields.add(s.index);
            fieldUpdates.push({
              alias: `f${s.index}_${key}`,
              itemId: s.projectItemId!,
              fieldId,
              optionId,
              childIndex: s.index,
            });

            // Best-effort Status sync for workflow-state changes.
            if (key === "workflowState") {
              const targetStatus = WORKFLOW_STATE_TO_STATUS[value];
              const statusFieldId = targetStatus
                ? fieldCache.getFieldId("Status", projectNumber)
                : undefined;
              const statusOptionId =
                targetStatus && statusFieldId
                  ? fieldCache.resolveOptionId("Status", targetStatus, projectNumber)
                  : undefined;
              if (statusFieldId && statusOptionId) {
                fieldUpdates.push({
                  alias: `f${s.index}_status`,
                  itemId: s.projectItemId!,
                  fieldId: statusFieldId,
                  optionId: statusOptionId,
                  childIndex: s.index,
                });
              }
            }
          }
        }

        // Children on the board that requested no field updates are
        // vacuously "fieldsSet". Keyed off the child's spec, not
        // requestedFields — a child whose only field failed to resolve
        // must keep fieldsSet=false alongside its Stage 3 error.
        for (const s of withItems) {
          const child = children[s.index];
          const specifiedAny = Boolean(
            child.workflowState || child.estimate || child.priority,
          );
          if (!specifiedAny) s.fieldsSet = true;
        }

        for (const chunkUpdates of chunk(fieldUpdates, MUTATION_CHUNK_SIZE)) {
          const { mutationString, variables } = buildBatchMutationQuery(
            projectId,
            chunkUpdates.map((u) => ({
              alias: u.alias,
              itemId: u.itemId,
              fieldId: u.fieldId,
              optionId: u.optionId,
            })),
          );
          const chunkChildIndices = new Set(chunkUpdates.map((u) => u.childIndex));
          try {
            await client.projectMutate(mutationString, variables);
            for (const idx of chunkChildIndices) {
              statuses[idx].fieldsSet = true;
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            for (const idx of chunkChildIndices) {
              statuses[idx].error = appendError(
                statuses[idx].error,
                `Stage 3 (fields) failed: ${message}`,
              );
            }
            partialFailure = true;
          }
        }

        // ---- Stage 4: dependency edges (addBlockedBy) ------------------
        const n = children.length;
        const edges: Array<{
          alias: string;
          blockedId: string;
          blockingId: string;
          childIndices: number[];
        }> = [];
        // Children that requested at least one edge (to distinguish
        // vacuous edgesWired from a wired one).
        const requestedEdges = new Set<number>();

        for (const s of created) {
          const child = children[s.index];
          const deps = child.dependsOn ?? [];
          for (let k = 0; k < deps.length; k++) {
            const dep = deps[k];
            requestedEdges.add(s.index);
            let blockingId: string | undefined;
            const involved = [s.index];

            if (dep < n) {
              // Sibling index — must have been created this call.
              const sibling = statuses[dep];
              if (!sibling?.created || !sibling.nodeId) {
                s.error = appendError(
                  s.error,
                  `Stage 4: sibling #${dep} was not created; skipped edge`,
                );
                partialFailure = true;
                continue;
              }
              blockingId = sibling.nodeId;
              involved.push(dep);
            } else {
              // Existing GitHub issue number.
              try {
                blockingId = await resolveIssueNodeId(client, owner, repo, dep);
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                s.error = appendError(
                  s.error,
                  `Stage 4: could not resolve blocker issue #${dep}: ${message}`,
                );
                partialFailure = true;
                continue;
              }
            }

            edges.push({
              alias: `e${s.index}_${k}`,
              blockedId: s.nodeId!,
              blockingId,
              childIndices: involved,
            });
          }
        }

        // Children requesting no edges are vacuously "edgesWired".
        for (const s of created) {
          if (!requestedEdges.has(s.index)) s.edgesWired = true;
        }

        for (const chunkEdges of chunk(edges, MUTATION_CHUNK_SIZE)) {
          const { mutationString, variables } = buildDependencyEdgesMutation(
            chunkEdges.map((e) => ({
              alias: e.alias,
              blockedId: e.blockedId,
              blockingId: e.blockingId,
            })),
          );
          const chunkChildIndices = new Set(
            chunkEdges.flatMap((e) => e.childIndices),
          );
          try {
            await client.mutate(mutationString, variables);
            // Mark the blocked child (source of the edge) as wired.
            for (const e of chunkEdges) {
              statuses[e.childIndices[0]].edgesWired = true;
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            for (const idx of chunkChildIndices) {
              statuses[idx].error = appendError(
                statuses[idx].error,
                `Stage 4 (edges) failed: ${message}`,
              );
            }
            partialFailure = true;
          }
        }

        // ---- Assemble result -------------------------------------------
        const childResults = statuses.map((s) => ({
          index: s.index,
          title: s.title,
          number: s.number,
          url: s.url,
          projectItemId: s.projectItemId,
          created: s.created,
          linked: s.linked,
          fieldsSet: s.fieldsSet,
          edgesWired: s.edgesWired,
          ...(s.error ? { error: s.error } : {}),
        }));

        return toolSuccess({
          parentNumber: args.parentNumber,
          partialFailure,
          summary: {
            total: children.length,
            created: statuses.filter((s) => s.created).length,
            linked: statuses.filter((s) => s.linked).length,
            addedToProject: statuses.filter((s) => s.projectItemId).length,
          },
          children: childResults,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to create sub-issues: ${message}`);
      }
    },
  );
}
