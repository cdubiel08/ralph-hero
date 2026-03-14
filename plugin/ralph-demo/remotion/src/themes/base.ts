import type { Theme } from "./types";

export const baseTheme: Omit<Theme, "name" | "easing" | "transition" | "speedMultiplier"> = {
  colors: {
    primary: "#1a1a2e",
    secondary: "#16213e",
    background: "#0f0f23",
    accent: ["#e94560", "#533483", "#0f3460"],
  },
  fonts: {
    heading: { family: "Inter", weight: 800 },
    body: { family: "Inter", weight: 400 },
  },
  logo: null,
};
