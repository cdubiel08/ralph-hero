/**
 * Tests for archive/unarchive on `ralph_hero__batch_update` (GH-1611).
 *
 * GH-1611 folded the former standalone `ralph_hero__archive_items` tool
 * into `ralph_hero__batch_update` as an `{action: "archive"|"unarchive"}`
 * operation with an `issues`/`projectItemIds`/`filter` selector, and ADDED
 * the GH-0870 open-children guard server-side to the filter-driven bulk
 * scan path (mirroring `findArchiveCandidates()` in `lib/hygiene.ts`) —
 * closing a bypass that existed in the standalone tool (its scan query
 * never fetched sub-issue data at all).
 *
 * The pure `buildBatchArchiveMutation`/`buildBatchUnarchiveMutation`
 * builder tests need no mocking. The integration-style tests below drive
 * the registered `ralph_hero__batch_update` handler directly against a
 * mocked `GitHubClient`, mirroring the `getTool` pattern used in
 * `health-check.test.ts` / `trends-tools.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildBatchArchiveMutation,
  buildBatchUnarchiveMutation,
  registerBatchTools,
} from "../tools/batch-tools.js";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";

describe("buildBatchArchiveMutation", () => {
  it("generates correct aliases for multiple items", () => {
    const { mutationString, variables } = buildBatchArchiveMutation(
      "proj-123",
      ["item-a", "item-b", "item-c"],
    );
    expect(mutationString).toContain("a0:");
    expect(mutationString).toContain("a1:");
    expect(mutationString).toContain("a2:");
    expect(variables.projectId).toBe("proj-123");
    expect(variables.item_a0).toBe("item-a");
    expect(variables.item_a1).toBe("item-b");
    expect(variables.item_a2).toBe("item-c");
  });

  it("starts with mutation keyword", () => {
    const { mutationString } = buildBatchArchiveMutation("proj-1", ["item-1"]);
    expect(mutationString.trimStart()).toMatch(/^mutation\(/);
  });

  it("uses archiveProjectV2Item mutation", () => {
    const { mutationString } = buildBatchArchiveMutation("proj-1", ["item-1"]);
    expect(mutationString).toContain("archiveProjectV2Item");
  });

  it("handles single item correctly", () => {
    const { mutationString, variables } = buildBatchArchiveMutation(
      "proj-1",
      ["single-item"],
    );
    expect(mutationString).toContain("a0:");
    expect(mutationString).not.toContain("a1:");
    expect(variables.item_a0).toBe("single-item");
  });

  it("does not use reserved @octokit/graphql variable names", () => {
    const reserved = ["query", "method", "url"];
    const { variables } = buildBatchArchiveMutation("proj-1", [
      "item-1",
      "item-2",
    ]);
    for (const key of Object.keys(variables)) {
      expect(reserved).not.toContain(key);
    }
  });

  it("shares projectId variable across all aliases", () => {
    const { mutationString, variables } = buildBatchArchiveMutation(
      "proj-shared",
      ["item-1", "item-2", "item-3"],
    );
    // Only one $projectId declaration
    const projectIdMatches = mutationString.match(/\$projectId/g);
    // Should appear in var decl + once per alias input
    expect(projectIdMatches).toBeTruthy();
    expect(variables.projectId).toBe("proj-shared");
  });
});

describe("buildBatchUnarchiveMutation", () => {
  it("generates correct aliases for multiple items", () => {
    const { mutationString, variables } = buildBatchUnarchiveMutation(
      "proj-123",
      ["item-a", "item-b"],
    );
    expect(mutationString).toContain("u0:");
    expect(mutationString).toContain("u1:");
    expect(variables.item_u0).toBe("item-a");
    expect(variables.item_u1).toBe("item-b");
  });

  it("uses unarchiveProjectV2Item mutation", () => {
    const { mutationString } = buildBatchUnarchiveMutation("proj-1", ["item-1"]);
    expect(mutationString).toContain("unarchiveProjectV2Item");
  });

  it("does not use reserved @octokit/graphql variable names", () => {
    const reserved = ["query", "method", "url"];
    const { variables } = buildBatchUnarchiveMutation("proj-1", [
      "item-1",
      "item-2",
    ]);
    for (const key of Object.keys(variables)) {
      expect(reserved).not.toContain(key);
    }
  });
});

describe("bulk_archive dryRun", () => {
  it("dryRun response includes wouldArchive count and items list", () => {
    const matched = [
      { id: "item-1", content: { number: 10, title: "Issue A" } },
      { id: "item-2", content: { number: 20, title: "Issue B" } },
    ];
    const result = {
      dryRun: true,
      wouldArchive: matched.length,
      items: matched.map((m) => ({
        number: m.content?.number,
        title: m.content?.title,
        itemId: m.id,
      })),
      errors: [],
    };
    expect(result.dryRun).toBe(true);
    expect(result.wouldArchive).toBe(2);
    expect(result.items).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  it("dryRun flag is false in normal response", () => {
    const result = {
      dryRun: false,
      archivedCount: 1,
      items: [{ number: 10, title: "Issue A", itemId: "item-1" }],
      errors: [],
    };
    expect(result.dryRun).toBe(false);
    expect(result.archivedCount).toBe(1);
  });

  it("dryRun items include number, title, and itemId", () => {
    const matched = [
      { id: "item-x", content: { number: 42, title: "My Issue" } },
    ];
    const items = matched.map((m) => ({
      number: m.content?.number,
      title: m.content?.title,
      itemId: m.id,
    }));
    expect(items[0]).toEqual({
      number: 42,
      title: "My Issue",
      itemId: "item-x",
    });
  });
});

describe("bulk_archive updatedBefore", () => {
  it("date validation rejects invalid dates", () => {
    expect(isNaN(new Date("not-a-date").getTime())).toBe(true);
    expect(isNaN(new Date("").getTime())).toBe(true);
    expect(isNaN(new Date("hello world").getTime())).toBe(true);
  });

  it("date validation accepts valid ISO dates", () => {
    expect(isNaN(new Date("2026-02-01T00:00:00Z").getTime())).toBe(false);
    expect(isNaN(new Date("2026-02-01").getTime())).toBe(false);
    expect(isNaN(new Date("2026-01-15T12:30:00Z").getTime())).toBe(false);
  });

  it("date filter composes with workflow state filter", () => {
    const cutoff = new Date("2026-02-01T00:00:00Z").getTime();
    const items = [
      { content: { updatedAt: "2026-01-15T00:00:00Z" }, ws: "Done" },
      { content: { updatedAt: "2026-02-15T00:00:00Z" }, ws: "Done" },
      { content: { updatedAt: "2026-01-10T00:00:00Z" }, ws: "In Progress" },
    ];

    const matched = items
      .filter((item) => item.ws === "Done")
      .filter((item) =>
        item.content?.updatedAt
          ? new Date(item.content.updatedAt).getTime() < cutoff
          : false,
      );

    // Only the first item: Done AND updatedAt before cutoff
    expect(matched).toHaveLength(1);
    expect(matched[0].content.updatedAt).toBe("2026-01-15T00:00:00Z");
  });

  it("items with null content are excluded from date filter", () => {
    const cutoff = new Date("2026-02-01T00:00:00Z").getTime();
    const items: Array<{ content: { updatedAt?: string } | null }> = [
      { content: null },
      { content: { updatedAt: "2026-01-15T00:00:00Z" } },
      { content: {} },
    ];

    const matched = items.filter((item) =>
      item.content?.updatedAt
        ? new Date(item.content.updatedAt).getTime() < cutoff
        : false,
    );

    // null content and missing updatedAt are excluded
    expect(matched).toHaveLength(1);
    expect(matched[0].content?.updatedAt).toBe("2026-01-15T00:00:00Z");
  });
});

describe("bulk_archive mutation structure", () => {
  it("archiveProjectV2Item mutation has required input fields", () => {
    const mutation = `mutation($projectId: ID!, $item_a0: ID!) {
      a0: archiveProjectV2Item(input: {
        projectId: $projectId,
        itemId: $item_a0
      }) {
        item { id }
      }
    }`;
    expect(mutation).toContain("archiveProjectV2Item");
    expect(mutation).toContain("projectId");
    expect(mutation).toContain("item_a0");
  });
});

// ---------------------------------------------------------------------------
// batch_update source-level structural checks (GH-1611 — archive folded in)
// ---------------------------------------------------------------------------

import * as fs from "fs";
import * as path from "path";

const batchToolsSrc = fs.readFileSync(
  path.resolve(__dirname, "../tools/batch-tools.ts"),
  "utf-8",
);
const pmToolsSrc = fs.readFileSync(
  path.resolve(__dirname, "../tools/project-management-tools.ts"),
  "utf-8",
);

describe("archive/unarchive folded into ralph_hero__batch_update (GH-1611)", () => {
  it("batch_update tool source contains archive/unarchive action schema", () => {
    expect(batchToolsSrc).toContain("ralph_hero__batch_update");
    expect(batchToolsSrc).toContain('"archive"');
    expect(batchToolsSrc).toContain('"unarchive"');
  });

  it("standalone archive_items tool is fully removed from project-management-tools", () => {
    expect(pmToolsSrc).not.toContain("ralph_hero__archive_items");
  });

  it("schema includes filter selector for bulk mode", () => {
    expect(batchToolsSrc).toContain("filter:");
    expect(batchToolsSrc).toContain("workflowStates");
  });

  it("schema includes projectItemIds selector for draft items", () => {
    expect(batchToolsSrc).toContain("projectItemIds");
  });

  it("validates mutually exclusive selectors", () => {
    expect(batchToolsSrc).toContain(
      "`filter` is mutually exclusive with `issues`/`projectItemIds`.",
    );
  });

  it("rejects unarchive combined with filter", () => {
    expect(batchToolsSrc).toContain(
      "`filter` is only valid with the `archive` action, not `unarchive`.",
    );
  });

  it("rejects mixing field ops with archive/unarchive ops", () => {
    expect(batchToolsSrc).toContain(
      "Cannot mix field operations with archive/unarchive operations",
    );
  });

  it("source contains SCAN_CAP constant", () => {
    expect(batchToolsSrc).toContain("SCAN_CAP");
  });

  it("source contains hasMore and totalScanned in response objects", () => {
    expect(batchToolsSrc).toContain("hasMore");
    expect(batchToolsSrc).toContain("totalScanned");
  });

  it("GH-0870 guard: scan query fetches subIssues and skip reason is present", () => {
    expect(batchToolsSrc).toContain("subIssues { totalCount }");
    expect(batchToolsSrc).toContain("open-or-any-children");
  });
});

// ---------------------------------------------------------------------------
// Integration: ralph_hero__batch_update archive mode (handler-level)
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

interface ScanFixtureItem {
  id: string;
  number: number;
  title: string;
  workflowState: string;
  updatedAt?: string;
  subIssueCount?: number;
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
                { id: "opt-done", name: "Done" },
                { id: "opt-canceled", name: "Canceled" },
                { id: "opt-ip", name: "In Progress" },
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

function isScanQuery(q: string): boolean {
  return q.includes("node(id: $projectId)") && q.includes("items(first:");
}

function isIssueNodeIdQuery(q: string): boolean {
  return q.includes("repository(owner:") && q.includes("issue(number:");
}

function isProjectItemIdQuery(q: string): boolean {
  return q.includes("node(id: $issueId)") && q.includes("projectItems");
}

function scanNode(item: ScanFixtureItem) {
  return {
    id: item.id,
    type: "ISSUE",
    content: {
      number: item.number,
      title: item.title,
      updatedAt: item.updatedAt ?? new Date().toISOString(),
      subIssues: { totalCount: item.subIssueCount ?? 0 },
    },
    fieldValues: {
      nodes: [
        {
          __typename: "ProjectV2ItemFieldSingleSelectValue",
          name: item.workflowState,
          field: { name: "Workflow State" },
        },
      ],
    },
  };
}

function makeMockClient(opts: {
  projectId?: string;
  scanItems?: ScanFixtureItem[];
  mutateShouldFail?: boolean;
}): { client: GitHubClient; projectMutate: ReturnType<typeof vi.fn> } {
  const projectId = opts.projectId ?? "project-id-1";
  const scanItems = opts.scanItems ?? [];
  const cacheStore = new Map<string, unknown>();

  const projectQuery = vi.fn(async (q: string) => {
    if (isFieldCacheQuery(q)) {
      return fieldCacheResponse(projectId);
    }
    if (isScanQuery(q)) {
      return {
        node: {
          items: {
            totalCount: scanItems.length,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: scanItems.map(scanNode),
          },
        },
      };
    }
    throw new Error(`Unmocked projectQuery: ${q.slice(0, 80)}`);
  });

  const query = vi.fn(async (q: string, vars: Record<string, unknown>) => {
    if (isIssueNodeIdQuery(q)) {
      return { repository: { issue: { id: `issue-node-${vars.number}` } } };
    }
    if (isProjectItemIdQuery(q)) {
      const issueId = vars.issueId as string;
      const match = issueId.match(/issue-node-(\d+)/);
      const num = match ? match[1] : "0";
      return {
        node: {
          projectItems: {
            nodes: [{ id: `item-issue-${num}`, project: { id: projectId } }],
          },
        },
      };
    }
    throw new Error(`Unmocked query: ${q.slice(0, 80)}`);
  });

  const projectMutate = opts.mutateShouldFail
    ? vi.fn().mockRejectedValue(new Error("mutation failed"))
    : vi.fn().mockResolvedValue({});

  const client = {
    config: {
      token: "test",
      owner: "octocat",
      repo: "repo",
      projectNumber: 7,
      projectOwner: "octocat",
    },
    query,
    projectQuery,
    mutate: vi.fn(),
    projectMutate,
    getCache: vi.fn(() => ({
      get: (key: string) => cacheStore.get(key),
      set: (key: string, value: unknown) => cacheStore.set(key, value),
      invalidatePrefix: vi.fn(),
    })),
    getAuthenticatedUser: vi.fn(),
    getRateLimitStatus: vi.fn(),
    restPost: vi.fn(),
  } as unknown as GitHubClient;

  return { client, projectMutate };
}

describe("ralph_hero__batch_update archive mode (integration)", () => {
  let server: McpServer;
  let fieldCache: FieldOptionCache;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    fieldCache = new FieldOptionCache();
  });

  it("filter mode dryRun previews matches without archiving", async () => {
    const { client, projectMutate } = makeMockClient({
      scanItems: [
        { id: "item-1", number: 10, title: "Done thing", workflowState: "Done" },
        { id: "item-2", number: 11, title: "Not done", workflowState: "In Progress" },
      ],
    });
    registerBatchTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__batch_update");

    const result = await tool.handler(
      {
        operations: [{ action: "archive" }],
        filter: { workflowStates: ["Done"] },
        dryRun: true,
      },
      {},
    );
    expect(result.isError).toBeFalsy();
    const payload = parsePayload(result);
    expect(payload.dryRun).toBe(true);
    expect(payload.wouldArchive).toBe(1);
    expect(payload.items).toEqual([
      { number: 10, title: "Done thing", itemId: "item-1" },
    ]);
    expect(projectMutate).not.toHaveBeenCalled();
  });

  it("filter mode archives matched items when dryRun is false", async () => {
    const { client, projectMutate } = makeMockClient({
      scanItems: [
        { id: "item-1", number: 10, title: "Done thing", workflowState: "Done" },
      ],
    });
    registerBatchTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__batch_update");

    const result = await tool.handler(
      {
        operations: [{ action: "archive" }],
        filter: { workflowStates: ["Done"] },
      },
      {},
    );
    expect(result.isError).toBeFalsy();
    const payload = parsePayload(result);
    expect(payload.dryRun).toBe(false);
    expect(payload.archivedCount).toBe(1);
    expect(projectMutate).toHaveBeenCalledTimes(1);
  });

  it("GH-0870 guard: a parent with sub-issues is skipped, not archived", async () => {
    const { client, projectMutate } = makeMockClient({
      scanItems: [
        {
          id: "item-parent",
          number: 20,
          title: "Epic with children",
          workflowState: "Done",
          subIssueCount: 3,
        },
        {
          id: "item-leaf",
          number: 21,
          title: "Leaf, no children",
          workflowState: "Done",
          subIssueCount: 0,
        },
      ],
    });
    registerBatchTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__batch_update");

    const result = await tool.handler(
      {
        operations: [{ action: "archive" }],
        filter: { workflowStates: ["Done"] },
      },
      {},
    );
    expect(result.isError).toBeFalsy();
    const payload = parsePayload(result);

    // Only the leaf (no sub-issues) was archived.
    expect(payload.archivedCount).toBe(1);
    const items = payload.items as Array<{ number: number }>;
    expect(items.map((i) => i.number)).toEqual([21]);

    // The parent with sub-issues is reported as skipped, not archived.
    const skipped = payload.skipped as Array<{ number: number; reason: string }>;
    expect(skipped).toEqual([{ number: 20, reason: "open-or-any-children" }]);

    // Only one archive mutation ran (for the leaf), proving the parent
    // never reached archiveProjectV2Item.
    expect(projectMutate).toHaveBeenCalledTimes(1);
  });

  it("explicit issues[] selection bypasses the GH-0870 guard by design", async () => {
    const { client, projectMutate } = makeMockClient({});
    registerBatchTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__batch_update");

    // No filter/scan involved at all — explicit issue number targeting.
    const result = await tool.handler(
      {
        operations: [{ action: "archive" }],
        issues: [42],
      },
      {},
    );
    expect(result.isError).toBeFalsy();
    const payload = parsePayload(result);
    expect(payload.archivedCount).toBe(1);
    expect(payload.skipped).toEqual([]);
    expect(projectMutate).toHaveBeenCalledTimes(1);
  });

  it("explicit projectItemIds[] can be unarchived", async () => {
    const { client, projectMutate } = makeMockClient({});
    registerBatchTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__batch_update");

    const result = await tool.handler(
      {
        operations: [{ action: "unarchive" }],
        projectItemIds: ["PVTI_draft123"],
      },
      {},
    );
    expect(result.isError).toBeFalsy();
    const payload = parsePayload(result);
    expect(payload.action).toBe("unarchive");
    expect(payload.archivedCount).toBe(1);
    expect(projectMutate).toHaveBeenCalledTimes(1);
    const [mutationString] = projectMutate.mock.calls[0] as [string, unknown];
    expect(mutationString).toContain("unarchiveProjectV2Item");
  });

  it("rejects filter combined with unarchive", async () => {
    const { client } = makeMockClient({});
    registerBatchTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__batch_update");

    const result = await tool.handler(
      {
        operations: [{ action: "unarchive" }],
        filter: { workflowStates: ["Done"] },
      },
      {},
    );
    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error).toMatch(/only valid with the `archive` action/);
  });

  it("rejects filter combined with explicit issues", async () => {
    const { client } = makeMockClient({});
    registerBatchTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__batch_update");

    const result = await tool.handler(
      {
        operations: [{ action: "archive" }],
        filter: { workflowStates: ["Done"] },
        issues: [1],
      },
      {},
    );
    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error).toMatch(/mutually exclusive/);
  });

  it("rejects mixing field operations with archive/unarchive operations", async () => {
    const { client } = makeMockClient({});
    registerBatchTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__batch_update");

    const result = await tool.handler(
      {
        issues: [1],
        operations: [
          { field: "workflow_state", value: "Done" },
          { action: "archive" },
        ],
      },
      {},
    );
    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error).toMatch(/Cannot mix field operations/);
  });

  it("rejects archive/unarchive with no selector at all", async () => {
    const { client } = makeMockClient({});
    registerBatchTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__batch_update");

    const result = await tool.handler(
      { operations: [{ action: "archive" }] },
      {},
    );
    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error).toMatch(/Provide `issues`, `projectItemIds`, or `filter`/);
  });

  it("field-update mode still requires issues", async () => {
    const { client } = makeMockClient({});
    registerBatchTools(server, client, fieldCache);
    const tool = getTool(server, "ralph_hero__batch_update");

    const result = await tool.handler(
      { operations: [{ field: "workflow_state", value: "Done" }] },
      {},
    );
    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error).toMatch(/Field operations require `issues`/);
  });
});
