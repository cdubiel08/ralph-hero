/**
 * Health-check helpers — pure functions that probe the GitHub API for
 * configuration drift between the project board and its underlying repo.
 *
 * `detectOrphanRepoIssues` compares the set of OPEN issues in the configured
 * repo against the set of `type=ISSUE` items on the configured project
 * board. Issues present in the repo but not on the board are "orphans" —
 * they exist but are structurally invisible to the discovery tools
 * (`next_actions`, `list_issues`, `pipeline_dashboard`, `project_hygiene`),
 * which all read from the project board.
 *
 * Surfaced via `health_check` so users discover the mismatch without having
 * to grep `gh issue list` against the board contents by hand.
 */

import type { GitHubClient } from "../github-client.js";

/**
 * Maximum number of orphan issue numbers to include in the response sample.
 * The sample is for diagnostic display only; the full set is summarized via `count`.
 */
export const ORPHAN_SAMPLE_LIMIT = 10;

/**
 * Page size used when paginating repo issues and project items.
 *
 * GitHub GraphQL caps `first:` at 100. Most projects fit comfortably in a
 * handful of pages — pagination is implemented for correctness, not because
 * every call hits it.
 */
const PAGE_SIZE = 100;

/**
 * Hard cap on pages walked when enumerating repo issues or project items.
 * Defensive: prevents a runaway loop on a misconfigured giant repo.
 */
const MAX_PAGES = 20;

/**
 * Result shape for `detectOrphanRepoIssues`.
 *
 * - `count`: number of OPEN repo issues that are NOT on the project board.
 * - `repoOpen`: total count of OPEN issues in the repo (for context).
 * - `boardItems`: count of `type=ISSUE` items on the project board.
 * - `sample`: up to `ORPHAN_SAMPLE_LIMIT` orphan issue numbers, sorted ascending.
 * - `note`: human-readable guidance shown to the user.
 *
 * When `count === 0`, the helper returns `null` instead of this shape so
 * callers can omit the field entirely from the `health_check` response.
 */
export interface OrphanRepoIssuesResult {
  count: number;
  repoOpen: number;
  boardItems: number;
  sample: number[];
  note: string;
}

/**
 * Standard explanatory note attached to the orphan-repo-issues warning.
 * Lifted to a constant so tests can assert against a single canonical string.
 */
export const ORPHAN_REPO_ISSUES_NOTE =
  "Issues exist in the repo that are not on the project board. They are " +
  "invisible to discovery tools (next_actions, list_issues, pipeline_dashboard, " +
  "project_hygiene). To make them visible, add them to the project or use " +
  "'gh issue list' directly.";

/**
 * GraphQL response shape for the paginated repo OPEN issues query.
 */
interface IssuesConnection {
  totalCount: number;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: Array<{ number: number }>;
}
interface RepoIssuesPage {
  repository: {
    issues: IssuesConnection;
  } | null;
}

/**
 * GraphQL response shape for the paginated project items query.
 *
 * Tries `user(login)` first, then `organization(login)`; both share this shape.
 */
interface ProjectItemsConnection {
  totalCount: number;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: Array<{
    type: string;
    content: { __typename: string; number?: number } | null;
  }>;
}
interface ProjectV2WithItems {
  items: ProjectItemsConnection | null;
}
interface ProjectItemsPage {
  projectV2: ProjectV2WithItems | null;
}

/**
 * Fetch all OPEN issue numbers in the repo via paginated GraphQL.
 *
 * Returns `{ totalCount, numbers }`. `totalCount` is taken from the first
 * page (it is constant across pages). `numbers` is the union of all
 * `node.number` values walked.
 */
async function fetchRepoOpenIssueNumbers(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<{ totalCount: number; numbers: Set<number> }> {
  const numbers = new Set<number>();
  let totalCount = 0;
  let cursor: string | null = null;
  let pages = 0;

  while (pages < MAX_PAGES) {
    const response: RepoIssuesPage = await client.query<RepoIssuesPage>(
      `query($owner: String!, $repo: String!, $cursor: String, $first: Int!) {
        repository(owner: $owner, name: $repo) {
          issues(states: OPEN, first: $first, after: $cursor) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes { number }
          }
        }
      }`,
      { owner, repo, cursor, first: PAGE_SIZE },
    );

    const page: IssuesConnection | undefined = response.repository?.issues;
    if (!page) break;

    if (pages === 0) totalCount = page.totalCount;
    for (const node of page.nodes) numbers.add(node.number);

    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
    pages += 1;
  }

  return { totalCount, numbers };
}

/**
 * Fetch all `type=ISSUE` item numbers on the project board via paginated GraphQL.
 *
 * The query tries `user(login)` first, then falls back to `organization(login)`
 * to handle both account types. PRs and DraftIssues are skipped — only true
 * `Issue`-typed content with a `number` field is collected.
 */
async function fetchBoardIssueNumbers(
  client: GitHubClient,
  projectOwner: string,
  projectNumber: number,
): Promise<{ totalCount: number; numbers: Set<number> }> {
  const numbers = new Set<number>();
  let totalCount = 0;
  let cursor: string | null = null;
  let pages = 0;

  // The project items query is identical across user/org owner — only the
  // root selector changes. Build a closure that runs the same shape and
  // tries both owner types on the first page.
  const runQuery = async (cur: string | null): Promise<ProjectV2WithItems | null> => {
    for (const ownerType of ["user", "organization"]) {
      try {
        const res: Record<string, ProjectItemsPage> = await client.projectQuery<
          Record<string, ProjectItemsPage>
        >(
          `query($owner: String!, $number: Int!, $cursor: String, $first: Int!) {
            ${ownerType}(login: $owner) {
              projectV2(number: $number) {
                items(first: $first, after: $cursor) {
                  totalCount
                  pageInfo { hasNextPage endCursor }
                  nodes {
                    type
                    content {
                      __typename
                      ... on Issue { number }
                    }
                  }
                }
              }
            }
          }`,
          { owner: projectOwner, number: projectNumber, cursor: cur, first: PAGE_SIZE },
        );
        const proj = res[ownerType]?.projectV2;
        if (proj) return proj;
      } catch {
        // Try next owner type
      }
    }
    return null;
  };

  while (pages < MAX_PAGES) {
    const proj = await runQuery(cursor);
    if (!proj || !proj.items) break;

    if (pages === 0) totalCount = proj.items.totalCount;
    for (const node of proj.items.nodes) {
      // Only count Issue-typed content. Type field is "ISSUE" but we double-check
      // via __typename because draft-issue items can have type=DRAFT_ISSUE and
      // should never count as repo-issue overlap.
      if (
        node.type === "ISSUE" &&
        node.content?.__typename === "Issue" &&
        typeof node.content.number === "number"
      ) {
        numbers.add(node.content.number);
      }
    }

    if (!proj.items.pageInfo.hasNextPage) break;
    cursor = proj.items.pageInfo.endCursor;
    pages += 1;
  }

  return { totalCount, numbers };
}

/**
 * Detect repo issues that are absent from the project board.
 *
 * Returns the orphan summary when at least one orphan exists, or `null`
 * when the board contains every OPEN repo issue.
 *
 * Returns `null` (not an empty result) so the `health_check` caller can
 * omit the field entirely on a clean board — keeping the response tight
 * for the common no-orphans case.
 */
export async function detectOrphanRepoIssues(
  client: GitHubClient,
  owner: string,
  repo: string,
  projectOwner: string,
  projectNumber: number,
): Promise<OrphanRepoIssuesResult | null> {
  const [repoSide, boardSide] = await Promise.all([
    fetchRepoOpenIssueNumbers(client, owner, repo),
    fetchBoardIssueNumbers(client, projectOwner, projectNumber),
  ]);

  // Orphans = OPEN issues in the repo whose number is NOT in the board set.
  // We compare against the actual numbers walked rather than just totalCount,
  // because a board may contain issues from OTHER repos (multi-repo project)
  // — those would inflate `boardItems` but contribute zero to the overlap.
  const orphanNumbers: number[] = [];
  for (const n of repoSide.numbers) {
    if (!boardSide.numbers.has(n)) orphanNumbers.push(n);
  }
  orphanNumbers.sort((a, b) => a - b);

  if (orphanNumbers.length === 0) return null;

  return {
    count: orphanNumbers.length,
    repoOpen: repoSide.totalCount,
    boardItems: boardSide.totalCount,
    sample: orphanNumbers.slice(0, ORPHAN_SAMPLE_LIMIT),
    note: ORPHAN_REPO_ISSUES_NOTE,
  };
}
