/**
 * Cross-tool count consistency tests for the discovery surface.
 *
 * Encodes the cross-tool count and visibility invariants from the
 * 2026-05-08 audit (`thoughts/shared/research/2026-05-08-shorthand-tools-counts-and-filters.md`)
 * so a future contributor renaming `boardItems` back to
 * `totalCandidates`/`totalIssues` on any of the four tools, or silently
 * changing one tool's filter rules, sees an immediate failure with a
 * descriptive `expect(...)` message that names the tool and the invariant
 * violated.
 *
 * Surface under test:
 *   - `ralph_hero__next_actions`        (registerDirectionsTools)
 *   - `ralph_hero__pipeline_dashboard`  (registerDashboardTools)
 *   - `ralph_hero__list_issues`         (registerIssueTools)
 *   - `ralph_hero__project_hygiene`     (registerHygieneTools)
 *
 * Mock harness pattern mirrors `directions-tools.test.ts:31-268`:
 * tools are registered against a fresh `McpServer` plus a shared
 * `MockClient` whose `projectQuery` is routed by query-shape detection
 * (`isFieldCacheQuery`, `isDashboardItemsQuery`). The same 12-item
 * fixture serves all four tools so cross-tool comparison is meaningful.
 *
 * No live API calls. All dates are pinned to `FIXTURE_NOW` so re-runs
 * produce identical bucketing across days.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDirectionsTools } from "../tools/directions-tools.js";
import { registerDashboardTools } from "../tools/dashboard-tools.js";
import { registerIssueTools } from "../tools/issue-tools.js";
import { registerHygieneTools } from "../tools/hygiene-tools.js";
import type { GitHubClient } from "../github-client.js";
import type { GitHubClientConfig } from "../types.js";
import { FieldOptionCache } from "../lib/cache.js";

// ---------------------------------------------------------------------------
// Fixture timestamps — pinned so test re-runs are deterministic.
// `FIXTURE_NOW` mirrors the shape used by other deterministic tests
// (e.g. `directions-tools.test.ts:367`); we anchor to noon UTC on
// 2026-05-09 so all relative offsets land on stable day boundaries.
// ---------------------------------------------------------------------------

const FIXTURE_NOW = new Date("2026-05-09T12:00:00Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function offsetIso(ms: number): string {
  return new Date(FIXTURE_NOW.getTime() - ms).toISOString();
}

// ---------------------------------------------------------------------------
// rawIssue / itemsResponse / fieldCacheResponse / mock-client helpers.
// Replicated from `directions-tools.test.ts:48-268` so this file is
// self-contained — `dashboard.test.ts` and `hygiene.test.ts` follow
// the same "build your own factory" precedent.
// ---------------------------------------------------------------------------

interface RawIssueFixture {
  number: number;
  title: string;
  workflowState?: string | null;
  priority?: string | null;
  estimate?: string | null;
  updatedAt?: string;
  closedAt?: string | null;
  state?: string;
  assignees?: string[];
}

/**
 * Build a `node.items.nodes[]` entry that matches the shape returned by
 * `DASHBOARD_ITEMS_QUERY` AND the `list_issues` query (the two queries
 * are isomorphic for the fields the tools read). `toDashboardItems`
 * will turn it into a `DashboardItem` with the expected workflowState /
 * priority / estimate; the `list_issues` filter chain operates on the
 * same `content`/`fieldValues` shape.
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

  const assigneeNodes = (fix.assignees ?? []).map((login) => ({ login }));

  return {
    id: `item-${fix.number}`,
    type: "ISSUE",
    content: {
      __typename: "Issue",
      number: fix.number,
      title: fix.title,
      state: fix.state ?? "OPEN",
      stateReason: null,
      url: `https://github.com/test-owner/test-repo/issues/${fix.number}`,
      createdAt: offsetIso(60 * DAY_MS),
      updatedAt: fix.updatedAt ?? FIXTURE_NOW.toISOString(),
      closedAt: fix.closedAt ?? null,
      labels: { nodes: [] },
      assignees: { nodes: assigneeNodes },
      repository: { nameWithOwner: "test-owner/test-repo", name: "test-repo" },
      subIssues: { totalCount: 0 },
      trackedIssues: { nodes: [] },
      trackedInIssues: { nodes: [] },
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
 *
 * Workflow State options enumerate every named state the audit's
 * Matrix 2 references plus `Backlog` (the implicit `Unknown` bucket
 * for null items needs no field-cache option — rawIssue() simply omits
 * the field-value entry for those items).
 */
function fieldCacheResponse(projectId = "project-id-3"): unknown {
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
                { id: "opt-backlog", name: "Backlog" },
                { id: "opt-rn", name: "Research Needed" },
                { id: "opt-rip", name: "Research in Progress" },
                { id: "opt-rfp", name: "Ready for Plan" },
                { id: "opt-pip", name: "Plan in Progress" },
                { id: "opt-pir", name: "Plan in Review" },
                { id: "opt-ip", name: "In Progress" },
                { id: "opt-iv", name: "In Review" },
                { id: "opt-done", name: "Done" },
                { id: "opt-canceled", name: "Canceled" },
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

function isProjectTitleQuery(q: string): boolean {
  // Best-effort `node { title }` lookup performed by `fetchDashboardItems`.
  return q.includes("node(id: $projectId)") && q.includes("title");
}

function isOpenPRsSearchQuery(q: string): boolean {
  return q.includes("search(query:") && q.includes("... on PullRequest");
}

interface MockClientOptions {
  /** Items response per project (keyed by project number). */
  itemsByProject?: Record<number, unknown[]>;
}

function createMockClient(
  config: Partial<GitHubClientConfig>,
  options: MockClientOptions = {},
): { client: GitHubClient } {
  const fullConfig: GitHubClientConfig = {
    token: "tok",
    owner: "test-owner",
    repo: "test-repo",
    projectNumber: 3,
    projectOwner: "test-owner",
    ...config,
  };

  const projectQuery = vi.fn(async (q: string, vars: Record<string, unknown>) => {
    if (isFieldCacheQuery(q)) {
      return fieldCacheResponse(`project-id-${vars.number}`);
    }
    // Project-title lookup runs before items pagination in
    // `fetchDashboardItems`. Match it first so the more general
    // `isDashboardItemsQuery` doesn't consume it.
    if (isProjectTitleQuery(q) && !q.includes("items(first:")) {
      return { node: { title: "Test Project" } };
    }
    if (isDashboardItemsQuery(q)) {
      const projectId = vars.projectId as string;
      const match = projectId.match(/project-id-(\d+)/);
      const pn = match ? Number(match[1]) : 0;
      const nodes = options.itemsByProject?.[pn] ?? [];
      return itemsResponse(nodes);
    }
    throw new Error(`Unmocked projectQuery: ${q.slice(0, 80)}`);
  });

  // `client.query` is the repo-scoped surface. The only call path the
  // discovery tools take through it is the internal `fetchOpenPRs`
  // search; route by query body so unrelated queries fail loudly.
  const query = vi.fn(async (q: string) => {
    if (isOpenPRsSearchQuery(q)) {
      return { search: { nodes: [] } };
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

  return { client };
}

// ---------------------------------------------------------------------------
// Server / handler harness — copied from
// `directions-tools.test.ts:283-306` so the test file is self-contained.
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

function parsePayload(result: HandlerResult): unknown {
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Synthetic 12-item fixture — one row per audit Matrix 2 entry.
//
// Naming convention: issue numbers are 1001-1012, titles are the
// workflow-state name (or "null state") prefixed with the number for
// debuggability. All non-Done/Canceled items have `assignees: []` so
// the orphan/stale categories have predictable shapes.
//
// Lock-state items (`Research in Progress`, `Plan in Progress`,
// `In Progress`) use updatedAt = NOW - 1h so they are NOT lock-stale
// (default `lockStaleHours = 24`). The Backlog and null items are
// 30 days old so they qualify for `orphanedItems`/`staleItems`
// respectively.
// ---------------------------------------------------------------------------

function buildTwelveItemFixture(): unknown[] {
  const recent = offsetIso(1 * HOUR_MS);
  const twoDays = offsetIso(2 * DAY_MS);
  const thirtyDays = offsetIso(30 * DAY_MS);

  return [
    rawIssue({
      number: 1001,
      title: "1001 Backlog item",
      workflowState: "Backlog",
      updatedAt: thirtyDays,
    }),
    rawIssue({
      number: 1002,
      title: "1002 Research Needed item",
      workflowState: "Research Needed",
      updatedAt: recent,
    }),
    rawIssue({
      number: 1003,
      title: "1003 Research in Progress (not lock-stale)",
      workflowState: "Research in Progress",
      updatedAt: recent,
    }),
    rawIssue({
      number: 1004,
      title: "1004 Ready for Plan item",
      workflowState: "Ready for Plan",
      updatedAt: recent,
    }),
    rawIssue({
      number: 1005,
      title: "1005 Plan in Progress (not lock-stale)",
      workflowState: "Plan in Progress",
      updatedAt: recent,
    }),
    rawIssue({
      number: 1006,
      title: "1006 Plan in Review item",
      workflowState: "Plan in Review",
      updatedAt: recent,
    }),
    rawIssue({
      number: 1007,
      title: "1007 In Progress (not lock-stale)",
      workflowState: "In Progress",
      updatedAt: recent,
    }),
    rawIssue({
      number: 1008,
      title: "1008 In Review item",
      workflowState: "In Review",
      updatedAt: recent,
    }),
    rawIssue({
      number: 1009,
      title: "1009 Done (within doneWindowDays=7)",
      workflowState: "Done",
      updatedAt: twoDays,
      closedAt: twoDays,
    }),
    rawIssue({
      number: 1010,
      title: "1010 Canceled (within doneWindowDays=7)",
      workflowState: "Canceled",
      updatedAt: twoDays,
      closedAt: twoDays,
    }),
    rawIssue({
      number: 1011,
      title: "1011 Human Needed item",
      workflowState: "Human Needed",
      updatedAt: recent,
    }),
    rawIssue({
      number: 1012,
      title: "1012 null workflow state",
      // Omit workflowState so no field-value entry is emitted; the
      // tools' aggregators will route this item to the `Unknown` bucket.
      workflowState: null,
      updatedAt: thirtyDays,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Shared helpers — every test wires the four real registration
// functions into a fresh `McpServer` plus a fresh `FieldOptionCache`
// and the same mock client. This is the load-bearing arrangement: the
// tools must observe the same 12-item input for the cross-tool
// comparison to be meaningful.
// ---------------------------------------------------------------------------

interface AllToolsHandlers {
  nextActions: RegisteredTool;
  dashboard: RegisteredTool;
  listIssues: RegisteredTool;
  hygiene: RegisteredTool;
}

function registerAll(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): AllToolsHandlers {
  registerDirectionsTools(server, client, fieldCache);
  registerDashboardTools(server, client, fieldCache);
  registerIssueTools(server, client, fieldCache);
  registerHygieneTools(server, client, fieldCache);
  return {
    nextActions: getTool(server, "ralph_hero__next_actions"),
    dashboard: getTool(server, "ralph_hero__pipeline_dashboard"),
    listIssues: getTool(server, "ralph_hero__list_issues"),
    hygiene: getTool(server, "ralph_hero__project_hygiene"),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cross-tool count consistency", () => {
  let server: McpServer;
  let fieldCache: FieldOptionCache;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    fieldCache = new FieldOptionCache();
  });

  it("all four tools report boardItems = 12 against the same fixture", async () => {
    const fixture = buildTwelveItemFixture();
    const { client } = createMockClient(
      { projectNumber: 3 },
      { itemsByProject: { 3: fixture } },
    );
    const tools = registerAll(server, client, fieldCache);

    // Default args for each tool. Zod defaults are not applied because
    // we bypass `validateToolInput`; pass the resolved shape directly.
    const nextActionsResult = await tools.nextActions.handler(
      { limit: 3, audience: "human", stuckThresholdHours: 48, lockStaleHours: 24, treeRecentDoneDays: 7, prStaleHours: 24 },
      {},
    );
    const dashboardResult = await tools.dashboard.handler(
      { format: "json", includeHealth: true, doneWindowDays: 7, archiveAgeDays: 14, issuesPerPhase: 10 },
      {},
    );
    const listIssuesResult = await tools.listIssues.handler(
      { state: "OPEN", limit: 50, orderBy: "CREATED_AT" },
      {},
    );
    const hygieneResult = await tools.hygiene.handler(
      { format: "json", archiveAgeDays: 14, staleDays: 7, orphanDays: 14, similarityThreshold: 0.8 },
      {},
    );

    const nextActions = parsePayload(nextActionsResult) as {
      boardItems: number;
      directions: unknown[];
    };
    const dashboard = parsePayload(dashboardResult) as { boardItems: number };
    const listIssues = parsePayload(listIssuesResult) as {
      filteredCount: number;
      items: unknown[];
    };
    const hygiene = parsePayload(hygieneResult) as { boardItems: number };

    expect(nextActions.boardItems, "next_actions.boardItems").toBe(12);
    expect(dashboard.boardItems, "pipeline_dashboard.boardItems").toBe(12);
    expect(hygiene.boardItems, "project_hygiene.boardItems").toBe(12);

    // `list_issues` does not emit `boardItems` (its return contract is
    // `{ filteredCount, items }`). Documenting that contract here so a
    // future "add boardItems to list_issues" change has to update this
    // assertion deliberately. With default args the filter chain is a
    // no-op so filteredCount equals the fixture size.
    expect(
      (listIssues as Record<string, unknown>).boardItems,
      "list_issues should NOT expose boardItems (its contract is filteredCount/items)",
    ).toBeUndefined();
    expect(listIssues.filteredCount, "list_issues.filteredCount").toBe(12);
  });

  it("per-tool filtered counts are <= boardItems", async () => {
    const fixture = buildTwelveItemFixture();
    const { client } = createMockClient(
      { projectNumber: 3 },
      { itemsByProject: { 3: fixture } },
    );
    const tools = registerAll(server, client, fieldCache);

    const nextActionsResult = await tools.nextActions.handler(
      { limit: 3, audience: "human", stuckThresholdHours: 48, lockStaleHours: 24, treeRecentDoneDays: 7, prStaleHours: 24 },
      {},
    );
    const dashboardResult = await tools.dashboard.handler(
      { format: "json", includeHealth: true, doneWindowDays: 7, archiveAgeDays: 14, issuesPerPhase: 10 },
      {},
    );
    const listIssuesResult = await tools.listIssues.handler(
      { state: "OPEN", limit: 50, orderBy: "CREATED_AT" },
      {},
    );
    const hygieneResult = await tools.hygiene.handler(
      { format: "json", archiveAgeDays: 14, staleDays: 7, orphanDays: 14, similarityThreshold: 0.8 },
      {},
    );

    const nextActions = parsePayload(nextActionsResult) as {
      boardItems: number;
      directions: unknown[];
    };
    const dashboard = parsePayload(dashboardResult) as {
      boardItems: number;
      phases: Array<{ state: string; count: number }>;
    };
    const listIssues = parsePayload(listIssuesResult) as { filteredCount: number };
    const hygiene = parsePayload(hygieneResult) as {
      boardItems: number;
      summary: {
        archiveCandidateCount: number;
        staleCount: number;
        orphanCount: number;
      };
    };

    const BOARD = 12;

    // next_actions: directions array bounded by both `limit` (3) AND
    // `boardItems` (12). The smaller bound (`limit`) dominates here.
    expect(
      nextActions.directions.length,
      "next_actions.directions.length <= boardItems",
    ).toBeLessThanOrEqual(BOARD);
    expect(
      nextActions.directions.length,
      "next_actions.directions.length <= limit (default 3)",
    ).toBeLessThanOrEqual(3);

    // pipeline_dashboard: sum of `phases[].count` <= boardItems. With
    // default `doneWindowDays=7` covering the 2-day-old Done/Canceled
    // items in this fixture, equality holds; with a tighter window it
    // would be strictly less.
    const phaseCountSum = dashboard.phases.reduce(
      (sum, p) => sum + p.count,
      0,
    );
    expect(
      phaseCountSum,
      "sum(pipeline_dashboard.phases[].count) <= boardItems",
    ).toBeLessThanOrEqual(BOARD);

    // list_issues: filteredCount strictly bounded by boardItems. With
    // default args (no filters beyond `state: OPEN`) and all fixture
    // items being state=OPEN, equality holds.
    expect(
      listIssues.filteredCount,
      "list_issues.filteredCount <= boardItems",
    ).toBeLessThanOrEqual(BOARD);

    // project_hygiene: each summary category is bounded by boardItems
    // independently. Categories overlap (a stale Backlog item is both
    // stale and orphaned), so summing is loose — hence <= 3*BOARD.
    const { archiveCandidateCount, staleCount, orphanCount } = hygiene.summary;
    expect(
      archiveCandidateCount,
      "hygiene.summary.archiveCandidateCount <= boardItems",
    ).toBeLessThanOrEqual(BOARD);
    expect(
      staleCount,
      "hygiene.summary.staleCount <= boardItems",
    ).toBeLessThanOrEqual(BOARD);
    expect(
      orphanCount,
      "hygiene.summary.orphanCount <= boardItems",
    ).toBeLessThanOrEqual(BOARD);
    expect(
      archiveCandidateCount + staleCount + orphanCount,
      "sum of overlapping hygiene categories bounded by 3*boardItems",
    ).toBeLessThanOrEqual(3 * BOARD);
  });

  it("sum of phase counts equals boardItems when doneWindowDays covers all Done/Canceled items", async () => {
    const fixture = buildTwelveItemFixture();
    const { client } = createMockClient(
      { projectNumber: 3 },
      { itemsByProject: { 3: fixture } },
    );
    const tools = registerAll(server, client, fieldCache);

    // `boardItems` is the invariant target — the sum-of-phase-counts
    // identity holds only when `doneWindowDays` is wide enough to keep
    // all Done/Canceled fixture items inside the window. We pass 365
    // explicitly (deliberately large) so this test does not silently
    // become a window-clamping test.
    const dashboardResult = await tools.dashboard.handler(
      { format: "json", includeHealth: true, doneWindowDays: 365, archiveAgeDays: 14, issuesPerPhase: 10 },
      {},
    );

    const dashboard = parsePayload(dashboardResult) as {
      boardItems: number;
      phases: Array<{ state: string; count: number }>;
    };

    const phaseCountSum = dashboard.phases.reduce(
      (sum, p) => sum + p.count,
      0,
    );
    expect(
      phaseCountSum,
      "sum(phases[].count) === boardItems when window covers all Done/Canceled (Unknown bucket included)",
    ).toBe(dashboard.boardItems);
    expect(dashboard.boardItems, "boardItems = 12").toBe(12);

    // Sanity-check that every phase the fixture references is present
    // (including the `Unknown` bucket for the null-state item). If a
    // future refactor drops the Unknown bucket, the sum-equals-board
    // assertion above already catches it, but pinpointing the missing
    // phase here makes diagnosis faster.
    const phaseStates = dashboard.phases.map((p) => p.state);
    expect(phaseStates, "Unknown bucket present").toContain("Unknown");
  });

  it("Backlog items are visible to pipeline_dashboard, list_issues, and next_actions(audience=agent), but NOT next_actions(audience=human)", async () => {
    // Reduced fixture: only Backlog items so `next_actions(audience='agent')`
    // hits the Backlog/null-state fallback (rankDirections triggers the
    // fallback only when the actionable-phase candidate set is empty).
    const backlogOnly = [
      rawIssue({
        number: 2001,
        title: "2001 Backlog only",
        workflowState: "Backlog",
        updatedAt: offsetIso(30 * DAY_MS),
      }),
    ];
    const { client } = createMockClient(
      { projectNumber: 3 },
      { itemsByProject: { 3: backlogOnly } },
    );
    const tools = registerAll(server, client, fieldCache);

    // next_actions with audience=agent: fallback fires, Backlog item surfaces.
    const agentResult = await tools.nextActions.handler(
      { limit: 3, audience: "agent", stuckThresholdHours: 48, lockStaleHours: 24, treeRecentDoneDays: 7, prStaleHours: 24 },
      {},
    );
    const agentPayload = parsePayload(agentResult) as {
      directions: Array<{ issue?: { number: number } }>;
    };
    const agentNumbers = agentPayload.directions
      .map((d) => d.issue?.number)
      .filter((n): n is number => typeof n === "number");
    expect(
      agentNumbers,
      "next_actions(audience=agent) surfaces Backlog item via fallback",
    ).toContain(2001);

    // next_actions with audience=human: fallback does NOT fire. The
    // candidate set is empty; the response returns 0 directions for
    // the Backlog item.
    const humanResult = await tools.nextActions.handler(
      { limit: 3, audience: "human", stuckThresholdHours: 48, lockStaleHours: 24, treeRecentDoneDays: 7, prStaleHours: 24 },
      {},
    );
    const humanPayload = parsePayload(humanResult) as {
      directions: Array<{ issue?: { number: number } }>;
    };
    const humanNumbers = humanPayload.directions
      .map((d) => d.issue?.number)
      .filter((n): n is number => typeof n === "number");
    expect(
      humanNumbers,
      "next_actions(audience=human) does NOT surface Backlog item",
    ).not.toContain(2001);

    // pipeline_dashboard: Backlog item appears in the Backlog phase's issues.
    const dashboardResult = await tools.dashboard.handler(
      { format: "json", includeHealth: true, doneWindowDays: 7, archiveAgeDays: 14, issuesPerPhase: 10 },
      {},
    );
    const dashboard = parsePayload(dashboardResult) as {
      phases: Array<{ state: string; issues: Array<{ number: number }> }>;
    };
    const backlogPhase = dashboard.phases.find((p) => p.state === "Backlog");
    expect(backlogPhase, "pipeline_dashboard exposes Backlog phase").toBeDefined();
    const dashboardBacklogNumbers =
      backlogPhase?.issues.map((i) => i.number) ?? [];
    expect(
      dashboardBacklogNumbers,
      "pipeline_dashboard.Backlog.issues includes the Backlog item",
    ).toContain(2001);

    // list_issues: Backlog item appears in items[].
    const listResult = await tools.listIssues.handler(
      { state: "OPEN", limit: 50, orderBy: "CREATED_AT" },
      {},
    );
    const listIssues = parsePayload(listResult) as {
      filteredCount: number;
      items: Array<{ number: number; workflowState: string | null }>;
    };
    const listNumbers = listIssues.items.map((i) => i.number);
    expect(
      listNumbers,
      "list_issues.items includes the Backlog item",
    ).toContain(2001);
  });

  it("workflowState=null items are visible to pipeline_dashboard (Unknown bucket), list_issues, and project_hygiene.staleItems, but NOT next_actions(audience=human)", async () => {
    const fixture = buildTwelveItemFixture();
    const { client } = createMockClient(
      { projectNumber: 3 },
      { itemsByProject: { 3: fixture } },
    );
    const tools = registerAll(server, client, fieldCache);

    // pipeline_dashboard: null item lands in the `Unknown` bucket.
    const dashboardResult = await tools.dashboard.handler(
      { format: "json", includeHealth: true, doneWindowDays: 7, archiveAgeDays: 14, issuesPerPhase: 10 },
      {},
    );
    const dashboard = parsePayload(dashboardResult) as {
      phases: Array<{ state: string; issues: Array<{ number: number }> }>;
    };
    const unknownPhase = dashboard.phases.find((p) => p.state === "Unknown");
    expect(
      unknownPhase,
      "pipeline_dashboard surfaces an Unknown phase for null-workflowState items",
    ).toBeDefined();
    const unknownNumbers = unknownPhase?.issues.map((i) => i.number) ?? [];
    expect(
      unknownNumbers,
      "pipeline_dashboard.Unknown.issues includes the null-state item (#1012)",
    ).toContain(1012);

    // list_issues: null item appears in items[]. The `workflowState`
    // key is absent (not literally null) because the impl returns
    // `undefined` from `getFieldValue` for items missing the field, and
    // JSON serialisation drops undefined keys. The visibility contract
    // is "the item is enumerated"; the field-null projection is a
    // separate concern (see `list_issues` `getFieldValue` signature
    // returning `string | undefined`).
    const listResult = await tools.listIssues.handler(
      { state: "OPEN", limit: 50, orderBy: "CREATED_AT" },
      {},
    );
    const listIssues = parsePayload(listResult) as {
      items: Array<{ number: number; workflowState?: string | null }>;
    };
    const listEntry = listIssues.items.find((i) => i.number === 1012);
    expect(
      listEntry,
      "list_issues.items includes the null-state item (#1012)",
    ).toBeDefined();
    // Either `null` (post-serialisation as a literal) or `undefined`
    // (key dropped by JSON.stringify) is acceptable — both encode the
    // same "no workflow state" semantic. A future refactor that returns
    // a non-null value for a null-field item would fail this check.
    expect(
      listEntry?.workflowState ?? null,
      "list_issues null-state item has no workflowState value",
    ).toBeNull();

    // project_hygiene.staleItems: null item with updatedAt 30d ago
    // qualifies because `findStaleItems` filters on `!TERMINAL_STATES`
    // (null passes the check) and ageDays > staleDays (default 7).
    const hygieneResult = await tools.hygiene.handler(
      { format: "json", archiveAgeDays: 14, staleDays: 7, orphanDays: 14, similarityThreshold: 0.8 },
      {},
    );
    const hygiene = parsePayload(hygieneResult) as {
      staleItems: Array<{ number: number; workflowState: string | null }>;
    };
    const staleNumbers = hygiene.staleItems.map((i) => i.number);
    expect(
      staleNumbers,
      "project_hygiene.staleItems includes the null-state item (#1012)",
    ).toContain(1012);

    // next_actions(audience=human): null-state item does NOT surface.
    const humanResult = await tools.nextActions.handler(
      { limit: 3, audience: "human", stuckThresholdHours: 48, lockStaleHours: 24, treeRecentDoneDays: 7, prStaleHours: 24 },
      {},
    );
    const humanPayload = parsePayload(humanResult) as {
      directions: Array<{ issue?: { number: number } }>;
    };
    const humanNumbers = humanPayload.directions
      .map((d) => d.issue?.number)
      .filter((n): n is number => typeof n === "number");
    expect(
      humanNumbers,
      "next_actions(audience=human) does NOT surface the null-state item",
    ).not.toContain(1012);
  });
});

// ---------------------------------------------------------------------------
// list_issues / pipeline_dashboard agreement on closed-non-terminal issues
// (GH-1169)
//
// Before GH-1169, `list_issues` defaulted `state: "OPEN"` and excluded
// closed-but-non-terminal-workflow issues from no-state-arg callers. The
// dashboard family had no equivalent filter, so the two tools disagreed on
// visibility for an issue whose Workflow State was advanced to a
// non-terminal value (e.g., "Plan in Review") while the underlying GitHub
// issue happened to be CLOSED. This regression test pins the post-fix
// agreement so a future re-introduction of an implicit OPEN default would
// fail loudly.
// ---------------------------------------------------------------------------

describe("list_issues / pipeline_dashboard closed-non-terminal agreement (GH-1169)", () => {
  let server: McpServer;
  let fieldCache: FieldOptionCache;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    fieldCache = new FieldOptionCache();
  });

  it("list_issues (no state arg) and pipeline_dashboard agree on closed-non-terminal issues", async () => {
    // Fixture with one CLOSED issue whose Workflow State is non-terminal —
    // the exact shape produced by sync-pr-merge.yml advancing a linked
    // issue's workflow state to "Done" without closing the GitHub issue
    // (research §Path B). We use "Plan in Review" because it is a
    // non-terminal phase the dashboard surfaces.
    const fixture = [
      rawIssue({
        number: 7001,
        title: "7001 OPEN Plan in Review",
        workflowState: "Plan in Review",
        state: "OPEN",
        updatedAt: offsetIso(1 * HOUR_MS),
      }),
      rawIssue({
        number: 7002,
        title: "7002 CLOSED Plan in Review (divergent state)",
        workflowState: "Plan in Review",
        state: "CLOSED",
        closedAt: offsetIso(2 * HOUR_MS),
        updatedAt: offsetIso(1 * HOUR_MS),
      }),
    ];
    const { client } = createMockClient(
      { projectNumber: 3 },
      { itemsByProject: { 3: fixture } },
    );
    const tools = registerAll(server, client, fieldCache);

    // list_issues with NO state arg — relies on the GH-1169 default removal.
    const listResult = await tools.listIssues.handler(
      { workflowState: "Plan in Review", limit: 50, orderBy: "CREATED_AT" },
      {},
    );
    const listIssues = parsePayload(listResult) as {
      items: Array<{ number: number; state: string }>;
    };
    const listNumbers = listIssues.items.map((i) => i.number).sort();

    // pipeline_dashboard — no state filter exists; both items appear in the
    // Plan in Review phase bucket.
    const dashboardResult = await tools.dashboard.handler(
      { format: "json", includeHealth: true, doneWindowDays: 7, archiveAgeDays: 14, issuesPerPhase: 10 },
      {},
    );
    const dashboard = parsePayload(dashboardResult) as {
      phases: Array<{ state: string; issues: Array<{ number: number }> }>;
    };
    const pirPhase = dashboard.phases.find((p) => p.state === "Plan in Review");
    expect(pirPhase, "pipeline_dashboard exposes Plan in Review phase").toBeDefined();
    const dashboardNumbers = (pirPhase?.issues ?? []).map((i) => i.number).sort();

    // Cross-tool agreement: same set of issue numbers in both tools.
    expect(
      listNumbers,
      "list_issues (no state) surfaces both OPEN and CLOSED Plan-in-Review items",
    ).toEqual([7001, 7002]);
    expect(
      dashboardNumbers,
      "pipeline_dashboard surfaces both OPEN and CLOSED Plan-in-Review items",
    ).toEqual([7001, 7002]);
    expect(
      listNumbers,
      "list_issues and pipeline_dashboard agree on closed-non-terminal visibility",
    ).toEqual(dashboardNumbers);
  });

  it("list_groups still defaults state=OPEN (regression pin)", async () => {
    // GH-1169 deliberately left `list_groups`'s OPEN default in place — the
    // acceptance criteria named `list_issues`, `next_actions`, and
    // `pipeline_dashboard` but not `list_groups`. This regression pin
    // documents the current behavior so a future change to `list_groups`
    // has to update this test deliberately.
    //
    // Read the source string directly (no runtime call needed — the
    // Zod-default change is a source-level invariant) and assert the
    // `.default("OPEN")` is still present on the `state` field in
    // relationship-tools.ts. The plan document references
    // relationship-tools.ts:1204-1208 as the parallel default site.
    const relationshipToolsSrc = fs.readFileSync(
      path.resolve(__dirname, "../tools/relationship-tools.ts"),
      "utf-8",
    );
    // Match the state-on-list_groups schema block: an `.enum(["OPEN", "CLOSED"])`
    // followed by `.optional().default("OPEN")`. The match is loose enough
    // to survive whitespace/comment changes but strict enough to catch a
    // default removal.
    expect(
      relationshipToolsSrc,
      "list_groups still has .default(\"OPEN\") on state (regression pin from GH-1169)",
    ).toMatch(/state:\s*z\s*\.enum\(\["OPEN",\s*"CLOSED"\]\)\s*\.optional\(\)\s*\.default\("OPEN"\)/);
  });
});
