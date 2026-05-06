/**
 * Integration tests for `registerTrendsTools` /
 * `ralph_hero__capture_snapshot`.
 *
 * Mocks `client.projectQuery` end-to-end (field cache + dashboard items
 * fetch) and redirects snapshot writes to a tmpdir via the
 * `__setSnapshotRoot` test hook.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTrendsTools } from "../tools/trends-tools.js";
import type { GitHubClient } from "../github-client.js";
import type { GitHubClientConfig } from "../types.js";
import { FieldOptionCache } from "../lib/cache.js";
import {
  __setSnapshotRoot,
  appendSnapshot,
  readSnapshots,
  snapshotPath,
  SNAPSHOT_SCHEMA_VERSION,
  type Snapshot,
} from "../lib/snapshots.js";

// ---------------------------------------------------------------------------
// Fixture helpers (shape mirrors DASHBOARD_ITEMS_QUERY response)
// ---------------------------------------------------------------------------

interface RawIssueFixture {
  number: number;
  title: string;
  workflowState?: string | null;
  priority?: string | null;
  estimate?: string | null;
  updatedAt?: string;
  closedAt?: string | null;
}

function rawIssue(fix: RawIssueFixture): unknown {
  const fieldValues: Array<Record<string, unknown>> = [];
  if (fix.workflowState) {
    fieldValues.push({
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      name: fix.workflowState,
      field: { name: "Workflow State" },
    });
  }
  if (fix.priority) {
    fieldValues.push({
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      name: fix.priority,
      field: { name: "Priority" },
    });
  }
  if (fix.estimate) {
    fieldValues.push({
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      name: fix.estimate,
      field: { name: "Estimate" },
    });
  }

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
      repository: { nameWithOwner: "octocat/repo", name: "repo" },
      subIssues: { totalCount: 0 },
      trackedIssues: { nodes: [] },
      trackedInIssues: { nodes: [] },
    },
    fieldValues: { nodes: fieldValues },
  };
}

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
                { id: "opt-ip", name: "In Progress" },
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
              ],
            },
            {
              id: "field-est-id",
              name: "Estimate",
              dataType: "SINGLE_SELECT",
              options: [
                { id: "xs", name: "XS" },
                { id: "s", name: "S" },
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

function isDashboardItemsQuery(q: string): boolean {
  return q.includes("node(id: $projectId)") && q.includes("items(first:");
}

function isProjectTitleQuery(q: string): boolean {
  return q.includes("ProjectV2 { title }");
}

interface MockClientOptions {
  itemsByProject?: Record<number, unknown[]>;
  projectTitle?: string;
  /** When set, `client.query` returns `comments(last: 100)` nodes for the
   * matching issue number. Issues not in the map return `{ nodes: [] }`. */
  commentsByIssueNumber?: Record<number, Array<{ body: string; createdAt: string }>>;
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
    owner: "octocat",
    projectNumber: 7,
    projectOwner: "octocat",
    ...config,
  };

  const projectQuery = vi.fn(async (q: string, vars: Record<string, unknown>) => {
    if (isFieldCacheQuery(q)) {
      return fieldCacheResponse(`project-id-${vars.number}`);
    }
    if (isProjectTitleQuery(q)) {
      return { node: { title: options.projectTitle ?? "Test Project" } };
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

  const query = vi.fn(async (_q: string, vars: Record<string, unknown>) => {
    const number = vars.number as number;
    const nodes = options.commentsByIssueNumber?.[number] ?? [];
    return {
      repository: {
        issue: {
          comments: { nodes },
        },
      },
    };
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
// Server harness
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

function parsePayload(result: HandlerResult): Record<string, unknown> {
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ralph_hero__capture_snapshot", () => {
  let tmpRoot: string;
  let server: McpServer;
  let fieldCache: FieldOptionCache;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "trends-test-"));
    __setSnapshotRoot(tmpRoot);
    server = new McpServer({ name: "test", version: "0.0.0" });
    fieldCache = new FieldOptionCache();
  });

  afterEach(async () => {
    __setSnapshotRoot(null);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("appends one snapshot row matching the returned payload", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const fixtures = [
      rawIssue({
        number: 1,
        title: "in backlog",
        workflowState: "Backlog",
        priority: "P1",
        estimate: "S",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 2,
        title: "in progress",
        workflowState: "In Progress",
        priority: "P0",
        estimate: "S",
        updatedAt: oneHourAgo,
      }),
      rawIssue({
        number: 3,
        title: "done recently",
        workflowState: "Done",
        priority: "P2",
        estimate: "XS",
        updatedAt: recent,
        closedAt: recent,
      }),
    ];

    const { client } = createMockClient(
      { owner: "octocat", projectNumber: 7, projectOwner: "octocat" },
      { itemsByProject: { 7: fixtures } },
    );

    registerTrendsTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__capture_snapshot");

    const result = await tool.handler({ windowDays: 7 }, {});
    expect(result.isError).toBeFalsy();

    const payload = parsePayload(result);
    expect(payload.owner).toBe("octocat");
    expect(payload.projectNumber).toBe(7);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.velocity).toBe(1); // one Done in window
    expect(payload.windowDays).toBe(7);
    expect(payload.cycleTime).toBeUndefined();

    const wipByPhase = payload.wipByPhase as Record<string, number>;
    expect(wipByPhase.Backlog).toBe(1);
    expect(wipByPhase["In Progress"]).toBe(1);
    expect(wipByPhase.Done).toBe(1);

    // Verify file contains exactly one line matching the returned snapshot.
    const file = snapshotPath("octocat", 7);
    const raw = await fs.readFile(file, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const written = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(written.capturedAt).toBe(payload.capturedAt);
    expect(written.owner).toBe("octocat");
    expect(written.projectNumber).toBe(7);
  });

  it("appends a second row on re-invocation (preserving the first)", async () => {
    const { client } = createMockClient(
      { owner: "octocat", projectNumber: 7, projectOwner: "octocat" },
      { itemsByProject: { 7: [rawIssue({ number: 1, title: "x", workflowState: "Backlog" })] } },
    );

    registerTrendsTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__capture_snapshot");

    await tool.handler({ windowDays: 7 }, {});
    // Tiny delay so the two captures get distinct ISO timestamps.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tool.handler({ windowDays: 7 }, {});

    const rows = await readSnapshots("octocat", 7);
    expect(rows).toHaveLength(2);
    expect(rows[0].capturedAt).not.toBe(rows[1].capturedAt);
  });

  it("returns an error when owner is missing", async () => {
    const { client } = createMockClient({
      owner: undefined,
      projectOwner: undefined,
      projectNumber: 7,
    });

    registerTrendsTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__capture_snapshot");

    const result = await tool.handler({ windowDays: 7 }, {});
    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error).toMatch(/RALPH_GH_OWNER/);
  });

  it("populates cycleTime when a Done item has parseable transition comments", async () => {
    const recent = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const fixtures = [
      rawIssue({
        number: 42,
        title: "done with transitions",
        workflowState: "Done",
        priority: "P1",
        estimate: "S",
        updatedAt: recent,
        closedAt: recent,
      }),
    ];

    // Two transitions 4h apart so the rollup yields a real lead time.
    const t1 = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const t2 = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const transitionA = `<!-- ralph-transition: ${JSON.stringify({
      from: "In Progress",
      to: "In Review",
      command: "ralph_pr",
      at: t1,
    })} -->`;
    const transitionB = `<!-- ralph-transition: ${JSON.stringify({
      from: "In Review",
      to: "Done",
      command: "ralph_merge",
      at: t2,
    })} -->`;

    const { client } = createMockClient(
      { owner: "octocat", projectNumber: 7, projectOwner: "octocat" },
      {
        itemsByProject: { 7: fixtures },
        commentsByIssueNumber: {
          42: [
            { body: transitionA, createdAt: t1 },
            { body: transitionB, createdAt: t2 },
          ],
        },
      },
    );

    registerTrendsTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__capture_snapshot");

    const result = await tool.handler({ windowDays: 7 }, {});
    expect(result.isError).toBeFalsy();
    const payload = parsePayload(result);

    expect(payload.cycleTime).toBeDefined();
    const ct = payload.cycleTime as Record<string, unknown>;
    expect(ct.sampleSize).toBe(1);
    // Lead-time is the 4h interval between the two transitions.
    expect(ct.leadTimeP50Hours).toBeCloseTo(4, 1);

    // JSONL row also carries the cycleTime.
    const file = snapshotPath("octocat", 7);
    const raw = await fs.readFile(file, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const written = JSON.parse(lines[0]) as Record<string, unknown>;
    expect((written.cycleTime as Record<string, unknown>).sampleSize).toBe(1);
  });

  it("returns an error when projectNumber is unset and no arg supplied", async () => {
    const { client } = createMockClient({
      owner: "octocat",
      projectOwner: "octocat",
      projectNumber: undefined,
    });

    registerTrendsTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__capture_snapshot");

    const result = await tool.handler({ windowDays: 7 }, {});
    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error).toMatch(/RALPH_GH_/);
  });
});
