import { describe, it, expect } from "vitest";
import type { Theme } from "./types";
import { resolveTheme } from "./index";

describe("Theme type", () => {
  it("enforces required theme fields", () => {
    const theme: Theme = {
      name: "test",
      colors: {
        primary: "#000",
        secondary: "#111",
        background: "#fff",
        accent: ["#f00", "#0f0", "#00f"],
      },
      fonts: {
        heading: { family: "Inter", weight: 700 },
        body: { family: "Inter", weight: 400 },
      },
      easing: {
        enter: "spring",
        exit: "ease-out",
        move: "spring",
      },
      transition: "slide",
      speedMultiplier: 1,
      logo: null,
    };

    expect(theme.name).toBe("test");
    expect(theme.speedMultiplier).toBe(1);
  });
});

describe("resolveTheme", () => {
  it("returns energetic theme by default", () => {
    const theme = resolveTheme();
    expect(theme.name).toBe("energetic");
    expect(theme.speedMultiplier).toBe(1.3);
  });

  it("returns energetic theme by name", () => {
    const theme = resolveTheme("energetic");
    expect(theme.name).toBe("energetic");
  });

  it("throws for unknown theme", () => {
    expect(() => resolveTheme("nonexistent")).toThrow("Unknown theme");
  });
});
