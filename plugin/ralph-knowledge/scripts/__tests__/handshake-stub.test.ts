import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";

const STUB = path.resolve(__dirname, "../handshake-stub.cjs");

// The stub is driven as a real subprocess over real pipes rather than by
// importing its handler: the failure this file exists to catch is a protocol
// one — a request left unanswered, a notification answered, a byte on the wrong
// stream — and none of those are observable from inside the module.
async function converse(
  lines: string[],
  { expected }: { expected: number },
): Promise<{ replies: any[]; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STUB], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const replies: any[] = [];
    let out = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out with ${replies.length}/${expected} replies`));
    }, 10_000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      let nl: number;
      while ((nl = out.indexOf("\n")) !== -1) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (line) replies.push(JSON.parse(line));
      }
      if (replies.length >= expected) {
        clearTimeout(timer);
        child.stdin.end();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ replies, stderr });
    });

    child.stdin.write(lines.map((l) => l + "\n").join(""));
  });
}

const initialize = (id: number | string, protocolVersion?: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      ...(protocolVersion ? { protocolVersion } : {}),
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  });

describe("handshake stub", () => {
  it("answers initialize and declares the tools capability", async () => {
    const { replies } = await converse([initialize(1, "2025-06-18")], {
      expected: 1,
    });
    expect(replies).toHaveLength(1);
    expect(replies[0].id).toBe(1);
    expect(replies[0].error).toBeUndefined();
    expect(replies[0].result.protocolVersion).toBe("2025-06-18");
    // Declaring the capability while the list is empty is the whole contract:
    // a client that sees no tools capability may never call tools/list again,
    // and the empty list is what makes the degradation honest.
    expect(replies[0].result.capabilities.tools).toBeDefined();
    expect(replies[0].result.instructions).toMatch(/installing/i);
  });

  it("echoes whatever protocol version the client named", async () => {
    const { replies } = await converse([initialize(1, "2024-11-05")], {
      expected: 1,
    });
    expect(replies[0].result.protocolVersion).toBe("2024-11-05");
  });

  it("reports no tools rather than tools that cannot run", async () => {
    const { replies } = await converse(
      [
        initialize(1),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      ],
      { expected: 2 },
    );
    expect(replies[1]).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
  });

  it("answers the other list methods a client probes at startup", async () => {
    const methods = ["resources/list", "prompts/list", "resources/templates/list"];
    const { replies } = await converse(
      [
        initialize(1),
        ...methods.map((method, i) =>
          JSON.stringify({ jsonrpc: "2.0", id: i + 2, method }),
        ),
      ],
      { expected: 1 + methods.length },
    );
    // Every one answered, none with an error: a client that treats a
    // capability probe failure as a dead server would undo the whole point.
    for (let i = 1; i <= methods.length; i++) {
      expect(replies[i].error, methods[i - 1]).toBeUndefined();
    }
  });

  it("never answers a notification, including an unknown one", async () => {
    // Both notifications are sent BEFORE a request whose reply we wait for, so
    // a stray answer to either would arrive first and be caught here rather
    // than racing the assertion.
    const { replies } = await converse(
      [
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled" }),
        JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }),
      ],
      { expected: 1 },
    );
    expect(replies).toHaveLength(1);
    expect(replies[0].id).toBe(9);
  });

  it("explains itself on a tools/call held over from an earlier session", async () => {
    const { replies } = await converse(
      [
        initialize(1),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "knowledge_search", arguments: { query: "x" } },
        }),
      ],
      { expected: 2 },
    );
    expect(replies[1].error.message).toMatch(/installing/i);
  });

  it("survives a garbage line instead of dropping the connection", async () => {
    // An unparseable line has no id to answer, so the only choice is whether to
    // stay up. Exiting would be reported as a crashed server for the rest of
    // the session.
    const { replies } = await converse(
      ["not json at all", initialize(1)],
      { expected: 1 },
    );
    expect(replies).toHaveLength(1);
    expect(replies[0].id).toBe(1);
  });

  it("answers every request in a batch", async () => {
    const { replies } = await converse(
      [
        JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "ping" },
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
        ]),
      ],
      { expected: 2 },
    );
    expect(replies.map((r) => r.id).sort()).toEqual([1, 2]);
  });

  it("writes nothing but JSON-RPC to stdout", async () => {
    const { replies, stderr } = await converse([initialize(1)], { expected: 1 });
    // Parsing in converse() already proves stdout is clean; this pins the other
    // half — the stub must not narrate on stderr either, because the launcher
    // has already said everything the user needs and a per-message log would
    // bury it.
    expect(replies).toHaveLength(1);
    expect(stderr).toBe("");
  });
});
