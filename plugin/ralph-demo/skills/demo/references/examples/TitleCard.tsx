// IDIOM DEMONSTRATION — not importable code.
//
// Copy the shapes, not the file. The composition you write for a given demo is
// bespoke: it knows what shipped, so its title card, its pacing and its palette
// are yours to choose. What this shows is how Remotion wants animation
// expressed — `spring` for entrances, `interpolate` for everything on a
// timeline, both derived from `useCurrentFrame()` and never from state or a
// timer. A render is a pure function of the frame number; anything that
// remembers a previous frame renders differently under Remotion's parallel
// workers than it does in the studio.

import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export const TitleCard: React.FC<{
  headline: string;
  subtitle?: string;
}> = ({ headline, subtitle }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // spring() is frame-based and deterministic: same frame, same value, in the
  // studio and on every render worker.
  const scale = spring({ fps, frame, config: { damping: 120 } });

  // interpolate() with both extrapolations clamped is the safe default — an
  // unclamped ramp keeps going past its range and silently produces opacity 3.
  const subtitleOpacity = interpolate(frame, [15, 30], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const subtitleY = interpolate(frame, [15, 30], [20, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#0b0d12",
        justifyContent: "center",
        alignItems: "center",
        fontFamily: "system-ui, sans-serif",
        padding: 96,
      }}
    >
      <div
        style={{
          transform: `scale(${scale})`,
          color: "#e6e9ef",
          fontSize: 72,
          fontWeight: 700,
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
            color: "#8b93a7",
            fontSize: 34,
            marginTop: 24,
            textAlign: "center",
          }}
        >
          {subtitle}
        </div>
      )}
    </AbsoluteFill>
  );
};
