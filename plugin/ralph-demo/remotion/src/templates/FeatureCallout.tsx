import React from "react";
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../themes/types";

interface FeatureCalloutProps {
  name: string;
  description: string;
  icon?: string;
  illustration?: string;
  theme: Theme;
}

export const FeatureCallout: React.FC<FeatureCalloutProps> = ({
  name,
  description,
  icon,
  illustration,
  theme,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const speed = theme.speedMultiplier;

  const iconScale = spring({
    fps,
    frame: Math.round(frame * speed),
    config: { damping: 80 },
  });

  const nameOpacity = interpolate(frame * speed, [8, 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const descOpacity = interpolate(frame * speed, [18, 32], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const descY = interpolate(frame * speed, [18, 32], [15, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.colors.background,
        justifyContent: "center",
        alignItems: "center",
        fontFamily: theme.fonts.heading.family,
      }}
    >
      {icon && (
        <div
          style={{
            fontSize: 80,
            transform: `scale(${iconScale})`,
            marginBottom: 24,
          }}
        >
          {icon}
        </div>
      )}
      {illustration && (
        <Img
          src={illustration}
          style={{
            height: 120,
            transform: `scale(${iconScale})`,
            marginBottom: 24,
          }}
        />
      )}
      <div
        style={{
          opacity: nameOpacity,
          color: theme.colors.primary,
          fontSize: 56,
          fontWeight: theme.fonts.heading.weight,
          textAlign: "center",
        }}
      >
        {name}
      </div>
      <div
        style={{
          opacity: descOpacity,
          transform: `translateY(${descY}px)`,
          color: theme.colors.secondary,
          fontSize: 32,
          fontWeight: theme.fonts.body.weight,
          marginTop: 16,
          textAlign: "center",
        }}
      >
        {description}
      </div>
    </AbsoluteFill>
  );
};
