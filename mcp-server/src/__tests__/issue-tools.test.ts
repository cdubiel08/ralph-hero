/**
 * Structural tests for issue-tools: verifies tool parameters, GraphQL query
 * structure, and filter chain completeness without making API calls.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerIssueTools } from "../tools/issue-tools.js";
import type { GitHubClient } from "../github-client.js";
import type { GitHubClientConfig } from "../types.js";
import { FieldOptionCache } from "../lib/cache.js";

const issueToolsSrc = fs.readFileSync(
  path.resolve(__dirname, "../tools/issue-tools.ts"),
  "utf-8",
);

describe("list_issues profile param", () => {
  it("has profile param in Zod schema", () => {
    expect(issueToolsSrc).toContain("profile: z");
  });

  it("imports expandProfile", () => {
    expect(issueToolsSrc).toContain(
      'import { expandProfile } from "../lib/filter-profiles.js"',
    );
  });

  it("calls expandProfile when profile is set", () => {
    expect(issueToolsSrc).toContain("expandProfile(args.profile)");
  });

  it("explicit args override profile defaults", () => {
    expect(issueToolsSrc).toContain("=== undefined");
  });
});

describe("list_issues structural", () => {
  it("tool description mentions updatedSince", () => {
    expect(issueToolsSrc).toContain("updatedSince");
  });

  it("tool description mentions updatedBefore", () => {
    expect(issueToolsSrc).toContain("updatedBefore");
  });

  it("GraphQL query fetches updatedAt", () => {
    expect(issueToolsSrc).toContain("updatedAt");
  });

  it("response mapping includes updatedAt", () => {
    expect(issueToolsSrc).toContain("updatedAt: content?.updatedAt");
  });

  it("imports parseDateMath", () => {
    expect(issueToolsSrc).toContain(
      'import { parseDateMath } from "../lib/date-math.js"',
    );
  });

  it("GraphQL query contains stateReason", () => {
    expect(issueToolsSrc).toContain("stateReason");
  });

  it("tool has reason parameter", () => {
    // Verify the reason enum is defined in the Zod schema
    expect(issueToolsSrc).toContain(
      '"completed", "not_planned", "reopened"',
    );
  });

  it("response mapping includes stateReason", () => {
    expect(issueToolsSrc).toContain("stateReason: content?.stateReason");
  });
});

describe("list_issues Project-V2 scoping disclosure (GH-1572 Phase 1)", () => {
  it("tool description states the default scope is Project V2 board membership", () => {
    expect(issueToolsSrc).toContain('scope: \\"project\\"');
  });

  it('tool description forward-references scope: "repo" as the repo-wide check', () => {
    expect(issueToolsSrc).toContain('scope: \\"repo\\"');
  });

  it("tool description warns that an empty result does not mean the issue doesn't exist", () => {
    expect(issueToolsSrc).toContain("doesn't exist in the repo");
  });

  it("create_issue description documents the dedup check and skipDedupeCheck opt-out", () => {
    expect(issueToolsSrc).toContain("skipDedupeCheck");
    expect(issueToolsSrc).toContain("duplicate check");
  });

  it("create_issue Zod schema has skipDedupeCheck: zBoolish()", () => {
    expect(issueToolsSrc).toContain("skipDedupeCheck: zBoolish()");
  });
});

describe("list_issues scope param structural (GH-1572 Phase 2)", () => {
  it("has scope param in Zod schema", () => {
    expect(issueToolsSrc).toContain("scope: z");
  });

  it("imports searchRepoIssues", () => {
    expect(issueToolsSrc).toContain(
      'import { searchRepoIssues } from "../lib/repo-issue-search.js"',
    );
  });
});

describe("list_issues has/no presence filters structural", () => {
  it("Zod schema includes has param with enum", () => {
    expect(issueToolsSrc).toContain('"workflowState", "estimate", "priority", "labels", "assignees"');
  });

  it("Zod schema includes both has and no params", () => {
    expect(issueToolsSrc).toMatch(/has:\s*z\s*\.array/);
    expect(issueToolsSrc).toMatch(/no:\s*z\s*\.array/);
  });

  it("has filter applies every() check", () => {
    expect(issueToolsSrc).toContain("args.has!.every");
  });

  it("no filter applies every() with negation", () => {
    expect(issueToolsSrc).toContain("!hasField(item, field");
  });

  it("hasField helper handles all five field types", () => {
    expect(issueToolsSrc).toContain('case "workflowState"');
    expect(issueToolsSrc).toContain('case "estimate"');
    expect(issueToolsSrc).toContain('case "priority"');
    expect(issueToolsSrc).toContain('case "labels"');
    expect(issueToolsSrc).toContain('case "assignees"');
  });
});

describe("list_issues exclude negation filters structural", () => {
  it("Zod schema includes excludeWorkflowStates param", () => {
    expect(issueToolsSrc).toContain("excludeWorkflowStates");
  });

  it("Zod schema includes excludeEstimates param", () => {
    expect(issueToolsSrc).toContain("excludeEstimates");
  });

  it("Zod schema includes excludePriorities param", () => {
    expect(issueToolsSrc).toContain("excludePriorities");
  });

  it("Zod schema includes excludeLabels param", () => {
    expect(issueToolsSrc).toContain("excludeLabels");
  });

  it("negation filters use Array.includes for matching", () => {
    expect(issueToolsSrc).toContain("excludeWorkflowStates!.includes");
    expect(issueToolsSrc).toContain("excludeEstimates!.includes");
    expect(issueToolsSrc).toContain("excludePriorities!.includes");
    expect(issueToolsSrc).toContain("excludeLabels!.includes");
  });

  it("items without field values are not excluded via ?? coercion", () => {
    expect(issueToolsSrc).toContain('?? ""');
  });
});

describe("list_issues repoFilter structural", () => {
  it("Zod schema includes repoFilter param", () => {
    expect(issueToolsSrc).toContain("repoFilter: z");
  });

  it("GraphQL query fetches repository data", () => {
    expect(issueToolsSrc).toContain("repository { name nameWithOwner }");
  });

  it("filter logic uses case-insensitive comparison", () => {
    expect(issueToolsSrc).toContain("args.repoFilter.toLowerCase()");
  });

  it("supports both name and nameWithOwner formats", () => {
    expect(issueToolsSrc).toContain('rf.includes("/")');
  });
});

// ---------------------------------------------------------------------------
// get_issue includePipeline structural tests (GH-454)
// ---------------------------------------------------------------------------

describe("get_issue includePipeline structural", () => {
  it("has includePipeline param in Zod schema", () => {
    expect(issueToolsSrc).toContain("includePipeline: z");
  });

  it("includePipeline defaults to false", () => {
    expect(issueToolsSrc).toContain('.default(false)');
  });

  it("handler imports detectPipelinePosition", () => {
    expect(issueToolsSrc).toContain("detectPipelinePosition");
  });

  it("handler imports OVERSIZED_ESTIMATES", () => {
    expect(issueToolsSrc).toContain("OVERSIZED_ESTIMATES");
  });

  it("handler calls getIssueFieldValues for non-seed members", () => {
    expect(issueToolsSrc).toContain("getIssueFieldValues(client, fieldCache,");
  });

  it("pipeline result includes phase, convergence, memberStates", () => {
    expect(issueToolsSrc).toContain("phase: pipelineResult.phase");
    expect(issueToolsSrc).toContain("convergence: pipelineResult.convergence");
    expect(issueToolsSrc).toContain("memberStates: pipelineResult.issues");
  });

  it("pipeline is conditionally included in response", () => {
    expect(issueToolsSrc).toContain("pipeline !== null");
  });
});

// ---------------------------------------------------------------------------
// list_issues iteration filter structural tests (GH-510)
// ---------------------------------------------------------------------------

describe("list_issues iteration filter structural", () => {
  it("Zod schema includes iteration param", () => {
    expect(issueToolsSrc).toContain("iteration: z");
  });

  it("iteration param description mentions @current and @next tokens", () => {
    expect(issueToolsSrc).toContain("@current");
    expect(issueToolsSrc).toContain("@next");
  });

  it("GraphQL query includes ProjectV2ItemFieldIterationValue fragment", () => {
    expect(issueToolsSrc).toContain("ProjectV2ItemFieldIterationValue");
  });

  it("GraphQL fragment fetches iterationId, title, startDate, duration", () => {
    expect(issueToolsSrc).toContain("iterationId");
    expect(issueToolsSrc).toContain("startDate");
    expect(issueToolsSrc).toContain("duration");
  });

  it("RawProjectItem type includes iteration fields", () => {
    // The type should include iterationId
    const typeSection = issueToolsSrc.slice(
      issueToolsSrc.indexOf("interface RawProjectItem"),
      issueToolsSrc.indexOf("interface RawProjectItem") + 500,
    );
    expect(typeSection).toContain("iterationId?: string");
  });

  it("getIterationValue helper extracts iteration data from items", () => {
    expect(issueToolsSrc).toContain("function getIterationValue");
    expect(issueToolsSrc).toContain("ProjectV2ItemFieldIterationValue");
  });

  it("iteration filter calls resolveIterationId", () => {
    expect(issueToolsSrc).toContain("resolveIterationId(");
  });

  it("iteration filter discovers field name dynamically via getFieldNames + getIterations", () => {
    // The list_issues handler should discover the iteration field name from cache
    expect(issueToolsSrc).toContain("fieldCache.getFieldNames(projectNumber)");
    expect(issueToolsSrc).toContain("fieldCache.getIterations(name, projectNumber)");
  });

  it("response mapping includes iteration data", () => {
    expect(issueToolsSrc).toContain("iteration: iterVal");
  });

  it("tool description mentions iteration", () => {
    // list_issues tool description should mention iteration in returned fields
    const toolDesc = issueToolsSrc.slice(
      issueToolsSrc.indexOf("ralph_hero__list_issues"),
      issueToolsSrc.indexOf("ralph_hero__list_issues") + 2000,
    );
    expect(toolDesc).toContain("iteration");
  });
});

// ---------------------------------------------------------------------------
// Removed tools verification (GH-454)
// ---------------------------------------------------------------------------

describe("removed tools verification (GH-454)", () => {
  it("detect_pipeline_position tool registration is removed", () => {
    expect(issueToolsSrc).not.toContain("ralph_hero__detect_pipeline_position");
  });

  it("check_convergence tool registration is removed", () => {
    expect(issueToolsSrc).not.toContain("ralph_hero__check_convergence");
  });

  it("computeDistance helper is removed", () => {
    expect(issueToolsSrc).not.toContain("function computeDistance");
  });
});

// ---------------------------------------------------------------------------
// list_issues totalCount removal (GH-1129)
// ---------------------------------------------------------------------------

describe("list_issues totalCount removal (GH-1129)", () => {
  it("does not return the misleading totalCount field in the response", () => {
    // Regression guard: the list_issues toolSuccess call must not include
    // `totalCount: itemsResult.totalCount` — that value is the unfiltered
    // project board total and was confusing analysts. See GH-1129.
    expect(issueToolsSrc).not.toContain("totalCount: itemsResult.totalCount");
  });

  it("still returns filteredCount derived from formattedItems.length", () => {
    // Positive guard: filteredCount is the surviving count field and must
    // remain in the toolSuccess response so callers keep getting an accurate
    // post-filter count.
    expect(issueToolsSrc).toContain("filteredCount: formattedItems.length");
  });
});

// ---------------------------------------------------------------------------
// list_issues scan-until-exhausted pagination (GH-1172)
// ---------------------------------------------------------------------------

describe("list_issues scan-until-exhausted pagination (GH-1172)", () => {
  it("paginateConnection call uses scanUntilExhausted: true (no silent cap)", () => {
    // Regression guard for GH-1172: the project-items fetch must not pass
    // `{ maxItems: 500 }` because that silently truncates projects with > 500
    // items (see #1102 at position ~640 on project #3). The fix is to use the
    // new `scanUntilExhausted: true` option from GH-1171 so the full project
    // is scanned client-side before filters apply.
    expect(issueToolsSrc).toContain("scanUntilExhausted: true");
    expect(issueToolsSrc).not.toContain("maxItems: 500");
  });

  it("tool description documents the full-project-scan behavior", () => {
    // The list_issues tool description (the second arg to server.tool) must
    // make the post-fix fetch semantics explicit so LLM consumers understand
    // that filters apply across the entire project, not the first 500 items.
    const toolBlock = issueToolsSrc.slice(
      issueToolsSrc.indexOf('"ralph_hero__list_issues"'),
      issueToolsSrc.indexOf('"ralph_hero__list_issues"') + 800,
    );
    expect(toolBlock).toMatch(/full project scan|all project items/i);
  });
});

// ---------------------------------------------------------------------------
// list_issues state default removal (GH-1169)
//
// Before GH-1169, `state` had `.default("OPEN")` in the Zod schema, so
// callers that did not pass `state` were silently restricted to OPEN issues.
// This diverged from the dashboard family (pipeline_dashboard, next_actions,
// project_hygiene, capture_snapshot), which has no equivalent state filter
// — closed issues with non-terminal workflow states appeared in dashboards
// but were invisible to list_issues.
//
// The fix is to drop the Zod default so `state` is genuinely optional. The
// existing `if (args.state)` guard at the filter site already does the right
// thing when `state` is undefined (skip the filter entirely). These runtime
// tests pin the new behavior end-to-end through the registered handler.
// ---------------------------------------------------------------------------

interface RawIssueFixture {
  number: number;
  title: string;
  workflowState?: string | null;
  state?: string;
}

/** Build a node.items.nodes[] entry shaped like the list_issues GraphQL response. */
function rawIssueForStateTest(fix: RawIssueFixture): unknown {
  const fieldValues: Array<Record<string, unknown>> = [];
  if (fix.workflowState !== undefined && fix.workflowState !== null) {
    fieldValues.push({
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      name: fix.workflowState,
      field: { name: "Workflow State" },
    });
  }

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
      createdAt: "2026-05-01T00:00:00Z",
      updatedAt: "2026-05-12T00:00:00Z",
      closedAt: fix.state === "CLOSED" ? "2026-05-11T00:00:00Z" : null,
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

function itemsResponseForStateTest(nodes: unknown[]): unknown {
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

function fieldCacheResponseForStateTest(projectId = "project-id-3"): unknown {
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
                { id: "opt-ip", name: "In Progress" },
                { id: "opt-done", name: "Done" },
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

function isItemsQuery(q: string): boolean {
  return q.includes("node(id: $projectId)") && q.includes("items(first:");
}

function createMockClientForStateTest(fixture: unknown[]): GitHubClient {
  const fullConfig: GitHubClientConfig = {
    token: "tok",
    owner: "test-owner",
    repo: "test-repo",
    projectNumber: 3,
    projectOwner: "test-owner",
  };

  const projectQuery = vi.fn(async (q: string, vars: Record<string, unknown>) => {
    if (isFieldCacheQuery(q)) {
      return fieldCacheResponseForStateTest(`project-id-${vars.number}`);
    }
    if (isItemsQuery(q)) {
      return itemsResponseForStateTest(fixture);
    }
    throw new Error(`Unmocked projectQuery: ${q.slice(0, 80)}`);
  });

  const query = vi.fn(async (q: string) => {
    throw new Error(`Unmocked query: ${q.slice(0, 80)}`);
  });

  return {
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
}

interface HandlerResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface RegisteredTool {
  handler: (args: unknown, extra: unknown) => Promise<HandlerResult>;
}

function getListIssuesHandler(server: McpServer): RegisteredTool {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = tools?.["ralph_hero__list_issues"];
  if (!tool) throw new Error("ralph_hero__list_issues not registered");
  return tool;
}

function parsePayload(result: HandlerResult): unknown {
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0].text);
}

describe("list_issues state arg behavior (GH-1169)", () => {
  let server: McpServer;
  let fieldCache: FieldOptionCache;

  // Two-item fixture: one OPEN + one CLOSED, both with the same non-terminal
  // workflow state ("Plan in Review"). This mirrors the exact divergence the
  // research doc identified — sync-pr-merge.yml advancing workflow state to
  // a non-terminal value without closing the GitHub issue. With the OPEN
  // default removed, both items must surface to a no-state-arg caller.
  const fixture = [
    rawIssueForStateTest({
      number: 5001,
      title: "5001 OPEN Plan in Review",
      workflowState: "Plan in Review",
      state: "OPEN",
    }),
    rawIssueForStateTest({
      number: 5002,
      title: "5002 CLOSED Plan in Review",
      workflowState: "Plan in Review",
      state: "CLOSED",
    }),
  ];

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    fieldCache = new FieldOptionCache();
  });

  it("list_issues with no state arg returns both OPEN and CLOSED issues", async () => {
    const client = createMockClientForStateTest(fixture);
    registerIssueTools(server, client, fieldCache);
    const handler = getListIssuesHandler(server);

    // No `state` arg — relies on the new default (undefined = no state filter).
    const result = await handler.handler(
      { workflowState: "Plan in Review", limit: 50, orderBy: "CREATED_AT" },
      {},
    );

    const payload = parsePayload(result) as {
      filteredCount: number;
      items: Array<{ number: number; state: string }>;
    };
    const numbers = payload.items.map((i) => i.number).sort();
    expect(
      numbers,
      "no-state-arg call should return BOTH the OPEN and the CLOSED issue",
    ).toEqual([5001, 5002]);
    expect(payload.filteredCount, "filteredCount matches items.length").toBe(2);
  });

  it("list_issues with state=OPEN still excludes CLOSED issues", async () => {
    const client = createMockClientForStateTest(fixture);
    registerIssueTools(server, client, fieldCache);
    const handler = getListIssuesHandler(server);

    const result = await handler.handler(
      { state: "OPEN", workflowState: "Plan in Review", limit: 50, orderBy: "CREATED_AT" },
      {},
    );

    const payload = parsePayload(result) as {
      filteredCount: number;
      items: Array<{ number: number; state: string }>;
    };
    const numbers = payload.items.map((i) => i.number);
    expect(
      numbers,
      "explicit state=OPEN preserves pre-GH-1169 narrowing behavior",
    ).toEqual([5001]);
    expect(payload.items[0].state).toBe("OPEN");
  });

  it("list_issues with state=CLOSED still excludes OPEN issues", async () => {
    const client = createMockClientForStateTest(fixture);
    registerIssueTools(server, client, fieldCache);
    const handler = getListIssuesHandler(server);

    const result = await handler.handler(
      { state: "CLOSED", workflowState: "Plan in Review", limit: 50, orderBy: "CREATED_AT" },
      {},
    );

    const payload = parsePayload(result) as {
      filteredCount: number;
      items: Array<{ number: number; state: string }>;
    };
    const numbers = payload.items.map((i) => i.number);
    expect(
      numbers,
      "explicit state=CLOSED returns only the closed issue",
    ).toEqual([5002]);
    expect(payload.items[0].state).toBe("CLOSED");
  });
});

// ---------------------------------------------------------------------------
// get_issue blocking/blockedBy native-dependency regression (GH-1591 Phase 6)
//
// get_issue used to map `blocking`/`blockedBy` from the legacy task-list
// `trackedInIssues`/`trackedIssues` connections instead of the native
// dependency connections `add_dependency`'s `addBlockedBy` mutation writes
// (same defect class GH-1470 fixed in dashboard-fetch.ts — see
// dashboard-fetch.test.ts:127,145 for the analogous regression shape). The
// fixtures below deliberately populate BOTH the native `blockedBy`/`blocking`
// connections AND the legacy `trackedIssues`/`trackedInIssues` connections
// with DIFFERENT node sets, so a reversion to the legacy field is caught by
// value (wrong numbers in the output), not just by the field's presence.
// ---------------------------------------------------------------------------

interface RawDependencyNode {
  number: number;
  title: string;
  state: string;
}

interface GetIssueFixtureOptions {
  blocking?: RawDependencyNode[];
  blockedBy?: RawDependencyNode[];
  trackedIssues?: RawDependencyNode[];
  trackedInIssues?: RawDependencyNode[];
}

function buildGetIssueQueryResponse(opts: GetIssueFixtureOptions): unknown {
  return {
    repository: {
      issue: {
        id: "issue-node-1615",
        number: 1615,
        title: "Fix get_issue dependency read",
        body: "",
        state: "OPEN",
        stateReason: null,
        url: "https://github.com/test-owner/test-repo/issues/1615",
        createdAt: "2026-07-26T00:00:00Z",
        updatedAt: "2026-07-26T00:00:00Z",
        closedAt: null,
        labels: { nodes: [] },
        assignees: { nodes: [] },
        parent: null,
        subIssuesSummary: null,
        subIssues: { nodes: [] },
        // Native dependency connections (what add_dependency writes and
        // relationship-tools.ts:536-547 already reads correctly).
        blocking: { nodes: opts.blocking ?? [] },
        blockedBy: { nodes: opts.blockedBy ?? [] },
        // Legacy task-list connections. A real GitHub response for the FIXED
        // query wouldn't include these (they're no longer requested), but
        // the mock includes them anyway to prove the response mapping reads
        // from `blocking`/`blockedBy` and ignores these entirely.
        trackedIssues: { nodes: opts.trackedIssues ?? [] },
        trackedInIssues: { nodes: opts.trackedInIssues ?? [] },
        comments: { nodes: [] },
        projectItems: { nodes: [] },
      },
    },
  };
}

function createMockClientForGetIssueTest(
  queryResponse: unknown,
): GitHubClient {
  const fullConfig: GitHubClientConfig = {
    token: "tok",
    owner: "test-owner",
    repo: "test-repo",
    projectNumber: 3,
    projectOwner: "test-owner",
  };

  // Single-call scope: with includeGroup:false and includePipeline:false,
  // get_issue's handler makes exactly one client.query call (the issue
  // fetch). Deliberately unconditional (not gated on the query text
  // containing "blocking(first:") so this harness isolates the
  // RESPONSE-MAPPING regression (does the handler map from the right field
  // in the response object?) from the query-text regression — both matter,
  // but the mapping bug is the one this test guards.
  const query = vi.fn(async () => queryResponse);

  return {
    config: fullConfig,
    query,
    projectQuery: vi.fn(async () => {
      throw new Error("get_issue with includeGroup:false should not call projectQuery");
    }),
    projectMutate: vi.fn(),
    mutate: vi.fn(),
    getCache: vi.fn(() => ({
      get: vi.fn(),
      set: vi.fn(),
      invalidate: vi.fn(),
      invalidateQueries: vi.fn(),
    })),
    getAuthenticatedUser: vi.fn(),
  } as unknown as GitHubClient;
}

function getGetIssueHandler(server: McpServer): RegisteredTool {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = tools?.["ralph_hero__get_issue"];
  if (!tool) throw new Error("ralph_hero__get_issue not registered");
  return tool;
}

describe("get_issue blocking/blockedBy reads native dependency connections (GH-1591 Phase 6)", () => {
  let server: McpServer;
  let fieldCache: FieldOptionCache;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    fieldCache = new FieldOptionCache();
  });

  it("native blockedBy/blocking edges populate the output", async () => {
    const client = createMockClientForGetIssueTest(
      buildGetIssueQueryResponse({
        blockedBy: [{ number: 1614, title: "Prereq", state: "OPEN" }],
        blocking: [{ number: 1616, title: "Downstream", state: "OPEN" }],
        // A legacy task-list reference to a DIFFERENT, unrelated issue.
        // If the implementation regresses to reading trackedIssues, this
        // value (9999) would leak into blockedBy instead of 1614.
        trackedIssues: [{ number: 9999, title: "Unrelated task-list ref", state: "OPEN" }],
      }),
    );
    registerIssueTools(server, client, fieldCache);
    const handler = getGetIssueHandler(server);

    const result = await handler.handler(
      {
        owner: "test-owner",
        repo: "test-repo",
        number: 1615,
        includeGroup: false,
        includePipeline: false,
      },
      {},
    );

    const payload = parsePayload(result) as {
      blocking: Array<{ number: number }>;
      blockedBy: Array<{ number: number }>;
    };

    expect(
      payload.blockedBy.map((b) => b.number),
      "blockedBy must come from the native dependency connection (1614), not the legacy trackedIssues ref (9999)",
    ).toEqual([1614]);
    expect(payload.blocking.map((b) => b.number)).toEqual([1616]);
  });

  it("task-list trackedIssues/trackedInIssues data does NOT populate blocking/blockedBy", async () => {
    const client = createMockClientForGetIssueTest(
      buildGetIssueQueryResponse({
        // No native dependency edges at all.
        blockedBy: [],
        blocking: [],
        // Only legacy task-list references — this is the exact defect shape
        // reported live: an issue with task-list mentions but no real
        // dependency edge reported blockedBy from trackedIssues instead of
        // an empty array.
        trackedIssues: [{ number: 1614, title: "Task-list mention only", state: "OPEN" }],
        trackedInIssues: [{ number: 1616, title: "Task-list mention only", state: "OPEN" }],
      }),
    );
    registerIssueTools(server, client, fieldCache);
    const handler = getGetIssueHandler(server);

    const result = await handler.handler(
      {
        owner: "test-owner",
        repo: "test-repo",
        number: 1615,
        includeGroup: false,
        includePipeline: false,
      },
      {},
    );

    const payload = parsePayload(result) as {
      blocking: Array<{ number: number }>;
      blockedBy: Array<{ number: number }>;
    };

    expect(
      payload.blockedBy,
      "an issue with only task-list trackedIssues refs (no native dependency edge) must report blockedBy: []",
    ).toEqual([]);
    expect(payload.blocking).toEqual([]);
  });
});
