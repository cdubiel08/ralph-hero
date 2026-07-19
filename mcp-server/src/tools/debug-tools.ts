/**
 * MCP tools for debug log collation.
 *
 * Provides:
 *   - `ralph_hero__collate_debug` (v2 — queries Langfuse for error spans,
 *     groups by normalized signature, dedupes against open `debug-auto`
 *     issues, and either creates new issues or appends occurrence comments
 *     when `dryRun=false`)
 *
 * Only registered when `RALPH_DEBUG=true`.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, release } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { toolSuccess, toolError } from "../types.js";
import { zBoolish } from "../lib/zod-helpers.js";
import {
  createLangfuseClient,
  type LangfuseClient,
} from "../lib/langfuse-client.js";
import {
  groupSpansBySignature,
  observationToSpan,
  type SignatureGroup,
} from "../lib/error-signature.js";
import {
  buildIssueBody,
  buildCommentBody,
  type IssueShapeEnv,
} from "../lib/debug-issue-shape.js";
import { resolveConfig } from "../lib/helpers.js";

// ---------------------------------------------------------------------------
// Phase 3b: GitHub dedup + issue create/comment
// ---------------------------------------------------------------------------

/**
 * GraphQL search response shape for `findExistingDebugIssue`.
 */
interface DebugIssueSearchResponse {
  search: {
    nodes: Array<{
      number?: number;
      id?: string;
      body?: string;
    }>;
  };
}

/**
 * Look for an open `debug-auto` issue whose body carries the given 8-char
 * hash on a `**Hash**: \`<hash>\`` line. Only issues updated within the last
 * `withinDays` are considered (default 7), matching the spec's "dedup window".
 *
 * Returns the first matching issue `{ number, id }` or `null` if no match.
 * Search rate-limit errors are swallowed (caller will create a duplicate;
 * the next run will collapse it via comment).
 */
export async function findExistingDebugIssue(
  client: GitHubClient,
  owner: string,
  repo: string,
  hash: string,
  withinDays: number = 7,
): Promise<{ number: number; id: string } | null> {
  const sinceIso = new Date(
    Date.now() - withinDays * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10); // YYYY-MM-DD
  // The hash marker `**Hash**: ` is too punctuation-heavy for GitHub's text
  // search index — search on the bare 8-char hex; the marker line is verified
  // by inspecting the issue body below.
  const q = `repo:${owner}/${repo} is:issue is:open label:debug-auto ${hash} in:body updated:>=${sinceIso}`;

  try {
    const data = await client.query<DebugIssueSearchResponse>(
      `query DebugIssueSearch($q: String!) {
        search(query: $q, type: ISSUE, first: 10) {
          nodes {
            ... on Issue {
              number
              id
              body
            }
          }
        }
      }`,
      { q },
    );

    const marker = new RegExp(`^\\*\\*Hash\\*\\*: \`${hash}\``, "m");
    for (const node of data.search.nodes ?? []) {
      if (
        typeof node.number === "number" &&
        typeof node.id === "string" &&
        typeof node.body === "string" &&
        marker.test(node.body)
      ) {
        return { number: node.number, id: node.id };
      }
    }
    return null;
  } catch (error) {
    console.error(
      `[debug-tools] findExistingDebugIssue search failed (treating as no-match): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/**
 * GraphQL response shape for the repo-id lookup.
 */
interface RepoIdResponse {
  repository: { id: string } | null;
}

/**
 * Resolve the repository's GraphQL node ID, with SessionCache memoization.
 */
async function resolveRepoNodeId(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<string> {
  const cacheKey = `repo-node-id:${owner}/${repo}`;
  const cached = client.getCache().get<string>(cacheKey);
  if (cached) return cached;

  const result = await client.query<RepoIdResponse>(
    `query($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) { id }
    }`,
    { owner, repo },
  );

  const id = result.repository?.id;
  if (!id) {
    throw new Error(`Repository ${owner}/${repo} not found`);
  }
  client.getCache().set(cacheKey, id, 60 * 60 * 1000); // 1 hour
  return id;
}

/**
 * Resolve repo-scoped label IDs for `debug-auto` and `ralph-self-report`.
 * Labels that don't exist in the repo are skipped silently — issue creation
 * still proceeds, the label just won't be applied.
 */
async function resolveLabelIds(
  client: GitHubClient,
  owner: string,
  repo: string,
  labelNames: string[],
): Promise<string[]> {
  const cacheKey = `repo-labels:${owner}/${repo}`;
  let labels = client.getCache().get<Array<{ id: string; name: string }>>(
    cacheKey,
  );
  if (!labels) {
    const result = await client.query<{
      repository: {
        labels: { nodes: Array<{ id: string; name: string }> };
      } | null;
    }>(
      `query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          labels(first: 100) { nodes { id name } }
        }
      }`,
      { owner, repo },
    );
    labels = result.repository?.labels.nodes ?? [];
    client.getCache().set(cacheKey, labels, 5 * 60 * 1000);
  }

  return labelNames
    .map((n) => labels!.find((l) => l.name === n)?.id)
    .filter((id): id is string => typeof id === "string");
}

/**
 * Create a fresh `debug-auto` issue for a new signature. Returns the new
 * issue number + node ID. Project board placement (Backlog state) is
 * delegated to the existing route-issues.yml workflow — we set labels and
 * the body marker; the workflow handles board routing.
 */
async function createDebugIssue(
  client: GitHubClient,
  owner: string,
  repo: string,
  title: string,
  body: string,
): Promise<{ number: number; id: string; url: string }> {
  const repoId = await resolveRepoNodeId(client, owner, repo);
  const labelIds = await resolveLabelIds(client, owner, repo, [
    "debug-auto",
    "ralph-self-report",
  ]);

  const result = await client.mutate<{
    createIssue: {
      issue: { id: string; number: number; url: string };
    };
  }>(
    `mutation($repoId: ID!, $title: String!, $body: String!, $labelIds: [ID!]) {
      createIssue(input: {
        repositoryId: $repoId,
        title: $title,
        body: $body,
        labelIds: $labelIds
      }) {
        issue { id number url }
      }
    }`,
    {
      repoId,
      title,
      body,
      labelIds: labelIds.length ? labelIds : null,
    },
  );

  const issue = result.createIssue.issue;
  client
    .getCache()
    .set(
      `issue-node-id:${owner}/${repo}#${issue.number}`,
      issue.id,
      30 * 60 * 1000,
    );
  return issue;
}

/**
 * Append an occurrence-update comment to an existing `debug-auto` issue.
 */
async function commentOnDebugIssue(
  client: GitHubClient,
  issueNodeId: string,
  body: string,
): Promise<string> {
  const result = await client.mutate<{
    addComment: { commentEdge: { node: { id: string } } };
  }>(
    `mutation($subjectId: ID!, $body: String!) {
      addComment(input: { subjectId: $subjectId, body: $body }) {
        commentEdge { node { id } }
      }
    }`,
    { subjectId: issueNodeId, body },
  );
  return result.addComment.commentEdge.node.id;
}

/**
 * Read the MCP server semver from package.json next to this module. Falls
 * back to `"unknown"` if the file is missing or unreadable. Mirrors the
 * approach used in `telemetry.ts:resolveServiceVersion` but kept local so
 * the debug surface has zero cross-dependency on telemetry init order.
 */
function readMcpServerVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, "..", "..", "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Default `IssueShapeEnv` builder — captures the MCP server version, the
 * Node version, and a short OS descriptor at call time. Exposed so tests
 * can override (e.g., deterministic version stamps).
 */
function defaultEnv(mcpVersion: string): IssueShapeEnv {
  return {
    mcpVersion: mcpVersion === "unknown" ? readMcpServerVersion() : mcpVersion,
    nodeVersion: process.version,
    os: `${platform()} ${release()}`,
  };
}

/**
 * Iterate groups, dedupe each against existing issues, and either create a
 * new issue or post a comment. Returns the counts the tool surfaces back to
 * the caller. Per-group failures are recorded and surfaced but do NOT abort
 * the loop — partial success is preferable to losing the whole run.
 */
export async function fileOrCommentForGroups(
  client: GitHubClient,
  owner: string,
  repo: string,
  groups: SignatureGroup[],
  env: IssueShapeEnv,
): Promise<{
  issuesCreated: number;
  issuesUpdated: number;
  results: Array<{
    hash: string;
    action: "created" | "commented" | "error";
    issueNumber?: number;
    error?: string;
  }>;
}> {
  const results: Array<{
    hash: string;
    action: "created" | "commented" | "error";
    issueNumber?: number;
    error?: string;
  }> = [];
  let issuesCreated = 0;
  let issuesUpdated = 0;

  for (const group of groups) {
    try {
      const existing = await findExistingDebugIssue(
        client,
        owner,
        repo,
        group.hash,
      );
      if (existing) {
        const commentBody = buildCommentBody(
          group,
          group.count,
          group.exampleTraceUrl,
        );
        await commentOnDebugIssue(client, existing.id, commentBody);
        issuesUpdated += 1;
        results.push({
          hash: group.hash,
          action: "commented",
          issueNumber: existing.number,
        });
      } else {
        const { title, body } = buildIssueBody(group, env);
        const created = await createDebugIssue(client, owner, repo, title, body);
        issuesCreated += 1;
        results.push({
          hash: group.hash,
          action: "created",
          issueNumber: created.number,
        });
      }
    } catch (error) {
      results.push({
        hash: group.hash,
        action: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { issuesCreated, issuesUpdated, results };
}

// ---------------------------------------------------------------------------
// Register Debug Tools
// ---------------------------------------------------------------------------

/**
 * Factory hook for the Langfuse client. Exported (and overridable) so unit
 * tests can stub the client without touching env vars or `fetch`.
 */
export type LangfuseClientFactory = () => LangfuseClient;

let langfuseClientFactory: LangfuseClientFactory = () =>
  createLangfuseClient();

/**
 * Override the Langfuse client factory. Returns a disposer that restores the
 * previous factory (used by tests).
 */
export function setLangfuseClientFactory(
  factory: LangfuseClientFactory,
): () => void {
  const prev = langfuseClientFactory;
  langfuseClientFactory = factory;
  return () => {
    langfuseClientFactory = prev;
  };
}

export function registerDebugTools(
  server: McpServer,
  client: GitHubClient,
  mcpVersion: string = "unknown",
): void {
  // -------------------------------------------------------------------------
  // ralph_hero__collate_debug (v2 — Langfuse + GitHub dedup)
  // -------------------------------------------------------------------------
  server.tool(
    "ralph_hero__collate_debug",
    "Query Langfuse for error spans in a time window, normalize messages, group by signature, then either return the grouped report (dryRun=true) or dedupe against open `debug-auto` issues and create / comment (dryRun=false, default). Returns: { since, errorGroups, totalOccurrences, dryRun, issuesCreated?, issuesUpdated?, groups[] }.",
    {
      since: z
        .string()
        .optional()
        .describe(
          "ISO date string. Only spans whose startTime >= this value are considered (default: 24h ago).",
        ),
      dryRun: zBoolish()
        .optional()
        .default(false)
        .describe(
          "If true, return the grouped report without touching GitHub. Default false — creates / comments on `debug-auto` issues per signature.",
        ),
      minOccurrences: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(3)
        .describe("Filter out signatures with fewer occurrences (default: 3)."),
      projectNumber: z
        .number()
        .optional()
        .describe(
          "Project number override. Currently informational — issues land in the configured project via the existing route-issues workflow.",
        ),
    },
    async (args) => {
      try {
        const dryRun = args.dryRun ?? false;
        const minOccurrences = args.minOccurrences ?? 3;
        const sinceDate = args.since
          ? new Date(args.since)
          : new Date(Date.now() - 24 * 60 * 60 * 1000);
        if (Number.isNaN(sinceDate.getTime())) {
          return toolError(`Invalid 'since' value: ${args.since}`);
        }

        let langfuse: LangfuseClient;
        try {
          langfuse = langfuseClientFactory();
        } catch (error) {
          return toolError(
            `Langfuse client unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        const fromStartTime = sinceDate.toISOString();
        const observations = await langfuse.queryAllObservations({
          type: "SPAN",
          level: "ERROR",
          fromStartTime,
          limit: 100,
        });

        const spans = observations.map(observationToSpan);
        const groups = groupSpansBySignature(spans, {
          minOccurrences,
          langfuseHost: langfuse.host,
        });

        const totalOccurrences = groups.reduce((sum, g) => sum + g.count, 0);
        const summaryGroups = groups.map((g) => ({
          signature: g.signature,
          hash: g.hash,
          count: g.count,
          firstSeen: g.firstSeen,
          lastSeen: g.lastSeen,
          exampleTraceUrl: g.exampleTraceUrl,
          sampleSpans: g.sampleSpans.slice(0, 3),
        }));

        if (dryRun) {
          return toolSuccess({
            since: fromStartTime,
            errorGroups: groups.length,
            totalOccurrences,
            dryRun: true,
            groups: summaryGroups,
          });
        }

        // dryRun=false — file or comment per signature.
        let owner: string;
        let repo: string;
        try {
          const resolved = resolveConfig(client, {});
          owner = resolved.owner;
          repo = resolved.repo;
        } catch (error) {
          return toolError(
            `Cannot resolve owner/repo for issue creation: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        const env = defaultEnv(mcpVersion);
        const fileResult = await fileOrCommentForGroups(
          client,
          owner,
          repo,
          groups,
          env,
        );

        return toolSuccess({
          since: fromStartTime,
          errorGroups: groups.length,
          totalOccurrences,
          dryRun: false,
          issuesCreated: fileResult.issuesCreated,
          issuesUpdated: fileResult.issuesUpdated,
          results: fileResult.results,
          groups: summaryGroups,
        });
      } catch (error) {
        return toolError(
          `Failed to collate debug spans: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}
