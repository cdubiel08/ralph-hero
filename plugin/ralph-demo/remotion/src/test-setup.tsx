import { vi } from "vitest";

// Mock Remotion hooks and components for jsdom testing.
// Remotion's hooks require internal React context providers that don't
// exist outside Remotion Studio/renderer. We mock them to return stable
// values so template components can render in jsdom.
vi.mock("remotion", async () => {
  const actual = await vi.importActual<typeof import("remotion")>("remotion");
  return {
    ...actual,
    useCurrentFrame: () => 15,
    useVideoConfig: () => ({
      fps: 30,
      width: 1920,
      height: 1080,
      durationInFrames: 150,
      id: "test",
    }),
    // Replace Remotion's Img (which uses delayRender) with a plain <img>
    Img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => {
      const { style, ...rest } = props;
      return <img style={style} {...rest} />;
    },
    // AbsoluteFill renders as a plain div in tests
    AbsoluteFill: ({ children, style, ...rest }: any) =>
      <div style={{ position: "absolute", ...style }} {...rest}>{children}</div>,
  };
});
