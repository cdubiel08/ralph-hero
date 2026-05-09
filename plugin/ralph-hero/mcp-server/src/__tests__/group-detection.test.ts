/**
 * Direct unit tests for `lib/group-detection.ts`.
 *
 * Covers the public `detectGroup()` entry point. Mocks `GitHubClient.query`
 * with shaped GraphQL responses — no real network. Each test scopes its mock
 * inline so fixtures don't leak between cases.
 */

import { describe, it, expect, vi } from "vitest";
import { detectGroup } from "../lib/group-detection.js";
import type { GitHubClient } from "../github-client.js";

// ---------------------------------------------------------------------------
// Fixture builders for the SEED_QUERY / EXPAND_QUERY response shape
// ---------------------------------------------------------------------------

interface SeedNodeFixture {
  id: string;
  number: number;
  title: string;
  state: string;
  blocking?: Array<{ number: number; repository?: { owner: { login: string }; name: string } }>;
  blockedBy?: Array<{ number: number; repository?: { owner: { login: string }; name: string } }>;
}

interface DepFixture {
  id: string;
  number: number;
  title: string;
  state: string;
  repository?: { owner: { login: string }; name: string };
}

interface IssueFixture {
  id: string;
  number: number;
  title: string;
  state: string;
  parent?: {
    id: string;
    number: number;
    title: string;
    state: string;
    subIssues: SeedNodeFixture[];
  } | null;
  subIssues?: SeedNodeFixture[];
  blocking?: DepFixture[];
  blockedBy?: DepFixture[];
}

function shapeIssue(f: IssueFixture) {
  return {
    id: f.id,
    number: f.number,
    title: f.title,
    state: f.state,
    parent: f.parent
      ? {
          ...f.parent,
          subIssues: {
            nodes: f.parent.subIssues.map((s) => ({
              ...s,
              blocking: { nodes: s.blocking ?? [] },
              blockedBy: { nodes: s.blockedBy ?? [] },
            })),
          },
        }
      : null,
    subIssues: {
      nodes: (f.subIssues ?? []).map((s) => ({
        ...s,
        blocking: { nodes: s.blocking ?? [] },
        blockedBy: { nodes: s.blockedBy ?? [] },
      })),
    },
    blocking: { nodes: f.blocking ?? [] },
    blockedBy: { nodes: f.blockedBy ?? [] },
  };
}

/**
 * Build a mock GitHubClient.query that looks up `IssueFixture` by issue
 * number. Returns `null` for unknown numbers (simulating a deleted issue).
 */
function makeClient(fixtures: IssueFixture[]): GitHubClient {
  const byNumber = new Map(fixtures.map((f) => [f.number, f]));
  const queryFn = vi.fn(async (_q: string, vars: any) => {
    const fixture = byNumber.get(vars.number);
    if (!fixture) {
      return { repository: { issue: null } };
    }
    return { repository: { issue: shapeIssue(fixture) } };
  });
  return {
    query: queryFn,
    config: { token: "x", owner: "octo", repo: "demo" },
  } as unknown as GitHubClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("detectGroup — standalone issue", () => {
  it("returns isGroup=false with single ticket when no relationships exist", async () => {
    const client = makeClient([
      { id: "I_1", number: 1, title: "Solo", state: "OPEN" },
    ]);

    const result = await detectGroup(client, "octo", "demo", 1);

    expect(result.isGroup).toBe(false);
    expect(result.totalTickets).toBe(1);
    expect(result.groupTickets).toHaveLength(1);
    expect(result.groupTickets[0].number).toBe(1);
    expect(result.groupPrimary.number).toBe(1);
  });
});

describe("detectGroup — parent + sub-issues", () => {
  it("returns the sibling group when called on the parent number", async () => {
    const parentSubs: SeedNodeFixture[] = [
      { id: "I_11", number: 11, title: "Child A", state: "OPEN" },
      { id: "I_12", number: 12, title: "Child B", state: "OPEN" },
      { id: "I_13", number: 13, title: "Child C", state: "OPEN" },
    ];
    const client = makeClient([
      {
        id: "I_10",
        number: 10,
        title: "Epic",
        state: "OPEN",
        subIssues: parentSubs,
      },
    ]);

    const result = await detectGroup(client, "octo", "demo", 10);

    // Parent seed with subIssueNumbers populated => group is the children
    expect(result.totalTickets).toBe(3);
    expect(result.groupTickets.map((g) => g.number).sort()).toEqual([11, 12, 13]);
    expect(result.isGroup).toBe(true);
  });

  it("returns the same group when called on a child number, with primary set to first child by topo order", async () => {
    const parentSubs: SeedNodeFixture[] = [
      { id: "I_11", number: 11, title: "Child A", state: "OPEN" },
      { id: "I_12", number: 12, title: "Child B", state: "OPEN" },
      { id: "I_13", number: 13, title: "Child C", state: "OPEN" },
    ];
    const client = makeClient([
      {
        id: "I_11",
        number: 11,
        title: "Child A",
        state: "OPEN",
        parent: {
          id: "I_10",
          number: 10,
          title: "Epic",
          state: "OPEN",
          subIssues: parentSubs,
        },
      },
    ]);

    const result = await detectGroup(client, "octo", "demo", 11);

    expect(result.totalTickets).toBe(3);
    expect(result.groupTickets.map((g) => g.number).sort()).toEqual([11, 12, 13]);
    // Topo sort breaks ties by issue number ascending => primary is #11
    expect(result.groupPrimary.number).toBe(11);
  });
});

describe("detectGroup — blockedBy chain within a sibling group", () => {
  it("topologically orders siblings by blockedBy", async () => {
    // Parent #100 with sub-issues 10, 20, 30 where 10 blocks 20 blocks 30.
    // Seed on any sub-issue should yield the whole sibling group ordered topologically.
    const parentSubs: SeedNodeFixture[] = [
      {
        id: "I_10",
        number: 10,
        title: "C",
        state: "OPEN",
        blocking: [{ number: 20 }],
      },
      {
        id: "I_20",
        number: 20,
        title: "B",
        state: "OPEN",
        blocking: [{ number: 30 }],
        blockedBy: [{ number: 10 }],
      },
      {
        id: "I_30",
        number: 30,
        title: "A",
        state: "OPEN",
        blockedBy: [{ number: 20 }],
      },
    ];
    const client = makeClient([
      {
        id: "I_20",
        number: 20,
        title: "B",
        state: "OPEN",
        parent: {
          id: "I_100",
          number: 100,
          title: "Epic",
          state: "OPEN",
          subIssues: parentSubs,
        },
      },
    ]);

    const result = await detectGroup(client, "octo", "demo", 20);

    expect(result.totalTickets).toBe(3);
    const numbers = result.groupTickets.map((g) => g.number);
    // Topo: C(10) -> B(20) -> A(30)
    expect(numbers).toEqual([10, 20, 30]);
    // Order field is sequential 1..N
    expect(result.groupTickets.map((g) => g.order)).toEqual([1, 2, 3]);
    // Primary is the unblocked node
    expect(result.groupPrimary.number).toBe(10);
  });
});

describe("detectGroup — cross-repo dependency", () => {
  it("tags a cross-repo dependency with the repository field", async () => {
    // Seed in octo/demo blocked by an issue in other-org/other-repo.
    const client = makeClient([
      {
        id: "I_100",
        number: 100,
        title: "Local",
        state: "OPEN",
        blockedBy: [
          {
            id: "I_99",
            number: 99,
            title: "Cross",
            state: "OPEN",
            repository: { owner: { login: "other-org" }, name: "other-repo" },
          },
        ],
      },
      // Cross-repo target — same number 99 in the lookup map
      { id: "I_99", number: 99, title: "Cross", state: "OPEN" },
    ]);

    const result = await detectGroup(client, "octo", "demo", 100);

    expect(result.totalTickets).toBe(2);
    const cross = result.groupTickets.find((g) => g.number === 99);
    expect(cross).toBeDefined();
    expect(cross!.repository).toBe("other-org/other-repo");
    // Local issue should NOT have a repository field
    const local = result.groupTickets.find((g) => g.number === 100);
    expect(local!.repository).toBeUndefined();
  });
});

describe("detectGroup — error path", () => {
  it("throws when the seed issue is not found", async () => {
    const client = makeClient([]); // no fixtures => null

    await expect(detectGroup(client, "octo", "demo", 404)).rejects.toThrow(
      /Issue #404 not found/,
    );
  });
});

describe("detectGroup — expand transitively via dependencies", () => {
  it("expands a dependency target not present in the seed graph", async () => {
    // Seed #50 has subIssues [51, 52]. Sub-issue 51 is blockedBy #99 (not yet
    // in the map). The expand loop must fetch #99.
    const client = makeClient([
      {
        id: "I_50",
        number: 50,
        title: "Parent50",
        state: "OPEN",
        subIssues: [
          {
            id: "I_51",
            number: 51,
            title: "Sub51",
            state: "OPEN",
            blockedBy: [{ number: 99 }],
          },
          { id: "I_52", number: 52, title: "Sub52", state: "OPEN" },
        ],
      },
      // 99 returned only via expand fetch
      { id: "I_99", number: 99, title: "Far", state: "OPEN" },
    ]);

    const result = await detectGroup(client, "octo", "demo", 50);
    // Group members are sub-issues 51, 52 + transitively 99 (joins via dep)
    const numbers = result.groupTickets.map((g) => g.number).sort();
    expect(numbers).toContain(51);
    expect(numbers).toContain(52);
    expect(numbers).toContain(99);
  });

  it("gracefully skips a dependency target that the API returns null for", async () => {
    // Seed has a blockedBy dep #777 that does not resolve when expanded.
    // (Note: direct deps are still added to the map from the seed payload
    //  even if EXPAND fails. Test that the algorithm completes without
    //  throwing on the missing expansion.)
    const client = makeClient([
      {
        id: "I_60",
        number: 60,
        title: "Seed",
        state: "OPEN",
        subIssues: [
          {
            id: "I_61",
            number: 61,
            title: "Sub",
            state: "OPEN",
            blockedBy: [{ number: 777 }],
          },
        ],
      },
      // 777 intentionally absent from fixtures => makeClient returns null
    ]);

    const result = await detectGroup(client, "octo", "demo", 60);
    // Algorithm must not throw, and produces a coherent result with the
    // sub-issues it could resolve.
    expect(result.totalTickets).toBeGreaterThanOrEqual(1);
  });
});
