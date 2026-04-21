---
date: 2026-04-16
topic: "Opus 4.7 vision capabilities and implications for ralph-playwright"
tags: [research, ralph-playwright, opus-4-7, vision, computer-use, visual-regression, a11y, reflect-phase]
status: complete
type: research
github_issue: 784
github_url: https://github.com/cdubiel08/ralph-hero/issues/784
---

# Research: Is Opus 4.7 now much better at eyes-on-glass tasks, and how should ralph-playwright change if so?

## Research Question
Verify whether Claude Opus 4.7 is materially better than predecessors at visual UI analysis ("eyes-on-glass"), and — if so — identify concrete improvements for the ralph-playwright plugin. The user explicitly asked for improvement ideas, so this document includes recommendations (outside the normal research skill scope of "document what is").

## Summary

**Yes, Opus 4.7 is substantially better at eyes-on-glass work.** The primary driver is a structural change — a 3x image resolution ceiling (2576px / 3.75MP, up from 1568px / 1.15MP) with 1:1 pixel-to-coordinate mapping — combined with targeted training gains on low-level perception, bounding-box detection, chart interpretation, and computer use. Public benchmarks show +5-22 point jumps over Opus 4.6 across visual reasoning, navigation, and document understanding; one partner's proprietary acuity benchmark jumped 44 points.

The ralph-playwright plugin (v0.2.0) is structurally well-positioned to benefit but currently under-uses screenshots. Today's `reflect` phase reads screenshots with a single instruction — "look for visual anomalies, layout issues, error states" — and the `regression` signal type has no mechanism because visual-diff is delegated to external tools (Chromatic/Applitools) at Storybook-story granularity only. Accessibility snapshots (the `.md` DOM trees) are the primary signal source; screenshots are secondary evidence.

Opus 4.7's capabilities map directly onto the thin spots: richer reflect prompts backed by actual pixel-level perception, pixel-computed contrast ratios, alt-text relevance validation, annotated evidence screenshots via bounding-box output, and in-loop semantic visual diff that fills the journey-level regression gap Chromatic cannot cover.

## Detailed Findings

### Part 1: Opus 4.7 visual capability verification

**Structural change.** The Anthropic API docs ([What's new in Claude Opus 4.7](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7)) state that Opus 4.7 is "our first Claude model with high-resolution image support. Maximum image resolution has increased to 2576px / 3.75MP (increased from our previous limit of 1568px / 1.15MP). This change should unlock performance gains on vision-heavy workloads, and is particularly important for computer use and screenshot/artifact/document understanding workflows." The docs also note "the model's coordinates are 1:1 with actual pixels, so there's no scale-factor math required" — directly relevant to any UI automation that maps model output to click targets.

Anthropic explicitly calls out improvements in low-level perception (pointing, measuring, counting) and image localization (bounding-box detection), plus "programmatic tool-calling with image-processing libraries (e.g. PIL) to analyze charts and figures, including pixel-level data transcription" and "producing and self-checking tracked changes and slide layouts."

**Benchmark deltas vs Opus 4.6** (sources: [Anthropic announcement](https://www.anthropic.com/news/claude-opus-4-7), [Vellum AI](https://www.vellum.ai/blog/claude-opus-4-7-benchmarks-explained), [The AI Corner](https://www.the-ai-corner.com/p/claude-opus-4-7-guide-benchmarks-2026)):

| Benchmark | Opus 4.7 | Opus 4.6 | Delta |
|---|---|---|---|
| Visual Navigation (no tools) | 79.5% | 57.7% | +21.8 pts |
| CharXiv Visual Reasoning (no tools) | 82.1% | 69.1% | +13.0 pts |
| CharXiv Visual Reasoning (with tools) | 91.0% | 84.7% | +6.3 pts |
| OSWorld-Verified (computer use) | 78.0% | 72.7% | +5.3 pts |
| OfficeQA Pro (doc reasoning) | 80.6% | 57.1% | +23.5 pts |

Anthropic's announcement also cites XBOW's proprietary visual-acuity benchmark at **98.5% for Opus 4.7 vs 54.5% for Opus 4.6**, a ~44-point jump involving dense terminal UIs and complex screens. This is partner-specific, not reproducible, but directionally consistent with the public benchmarks.

**No published comparison to Sonnet 4.6 on vision.** The benchmark tables compare Opus 4.7 to Opus 4.6, GPT-5.4, Gemini 3.1 Pro, and the unreleased Mythos Preview — not Sonnet. Because Sonnet has historically trailed Opus on vision, the gap from Sonnet 4.6 to Opus 4.7 is likely larger than the Opus-to-Opus delta but no number is published.

**Caveats.** Standard academic multimodal benchmarks (MMMU, ChartQA, DocVQA, AI2D) are not reported in any Opus 4.7 material — Anthropic has moved toward task-specific evaluations. BrowseComp shows a minor regression per The AI Corner, suggesting web-browsing visual tasks may not uniformly benefit. Higher resolution means higher token cost; the docs recommend downsampling when full fidelity is unnecessary.

### Part 2: Current ralph-playwright visual intelligence (v0.2.0)

Plugin root: `~/.claude/plugins/cache/ralph-hero/ralph-playwright/0.2.0/`.

**Pipeline architecture.** Every substantive skill composes through an Execute → Reflect → Act pipeline, with YAML schemas enforcing structure at each boundary. Execute runs a browser-automation sub-agent (`explorer-agent` for freeform, `story-runner-agent` for structured) that captures a screenshot PNG and an accessibility snapshot `.md` file at every step, records console errors via JS injection, and writes `journey-trace.yaml`. Reflect is executed by the calling model directly (not a sub-agent) — it reads each step's PNG + snapshot + console state, classifies into five signal types, and writes `signal-report.yaml`. Act promotes screenshots, writes research notes, and optionally creates GitHub issues.

**Screenshot capture is universal and required.** `schemas/journey-trace.schema.yaml:38-58` requires every step to record both `screenshot` (PNG path) and `snapshot` (`.md` path). The explorer-agent (`agents/explorer-agent.md:47-50`) and story-runner-agent (`agents/story-runner-agent.md:44-49`) both take snapshot-then-screenshot at every step. No step can conform to the schema without both captures.

**Screenshot analysis is thin.** `skills/reflect/SKILL.md:22-30` gives the model this checklist:

> 1. Read the screenshot (the PNG file at the `screenshot` path) — look for visual anomalies, layout issues, error states
> 2. Read the accessibility snapshot (the `.md` file at the `snapshot` path) — check element structure, labels, roles, ARIA attributes
> 3. Check console entries — any errors or warnings indicate issues
> 4. Check the outcome — failed steps need investigation

The visual sub-step is a single sentence with no categorization, no thresholds, no examples. The model is shown the image but given minimal guidance on what to extract.

**Signal taxonomy has an unsupported type.** `skills/reflect/SKILL.md:35-41` defines five types: `anomaly | regression | a11y_violation | ux_issue | error`. The `regression` type says "requires baseline comparison" — but no baseline-comparison mechanism exists in reflect. The `anomaly` type references "visual glitches, broken layouts" but gives no mechanism beyond the one-line prompt.

**Accessibility analysis is structural, not visual.** `skills/a11y-scan/SKILL.md:30-43` reflect step says "examine the accessibility snapshot (.md file)" — the violation identification runs against the DOM tree. Notably, `a11y-scan/SKILL.md:39` lists "color contrast ratios below 4.5:1 (normal) or 3:1 (large)" as a criterion, but the DOM tree cannot compute actual rendered contrast. This criterion is listed but unenforceable by the current mechanism.

**Visual regression is external.** `skills/visual-diff/SKILL.md` delegates entirely to Chromatic or Applitools. Both operate at Storybook-story granularity, outside the agent loop. For `explore`, `test-e2e`, and `capture`, there is no in-loop regression detection — the `regression` signal type remains mechanism-free at the journey level.

**Agent model is Sonnet, not Opus.** `agents/explorer-agent.md:4` and `agents/story-runner-agent.md:4` both specify `model: sonnet`. The reflect phase runs in the calling model's context, which today is whatever the user invoked the skill with — typically not explicitly Opus 4.7.

**Element targeting uses accessibility refs, not pixels.** Story-runner (`agents/story-runner-agent.md:50`) explicitly prohibits CSS selectors and instructs "NEVER use CSS selectors" — element discovery goes through snapshot refs like `e8`, `e21`. This works well for accessible sites but breaks on canvas renderers, custom widgets, maps, and sites with poor a11y hygiene.

### Part 3: Improvement ideas

The user explicitly asked for improvement ideas, so this section departs from normal research-doc scope.

#### High-leverage (low-effort, high-payoff)

**1. Split model routing — Opus 4.7 for Reflect, Sonnet for Execute.**
Rationale: Execute is mostly mechanical click/fill operations where Sonnet is competent and cheap. Reflect is where vision matters. Add a preferred-model hint to `skills/reflect/SKILL.md` frontmatter and a `RALPH_PLAYWRIGHT_REFLECT_MODEL` env override. Leave agent models on Sonnet.

**2. Replace the one-line reflect instruction with a structured visual audit prompt.**
Swap `skills/reflect/SKILL.md:26` for a categorized checklist matching 4.7's documented strengths:
- **Layout integrity** — overlapping elements, clipped content, horizontal overflow, z-index stacking (modals behind overlays, popovers clipped)
- **Typography** — truncation without ellipsis, ellipsis without tooltip, mixed font faces within a region, unintended size jumps
- **Imagery** — broken image placeholders, missing thumbnails, aspect-ratio squish, pixelation on retina displays
- **State visibility** — skeletons/spinners visible when data is present, empty states with no message, feedback missing after action, error styled identically to success
- **Visual hierarchy** — primary CTA not dominant, destructive actions styled as primary, secondary actions outshining primary
- **Color & contrast (new capability)** — estimate text-to-background contrast from pixels; flag < 4.5:1 for normal text and < 3:1 for large text; dark-mode inversions; info conveyed only through color
- **Chart & data UIs** — axis labels missing, legend ↔ data mismatch, bar heights inconsistent with labels, unreadable density, unlabeled units
- **Viewport/responsive** — unintended horizontal scroll, mobile rendering on desktop, content clipped at the fold

**3. Route by step importance, not globally.**
Not every step needs Opus. Use Sonnet for happy-path steps; escalate to Opus 4.7 for steps where outcome=fail or where step N-1 raised a signal. Keeps cost bounded.

#### New capabilities (fill identified gaps)

**4. Pixel-computed color contrast.**
`skills/a11y-scan/SKILL.md:39` lists contrast as a criterion but has no mechanism. With 4.7, add a contrast estimator to the reflect prompt for a11y-scan: "For each piece of text visible in the screenshot, estimate the contrast ratio against its immediate background. Flag any below 4.5:1 (or 3:1 for large text ≥18pt or 14pt bold)." Output as `a11y_violation` with tag `[pixel-computed]`, or split into a new `contrast_violation` type.

**5. Alt-text relevance validation.**
`skills/a11y-scan/SKILL.md:40` currently checks `alt` attribute existence. Extend: for each `<img>` found in the accessibility snapshot, cross-reference the actual image in the screenshot and ask 4.7 whether the alt text accurately describes the visible content. Flag mismatches as `a11y_violation` with tag `[alt-relevance]`.

**6. Annotated evidence screenshots.**
Add `bbox` to `schemas/signal-report.schema.yaml:33-46` so 4.7's bounding-box output lands in structured storage:
```yaml
evidence:
  steps: [3]
  screenshots: ["03_checkout.png"]
  bboxes:
    - screenshot: "03_checkout.png"
      x: 120
      y: 450
      w: 200
      h: 40
      note: "Truncated button label"
```
Then in act, render `03_checkout.annotated.png` with red rectangles over each bbox and numbered labels. Options: (a) extend playwright-cli with an `annotate` subcommand, (b) use a small Node helper with `sharp`, or (c) emit sidecar SVG overlays. Promote both original and annotated to `thoughts/local/assets/`.

**7. In-loop semantic visual diff (new `reflect-diff` skill or `--baseline` flag).**
Fills the mechanism-free `regression` signal type for journey-level work:
- Inputs: current `journey-trace.yaml` + baseline `journey-trace.yaml`.
- For each matching step (match by `(action, target)`, fall back to index): read current + baseline PNGs, ask 4.7 to identify meaningful visual differences while ignoring anti-aliasing, font hinting, animation frames, and timestamps.
- Output: `regression` signals with natural-language change descriptions ("Submit button moved 40px down and lost its shadow"), not just diff images.
- Baseline storage: `thoughts/local/baselines/<session-slug>/` (gitignored). Add `--update-baseline` action.
- Complements (doesn't replace) Chromatic/Applitools, which stay for Storybook-component-level work. Document the split clearly in `visual-diff/SKILL.md`.

**8. Vision-fallback element targeting.**
When the accessibility snapshot yields no ref (canvas, maps, custom widgets, bad a11y), allow story-runner and explorer to fall back to pixel-coordinate clicks using 4.7's 1:1 coordinate output. This is currently a hard failure mode.

**9. `data_interpretation` signal type.**
Add to `schemas/signal-report.schema.yaml:23` enum and `reflect/SKILL.md:35-41` taxonomy. Catches dashboard and chart-UI issues that don't fit cleanly into `anomaly` or `ux_issue`. Leverages 4.7's +13 points on CharXiv directly.

#### Capture & exploration

**10. Higher screenshot resolution for critical steps.**
Current `playwright-cli screenshot` likely captures at default viewport resolution. For steps where the reflect phase needs OCR or fine detail (tables, receipts, dense logs, charts), raise capture resolution toward 4.7's 2576px ceiling. Keep default low to bound tokens; add a `--high-res` flag used on demand (e.g. when OCR accuracy matters or for failure-step re-capture).

**11. Vision-driven exploration mode.**
`agents/explorer-agent.md` today navigates via snapshot element refs. Add an optional mode where exploration is driven primarily by screenshot understanding — parallels Anthropic's "computer use" pattern. Useful for sites with poor a11y hygiene where snapshot-ref navigation gets stuck.

**12. Sad-path inference from screenshots in story-gen.**
`skills/story-gen/SKILL.md:44-52` uses eight hardcoded sad-path heuristics. With 4.7, optionally inspect the actual UI and propose sad paths grounded in what's visible — missing error handlers, empty states not designed, tooltips cut off at viewport edge, form fields without visible validation hints.

## Code References

- `~/.claude/plugins/cache/ralph-hero/ralph-playwright/0.2.0/skills/reflect/SKILL.md:22-30` — the 4-line reflect checklist; sub-step 1 is the thin visual-analysis instruction
- `~/.claude/plugins/cache/ralph-hero/ralph-playwright/0.2.0/skills/reflect/SKILL.md:35-41` — signal taxonomy table; `regression` has no mechanism today
- `~/.claude/plugins/cache/ralph-hero/ralph-playwright/0.2.0/skills/a11y-scan/SKILL.md:39` — contrast ratio listed as criterion, unenforceable by DOM-only mechanism
- `~/.claude/plugins/cache/ralph-hero/ralph-playwright/0.2.0/skills/visual-diff/SKILL.md` — fully delegated to Chromatic/Applitools at Storybook granularity
- `~/.claude/plugins/cache/ralph-hero/ralph-playwright/0.2.0/schemas/signal-report.schema.yaml:23` — signal-type enum; add `data_interpretation` (and optionally `contrast_violation`)
- `~/.claude/plugins/cache/ralph-hero/ralph-playwright/0.2.0/schemas/signal-report.schema.yaml:33-46` — evidence block; add `bboxes` sub-field for bounding-box outputs
- `~/.claude/plugins/cache/ralph-hero/ralph-playwright/0.2.0/schemas/journey-trace.schema.yaml:38-58` — step schema requires both `screenshot` and `snapshot`; no capture can opt out
- `~/.claude/plugins/cache/ralph-hero/ralph-playwright/0.2.0/agents/explorer-agent.md:4` and `agents/story-runner-agent.md:4` — both specify `model: sonnet`
- `~/.claude/plugins/cache/ralph-hero/ralph-playwright/0.2.0/agents/story-runner-agent.md:50` — "NEVER use CSS selectors", forcing accessibility-ref navigation

## Architecture Documentation

The Execute → Reflect → Act pipeline is strict and schema-enforced. Hooks in `hooks/scripts/validate-primitive-io.sh` validate journey-trace, signal-report, and action-log YAMLs at Read and Write boundaries, blocking non-conforming artifacts. Screenshots and accessibility snapshots are captured side-by-side at every step; the reflect phase reads both. Today, accessibility snapshots drive most classification and element targeting; screenshots are captured universally but analyzed thinly. No in-loop cross-step or cross-run screenshot comparison exists.

## Historical Context (from thoughts/)

No substantive prior research on ralph-playwright vision capabilities, model selection for visual analysis, or Opus 4.7 evaluation was found in `thoughts/shared/research/` or `thoughts/shared/plans/`. An automated locator agent returned plausible-sounding filenames (vision-parity-trajectory-analysis, plan-of-plans-model-switching) that do not exist on disk — disregarded.

## Open Questions

- **Token cost delta** — Opus 4.7 at 2576px resolution is materially more expensive per screenshot than Sonnet at 1568px. Needs empirical measurement against typical `explore` and `test-e2e` session lengths before committing to model-split defaults.
- **Bounding-box output format stability** — Does Opus 4.7 reliably emit structured bbox coordinates in response to "return findings as JSON with x/y/w/h"? If free-form, needs a light parser or tool-use schema.
- **Annotated-screenshot rendering** — Which of the three options (playwright-cli extension, Node helper, SVG sidecar) best fits ralph-playwright's minimal-dependencies posture.
- **Semantic-diff noise floor** — How much "ignore rendering noise" can be trusted? Pilot on a real journey with known changes before making it the regression default.
- **Vision-first exploration success rate** — Does vision-only navigation actually succeed on sites with poor a11y, or does it hit its own failure modes?

## Sources

- [Anthropic: What's new in Claude Opus 4.7](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7)
- [Anthropic: Introducing Claude Opus 4.7](https://www.anthropic.com/news/claude-opus-4-7)
- [Vellum AI: Claude Opus 4.7 Benchmarks Explained](https://www.vellum.ai/blog/claude-opus-4-7-benchmarks-explained)
- [The AI Corner: Claude Opus 4.7 benchmarks and migration guide](https://www.the-ai-corner.com/p/claude-opus-4-7-guide-benchmarks-2026)
- [CNBC: Anthropic releases Claude Opus 4.7](https://www.cnbc.com/2026/04/16/anthropic-claude-opus-4-7-model-mythos.html)
- [VentureBeat: Anthropic releases Claude Opus 4.7](https://venturebeat.com/technology/anthropic-releases-claude-opus-4-7-narrowly-retaking-lead-for-most-powerful-generally-available-llm)
- [AWS: Claude Opus 4.7 in Amazon Bedrock](https://aws.amazon.com/about-aws/whats-new/2026/04/claude-opus-4.7-amazon-bedrock/)
