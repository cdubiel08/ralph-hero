import React from "react";
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../themes/types";

interface TitleSlideProps {
  headline: string;
  subtitle?: string;
  logo?: string;
  theme: Theme;
}

export const TitleSlide: React.FC<TitleSlideProps> = ({ headline, subtitle, logo, theme }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const speed = theme.speedMultiplier;

  const headlineScale = spring({
    fps,
    frame: Math.round(frame * speed),
    config: { damping: 120 },
  });

  const subtitleOpacity = interpolate(
    frame * speed,
    [15, 30],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const subtitleY = interpolate(
    frame * speed,
    [15, 30],
    [20, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.colors.background,
        justifyContent: "center",
        alignItems: "center",
        fontFamily: theme.fonts.heading.family,
      }}
    >
      {logo && (
        <Img
          src={logo}
          style={{ height: 60, marginBottom: 24, opacity: 0.8 }}
        />
      )}
      <div
        style={{
          transform: `scale(${headlineScale})`,
          color: theme.colors.primary,
          fontSize: 72,
          fontWeight: theme.fonts.heading.weight,
          textAlign: "center",
          lineHeight: 1.1,
        }}
      >
        {headline}
      </div>
      {subtitle && (
        <div
          style={{
            opacity: subtitleOpacity,
            transform: `translateY(${subtitleY}px)`,
            color: theme.colors.secondary,
            fontSize: 36,
            fontWeight: theme.fonts.body.weight,
            marginTop: 20,
          }}
        >
          {subtitle}
        </div>
      )}
    </AbsoluteFill>
  );
};
