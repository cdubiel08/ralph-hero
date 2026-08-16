import React from "react";
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export type Caption = { from: number; durationInFrames: number; text: string };

export type Slide =
  | { kind: "title"; from: number; durationInFrames: number; eyebrow: string; title: string; subtitle: string }
  | { kind: "statement"; from: number; durationInFrames: number; heading: string; lines: string[] }
  | { kind: "terminal"; from: number; durationInFrames: number; heading: string; command: string; output: string[] }
  | { kind: "table"; from: number; durationInFrames: number; heading: string; columns: string[]; rows: string[][] };

export type DemoProps = {
  title: string;
  durationInFrames: number;
  slides: Slide[];
  captions: Caption[];
};

const BG = "#0b0d12";
const FG = "#e6e9ef";
const DIM = "#8b93a7";
const ACCENT = "#7cc4ff";
const GREEN = "#7ee787";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const SANS = "system-ui, -apple-system, Helvetica, Arial, sans-serif";

const CAPTION_BAND = 190; // px reserved at the bottom; slides never draw into it

const useEnter = (delay = 0) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ fps, frame: frame - delay, config: { damping: 120 } });
  return { opacity: s, transform: `translateY(${interpolate(s, [0, 1], [18, 0])}px)` };
};

const SlideFrame: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      padding: "96px 120px",
      paddingBottom: CAPTION_BAND + 40,
      justifyContent: "center",
      fontFamily: SANS,
      color: FG,
    }}
  >
    {children}
  </AbsoluteFill>
);

const TitleSlide: React.FC<Extract<Slide, { kind: "title" }>> = ({ eyebrow, title, subtitle }) => {
  const a = useEnter(0);
  const b = useEnter(6);
  const c = useEnter(12);
  return (
    <SlideFrame>
      <div style={{ ...a, fontFamily: MONO, fontSize: 34, color: ACCENT, letterSpacing: 2 }}>{eyebrow}</div>
      <div style={{ ...b, fontSize: 88, fontWeight: 700, lineHeight: 1.1, marginTop: 24, whiteSpace: "pre-line" }}>
        {title}
      </div>
      <div style={{ ...c, fontSize: 40, color: DIM, marginTop: 28 }}>{subtitle}</div>
    </SlideFrame>
  );
};

const StatementSlide: React.FC<Extract<Slide, { kind: "statement" }>> = ({ heading, lines }) => {
  const h = useEnter(0);
  return (
    <SlideFrame>
      <div style={{ ...h, fontSize: 62, fontWeight: 700 }}>{heading}</div>
      <div style={{ marginTop: 44 }}>
        {lines.map((line, i) => (
          <StatementLine key={i} text={line} delay={10 + i * 8} />
        ))}
      </div>
    </SlideFrame>
  );
};

const StatementLine: React.FC<{ text: string; delay: number }> = ({ text, delay }) => {
  const s = useEnter(delay);
  return (
    <div style={{ ...s, display: "flex", gap: 20, marginBottom: 22, fontSize: 40, lineHeight: 1.35 }}>
      <span style={{ color: ACCENT }}>▸</span>
      <span>{text}</span>
    </div>
  );
};

const TerminalSlide: React.FC<Extract<Slide, { kind: "terminal" }>> = ({ heading, command, output }) => {
  const frame = useCurrentFrame();
  const h = useEnter(0);
  const typedChars = Math.floor(interpolate(frame, [8, 8 + command.length], [0, command.length], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  }));
  const outputStart = 8 + command.length + 12;
  return (
    <SlideFrame>
      <div style={{ ...h, fontSize: 46, fontWeight: 700, marginBottom: 28 }}>{heading}</div>
      <div
        style={{
          background: "#05070b",
          border: "1px solid #1e2534",
          borderRadius: 14,
          padding: "34px 40px",
          fontFamily: MONO,
          fontSize: 27,
          lineHeight: 1.55,
        }}
      >
        <div style={{ color: GREEN, whiteSpace: "pre-wrap" }}>
          <span style={{ color: DIM }}>$ </span>
          {command.slice(0, typedChars)}
        </div>
        <div style={{ marginTop: 18 }}>
          {output.map((line, i) => {
            const op = interpolate(frame, [outputStart + i * 5, outputStart + i * 5 + 8], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
            return (
              <div
                key={i}
                style={{
                  opacity: op,
                  whiteSpace: "pre-wrap",
                  color: line.startsWith("  ") ? DIM : FG,
                }}
              >
                {line}
              </div>
            );
          })}
        </div>
      </div>
    </SlideFrame>
  );
};

const TableSlide: React.FC<Extract<Slide, { kind: "table" }>> = ({ heading, columns, rows }) => {
  const h = useEnter(0);
  return (
    <SlideFrame>
      <div style={{ ...h, fontSize: 62, fontWeight: 700, marginBottom: 40 }}>{heading}</div>
      <div style={{ fontFamily: MONO, fontSize: 40 }}>
        <TableRow cells={columns} delay={10} header />
        {rows.map((r, i) => (
          <TableRow key={i} cells={r} delay={18 + i * 10} />
        ))}
      </div>
    </SlideFrame>
  );
};

const TableRow: React.FC<{ cells: string[]; delay: number; header?: boolean }> = ({ cells, delay, header }) => {
  const s = useEnter(delay);
  return (
    <div
      style={{
        ...s,
        display: "grid",
        gridTemplateColumns: `1.6fr repeat(${cells.length - 1}, 1fr)`,
        padding: "18px 8px",
        borderBottom: "1px solid #1e2534",
        color: header ? DIM : FG,
      }}
    >
      {cells.map((c, i) => (
        <span key={i}>{c}</span>
      ))}
    </div>
  );
};

const renderSlide = (slide: Slide) => {
  switch (slide.kind) {
    case "title":
      return <TitleSlide {...slide} />;
    case "statement":
      return <StatementSlide {...slide} />;
    case "terminal":
      return <TerminalSlide {...slide} />;
    case "table":
      return <TableSlide {...slide} />;
  }
};

const CaptionBar: React.FC<{ text: string; durationInFrames: number }> = ({ text, durationInFrames }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(
    frame,
    [0, 6, durationInFrames - 6, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 56 }}>
      <div
        style={{
          opacity,
          maxWidth: 1560,
          background: "rgba(5,7,11,0.92)",
          border: "1px solid #1e2534",
          borderRadius: 12,
          padding: "22px 34px",
          fontFamily: SANS,
          fontSize: 38,
          lineHeight: 1.3,
          color: FG,
          textAlign: "center",
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

export const demoDefaultProps: DemoProps = {
  title: "ralph demo",
  durationInFrames: 150,
  slides: [
    { kind: "title", from: 0, durationInFrames: 150, eyebrow: "GH-0000", title: "ralph demo", subtitle: "scaffold default" },
  ],
  captions: [],
};

export const Demo: React.FC<DemoProps> = ({ slides, captions }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: BG }}>
      {slides.map((slide, i) => (
        <Sequence key={i} from={slide.from} durationInFrames={slide.durationInFrames}>
          {renderSlide(slide)}
        </Sequence>
      ))}
      {captions.map((c, i) => (
        <Sequence key={`c${i}`} from={c.from} durationInFrames={c.durationInFrames}>
          <CaptionBar text={c.text} durationInFrames={c.durationInFrames} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
