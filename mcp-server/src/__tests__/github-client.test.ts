import { describe, it, expect, vi, beforeEach } from "vitest";
import { graphql } from "@octokit/graphql";
import { createGitHubClient } from "../github-client.js";

// Mock @octokit/graphql to avoid real API calls.
//
// Strategy: `graphql.defaults(opts)` returns a fresh spy per invocation so
// tests can distinguish which underlying callable each high-level method
// (query / projectQuery / mutate / projectMutate) routed through. Each
// returned callable resolves with `viewer.login` (used by some test paths)
// and records all calls for later inspection.
vi.mock("@octokit/graphql", () => {
  const defaultsSpy = vi.fn((_opts: unknown) => {
    const callable = vi
      .fn()
      .mockResolvedValue({ viewer: { login: "test-user" } });
    return callable;
  });
  // The library only ever calls `graphql.defaults(...)`, so the top-level
  // `graphql` callable does not need to be a real spy.
  const mockGraphql = Object.assign(vi.fn(), { defaults: defaultsSpy });
  return { graphql: mockGraphql };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createGitHubClient", () => {
  describe("single-token mode", () => {
    it("creates client with query and projectQuery methods", () => {
      const client = createGitHubClient({
        token: "single-token",
        owner: "org",
        repo: "repo",
      });

      expect(client.query).toBeTypeOf("function");
      expect(client.projectQuery).toBeTypeOf("function");
      expect(client.mutate).toBeTypeOf("function");
      expect(client.projectMutate).toBeTypeOf("function");
    });

    it("stores config correctly", () => {
      const client = createGitHubClient({
        token: "tok",
        owner: "org",
        repo: "repo",
        projectNumber: 3,
        projectOwner: "personal",
      });

      expect(client.config.owner).toBe("org");
      expect(client.config.projectOwner).toBe("personal");
      expect(client.config.projectNumber).toBe(3);
    });
  });

  describe("dual-token mode", () => {
    it("creates client with separate project token in config", () => {
      const client = createGitHubClient({
        token: "repo-token",
        projectToken: "project-token",
        owner: "org",
        repo: "repo",
      });

      expect(client.config.token).toBe("repo-token");
      expect(client.config.projectToken).toBe("project-token");
    });

    it("treats same token as single-token mode", () => {
      const client = createGitHubClient({
        token: "same-token",
        projectToken: "same-token",
        owner: "org",
        repo: "repo",
      });

      // Both methods should exist regardless
      expect(client.query).toBeTypeOf("function");
      expect(client.projectQuery).toBeTypeOf("function");
    });
  });
});

describe("GitHubClient config shape", () => {
  it("supports all new config fields", () => {
    const client = createGitHubClient({
      token: "repo-token",
      projectToken: "project-token",
      owner: "centerpoint-energy",
      repo: "my-repo",
      projectNumber: 3,
      projectOwner: "chad-a-dubiel_cpe",
    });

    expect(client.config).toEqual({
      token: "repo-token",
      projectToken: "project-token",
      owner: "centerpoint-energy",
      repo: "my-repo",
      projectNumber: 3,
      projectOwner: "chad-a-dubiel_cpe",
    });
  });

  it("works with minimal config (backward compatible)", () => {
    const client = createGitHubClient({
      token: "single-token",
    });

    expect(client.config.token).toBe("single-token");
    expect(client.config.projectToken).toBeUndefined();
    expect(client.config.projectOwner).toBeUndefined();
  });
});

describe("split-token routing", () => {
  it("calls graphql.defaults twice with distinct authorization headers when token !== projectToken", () => {
    createGitHubClient({
      token: "repo-tok",
      projectToken: "project-tok",
      owner: "org",
      repo: "repo",
    });

    const defaultsSpy = vi.mocked(graphql.defaults);
    expect(defaultsSpy.mock.calls.length).toBe(2);

    const auths = defaultsSpy.mock.calls.map(
      (c) =>
        (c[0] as { headers: { authorization: string } }).headers.authorization,
    );
    expect(auths).toContain("token repo-tok");
    expect(auths).toContain("token project-tok");
  });

  it("calls graphql.defaults once when token === projectToken", () => {
    createGitHubClient({
      token: "same-tok",
      projectToken: "same-tok",
      owner: "org",
      repo: "repo",
    });

    expect(vi.mocked(graphql.defaults).mock.calls.length).toBe(1);
  });

  it("calls graphql.defaults once when projectToken is omitted", () => {
    createGitHubClient({
      token: "only-tok",
      owner: "org",
      repo: "repo",
    });

    expect(vi.mocked(graphql.defaults).mock.calls.length).toBe(1);
  });
});

describe("project-owner fallback", () => {
  // Note: user/organization GraphQL dual-shape resolution lives in
  // lib/helpers.ts::fetchProjectForCache and is exercised by helpers.test.ts.
  // Here we only assert that GitHubClient preserves projectOwner on config so
  // downstream callers can fall back to `owner` when it's absent.
  it("preserves projectOwner on config when provided", () => {
    const client = createGitHubClient({
      token: "tok",
      owner: "primary-owner",
      repo: "repo",
      projectOwner: "alt-owner",
    });

    expect(client.config.projectOwner).toBe("alt-owner");
  });

  it("leaves projectOwner undefined when omitted so callers fall back to owner", () => {
    const client = createGitHubClient({
      token: "tok",
      owner: "primary-owner",
      repo: "repo",
    });

    expect(client.config.projectOwner).toBeUndefined();
    expect(client.config.owner).toBe("primary-owner");
  });
});

describe("mutate / projectMutate", () => {
  it("mutate passes mutation string and variables through to the underlying graphql callable", async () => {
    const client = createGitHubClient({
      token: "tok",
      owner: "org",
      repo: "repo",
    });

    // Single-token mode produces one defaults() call; its return value is
    // the callable used by all four high-level methods.
    const defaultsSpy = vi.mocked(graphql.defaults);
    const repoCallable = defaultsSpy.mock.results[0]!.value as ReturnType<
      typeof vi.fn
    >;

    const mutationStr = "mutation Foo($x: Int!) { doFoo(x: $x) { id } }";
    await client.mutate(mutationStr, { x: 1 });

    expect(repoCallable).toHaveBeenCalledTimes(1);
    expect(repoCallable.mock.calls[0]![0]).toBe(mutationStr);
    expect(repoCallable.mock.calls[0]![1]).toEqual({ x: 1 });
  });

  it("projectMutate routes through the project graphql instance when split tokens are configured", async () => {
    const client = createGitHubClient({
      token: "repo-tok",
      projectToken: "project-tok",
      owner: "org",
      repo: "repo",
    });

    const defaultsSpy = vi.mocked(graphql.defaults);
    // Identify which call corresponds to which token by inspecting headers.
    const callIndexFor = (auth: string) =>
      defaultsSpy.mock.calls.findIndex(
        (c) =>
          (c[0] as { headers: { authorization: string } }).headers
            .authorization === auth,
      );
    const repoIdx = callIndexFor("token repo-tok");
    const projectIdx = callIndexFor("token project-tok");
    const repoCallable = defaultsSpy.mock.results[repoIdx]!.value as ReturnType<
      typeof vi.fn
    >;
    const projectCallable = defaultsSpy.mock.results[projectIdx]!
      .value as ReturnType<typeof vi.fn>;

    await client.projectMutate("mutation Bar { doBar { id } }");

    expect(projectCallable).toHaveBeenCalledTimes(1);
    expect(repoCallable).not.toHaveBeenCalled();

    // And the inverse: mutate routes through the repo callable, not the project one.
    await client.mutate("mutation Baz { doBaz { id } }");
    expect(repoCallable).toHaveBeenCalledTimes(1);
    expect(projectCallable).toHaveBeenCalledTimes(1);
  });

  it("mutate invalidates cached query: prefix entries before executing", async () => {
    const client = createGitHubClient({
      token: "tok",
      owner: "org",
      repo: "repo",
    });

    client.getCache().set("query:abc", "stale");
    expect(client.getCache().get("query:abc")).toBe("stale");

    await client.mutate("mutation { x }");

    expect(client.getCache().get("query:abc")).toBeUndefined();
  });

  it("projectMutate invalidates cached query: prefix entries before executing", async () => {
    const client = createGitHubClient({
      token: "repo-tok",
      projectToken: "project-tok",
      owner: "org",
      repo: "repo",
    });

    client.getCache().set("query:xyz", "stale");
    await client.projectMutate("mutation { y }");

    expect(client.getCache().get("query:xyz")).toBeUndefined();
  });
});

describe("query caching and ancillary methods", () => {
  // These tests are not part of the four primary describe blocks for GH-1122
  // but exercise enough of github-client.ts to push line coverage past 85%
  // (covering getAuthenticatedUser, getRateLimitStatus, the cache short-circuit
  // path on query/projectQuery, and the rateLimit response-update branch).

  it("query caches results when options.cache is true and short-circuits the second call", async () => {
    const client = createGitHubClient({
      token: "tok",
      owner: "org",
      repo: "repo",
    });

    const callable = vi.mocked(graphql.defaults).mock.results[0]!
      .value as ReturnType<typeof vi.fn>;
    callable.mockResolvedValue({ thing: { id: "1" } });

    const a = await client.query<{ thing: { id: string } }>(
      "query { thing { id } }",
      undefined,
      { cache: true },
    );
    const b = await client.query<{ thing: { id: string } }>(
      "query { thing { id } }",
      undefined,
      { cache: true },
    );

    expect(a).toEqual({ thing: { id: "1" } });
    expect(b).toEqual({ thing: { id: "1" } });
    // Only one underlying network call thanks to cache
    expect(callable).toHaveBeenCalledTimes(1);
  });

  it("projectQuery caches results when options.cache is true", async () => {
    const client = createGitHubClient({
      token: "tok",
      owner: "org",
      repo: "repo",
    });

    const callable = vi.mocked(graphql.defaults).mock.results[0]!
      .value as ReturnType<typeof vi.fn>;
    callable.mockResolvedValue({ thing: { id: "p" } });

    await client.projectQuery("query { thing { id } }", undefined, {
      cache: true,
    });
    await client.projectQuery("query { thing { id } }", undefined, {
      cache: true,
    });

    expect(callable).toHaveBeenCalledTimes(1);
  });

  it("updates the rate limiter from a response that includes a rateLimit block", async () => {
    const client = createGitHubClient({
      token: "tok",
      owner: "org",
      repo: "repo",
    });

    const callable = vi.mocked(graphql.defaults).mock.results[0]!
      .value as ReturnType<typeof vi.fn>;
    callable.mockResolvedValue({
      thing: { id: "1" },
      rateLimit: {
        limit: 5000,
        remaining: 4321,
        resetAt: new Date(Date.now() + 3600_000).toISOString(),
        cost: 1,
        nodeCount: 1,
      },
    });

    await client.query("query { thing { id } }");

    const status = client.getRateLimitStatus();
    expect(status.remaining).toBe(4321);
    expect(status.isLow).toBe(false);
  });

  it("projectQuery uncached path routes through executeGraphQL with the project graphql instance", async () => {
    const client = createGitHubClient({
      token: "repo-tok",
      projectToken: "project-tok",
      owner: "org",
      repo: "repo",
    });

    const defaultsSpy = vi.mocked(graphql.defaults);
    const projectIdx = defaultsSpy.mock.calls.findIndex(
      (c) =>
        (c[0] as { headers: { authorization: string } }).headers
          .authorization === "token project-tok",
    );
    const projectCallable = defaultsSpy.mock.results[projectIdx]!
      .value as ReturnType<typeof vi.fn>;
    projectCallable.mockResolvedValue({ thing: { id: "p" } });

    const result = await client.projectQuery<{ thing: { id: string } }>(
      "query { thing { id } }",
    );

    expect(result).toEqual({ thing: { id: "p" } });
    expect(projectCallable).toHaveBeenCalledTimes(1);
  });

  it("retries once with retry-after on a 403 rate-limit error", async () => {
    const client = createGitHubClient({
      token: "tok",
      owner: "org",
      repo: "repo",
    });

    const callable = vi.mocked(graphql.defaults).mock.results[0]!
      .value as ReturnType<typeof vi.fn>;
    const rateErr = Object.assign(new Error("rate limited"), {
      status: 403,
      headers: { "retry-after": "0" },
    });
    callable
      .mockRejectedValueOnce(rateErr)
      .mockResolvedValueOnce({ thing: { id: "ok" } });

    const result = await client.query<{ thing: { id: string } }>(
      "query { thing { id } }",
    );

    expect(result).toEqual({ thing: { id: "ok" } });
    expect(callable).toHaveBeenCalledTimes(2);
  });

  it("rethrows non-403 errors from the graphql callable", async () => {
    const client = createGitHubClient({
      token: "tok",
      owner: "org",
      repo: "repo",
    });

    const callable = vi.mocked(graphql.defaults).mock.results[0]!
      .value as ReturnType<typeof vi.fn>;
    callable.mockRejectedValueOnce(
      Object.assign(new Error("server boom"), { status: 500 }),
    );

    await expect(client.query("query { thing { id } }")).rejects.toThrow(
      "server boom",
    );
  });

  it("getAuthenticatedUser returns viewer.login and caches the result", async () => {
    const client = createGitHubClient({
      token: "tok",
      owner: "org",
      repo: "repo",
    });

    const callable = vi.mocked(graphql.defaults).mock.results[0]!
      .value as ReturnType<typeof vi.fn>;
    callable.mockResolvedValue({ viewer: { login: "alice" } });

    const user1 = await client.getAuthenticatedUser();
    const user2 = await client.getAuthenticatedUser();

    expect(user1).toBe("alice");
    expect(user2).toBe("alice");
    // Cached → only one underlying call
    expect(callable).toHaveBeenCalledTimes(1);
  });
});

describe("rateLimit fragment injection", () => {
  it("injects rateLimit fragment into non-mutation queries that lack it", async () => {
    const client = createGitHubClient({
      token: "tok",
      owner: "org",
      repo: "repo",
    });

    const defaultsSpy = vi.mocked(graphql.defaults);
    const callable = defaultsSpy.mock.results[0]!.value as ReturnType<
      typeof vi.fn
    >;

    // NOTE: github-client.ts uses regex `/(query)\s*(\([^)]*\))?\s*\{/` for
    // injection, which only matches unnamed `query {` or `query($var) {` —
    // not `query Name {`. Use unnamed form here so injection actually fires.
    await client.query("query { thing { id } }");

    expect(callable).toHaveBeenCalledTimes(1);
    const sentQuery = callable.mock.calls[0]![0] as string;
    expect(sentQuery).toContain("rateLimit");
    expect(sentQuery).toContain("remaining");
  });

  it("does not inject rateLimit fragment into mutations", async () => {
    const client = createGitHubClient({
      token: "tok",
      owner: "org",
      repo: "repo",
    });

    const defaultsSpy = vi.mocked(graphql.defaults);
    const callable = defaultsSpy.mock.results[0]!.value as ReturnType<
      typeof vi.fn
    >;

    await client.mutate("mutation DoThing { doThing { id } }");

    const sentMutation = callable.mock.calls[0]![0] as string;
    expect(sentMutation).not.toContain("rateLimit");
  });

  it("does not double-inject when query already contains rateLimit", async () => {
    const client = createGitHubClient({
      token: "tok",
      owner: "org",
      repo: "repo",
    });

    const defaultsSpy = vi.mocked(graphql.defaults);
    const callable = defaultsSpy.mock.results[0]!.value as ReturnType<
      typeof vi.fn
    >;

    await client.query("query { rateLimit { remaining } thing { id } }");

    const sentQuery = callable.mock.calls[0]![0] as string;
    const occurrences = (sentQuery.match(/rateLimit\s*\{/g) || []).length;
    expect(occurrences).toBe(1);
  });
});
