/**
 * Tool-registration audit test for index.ts.
 *
 * Locks the full ralph_hero__* tool surface against an expected manifest so a
 * dropped `register*Tools()` call (or an undeclared addition) fails CI with a
 * clear message. Mocks `McpServer` to capture every `tool(name, ...)` call as
 * `index.ts` runs `main()`, then asserts the captured set matches the manifest.
 *
 * Why this test is shaped this way:
 * - `index.ts` only registers tools inside `main()`, which runs only when the
 *   module is the process entry point. Tests aren't the entry point, so we
 *   force the gate via `RALPH_HERO_RUN_MAIN=true`.
 * - `main()` constructs a real GitHubClient and calls `server.connect(stdio)`.
 *   Both are mocked here so the test makes no network calls and doesn't try to
 *   read from the test runner's stdin.
 * - Registration is synchronous inside `main()`, but `main()` itself is fired
 *   off by a top-level `if (isEntryPoint) main().catch(...)` — so we await a
 *   sentinel promise that resolves the moment `transport.connect` is invoked
 *   (i.e. after every register*Tools() call has run).
 *
 * Out of scope: schema/handler shape — only tool names are asserted.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";

// ---------------------------------------------------------------------------
// Module-scoped capture state
// ---------------------------------------------------------------------------

const registered: string[] = [];

// Resolved once main() has reached `server.connect(transport)`. At that point
// every `registerXyzTools()` call has run synchronously, so `registered` is
// final and safe to assert against.
let connectedResolve!: () => void;
const connectedPromise = new Promise<void>((resolve) => {
  connectedResolve = resolve;
});

// ---------------------------------------------------------------------------
// Mocks (declared before the dynamic import of ../index.js below)
// ---------------------------------------------------------------------------

// Capture every tool name registered against any McpServer instance. We
// subclass the real McpServer so the rest of the registration code (which may
// touch _registeredTools, validateToolInput, etc.) keeps working unchanged.
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@modelcontextprotocol/sdk/server/mcp.js")
    >();
  class CapturingMcpServer extends actual.McpServer {
    tool(name: string, ...rest: unknown[]) {
      registered.push(name);
      // Forward to the real implementation. The MCP SDK's `tool()` overloads
      // resolve at runtime by argument shape, so casting to a permissive tuple
      // is safe — we are not changing argument values.
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

// Replace StdioServerTransport with a no-op so `server.connect(transport)`
// doesn't actually wire up to process.stdin/stdout (which would block the test
// runner on stdin and pollute stdout with framing bytes). Resolving
// `connectedPromise` here is the signal that registration is complete.
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

// Stub createGitHubClient so main() doesn't try to authenticate or hit the
// GitHub API. The registration code only reads client.config (some tools)
// during registration; the actual handlers are not invoked here.
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

// Stub the registry loader so main() doesn't try to fetch .ralph-repos.yml
// from a real repo. main() already wraps this in try/catch — the stub keeps
// the path deterministic and silent.
vi.mock("../lib/registry-loader.js", () => ({
  loadRepoRegistry: vi.fn(async () => null),
}));

// Stub helpers.resolveRepoFromProject for the same reason as registry-loader.
// We keep every other helper export intact via importOriginal.
vi.mock("../lib/helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/helpers.js")>();
  return {
    ...actual,
    resolveRepoFromProject: vi.fn(async () => "test-repo"),
  };
});

// ---------------------------------------------------------------------------
// Expected manifest
// ---------------------------------------------------------------------------
//
// Source of truth: every `server.tool("ralph_hero__...", ...)` call across
// `src/index.ts` (core) and `src/tools/*.ts`. Sorted alphabetically. When a
// new tool is added, this manifest must be updated deliberately — that is the
// guard. The failure messages emitted below ("missing tool: X" / "unexpected
// new tool: Y") tell you exactly which line to add or remove here.
//
// Note: ralph_hero__collate_debug and ralph_hero__debug_stats are intentionally
// NOT in the manifest because debug-tools is registered only when
// RALPH_DEBUG=true. The test runs without that flag so those tools should not
// appear in `registered`.
const EXPECTED_TOOLS: readonly string[] = [
  "ralph_hero__add_dependency",
  "ralph_hero__add_sub_issue",
  "ralph_hero__advance_issue",
  "ralph_hero__archive_items",
  "ralph_hero__batch_update",
  "ralph_hero__capture_snapshot",
  "ralph_hero__convert_draft_issue",
  "ralph_hero__create_comment",
  "ralph_hero__create_draft_issue",
  "ralph_hero__create_issue",
  "ralph_hero__create_status_update",
  "ralph_hero__create_views",
  "ralph_hero__decompose_feature",
  "ralph_hero__delegation_stats",
  "ralph_hero__detect_stream_positions",
  "ralph_hero__get_draft_issue",
  "ralph_hero__get_issue",
  "ralph_hero__get_project",
  "ralph_hero__health_check",
  "ralph_hero__list_dependencies",
  "ralph_hero__list_groups",
  "ralph_hero__list_issues",
  "ralph_hero__list_sub_issues",
  "ralph_hero__metrics_trends",
  "ralph_hero__next_actions",
  "ralph_hero__pipeline_dashboard",
  "ralph_hero__project_hygiene",
  "ralph_hero__recent_activity",
  "ralph_hero__remove_dependency",
  "ralph_hero__save_issue",
  "ralph_hero__setup_project",
  "ralph_hero__sre__delete_pod",
  "ralph_hero__sre__drain",
  "ralph_hero__sre__rollout_restart",
  "ralph_hero__sre__scale",
  "ralph_hero__sync_plan_graph",
  "ralph_hero__update_draft_issue",
];

// ---------------------------------------------------------------------------
// Driver: trigger main() once for the whole describe block
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Ensure debug tools stay out of the captured set.
  delete process.env.RALPH_DEBUG;

  // Provide the minimum env needed for initGitHubClient + main() to succeed.
  // The GitHubClient is mocked, but initGitHubClient still reads these env
  // vars to log token sources and detect dual-token mode.
  process.env.RALPH_HERO_GITHUB_TOKEN = "test-token-not-real";
  process.env.RALPH_GH_OWNER = "test-owner";
  process.env.RALPH_GH_REPO = "test-repo";
  process.env.RALPH_GH_PROJECT_NUMBER = "1";

  // Force main() to run on import: index.ts checks RALPH_HERO_RUN_MAIN as an
  // explicit override of the realpath(argv[1]) entry-point detection.
  process.env.RALPH_HERO_RUN_MAIN = "true";

  // Importing index.js fires main() via the entry-point gate; the FakeStdio
  // transport resolves connectedPromise once registration is complete.
  await import("../index.js");
  await connectedPromise;
});

describe("tool registration audit", () => {
  it("registers every expected ralph_hero__* tool exactly once", () => {
    // Each tool should appear exactly once across all register*Tools() calls.
    const counts = new Map<string, number>();
    for (const name of registered) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const duplicates = [...counts.entries()]
      .filter(([, c]) => c > 1)
      .map(([n, c]) => `${n} (${c}x)`);
    expect(duplicates, "tools registered more than once").toEqual([]);
  });

  it("registers every tool in the expected manifest", () => {
    // Surface dropped registrations clearly: list every missing tool, not just
    // the first one. Failing message reads "missing tool: X, Y, Z".
    const captured = new Set(registered);
    const missing = EXPECTED_TOOLS.filter((name) => !captured.has(name));
    expect(
      missing,
      `missing tool: ${missing.join(", ")} — a register*Tools() call was likely dropped from index.ts`,
    ).toEqual([]);
  });

  it("does not register any tool that is not in the manifest", () => {
    // Surface new tools clearly so the manifest can be updated deliberately.
    // Filter to ralph_hero__* only — debug tools live behind RALPH_DEBUG and
    // are intentionally absent here.
    const expected = new Set(EXPECTED_TOOLS);
    const ralphTools = registered.filter((name) =>
      name.startsWith("ralph_hero__"),
    );
    const unexpected = ralphTools.filter((name) => !expected.has(name));
    expect(
      unexpected,
      `unexpected new tool: ${unexpected.join(", ")} — add to EXPECTED_TOOLS in tool-registration.test.ts`,
    ).toEqual([]);
  });

  it("does not register debug tools when RALPH_DEBUG is unset", () => {
    // Sanity check that the conditional debug-tools branch in index.ts is
    // gated as documented.
    expect(registered).not.toContain("ralph_hero__collate_debug");
    expect(registered).not.toContain("ralph_hero__debug_stats");
  });
});
