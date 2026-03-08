import { describe, it, expect } from "vitest";

describe("knowledge-index server", () => {
  it("exports createServer function", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.createServer).toBe("function");
  });
});
