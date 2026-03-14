import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../themes/types";

interface BulletPointsProps {
  title: string;
  items: string[];
  icon?: string;
  theme: Theme;
}

export const BulletPoints: React.FC<BulletPointsProps> = ({ title, items, icon, theme }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const speed = theme.speedMultiplier;

  const titleOpacity = interpolate(frame * speed, [0, 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.colors.background,
        justifyContent: "center",
        alignItems: "flex-start",
        padding: "80px 120px",
        fontFamily: theme.fonts.heading.family,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 40 }}>
        {icon && <div style={{ fontSize: 40 }}>{icon}</div>}
        <div
          style={{
            opacity: titleOpacity,
            color: theme.colors.primary,
            fontSize: 48,
            fontWeight: theme.fonts.heading.weight,
          }}
        >
          {title}
        </div>
      </div>
      {items.map((item, i) => {
        const delay = 15 + i * 10;
        const itemScale = spring({
          fps,
          frame: Math.round((frame - delay / speed) * speed),
          config: { damping: 100 },
        });
        const itemOpacity = interpolate(frame * speed, [delay, delay + 10], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

        return (
          <div
            key={i}
            style={{
              opacity: itemOpacity,
              transform: `scale(${Math.max(0, itemScale)})`,
              color: theme.colors.secondary,
              fontSize: 36,
              fontWeight: theme.fonts.body.weight,
              marginBottom: 24,
              display: "flex",
              alignItems: "center",
              gap: 16,
            }}
          >
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                backgroundColor: theme.colors.accent[i % theme.colors.accent.length],
              }}
            />
            {item}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
