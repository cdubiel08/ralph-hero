import { describe, it, expect } from "vitest";

describe("knowledge-index server", () => {
  it("exports createServer function", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.createServer).toBe("function");
  });

  it("registers outcome tools without error", async () => {
    const mod = await import("../index.js");
    const { server } = mod.createServer(":memory:");
    expect(server).toBeTruthy();
  });
});
