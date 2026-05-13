/**
 * Phase 3b integration test for `ralph_hero__collate_debug`.
 *
 * Verifies the GitHub-side half (dedup + create / comment) end-to-end with
 * an in-memory stubbed `GitHubClient`. Specifically:
 *
 *   1. First run over 2 unique signatures × 5 occurrences each creates 2
 *      issues, posts 0 comments.
 *   2. Second run over the same fixture (with the previously-filed issues
 *      now visible to the search stub) creates 0 issues and posts 2
 *      comments.
 *   3. `findExistingDebugIssue` builds a search query containing the hash
 *      and the dedup-window filter, and verifies the body hash marker
 *      before returning a match.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerDebugTools,
  setLangfuseClientFactory,
  findExistingDebugIssue,
  fileOrCommentForGroups,
} from "../tools/debug-tools.js";
import type { GitHubClient } from "../github-client.js";
import { SessionCache } from "../lib/cache.js";
import {
  createLangfuseClient,
  type LangfuseClient,
  type LangfuseObservation,
  type LangfusePage,
} from "../lib/langfuse-client.js";
import type { SignatureGroup } from "../lib/error-signature.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface HandlerResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface RegisteredTool {
  handler: (args: unknown, extra: unknown) => Promise<HandlerResult>;
}

function getTool(server: McpServer, name: string): RegisteredTool {
  const tools = (
    server as unknown as { _registeredTools: Record<string, RegisteredTool> }
  )._registeredTools;
  const tool = tools?.[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool;
}

function parsePayload(result: HandlerResult): Record<string, unknown> {
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Mock GitHubClient — records queries and mutations, returns deterministic
// responses tailored to the search/create/comment flow.
// ---------------------------------------------------------------------------

interface MockIssue {
  id: string;
  number: number;
  body: string;
  hash: string;
}

interface MockClientState {
  /** Currently-existing `debug-auto` issues the search query can return. */
  issues: MockIssue[];
  /** Each create mutation appends here. */
  createdIssues: Array<{ title: string; body: string; number: number }>;
  /** Each comment mutation appends here. */
  comments: Array<{ subjectId: string; body: string }>;
  /** Auto-incrementing issue number for newly-created issues. */
  nextIssueNumber: number;
  /** Recorded queries for assertion. */
  queries: Array<{ q: string; vars: Record<string, unknown> }>;
}

function makeMockClient(state: MockClientState): GitHubClient {
  const cache = new SessionCache();

  async function query<T>(
    queryString: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    state.queries.push({
      q: queryString,
      vars: variables ?? {},
    });
    // Repo node ID lookup.
    if (/repository\(owner: \$owner, name: \$repo\)/.test(queryString) && !queryString.includes("labels(")) {
      return {
        repository: { id: "repo-node-id-abc" },
      } as unknown as T;
    }
    // Labels lookup.
    if (queryString.includes("labels(first: 100)")) {
      return {
        repository: {
          labels: {
            nodes: [
              { id: "label-debug-auto", name: "debug-auto" },
              { id: "label-ralph-self-report", name: "ralph-self-report" },
            ],
          },
        },
      } as unknown as T;
    }
    // Search query.
    if (queryString.includes("search(query: $q, type: ISSUE")) {
      const q = (variables?.q ?? "") as string;
      const hashMatch = q.match(/\b([0-9a-f]{8})\b/);
      const hash = hashMatch?.[1];
      const matches = hash
        ? state.issues.filter((i) => i.hash === hash)
        : [];
      return {
        search: {
          nodes: matches.map((m) => ({
            number: m.number,
            id: m.id,
            body: m.body,
          })),
        },
      } as unknown as T;
    }
    throw new Error(`Unexpected query in mock: ${queryString.slice(0, 80)}`);
  }

  async function mutate<T>(
    mutation: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    if (mutation.includes("createIssue(input:")) {
      const title = variables?.title as string;
      const body = variables?.body as string;
      const number = state.nextIssueNumber++;
      state.createdIssues.push({ title, body, number });
      // Track in state.issues so the next run's search returns it.
      const hashMatch = body.match(/\*\*Hash\*\*: `([0-9a-f]{8})`/);
      if (hashMatch) {
        state.issues.push({
          id: `issue-node-${number}`,
          number,
          body,
          hash: hashMatch[1],
        });
      }
      return {
        createIssue: {
          issue: {
            id: `issue-node-${number}`,
            number,
            url: `https://github.com/test/test/issues/${number}`,
          },
        },
      } as unknown as T;
    }
    if (mutation.includes("addComment(input:")) {
      state.comments.push({
        subjectId: variables?.subjectId as string,
        body: variables?.body as string,
      });
      return {
        addComment: {
          commentEdge: { node: { id: `comment-${state.comments.length}` } },
        },
      } as unknown as T;
    }
    throw new Error(`Unexpected mutation in mock: ${mutation.slice(0, 80)}`);
  }

  return {
    config: {
      token: "tok",
      owner: "test",
      repo: "test",
      projectNumber: 1,
    },
    query,
    mutate,
    projectQuery: query,
    projectMutate: mutate,
    getCache: () => cache,
    getRateLimitStatus: () => ({
      remaining: 5000,
      resetAt: new Date(),
      isLow: false,
      isCritical: false,
    }),
    getAuthenticatedUser: async () => "test-user",
    restPost: async () => ({}) as never,
  } as unknown as GitHubClient;
}

// ---------------------------------------------------------------------------
// Langfuse fixture — 2 signatures × 5 occurrences each.
// ---------------------------------------------------------------------------

function makeLangfuseFixture(): LangfusePage<LangfuseObservation> {
  const out: LangfuseObservation[] = [];
  // Signature A: GetIssue "Issue #N not found"
  for (let i = 0; i < 5; i++) {
    out.push({
      id: `obs-a-${i}`,
      traceId: `trace-a-${i}`,
      name: "ralph_hero.graphql",
      type: "SPAN",
      startTime: `2026-05-11T10:0${i}:00.000Z`,
      endTime: `2026-05-11T10:0${i}:01.000Z`,
      statusMessage: `Issue #${100 + i} not found`,
      level: "ERROR",
      metadata: {
        "ralph_hero.error_type": "graphql",
        "ralph_hero.operation": "GetIssue",
      },
    } as unknown as LangfuseObservation);
  }
  // Signature B: rate_limit
  for (let i = 0; i < 5; i++) {
    out.push({
      id: `obs-b-${i}`,
      traceId: `trace-b-${i}`,
      name: "ralph_hero.graphql",
      type: "SPAN",
      startTime: `2026-05-11T11:0${i}:00.000Z`,
      endTime: `2026-05-11T11:0${i}:01.000Z`,
      statusMessage: `rate limit exceeded; retry after ${30 + i}s`,
      level: "ERROR",
      metadata: {
        "ralph_hero.error_type": "rate_limit",
      },
    } as unknown as LangfuseObservation);
  }
  return { data: out } as LangfusePage<LangfuseObservation>;
}

function makeLangfuseStub(
  fixture: LangfusePage<LangfuseObservation>,
): typeof fetch {
  let firstCall = true;
  return (async (input: RequestInfo | URL) => {
    void input;
    if (firstCall) {
      firstCall = false;
      return new Response(JSON.stringify(fixture), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("findExistingDebugIssue", () => {
  it("builds a query with hash, label, and dedup window", async () => {
    const state: MockClientState = {
      issues: [],
      createdIssues: [],
      comments: [],
      nextIssueNumber: 2000,
      queries: [],
    };
    const client = makeMockClient(state);
    const result = await findExistingDebugIssue(
      client,
      "owner",
      "repo",
      "deadbeef",
      7,
    );
    expect(result).toBeNull();
    const search = state.queries.find((q) =>
      q.q.includes("search(query: $q, type: ISSUE"),
    );
    expect(search).toBeDefined();
    const queryString = (search!.vars.q ?? "") as string;
    expect(queryString).toContain("repo:owner/repo");
    expect(queryString).toContain("is:issue");
    expect(queryString).toContain("is:open");
    expect(queryString).toContain("label:debug-auto");
    expect(queryString).toContain("deadbeef");
    expect(queryString).toMatch(/updated:>=\d{4}-\d{2}-\d{2}/);
  });

  it("returns the issue when the body carries the hash marker", async () => {
    const state: MockClientState = {
      issues: [
        {
          id: "node-1",
          number: 999,
          body: "**Hash**: `cafebabe`\n\nMore content here.",
          hash: "cafebabe",
        },
      ],
      createdIssues: [],
      comments: [],
      nextIssueNumber: 2000,
      queries: [],
    };
    const client = makeMockClient(state);
    const result = await findExistingDebugIssue(
      client,
      "owner",
      "repo",
      "cafebabe",
    );
    expect(result).toEqual({ number: 999, id: "node-1" });
  });

  it("rejects matches whose body lacks the canonical hash marker", async () => {
    // Even if GitHub search returns a node (because the hash appears
    // anywhere in the body), we should not trust the result unless the
    // body carries the exact `**Hash**: \`<h>\`` line.
    const state: MockClientState = {
      issues: [
        {
          id: "node-2",
          number: 1234,
          // hash appears as plain text but not in the marker line.
          body: "Some debug-auto issue mentioning beefface in passing.",
          hash: "beefface",
        },
      ],
      createdIssues: [],
      comments: [],
      nextIssueNumber: 2000,
      queries: [],
    };
    const client = makeMockClient(state);
    const result = await findExistingDebugIssue(
      client,
      "owner",
      "repo",
      "beefface",
    );
    expect(result).toBeNull();
  });

  it("treats search errors as no-match", async () => {
    const client = {
      config: { token: "tok", owner: "o", repo: "r", projectNumber: 1 },
      query: async () => {
        throw new Error("rate limited");
      },
      getCache: () => new SessionCache(),
    } as unknown as GitHubClient;
    const result = await findExistingDebugIssue(client, "o", "r", "deadbeef");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("fileOrCommentForGroups", () => {
  function makeGroup(
    hash: string,
    count: number,
    overrides: Partial<SignatureGroup> = {},
  ): SignatureGroup {
    return {
      signature: `ralph_hero.graphql:graphql:Issue #N not found`,
      hash,
      count,
      firstSeen: "2026-05-11T10:00:00.000Z",
      lastSeen: "2026-05-11T10:05:00.000Z",
      exampleTraceUrl: `http://localhost:3100/project/p/traces/t-${hash}`,
      sampleSpans: [
        {
          name: "ralph_hero.graphql",
          traceId: `t-${hash}`,
          startTime: "2026-05-11T10:00:00.000Z",
          message: "Issue #42 not found",
          metadata: {},
          errorType: "graphql",
        },
      ],
      ...overrides,
    };
  }

  it("creates new issues when no existing match", async () => {
    const state: MockClientState = {
      issues: [],
      createdIssues: [],
      comments: [],
      nextIssueNumber: 5000,
      queries: [],
    };
    const client = makeMockClient(state);
    const groups = [makeGroup("a1b2c3d4", 3), makeGroup("e5f6a7b8", 4)];
    const result = await fileOrCommentForGroups(client, "o", "r", groups, {
      mcpVersion: "test",
      nodeVersion: "v22.0.0",
      os: "test 1.0",
    });
    expect(result.issuesCreated).toBe(2);
    expect(result.issuesUpdated).toBe(0);
    expect(state.createdIssues).toHaveLength(2);
    // Both bodies carry the canonical hash marker.
    for (const created of state.createdIssues) {
      expect(created.body).toMatch(/\*\*Hash\*\*: `[0-9a-f]{8}`/);
    }
  });

  it("comments on existing issues, does not duplicate", async () => {
    const state: MockClientState = {
      issues: [
        {
          id: "existing-node",
          number: 4242,
          body: "**Hash**: `a1b2c3d4`\n\nbody content",
          hash: "a1b2c3d4",
        },
      ],
      createdIssues: [],
      comments: [],
      nextIssueNumber: 5000,
      queries: [],
    };
    const client = makeMockClient(state);
    const groups = [makeGroup("a1b2c3d4", 7)];
    const result = await fileOrCommentForGroups(client, "o", "r", groups, {
      mcpVersion: "test",
      nodeVersion: "v22.0.0",
      os: "test 1.0",
    });
    expect(result.issuesCreated).toBe(0);
    expect(result.issuesUpdated).toBe(1);
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0].subjectId).toBe("existing-node");
    expect(state.comments[0].body).toContain("**7** new occurrences");
  });

  it("records per-group errors without aborting the loop", async () => {
    const state: MockClientState = {
      issues: [],
      createdIssues: [],
      comments: [],
      nextIssueNumber: 5000,
      queries: [],
    };
    const client = makeMockClient(state);
    // Override mutate to throw for one group.
    const origMutate = client.mutate;
    let callCount = 0;
    (client as unknown as { mutate: typeof origMutate }).mutate = (async (
      m: string,
      v: Record<string, unknown>,
    ) => {
      callCount += 1;
      if (callCount === 1) throw new Error("transient network glitch");
      return origMutate(m, v);
    }) as typeof origMutate;
    const groups = [makeGroup("a1b2c3d4", 3), makeGroup("e5f6a7b8", 4)];
    const result = await fileOrCommentForGroups(client, "o", "r", groups, {
      mcpVersion: "test",
      nodeVersion: "v22.0.0",
      os: "test 1.0",
    });
    expect(result.results).toHaveLength(2);
    expect(result.results.filter((r) => r.action === "error")).toHaveLength(1);
    expect(result.results.filter((r) => r.action === "created")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("ralph_hero__collate_debug end-to-end (dryRun=false)", () => {
  let server: McpServer;
  let state: MockClientState;
  let restoreFactory: (() => void) | undefined;

  beforeEach(() => {
    state = {
      issues: [],
      createdIssues: [],
      comments: [],
      nextIssueNumber: 7000,
      queries: [],
    };
    const client = makeMockClient(state);
    server = new McpServer({ name: "test", version: "0.0.0" });
    registerDebugTools(server, client, "2.5.127");
  });

  afterEach(() => {
    if (restoreFactory) {
      restoreFactory();
      restoreFactory = undefined;
    }
  });

  it("2 signatures × 5 occurrences → 2 issues; rerun → 0 new + 2 comments", async () => {
    const fixture = makeLangfuseFixture();

    // First run.
    restoreFactory = setLangfuseClientFactory(() => {
      return createLangfuseClient({
        publicKey: "pk",
        secretKey: "sk",
        host: "http://localhost:3100",
        fetchImpl: makeLangfuseStub(fixture),
      }) as LangfuseClient;
    });

    const tool = getTool(server, "ralph_hero__collate_debug");

    const first = await tool.handler(
      { dryRun: false, minOccurrences: 3 },
      {},
    );
    const firstPayload = parsePayload(first);
    expect(firstPayload.dryRun).toBe(false);
    expect(firstPayload.errorGroups).toBe(2);
    expect(firstPayload.issuesCreated).toBe(2);
    expect(firstPayload.issuesUpdated).toBe(0);
    expect(state.createdIssues).toHaveLength(2);
    // Each created issue body carries the canonical hash marker line.
    for (const c of state.createdIssues) {
      expect(c.body).toMatch(/^\*\*Hash\*\*: `[0-9a-f]{8}`/m);
      expect(c.body).toContain("http://localhost:3100/project/");
    }

    // Second run with a fresh Langfuse stub (state.issues now contains both
    // previously-filed issues, so search will return them on hash match).
    restoreFactory();
    restoreFactory = setLangfuseClientFactory(() => {
      return createLangfuseClient({
        publicKey: "pk",
        secretKey: "sk",
        host: "http://localhost:3100",
        fetchImpl: makeLangfuseStub(fixture),
      }) as LangfuseClient;
    });

    const second = await tool.handler(
      { dryRun: false, minOccurrences: 3 },
      {},
    );
    const secondPayload = parsePayload(second);
    expect(secondPayload.errorGroups).toBe(2);
    expect(secondPayload.issuesCreated).toBe(0);
    expect(secondPayload.issuesUpdated).toBe(2);
    // No new createdIssues entries from the second run.
    expect(state.createdIssues).toHaveLength(2);
    expect(state.comments).toHaveLength(2);
    for (const cm of state.comments) {
      expect(cm.body).toContain("Recurring occurrence");
      expect(cm.body).toMatch(/\*\*5\*\* new occurrences/);
    }
  });

  it("preserves dryRun=true grouped report behavior (no GitHub calls)", async () => {
    const fixture = makeLangfuseFixture();
    restoreFactory = setLangfuseClientFactory(() => {
      return createLangfuseClient({
        publicKey: "pk",
        secretKey: "sk",
        host: "http://localhost:3100",
        fetchImpl: makeLangfuseStub(fixture),
      }) as LangfuseClient;
    });

    const tool = getTool(server, "ralph_hero__collate_debug");
    const result = await tool.handler(
      { dryRun: true, minOccurrences: 3 },
      {},
    );
    const payload = parsePayload(result);
    expect(payload.dryRun).toBe(true);
    expect(payload.errorGroups).toBe(2);
    expect(state.createdIssues).toHaveLength(0);
    expect(state.comments).toHaveLength(0);
    expect(state.queries).toHaveLength(0);
  });
});
