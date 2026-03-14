import { describe, it, expect } from "vitest";
import { resolvePreset, presets } from "./presets";

describe("presets", () => {
  it("has all four export presets", () => {
    expect(Object.keys(presets)).toEqual(["sprint-demo", "social-square", "social-reel", "presentation"]);
  });

  it("sprint-demo is 1920x1080", () => {
    expect(presets["sprint-demo"].width).toBe(1920);
    expect(presets["sprint-demo"].height).toBe(1080);
  });

  it("social-square is 1080x1080", () => {
    expect(presets["social-square"].width).toBe(1080);
    expect(presets["social-square"].height).toBe(1080);
  });

  it("social-reel is 1080x1920", () => {
    expect(presets["social-reel"].width).toBe(1080);
    expect(presets["social-reel"].height).toBe(1920);
  });
});

describe("resolvePreset", () => {
  it("maps 16:9 to sprint-demo", () => {
    expect(resolvePreset("16:9").name).toBe("sprint-demo");
  });

  it("maps 1:1 to social-square", () => {
    expect(resolvePreset("1:1").name).toBe("social-square");
  });

  it("maps 9:16 to social-reel", () => {
    expect(resolvePreset("9:16").name).toBe("social-reel");
  });

  it("defaults to sprint-demo for unknown format", () => {
    expect(resolvePreset("4:3").name).toBe("sprint-demo");
  });
});
