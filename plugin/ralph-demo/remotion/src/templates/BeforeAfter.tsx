import React from "react";
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../themes/types";

interface BeforeAfterProps {
  before: string;
  after: string;
  caption?: string;
  transition?: "wipe" | "slide" | "fade";
  theme: Theme;
}

export const BeforeAfter: React.FC<BeforeAfterProps> = ({
  before,
  after,
  caption,
  transition = "fade",
  theme,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const speed = theme.speedMultiplier;

  const beforeOpacity = interpolate(frame * speed, [0, 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const afterProgress = interpolate(frame * speed, [40, 70], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const afterScale = spring({
    fps,
    frame: Math.round((frame - 40 / speed) * speed),
    config: { damping: 100 },
  });

  const captionOpacity = interpolate(frame * speed, [60, 75], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const afterTransitionStyle: React.CSSProperties = (() => {
    switch (transition) {
      case "wipe":
        return { clipPath: `inset(0 ${(1 - afterProgress) * 100}% 0 0)` };
      case "slide":
        return { transform: `translateX(${(1 - afterProgress) * 100}px) scale(${Math.max(0, afterScale)})` };
      case "fade":
      default:
        return { opacity: afterProgress, transform: `scale(${Math.max(0, afterScale)})` };
    }
  })();

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.colors.background,
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        fontFamily: theme.fonts.heading.family,
      }}
    >
      <div style={{ display: "flex", gap: 40, alignItems: "center" }}>
        <div style={{ textAlign: "center", opacity: beforeOpacity }}>
          <div
            style={{
              color: theme.colors.secondary,
              fontSize: 24,
              fontWeight: theme.fonts.body.weight,
              marginBottom: 12,
            }}
          >
            Before
          </div>
          <Img
            src={before}
            style={{
              maxWidth: 700,
              maxHeight: 500,
              borderRadius: 12,
              boxShadow: "0 10px 40px rgba(0,0,0,0.2)",
            }}
          />
        </div>
        <div style={{ textAlign: "center", ...afterTransitionStyle }}>
          <div
            style={{
              color: theme.colors.accent[0],
              fontSize: 24,
              fontWeight: theme.fonts.heading.weight,
              marginBottom: 12,
            }}
          >
            After
          </div>
          <Img
            src={after}
            style={{
              maxWidth: 700,
              maxHeight: 500,
              borderRadius: 12,
              boxShadow: "0 10px 40px rgba(0,0,0,0.2)",
            }}
          />
        </div>
      </div>
      {caption && (
        <div
          style={{
            opacity: captionOpacity,
            color: theme.colors.primary,
            fontSize: 28,
            fontWeight: theme.fonts.body.weight,
            marginTop: 32,
          }}
        >
          {caption}
        </div>
      )}
    </AbsoluteFill>
  );
};
