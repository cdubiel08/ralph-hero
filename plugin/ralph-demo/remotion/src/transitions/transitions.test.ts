import { describe, it, expect } from "vitest";
import { getTransitionPresentation, getTransitionTiming } from "./index";

describe("getTransitionPresentation", () => {
  it("returns a presentation for slide", () => {
    const result = getTransitionPresentation("slide");
    expect(result).toBeTruthy();
  });

  it("returns a presentation for fade", () => {
    const result = getTransitionPresentation("fade");
    expect(result).toBeTruthy();
  });

  it("returns a presentation for wipe", () => {
    const result = getTransitionPresentation("wipe");
    expect(result).toBeTruthy();
  });

  it("returns null for none", () => {
    const result = getTransitionPresentation("none");
    expect(result).toBeNull();
  });
});

describe("getTransitionTiming", () => {
  it("returns spring timing", () => {
    const result = getTransitionTiming("spring", 15);
    expect(result).toBeTruthy();
  });

  it("returns linear timing", () => {
    const result = getTransitionTiming("linear", 20);
    expect(result).toBeTruthy();
  });
});
