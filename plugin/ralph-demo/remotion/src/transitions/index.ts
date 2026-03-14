import { linearTiming, springTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import type { TransitionType } from "../themes/types";

export function getTransitionPresentation(type: TransitionType) {
  switch (type) {
    case "fade":
      return fade();
    case "slide":
      return slide();
    case "wipe":
      return wipe();
    case "none":
      return null;
  }
}

export function getTransitionTiming(type: "spring" | "linear", durationInFrames = 15) {
  if (type === "spring") {
    return springTiming({ config: { damping: 200 }, durationInFrames });
  }
  return linearTiming({ durationInFrames });
}
