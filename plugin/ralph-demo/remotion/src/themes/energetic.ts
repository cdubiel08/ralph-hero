import type { Theme } from "./types";
import { baseTheme } from "./base";

export const energeticTheme: Theme = {
  ...baseTheme,
  name: "energetic",
  easing: {
    enter: "spring",
    exit: "ease-out",
    move: "spring",
  },
  transition: "slide",
  speedMultiplier: 1.3,
};
