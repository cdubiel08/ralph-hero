/**
 * Flag-ON sibling of tool-registration.test.ts (GH-1613).
 *
 * tool-registration.test.ts asserts the default (RALPH_SRE_ENABLE unset)
 * surface — the four ralph_hero__sre__* tools are absent. This file asserts
 * the opposite: with RALPH_SRE_ENABLE="true" set BEFORE the dynamic import of
 * ../index.js, all four sre__* tools ARE registered.
 *
 * A second file is required rather than toggling the env var mid-file because
 * vitest's module cache means ../index.js (and its main()) only runs once per
 * process; the flag must be set before the very first import.
 *
 * See tool-registration.test.ts's header comment for the full rationale
 * behind the McpServer/StdioServerTransport/GitHubClient mocking strategy —
 * this file copies that harness verbatim and only changes the manifest +
 * the RALPH_SRE_ENABLE value.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";

const registered: string[] = [];

let connectedResolve!: () => void;
const connectedPromise = new Promise<void>((resolve) => {
  connectedResolve = resolve;
});

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@modelcontextprotocol/sdk/server/mcp.js")
    >();
  class CapturingMcpServer extends actual.McpServer {
    tool(name: string, ...rest: unknown[]) {
      registered.push(name);
      return (super.tool as (n: string, ...r: unknown[]) => unknown)(
        name,
        ...rest,
      ) as ReturnType<actual.McpServer["tool"]>;
    }
  }
  return {
    ...actual,
    McpServer: CapturingMcpServer,
  };
});

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => {
  class FakeStdioServerTransport {
    async start() {
      connectedResolve();
    }
    async close() {
      /* no-op */
    }
    async send() {
      /* no-op */
    }
    onclose?: () => void;
    onerror?: (err: Error) => void;
    onmessage?: (msg: unknown) => void;
  }
  return { StdioServerTransport: FakeStdioServerTransport };
});

vi.mock("../github-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github-client.js")>();
  return {
    ...actual,
    createGitHubClient: vi.fn(() => {
      const stubFn = async () => ({});
      return {
        query: stubFn,
        projectQuery: stubFn,
        mutate: stubFn,
        projectMutate: stubFn,
        getRateLimitStatus: () => ({
          remaining: 5000,
          resetAt: new Date(Date.now() + 3600_000),
          isLow: false,
          isCritical: false,
        }),
        getCache: () => ({
          get: () => undefined,
          set: () => {},
          invalidate: () => {},
          invalidateByPrefix: () => {},
        }),
        getAuthenticatedUser: async () => "test-user",
        restPost: stubFn,
        config: {
          token: "test-token",
          owner: "test-owner",
          repo: "test-repo",
          projectNumber: 1,
        },
      } as unknown as ReturnType<typeof actual.createGitHubClient>;
    }),
  };
});

vi.mock("../lib/registry-loader.js", () => ({
  loadRepoRegistry: vi.fn(async () => null),
}));

vi.mock("../lib/helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/helpers.js")>();
  return {
    ...actual,
    resolveRepoFromProject: vi.fn(async () => "test-repo"),
  };
});

// The four sre__* tools this flag gates (GH-1613).
const EXPECTED_SRE_TOOLS: readonly string[] = [
  "ralph_hero__sre__delete_pod",
  "ralph_hero__sre__drain",
  "ralph_hero__sre__rollout_restart",
  "ralph_hero__sre__scale",
];

beforeAll(async () => {
  // Set BEFORE the dynamic import below — index.ts reads this at
  // registration time inside main(), which only runs once per module cache.
  process.env.RALPH_SRE_ENABLE = "true";

  delete process.env.RALPH_DEBUG;

  process.env.RALPH_HERO_GITHUB_TOKEN = "test-token-not-real";
  process.env.RALPH_GH_OWNER = "test-owner";
  process.env.RALPH_GH_REPO = "test-repo";
  process.env.RALPH_GH_PROJECT_NUMBER = "1";

  process.env.RALPH_HERO_RUN_MAIN = "true";

  await import("../index.js");
  await connectedPromise;
});

describe("tool registration audit — RALPH_SRE_ENABLE=true", () => {
  it("registers all four sre__* tools when the flag is set", () => {
    const captured = new Set(registered);
    const missing = EXPECTED_SRE_TOOLS.filter((name) => !captured.has(name));
    expect(
      missing,
      `missing sre tool: ${missing.join(", ")} — registerSreTools() gate in index.ts may be broken`,
    ).toEqual([]);
  });

  it("registers each sre__* tool exactly once", () => {
    const counts = new Map<string, number>();
    for (const name of registered) {
      if (EXPECTED_SRE_TOOLS.includes(name)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    const duplicates = [...counts.entries()]
      .filter(([, c]) => c > 1)
      .map(([n, c]) => `${n} (${c}x)`);
    expect(duplicates, "sre tools registered more than once").toEqual([]);
  });
});
