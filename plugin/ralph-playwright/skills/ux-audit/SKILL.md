---
name: ralph-playwright:ux-audit
description: Evaluate a live website against current (2026) UX/UI design trends using playwright-cli. Scores the site across 8 trend categories with a detailed rubric, captures evidence screenshots, and produces a research note with actionable recommendations. Use this skill whenever someone asks about UX modernness, design trends compliance, whether a site feels "current" or "dated", wants a UX review or audit focused on visual and interaction trends, asks how their site compares to modern design standards, mentions bento grids, dopamine design, spatial UI, agentic UX, or multimodal interfaces in a review context, or wants to know what UX improvements would have the most impact. Also trigger when someone asks to "audit the UX" or "review the design" of a running site — even if they don't mention specific trends.
allowed-tools:
  - Bash(playwright-cli *)
  - Agent
  - Read
  - Write
---

# UX Trend Audit — Live URL Evaluation Against 2026 Design Standards

Evaluate a running website against 8 current UX/UI trend categories. The audit uses playwright-cli to capture real screenshots and accessibility snapshots, then scores what it observes against a detailed rubric. The output is a scored research note with evidence and prioritized recommendations.

This skill exists because design trends shift faster than most teams can track. A site that felt modern 18 months ago may now look dated — not because anything broke, but because user expectations evolved. The audit gives teams a concrete, evidence-backed picture of where they stand and what to prioritize.

## Prerequisites
- `playwright-cli` installed globally (see `/ralph-playwright:setup`)
- Target app running (localhost or any accessible URL)

## Process

### Step 1: Gather Context

Ask for (or extract from arguments):
- **URL** to audit (required)
- **Site type** — SaaS dashboard, marketing site, e-commerce, docs, blog, internal tool (helps calibrate expectations — a docs site and a marketing site have different trend baselines)
- **Target audience** — developers, consumers, enterprise, general public
- **Specific concerns** — any particular areas the user wants focus on (optional)

If the user provides just a URL, infer site type from the first page load.

### Step 2: Execute (deep multi-viewport exploration)

Good UX audits need raw evidence from multiple viewports and interaction states. The more you capture now, the more confident the scoring in Step 3 will be. Don't shortcut the exploration — it's the foundation.

Generate session name: `<date>-ux-audit-<slug>`

#### 2a: Primary exploration (desktop viewport, 1280px)

Spawn `explorer-agent` with:
- `url`: Target URL
- `goal`: "Systematically explore this site to evaluate its UX design. Visit at least 5-8 distinct pages or states (home, key feature pages, about/pricing if available, any logged-in states, error states). On each page: (1) scroll fully top-to-bottom to trigger scroll-based animations and lazy content, (2) hover over buttons, cards, and nav items to observe hover states and micro-interactions, (3) interact with any forms, search bars, or input fields, (4) click through the navigation to test wayfinding, (5) note any modals, drawers, or progressive disclosure patterns. Capture a screenshot and accessibility snapshot after each meaningful interaction, not just each page."
- `session`: The generated session name

#### 2b: Responsive exploration (mobile + tablet)

After the primary exploration completes, run two additional focused passes to evaluate responsive behavior. These are essential for scoring Layout Innovation and Accessibility accurately.

**Mobile pass (375px viewport):**
```bash
playwright-cli --viewport 375x812 navigate <url>
```
On mobile, specifically check:
- Does the layout reflow or just shrink?
- Is there a hamburger/mobile nav? Does it open and close correctly?
- Are touch targets at least 44x44px?
- Do horizontal scroll issues appear?
- Capture 3-5 screenshots: home, nav open, a content page, a form if available

**Tablet pass (768px viewport):**
```bash
playwright-cli --viewport 768x1024 navigate <url>
```
Check the in-between breakpoint — many sites break here. Capture 2-3 screenshots of key pages.

**Wide desktop pass (1920px viewport):**
```bash
playwright-cli --viewport 1920x1080 navigate <url>
```
Check whether content stretches uncontrollably or is properly constrained. Capture 1-2 screenshots.

#### 2c: Interaction-specific probes

After the viewport passes, run targeted checks that the general exploration may have missed:

- **Scroll behavior**: Navigate to the homepage, scroll slowly from top to bottom. Do animations trigger? Is content hidden until scroll (content gating)?
- **Keyboard navigation**: Tab through the first page. Are focus indicators visible? Can you reach all interactive elements?
- **Console health**: Check for JS errors, failed resource loads, or deprecation warnings that indicate broken animations or interactions
- **Performance signal**: Note initial load time from playwright-cli output — relevant to Spatial & Motion scoring (heavy 3D/WebGL will show up here)

Aim for **15-25 total screenshots** across all passes. More evidence means more confident scoring.

### Step 3: Reflect (trend-focused analysis)

Read the journey trace from `.playwright-cli/<session>/journey-trace.yaml`.

Before scoring, read the rubric reference file — it contains the detailed criteria for each trend category and score level:
```
Glob pattern: **/ux-audit/references/ux-trends-2026.md
```

For each step in the trace:
1. **Read the screenshot** (PNG) — observe layout, color, typography, spacing, visual effects
2. **Read the accessibility snapshot** (MD) — check semantic structure, ARIA usage, heading hierarchy
3. **Note console warnings/errors** — broken animations, failed asset loads, JS errors

Also review the multi-viewport screenshots from Step 2b:
- Compare mobile vs. desktop layouts — does the design *adapt* or just *shrink*?
- Note any breakpoint-specific bugs (overlapping elements, broken nav, horizontal scroll)
- Check touch target sizes on mobile captures
- Note whether wide desktop content is properly constrained

And the interaction probes from Step 2c:
- Were scroll animations present? Did they gate content (content invisible without scrolling)?
- Were keyboard focus indicators visible and styled?
- Any console errors or failed loads?

Score each of the 8 trend categories (1-5) using the rubric. Base scores on what you actually observe across all captured pages and viewports — not assumptions. If a category can't be evaluated from the captured evidence (e.g., no forms were encountered, so multimodal can't be assessed), mark it as "Not Observed" rather than guessing.

**Scoring approach:**
- Score each category independently
- Use the rubric's concrete indicators at each level — don't interpolate
- When evidence spans two levels, use the lower score but note the higher-level elements present
- Weight consistency across pages: a single innovative page surrounded by dated pages scores lower than consistent mid-level quality

Compile an overall score as the average of all scored categories (excluding "Not Observed").

### Step 4: Act

#### 4a: Promote evidence screenshots

For each trend category that scored 3 or below, or any category with noteworthy positive examples:
- Source: `.playwright-cli/<session>/<screenshot>`
- Destination: `thoughts/local/assets/<session>/<category-slug>-<description>.png`
- Create destination directory: `mkdir -p thoughts/local/assets/<session>/`

#### 4b: Write research note

Write to `thoughts/shared/research/<date>-<slug>-ux-audit.md`:

```yaml
---
date: <today>
type: research
tags: [ralph-playwright, ux-audit, ux-trends-2026, <site-type>]
assets:
  - thoughts/local/assets/<session>/<promoted-screenshot-1>.png
  - thoughts/local/assets/<session>/<promoted-screenshot-2>.png
---
```

**Research note structure:**

```markdown
# UX Trend Audit: <site name or URL>

**Date:** <today>
**Site type:** <type>
**Target audience:** <audience>
**Overall score:** <X.X> / 5.0
**Pages evaluated:** <N>

## Scorecard

| Category | Score | Verdict |
|----------|-------|---------|
| Layout Innovation | X/5 | <one-line summary> |
| Color & Visual Direction | X/5 | <one-line summary> |
| Spatial & Motion Design | X/5 | <one-line summary> |
| Accessibility Baseline | X/5 | <one-line summary> |
| Multimodal Readiness | X/5 | <one-line summary> |
| Personalization Signals | X/5 | <one-line summary> |
| Agentic UX Readiness | X/5 | <one-line summary> |
| AI Integration | X/5 | <one-line summary> |

## Category Details

### <Category Name> — <Score>/5

**What we observed:** <2-3 sentences describing what the audit found, referencing specific pages/screenshots>

**Rubric alignment:** <Which level in the rubric this maps to and why>

**Evidence:** <screenshot references>

(Repeat for each category)

## Responsive Behavior

| Viewport | Status | Key Observations |
|----------|--------|-----------------|
| Mobile (375px) | <pass/issues/broken> | <1-2 sentences> |
| Tablet (768px) | <pass/issues/broken> | <1-2 sentences> |
| Desktop (1280px) | <pass/issues/broken> | <1-2 sentences> |
| Wide (1920px) | <pass/issues/broken> | <1-2 sentences> |

## Raw Findings

Issues and bugs discovered during exploration that don't fit neatly into the trend categories but are worth flagging. These are often the most immediately actionable items:

- <Finding 1 — e.g., "Mobile nav close button intercepted by overlay, making it difficult to dismiss">
- <Finding 2 — e.g., "All content below hero is invisible until scroll animations fire — crawlers and screen readers see a blank page">
- <Finding 3 — etc.>

## Top 3 Recommendations

Prioritized by impact and effort. Each recommendation includes:
1. **What to change** — specific, actionable
2. **Why it matters** — which trend it addresses and what users expect
3. **Effort estimate** — small (days), medium (sprint), large (quarter)
4. **Expected impact** — which score(s) it would improve and by how much

## Trend Context

Brief note on which 2026 trends are most relevant for this site type and audience, so the user understands why certain categories matter more for their context.
```

#### 4c: Issue creation (mode-dependent)

Determine the execution mode:
- **Headless/agentic mode** (skill invoked by another agent, no user in the loop): Create GitHub issues automatically for each recommendation using the ralph-hero MCP tools. Tag with `ux-audit` and the trend category.
- **Interactive mode** (user invoked the skill directly): Present the recommendations and ask: "Want me to create GitHub issues for any of these?"

To detect mode: if the skill was invoked with arguments containing all required fields (URL + site type) and no clarifying questions were needed, treat as headless. If the user was prompted for input, treat as interactive.

### Step 5: Summary

Report to the user:

```
== UX Trend Audit: <URL> ==
Site type: <type> | Pages: <N> | Overall: <X.X>/5.0

Scorecard:
  Layout Innovation ........... X/5
  Color & Visual Direction .... X/5
  Spatial & Motion Design ..... X/5
  Accessibility Baseline ...... X/5
  Multimodal Readiness ........ X/5
  Personalization Signals ..... X/5
  Agentic UX Readiness ........ X/5
  AI Integration .............. X/5

Top recommendation: <#1 recommendation, one line>

Research note: thoughts/shared/research/<path>
Screenshots: N promoted to thoughts/local/assets/<session>/

Next steps:
  - /ralph-playwright:a11y-scan for deep accessibility audit
  - /ralph-hero:design-system-audit for component maturity assessment
```

## Reference Files

| File | When to Read | Contents |
|------|-------------|----------|
| `ux-trends-2026.md` | Before Step 3 scoring | Full 8-category rubric with 1-5 scale, concrete indicators at each level, and scoring guidance per site type |
