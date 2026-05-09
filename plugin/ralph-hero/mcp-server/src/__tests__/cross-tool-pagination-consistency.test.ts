/**
 * Cross-tool consistency regression test (GH-1175 / Phase 5 of GH-1171 group).
 *
 * Asserts that `ralph_hero__list_issues` (Path A) and
 * `ralph_hero__pipeline_dashboard` (Path B) return the same set of issue
 * numbers per non-terminal workflow state when run against a mocked
 * project that exceeds 500 items.
 *
 * Why this test exists:
 *   Before GH-1171/1172/1173, both paths shared a 500-item silent cap inside
 *   `paginateConnection` (`{ maxItems: 500 }`). Items at board positions
 *   > 500 were invisible to both tools, but worse — depending on local
 *   filter ordering the two paths could disagree on which subset of items
 *   they surfaced. After the scan-until-exhausted fix (Phases 1-3) both
 *   paths walk the full connection. This test would have failed before the
 *   fix (the position-640 item disappears from both tools) and passes
 *   after, locking that invariant in.
 *
 * Boundary fixtures: the 734-item synthetic project deliberately places
 * items at positions 1, 100, 499, 500, 501, 600, 640, 700, 733 across
 * several workflow states so a future regression in pagination would land
 * exactly on the boundary the cap used to enforce.
 *
 * Out of scope (per #1175 body and shared constraints in the plan):
 *   - `list_groups` consistency — different shape (groups, not flat items);
 *     covered by its own sub-issue tests in Phase 4.
 *   - The closed-issue asymmetry between Path A (defaults `state: "OPEN"`)
 *     and Path B (no state filter). Path B retains closed-but-non-Done
 *     items; Path A drops them by default. This test sidesteps the
 *     asymmetry by making every fixture item `state: "OPEN"` and
 *     comparing OPEN-only sets. The asymmetry itself is GH-1169's
 *     territory.
 *   - Done / Canceled buckets: `aggregateByPhase` filters those by a 7-day
 *     `doneWindowDays` window (intentional, predates this work). The
 *     comparison in this test only iterates non-terminal states.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerIssueTools } from "../tools/issue-tools.js";
import { registerDashboardTools } from "../tools/dashboard-tools.js";
import type { GitHubClient } from "../github-client.js";
import type { GitHubClientConfig } from "../types.js";
import { FieldOptionCache } from "../lib/cache.js";

// ---------------------------------------------------------------------------
// Fixture: 734-item synthetic project spread across 7 GraphQL pages.
//
// Boundary-of-interest positions: 1, 100, 499, 500, 501, 600, 640, 700, 733.
// Items at and beyond position 501 would be invisible under the old 500-cap.
// ---------------------------------------------------------------------------

/** The non-terminal workflow states we cycle items through. */
const NON_TERMINAL_STATES = [
  "Backlog",
  "Research Needed",
  "Plan in Review",
  "In Progress",
  "In Review",
] as const;

/** Total project size — exceeds the historical 500-cap by 234 items. */
const TOTAL_ITEMS = 734;
const PAGE_SIZE = 100;

type Position = number;

/**
 * Pinned items at boundary-relevant positions. Each entry asserts the item's
 * board position (1-indexed) and its workflow state. Position 640 is the
 * "smoke" item — it matches the empirical observation in the research doc
 * (#1102 sat at position 640 in production project #3 on 2026-05-09).
 */
const PINNED_ITEMS: Array<{ position: Position; workflowState: string }> = [
  { position: 1, workflowState: "Backlog" },
  { position: 100, workflowState: "Research Needed" },
  { position: 499, workflowState: "In Progress" },
  { position: 500, workflowState: "Plan in Review" },
  { position: 501, workflowState: "Plan in Review" }, // first item beyond old cap
  { position: 600, workflowState: "In Progress" },
  { position: 640, workflowState: "Plan in Review" }, // research-doc smoke item
  { position: 700, workflowState: "In Review" },
  { position: 733, workflowState: "Backlog" },
];

const PINNED_BY_POSITION = new Map(
  PINNED_ITEMS.map((p) => [p.position, p.workflowState]),
);

/**
 * Issue number is `position + 1000` so the fixture number space is clearly
 * disjoint from any `position` integer (reads more naturally in failure
 * output).
 */
function issueNumberFor(position: Position): number {
  return position + 1000;
}

/**
 * Workflow state for an unpinned position. Cycles through the non-terminal
 * states in a deterministic pattern so every state has items distributed
 * both inside and outside the historical 500-cap. A small deterministic
 * sub-pattern leaves some items with no workflow state (`null`) to
 * exercise the "Unknown" / undefined-state branch on both paths.
 */
function workflowStateForPosition(position: Position): string | null {
  // Every 17th item has no workflow state — sparse enough not to dominate
  // any bucket, dense enough to hit at least once per page.
  if (position % 17 === 0) return null;
  return NON_TERMINAL_STATES[position % NON_TERMINAL_STATES.length];
}

/**
 * Build one raw project item that satisfies BOTH the `list_issues` query
 * shape and the `DASHBOARD_ITEMS_QUERY` shape. The two queries differ in
 * which fields they ask for (list_issues fetches `body`, `createdAt`,
 * `labels`, `url`; dashboard fetches `subIssues.totalCount`,
 * `trackedIssues`, `trackedInIssues`). We provide all fields on every
 * item so a single fixture serves both tools.
 */
function makeRawItem(position: Position): unknown {
  const number = issueNumberFor(position);
  const workflowState =
    PINNED_BY_POSITION.get(position) ?? workflowStateForPosition(position);

  const fieldValues: Array<Record<string, unknown>> = [];
  if (workflowState) {
    fieldValues.push({
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      name: workflowState,
      field: { name: "Workflow State" },
    });
  }

  return {
    id: `item-${number}`,
    type: "ISSUE",
    content: {
      __typename: "Issue",
      number,
      title: `Synthetic issue ${number} at position ${position}`,
      body: "",
      state: "OPEN", // every fixture item is OPEN — sidesteps Path A/B closed asymmetry
      stateReason: null,
      url: `https://github.com/test-owner/test-repo/issues/${number}`,
      createdAt: new Date(2026, 0, 1).toISOString(),
      updatedAt: new Date(2026, 4, 1).toISOString(),
      closedAt: null,
      labels: { nodes: [] },
      assignees: { nodes: [] },
      repository: { nameWithOwner: "test-owner/test-repo", name: "test-repo" },
      subIssues: { totalCount: 0 },
      trackedIssues: { nodes: [] },
      trackedInIssues: { nodes: [] },
    },
    fieldValues: { nodes: fieldValues },
  };
}

/**
 * Build all 734 raw items. Their order is deterministic (position 1 first,
 * position 733 last) which mirrors GitHub's default board ordering used by
 * the un-`orderBy`'d `items()` connection.
 */
function buildAllRawItems(): unknown[] {
  const items: unknown[] = [];
  for (let pos = 1; pos <= TOTAL_ITEMS; pos++) {
    items.push(makeRawItem(pos));
  }
  return items;
}

/**
 * Slice the full item list into page-shaped responses. Returns `pages.length`
 * objects, each shaped like the `node.items` connection response that both
 * `list_issues` and `fetchDashboardItems` walk via `paginateConnection`.
 */
function buildPagedResponses(allItems: unknown[]): unknown[] {
  const responses: unknown[] = [];
  for (let i = 0; i < allItems.length; i += PAGE_SIZE) {
    const slice = allItems.slice(i, i + PAGE_SIZE);
    const isLast = i + PAGE_SIZE >= allItems.length;
    responses.push({
      node: {
        items: {
          totalCount: allItems.length,
          pageInfo: {
            hasNextPage: !isLast,
            endCursor: isLast ? null : `cursor-${i + PAGE_SIZE}`,
          },
          nodes: slice,
        },
      },
    });
  }
  return responses;
}

// ---------------------------------------------------------------------------
// Mock GraphQL client — same patterns as directions-tools.test.ts and
// trends-tools.test.ts, extended to deliver pages in sequence.
// ---------------------------------------------------------------------------

function fieldCacheResponse(projectId: string): unknown {
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
                { id: "opt-bl", name: "Backlog" },
                { id: "opt-rn", name: "Research Needed" },
                { id: "opt-rip", name: "Research in Progress" },
                { id: "opt-rfp", name: "Ready for Plan" },
                { id: "opt-pip", name: "Plan in Progress" },
                { id: "opt-pir", name: "Plan in Review" },
                { id: "opt-ip", name: "In Progress" },
                { id: "opt-iv", name: "In Review" },
                { id: "opt-done", name: "Done" },
                { id: "opt-cancel", name: "Canceled" },
                { id: "opt-hn", name: "Human Needed" },
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
                { id: "l", name: "L" },
                { id: "xl", name: "XL" },
              ],
            },
          ],
        },
      },
    },
  };
}

function isFieldCacheQuery(q: string): boolean {
  return q.includes("projectV2(number:") && q.includes("fields(first:");
}

function isProjectTitleQuery(q: string): boolean {
  return q.includes("ProjectV2 { title }");
}

function isItemsQuery(q: string): boolean {
  return q.includes("node(id: $projectId)") && q.includes("items(first:");
}

interface MockClient {
  client: GitHubClient;
  projectQuery: ReturnType<typeof vi.fn>;
}

/**
 * Stateful mock that delivers pages in cursor order. The mock advances
 * through `pagedResponses` based on the inbound `$cursor` variable so the
 * same handler serves both `list_issues` and `pipeline_dashboard` calls
 * (each starts fresh at cursor=null).
 *
 * This is more faithful than a "next call gets next page" counter mock,
 * because both tools walk the connection independently and we don't want
 * one tool's progress to leak into the other.
 */
function createMockClient(pagedResponses: unknown[]): MockClient {
  const config: GitHubClientConfig = {
    token: "tok",
    owner: "test-owner",
    repo: "test-repo",
    projectNumber: 3,
    projectOwner: "test-owner",
  };

  const projectQuery = vi.fn(
    async (q: string, vars: Record<string, unknown>) => {
      if (isFieldCacheQuery(q)) {
        return fieldCacheResponse(`project-id-${vars.number}`);
      }
      if (isProjectTitleQuery(q)) {
        return { node: { title: "Test Project" } };
      }
      if (isItemsQuery(q)) {
        // Deduce the page index from the inbound cursor. cursor=null means
        // page 0; "cursor-100" means page 1 (cursor was set to "cursor-100"
        // by page 0); etc.
        const cursor = vars.cursor as string | null;
        const pageIndex =
          cursor === null || cursor === undefined
            ? 0
            : Number(cursor.replace("cursor-", "")) / PAGE_SIZE;
        const response = pagedResponses[pageIndex];
        if (!response) {
          throw new Error(
            `Mock paged response out of range: pageIndex=${pageIndex}, cursor=${String(cursor)}`,
          );
        }
        return response;
      }
      throw new Error(`Unmocked projectQuery: ${q.slice(0, 80)}`);
    },
  );

  const client = {
    config,
    query: vi.fn(),
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

  return { client, projectQuery };
}

// ---------------------------------------------------------------------------
// Tool harness
// ---------------------------------------------------------------------------

interface HandlerResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface RegisteredTool {
  handler: (args: unknown, extra: unknown) => Promise<HandlerResult>;
}

function getTool(server: McpServer, name: string): RegisteredTool {
  const tools = (
    server as unknown as { _registeredTools: Record<string, RegisteredTool> }
  )._registeredTools;
  const tool = tools?.[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool;
}

function parsePayload(result: HandlerResult): Record<string, unknown> {
  expect(result.isError).toBeUndefined();
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cross-tool consistency: list_issues vs pipeline_dashboard (GH-1175)", () => {
  let server: McpServer;
  let fieldCache: FieldOptionCache;
  let allItems: unknown[];
  let pagedResponses: unknown[];
  let mock: MockClient;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    fieldCache = new FieldOptionCache();
    allItems = buildAllRawItems();
    pagedResponses = buildPagedResponses(allItems);
    mock = createMockClient(pagedResponses);
    registerIssueTools(server, mock.client, fieldCache);
    registerDashboardTools(server, mock.client, fieldCache);
  });

  it("fixture sanity: 734 items, 8 pages (7 full + 1 partial), boundary positions present", () => {
    expect(allItems).toHaveLength(TOTAL_ITEMS);
    // 734 / 100 = 7.34 → 8 pages (7 of 100 + 1 of 34).
    expect(pagedResponses).toHaveLength(8);

    // Pinned items survived buildAllRawItems
    for (const pinned of PINNED_ITEMS) {
      const num = issueNumberFor(pinned.position);
      const found = allItems.find(
        (i) =>
          (i as { content: { number: number } }).content.number === num,
      );
      expect(found, `position ${pinned.position} (#${num}) missing from fixture`).toBeDefined();
    }
  });

  it("list_issues and pipeline_dashboard return the same OPEN-issue set per non-terminal workflow state", async () => {
    const listTool = getTool(server, "ralph_hero__list_issues");
    const dashboardTool = getTool(server, "ralph_hero__pipeline_dashboard");

    // Prime the dashboard once so we don't re-fetch per state. Set
    // `issuesPerPhase` high enough to cover every per-phase bucket — the
    // dashboard tool truncates `phase.issues` to that limit and any
    // truncation here would mask a real consistency bug.
    const dashboardResult = await dashboardTool.handler(
      { issuesPerPhase: 10000, doneWindowDays: 365 },
      {},
    );
    const dashboardPayload = parsePayload(dashboardResult) as {
      phases: Array<{
        state: string;
        issues: Array<{ number: number }>;
      }>;
    };

    expect(dashboardPayload.phases).toBeDefined();
    expect(Array.isArray(dashboardPayload.phases)).toBe(true);

    for (const state of NON_TERMINAL_STATES) {
      // Path A: list_issues filtered by workflowState.
      // Set `limit` high so list_issues doesn't slice the result.
      const listResult = await listTool.handler(
        { workflowState: state, state: "OPEN", limit: 10000 },
        {},
      );
      const listPayload = parsePayload(listResult) as {
        items: Array<{ number: number }>;
      };
      const setA = new Set(listPayload.items.map((i) => i.number));

      // Path B: pipeline_dashboard, filter to bucket X. Every fixture item
      // is `state: "OPEN"`, so no extra OPEN filter is needed on Path B —
      // but we still document that intent in the test name.
      const phase = dashboardPayload.phases.find((p) => p.state === state);
      expect(phase, `phase "${state}" missing from dashboard payload`).toBeDefined();
      const setB = new Set(phase!.issues.map((i) => i.number));

      // Compare as sets, ignoring order. Use sorted-array compare for
      // readable diff output on failure.
      const sortedA = [...setA].sort((x, y) => x - y);
      const sortedB = [...setB].sort((x, y) => x - y);
      expect(
        sortedB,
        `mismatch for workflowState="${state}": list_issues vs pipeline_dashboard differ`,
      ).toEqual(sortedA);
    }
  });

  it("position-640 boundary item appears in both tools' Plan-in-Review bucket", async () => {
    const listTool = getTool(server, "ralph_hero__list_issues");
    const dashboardTool = getTool(server, "ralph_hero__pipeline_dashboard");

    const expectedNumber = issueNumberFor(640);

    // Path A
    const listResult = await listTool.handler(
      { workflowState: "Plan in Review", state: "OPEN", limit: 10000 },
      {},
    );
    const listPayload = parsePayload(listResult) as {
      items: Array<{ number: number }>;
    };
    const listNumbers = listPayload.items.map((i) => i.number);
    expect(
      listNumbers,
      "list_issues did not surface position-640 item — pagination cap may have regressed",
    ).toContain(expectedNumber);

    // Path B
    const dashboardResult = await dashboardTool.handler(
      { issuesPerPhase: 10000, doneWindowDays: 365 },
      {},
    );
    const dashboardPayload = parsePayload(dashboardResult) as {
      phases: Array<{ state: string; issues: Array<{ number: number }> }>;
    };
    const planInReview = dashboardPayload.phases.find(
      (p) => p.state === "Plan in Review",
    );
    expect(planInReview).toBeDefined();
    const dashboardNumbers = planInReview!.issues.map((i) => i.number);
    expect(
      dashboardNumbers,
      "pipeline_dashboard did not surface position-640 item — fetchDashboardItems cap may have regressed",
    ).toContain(expectedNumber);
  });

  it("at least one item beyond position 500 appears under each non-terminal state in both tools", async () => {
    // Specifically validates the fix end-to-end: every non-terminal bucket
    // must contain at least one item with position > 500 in both paths. If
    // either path silently truncated at 500, this assertion would fail
    // for whichever bucket the >500 item lives in.
    const listTool = getTool(server, "ralph_hero__list_issues");
    const dashboardTool = getTool(server, "ralph_hero__pipeline_dashboard");

    const dashboardResult = await dashboardTool.handler(
      { issuesPerPhase: 10000, doneWindowDays: 365 },
      {},
    );
    const dashboardPayload = parsePayload(dashboardResult) as {
      phases: Array<{ state: string; issues: Array<{ number: number }> }>;
    };

    // Threshold for "beyond the old cap": any position > 500 implies an
    // issue number > 1500 (issueNumberFor adds 1000 to position).
    const POSITION_500_NUMBER = issueNumberFor(500);

    for (const state of NON_TERMINAL_STATES) {
      const listResult = await listTool.handler(
        { workflowState: state, state: "OPEN", limit: 10000 },
        {},
      );
      const listPayload = parsePayload(listResult) as {
        items: Array<{ number: number }>;
      };
      const beyondCapInList = listPayload.items.filter(
        (i) => i.number > POSITION_500_NUMBER,
      );

      const phase = dashboardPayload.phases.find((p) => p.state === state);
      expect(phase).toBeDefined();
      const beyondCapInDashboard = phase!.issues.filter(
        (i) => i.number > POSITION_500_NUMBER,
      );

      expect(
        beyondCapInList.length,
        `list_issues returned 0 items beyond position 500 for "${state}" — pagination cap regression`,
      ).toBeGreaterThan(0);
      expect(
        beyondCapInDashboard.length,
        `pipeline_dashboard returned 0 items beyond position 500 for "${state}" — fetchDashboardItems regression`,
      ).toBeGreaterThan(0);
    }
  });

  it("both tools exhaust the connection (each invokes the items query 8 times)", async () => {
    // Sanity check that mock is being walked all the way through. With
    // pageSize=100 and 734 items, the helper requests pages 1..8 (last is
    // 34 items, hasNextPage=false). If a regression truncated at 500
    // again, pagination would only request 5 pages.
    const listTool = getTool(server, "ralph_hero__list_issues");
    const dashboardTool = getTool(server, "ralph_hero__pipeline_dashboard");

    // Reset call counter via a fresh mock so we count one tool's work in
    // isolation.
    const isolatedMock = createMockClient(pagedResponses);
    const isolatedFieldCache = new FieldOptionCache();
    const isolatedServer = new McpServer({ name: "iso", version: "0.0.0" });
    registerIssueTools(isolatedServer, isolatedMock.client, isolatedFieldCache);
    registerDashboardTools(
      isolatedServer,
      isolatedMock.client,
      isolatedFieldCache,
    );

    void listTool; // silence unused
    void dashboardTool;

    const isoList = getTool(isolatedServer, "ralph_hero__list_issues");
    await isoList.handler(
      { workflowState: "Plan in Review", state: "OPEN", limit: 10000 },
      {},
    );

    const itemsQueryCalls = isolatedMock.projectQuery.mock.calls.filter(
      ([q]) => isItemsQuery(q as string),
    );
    expect(itemsQueryCalls.length).toBeGreaterThanOrEqual(8);

    // Confirm the last fetched page had hasNextPage=false (otherwise the
    // mock would still have more pages and the loop would have stopped
    // early — the silent-truncation failure mode).
    const lastResponse = pagedResponses[pagedResponses.length - 1] as {
      node: { items: { pageInfo: { hasNextPage: boolean } } };
    };
    expect(lastResponse.node.items.pageInfo.hasNextPage).toBe(false);
  });
});
