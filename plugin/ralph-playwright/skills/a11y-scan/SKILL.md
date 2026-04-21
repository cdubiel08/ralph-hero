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
- **Color contrast (pixel-computed from screenshot)**: For every text run visible in the screenshot, sample the rendered foreground pixel at a glyph stroke and the immediate background pixel adjacent to it. Apply the WCAG 2.x contrast ratio formula. Flag violations per the thresholds below.
- **Missing alt text**: Images without `alt` attribute
- **Focus management**: Modals/dialogs that don't trap focus, focus not returned on close

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

When the reflect-model routing feature ([#785](https://github.com/cdubiel08/ralph-hero/issues/785)) lands, the reflect model will be resolved by the env var `RALPH_PLAYWRIGHT_REFLECT_MODEL` or the skill-level preferred-model hint. This skill does not declare a new env var of its own.

## Verification fixture

A known-shape low-contrast fixture lives at [`plugin/ralph-playwright/fixtures/low-contrast/`](../../fixtures/low-contrast/README.md). It exercises four cases (normal-fail, normal-pass, large-fail, text-over-variable-background) with documented expected ratios and a runbook for end-to-end verification. Use it to pilot this skill after prompt changes.
