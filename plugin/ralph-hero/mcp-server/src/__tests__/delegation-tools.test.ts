/**
 * Tests for the delegation-stats MCP tool registration.
 *
 * Mirrors the activity-tools.test.ts harness: builds an McpServer,
 * registers the tool, then calls the handler directly via the
 * `_registeredTools` map.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { registerDelegationTools } from "../tools/delegation-tools.js";
import { __setDelegateLogPath } from "../lib/delegation-log.js";

let tmpDir: string;
let logPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegation-tools-test-"));
  logPath = path.join(tmpDir, "delegate.log");
  __setDelegateLogPath(logPath);
});

afterEach(() => {
  __setDelegateLogPath(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function getHandler(server: McpServer): (params: { logPath?: string }) => Promise<{ content: Array<{ text: string }> }> {
  return (server as unknown as { _registeredTools: Record<string, { handler: (p: { logPath?: string }) => Promise<{ content: Array<{ text: string }> }> }> })
    ._registeredTools["ralph_hero__delegation_stats"].handler;
}

describe("ralph_hero__delegation_stats", () => {
  it("registers the tool by name", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerDelegationTools(server);
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(tools["ralph_hero__delegation_stats"]).toBeDefined();
  });

  it("returns zero-state when log file is missing", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerDelegationTools(server);
    const handler = getHandler(server);
    const result = await handler({});
    const data = JSON.parse(result.content[0].text);
    expect(data.fileExists).toBe(false);
    expect(data.totals).toEqual({ calls: 0, fallbacks: 0, bytesIn: 0, bytesOut: 0, skippedLines: 0 });
    expect(data.byTask).toEqual({});
    expect(data.logPath).toBe(logPath);
    expect(data.tokensReason).toContain("F1 audit-log does not capture token usage");
  });

  it("returns populated stats when log file has entries", async () => {
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({ ts: "2026-05-12T08:00:00Z", task: "locator", status: "ok", ms: 100, bytes_in: 50, bytes_out: 30 }),
        JSON.stringify({ ts: "2026-05-12T08:01:00Z", task: "locator", status: "ok", ms: 200, bytes_in: 60, bytes_out: 40 }),
        JSON.stringify({ ts: "2026-05-12T08:02:00Z", task: "locator", status: "timeout", ms: 5000, bytes_in: 50, bytes_out: 0 }),
        JSON.stringify({ ts: "2026-05-12T08:03:00Z", task: "summarize", status: "ok", ms: 80, bytes_in: 30, bytes_out: 20 }),
      ].join("\n") + "\n",
    );

    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerDelegationTools(server);
    const handler = getHandler(server);
    const result = await handler({});
    const data = JSON.parse(result.content[0].text);

    expect(data.fileExists).toBe(true);
    expect(data.totals.calls).toBe(4);
    expect(data.totals.fallbacks).toBe(1);
    expect(data.totals.bytesIn).toBe(190);
    expect(data.totals.bytesOut).toBe(90);
    expect(data.totals.skippedLines).toBe(0);

    expect(data.byTask.locator.calls).toBe(3);
    expect(data.byTask.locator.fallbacks).toBe(1);
    expect(data.byTask.locator.bytesIn).toBe(160);
    expect(data.byTask.locator.bytesOut).toBe(70);
    expect(data.byTask.locator.tokens).toBeNull();

    expect(data.byTask.summarize.calls).toBe(1);
    expect(data.byTask.summarize.fallbacks).toBe(0);
  });

  it("counts skipped lines for malformed / under-shaped entries", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({ ts: "2026-05-12T08:00:00Z", task: "locator", status: "ok", ms: 100 }),
        "not json",
        JSON.stringify({ foo: "bar" }),
      ].join("\n") + "\n",
    );

    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerDelegationTools(server);
    const handler = getHandler(server);
    const result = await handler({});
    const data = JSON.parse(result.content[0].text);
    expect(data.totals.calls).toBe(1);
    expect(data.totals.skippedLines).toBe(2);
    warnSpy.mockRestore();
  });

  it("honors logPath override param", async () => {
    const altPath = path.join(tmpDir, "alt-delegate.log");
    fs.writeFileSync(
      altPath,
      JSON.stringify({ ts: "2026-05-12T08:00:00Z", task: "x", status: "ok", ms: 50 }) + "\n",
    );

    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerDelegationTools(server);
    const handler = getHandler(server);
    const result = await handler({ logPath: altPath });
    const data = JSON.parse(result.content[0].text);
    expect(data.logPath).toBe(altPath);
    expect(data.totals.calls).toBe(1);
    expect(data.byTask.x.calls).toBe(1);
  });
});
