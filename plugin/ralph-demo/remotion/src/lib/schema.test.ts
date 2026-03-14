import { describe, it, expect } from "vitest";
import { VideoInputSchema, type VideoInput } from "./schema";
import { calculateTotalDuration } from "./duration";

describe("VideoInputSchema", () => {
  const validInput: VideoInput = {
    sprint: 42,
    date: "2026-03-12",
    team: "Platform Team",
    theme: "energetic",
    format: "16:9",
    scenes: [
      { type: "title", headline: "Sprint 42 Demo" },
      { type: "feature", name: "Batch Processing", description: "10x faster" },
      { type: "outro", text: "Thanks!" },
    ],
  };

  it("validates a correct input", () => {
    const result = VideoInputSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("rejects input with no scenes", () => {
    const result = VideoInputSchema.safeParse({ ...validInput, scenes: [] });
    expect(result.success).toBe(false);
  });

  it("rejects unknown scene type", () => {
    const result = VideoInputSchema.safeParse({
      ...validInput,
      scenes: [{ type: "unknown" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects title scene missing headline", () => {
    const result = VideoInputSchema.safeParse({
      ...validInput,
      scenes: [{ type: "title" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts input without sprint number (ad-hoc videos)", () => {
    const { sprint, ...noSprint } = validInput;
    const result = VideoInputSchema.safeParse(noSprint);
    expect(result.success).toBe(true);
  });
});

describe("calculateTotalDuration", () => {
  it("sums default durations for scenes", () => {
    const scenes = [
      { type: "title" as const, headline: "Test" },
      { type: "feature" as const, name: "Feat", description: "Desc" },
      { type: "outro" as const, text: "End" },
    ];
    const fps = 30;
    const duration = calculateTotalDuration(scenes, fps);
    // title: 3.5s = 105f, feature: 4.5s = 135f, outro: 3.5s = 105f
    expect(duration).toBe(105 + 135 + 105);
  });

  it("respects per-scene duration overrides", () => {
    const scenes = [
      { type: "title" as const, headline: "Test", durationSeconds: 5 },
    ];
    const fps = 30;
    const duration = calculateTotalDuration(scenes, fps);
    expect(duration).toBe(150);
  });
});
