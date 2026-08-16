import React from "react";
import { Composition } from "remotion";
import { Demo, demoDefaultProps, type DemoProps } from "./Demo";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Demo"
      component={Demo}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={demoDefaultProps}
      // Length is a property of the input, never a constant declared beside it:
      // a hardcoded durationInFrames silently truncates any longer input.
      calculateMetadata={({ props }: { props: DemoProps }) => ({
        durationInFrames: props.durationInFrames,
      })}
    />
  );
};
