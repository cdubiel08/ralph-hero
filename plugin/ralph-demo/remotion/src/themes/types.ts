export interface ThemeColors {
  primary: string;
  secondary: string;
  background: string;
  accent: string[];
}

export interface ThemeFont {
  family: string;
  weight: number;
}

export interface ThemeEasing {
  enter: "spring" | "ease-in" | "ease-out" | "linear";
  exit: "spring" | "ease-in" | "ease-out" | "linear";
  move: "spring" | "ease-in" | "ease-out" | "linear";
}

export interface ThemeLogo {
  src: string;
  placement: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  size: number;
  opacity: number;
}

export type TransitionType = "slide" | "fade" | "wipe" | "none";

export interface Theme {
  name: string;
  colors: ThemeColors;
  fonts: {
    heading: ThemeFont;
    body: ThemeFont;
  };
  easing: ThemeEasing;
  transition: TransitionType;
  speedMultiplier: number;
  logo: ThemeLogo | null;
}
