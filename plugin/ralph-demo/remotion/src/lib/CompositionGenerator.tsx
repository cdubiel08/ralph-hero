import React from "react";
import { TransitionSeries } from "@remotion/transitions";
import type { VideoInput, Scene } from "./schema";
import { sceneDurationFrames } from "./duration";
import { resolveTheme } from "../themes";
import { getTransitionPresentation, getTransitionTiming } from "../transitions";
import { TitleSlide } from "../templates/TitleSlide";
import { FeatureCallout } from "../templates/FeatureCallout";
import { ScreenshotShowcase } from "../templates/ScreenshotShowcase";
import { BeforeAfter } from "../templates/BeforeAfter";
import { BulletPoints } from "../templates/BulletPoints";
import { FlowDiagram } from "../templates/FlowDiagram";
import { OutroSlide } from "../templates/OutroSlide";
import type { Theme } from "../themes/types";

function renderScene(scene: Scene, theme: Theme): React.ReactNode {
  const { type, durationSeconds: _, ...sceneProps } = scene;
  const props = { ...sceneProps, theme };

  switch (type) {
    case "title":
      return <TitleSlide {...(props as React.ComponentProps<typeof TitleSlide>)} />;
    case "feature":
      return <FeatureCallout {...(props as React.ComponentProps<typeof FeatureCallout>)} />;
    case "screenshot":
      return <ScreenshotShowcase {...(props as React.ComponentProps<typeof ScreenshotShowcase>)} />;
    case "before-after":
      return <BeforeAfter {...(props as React.ComponentProps<typeof BeforeAfter>)} />;
    case "bullets":
      return <BulletPoints {...(props as React.ComponentProps<typeof BulletPoints>)} />;
    case "flow":
      return <FlowDiagram {...(props as React.ComponentProps<typeof FlowDiagram>)} />;
    case "outro":
      return <OutroSlide {...(props as React.ComponentProps<typeof OutroSlide>)} />;
  }
}

interface CompositionGeneratorProps {
  input: VideoInput;
}

export const CompositionGenerator: React.FC<CompositionGeneratorProps> = ({ input }) => {
  const theme = resolveTheme(input.theme);
  const fps = 30;
  const transitionPresentation = getTransitionPresentation(theme.transition);
  const transitionTiming = getTransitionTiming(
    theme.easing.enter === "spring" ? "spring" : "linear",
    15
  );

  return (
    <TransitionSeries>
      {input.scenes.map((scene, i) => (
        <React.Fragment key={i}>
          <TransitionSeries.Sequence durationInFrames={sceneDurationFrames(scene, fps)}>
            {renderScene(scene, theme)}
          </TransitionSeries.Sequence>
          {i < input.scenes.length - 1 && transitionPresentation && (
            <TransitionSeries.Transition
              presentation={transitionPresentation}
              timing={transitionTiming}
            />
          )}
        </React.Fragment>
      ))}
    </TransitionSeries>
  );
};
