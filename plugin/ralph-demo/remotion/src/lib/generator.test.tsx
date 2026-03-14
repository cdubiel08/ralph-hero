import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { CompositionGenerator } from "./CompositionGenerator";
import type { VideoInput } from "./schema";

// TransitionSeries requires Remotion context. Mock it to render children directly.
vi.mock("@remotion/transitions", () => {
  const Sequence = ({ children }: any) => <div>{children}</div>;
  const Transition = () => null;
  const TransitionSeries = ({ children }: any) => <div>{children}</div>;
  TransitionSeries.Sequence = Sequence;
  TransitionSeries.Transition = Transition;
  return {
    TransitionSeries,
    linearTiming: () => ({}),
    springTiming: () => ({}),
  };
});

describe("CompositionGenerator", () => {
  const sampleInput: VideoInput = {
    date: "2026-03-12",
    team: "Test Team",
    theme: "energetic",
    format: "16:9",
    scenes: [
      { type: "title", headline: "Test Demo" },
      { type: "feature", name: "Feature A", description: "Does things" },
      { type: "outro", text: "The End" },
    ],
  };

  it("renders all scene content", () => {
    const { getByText } = render(<CompositionGenerator input={sampleInput} />);
    expect(getByText("Test Demo")).toBeTruthy();
    expect(getByText("Feature A")).toBeTruthy();
    expect(getByText("The End")).toBeTruthy();
  });

  it("renders single-scene input", () => {
    const input: VideoInput = {
      date: "2026-03-12",
      team: "Test",
      theme: "energetic",
      format: "16:9",
      scenes: [{ type: "title", headline: "Solo" }],
    };
    const { getByText } = render(<CompositionGenerator input={input} />);
    expect(getByText("Solo")).toBeTruthy();
  });

  it("handles all scene types without crashing", () => {
    const input: VideoInput = {
      date: "2026-03-12",
      team: "Test",
      theme: "energetic",
      format: "16:9",
      scenes: [
        { type: "title", headline: "H" },
        { type: "feature", name: "N", description: "D" },
        { type: "screenshot", src: "s.png" },
        { type: "before-after", before: "a.png", after: "b.png" },
        { type: "bullets", title: "T", items: ["a"] },
        { type: "flow", steps: ["a", "b"] },
        { type: "outro", text: "E" },
      ],
    };
    const { container } = render(<CompositionGenerator input={input} />);
    expect(container.firstChild).toBeTruthy();
  });
});
