---
date: 2026-05-23
status: draft
type: design
topic: using-html skill
---

# Design: `using-html` skill

A personal Claude Code skill that teaches the agent to produce HTML artifacts — instead of long Markdown — for outputs that benefit from visual structure (multi-option comparisons, research synthesis docs). Inspired by Thariq Shihipar's *"The unreasonable effectiveness of HTML"* and the companion demo gallery at [thariqs.github.io/html-effectiveness](https://thariqs.github.io/html-effectiveness/).

## Summary

`using-html` is a single, flat-structured skill living at `~/.claude/skills/using-html/SKILL.md`. It establishes a small visual identity (palette, typography, component vocabulary) and documents two workflows that produce self-contained HTML files:

- **Specs & design comparison** — side-by-side cards comparing 2-4 candidate approaches with pros/cons and a recommendation.
- **Research reports** — sticky-nav editorial layout with TL;DR, anchor-linked sections, accordions, tabs, callouts, and a "Files read" footer.

The agent writes one HTML file per invocation to a deterministic location, then `open`s it in the user's default browser. No frameworks, no CDNs, no external assets — every artifact must work offline, as an email attachment, and after being uploaded to a wiki.

## Goals

- Replace Markdown output with HTML for the two highest-value workflows (comparison docs and research syntheses).
- Ship a coherent, original visual identity — not a clone of Anthropic's brand — that the user can iterate on later.
- Keep the skill self-contained: one HTML file per artifact, no build step, no runtime fetches.
- Make every output discoverable: predictable file location, auto-opens in browser, restated path in chat.
- Stay tightly scoped: one skill, two workflows, no theming layer or override mechanism in v1.

## Non-goals

- The other three workflows from the source post — code review rendering, interactive prototypes, custom editing UIs. Deferred.
- A user-overridable theme system (`~/.claude/using-html/theme.css`, env var theme switcher, etc.). Deferred.
- A dark-mode variant. Light only.
- A self-critique / output-audit step inside the skill. Rails must pull their own weight.
- Browser automation. The skill writes a file and runs `open`; a future Chrome-MCP-enabled agent can pick up the artifact independently.
- A theme sampler render-and-verify loop with `playwright-cli`. Useful tooling but not part of v1; "use Chrome" is the directive for future agents.

## Skill identity

| Field | Value |
|---|---|
| Name | `using-html` |
| Home | `~/.claude/skills/using-html/` |
| Frontmatter | `name`, `description` only |
| Assets | `assets/theme.css`, `assets/skeleton.html` (see Architecture) |
| References dir | None in v1 |

**Description (frontmatter — the trigger surface)**:

> Use when producing multi-option design comparisons, research synthesis docs, status/incident reports, or any Claude Code output that would otherwise be a long Markdown document. Reach for this skill whenever the user asks to "compare", "explore options", "research", "summarize findings", "write up", "synthesize", or "explain how X works" — and especially when the output will exceed ~100 lines, contain side-by-side options, or be shared with another person. HTML beats Markdown for these by a wide margin (visual hierarchy, tables, SVG diagrams, navigability); default to invoking this skill even if the user doesn't explicitly ask for HTML.

## Architecture

Flat-structured single skill with two small bundled assets — palette/component CSS and the page skeleton — so the agent doesn't reconstruct the visual identity from prose every invocation (which is where visual drift comes from):

```
~/.claude/skills/using-html/
├── SKILL.md              (frontmatter + workflow guidance)
└── assets/
    ├── theme.css         (:root palette vars + component styles —
    │                     .eyebrow, .tldr, .callout, details,
    │                     tabs, sticky nav, card, syntax spans)
    └── skeleton.html     (doctype + meta + <title> + linked
                          <style> placeholder — the page shell)
```

`SKILL.md` body structure (flat, parallel):

```
├── frontmatter (name, description)
├── Intro — when HTML beats Markdown
├── Core principles
├── File location & finisher
├── Workflow: Specs & design comparison
└── Workflow: Research reports
```

**How assets are used**: When generating output, the agent reads `assets/skeleton.html` and `assets/theme.css`, inlines the CSS into a `<style>` block in the head, fills in the title + body content per workflow, and writes the result as a single self-contained file. The agent does *not* link to the CSS via `<link rel>` — the artifact must remain one file that works as an email attachment.

Each `SKILL.md` section is self-contained. Per-workflow sections are parallel and don't cross-reference each other.

**Voice in `SKILL.md`** must be imperative second-person ("Write the HTML to...", "Open it with `open`...") — not descriptive third-person. The implementation plan should not paste this spec's prose into SKILL.md verbatim.

## Core principles

Section content (paraphrasable; final wording in the SKILL.md itself):

- **One file, fully self-contained.** Inline CSS, inline SVG, inline JS only if interactive. Zero CDNs, zero external assets, zero `fetch()`. Artifact must work offline, as an email attachment, and after being uploaded to a wiki.
- **Page skeleton.** `<!doctype html>`, `<meta charset="utf-8">`, `<meta name="viewport" content="width=device-width, initial-scale=1">`, `<title>` matching the doc topic, `<style>` in `<head>`, content in `<body>`.
- **JS posture.** Small inline vanilla JS is part of the toolkit (e.g. ~10 lines to switch tabs, `<details>` for accordions). No frameworks, no `<script src=...>`, no `import` from a CDN.
- **Syntax highlighting.** Hand-coded `<span class="kw|str|cm|fn">` only. Never invoke a JS syntax highlighter or dump raw `<code>` blocks in default monospace gray.

### Visual identity

**Palette — "marine ink on cream"**, deliberately distinct from Anthropic's clay-on-ivory brand:

```css
:root {
  --paper:    #f5f1e8;   /* warm cream, slightly cooler than ivory */
  --ink:      #1b2329;   /* deep blue-black */
  --accent:   #2e5d7e;   /* marine teal — primary punch */
  --rust:     #b35a2c;   /* secondary, used sparingly (cons, warnings) */
  --moss:     #5a7847;   /* positive / pro signals */
  --sand:     #e6dcc4;   /* tinted callout background */
  --gray-150: #ece7db;
  --gray-300: #cdc6b7;
  --gray-500: #847d6c;
  --gray-700: #3a3a36;
  --white:    #ffffff;   /* card surface */
  --serif:    'Iowan Old Style', Charter, ui-serif, Georgia, serif;
  --sans:     system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono:     'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace;
}
```

**Type sandwich**:

- Body: `var(--sans)`, line-height 1.65, color `var(--gray-700)`.
- Headings (H1, H2, summary, FAQ `<dt>`): `var(--serif)`, weight 500, color `var(--ink)`, tighter line-height (~1.15).
- Eyebrows, chips, code, file paths: `var(--mono)`.

**Light mode only for v1.** No `@media (prefers-color-scheme: dark)` override.

### Component vocabulary

Both workflows pull from this shared set:

- `.eyebrow` — mono uppercase 11px section label above H1, gray-500.
- `.tldr` — white card, 3px `--accent` left-border, used at top of reports.
- `.callout` — `--sand` background with `--accent` icon (`★` by default); for tips/gotchas.
- `<details><summary>` — accordions with rotating `▸` chevron in `--accent`; summary uses serif.
- Tabs — `<button data-t>` bar + show/hide `<pre>` panes via ~10 lines vanilla JS.
- Sticky `<nav>` — 200px sidebar, `position: sticky; top: 32px`, hidden under 920px.
- `.card` — `1.5px solid var(--gray-300)`, 10-12px radius, white bg on paper.
- Inline syntax-highlight spans — `.kw` (accent/teal), `.str` (moss), `.cm` (gray-500), `.fn` (warm tan `#c9b98a`, code-panel only — sits well on the slate background).
- H2 anchors — `scroll-margin-top: 24px` so anchor jumps don't hide behind sticky nav.

## File location & finisher

**Location**:

```bash
if git rev-parse --show-toplevel >/dev/null 2>&1; then
  toplevel=$(git rev-parse --show-toplevel)
  if [ -d "$toplevel/thoughts" ]; then
    out="$toplevel/thoughts/shared/html-out/$(date +%Y-%m-%d)-<slug>.html"
  fi
fi
out=${out:-"$HOME/claude-html-out/$(date +%Y-%m-%d)-<slug>.html"}
mkdir -p "$(dirname "$out")"
```

- Slug is a kebab-case short description of the artifact's topic.
- If a sibling file from the same day already exists, append `-2`, `-3`, etc.

**Finisher** (every invocation, in order):

1. Write the HTML file to the resolved path.
2. Run `open "$out"` via Bash — opens in default browser.
3. Restate the path in chat as a single line so the user has it if they missed the `open` flash.

## Workflow: Specs & design comparison

**When to use**: "compare these approaches", "tradeoffs between X and Y", "show me N ways to...", "what are my options for...", "side-by-side", "explore designs for...", or any request that produces ≥2 candidate solutions to a single decision.

**Page anatomy** (top to bottom):

1. **Header band** — `.eyebrow` (mono uppercase, e.g. `Exploration · <project or domain>`) + `<h1>` (serif, the question being decided) + `.prompt-box` (gray-150 background, mono "PROMPT" label, the user's original question quoted verbatim).
2. **`.approaches` grid** — CSS grid of 2-4 cards: `grid-template-columns: repeat(N, minmax(0, 1fr))`, collapses to `1fr` under 1100px. Each `<article class="approach">` contains:
   - **Head**: numbered badge (e.g. `<span class="num">01</span>` in oat background) + `<h2>` (serif, approach name) + dek (gray-500, one-line summary).
   - **Code panel** (if applicable): slate background, mono, hand-coded `<span class="kw|str|cm|fn">` highlighting. Skip if the approach isn't code-shaped.
   - **Tradeoffs**: 2-column grid (Pro | Con), 3-5 rows each. Each cell prefixed with a colored dot — `--moss` for pro, `--rust` for con. **Never** bury tradeoffs in prose paragraphs.
   - **Chips**: mono metadata pills with concrete numbers — bundle size, latency, complexity rating, anything quantifiable.
3. **`.reco` aside** — accent left-border, white card, max-width 860px. Names the recommended approach by number AND name (bold), explains in 1-3 sentences *why*, notes conditions under which a different choice becomes correct. Omit only when genuinely no recommendation exists; explain why if so.

**Anti-patterns** (each carries a *why* so the agent can judge edge cases):

- **Don't list "approaches" as bullet paragraphs without cards.** The grid layout is what makes side-by-side comparison glanceable; collapsed into bullets, the reader is back to reading sequential prose and we might as well have shipped Markdown.
- **Don't bury tradeoffs in prose.** Show them in the 2-column pro/con grid. Prose forces the reader to extract and mentally tabulate; the grid lets them scan across approaches in seconds — that scanning ability is the whole reason we went to HTML.
- **Don't use a 2-column grid when there are 3 options.** Two of the cards align under the heading; the third sits orphaned on the next row. Use `repeat(N, ...)` matching the option count so the comparison reads as one row.
- **Don't conclude with "depends on context".** The reader came here to make a decision. Pick the approach that best fits the stated constraints and name it. If genuinely no winner exists, write one sentence explaining why — that's still an answer.
- **Don't use a JS syntax highlighter or default-monospace `<code>` blocks.** The skill ships with `.kw`/`.str`/`.cm`/`.fn` spans that match the palette; a generic highlighter (Prism, highlight.js) adds bytes, breaks self-containment, and produces colors that fight the theme.

**Permitted variants**:

- 2 approaches → 2-column grid; still has the recommendation aside.
- Non-code comparisons (architecture choices, vendor selection) → drop the code panel, keep everything else.
- "Three visual design directions" → swap the code panel for an inline SVG mockup.

**Worked-example fragments** (SKILL.md should include short literal snippets like these so the agent has concrete rails, not just descriptions):

```html
<!-- header band -->
<div class="eyebrow">Exploration · acme/web-client</div>
<h1>Three ways to debounce search</h1>
<div class="prompt-box">
  <span class="label">PROMPT</span>
  Show me three approaches to debounced search…
</div>

<!-- one approach card -->
<article class="approach">
  <header class="approach-head">
    <h2><span class="num">01</span>Inline useEffect + setTimeout</h2>
    <p>Timer lives inside the component that owns the input.</p>
  </header>
  <!-- code panel, tradeoffs, chips -->
</article>
```

## Workflow: Research reports

**When to use**: "research X and report back", "summarize what you found", "investigate Y", "write up your findings", "explain how Z works", "feature explainer for...", "incident timeline / postmortem of...", or any synthesis of findings from multiple sources/files into a single durable document.

**Page anatomy**:

1. **Two-column layout** on >920px: sticky `<nav>` sidebar (200px) + `<main>` column (`minmax(0, 1fr)`). Single column with nav hidden below 920px.
2. **Sidebar (`<nav>`)**:
   - `.label` ("ON THIS PAGE") + anchor links to each H2. Two indent levels supported: top-level and `.l2` indented children.
   - **"Files read" footer**: bottom of nav, mono list of every file path the research touched. Required when the report is grounded in a codebase — this is the trust-building move.
3. **Main column**:
   - **Header**: `.eyebrow` (e.g. `Research · <topic class>`) + `<h1>` (serif, the question or feature name; may include `<code>` for module/path names).
   - **`.tldr` callout**: 3px accent left-border, white card. One paragraph max, bolds the most important claim. Always include.
   - **H2 sections** with `scroll-margin-top: 24px`.
   - **Inline patterns** (use as fits):
     - `<details><summary>` accordions for step-by-step content; summary may include mono `.where` file:line on the right.
     - Tabs — `<button data-t>` bar + `<pre>` panes + ~10-line vanilla JS switcher. Use for showing the same concept across config / call-site / response.
     - `.callout` — oat-tinted background, accent icon, for tips and gotchas.
     - FAQ — `<dl class="faq"><dt><dd>`. Serif `dt`, sans `dd`. 3-6 entries max.
     - Gotchas list — plain `<ul>` with bold leading clause per item.
   - **No recommendation aside.** Reports describe what IS, not what to choose.

**Anti-patterns** (each carries a *why*):

- **Don't write a Markdown-style linear wall of text.** A report that's just `<p>` tags down a single column is Markdown with extra steps. Use the structural patterns — TOC, sections with anchors, callouts, accordions — to give the reader entry points and signposts. The whole point of going to HTML is navigability.
- **Don't put the sidebar nav in normal flow.** Without `position: sticky`, it scrolls off and becomes useless on page two. The nav exists so the reader can jump between sections at any scroll position; that requires sticky.
- **Don't omit the "Files read" footer on code-grounded reports.** Naming the files makes the report verifiable — the reader can grep the same paths and check the claims. Without it, the report is "trust me." With it, it's "here's exactly what I looked at."
- **Don't write a multi-paragraph TL;DR.** The TL;DR exists so a skimmer gets the headline claim in 10 seconds. If it takes two paragraphs, it isn't a TL;DR — it's the introduction, and you've defeated its purpose.
- **Don't hide must-read content inside `<details>`.** Accordions are for optional drill-down (steps, sub-procedures, less-common cases). If the reader *must* see something to understand the report, put it inline.
- **Don't end with a "Recommendation" aside.** Reports describe what IS — how a system works, what the data shows, what happened in an incident. Prescription belongs in the specs workflow, not here.

**Permitted variants**:

- **Status / weekly report** → drop sidebar, single column, sections become time-bucketed (shipped / in progress / slipped).
- **Incident timeline / postmortem** → main is a vertical timeline (`<ol>` styled with left rail); sidebar is "timeline at a glance" with timestamps.
- **Concept explainer** → may include one inline SVG diagram; nav adds a glossary anchor.

**Worked-example fragments**:

```html
<!-- sidebar -->
<nav>
  <div class="label">ON THIS PAGE</div>
  <a href="#tldr">TL;DR</a>
  <a href="#path">Request path</a>
  <a href="#path" class="l2">1. Identify</a>
  <a href="#path" class="l2">2. Bucket lookup</a>
  <div class="files">
    <div class="label">Files read</div>
    <code>middleware/ratelimit.ts</code>
    <code>lib/tokenBucket.ts</code>
  </div>
</nav>

<!-- main, header + TL;DR -->
<main>
  <div class="eyebrow">Research · feature summary</div>
  <h1>How rate limiting works in <code>acme/api</code></h1>
  <div class="tldr" id="tldr">
    <b>TL;DR</b> — Every request runs through <code>rateLimit()</code>,
    which resolves the caller to a bucket key and consumes one token.
  </div>
</main>
```

## Open questions

None at this stage. All theme, layout, and scope decisions resolved in brainstorming.

## Out of scope (deferred)

| Item | Reason |
|---|---|
| Workflows: code review, interactive prototypes, custom editing UIs | Not the user's near-term need. Add as parallel `## Workflow:` sections when they become real. |
| User theme override (`~/.claude/using-html/theme.css`, env vars) | One theme, iterate later. |
| Dark mode | Defer. Light only suits both workflows for now. |
| Self-critique step before save | Rails carry the weight. |
| Render-and-verify loop via `playwright-cli` | "Use Chrome" is the directive for future agents; v1 ships without programmatic verification. |
| Native Chrome DevTools MCP integration | Not wired in this session; defer until the MCP is installed. |

## Implementation notes

The implementation plan (separate doc, produced by `writing-plans`) will need to handle:

- Creating `~/.claude/skills/using-html/` directory and `assets/` subdirectory.
- Authoring `SKILL.md` with the frontmatter described above. Body voice is imperative second-person ("Write the HTML to…") — not descriptive third-person. Don't paste this spec's prose verbatim; rewrite as instructions to the agent.
- Authoring `assets/theme.css` — `:root` palette vars + all component styles (`.eyebrow`, `.tldr`, `.callout`, `<details>` chrome, tabs JS-companion styles, sticky nav, `.card`, syntax-highlight spans, H2 `scroll-margin-top`).
- Authoring `assets/skeleton.html` — doctype, meta tags, `<title>` placeholder, `<style>` placeholder where theme.css gets inlined.
- Including the worked-example HTML fragments from this spec inside the relevant `## Workflow:` sections of SKILL.md as concrete rails.
- Verifying the skill is discovered by Claude Code's skill loader (no installation step needed for personal skills — just file presence).

### Test cases (skill-creator style — three prompts covering surface area)

| # | Workflow | Prompt |
|---|----------|--------|
| 1 | Specs (code) | "Show me three ways to implement debounced search in a React component — with tradeoffs for each." |
| 2 | Research (codebase) | "Investigate how the ralph-hero MCP server handles GitHub rate limits and write it up." |
| 3 | Specs (non-code) | "Compare Postgres vs DynamoDB for our event-log store and recommend one." |

These are starting test prompts for evals; the implementation plan should run them once the skill exists and capture qualitative review before declaring v1 done.
