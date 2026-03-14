import type { Theme } from "./types";
import { energeticTheme } from "./energetic";

export type { Theme } from "./types";
export { energeticTheme } from "./energetic";

const themes: Record<string, Theme> = {
  energetic: energeticTheme,
};

export function resolveTheme(name?: string): Theme {
  const themeName = name ?? "energetic";
  const theme = themes[themeName];
  if (!theme) {
    throw new Error(`Unknown theme: "${themeName}". Available: ${Object.keys(themes).join(", ")}`);
  }
  return theme;
}
