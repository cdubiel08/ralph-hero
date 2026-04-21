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
- **Color contrast**: Text against background ratios below 4.5:1 (normal) or 3:1 (large)
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

## Verification fixtures

Known-shape fixtures for piloting this skill after prompt changes:

- [`plugin/ralph-playwright/fixtures/alt-relevance/`](../../fixtures/alt-relevance/README.md) — six cases (good / bad / misleading / decorative / figcaption / aria-label) exercising the alt-text relevance sub-procedure. Expected-signal oracle documents the `[alt-relevance]` signals a correctly-configured run should emit.
