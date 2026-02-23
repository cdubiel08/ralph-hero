import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DebugLogger,
  createDebugLogger,
  sanitize,
  withLogging,
  extractOperationName,
  wrapServerToolWithLogging,
} from "../lib/debug-logger.js";

describe("createDebugLogger", () => {
  const origDebug = process.env.RALPH_DEBUG;

  afterEach(() => {
    if (origDebug === undefined) {
      delete process.env.RALPH_DEBUG;
    } else {
      process.env.RALPH_DEBUG = origDebug;
    }
  });

  it("returns null when RALPH_DEBUG is not set", () => {
    delete process.env.RALPH_DEBUG;
    expect(createDebugLogger()).toBeNull();
  });

  it("returns null when RALPH_DEBUG is 'false'", () => {
    process.env.RALPH_DEBUG = "false";
    expect(createDebugLogger()).toBeNull();
  });

  it("returns DebugLogger when RALPH_DEBUG is 'true'", () => {
    process.env.RALPH_DEBUG = "true";
    const logger = createDebugLogger();
    expect(logger).toBeInstanceOf(DebugLogger);
  });
});

describe("sanitize", () => {
  it("redacts fields matching sensitive patterns", () => {
    const input = {
      owner: "test",
      token: "ghp_secret",
      authToken: "abc123",
      secretKey: "xyz",
      password: "pass",
      number: 42,
    };
    const result = sanitize(input);
    expect(result).toEqual({
      owner: "test",
      token: "[REDACTED]",
      authToken: "[REDACTED]",
      secretKey: "[REDACTED]",
      password: "[REDACTED]",
      number: 42,
    });
  });

  it("returns undefined for undefined input", () => {
    expect(sanitize(undefined)).toBeUndefined();
  });
});

describe("extractOperationName", () => {
  it("extracts query name", () => {
    expect(extractOperationName("query GetIssue($n: Int!) { issue(number: $n) { title } }"))
      .toBe("GetIssue");
  });

  it("extracts mutation name", () => {
    expect(extractOperationName("mutation UpdateItem($id: ID!) { updateItem(input: { id: $id }) { id } }"))
      .toBe("UpdateItem");
  });

  it("returns undefined for anonymous queries", () => {
    expect(extractOperationName("query { viewer { login } }")).toBeUndefined();
  });
});

describe("DebugLogger", () => {
  let logDir: string;

  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), "ralph-debug-test-"));
  });

  afterEach(async () => {
    await rm(logDir, { recursive: true, force: true });
  });

  it("creates log file lazily on first event", async () => {
    const logger = new DebugLogger({ logDir });
    expect(logger.getSessionLogPath()).toBeNull();

    logger.logTool({ tool: "test_tool", params: {}, durationMs: 10, ok: true });

    // Wait for fire-and-forget write
    await new Promise((r) => setTimeout(r, 100));

    const logPath = logger.getSessionLogPath();
    expect(logPath).not.toBeNull();
    expect(logPath!).toContain("session-");
    expect(logPath!.endsWith(".jsonl")).toBe(true);
  });

  it("writes valid JSONL format", async () => {
    const logger = new DebugLogger({ logDir });

    logger.logTool({ tool: "tool_a", params: { owner: "x" }, durationMs: 5, ok: true });
    logger.logTool({ tool: "tool_b", params: {}, durationMs: 10, ok: false, error: "fail" });
    logger.logGraphQL({
      operation: "GetIssue",
      variables: { number: 1 },
      durationMs: 50,
      status: 200,
      rateLimitRemaining: 4900,
      rateLimitCost: 1,
    });

    await new Promise((r) => setTimeout(r, 200));

    const content = await readFile(logger.getSessionLogPath()!, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);

    // Each line must be valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.ts).toBeDefined();
      expect(parsed.cat).toBeDefined();
    }

    // Parse all events (order not guaranteed with fire-and-forget writes)
    const events = lines.map((l: string) => JSON.parse(l));
    const toolEvents = events.filter((e: Record<string, unknown>) => e.cat === "tool");
    const gqlEvents = events.filter((e: Record<string, unknown>) => e.cat === "graphql");

    expect(toolEvents).toHaveLength(2);
    expect(gqlEvents).toHaveLength(1);

    // Check tool events by content
    const toolA = toolEvents.find((e: Record<string, unknown>) => e.tool === "tool_a");
    const toolB = toolEvents.find((e: Record<string, unknown>) => e.tool === "tool_b");
    expect(toolA).toBeDefined();
    expect(toolA!.ok).toBe(true);
    expect(toolB).toBeDefined();
    expect(toolB!.ok).toBe(false);
    expect(toolB!.error).toBe("fail");

    // Check GraphQL event
    const gqlEvent = gqlEvents[0];
    expect(gqlEvent.operation).toBe("GetIssue");
    expect(gqlEvent.rateLimitRemaining).toBe(4900);
  });

  it("sanitizes token fields in logged variables", async () => {
    const logger = new DebugLogger({ logDir });

    logger.logGraphQL({
      operation: "Test",
      variables: { token: "ghp_secret", owner: "user" },
      durationMs: 10,
      status: 200,
    });

    await new Promise((r) => setTimeout(r, 100));

    const content = await readFile(logger.getSessionLogPath()!, "utf-8");
    const event = JSON.parse(content.trim());
    expect(event.variables.token).toBe("[REDACTED]");
    expect(event.variables.owner).toBe("user");
  });
});

describe("withLogging", () => {
  it("calls handler directly when logger is null (zero overhead)", async () => {
    const handler = vi.fn().mockResolvedValue("result");
    const result = await withLogging(null, "test", {}, handler);
    expect(result).toBe("result");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("logs successful tool calls", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "ralph-debug-test-"));
    const logger = new DebugLogger({ logDir });

    const result = await withLogging(logger, "my_tool", { n: 1 }, async () => "ok");
    expect(result).toBe("ok");

    await new Promise((r) => setTimeout(r, 100));

    const content = await readFile(logger.getSessionLogPath()!, "utf-8");
    const event = JSON.parse(content.trim());
    expect(event.cat).toBe("tool");
    expect(event.tool).toBe("my_tool");
    expect(event.ok).toBe(true);
    expect(event.durationMs).toBeGreaterThanOrEqual(0);

    await rm(logDir, { recursive: true, force: true });
  });

  it("logs and rethrows errors", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "ralph-debug-test-"));
    const logger = new DebugLogger({ logDir });

    await expect(
      withLogging(logger, "failing_tool", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await new Promise((r) => setTimeout(r, 100));

    const content = await readFile(logger.getSessionLogPath()!, "utf-8");
    const event = JSON.parse(content.trim());
    expect(event.ok).toBe(false);
    expect(event.error).toBe("boom");

    await rm(logDir, { recursive: true, force: true });
  });
});

describe("wrapServerToolWithLogging", () => {
  it("wraps tool handlers with logging", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "ralph-debug-test-"));
    const logger = new DebugLogger({ logDir });

    const registeredTools: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

    // Mock server with tool method
    const mockServer = {
      tool: (name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
        registeredTools[name] = handler;
      },
    };

    wrapServerToolWithLogging(mockServer, logger);

    // Register a tool through the wrapped method
    mockServer.tool("test_tool", "desc", {}, async (args: unknown) => {
      return { content: [{ type: "text", text: "ok" }] };
    });

    // Call the registered handler
    const result = await registeredTools["test_tool"]({ owner: "test" });
    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });

    await new Promise((r) => setTimeout(r, 100));

    const content = await readFile(logger.getSessionLogPath()!, "utf-8");
    const event = JSON.parse(content.trim());
    expect(event.cat).toBe("tool");
    expect(event.tool).toBe("test_tool");
    expect(event.ok).toBe(true);

    await rm(logDir, { recursive: true, force: true });
  });
});
