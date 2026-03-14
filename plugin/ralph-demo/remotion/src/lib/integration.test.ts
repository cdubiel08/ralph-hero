import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { VideoInputSchema } from "./schema";
import { calculateTotalDuration } from "./duration";
import { resolveTheme } from "../themes";
import { resolvePreset } from "./presets";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("End-to-end input processing", () => {
  const raw = readFileSync(join(__dirname, "../../inputs/sample-sprint.json"), "utf-8");
  const parsed = JSON.parse(raw);

  it("validates sample input file against schema", () => {
    const result = VideoInputSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it("resolves theme from input", () => {
    const input = VideoInputSchema.parse(parsed);
    const theme = resolveTheme(input.theme);
    expect(theme.name).toBe("energetic");
  });

  it("calculates total duration", () => {
    const input = VideoInputSchema.parse(parsed);
    const duration = calculateTotalDuration(input.scenes, 30);
    expect(duration).toBeGreaterThan(0);
    // 4 scenes: title(3.5s) + feature(4.5s) + bullets(5s) + outro(3.5s) = 16.5s = 495 frames
    expect(duration).toBe(495);
  });

  it("resolves export preset from format", () => {
    const input = VideoInputSchema.parse(parsed);
    const preset = resolvePreset(input.format);
    expect(preset.width).toBe(1920);
    expect(preset.height).toBe(1080);
  });
});
