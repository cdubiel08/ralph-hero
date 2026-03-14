import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TitleSlide } from "./TitleSlide";
import { FeatureCallout } from "./FeatureCallout";
import { BulletPoints } from "./BulletPoints";
import { OutroSlide } from "./OutroSlide";
import { ScreenshotShowcase } from "./ScreenshotShowcase";
import { BeforeAfter } from "./BeforeAfter";
import { FlowDiagram } from "./FlowDiagram";
import { energeticTheme } from "../themes";

describe("TitleSlide", () => {
  it("renders headline text", () => {
    const { getByText } = render(
      <TitleSlide headline="Sprint 42 Demo" theme={energeticTheme} />
    );
    expect(getByText("Sprint 42 Demo")).toBeTruthy();
  });

  it("renders subtitle when provided", () => {
    const { getByText } = render(
      <TitleSlide headline="Sprint 42" subtitle="Pipeline Updates" theme={energeticTheme} />
    );
    expect(getByText("Pipeline Updates")).toBeTruthy();
  });

  it("renders logo image when provided", () => {
    const { container } = render(
      <TitleSlide headline="Sprint 42" logo="logo.png" theme={energeticTheme} />
    );
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("src")).toBe("logo.png");
  });
});

describe("FeatureCallout", () => {
  it("renders feature name and description", () => {
    const { getByText } = render(
      <FeatureCallout name="Batch Processing" description="10x faster" theme={energeticTheme} />
    );
    expect(getByText("Batch Processing")).toBeTruthy();
    expect(getByText("10x faster")).toBeTruthy();
  });

  it("renders icon when provided", () => {
    const { getByText } = render(
      <FeatureCallout name="Speed" description="Fast" icon="⚡" theme={energeticTheme} />
    );
    expect(getByText("⚡")).toBeTruthy();
  });

  it("renders illustration image when provided", () => {
    const { container } = render(
      <FeatureCallout name="X" description="Y" illustration="feat.svg" theme={energeticTheme} />
    );
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("src")).toBe("feat.svg");
  });
});

describe("BulletPoints", () => {
  it("renders title and all items", () => {
    const { getByText } = render(
      <BulletPoints
        title="By the Numbers"
        items={["10x throughput", "40% less config", "Zero downtime"]}
        theme={energeticTheme}
      />
    );
    expect(getByText("By the Numbers")).toBeTruthy();
    expect(getByText("10x throughput")).toBeTruthy();
    expect(getByText("40% less config")).toBeTruthy();
    expect(getByText("Zero downtime")).toBeTruthy();
  });

  it("renders icon when provided", () => {
    const { getByText } = render(
      <BulletPoints title="Stats" items={["One"]} icon="📊" theme={energeticTheme} />
    );
    expect(getByText("📊")).toBeTruthy();
  });
});

describe("OutroSlide", () => {
  it("renders closing text", () => {
    const { getByText } = render(
      <OutroSlide text="Questions? Reach out in #platform-team" theme={energeticTheme} />
    );
    expect(getByText("Questions? Reach out in #platform-team")).toBeTruthy();
  });

  it("renders CTA when provided", () => {
    const { getByText } = render(
      <OutroSlide text="Thanks!" cta="Try it now" theme={energeticTheme} />
    );
    expect(getByText("Try it now")).toBeTruthy();
  });

  it("renders links when provided", () => {
    const { getByText } = render(
      <OutroSlide text="Thanks!" links={["docs.example.com", "slack.example.com"]} theme={energeticTheme} />
    );
    expect(getByText("docs.example.com")).toBeTruthy();
    expect(getByText("slack.example.com")).toBeTruthy();
  });
});

describe("ScreenshotShowcase", () => {
  it("renders image element", () => {
    const { container } = render(
      <ScreenshotShowcase src="test.png" theme={energeticTheme} />
    );
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("src")).toBe("test.png");
  });

  it("renders highlight labels", () => {
    const { getByText } = render(
      <ScreenshotShowcase
        src="test.png"
        highlights={[{ x: 0, y: 0, w: 100, h: 100, label: "New feature" }]}
        theme={energeticTheme}
      />
    );
    expect(getByText("New feature")).toBeTruthy();
  });

  it("renders caption when provided", () => {
    const { getByText } = render(
      <ScreenshotShowcase src="test.png" caption="Dashboard view" theme={energeticTheme} />
    );
    expect(getByText("Dashboard view")).toBeTruthy();
  });
});

describe("BeforeAfter", () => {
  it("renders Before and After labels", () => {
    const { getByText } = render(
      <BeforeAfter before="old.png" after="new.png" theme={energeticTheme} />
    );
    expect(getByText("Before")).toBeTruthy();
    expect(getByText("After")).toBeTruthy();
  });

  it("renders caption when provided", () => {
    const { getByText } = render(
      <BeforeAfter before="old.png" after="new.png" caption="Simplified config" theme={energeticTheme} />
    );
    expect(getByText("Simplified config")).toBeTruthy();
  });

  it("accepts transition prop", () => {
    const { getByText } = render(
      <BeforeAfter before="old.png" after="new.png" transition="wipe" theme={energeticTheme} />
    );
    expect(getByText("Before")).toBeTruthy();
  });
});

describe("FlowDiagram", () => {
  it("renders all steps", () => {
    const { getByText } = render(
      <FlowDiagram steps={["Input", "Process", "Output"]} theme={energeticTheme} />
    );
    expect(getByText("Input")).toBeTruthy();
    expect(getByText("Process")).toBeTruthy();
    expect(getByText("Output")).toBeTruthy();
  });

  it("renders caption when provided", () => {
    const { getByText } = render(
      <FlowDiagram steps={["A", "B"]} caption="Data flow" theme={energeticTheme} />
    );
    expect(getByText("Data flow")).toBeTruthy();
  });
});
