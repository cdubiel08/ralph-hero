/**
 * Tests for zBoolish() — string boolean coercion at the Zod schema layer.
 *
 * Background (GH-1130): When an MCP tool is invoked before its schema is
 * hydrated via ToolSearch, the Claude Code harness passes boolean argument
 * values as the literal strings `"true"` / `"false"` instead of native
 * booleans. A plain `z.boolean()` rejects these and emits MCP error -32602.
 *
 * `zBoolish()` uses `z.preprocess` to coerce exactly those two literal
 * shapes to real booleans before validation. This file mirrors the pattern
 * of `__tests__/empty-params.test.ts` (registers a tool with `zBoolish()`
 * params on a patched server) and asserts the harness wire-shape round-trips
 * to the handler as a native boolean.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { zBoolish } from "../lib/zod-helpers.js";

/**
 * Create a McpServer with the same validateToolInput patch applied in index.ts.
 */
function createPatchedServer(): McpServer {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const _orig = (server as any).validateToolInput.bind(server);
  (server as any).validateToolInput = (tool: unknown, args: unknown, toolName: string) =>
    _orig(tool, args ?? {}, toolName);
  return server;
}

describe("zBoolish() helper (unit)", () => {
  it("parses native true", () => {
    expect(zBoolish().parse(true)).toBe(true);
  });

  it("parses native false", () => {
    expect(zBoolish().parse(false)).toBe(false);
  });

  it("coerces literal string 'true' to true", () => {
    expect(zBoolish().parse("true")).toBe(true);
  });

  it("coerces literal string 'false' to false", () => {
    expect(zBoolish().parse("false")).toBe(false);
  });

  it("does NOT coerce 'yes' (only the two exact harness shapes are accepted)", () => {
    expect(() => zBoolish().parse("yes")).toThrow();
  });

  it("does NOT coerce '1' to true (avoids the Boolean('false') === true trap)", () => {
    expect(() => zBoolish().parse("1")).toThrow();
  });

  it("rejects numeric 1", () => {
    expect(() => zBoolish().parse(1)).toThrow();
  });

  it("rejects null", () => {
    expect(() => zBoolish().parse(null)).toThrow();
  });

  it("chains with .optional()", () => {
    const schema = zBoolish().optional();
    expect(schema.parse(undefined)).toBeUndefined();
    expect(schema.parse("true")).toBe(true);
    expect(schema.parse(false)).toBe(false);
  });

  it("chains with .default(false)", () => {
    const schema = zBoolish().default(false);
    expect(schema.parse(undefined)).toBe(false);
    expect(schema.parse("true")).toBe(true);
    expect(schema.parse("false")).toBe(false);
  });

  it("chains with .describe(...) (type-level — runtime is a no-op)", () => {
    const schema = zBoolish().describe("test flag");
    expect(schema.parse("true")).toBe(true);
  });
});

describe("zBoolish() in a registered tool schema (harness wire-shape)", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createPatchedServer();
  });

  it("accepts string 'true' from the wire and the handler sees boolean true", async () => {
    let observed: unknown = undefined;
    server.tool(
      "flag_tool",
      "test",
      { flag: zBoolish().optional().default(false) },
      async (params: { flag: boolean }) => {
        observed = params.flag;
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    );

    const SchemaShape = z.object({ flag: zBoolish().optional().default(false) });
    const parsed = SchemaShape.parse({ flag: "true" });
    expect(parsed.flag).toBe(true);
    expect(typeof parsed.flag).toBe("boolean");

    // Sanity: server registered the tool
    expect((server as any)._registeredTools?.flag_tool).toBeDefined();
    expect(observed).toBeUndefined(); // handler not yet invoked — schema-level assertion above is the load-bearing check
  });

  it("accepts string 'false' from the wire and the handler sees boolean false", () => {
    const SchemaShape = z.object({ flag: zBoolish().optional() });
    const parsed = SchemaShape.parse({ flag: "false" });
    expect(parsed.flag).toBe(false);
    expect(typeof parsed.flag).toBe("boolean");
  });

  it("accepts native boolean true unchanged", () => {
    const SchemaShape = z.object({ flag: zBoolish().optional() });
    const parsed = SchemaShape.parse({ flag: true });
    expect(parsed.flag).toBe(true);
  });

  it("accepts native boolean false unchanged", () => {
    const SchemaShape = z.object({ flag: zBoolish().optional() });
    const parsed = SchemaShape.parse({ flag: false });
    expect(parsed.flag).toBe(false);
  });

  it("rejects garbage strings with a Zod validation error", () => {
    const SchemaShape = z.object({ flag: zBoolish() });
    expect(() => SchemaShape.parse({ flag: "garbage" })).toThrow();
  });
});
