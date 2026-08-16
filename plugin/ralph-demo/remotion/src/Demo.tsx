import React from "react";
import { AbsoluteFill } from "remotion";

export type DemoProps = {
  title: string;
  durationInFrames: number;
};

export const demoDefaultProps: DemoProps = {
  title: "ralph demo",
  durationInFrames: 150,
};

export const Demo: React.FC<DemoProps> = ({ title }) => {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#0b0d12",
        color: "#e6e9ef",
        justifyContent: "center",
        alignItems: "center",
        fontFamily: "system-ui, sans-serif",
        fontSize: 64,
      }}
    >
      {title}
    </AbsoluteFill>
  );
};
