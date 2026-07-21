/**
 * Unit tests for `repo-issue-search.ts` (GH-1572 Phase 2).
 *
 * `buildRepoSearchQuery` is a pure function — tested directly against
 * representative filter combinations, asserting the exact qualifier string.
 * `searchRepoIssues` is tested with a stubbed `client.query` confirming the
 * GraphQL shape (search/type: ISSUE) and response mapping.
 */

import { describe, it, expect, vi } from "vitest";
import {
  buildRepoSearchQuery,
  searchRepoIssues,
} from "../lib/repo-issue-search.js";
import type { GitHubClient } from "../github-client.js";

describe("buildRepoSearchQuery", () => {
  it("always includes repo: and is:issue", () => {
    expect(buildRepoSearchQuery("acme", "widgets", {})).toBe(
      "repo:acme/widgets is:issue sort:created-desc",
    );
  });

  it("label-only", () => {
    expect(
      buildRepoSearchQuery("acme", "widgets", { label: "bug" }),
    ).toBe("repo:acme/widgets is:issue label:bug sort:created-desc");
  });

  it("quotes a label containing whitespace", () => {
    expect(
      buildRepoSearchQuery("acme", "widgets", { label: "user feedback" }),
    ).toBe(
      'repo:acme/widgets is:issue label:"user feedback" sort:created-desc',
    );
  });

  it("query + state maps to is:open plus in:title,body term", () => {
    expect(
      buildRepoSearchQuery("acme", "widgets", {
        query: "login bug",
        state: "OPEN",
      }),
    ).toBe(
      'repo:acme/widgets is:issue is:open sort:created-desc "login bug" in:title,body',
    );
  });

  it("state CLOSED maps to is:closed", () => {
    expect(
      buildRepoSearchQuery("acme", "widgets", { state: "CLOSED" }),
    ).toBe("repo:acme/widgets is:issue is:closed sort:created-desc");
  });

  it("reason maps completed / not_planned / reopened", () => {
    expect(
      buildRepoSearchQuery("acme", "widgets", { reason: "completed" }),
    ).toContain("reason:completed");
    expect(
      buildRepoSearchQuery("acme", "widgets", { reason: "not_planned" }),
    ).toContain('reason:"not planned"');
    expect(
      buildRepoSearchQuery("acme", "widgets", { reason: "reopened" }),
    ).toContain("reason:reopened");
  });

  it("updatedSince/updatedBefore map via parseDateMath to updated:>=/updated:<", () => {
    const q = buildRepoSearchQuery("acme", "widgets", {
      updatedSince: "2026-01-01",
      updatedBefore: "2026-02-01",
    });
    expect(q).toContain("updated:>=2026-01-01T00:00:00.000Z");
    expect(q).toContain("updated:<2026-02-01T00:00:00.000Z");
  });

  it("excludeLabels maps to -label: per entry", () => {
    const q = buildRepoSearchQuery("acme", "widgets", {
      excludeLabels: ["wontfix", "duplicate"],
    });
    expect(q).toContain("-label:wontfix");
    expect(q).toContain("-label:duplicate");
  });

  it("orderBy maps to sort:created-desc / sort:updated-desc / sort:comments-desc", () => {
    expect(
      buildRepoSearchQuery("acme", "widgets", { orderBy: "CREATED_AT" }),
    ).toContain("sort:created-desc");
    expect(
      buildRepoSearchQuery("acme", "widgets", { orderBy: "UPDATED_AT" }),
    ).toContain("sort:updated-desc");
    expect(
      buildRepoSearchQuery("acme", "widgets", { orderBy: "COMMENTS" }),
    ).toContain("sort:comments-desc");
  });
});

describe("searchRepoIssues", () => {
  function makeClient(queryImpl: GitHubClient["query"]): GitHubClient {
    return {
      config: { token: "tok", owner: "acme", repo: "widgets" },
      query: queryImpl,
      projectQuery: vi.fn(async () => {
        throw new Error("Unexpected projectQuery call");
      }),
      mutate: vi.fn(async () => {
        throw new Error("Unexpected mutate call");
      }),
      projectMutate: vi.fn(async () => {
        throw new Error("Unexpected projectMutate call");
      }),
      getRateLimitStatus: () => ({
        remaining: 5000,
        resetAt: new Date(),
        isLow: false,
        isCritical: false,
      }),
      getCache: () => ({
        get: () => undefined,
        set: vi.fn(),
        invalidateQueries: vi.fn(),
      }),
      getAuthenticatedUser: vi.fn(async () => "test-user"),
      restPost: vi.fn(async () => {
        throw new Error("Unexpected restPost call");
      }),
    } as unknown as GitHubClient;
  }

  const SEARCH_NODE = {
    number: 42,
    title: "Something broke",
    state: "OPEN",
    stateReason: null,
    url: "https://github.com/acme/widgets/issues/42",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    labels: { nodes: [{ name: "bug" }] },
    assignees: { nodes: [] },
    repository: { name: "widgets", nameWithOwner: "acme/widgets" },
  };

  it("issues a search(type: ISSUE) GraphQL query via client.query, not projectQuery", async () => {
    const queryFn = vi.fn(async (queryString: string) => {
      expect(queryString).toContain("search(query: $q, type: ISSUE");
      return { search: { nodes: [SEARCH_NODE] } };
    });
    const client = makeClient(queryFn);

    const result = await searchRepoIssues(
      client,
      "acme",
      "widgets",
      { label: "bug" },
      10,
    );

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual([SEARCH_NODE]);
  });

  it("returns an empty array when search.nodes is absent", async () => {
    const client = makeClient(vi.fn(async () => ({ search: {} })));
    const result = await searchRepoIssues(client, "acme", "widgets", {}, 10);
    expect(result).toEqual([]);
  });

  it("re-throws on search failure (not best-effort — caller must surface a toolError)", async () => {
    const client = makeClient(
      vi.fn(async () => {
        throw new Error("rate limited");
      }),
    );
    await expect(
      searchRepoIssues(client, "acme", "widgets", {}, 10),
    ).rejects.toThrow("rate limited");
  });
});
