import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../themes/types";

interface FlowDiagramProps {
  steps: string[];
  direction?: "horizontal" | "vertical";
  caption?: string;
  theme: Theme;
}

export const FlowDiagram: React.FC<FlowDiagramProps> = ({
  steps,
  direction = "horizontal",
  caption,
  theme,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const speed = theme.speedMultiplier;
  const isHorizontal = direction === "horizontal";

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.colors.background,
        justifyContent: "center",
        alignItems: "center",
        fontFamily: theme.fonts.heading.family,
        padding: 80,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: isHorizontal ? "row" : "column",
          alignItems: "center",
          gap: 0,
        }}
      >
        {steps.map((step, i) => {
          const delay = i * 15;
          const nodeScale = spring({
            fps,
            frame: Math.round((frame - delay / speed) * speed),
            config: { damping: 80 },
          });
          const nodeOpacity = interpolate(frame * speed, [delay, delay + 10], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });

          const arrowOpacity =
            i < steps.length - 1
              ? interpolate(frame * speed, [delay + 8, delay + 16], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                })
              : 0;

          return (
            <React.Fragment key={i}>
              <div
                style={{
                  opacity: nodeOpacity,
                  transform: `scale(${Math.max(0, nodeScale)})`,
                  backgroundColor: theme.colors.accent[i % theme.colors.accent.length],
                  color: "#fff",
                  padding: "20px 36px",
                  borderRadius: 12,
                  fontSize: 28,
                  fontWeight: theme.fonts.heading.weight,
                  textAlign: "center",
                  minWidth: 140,
                }}
              >
                {step}
              </div>
              {i < steps.length - 1 && (
                <div
                  style={{
                    opacity: arrowOpacity,
                    color: theme.colors.secondary,
                    fontSize: 32,
                    padding: isHorizontal ? "0 16px" : "16px 0",
                    transform: isHorizontal ? "none" : "rotate(90deg)",
                  }}
                >
                  →
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
      {caption && (
        <div
          style={{
            marginTop: 40,
            color: theme.colors.primary,
            fontSize: 24,
            opacity: interpolate(
              frame * speed,
              [steps.length * 15 + 10, steps.length * 15 + 25],
              [0, 1],
              { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
            ),
          }}
        >
          {caption}
        </div>
      )}
    </AbsoluteFill>
  );
};
