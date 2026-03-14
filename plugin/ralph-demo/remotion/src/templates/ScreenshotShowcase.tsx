import React from "react";
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../themes/types";

interface Highlight {
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
}

interface ScreenshotShowcaseProps {
  src: string;
  highlights?: Highlight[];
  caption?: string;
  zoom?: number;
  theme: Theme;
}

export const ScreenshotShowcase: React.FC<ScreenshotShowcaseProps> = ({
  src,
  highlights = [],
  caption,
  zoom = 1,
  theme,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const speed = theme.speedMultiplier;

  const imgScale = interpolate(frame * speed, [0, 30], [0.9, zoom], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const imgOpacity = interpolate(frame * speed, [0, 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.colors.background,
        justifyContent: "center",
        alignItems: "center",
        fontFamily: theme.fonts.body.family,
      }}
    >
      <div
        style={{
          position: "relative",
          opacity: imgOpacity,
          transform: `scale(${imgScale})`,
        }}
      >
        <Img
          src={src}
          style={{
            maxWidth: "85%",
            maxHeight: "75%",
            borderRadius: 12,
            boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
          }}
        />
        {highlights.map((h, i) => {
          const delay = 25 + i * 12;
          const highlightOpacity = interpolate(frame * speed, [delay, delay + 10], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          const pulseScale = spring({
            fps,
            frame: Math.round((frame - delay / speed) * speed),
            config: { damping: 60 },
          });

          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: h.x,
                top: h.y,
                width: h.w,
                height: h.h,
                border: `3px solid ${theme.colors.accent[0]}`,
                borderRadius: 8,
                opacity: highlightOpacity,
                transform: `scale(${Math.max(0, pulseScale)})`,
              }}
            >
              {h.label && (
                <div
                  style={{
                    position: "absolute",
                    bottom: -32,
                    left: 0,
                    backgroundColor: theme.colors.accent[0],
                    color: "#fff",
                    padding: "4px 12px",
                    borderRadius: 4,
                    fontSize: 14,
                    fontWeight: theme.fonts.body.weight,
                    whiteSpace: "nowrap",
                  }}
                >
                  {h.label}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {caption && (
        <div
          style={{
            marginTop: 24,
            color: theme.colors.secondary,
            fontSize: 24,
            opacity: interpolate(frame * speed, [20, 35], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          {caption}
        </div>
      )}
    </AbsoluteFill>
  );
};
