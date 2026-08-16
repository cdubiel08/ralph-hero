// IDIOM DEMONSTRATION — not importable code.
//
// The captions-first shape: browser footage under narration text we already
// own. There is no transcription step and no whisper dependency, because the
// agent WROTE the narration — the words exist before the video does, so
// deriving them back out of an audio track that has no audio would be
// inventing a problem.
//
// Two things here are load-bearing rather than stylistic:
//
//   1. OffthreadVideo, never <video>. Remotion extracts the exact frame it is
//      rendering rather than asking a browser element to seek; a plain <video>
//      renders whatever frame it happened to have decoded, which is how you get
//      a render that looks right in the studio and stutters in the MP4.
//   2. `durationInFrames` arrives as a prop, MEASURED. A Playwright WebM cannot
//      answer for its own length at the stream level (GH-1749: `stream=duration`
//      and `stream=nb_frames` are both N/A), so the number comes from
//      `pnpm measure` and flows through `calculateMetadata` in Root.tsx. A
//      constant declared beside the composition is exactly what truncated v1's
//      renders at 495 frames.
//
// Captions are placed on the timeline with <Sequence>, which is how Remotion
// expresses "this exists between frame A and frame B". Doing it with a
// conditional on useCurrentFrame() also works and is worse: Sequence shifts the
// child's own frame origin, so a caption can animate its own entrance without
// knowing where on the timeline it sits.

import React from "react";
import {
  AbsoluteFill,
  interpolate,
  OffthreadVideo,
  Sequence,
  useCurrentFrame,
} from "remotion";

export type Caption = {
  text: string;
  /** Timeline frames, in the COMPOSITION's fps — not the source clip's. */
  from: number;
  durationInFrames: number;
};

const CaptionBar: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame(); // 0 at this caption's own start, via Sequence
  const opacity = interpolate(frame, [0, 6], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center" }}>
      <div
        style={{
          opacity,
          maxWidth: "80%",
          margin: 72,
          padding: "20px 32px",
          borderRadius: 12,
          backgroundColor: "rgba(11, 13, 18, 0.86)",
          color: "#e6e9ef",
          fontFamily: "system-ui, sans-serif",
          fontSize: 40,
          lineHeight: 1.3,
          textAlign: "center",
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

export const CaptionedClip: React.FC<{
  /** staticFile("demo.webm") — the capture, copied into remotion/public/. */
  src: string;
  captions: Caption[];
}> = ({ src, captions }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#0b0d12" }}>
      {/*
        The capture is 800x450 (playwright-cli caps the recording at 800px on
        the long edge — a 1280x720 viewport still records at 800x450) while the
        composition is 1920x1080. `contain` letterboxes it rather than cropping
        the UI the demo exists to show; `cover` would silently eat the edges.
      */}
      <OffthreadVideo src={src} style={{ width: "100%", height: "100%", objectFit: "contain" }} />

      {captions.map((c, i) => (
        <Sequence key={i} from={c.from} durationInFrames={c.durationInFrames}>
          <CaptionBar text={c.text} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
