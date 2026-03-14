import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../themes/types";

interface OutroSlideProps {
  text: string;
  cta?: string;
  links?: string[];
  theme: Theme;
}

export const OutroSlide: React.FC<OutroSlideProps> = ({ text, cta, links, theme }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const speed = theme.speedMultiplier;

  const textScale = spring({
    fps,
    frame: Math.round(frame * speed),
    config: { damping: 150 },
  });

  const ctaOpacity = interpolate(frame * speed, [20, 35], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const linksOpacity = interpolate(frame * speed, [30, 45], [0, 1], {
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
      <div
        style={{
          transform: `scale(${textScale})`,
          color: theme.colors.primary,
          fontSize: 48,
          fontWeight: theme.fonts.heading.weight,
          textAlign: "center",
          maxWidth: "80%",
        }}
      >
        {text}
      </div>
      {cta && (
        <div
          style={{
            opacity: ctaOpacity,
            marginTop: 32,
            padding: "16px 48px",
            backgroundColor: theme.colors.accent[0],
            color: "#fff",
            fontSize: 28,
            fontWeight: theme.fonts.heading.weight,
            borderRadius: 12,
          }}
        >
          {cta}
        </div>
      )}
      {links && links.length > 0 && (
        <div
          style={{
            opacity: linksOpacity,
            marginTop: 24,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
          }}
        >
          {links.map((link, i) => (
            <div
              key={i}
              style={{
                color: theme.colors.accent[1] ?? theme.colors.secondary,
                fontSize: 20,
                fontWeight: theme.fonts.body.weight,
              }}
            >
              {link}
            </div>
          ))}
        </div>
      )}
    </AbsoluteFill>
  );
};
