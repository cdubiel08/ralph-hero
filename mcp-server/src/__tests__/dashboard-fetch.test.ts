/**
 * Direct unit tests for `lib/dashboard-fetch.ts`.
 *
 * Splits coverage into:
 *   1. `toDashboardItems` — pure-function tests, no mocks.
 *   2. `fetchDashboardItems` — mock `client.projectQuery` via vi.fn();
 *      pre-populate `FieldOptionCache` to short-circuit `ensureFieldCache`,
 *      and `vi.mock` the helpers module to inject the failure path for the
 *      `ensureFieldCache rejects` case.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock must be hoisted before module import. We provide a controllable
// `ensureFieldCache` so a single test can force it to reject for one project.
const ensureFieldCacheMock = vi.fn(async () => {
  /* default: succeed (no-op) */
});
vi.mock("../lib/helpers.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/helpers.js")>(
    "../lib/helpers.js",
  );
  return {
    ...actual,
    ensureFieldCache: (...args: any[]) => ensureFieldCacheMock(...args),
  };
});

import {
  toDashboardItems,
  fetchDashboardItems,
  type RawDashboardItem,
} from "../lib/dashboard-fetch.js";
import { FieldOptionCache } from "../lib/cache.js";
import type { GitHubClient } from "../github-client.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeRawIssue(overrides: Partial<RawDashboardItem["content"]> = {}, fieldValues: any[] = []): RawDashboardItem {
  return {
    id: "PVTI_1",
    type: "ISSUE",
    content: {
      __typename: "Issue",
      number: 1,
      title: "Test issue",
      state: "OPEN",
      updatedAt: "2026-05-01T00:00:00Z",
      closedAt: null,
      assignees: { nodes: [] },
      trackedInIssues: { nodes: [] },
      trackedIssues: { nodes: [] },
      repository: { nameWithOwner: "octo/demo", name: "demo" },
      subIssues: { totalCount: 0 },
      ...overrides,
    },
    fieldValues: { nodes: fieldValues },
  };
}

// ---------------------------------------------------------------------------
// toDashboardItems — pure
// ---------------------------------------------------------------------------

describe("toDashboardItems", () => {
  it("filters out non-Issue content (PRs and DraftIssues are dropped)", () => {
    const raw: RawDashboardItem[] = [
      makeRawIssue(),
      {
        id: "PVTI_2",
        type: "PULL_REQUEST",
        content: { __typename: "PullRequest", number: 2, title: "PR" },
        fieldValues: { nodes: [] },
      } as any,
      {
        id: "PVTI_3",
        type: "DRAFT_ISSUE",
        content: { __typename: "DraftIssue", title: "Draft" },
        fieldValues: { nodes: [] },
      } as any,
    ];

    const result = toDashboardItems(raw);
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });

  it("maps Workflow State / Priority / Estimate single-select fields onto items", () => {
    const raw = [
      makeRawIssue({}, [
        {
          __typename: "ProjectV2ItemFieldSingleSelectValue",
          name: "In Progress",
          field: { name: "Workflow State" },
        },
        {
          __typename: "ProjectV2ItemFieldSingleSelectValue",
          name: "P1",
          field: { name: "Priority" },
        },
        {
          __typename: "ProjectV2ItemFieldSingleSelectValue",
          name: "S",
          field: { name: "Estimate" },
        },
      ]),
    ];
    const [item] = toDashboardItems(raw);
    expect(item.workflowState).toBe("In Progress");
    expect(item.priority).toBe("P1");
    expect(item.estimate).toBe("S");
  });

  it("populates workflowStateUpdatedAt from the Workflow State field value's own updatedAt (GH-1617)", () => {
    const raw = [
      makeRawIssue({ updatedAt: "2026-07-20T00:00:00Z" }, [
        {
          __typename: "ProjectV2ItemFieldSingleSelectValue",
          name: "In Progress",
          updatedAt: "2026-07-26T10:00:00Z",
          field: { name: "Workflow State" },
        },
        {
          __typename: "ProjectV2ItemFieldSingleSelectValue",
          name: "P1",
          updatedAt: "2026-01-01T00:00:00Z",
          field: { name: "Priority" },
        },
      ]),
    ];
    const [item] = toDashboardItems(raw);
    // Distinct from content updatedAt AND from the Priority field's updatedAt
    // — must be sourced specifically from the Workflow State field value.
    expect(item.workflowStateUpdatedAt).toBe("2026-07-26T10:00:00Z");
    expect(item.updatedAt).toBe("2026-07-20T00:00:00Z");
  });

  it("omits workflowStateUpdatedAt when the Workflow State field value carries no updatedAt", () => {
    const raw = [
      makeRawIssue({}, [
        {
          __typename: "ProjectV2ItemFieldSingleSelectValue",
          name: "In Progress",
          field: { name: "Workflow State" },
        },
      ]),
    ];
    const [item] = toDashboardItems(raw);
    expect(item.workflowStateUpdatedAt).toBeUndefined();
  });

  it("omits workflowStateUpdatedAt when there is no Workflow State value at all", () => {
    const raw = [makeRawIssue({}, [])];
    const [item] = toDashboardItems(raw);
    expect(item.workflowStateUpdatedAt).toBeUndefined();
  });

  it("flattens assignees to string[]", () => {
    const raw = [
      makeRawIssue({
        assignees: { nodes: [{ login: "alice" }, { login: "bob" }] },
      }),
    ];
    const [item] = toDashboardItems(raw);
    expect(item.assignees).toEqual(["alice", "bob"]);
  });

  it("maps blockedBy dependency connection -> blockedBy with workflowState=Done iff source state CLOSED", () => {
    // Uses the native GitHub blockedBy(first:N) dependency connection, not trackedIssues.
    const raw = [
      makeRawIssue({
        blockedBy: {
          nodes: [
            { number: 50, state: "CLOSED" },
            { number: 60, state: "OPEN" },
          ],
        },
      }),
    ];
    const [item] = toDashboardItems(raw);
    expect(item.blockedBy).toEqual([
      { number: 50, workflowState: "Done" },
      { number: 60, workflowState: null },
    ]);
  });

  it("trackedIssues (task-list) does NOT populate blockedBy — only the dependency connection does", () => {
    // An issue with trackedIssues but no blockedBy edges yields blockedBy=[].
    const raw = [
      makeRawIssue({
        trackedIssues: {
          nodes: [{ number: 70, state: "OPEN" }],
        },
        blockedBy: { nodes: [] },
      }),
    ];
    const [item] = toDashboardItems(raw);
    expect(item.blockedBy).toEqual([]);
  });

  it("sets parentNumber and parentState from trackedInIssues.nodes[0]", () => {
    const raw = [
      makeRawIssue({
        trackedInIssues: {
          nodes: [{ number: 99, state: "OPEN", closedAt: null }],
        },
      }),
    ];
    const [item] = toDashboardItems(raw);
    expect(item.parentNumber).toBe(99);
    expect(item.parentState).toBe("OPEN");
  });

  it("propagates projectNumber, projectTitle, repository, and iteration fields", () => {
    const raw = [
      makeRawIssue({}, [
        {
          __typename: "ProjectV2ItemFieldIterationValue",
          iterationId: "iter-1",
          title: "Sprint 1",
          startDate: "2026-05-01",
          duration: 14,
        },
      ]),
    ];
    const [item] = toDashboardItems(raw, 7, "Demo Project");
    expect(item.projectNumber).toBe(7);
    expect(item.projectTitle).toBe("Demo Project");
    expect(item.repository).toBe("octo/demo");
    expect(item.iterationId).toBe("iter-1");
    expect(item.iterationTitle).toBe("Sprint 1");
    expect(item.iterationStartDate).toBe("2026-05-01");
    expect(item.iterationDuration).toBe(14);
  });

  it("defaults title to '(untitled)' and updatedAt to epoch when missing", () => {
    const raw: RawDashboardItem[] = [
      {
        id: "PVTI_X",
        type: "ISSUE",
        content: {
          __typename: "Issue",
          number: 1,
          // title and updatedAt intentionally omitted
        } as any,
        fieldValues: { nodes: [] },
      },
    ];
    const [item] = toDashboardItems(raw);
    expect(item.title).toBe("(untitled)");
    expect(item.updatedAt).toBe(new Date(0).toISOString());
    expect(item.subIssueCount).toBe(0);
    expect(item.assignees).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchDashboardItems
// ---------------------------------------------------------------------------

/**
 * Build a mock GitHubClient where projectQuery is a vi.fn that we can
 * pre-program to return shaped responses for:
 *   - the project-title query (`node { title }`)
 *   - the DASHBOARD_ITEMS_QUERY (paginated items connection)
 */
function makeMockClient(opts: {
  owner?: string;
  projectNumber?: number;
  projectNumbers?: number[];
}): {
  client: GitHubClient;
  projectQuery: ReturnType<typeof vi.fn>;
} {
  const projectQuery = vi.fn();
  const client = {
    config: {
      token: "x",
      owner: opts.owner,
      repo: "demo",
      projectNumber: opts.projectNumber,
      projectNumbers: opts.projectNumbers,
    },
    projectQuery: (q: string, v: any) => projectQuery(q, v),
  } as unknown as GitHubClient;
  return { client, projectQuery };
}

const FIELDS_FIXTURE = [
  {
    id: "field-ws",
    name: "Workflow State",
    options: [{ id: "opt-1", name: "In Progress" }],
  },
];

beforeEach(() => {
  ensureFieldCacheMock.mockReset();
  ensureFieldCacheMock.mockImplementation(async () => {
    /* default: succeed */
  });
});

describe("fetchDashboardItems — error paths", () => {
  it("throws when no owner is resolvable", async () => {
    const { client } = makeMockClient({ projectNumber: 3 });
    const cache = new FieldOptionCache();
    await expect(fetchDashboardItems(client, cache)).rejects.toThrow(
      /owner is required/,
    );
  });

  it("throws when no project numbers are configured", async () => {
    const { client } = makeMockClient({ owner: "octo" });
    const cache = new FieldOptionCache();
    await expect(fetchDashboardItems(client, cache)).rejects.toThrow(
      /No project numbers configured/,
    );
  });
});

describe("fetchDashboardItems — explicit projectNumber arg", () => {
  it("uses the explicit arg over config and queries with the resolved projectId", async () => {
    const { client, projectQuery } = makeMockClient({
      owner: "octo",
      projectNumber: 99, // config
    });
    const cache = new FieldOptionCache();
    cache.populate(7, "PVT_proj_explicit", FIELDS_FIXTURE);

    // projectQuery is called for: (1) title fetch, (2) items pagination
    projectQuery.mockImplementation(async (q: string, vars: any) => {
      if (!q.includes("items(first:")) {
        return { node: { title: "Explicit Project" } };
      }
      // items query
      expect(vars.projectId).toBe("PVT_proj_explicit");
      return {
        node: {
          items: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "PVTI_E",
                type: "ISSUE",
                content: {
                  __typename: "Issue",
                  number: 42,
                  title: "From explicit",
                  state: "OPEN",
                  updatedAt: "2026-05-01T00:00:00Z",
                  closedAt: null,
                  assignees: { nodes: [] },
                  trackedInIssues: { nodes: [] },
                  trackedIssues: { nodes: [] },
                  repository: { nameWithOwner: "octo/demo", name: "demo" },
                  subIssues: { totalCount: 0 },
                },
                fieldValues: { nodes: [] },
              },
            ],
          },
        },
      };
    });

    const result = await fetchDashboardItems(client, cache, 7);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].number).toBe(42);
    expect(result.items[0].projectNumber).toBe(7);
    expect(result.items[0].projectTitle).toBe("Explicit Project");
    expect(result.warnings).toEqual([]);
  });
});

describe("fetchDashboardItems — multi-project fan-out", () => {
  it("fans out across config.projectNumbers and tags items per project", async () => {
    const { client, projectQuery } = makeMockClient({
      owner: "octo",
      projectNumbers: [3, 4],
    });
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_p3", FIELDS_FIXTURE);
    cache.populate(4, "PVT_p4", FIELDS_FIXTURE);

    projectQuery.mockImplementation(async (q: string, vars: any) => {
      if (!q.includes("items(first:")) {
        return { node: { title: vars.projectId === "PVT_p3" ? "P3" : "P4" } };
      }
      const num = vars.projectId === "PVT_p3" ? 100 : 200;
      return {
        node: {
          items: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: `PVTI_${num}`,
                type: "ISSUE",
                content: {
                  __typename: "Issue",
                  number: num,
                  title: `From project ${num}`,
                  state: "OPEN",
                  updatedAt: "2026-05-01T00:00:00Z",
                  closedAt: null,
                  assignees: { nodes: [] },
                  trackedInIssues: { nodes: [] },
                  trackedIssues: { nodes: [] },
                  repository: { nameWithOwner: "octo/demo", name: "demo" },
                  subIssues: { totalCount: 0 },
                },
                fieldValues: { nodes: [] },
              },
            ],
          },
        },
      };
    });

    const result = await fetchDashboardItems(client, cache);
    expect(result.items).toHaveLength(2);
    const byNum = new Map(result.items.map((i) => [i.number, i]));
    expect(byNum.get(100)?.projectNumber).toBe(3);
    expect(byNum.get(200)?.projectNumber).toBe(4);
    expect(byNum.get(100)?.projectTitle).toBe("P3");
    expect(byNum.get(200)?.projectTitle).toBe("P4");
  });
});

describe("fetchDashboardItems — partial failure", () => {
  it("records a warning and skips a project when ensureFieldCache rejects", async () => {
    const { client, projectQuery } = makeMockClient({
      owner: "octo",
      projectNumbers: [3, 4],
    });
    const cache = new FieldOptionCache();
    // Only project 4 is populated; project 3 will fail via ensureFieldCache mock
    cache.populate(4, "PVT_p4", FIELDS_FIXTURE);

    ensureFieldCacheMock.mockImplementation(
      async (_c: any, _f: any, _o: string, pn: number) => {
        if (pn === 3) throw new Error("boom");
      },
    );

    projectQuery.mockImplementation(async (q: string) => {
      if (!q.includes("items(first:")) return { node: { title: "P4" } };
      return {
        node: {
          items: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "PVTI_S",
                type: "ISSUE",
                content: {
                  __typename: "Issue",
                  number: 7,
                  title: "Survivor",
                  state: "OPEN",
                  updatedAt: "2026-05-01T00:00:00Z",
                  closedAt: null,
                  assignees: { nodes: [] },
                  trackedInIssues: { nodes: [] },
                  trackedIssues: { nodes: [] },
                  repository: { nameWithOwner: "octo/demo", name: "demo" },
                  subIssues: { totalCount: 0 },
                },
                fieldValues: { nodes: [] },
              },
            ],
          },
        },
      };
    });

    const result = await fetchDashboardItems(client, cache);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].number).toBe(7);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/Project #3.*boom.*skipping/);
  });

  it("warns and skips when fieldCache.getProjectId returns undefined", async () => {
    const { client, projectQuery } = makeMockClient({
      owner: "octo",
      projectNumbers: [9],
    });
    // ensureFieldCache succeeds (mocked default), but cache is empty
    const cache = new FieldOptionCache();

    const result = await fetchDashboardItems(client, cache);
    expect(result.items).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/Project #9.*could not resolve project ID.*skipping/);
    expect(projectQuery).not.toHaveBeenCalled();
  });

  it("project-title fetch failure is non-fatal", async () => {
    const { client, projectQuery } = makeMockClient({
      owner: "octo",
      projectNumber: 3,
    });
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_p3", FIELDS_FIXTURE);

    projectQuery.mockImplementation(async (q: string) => {
      if (!q.includes("items(first:")) {
        throw new Error("title fetch failed");
      }
      return {
        node: {
          items: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "PVTI_T",
                type: "ISSUE",
                content: {
                  __typename: "Issue",
                  number: 1,
                  title: "Untitled-project item",
                  state: "OPEN",
                  updatedAt: "2026-05-01T00:00:00Z",
                  closedAt: null,
                  assignees: { nodes: [] },
                  trackedInIssues: { nodes: [] },
                  trackedIssues: { nodes: [] },
                  repository: { nameWithOwner: "octo/demo", name: "demo" },
                  subIssues: { totalCount: 0 },
                },
                fieldValues: { nodes: [] },
              },
            ],
          },
        },
      };
    });

    const result = await fetchDashboardItems(client, cache);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].projectTitle).toBeUndefined();
  });
});

describe("fetchDashboardItems — pagination", () => {
  it("walks pages until hasNextPage=false", async () => {
    const { client, projectQuery } = makeMockClient({
      owner: "octo",
      projectNumber: 3,
    });
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_p3", FIELDS_FIXTURE);

    let page = 0;
    projectQuery.mockImplementation(async (q: string) => {
      if (!q.includes("items(first:")) return { node: { title: "P3" } };
      page += 1;
      const isLast = page === 2;
      return {
        node: {
          items: {
            totalCount: 2,
            pageInfo: { hasNextPage: !isLast, endCursor: isLast ? null : "cursor-1" },
            nodes: [
              {
                id: `PVTI_p${page}`,
                type: "ISSUE",
                content: {
                  __typename: "Issue",
                  number: page,
                  title: `Item ${page}`,
                  state: "OPEN",
                  updatedAt: "2026-05-01T00:00:00Z",
                  closedAt: null,
                  assignees: { nodes: [] },
                  trackedInIssues: { nodes: [] },
                  trackedIssues: { nodes: [] },
                  repository: { nameWithOwner: "octo/demo", name: "demo" },
                  subIssues: { totalCount: 0 },
                },
                fieldValues: { nodes: [] },
              },
            ],
          },
        },
      };
    });

    const result = await fetchDashboardItems(client, cache);
    expect(result.items.map((i) => i.number).sort()).toEqual([1, 2]);
    expect(page).toBe(2);
  });
});
