/**
 * Tests for empty/undefined params normalization.
 *
 * mcptools 0.7.1 strips empty `{}` params to `undefined` before sending to
 * the MCP server. The server patches `validateToolInput` to normalize
 * `undefined → {}` so tools with all-optional or no parameters succeed.
 *
 * These tests verify the patch behavior directly against McpServer.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

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

/**
 * Retrieve a registered tool's internal record from McpServer._registeredTools.
 * _registeredTools is a plain object keyed by tool name.
 */
function getTool(server: McpServer, name: string): unknown {
  const tools = (server as any)._registeredTools as Record<string, unknown>;
  return tools?.[name];
}

describe("empty/undefined params normalization", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createPatchedServer();
  });

  it("accepts undefined args for a no-param tool (empty schema {})", async () => {
    server.tool("no_params", "No params", {}, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));

    const tool = getTool(server, "no_params");
    expect(tool).toBeDefined();

    // validateToolInput with undefined should not throw
    const result = await (server as any).validateToolInput(tool, undefined, "no_params");
    expect(result).toEqual({});
  });

  it("accepts undefined args for an all-optional param tool", async () => {
    server.tool(
      "all_optional",
      "All optional params",
      {
        owner: z.string().optional(),
        limit: z.number().optional().default(50),
      },
      async (args) => ({
        content: [{ type: "text" as const, text: `limit=${args.limit}` }],
      }),
    );

    const tool = getTool(server, "all_optional");
    const result = await (server as any).validateToolInput(tool, undefined, "all_optional");

    // limit should be filled by Zod default
    expect(result).toEqual({ limit: 50 });
    // owner should be absent (no default)
    expect(result.owner).toBeUndefined();
  });

  it("accepts empty {} args for an all-optional param tool", async () => {
    server.tool(
      "all_optional_empty",
      "All optional, called with {}",
      {
        workflowState: z.string().optional(),
        limit: z.number().optional().default(10),
      },
      async (args) => ({
        content: [{ type: "text" as const, text: `limit=${args.limit}` }],
      }),
    );

    const tool = getTool(server, "all_optional_empty");
    const result = await (server as any).validateToolInput(tool, {}, "all_optional_empty");
    expect(result).toEqual({ limit: 10 });
  });

  it("rejects undefined args for a tool with required params, but with field-level error", async () => {
    server.tool(
      "has_required",
      "Has required param",
      {
        number: z.number(),
        title: z.string().optional(),
      },
      async (args) => ({
        content: [{ type: "text" as const, text: `number=${args.number}` }],
      }),
    );

    const tool = getTool(server, "has_required");

    // Should throw with a validation error about the required field,
    // NOT "expected object, received undefined"
    await expect(
      (server as any).validateToolInput(tool, undefined, "has_required"),
    ).rejects.toThrow();

    // Verify the error is field-level (number missing), not object-level (undefined)
    try {
      await (server as any).validateToolInput(tool, undefined, "has_required");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).not.toContain("expected object, received undefined");
    }
  });

  it("still validates populated args correctly", async () => {
    server.tool(
      "with_args",
      "With args",
      {
        owner: z.string(),
        limit: z.number().optional().default(25),
      },
      async (args) => ({
        content: [{ type: "text" as const, text: `${args.owner}:${args.limit}` }],
      }),
    );

    const tool = getTool(server, "with_args");
    const result = await (server as any).validateToolInput(
      tool,
      { owner: "cdubiel08", limit: 100 },
      "with_args",
    );
    expect(result).toEqual({ owner: "cdubiel08", limit: 100 });
  });
});
