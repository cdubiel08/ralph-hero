import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { registerActivityTools } from "../tools/activity-tools.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-tools-test-"));
  process.env.RALPH_ACTIVITY_DIR = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.RALPH_ACTIVITY_DIR;
});

describe("ralph_hero__recent_activity", () => {
  it("registers and returns events from log", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerActivityTools(server);

    // Seed log
    const dir = path.join(tmpDir, "2026", "05");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "02.jsonl"),
      JSON.stringify({ ts: "2026-05-02T08:00:00Z", kind: "skill_invoked", category: "work" }) + "\n",
    );

    // Direct call into the tool's handler
    // (Mirror the pattern used by directions-tools.test.ts for invocation.)
    const handler = (server as any)._registeredTools["ralph_hero__recent_activity"].handler;
    const result = await handler({ category: "work", since: "2026-05-01T00:00:00Z" });
    const data = JSON.parse(result.content[0].text);
    expect(data.events).toHaveLength(1);
    expect(data.cursor_advanced_to).toBe("2026-05-02T08:00:00Z");
  });

  it("default limit caps results at 50 (was 100 before context-flood fix)", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerActivityTools(server);

    // Seed 75 work events
    const dir = path.join(tmpDir, "2026", "05");
    fs.mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 75; i++) {
      const minute = String(i).padStart(2, "0");
      lines.push(
        JSON.stringify({
          ts: `2026-05-02T08:${minute}:00Z`,
          kind: "tool_called",
          category: "work",
          target: { tool: "Read" },
        }),
      );
    }
    fs.writeFileSync(path.join(dir, "02.jsonl"), lines.join("\n") + "\n");

    const handler = (server as any)._registeredTools["ralph_hero__recent_activity"].handler;
    // No explicit limit passed — exercises default
    const result = await handler({ category: "work", since: "2026-05-01T00:00:00Z" });
    const data = JSON.parse(result.content[0].text);
    expect(data.events).toHaveLength(50);
  });

  it("compact: true returns projected events through the tool surface", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerActivityTools(server);

    const dir = path.join(tmpDir, "2026", "05");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "02.jsonl"),
      JSON.stringify({
        ts: "2026-05-02T08:00:00Z",
        kind: "tool_called",
        category: "work",
        actor: "claude",
        target: { tool: "Write" },
        project: "ralph-hero",
        session_id: "abc-123",
      }) + "\n",
    );

    const handler = (server as any)._registeredTools["ralph_hero__recent_activity"].handler;
    const result = await handler({
      category: "work",
      since: "2026-05-01T00:00:00Z",
      compact: true,
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.events).toHaveLength(1);
    expect(data.events[0]).toEqual({
      ts: "2026-05-02T08:00:00Z",
      kind: "tool_called",
      tool: "Write",
      project: "ralph-hero",
    });
    expect("actor" in data.events[0]).toBe(false);
    expect("session_id" in data.events[0]).toBe(false);
  });
});
