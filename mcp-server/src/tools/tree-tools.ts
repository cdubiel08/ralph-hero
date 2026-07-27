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
import {
  WORKFLOW_STATE_TO_STATUS,
  isParentGateState,
  isValidState,
  VALID_STATES,
} from "../lib/workflow-states.js";
import { toolSuccess, toolError } from "../types.js";
import {
  ensureFieldCache,
  resolveFullConfig,
  resolveIssueNodeId,
  autoAdvanceParent,
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

/**
 * Ordering for the `maxChildEstimate` ceiling check (GH-1618). Mirrors the
 * `estimate` enum on `childSchema` — smallest to largest.
 */
const ESTIMATE_ORDER = ["XS", "S", "M", "L", "XL"] as const;
type Estimate = (typeof ESTIMATE_ORDER)[number];

/** Default ceiling when `maxChildEstimate` is not supplied (GH-1618). "M"
 * keeps epic/plan-of-plans decomposition legal (this very group's siblings
 * are M-estimate children of a non-split surface) while still closing the
 * L/XL hole every ungated caller left open. */
const DEFAULT_MAX_CHILD_ESTIMATE: Estimate = "M";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Zod schema for a single child spec. `dependsOn` is sibling-index-only;
 * pre-existing GitHub issue blockers go in `dependsOnIssues`. Exported so the
 * handler input and unit tests share one source of truth (F6/F10).
 */
export const childSchema = z.object({
  title: z.string().min(1).describe("Issue title (required)"),
  body: z.string().optional().describe("Issue body (markdown)"),
  estimate: z
    .enum(["XS", "S", "M", "L", "XL"])
    .optional()
    .describe(
      "Estimate. Validated up front against the request-level " +
        "maxChildEstimate ceiling (default \"M\") before any issue is created " +
        "— see the tool description.",
    ),
  priority: z.enum(["P0", "P1", "P2", "P3"]).optional().describe("Priority"),
  workflowState: z
    .string()
    .optional()
    .describe("Initial workflow state (e.g. 'Backlog', 'Research Needed')"),
  dependsOn: z
    .array(z.coerce.number().int())
    .max(50)
    .optional()
    .describe(
      "Sibling indices ONLY — each value is a 0-based index into THIS call's " +
        "children array; the child is blocked by (depends on) that sibling. " +
        "Every value must be in [0, children.length); out-of-range values are " +
        "rejected up front. For blockers that are EXISTING GitHub issues, use " +
        "dependsOnIssues instead. Capped at 50 per child.",
    ),
  dependsOnIssues: z
    .array(z.coerce.number().int().positive())
    .max(50)
    .optional()
    .describe(
      "Existing GitHub issue numbers this child depends on (is blocked by), " +
        "resolved via node-id lookup. Use this for blockers OUTSIDE this call's " +
        "children array. Capped at 50 per child.",
    ),
});

export type ChildInput = z.infer<typeof childSchema>;

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
// Up-front dependsOnIssues resolvability (GH-1618)
// ---------------------------------------------------------------------------

/**
 * Resolve every distinct `dependsOnIssues` reference across the whole batch
 * in ONE aliased query, before any mutation. Returns the subset of `numbers`
 * that did not resolve to an existing issue in `owner/repo`. Successfully
 * resolved node IDs are seeded into the same cache key `resolveIssueNodeId`
 * reads, so Stage 4's per-edge resolution below is a cache hit rather than a
 * second round-trip.
 */
export async function resolveDependsOnIssuesUpFront(
  client: GitHubClient,
  owner: string,
  repo: string,
  numbers: number[],
): Promise<number[]> {
  const unique = Array.from(new Set(numbers));
  if (unique.length === 0) return [];

  const varDecls = ["$owner: String!", "$repo: String!"];
  const variables: Record<string, unknown> = { owner, repo };
  const aliases: string[] = [];

  unique.forEach((n, i) => {
    const numVar = `num${i}`;
    varDecls.push(`$${numVar}: Int!`);
    variables[numVar] = n;
    aliases.push(
      `n${i}: repository(owner: $owner, name: $repo) { issue(number: $${numVar}) { id } }`,
    );
  });

  const queryString = `query(${varDecls.join(", ")}) {\n  ${aliases.join("\n  ")}\n}`;
  const result = await client.query<
    Record<string, { issue: { id: string } | null } | null>
  >(queryString, variables);

  const unknown: number[] = [];
  unique.forEach((n, i) => {
    const issue = result[`n${i}`]?.issue;
    if (!issue) {
      unknown.push(n);
    } else {
      client
        .getCache()
        .set(`issue-node-id:${owner}/${repo}#${n}`, issue.id, 30 * 60 * 1000);
    }
  });
  return unknown;
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

/**
 * Pack per-child item groups into chunks of at most `size` items WITHOUT ever
 * splitting a single child's group across a chunk boundary (F3/F4). A whole
 * child group is kept intact so its status (fieldsSet / edgesWired) can never
 * be corrupted by a straddling boundary. Each returned chunk lists the child
 * indices whose groups it carries. A lone group larger than `size` (guarded
 * against by the .max(50) caps on dependsOn/dependsOnIssues) becomes its own
 * oversized chunk rather than straddling.
 */
export function packByChild<T>(
  groups: Map<number, T[]>,
  size: number,
): Array<{ childIndices: number[]; items: T[] }> {
  const chunks: Array<{ childIndices: number[]; items: T[] }> = [];
  let items: T[] = [];
  let childIndices: number[] = [];
  for (const [childIndex, group] of groups) {
    if (items.length > 0 && items.length + group.length > size) {
      chunks.push({ childIndices, items });
      items = [];
      childIndices = [];
    }
    items.push(...group);
    childIndices.push(childIndex);
  }
  if (items.length > 0) chunks.push({ childIndices, items });
  return chunks;
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
      "so a caller can repair without re-creating. Contract (GH-1618, enforced up front — a violation " +
      "creates ZERO issues): every child's estimate must be <= maxChildEstimate (defaults to \"M\" when " +
      "omitted, so no caller can create L/XL children by forgetting the param; pass e.g. \"S\" to arm an " +
      "atomic-split/ticket-tree contract, or \"XL\" for a deliberately coarse decomposition); a child with " +
      "no estimate is REFUSED when maxChildEstimate was explicitly set, or created and reported in " +
      "unestimatedChildren when it fell back to the default; every child workflowState must be a known " +
      "workflow state; every dependsOnIssues reference must resolve to an existing issue. " +
      "workflowState/priority remain passthrough (no policy gating). " +
      "Returns partialFailure:true when any stage partially failed after creation.",
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
      maxChildEstimate: z
        .enum(["XS", "S", "M", "L", "XL"])
        .optional()
        .describe(
          "Ceiling every child's estimate must be <= (GH-1618). Defaults to " +
            "\"M\" when omitted — arm \"S\" for atomic-split/ticket-tree contracts, " +
            "or raise/omit for coarser decompositions (epic feature children are " +
            "legitimately M). When explicitly set, a child with no estimate is " +
            "refused; when defaulted, an unestimated child is created and listed " +
            "in the response's unestimatedChildren. Whole-batch up-front toolError " +
            "on violation — nothing is created.",
        ),
      children: z
        .array(childSchema)
        .min(1)
        .max(MAX_CHILDREN)
        .describe("Child issues to create (1-50)"),
    },
    async (args) => {
      try {
        const children: ChildInput[] = args.children;

        // ---- dependsOn strict sibling-index validation -----------------
        // dependsOn is sibling-index-only now (F6): every value must point at
        // a real sibling in THIS call. Pre-existing GitHub blockers belong in
        // dependsOnIssues. Reject out-of-range values before any mutation.
        for (let i = 0; i < children.length; i++) {
          for (const d of children[i].dependsOn ?? []) {
            if (!Number.isInteger(d) || d < 0 || d >= children.length) {
              return toolError(
                `Child #${i} (${children[i].title}) has an invalid dependsOn ` +
                  `value ${d}: dependsOn entries must be sibling indices in ` +
                  `[0, ${children.length}). Use dependsOnIssues for blockers ` +
                  `that are existing GitHub issues.`,
              );
            }
          }
        }

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

        // ---- Child-estimate ceiling (GH-1618, before any mutation) -----
        // `maxChildEstimate` is resolved here rather than via a zod
        // `.default()` so the handler can tell "caller armed it explicitly"
        // from "fell back to the default" — the two differ on how a missing
        // child estimate is treated (refused vs. created + reported).
        const ceilingArmed = args.maxChildEstimate !== undefined;
        const effectiveCeiling: Estimate =
          args.maxChildEstimate ?? DEFAULT_MAX_CHILD_ESTIMATE;
        const ceilingIndex = ESTIMATE_ORDER.indexOf(effectiveCeiling);
        const unestimatedChildren: number[] = [];

        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          if (!child.estimate) {
            if (ceilingArmed) {
              return toolError(
                `Child #${i} ("${child.title}") has no estimate, but maxChildEstimate=${effectiveCeiling} is set — ` +
                  `the ceiling cannot be verified. No issues were created. Add an estimate ` +
                  `to every child (XS-${effectiveCeiling}) and retry.`,
              );
            }
            unestimatedChildren.push(i);
            continue;
          }
          if (ESTIMATE_ORDER.indexOf(child.estimate) > ceilingIndex) {
            return toolError(
              `Child #${i} ("${child.title}") has estimate ${child.estimate}, which exceeds maxChildEstimate=${effectiveCeiling}. ` +
                `No issues were created. Split this child further, or raise/omit ` +
                `maxChildEstimate if this is an epic-level decomposition (feature children ` +
                `may legitimately be M).`,
            );
          }
        }

        // ---- workflowState validity (before any mutation) --------------
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          if (child.workflowState && !isValidState(child.workflowState)) {
            return toolError(
              `Child #${i} ("${child.title}") has unknown workflowState "${child.workflowState}". ` +
                `Valid states: ${VALID_STATES.join(", ")}. ` +
                `No issues were created. Retry with a valid state name, or omit workflowState.`,
            );
          }
        }

        const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(
          client,
          args,
        );

        // ---- dependsOnIssues resolvability (before any mutation) -------
        // Range/self-edge/cycle checks above cover sibling-index dependsOn;
        // dependsOnIssues references issues OUTSIDE this batch and needs an
        // actual lookup. One aliased query for the whole batch, before any
        // mutation — a caller passing a typo'd or deleted issue number gets
        // a whole-batch refusal instead of a Stage 4 partial failure.
        const allDependsOnIssues = children.flatMap(
          (c) => c.dependsOnIssues ?? [],
        );
        let unresolvedDependsOnIssues: number[];
        try {
          unresolvedDependsOnIssues = await resolveDependsOnIssuesUpFront(
            client,
            owner,
            repo,
            allDependsOnIssues,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return toolError(
            `Could not verify dependsOnIssues references: ${message}. No issues were created.`,
          );
        }
        if (unresolvedDependsOnIssues.length > 0) {
          return toolError(
            `dependsOnIssues references unknown issue number(s): ${unresolvedDependsOnIssues
              .map((n) => `#${n}`)
              .join(", ")}. No issues were created. Verify the issue numbers exist ` +
              `in ${owner}/${repo} and retry.`,
          );
        }

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
            // GraphqlResponseError carries partial results in err.data: the
            // aliases that executed before the failing one. Salvage those as
            // created; only aliases absent/null get the stage error (F1).
            const data = (err as { data?: Record<string, unknown> }).data;
            for (const i of chunkIndices) {
              const issue = data
                ? (
                    data[`c${i}`] as {
                      issue?: { id: string; number: number; url: string };
                    } | null
                  )?.issue
                : undefined;
              if (issue) {
                statuses[i].number = issue.number;
                statuses[i].url = issue.url;
                statuses[i].nodeId = issue.id;
                statuses[i].created = true;
              } else {
                statuses[i].error = appendError(
                  statuses[i].error,
                  `Stage 1 (create) failed: ${message}`,
                );
              }
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
            // Salvage aliases that linked before the failing one (F2): an
            // alias present with a non-null value in err.data succeeded.
            const data = (err as { data?: Record<string, unknown> }).data;
            for (const s of chunkStatuses) {
              if (data && data[`l${s.index}`] != null) {
                s.linked = true;
              } else {
                s.error = appendError(
                  s.error,
                  `Stage 2 (link) failed: ${message}`,
                );
                partialFailure = true;
              }
            }
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
        // Field updates grouped by child index so a child's updates are
        // packed whole into a chunk and never straddle a boundary (F3).
        type FieldUpdate = {
          alias: string;
          itemId: string;
          fieldId: string;
          optionId: string;
        };
        const fieldGroups = new Map<number, FieldUpdate[]>();
        const pushFieldUpdate = (childIndex: number, u: FieldUpdate) => {
          const g = fieldGroups.get(childIndex) ?? [];
          g.push(u);
          fieldGroups.set(childIndex, g);
        };

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
            pushFieldUpdate(s.index, {
              alias: `f${s.index}_${key}`,
              itemId: s.projectItemId!,
              fieldId,
              optionId,
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
                pushFieldUpdate(s.index, {
                  alias: `f${s.index}_status`,
                  itemId: s.projectItemId!,
                  fieldId: statusFieldId,
                  optionId: statusOptionId,
                });
              }
            }
          }
        }

        // Children on the board that requested no field updates are
        // vacuously "fieldsSet". Keyed off the child's spec, not whether a
        // field resolved — a child whose only field failed to resolve must
        // keep fieldsSet=false alongside its Stage 3 error.
        for (const s of withItems) {
          const child = children[s.index];
          const specifiedAny = Boolean(
            child.workflowState || child.estimate || child.priority,
          );
          if (!specifiedAny) s.fieldsSet = true;
        }

        for (const fieldChunk of packByChild(fieldGroups, MUTATION_CHUNK_SIZE)) {
          const { mutationString, variables } = buildBatchMutationQuery(
            projectId,
            fieldChunk.items.map((u) => ({
              alias: u.alias,
              itemId: u.itemId,
              fieldId: u.fieldId,
              optionId: u.optionId,
            })),
          );
          try {
            await client.projectMutate(mutationString, variables);
            for (const idx of fieldChunk.childIndices) {
              statuses[idx].fieldsSet = true;
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            for (const idx of fieldChunk.childIndices) {
              statuses[idx].error = appendError(
                statuses[idx].error,
                `Stage 3 (fields) failed: ${message}`,
              );
            }
            partialFailure = true;
          }
        }

        // ---- Parent auto-advance (best-effort, F8) ---------------------
        // batch field writes don't auto-advance the parent the way
        // save_issue does. If children were moved to a parent-gate state,
        // fire the parent gate check per distinct gate state actually set.
        const advanceNotes: string[] = [];
        const gateReps = new Map<string, number>();
        for (const s of statuses) {
          if (!s.created || s.number == null || !s.fieldsSet) continue;
          const ws = children[s.index].workflowState;
          if (ws && isParentGateState(ws) && !gateReps.has(ws)) {
            gateReps.set(ws, s.number);
          }
        }
        for (const [gateState, repChild] of gateReps) {
          try {
            await autoAdvanceParent(
              client,
              fieldCache,
              owner,
              repo,
              repChild,
              gateState,
              projectNumber,
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            advanceNotes.push(
              `Parent auto-advance for gate "${gateState}" failed: ${message}`,
            );
          }
        }

        // ---- Stage 4: dependency edges (addBlockedBy) ------------------
        // Edges are grouped by their BLOCKED child so a child's edges pack
        // whole into a chunk (F4). `blockedIndex` is a scalar — on failure
        // the error attaches ONLY to the blocked child, never the blocking
        // sibling (F5). dependsOn holds sibling indices; dependsOnIssues
        // holds existing GH issue numbers (F6).
        type Edge = {
          alias: string;
          blockedId: string;
          blockingId: string;
          blockedIndex: number;
        };
        const edgeGroups = new Map<number, Edge[]>();
        const pushEdge = (childIndex: number, e: Edge) => {
          const g = edgeGroups.get(childIndex) ?? [];
          g.push(e);
          edgeGroups.set(childIndex, g);
        };
        // Children that requested at least one edge (to distinguish
        // vacuous edgesWired from a wired one).
        const requestedEdges = new Set<number>();

        for (const s of created) {
          const child = children[s.index];
          let k = 0;

          // Sibling-index edges (dependsOn).
          for (const dep of child.dependsOn ?? []) {
            requestedEdges.add(s.index);
            const sibling = statuses[dep];
            if (!sibling?.created || !sibling.nodeId) {
              s.error = appendError(
                s.error,
                `Stage 4: sibling #${dep} was not created; skipped edge`,
              );
              partialFailure = true;
              k++;
              continue;
            }
            pushEdge(s.index, {
              alias: `e${s.index}_${k}`,
              blockedId: s.nodeId!,
              blockingId: sibling.nodeId,
              blockedIndex: s.index,
            });
            k++;
          }

          // Existing-issue edges (dependsOnIssues).
          for (const depIssue of child.dependsOnIssues ?? []) {
            requestedEdges.add(s.index);
            let blockingId: string;
            try {
              blockingId = await resolveIssueNodeId(
                client,
                owner,
                repo,
                depIssue,
              );
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              s.error = appendError(
                s.error,
                `Stage 4: could not resolve blocker issue #${depIssue}: ${message}`,
              );
              partialFailure = true;
              k++;
              continue;
            }
            pushEdge(s.index, {
              alias: `e${s.index}_${k}`,
              blockedId: s.nodeId!,
              blockingId,
              blockedIndex: s.index,
            });
            k++;
          }
        }

        // Children requesting no edges are vacuously "edgesWired".
        for (const s of created) {
          if (!requestedEdges.has(s.index)) s.edgesWired = true;
        }

        for (const edgeChunk of packByChild(edgeGroups, MUTATION_CHUNK_SIZE)) {
          const { mutationString, variables } = buildDependencyEdgesMutation(
            edgeChunk.items.map((e) => ({
              alias: e.alias,
              blockedId: e.blockedId,
              blockingId: e.blockingId,
            })),
          );
          try {
            await client.mutate(mutationString, variables);
            // Only blocked children are in edgeChunk.childIndices.
            for (const idx of edgeChunk.childIndices) {
              statuses[idx].edgesWired = true;
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            for (const idx of edgeChunk.childIndices) {
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
          ...(advanceNotes.length ? { notes: advanceNotes } : {}),
          ...(unestimatedChildren.length ? { unestimatedChildren } : {}),
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to create sub-issues: ${message}`);
      }
    },
  );
}
