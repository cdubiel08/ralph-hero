import React from "react";
import { Composition } from "remotion";
import { z } from "zod";
import { CompositionGenerator } from "./lib/CompositionGenerator";
import { VideoInputSchema } from "./lib/schema";
import { calculateTotalDuration } from "./lib/duration";
import { presets } from "./lib/presets";

const defaultInput = {
  date: "2026-01-01",
  team: "Demo Team",
  theme: "energetic",
  format: "16:9" as const,
  scenes: [
    { type: "title" as const, headline: "Sprint Demo", subtitle: "Sample Video" },
    { type: "feature" as const, name: "Feature One", description: "Something great" },
    { type: "bullets" as const, title: "Highlights", items: ["Fast", "Reliable", "Easy"] },
    { type: "outro" as const, text: "Thanks for watching!" },
  ],
};

export const RemotionRoot: React.FC = () => {
  const fps = 30;
  const totalFrames = calculateTotalDuration(defaultInput.scenes, fps);

  return (
    <>
      {Object.values(presets).map((preset) => (
        <Composition
          key={preset.name}
          id={preset.name}
          component={CompositionGenerator}
          durationInFrames={totalFrames}
          fps={preset.fps}
          width={preset.width}
          height={preset.height}
          schema={z.object({ input: VideoInputSchema })}
          defaultProps={{ input: defaultInput }}
        />
      ))}
    </>
  );
};
