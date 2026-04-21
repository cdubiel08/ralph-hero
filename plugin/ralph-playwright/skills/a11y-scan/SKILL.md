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
- **Missing alt text**: Images without `alt` attribute
- **Focus management**: Modals/dialogs that don't trap focus, focus not returned on close

Classify all findings as `a11y_violation` signals with WCAG success criteria references.

Write signal report to `.playwright-cli/<session>/signal-report.yaml`.

#### When to request `--high-res` captures

A subset of a11y criteria require reading pixels from the rendered image rather than inspecting the DOM. For those, pass `high_res_steps` to `explorer-agent` (see [browser/SKILL.md § High-resolution captures](../browser/SKILL.md#high-resolution-captures) for the canonical flag syntax):

- **Pixel-computed color contrast** — computed DOM contrast lies when text sits on gradients, background images, or composited overlays. High-res captures enable sampling actual rendered pixels. (Precursor to Feature D #788.)
- **Alt-text relevance** — an alt attribute can be present and syntactically valid while being wholly unrelated to the image content. High-res makes it feasible to compare the alt text to what the image actually shows. (Precursor to Feature E #789.)
- **Small-type form labels** — labels rendered at 10-12px on hi-DPI displays can look correct in the snapshot but be unreadable in practice. High-res makes it possible to observe the rendered typography.
- **Thin / faint focus indicators** — a 1px outline at 40% opacity may technically exist but be invisible to users with mild visual impairment. Default resolution can hide this; high-res shows it clearly.

Current a11y criteria that do NOT benefit from high-res (use default resolution):

- Missing labels, missing alt attributes (DOM-only — the accessibility snapshot tells you this)
- Broken tab order, keyboard inoperability (interaction-based)
- Heading hierarchy, landmark structure (DOM-only)
- Missing ARIA attributes (DOM-only)

Rule of thumb: if the snapshot `.md` file can answer the question, use default resolution. If the question requires looking at the rendered pixels, request high-res for that specific step. Do not request high-res across the whole audit — blanket high-res roughly triples image-input token cost, which compounds against the already-aggressive screenshot cadence a11y audits use.

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
