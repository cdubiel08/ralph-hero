---
name: ralph-playwright:a11y-scan
description: Run a WCAG 2.2 AA accessibility audit against a URL using playwright-cli. Captures accessibility snapshots, analyzes for violations, and creates issues for findings. Uses the execute → reflect → act pipeline with an a11y-focused goal.
allowed-tools:
  - Bash(playwright-cli *)
  - Agent
  - Read
  - Write
---

# A11y Scan — Accessibility Audit via CLI

## Prerequisites
- `playwright-cli` installed globally (see `/ralph-playwright:setup`)
- Target app running

## Process

### Step 1: Execute (freeform, a11y goal)

Generate session name: `<date>-a11y-scan-<slug>`

Spawn `explorer-agent` with:
- `url`: Target URL (from arguments or ask)
- `goal`: "Systematically audit this page for WCAG 2.2 AA accessibility compliance. Focus on: form labels, tab order, keyboard operability, color contrast ratios, ARIA attributes, heading hierarchy, alt text, and focus management."
- `session`: The generated session name

The agent navigates the page, interacts with all interactive elements (especially via keyboard), and captures snapshots at each state.

### Step 2: Reflect (a11y signals only)

Read the journey trace. For each step, examine the accessibility snapshot (`.md` file) for:

- **Missing or empty labels**: Form fields without associated `<label>` or `aria-label`
- **Broken tab order**: Elements not reachable via Tab, or illogical order
- **Keyboard inoperability**: Buttons/links not operable via Enter/Space
- **Missing ARIA**: Interactive components without `role`, `aria-expanded`, `aria-describedby` etc.
- **Heading hierarchy**: Skipped levels (h1 → h3), missing h1, multiple h1s
- **Color contrast (pixel-computed from screenshot)**: For every text run visible in the screenshot, sample the rendered foreground pixel at a glyph stroke and the immediate background pixel adjacent to it. Apply the WCAG 2.x contrast ratio formula. Flag violations per the thresholds in the pixel-computed sub-checklist below.
- **Missing alt text**: Images without `alt` attribute (existence check — presence-only; the presence-but-wrong case is handled by the next bullet)
- **Alt-text relevance (screenshot-grounded)**: For each image with a non-empty accessible name, cross-reference the author-provided text against the actual visible content in the step's screenshot PNG. Flag mismatches per the sub-procedure below. Decorative images (`alt=""`) are explicitly compliant and must be skipped.
- **Focus management**: Modals/dialogs that don't trap focus, focus not returned on close

#### Alt-text relevance sub-procedure (screenshot-grounded)

The existence check above catches missing `alt`; this sub-procedure catches the distinct failure mode where the author supplied an accessible name that does not describe what the image actually depicts. This is WCAG 2.2 SC 1.1.1 Non-text Content (Level A). The accessibility snapshot (`.md`) reports alt text verbatim (e.g., `- img "alt text here" [ref=eXX]`), but has no rendered-pixel information; the step's screenshot PNG is the authoritative record of what the sighted user sees. Opus 4.7 (or a comparably vision-capable model) is the target interlocutor — see `## Reflect model notes` below.

**(a) What to enumerate.** For each image reference in the accessibility snapshot with a non-empty accessible name, derived in this priority order:

1. `alt` attribute on `<img>` (non-empty string).
2. `aria-label` on `<img>` or on any element with `role="img"`.
3. `<figcaption>` text within an enclosing `<figure>` element.
4. `aria-labelledby` target text (resolve the referenced element's text content).

If none of the above provide a non-empty name, the image falls through to the existence check (missing alt text) and is not enumerated here.

**(b) What to skip.**

- **If the alt attribute is present but empty (`alt=""`), the image is marked as decorative by the author. Do NOT flag. Skip to the next image.** This is the WCAG-recommended pattern for purely presentational images — flagging it would be a false positive.
- Images with `aria-hidden="true"` — hidden from assistive technology by the author, out of scope for alt-relevance.
- Images that are off-screen / not visible in the captured screenshot (dynamically rendered, lazy-loaded, below the fold at capture time). No pixels to judge against.
- `<svg>` elements — their accessible name comes from `<title>` / `aria-label`; relevance scoring against rendered pixels is materially harder and is deferred to a future feature.
- CSS `background-image` regions — not `<img>` elements and typically decorative; out of scope.

**(c) The relevance judgment.** For each image with a non-empty accessible name, locate the image in the step's screenshot PNG and judge whether the accessible name accurately describes what is visible. You are reading the same screenshot the sighted user sees. Apply the rubric below.

**(d) Rubric (three grades).**

- **ACCURATE** — The accessible name captures the primary subject and intent of the image. Minor stylistic differences (e.g., "dog" vs "golden retriever") are acceptable as long as the core referent is correct.
- **PARTIAL** — The accessible name is technically related but misses the key content or is overly generic (e.g., `alt="image"`, `alt="photo"`, `alt="picture of a thing"` on an image that carries specific information). A screen-reader user would receive weaker-than-visible information but not actively misleading information.
- **INACCURATE** — The accessible name describes something not depicted in the image, or contradicts the image. A screen-reader user would be actively misled.

**(e) Emit rules.**

- ACCURATE -> no signal.
- PARTIAL -> `a11y_violation` signal, severity `low`.
- INACCURATE -> `a11y_violation` signal, severity `medium`.
- If the image appears to convey information critical to page understanding (a chart, diagram, product photo on an e-commerce page, a data visualization, a safety or warning icon), escalate severity one step: PARTIAL -> `medium`, INACCURATE -> `high`.

Reuse the existing `a11y_violation` signal type — do NOT invent a new signal-type enum value. This mirrors the `[pixel-computed]` pattern used by the contrast sub-checklist.

**(f) Signal shape.** Each emitted signal:

- `type`: `a11y_violation`.
- `severity`: per the rubric in (e) above.
- `title`: `"Alt-text mismatch: '<first 40 chars of accessible name>'"` (truncate with an ellipsis if the name is longer).
- `description` must include the following, in this order:
  - A one-line summary of the form: `Image depicts: <model's observation>. Author-provided alt/label: "<quoted text verbatim>". Relevance grade: <PARTIAL|INACCURATE>.`
  - The source of the accessible name (e.g., `source=alt`, `source=aria-label`, `source=figcaption`, `source=aria-labelledby`).
  - WCAG reference: `WCAG 2.2 SC 1.1.1 Non-text Content (Level A)`.
  - Remediation guidance: "revise the accessible name to describe the visible subject" with one concrete suggestion derived from the model's observation (e.g., `suggested alt: "Golden retriever sitting on a porch"`).
- `evidence.steps`: the step index where the image appeared in the journey trace.
- `evidence.screenshots`: that step's screenshot filename.
- `tags`: always include the literal string `alt-relevance`. Add `information-critical` when the severity was escalated per (e) above.

**(g) Forward compatibility with bounding-box evidence.** If GH-790 bounding-box output is available (the `evidence.bboxes` field has been added and populated by a predecessor step), populate `evidence.bboxes` with the image's bounding rectangle in the screenshot. If not available, omit the field. Do not fabricate coordinates.

**(h) Decorative-image sanity check (do before every run).** Before emitting any `[alt-relevance]` signals, verify that every image whose `alt` attribute is present and empty (`alt=""`) was skipped. If any `alt=""` image appears in the emitted signals, the prompt has regressed and the run must be discarded — decorative-image over-flagging is the primary false-positive risk for this feature.

This sub-procedure lives alongside the other a11y-scan reflect heuristics; it does not shadow or short-circuit the existing "Missing alt text" existence check. An image that is both missing `alt` entirely AND has a misleading `aria-label` will surface two independent signals (one from the existence check, one from this sub-procedure).

#### Pixel-computed contrast sub-checklist

The accessibility snapshot (`.md`) has no rendered-color information; contrast must be computed from the screenshot PNG captured at the same step. Opus 4.7 (or a comparably vision-capable model) is the target interlocutor — see `## Reflect model notes` below.

**(a) What to sample.** For each text run visible in the screenshot:

- Pick ONE foreground pixel at a glyph stroke (the thickest dark core of a character, not an antialiased edge). Prefer the middle of a vertical stem where present.
- Pick ONE background pixel immediately adjacent to the stroke, within ~2 px horizontally or vertically, that is not part of any other glyph.
- For text over non-uniform backgrounds (photograph, gradient, mixed-color regions): sample the **worst-case** background pixel across the text run (the background pixel that produces the smallest contrast ratio with the foreground). Flag the signal description with `"variable background: worst-case sampled"` and emit the hex of that worst-case background pixel.

**(b) What to skip.**

- Text with `opacity: 0` or equivalent invisibility that the accessibility snapshot reveals as hidden from assistive technology.
- Text rendered at less than 6 px (illegible at any contrast — a separate violation, not a contrast one).
- Decorative repetitive glyphs used as icon fonts where the accessibility snapshot marks them `aria-hidden="true"` or otherwise decorative.
- Pure whitespace or tab-stops (no glyph strokes to sample).

**(c) The formula (WCAG 2.x relative luminance + contrast ratio — quote verbatim before computing).**

```
L = 0.2126 * R_lin + 0.7152 * G_lin + 0.0722 * B_lin
where for each channel c in {R, G, B} normalized to [0, 1]:
  c_lin = c / 12.92                      if c <= 0.03928
  c_lin = ((c + 0.055) / 1.055) ^ 2.4    otherwise
ratio = (L_light + 0.05) / (L_dark + 0.05)
```

Apply the piecewise branch per channel (this is the common mis-execution point — do not skip the `c <= 0.03928` branch for very dark channels). Use `L_light` = max(L_fg, L_bg) and `L_dark` = min(L_fg, L_bg); the ratio is always >= 1.

**(d) Thresholds (WCAG 2.2 SC 1.4.3 — Contrast Minimum, AA only).**

- **Normal text**: ratio must be >= 4.5:1. Below is a fail.
- **Large text (>=18 pt / 24 px OR >=14 pt / 18.66 px bold)**: ratio must be >= 3:1. Below is a fail.
- **Heuristic for detecting large text from pixels**: text whose x-height exceeds approximately 12 px (normal weight) or approximately 10 px (bold) qualifies as large. When the weight cannot be determined confidently from pixels, note "large-text classification uncertain" in the description and apply the stricter 4.5:1 threshold (conservative).

**(e) Output shape.** For each failure, emit an `a11y_violation` signal. Reuse the existing signal type — do NOT invent a new type. The signal fields:

- `severity`:
  - `critical` if computed ratio < 3.0:1 (effectively unreadable even against the large-text threshold).
  - `high` if 3.0 <= ratio < applicable threshold.
  - `medium` if ratio is at-threshold within ±0.1:1 (ambiguous — reviewer to confirm with a dedicated color tool).
- `title`: `"Insufficient contrast: <ratio>:1 on '<first 40 chars of failing text>'"`.
- `description` must include, in this order:
  - Sampled foreground sRGB as hex (e.g., `fg=#888888`).
  - Sampled background sRGB as hex (e.g., `bg=#ffffff`). For variable backgrounds, note `bg=#<worst-case> (variable background: worst-case sampled)`.
  - Computed ratio to 2 decimal places (e.g., `ratio=3.54:1`).
  - Applicable threshold (`threshold=4.5:1` or `threshold=3:1`).
  - The failing text content (quoted, up to ~120 chars).
  - WCAG reference: `WCAG 2.2 SC 1.4.3 (Contrast — Minimum)`.
  - Remediation guidance: "increase foreground darkness by approximately N luminance points OR lighten the background" where N is the luminance delta needed to cross the threshold.
- `evidence.steps`: the step indices where the failing text is visible.
- `evidence.screenshots`: the screenshot filenames from those steps.
- `tags`: always include `"pixel-computed"` and `"wcag-1.4.3"`. Add `"large-text"` when the 3:1 large-text threshold was the applicable one. Add `"variable-background"` when the background was sampled worst-case from a non-uniform region.

**(f) Self-audit (do before emitting each `[pixel-computed]` signal).** Re-check your own arithmetic by restating each step:

```
L for fg (hex=<fg>) = <show per-channel c_lin, then L>
L for bg (hex=<bg>) = <show per-channel c_lin, then L>
ratio = (max(L_fg, L_bg) + 0.05) / (min(L_fg, L_bg) + 0.05) = <value>
applicable threshold = <4.5:1 | 3:1> (reason: <normal | large-text>)
verdict = <fail | pass>
```

Only emit the signal if the verdict is `fail`. If the restated arithmetic disagrees with the initial computation, emit the signal only if both attempts agree on `fail` and reduce severity by one step to flag the ambiguity.

This is pixel-computed; requires Opus 4.7 (or a comparable vision model) at reflect time for best accuracy. Sonnet 4.6 will produce noisier pixel estimates but the signal shape is preserved — the hex fg/bg in the description lets a reviewer recompute the ratio offline if needed.

Classify all findings as `a11y_violation` signals with WCAG success criteria references.

Write signal report to `.playwright-cli/<session>/signal-report.yaml`.

### Step 3: Act

For each signal:
1. **Critical/high**: Create GitHub issue with WCAG reference, element details, and remediation guidance
2. **Promote evidence screenshots** showing the violation context
3. **Write research note** to `thoughts/shared/research/<date>-<slug>-a11y-audit.md` with full findings

### Step 4: Report

```
== A11y Scan: http://localhost:3000/login ==
WCAG 2.2 AA | playwright-cli | N violations

🔴 CRITICAL (N):
  - <violation> → <remediation> (WCAG <criterion>)

🟠 HIGH (N):
  - <violation> → <remediation> (WCAG <criterion>)

🟡 MEDIUM (N):
  - <violation> → <remediation> (WCAG <criterion>)

Actions: N issues created, N screenshots promoted
```

## Reflect model notes

Pixel-computed contrast in Step 2 requires a vision-capable model at reflect. The pixel-sampling + WCAG-formula sub-checklist is Opus 4.7's documented sweet spot:

- **Preferred**: Opus 4.7 (2576 px image ceiling, 1:1 pixel-to-coordinate mapping, documented pixel-level transcription). Contrast estimates at default viewport resolution are reliable for body text down to ~12 px rendered.
- **Acceptable fallback**: Sonnet 4.6. The signal shape is preserved but pixel-sampling accuracy degrades proportionally with perceptual resolution. The hex fg/bg emitted in each signal description lets a reviewer recompute the ratio offline — so a noisy Sonnet pass still produces auditable output.

The alt-text relevance sub-procedure has the same model requirements — the screenshot-grounded comparison is Opus 4.7's sweet spot for the same reasons.

When the reflect-model routing feature ([#785](https://github.com/cdubiel08/ralph-hero/issues/785)) lands, the reflect model will be resolved by the env var `RALPH_PLAYWRIGHT_REFLECT_MODEL` or the skill-level preferred-model hint. This skill does not declare a new env var of its own.

## Verification fixtures

Known-shape fixtures for piloting this skill after prompt changes:

- [`plugin/ralph-playwright/fixtures/alt-relevance/`](../../fixtures/alt-relevance/README.md) — six cases (good / bad / misleading / decorative / figcaption / aria-label) exercising the alt-text relevance sub-procedure. Expected-signal oracle documents the `[alt-relevance]` signals a correctly-configured run should emit.
- [`plugin/ralph-playwright/fixtures/low-contrast/`](../../fixtures/low-contrast/README.md) — four cases (normal-fail, normal-pass, large-fail, text-over-variable-background) with documented expected ratios and a runbook for end-to-end verification of the pixel-computed contrast sub-checklist.
