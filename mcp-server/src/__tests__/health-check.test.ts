/**
 * Tests for `detectOrphanRepoIssues` — the helper that powers the
 * `orphanRepoIssues` warning in the `health_check` MCP tool.
 *
 * The tool registration itself lives inline in `index.ts` and is wired to a
 * live MCP server, so unit tests target the pure helper directly with a
 * mocked `GitHubClient`. This keeps the tests fast and deterministic while
 * still asserting the field contract (count, repoOpen, boardItems, sample, note).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  detectOrphanRepoIssues,
  ORPHAN_REPO_ISSUES_NOTE,
  ORPHAN_SAMPLE_LIMIT,
} from "../lib/health.js";
import type { GitHubClient } from "../github-client.js";

/**
 * Build a mock GitHubClient with `query` and `projectQuery` stubbed to
 * return the supplied repo and board issue numbers.
 *
 * Notes:
 * - `query()` mock returns a single page (we never test pagination here).
 * - `projectQuery()` mock returns the items under `user.projectV2.items`
 *   so the helper's user-first lookup path resolves on the first try.
 */
function makeMockClient(opts: {
  repoOpenCount: number;
  repoOpenNumbers: number[];
  boardItemCount: number;
  boardIssueNumbers: number[];
}): GitHubClient {
  const queryMock = vi.fn().mockResolvedValue({
    repository: {
      issues: {
        totalCount: opts.repoOpenCount,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: opts.repoOpenNumbers.map((number) => ({ number })),
      },
    },
  });

  const projectQueryMock = vi.fn().mockResolvedValue({
    user: {
      projectV2: {
        items: {
          totalCount: opts.boardItemCount,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: opts.boardIssueNumbers.map((number) => ({
            type: "ISSUE",
            content: { __typename: "Issue", number },
          })),
        },
      },
    },
  });

  return {
    query: queryMock,
    projectQuery: projectQueryMock,
    mutate: vi.fn(),
    projectMutate: vi.fn(),
    getRateLimitStatus: vi.fn(),
    getCache: vi.fn(),
    getAuthenticatedUser: vi.fn(),
    restPost: vi.fn(),
    config: {
      token: "test",
      owner: "test-owner",
      repo: "test-repo",
      projectNumber: 1,
      projectOwner: "test-owner",
    },
  } as unknown as GitHubClient;
}

describe("detectOrphanRepoIssues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when every OPEN repo issue is on the board", async () => {
    const client = makeMockClient({
      repoOpenCount: 3,
      repoOpenNumbers: [10, 11, 12],
      boardItemCount: 3,
      boardIssueNumbers: [10, 11, 12],
    });

    const result = await detectOrphanRepoIssues(
      client,
      "test-owner",
      "test-repo",
      "test-owner",
      1,
    );

    // Clean board → null → caller omits the field entirely.
    expect(result).toBeNull();
  });

  it("returns orphan summary when repo has issues missing from the board", async () => {
    // 35 OPEN repo issues, only 4 on board — this is the today's-known-delta
    // case from the audit (31 orphans).
    const repoNumbers = Array.from({ length: 35 }, (_, i) => i + 1);
    const boardNumbers = [10, 11, 12, 13];

    const client = makeMockClient({
      repoOpenCount: 35,
      repoOpenNumbers: repoNumbers,
      boardItemCount: 4,
      boardIssueNumbers: boardNumbers,
    });

    const result = await detectOrphanRepoIssues(
      client,
      "test-owner",
      "test-repo",
      "test-owner",
      1,
    );

    expect(result).not.toBeNull();
    expect(result!.count).toBe(31);
    expect(result!.repoOpen).toBe(35);
    expect(result!.boardItems).toBe(4);
    // Sample is capped at ORPHAN_SAMPLE_LIMIT entries, sorted ascending.
    expect(result!.sample.length).toBe(ORPHAN_SAMPLE_LIMIT);
    expect(result!.sample).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 14]);
    expect(result!.note).toBe(ORPHAN_REPO_ISSUES_NOTE);
  });

  it("sample contains all orphans when fewer than the limit", async () => {
    const client = makeMockClient({
      repoOpenCount: 5,
      repoOpenNumbers: [1, 2, 3, 4, 5],
      boardItemCount: 3,
      boardIssueNumbers: [1, 2, 3],
    });

    const result = await detectOrphanRepoIssues(
      client,
      "test-owner",
      "test-repo",
      "test-owner",
      1,
    );

    expect(result).not.toBeNull();
    expect(result!.count).toBe(2);
    // Only 2 orphans → sample has 2 entries, NOT padded to ORPHAN_SAMPLE_LIMIT.
    expect(result!.sample).toEqual([4, 5]);
    expect(result!.sample.length).toBe(2);
  });

  it("ignores PRs and DraftIssues on the board", async () => {
    // Board contains an ISSUE, a PR, and a DraftIssue. Only the ISSUE
    // should count as overlap with the repo's OPEN issue set.
    const queryMock = vi.fn().mockResolvedValue({
      repository: {
        issues: {
          totalCount: 2,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ number: 100 }, { number: 200 }],
        },
      },
    });

    const projectQueryMock = vi.fn().mockResolvedValue({
      user: {
        projectV2: {
          items: {
            totalCount: 3,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              // The matching ISSUE — should overlap with repo issue 100.
              { type: "ISSUE", content: { __typename: "Issue", number: 100 } },
              // A PR on the board — must NOT count as repo-issue overlap.
              { type: "PULL_REQUEST", content: { __typename: "PullRequest", number: 200 } },
              // A draft issue — must NOT count.
              { type: "DRAFT_ISSUE", content: { __typename: "DraftIssue" } },
            ],
          },
        },
      },
    });

    const client = {
      query: queryMock,
      projectQuery: projectQueryMock,
      mutate: vi.fn(),
      projectMutate: vi.fn(),
      getRateLimitStatus: vi.fn(),
      getCache: vi.fn(),
      getAuthenticatedUser: vi.fn(),
      restPost: vi.fn(),
      config: {
        token: "test",
        owner: "test-owner",
        repo: "test-repo",
        projectNumber: 1,
        projectOwner: "test-owner",
      },
    } as unknown as GitHubClient;

    const result = await detectOrphanRepoIssues(
      client,
      "test-owner",
      "test-repo",
      "test-owner",
      1,
    );

    // Issue 100 IS on the board (as type=ISSUE). Issue 200 is only present
    // as a PR — it should still count as an orphan because the helper
    // operates on the OPEN-issue set, not the OPEN-issue-or-PR set.
    expect(result).not.toBeNull();
    expect(result!.count).toBe(1);
    expect(result!.sample).toEqual([200]);
  });

  it("falls back to organization owner when user lookup returns null", async () => {
    // Simulate a project owned by an org: the user(login) call returns null
    // (or its projectV2 is null), and the helper should retry as organization.
    let callCount = 0;
    const projectQueryMock = vi.fn().mockImplementation(async () => {
      callCount += 1;
      // First call: user(login) returns no project → triggers org fallback.
      if (callCount === 1) {
        return { user: null };
      }
      // Second call: organization(login) returns the project.
      return {
        organization: {
          projectV2: {
            items: {
              totalCount: 2,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { type: "ISSUE", content: { __typename: "Issue", number: 1 } },
                { type: "ISSUE", content: { __typename: "Issue", number: 2 } },
              ],
            },
          },
        },
      };
    });

    const queryMock = vi.fn().mockResolvedValue({
      repository: {
        issues: {
          totalCount: 3,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ number: 1 }, { number: 2 }, { number: 3 }],
        },
      },
    });

    const client = {
      query: queryMock,
      projectQuery: projectQueryMock,
      mutate: vi.fn(),
      projectMutate: vi.fn(),
      getRateLimitStatus: vi.fn(),
      getCache: vi.fn(),
      getAuthenticatedUser: vi.fn(),
      restPost: vi.fn(),
      config: {
        token: "test",
        owner: "test-owner",
        repo: "test-repo",
        projectNumber: 1,
        projectOwner: "test-org",
      },
    } as unknown as GitHubClient;

    const result = await detectOrphanRepoIssues(
      client,
      "test-owner",
      "test-repo",
      "test-org",
      1,
    );

    // Issue 3 is the orphan — repo has it, board has only 1 and 2.
    expect(result).not.toBeNull();
    expect(result!.count).toBe(1);
    expect(result!.sample).toEqual([3]);
    // Both user and org calls were attempted on the first page.
    expect(projectQueryMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("note text is the canonical exported constant", async () => {
    // Asserting the exact prose ensures downstream consumers (logs, UI)
    // can pattern-match against ORPHAN_REPO_ISSUES_NOTE without drift.
    expect(ORPHAN_REPO_ISSUES_NOTE).toContain("not on the project board");
    expect(ORPHAN_REPO_ISSUES_NOTE).toContain("next_actions");
    expect(ORPHAN_REPO_ISSUES_NOTE).toContain("list_issues");
    expect(ORPHAN_REPO_ISSUES_NOTE).toContain("pipeline_dashboard");
    expect(ORPHAN_REPO_ISSUES_NOTE).toContain("project_hygiene");
  });
});
