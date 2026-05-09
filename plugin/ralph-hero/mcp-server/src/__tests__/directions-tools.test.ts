/**
 * Integration tests for `registerDirectionsTools` /
 * `ralph_hero__next_actions`.
 *
 * Mocks `client.projectQuery` and exercises the tool's full flow:
 *   ensureFieldCache -> paginateConnection -> toDashboardItems ->
 *   rankDirections -> toolSuccess.
 *
 * Mock-client harness mirrors `auto-advance-parent.test.ts:81-110` and
 * `repo-inference.test.ts:30-41` (the integration patterns) — NOT
 * `dashboard.test.ts` (pure-function-only).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerDirectionsTools,
  extractUnblockSignal,
} from "../tools/directions-tools.js";
import type { GitHubClient } from "../github-client.js";
import type { GitHubClientConfig } from "../types.js";
import { FieldOptionCache } from "../lib/cache.js";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

interface RawIssueFixture {
  number: number;
  title: string;
  workflowState?: string | null;
  priority?: string | null;
  estimate?: string | null;
  updatedAt?: string;
  closedAt?: string | null;
  parentNumber?: number | null;
  parentState?: string | null;
}

/**
 * Build a `node.items.nodes[]` entry that matches the shape returned by
 * `DASHBOARD_ITEMS_QUERY`. `toDashboardItems` will turn it into a
 * `DashboardItem` with the expected workflowState / priority / estimate.
 */
function rawIssue(fix: RawIssueFixture): unknown {
  const fieldValues: Array<Record<string, unknown>> = [];
  if (fix.workflowState !== undefined && fix.workflowState !== null) {
    fieldValues.push({
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      name: fix.workflowState,
      field: { name: "Workflow State" },
    });
  }
  if (fix.priority !== undefined && fix.priority !== null) {
    fieldValues.push({
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      name: fix.priority,
      field: { name: "Priority" },
    });
  }
  if (fix.estimate !== undefined && fix.estimate !== null) {
    fieldValues.push({
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      name: fix.estimate,
      field: { name: "Estimate" },
    });
  }

  const trackedInIssues =
    fix.parentNumber !== undefined && fix.parentNumber !== null
      ? {
          nodes: [
            {
              number: fix.parentNumber,
              state: fix.parentState ?? "OPEN",
              closedAt: null,
            },
          ],
        }
      : { nodes: [] };

  return {
    id: `item-${fix.number}`,
    type: "ISSUE",
    content: {
      __typename: "Issue",
      number: fix.number,
      title: fix.title,
      state: "OPEN",
      updatedAt: fix.updatedAt ?? new Date().toISOString(),
      closedAt: fix.closedAt ?? null,
      assignees: { nodes: [] },
      repository: { nameWithOwner: "owner/repo", name: "repo" },
      subIssues: { totalCount: 0 },
      trackedIssues: { nodes: [] },
      trackedInIssues,
    },
    fieldValues: { nodes: fieldValues },
  };
}

/** Wrap raw issue nodes into a `DASHBOARD_ITEMS_QUERY`-shaped response. */
function itemsResponse(nodes: unknown[]): unknown {
  return {
    node: {
      items: {
        totalCount: nodes.length,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes,
      },
    },
  };
}

/**
 * Field-cache populate response. `ensureFieldCache` queries
 * `${ownerType}(login: $owner) { projectV2 { id, fields {...} } }` and
 * tries `user` first, then `organization` — return the user shape so the
 * first attempt succeeds.
 */
function fieldCacheResponse(projectId = "project-id-123"): unknown {
  return {
    user: {
      projectV2: {
        id: projectId,
        fields: {
          nodes: [
            {
              id: "field-ws-id",
              name: "Workflow State",
              dataType: "SINGLE_SELECT",
              options: [
                { id: "opt-pir", name: "Plan in Review" },
                { id: "opt-rfp", name: "Ready for Plan" },
                { id: "opt-rn", name: "Research Needed" },
                { id: "opt-ip", name: "In Progress" },
                { id: "opt-iv", name: "In Review" },
                { id: "opt-done", name: "Done" },
              ],
            },
            {
              id: "field-pri-id",
              name: "Priority",
              dataType: "SINGLE_SELECT",
              options: [
                { id: "p0", name: "P0" },
                { id: "p1", name: "P1" },
                { id: "p2", name: "P2" },
                { id: "p3", name: "P3" },
              ],
            },
            {
              id: "field-est-id",
              name: "Estimate",
              dataType: "SINGLE_SELECT",
              options: [
                { id: "xs", name: "XS" },
                { id: "s", name: "S" },
                { id: "m", name: "M" },
              ],
            },
          ],
        },
      },
    },
  };
}

/** Detect the kind of GraphQL query being sent so we can route mock responses. */
function isFieldCacheQuery(q: string): boolean {
  return q.includes("projectV2(number:") && q.includes("fields(first:");
}

function isDashboardItemsQuery(q: string): boolean {
  return q.includes("node(id: $projectId)") && q.includes("items(first:");
}

function isOpenPRsSearchQuery(q: string): boolean {
  return q.includes("search(query:") && q.includes("... on PullRequest");
}

interface OpenPRFixture {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  reviewDecision: string | null;
  headRefName: string;
  createdAt: string;
}

interface MockClientOptions {
  /** Items response per project (keyed by project number). */
  itemsByProject?: Record<number, unknown[]>;
  /** Make ensureFieldCache fail (returns null project everywhere). */
  failFieldCache?: boolean;
  /**
   * PR fixtures returned by the internal `fetchOpenPRs` helper. Single
   * shared bucket — the helper queries one repo at a time but tests rarely
   * need per-repo routing, so a flat array keeps the mock simple.
   */
  openPRs?: OpenPRFixture[];
}

function createMockClient(
  config: Partial<GitHubClientConfig>,
  options: MockClientOptions = {},
): {
  client: GitHubClient;
  projectQuery: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
} {
  const fullConfig: GitHubClientConfig = {
    token: "tok",
    owner: "test-owner",
    projectNumber: 3,
    projectOwner: "test-owner",
    ...config,
  };

  const projectQuery = vi.fn(async (q: string, vars: Record<string, unknown>) => {
    if (isFieldCacheQuery(q)) {
      if (options.failFieldCache) {
        // Both user and organization paths return null projectV2.
        return { user: { projectV2: null }, organization: { projectV2: null } };
      }
      return fieldCacheResponse(`project-id-${vars.number}`);
    }
    if (isDashboardItemsQuery(q)) {
      // Project ID convention: "project-id-${pn}"; unwrap to find pn.
      const projectId = vars.projectId as string;
      const match = projectId.match(/project-id-(\d+)/);
      const pn = match ? Number(match[1]) : 0;
      const nodes = options.itemsByProject?.[pn] ?? [];
      return itemsResponse(nodes);
    }
    throw new Error(`Unmocked projectQuery: ${q.slice(0, 80)}`);
  });

  // `client.query` is the repo-scoped surface. The tool calls it for the
  // internal PR search (`fetchOpenPRs`). Route by the query body so
  // unrelated repo queries fall through to a clear error.
  const query = vi.fn(async (q: string) => {
    if (isOpenPRsSearchQuery(q)) {
      return { search: { nodes: options.openPRs ?? [] } };
    }
    throw new Error(`Unmocked query: ${q.slice(0, 80)}`);
  });

  const client = {
    config: fullConfig,
    query,
    projectQuery,
    projectMutate: vi.fn(),
    mutate: vi.fn(),
    getCache: vi.fn(() => ({
      get: vi.fn(),
      set: vi.fn(),
      invalidateQueries: vi.fn(),
    })),
    getAuthenticatedUser: vi.fn(),
  } as unknown as GitHubClient;

  return { client, projectQuery, query };
}

// ---------------------------------------------------------------------------
// Server / handler harness
// ---------------------------------------------------------------------------

interface HandlerResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface RegisteredTool {
  handler: (args: unknown, extra: unknown) => Promise<HandlerResult>;
}

function getTool(server: McpServer, name: string): RegisteredTool {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = tools?.[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool;
}

function buildArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // Match Zod-defaulted args. `validateToolInput` would normally do this;
  // we pass the resolved object directly so each test stays focused.
  return {
    limit: 3,
    stuckThresholdHours: 48,
    lockStaleHours: 24,
    treeRecentDoneDays: 7,
    prStaleHours: 24,
    ...overrides,
  };
}

function parsePayload(result: HandlerResult): unknown {
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ralph_hero__next_actions", () => {
  let server: McpServer;
  let fieldCache: FieldOptionCache;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    fieldCache = new FieldOptionCache();
  });

  it("registers under the new name and accepts audience param", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const fixtures = [
      rawIssue({
        number: 700,
        title: "P0 plan-in-review",
        workflowState: "Plan in Review",
        priority: "P0",
        updatedAt: oneHourAgo,
      }),
    ];

    const { client } = createMockClient(
      { projectNumber: 3 },
      { itemsByProject: { 3: fixtures } },
    );

    registerDirectionsTools(server, client, fieldCache);

    // Tool is registered under the new name
    const tool = getTool(server, "ralph_hero__next_actions");
    expect(tool).toBeDefined();

    // Call with audience=agent
    const result = await tool.handler(
      buildArgs({ limit: 1, audience: "agent" }),
      {},
    );
    const payload = parsePayload(result) as {
      directions: Array<{ recommended: boolean }>;
    };
    expect(result.isError).toBeUndefined();
    expect(payload.directions).toBeDefined();
    if (payload.directions.length > 0) {
      expect(payload.directions[0].recommended).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// extractUnblockSignal — comment parsing for `human-needed-unblock`
// (GH-1146 Phase 4)
// ---------------------------------------------------------------------------

describe("extractUnblockSignal", () => {
  const NOW = new Date("2026-05-08T12:00:00Z");
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;

  it("returns null when there is no `## Unblock Request` comment", () => {
    const comments = [
      {
        body: "## Escalation\n\nProblem with build.",
        createdAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
      },
    ];
    expect(extractUnblockSignal(comments, NOW)).toBeNull();
  });

  it("returns signal with question count from numbered list", () => {
    const comments = [
      {
        body: [
          "## Unblock Request",
          "",
          "Please answer the following questions:",
          "",
          "1. What is the expected behavior?",
          "2. Should we keep this feature?",
          "3. Is there a workaround?",
          "",
          "Thanks!",
        ].join("\n"),
        createdAt: new Date(NOW.getTime() - 2 * DAY_MS).toISOString(),
      },
    ];
    const signal = extractUnblockSignal(comments, NOW);
    expect(signal).not.toBeNull();
    expect(signal?.questionCount).toBe(3);
    expect(signal?.unblockRequestAgeDays).toBe(2);
  });

  it("returns null when an Escalation comment is newer than the Unblock Request", () => {
    const comments = [
      {
        body: "## Unblock Request\n\n1. Question?",
        createdAt: new Date(NOW.getTime() - 3 * DAY_MS).toISOString(),
      },
      {
        body: "## Escalation\n\nNew problem occurred.",
        createdAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
      },
    ];
    expect(extractUnblockSignal(comments, NOW)).toBeNull();
  });

  it("uses the most recent Unblock Request when multiple exist", () => {
    const comments = [
      {
        body: "## Unblock Request\n\n1. Q1?\n2. Q2?",
        createdAt: new Date(NOW.getTime() - 5 * DAY_MS).toISOString(),
      },
      {
        body: "## Unblock Request\n\n1. Q1?",
        createdAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
      },
    ];
    const signal = extractUnblockSignal(comments, NOW);
    expect(signal).not.toBeNull();
    expect(signal?.questionCount).toBe(1);
    expect(signal?.unblockRequestAgeDays).toBe(1);
  });

  it("treats today's unblock request as 0 days old", () => {
    const comments = [
      {
        body: "## Unblock Request\n\n1. Quick question",
        createdAt: new Date(NOW.getTime() - 2 * HOUR_MS).toISOString(),
      },
    ];
    const signal = extractUnblockSignal(comments, NOW);
    expect(signal).not.toBeNull();
    expect(signal?.unblockRequestAgeDays).toBe(0);
  });

  it("returns 0 question count when the body has no numbered list lines", () => {
    const comments = [
      {
        body: "## Unblock Request\n\nFreeform unblock — please advise.",
        createdAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
      },
    ];
    const signal = extractUnblockSignal(comments, NOW);
    expect(signal).not.toBeNull();
    expect(signal?.questionCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Structural assertion — `openPRs` parameter removed in 2.6.0 (GH-1155).
//
// Reads the source verbatim to guard against future regressions that would
// re-introduce the field. The check looks for `openPRs:` followed by a Zod
// expression in the registration block — comment / docstring mentions are
// allowed (they document the removal).
// ---------------------------------------------------------------------------

describe("openPRs parameter removed from Zod schema", () => {
  it("source contains no `openPRs: z.` registration", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      resolvePath(here, "../tools/directions-tools.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/openPRs:\s*z\./);
  });
});
