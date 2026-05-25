# Reference: Research reports

**Canon:** <https://thariqs.github.io/html-effectiveness/14-research-feature-explainer.html>
(feature) · <https://thariqs.github.io/html-effectiveness/15-research-concept-explainer.html>
(concept) · <https://thariqs.github.io/html-effectiveness/11-status-report.html> (status) ·
<https://thariqs.github.io/html-effectiveness/12-incident-report.html> (incident)
**JS budget:** Micro (≤ ~15 lines for the tab switcher) — except the concept-explainer variant,
which is Interactive (≤ ~60 lines to wire its SVG demo).

**Trigger this workflow when** the user says "research X and report back", "summarize what you
found", "investigate Y", "write up your findings", "explain how Z works", "feature explainer
for...", "incident timeline / postmortem of...", or asks for any synthesis of findings from
multiple sources/files into one durable document.

## Page anatomy

Wrap the page in `<div class="report">` to activate the two-column grid layout:

1. **Sidebar (`<nav>`)** — sticky 200px, hidden under 920px (the CSS already handles the breakpoint). Inside:
   - `<div class="label">ON THIS PAGE</div>` + anchor `<a>` links for each H2. For nested step lists, add `class="l2"` to the child links so they indent.
   - **"Files read" footer** at the bottom — `<div class="files">` containing `<div class="label">FILES READ</div>` and one `<code>` per file path. Include this whenever the report is grounded in a codebase; it lets the reader verify by grepping the same paths.
2. **Main column (`<main>`)** in this order:
   - `<header>` with `.eyebrow` (e.g. `Research · feature summary`) + `<h1>` (may contain `<code>` for module/path names).
   - `.tldr` callout — one paragraph max, `<b>` on the most important claim.
   - `<h2>` sections with `id="..."` for the anchor links. The CSS gives them `scroll-margin-top: 24px` so anchors land below any sticky chrome.
3. **Inline content patterns** — use as fits:
   - **Accordions** for step-by-step or optional drill-down. `<details><summary>1 · Identify the caller <span class="where">middleware/ratelimit.ts:21</span></summary><div class="body"><p>…</p></div></details>`. The mono `.where` slot on the right is for the file:line citation.
   - **Tabs** for the same concept across config / call-site / response. Wrap in `<div class="tabs" data-tabs>` with a `.tabbar` of `<button data-t="0">` etc. and `<pre>` panes whose first carries `class="on"`. Then add this 10-line vanilla JS at the bottom of the body:

     ```html
     <script>
     document.querySelectorAll("[data-tabs]").forEach(box => {
       const btns = box.querySelectorAll("button");
       const panes = box.querySelectorAll("pre");
       btns.forEach(b => b.addEventListener("click", () => {
         btns.forEach(x => x.classList.remove("on"));
         panes.forEach(x => x.classList.remove("on"));
         b.classList.add("on");
         panes[+b.dataset.t].classList.add("on");
       }));
     });
     </script>
     ```
   - **Callouts** for tips and gotchas — `<div class="callout"><span class="ico">★</span><div>…</div></div>`.
   - **FAQ** — `<dl class="faq"><dt>Question?</dt><dd>Answer.</dd></dl>`. 3-6 entries max.
   - **Gotchas** — a plain `<ul>` with `<b>` on the leading clause of each `<li>`.

## Worked example — sidebar + header + TL;DR

```html
<div class="report">
  <nav>
    <div class="label">ON THIS PAGE</div>
    <a href="#tldr">TL;DR</a>
    <a href="#path">Request path</a>
    <a href="#path" class="l2">1. Identify</a>
    <a href="#path" class="l2">2. Bucket lookup</a>
    <a href="#config">Configuring a route</a>
    <div class="files">
      <div class="label">FILES READ</div>
      <code>middleware/ratelimit.ts</code>
      <code>lib/tokenBucket.ts</code>
      <code>config/limits.yaml</code>
    </div>
  </nav>

  <main>
    <header>
      <div class="eyebrow">Research · feature summary</div>
      <h1>How rate limiting works in <code>acme/api</code></h1>
      <div class="tldr" id="tldr">
        <b>TL;DR</b> — Every request runs <code>rateLimit()</code>, which resolves the caller to a bucket key and either consumes one token or returns <code>429</code>.
      </div>
    </header>

    <h2 id="path">The request path</h2>
    <details open>
      <summary>1 · Identify the caller <span class="where">middleware/ratelimit.ts:21</span></summary>
      <div class="body"><p>The middleware reduces the request to a <code>bucketKey</code>…</p></div>
    </details>
    <!-- more steps, more sections -->
  </main>
</div>
```

## Anti-patterns (each with why)

- **Don't write a Markdown-style linear wall of `<p>` tags.** A report that's just paragraphs down a single column is Markdown with extra steps. Use the structural patterns — TOC, sections with anchors, callouts, accordions — so the reader has entry points and signposts. Navigability is the point of going to HTML.
- **Don't put the sidebar nav in normal flow.** Without `position: sticky` (which `.report nav` already sets), it scrolls off and becomes useless on page two. The nav exists so the reader can jump between sections at any scroll position.
- **Don't omit the "Files read" footer on code-grounded reports.** Naming the files makes the report verifiable — the reader can grep the same paths and check the claims. Without it, the report is "trust me." With it, it's "here's exactly what I looked at."
- **Don't write a multi-paragraph TL;DR.** The TL;DR exists so a skimmer gets the headline claim in 10 seconds. If it takes two paragraphs, it isn't a TL;DR — it's the introduction, and you've defeated its purpose.
- **Don't hide must-read content inside `<details>`.** Accordions are for optional drill-down (steps, sub-procedures, less-common cases). If the reader *must* see something to understand the report, put it inline.
- **Don't end with a "Recommendation" aside.** Reports describe what IS — how a system works, what the data shows, what happened in an incident. Prescription belongs in the specs workflow, not here.

## Permitted variants

- **Status / weekly report** → drop the sidebar (omit `<div class="report">` wrapper, use `<main>` directly), single column. Reference: <https://thariqs.github.io/html-effectiveness/11-status-report.html>. Canon H2s are `Highlights / Shipped / Velocity / Carryover`. Use a `.summary-band` near the top, a small `.chart-panel` containing one inline `<svg>` velocity chart, `.stat-card` blocks with `.stat-num` + `.stat-label` + `.stat-delta` for KPI deltas (apply `.up`/`.warn` modifiers for direction), and `.carryover` rows containing `.carry-item` + `.carry-tag` pills with a `.risk-dot` (`.high`/`.med`/`.low`) per item.

- **Incident timeline / postmortem** → main is a left-rail timeline, NOT a vertical `<ol>`. Reference: <https://thariqs.github.io/html-effectiveness/12-incident-report.html>. Canon H2s are `Timeline / Root cause / Impact / Action items`. The timeline is a `<section class="timeline">` of `.tl-entry` rows, each with `.tl-time` (HH:MM), `.tl-dot`, and `.tl-body`. Log excerpts inside `.tl-body` go in a `.code-panel` using `.diff-line.add`/`.diff-line.del` for added/removed lines. Action items use an `.actions` grid of `.ai-row` blocks (`.ai-avatar` assignee + `.ai-desc` description + `.ai-due` date + `.ai-check` checkbox). Status pills (`.pill.mitigated`/`.pill.resolved`) plus a `.sev` severity tag sit in a `.meta-row` at the top. Sidebar's anchor list becomes "timeline at a glance" with timestamps.

- **Concept explainer** → centerpiece is an interactive `<svg>` demo, NOT a static diagram. Reference: <https://thariqs.github.io/html-effectiveness/15-research-concept-explainer.html>. Canon drops the sidebar entirely; layout is a single `.demo-grid` placing the SVG widget (`.ring`/`.node`/`.arc`/`.track`) next to `.controls` (sliders + buttons that mutate the SVG via inline JS). Often skips `.tldr` — a brief `.lead` paragraph carries the headline instead. Include a `<table>` for "X vs Y" comparison (use `.good`/`.bad` cells for visual contrast) and a glossary as `<dl>` with `.term` + `.lbl` entries for inline definitions. ~20 lines of vanilla JS to wire control → SVG updates is acceptable here; the interactivity IS the explainer.

> **Canon reference for this workflow:** <https://thariqs.github.io/html-effectiveness/14-research-feature-explainer.html> is the worked example. The canon uses `<div class="page">` for the two-column grid wrapper; this skill uses `<div class="report">` to keep that grid distinct from the wider 1360px `.page` used by the specs workflow.
