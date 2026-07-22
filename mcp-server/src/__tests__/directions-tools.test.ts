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
  extractDecisionSignal,
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
  /**
   * Override the `nameWithOwner` carried in the project item. Defaults to
   * `owner/repo`. Tests that exercise multi-repo behavior (e.g. the GH-1399
   * foreign-repo PR-leak regression) override this so item fixtures can map
   * to distinct repos.
   */
  repository?: string;
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
      repository: (() => {
        const nameWithOwner = fix.repository ?? "owner/repo";
        const name = nameWithOwner.includes("/")
          ? nameWithOwner.split("/")[1]
          : nameWithOwner;
        return { nameWithOwner, name };
      })(),
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

function isIssueCommentsQuery(q: string): boolean {
  return q.includes("issue(number: $number)") && q.includes("comments(last:");
}

interface IssueCommentFixture {
  body: string;
  createdAt: string;
  url?: string;
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
  /**
   * Per-issue comment fixtures served to the issue-comments query used by
   * buildUnblockSignalMap / buildDecisionSignalMap. Issues without an
   * entry return an empty comment list (instead of the throw-and-swallow
   * path), keeping signal extraction observable end-to-end.
   */
  commentsByIssue?: Record<number, IssueCommentFixture[]>;
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
  // unrelated repo queries fall through to a clear error. PRs are filtered
  // by the `q` variable's `repo:<owner>/<repo>` clause so a per-repo search
  // returns only that repo's fixtures — required for the GH-1399 regression
  // to observe radius tightening rather than a global PR dump.
  const query = vi.fn(
    async (q: string, vars?: { q?: string; number?: number }) => {
      if (isOpenPRsSearchQuery(q)) {
        const searchExpr = vars?.q ?? "";
        const repoMatch = searchExpr.match(/repo:([^\s]+)/);
        const queriedRepo = repoMatch?.[1] ?? null;
        const all = options.openPRs ?? [];
        const filtered =
          queriedRepo === null
            ? all
            : all.filter((pr) => pr.url.includes(queriedRepo));
        return { search: { nodes: filtered } };
      }
      if (isIssueCommentsQuery(q)) {
        const nodes = options.commentsByIssue?.[vars?.number ?? -1] ?? [];
        return { repository: { issue: { comments: { nodes } } } };
      }
      throw new Error(`Unmocked query: ${q.slice(0, 80)}`);
    },
  );

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

  // -------------------------------------------------------------------------
  // GH-1399 regression: closed cross-repo items must not expand the PR-search
  // radius. A stale closed item from a foreign repo on the board would
  // otherwise pull every open PR from that repo into the directions ranking.
  // -------------------------------------------------------------------------

  it("does not search PRs from foreign repos whose only board items are closed", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const twoWeeksAgo = new Date(
      Date.now() - 14 * 24 * 60 * 60 * 1000,
    ).toISOString();

    // Project mix mirrors the GH-1399 repro: one open item from the
    // "primary" repo, one closed item from a foreign repo. The foreign
    // repo should NOT trigger an `is:pr is:open repo:owner/foreign-repo`
    // search, regardless of whether open PRs exist there.
    const fixtures = [
      rawIssue({
        number: 904,
        title: "Primary repo open issue",
        workflowState: "Ready for Plan",
        priority: "P1",
        updatedAt: oneHourAgo,
        repository: "owner/primary-repo",
      }),
      rawIssue({
        number: 731,
        title: "Foreign repo stale closed issue",
        workflowState: "Done",
        priority: "P2",
        updatedAt: twoWeeksAgo,
        closedAt: twoWeeksAgo,
        repository: "owner/foreign-repo",
      }),
    ];

    const { client, query } = createMockClient(
      { projectNumber: 3 },
      {
        itemsByProject: { 3: fixtures },
        // Open PR exists in the foreign repo — would have leaked before GH-1399.
        // Returned for any PR search; assertion below checks no foreign-repo
        // search was issued at all.
        openPRs: [
          {
            number: 1355,
            title: "Foreign repo open PR",
            url: "https://github.com/owner/foreign-repo/pull/1355",
            isDraft: false,
            reviewDecision: "REVIEW_REQUIRED",
            headRefName: "feature/GH-1301",
            createdAt: twoWeeksAgo,
          },
        ],
      },
    );

    registerDirectionsTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__next_actions");

    const result = await tool.handler(
      buildArgs({ limit: 5, audience: "agent" }),
      {},
    );
    const payload = parsePayload(result) as {
      directions: Array<{ kind: string; pr: { url: string } | null }>;
    };

    expect(result.isError).toBeUndefined();

    // Observable 1: no PR direction surfaces for the foreign repo.
    const foreignPrDirections = payload.directions.filter(
      (d) => d.kind === "pr" && d.pr?.url.includes("owner/foreign-repo"),
    );
    expect(foreignPrDirections).toHaveLength(0);

    // Observable 2 (load-bearing): no GraphQL search was issued against the
    // foreign repo. Asserts the radius tightened — not just the output filter.
    const prSearchCalls = query.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("... on PullRequest"),
    );
    for (const call of prSearchCalls) {
      const vars = call[1] as { q?: string } | undefined;
      expect(vars?.q ?? "").not.toContain("owner/foreign-repo");
    }
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

  // -------------------------------------------------------------------------
  // GH-1551: enumerate="human-queue" — full human queue, unsliced
  // -------------------------------------------------------------------------

  function actionableFixtures(): unknown[] {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    return [
      rawIssue({
        number: 710,
        title: "Plan review A",
        workflowState: "Plan in Review",
        priority: "P0",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 711,
        title: "In review B",
        workflowState: "In Review",
        priority: "P1",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 712,
        title: "Ready for plan C",
        workflowState: "Ready for Plan",
        priority: "P2",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 713,
        title: "Research needed D",
        workflowState: "Research Needed",
        priority: "P3",
        updatedAt: oneHourAgo,
      }),
    ];
  }

  it("enumerate='human-queue' returns the full queue, ignoring limit", async () => {
    const { client } = createMockClient(
      { projectNumber: 3 },
      { itemsByProject: { 3: actionableFixtures() } },
    );
    registerDirectionsTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__next_actions");

    const result = await tool.handler(
      buildArgs({ limit: 1, enumerate: "human-queue" }),
      {},
    );
    const payload = parsePayload(result) as {
      directions: Array<{ rank: number; recommended: boolean }>;
      boardItems: number;
    };
    expect(result.isError).toBeUndefined();
    expect(payload.directions).toHaveLength(4);
    payload.directions.forEach((d, idx) => {
      expect(d.rank).toBe(idx + 1);
      expect(d.recommended).toBe(idx === 0);
    });
    expect(payload.boardItems).toBe(4);
  });

  it("enumerate surfaces plan-decision holds with sourceCommentUrl from the mocked comment", async () => {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const commentUrl =
      "https://github.com/test-owner/r/issues/720#issuecomment-999";
    const fixtures = [
      ...actionableFixtures(),
      rawIssue({
        number: 720,
        title: "Held plan",
        workflowState: "Plan in Review",
        priority: "P2",
        updatedAt: oneDayAgo,
      }),
    ];
    const { client } = createMockClient(
      { projectNumber: 3 },
      {
        itemsByProject: { 3: fixtures },
        commentsByIssue: {
          720: [
            {
              body: "## Decision Request\n\n### Storage backend",
              createdAt: oneDayAgo,
              url: commentUrl,
            },
          ],
        },
      },
    );
    registerDirectionsTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__next_actions");

    const result = await tool.handler(
      buildArgs({ limit: 1, enumerate: "human-queue" }),
      {},
    );
    const payload = parsePayload(result) as {
      directions: Array<{
        kind: string;
        issue: { number: number } | null;
        signals: { sourceCommentUrl?: string };
      }>;
    };
    expect(result.isError).toBeUndefined();
    const decision = payload.directions.find((d) => d.kind === "plan-decision");
    expect(decision).toBeDefined();
    expect(decision?.issue?.number).toBe(720);
    expect(decision?.signals.sourceCommentUrl).toBe(commentUrl);
  });

  it("enumerate forces human audience even when audience='agent' is passed", async () => {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const fixtures = [
      ...actionableFixtures(),
      rawIssue({
        number: 730,
        title: "Held plan agent-invisible",
        workflowState: "Plan in Review",
        priority: "P2",
        updatedAt: oneDayAgo,
      }),
    ];
    const { client } = createMockClient(
      { projectNumber: 3 },
      {
        itemsByProject: { 3: fixtures },
        commentsByIssue: {
          730: [
            {
              body: "## Decision Request\n\n### Only decision",
              createdAt: oneDayAgo,
              url: "https://github.com/test-owner/r/issues/730#issuecomment-1",
            },
          ],
        },
      },
    );
    registerDirectionsTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__next_actions");

    const result = await tool.handler(
      buildArgs({ limit: 2, audience: "agent", enumerate: "human-queue" }),
      {},
    );
    const payload = parsePayload(result) as {
      directions: Array<{ kind: string; issue: { number: number } | null }>;
    };
    expect(result.isError).toBeUndefined();
    // Agent audience would EXCLUDE the held plan; the server-side human
    // override must keep it in the enumeration.
    const held = payload.directions.find((d) => d.issue?.number === 730);
    expect(held).toBeDefined();
    expect(held?.kind).toBe("plan-decision");
  });

  it("byte-compat: default (no-enumerate) response matches the hard-coded expected object", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const fixtures = [
      rawIssue({
        number: 700,
        title: "P0 plan-in-review",
        workflowState: "Plan in Review",
        priority: "P0",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 701,
        title: "P1 ready-for-plan",
        workflowState: "Ready for Plan",
        priority: "P1",
        updatedAt: oneHourAgo,
      }),
    ];
    const { client } = createMockClient(
      { projectNumber: 3 },
      { itemsByProject: { 3: fixtures } },
    );
    registerDirectionsTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__next_actions");

    const result = await tool.handler(buildArgs({}), {});
    const payload = parsePayload(result) as Record<string, unknown>;
    expect(result.isError).toBeUndefined();
    expect(payload).toEqual({
      fetchedAt: expect.any(String),
      boardItems: 2,
      directions: [
        {
          rank: 1,
          recommended: true,
          kind: "issue",
          issue: {
            number: 700,
            title: "P0 plan-in-review",
            workflowState: "Plan in Review",
            priority: "P0",
            estimate: null,
          },
          pr: null,
          signals: { tags: ["high-priority"], staleThresholdDays: 2 },
          reason: expect.any(String),
          tags: ["high-priority"],
          score: 0,
        },
        {
          rank: 2,
          recommended: false,
          kind: "issue",
          issue: {
            number: 701,
            title: "P1 ready-for-plan",
            workflowState: "Ready for Plan",
            priority: "P1",
            estimate: null,
          },
          pr: null,
          signals: { tags: ["high-priority"], staleThresholdDays: 2 },
          reason: expect.any(String),
          tags: ["high-priority"],
          score: 12,
        },
      ],
    });
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
        url: "https://github.com/o/r/issues/5#issuecomment-777",
      },
    ];
    const signal = extractUnblockSignal(comments, NOW);
    expect(signal).not.toBeNull();
    expect(signal?.questionCount).toBe(3);
    expect(signal?.unblockRequestAgeDays).toBe(2);
    expect(signal?.sourceCommentUrl).toBe(
      "https://github.com/o/r/issues/5#issuecomment-777",
    );
  });

  it("omits sourceCommentUrl when the comment node has no url field", () => {
    const comments = [
      {
        body: "## Unblock Request\n\n1. Question?",
        createdAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
      },
    ];
    const signal = extractUnblockSignal(comments, NOW);
    expect(signal).not.toBeNull();
    expect(signal?.sourceCommentUrl).toBeUndefined();
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
// extractDecisionSignal — comment parsing for `plan-decision` (GH-1546)
// ---------------------------------------------------------------------------

describe("extractDecisionSignal", () => {
  const NOW = new Date("2026-07-18T12:00:00Z");
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;

  it("returns null when there is no `## Decision Request` comment", () => {
    const comments = [
      {
        body: "## Implementation Plan\n\nPlan: thoughts/shared/plans/x.md",
        createdAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
      },
    ];
    expect(extractDecisionSignal(comments, NOW)).toBeNull();
  });

  it("returns signal with decision count from ### section headers", () => {
    const comments = [
      {
        body: [
          "## Decision Request",
          "",
          "### Park location",
          "- **Context**: ...",
          "",
          "### Skip scope",
          "- **Context**: ...",
          "",
          "Reply here, or run /ralph:plan --mode review 123",
        ].join("\n"),
        createdAt: new Date(NOW.getTime() - 2 * DAY_MS).toISOString(),
        url: "https://github.com/o/r/issues/123#issuecomment-888",
      },
    ];
    const signal = extractDecisionSignal(comments, NOW);
    expect(signal).not.toBeNull();
    expect(signal?.decisionCount).toBe(2);
    expect(signal?.decisionRequestAgeDays).toBe(2);
    expect(signal?.sourceCommentUrl).toBe(
      "https://github.com/o/r/issues/123#issuecomment-888",
    );
  });

  it("omits sourceCommentUrl when the request comment has no url field", () => {
    const comments = [
      {
        body: "## Decision Request\n\n### Lone decision",
        createdAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
      },
    ];
    const signal = extractDecisionSignal(comments, NOW);
    expect(signal).not.toBeNull();
    expect(signal?.sourceCommentUrl).toBeUndefined();
  });

  it("returns null when ANY comment is newer than the request (answered)", () => {
    const comments = [
      {
        body: "## Decision Request\n\n### Park location",
        createdAt: new Date(NOW.getTime() - 3 * DAY_MS).toISOString(),
      },
      {
        body: "Go with option 1 — Plan in Review + comment.",
        createdAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
      },
    ];
    expect(extractDecisionSignal(comments, NOW)).toBeNull();
  });

  it("uses the most recent Decision Request when multiple exist", () => {
    const comments = [
      {
        body: "## Decision Request\n\n### Old A\n\n### Old B",
        createdAt: new Date(NOW.getTime() - 6 * DAY_MS).toISOString(),
      },
      {
        body: "## Decision Request\n\n### Remaining",
        createdAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
      },
    ];
    const signal = extractDecisionSignal(comments, NOW);
    expect(signal).not.toBeNull();
    expect(signal?.decisionCount).toBe(1);
    expect(signal?.decisionRequestAgeDays).toBe(1);
  });

  it("floors decisionCount at 1 when the body has no ### sections", () => {
    const comments = [
      {
        body: "## Decision Request\n\nFreeform — which storage backend?",
        createdAt: new Date(NOW.getTime() - 5 * HOUR_MS).toISOString(),
      },
    ];
    const signal = extractDecisionSignal(comments, NOW);
    expect(signal).not.toBeNull();
    expect(signal?.decisionCount).toBe(1);
    expect(signal?.decisionRequestAgeDays).toBe(0);
  });

  it("comments OLDER than the request do not count as answers", () => {
    const comments = [
      {
        body: "## Implementation Plan\n\nPlan: ...",
        createdAt: new Date(NOW.getTime() - 4 * DAY_MS).toISOString(),
      },
      {
        body: "## Decision Request\n\n### Park location",
        createdAt: new Date(NOW.getTime() - 2 * DAY_MS).toISOString(),
      },
    ];
    const signal = extractDecisionSignal(comments, NOW);
    expect(signal).not.toBeNull();
    expect(signal?.decisionRequestAgeDays).toBe(2);
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
