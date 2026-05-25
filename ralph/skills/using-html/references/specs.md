# Reference: Specs & design comparison

**Canon:** <https://thariqs.github.io/html-effectiveness/01-exploration-code-approaches.html>
(code) · <https://thariqs.github.io/html-effectiveness/02-exploration-visual-designs.html> (visual)
**JS budget:** Micro (≤ ~15 lines — only if a variant needs a tab switcher).

**Trigger this workflow when** the user says "compare these approaches", "tradeoffs between X and
Y", "show me N ways to...", "what are my options for...", "side-by-side", "explore designs
for...", or asks any question that produces ≥2 candidate solutions to a single decision.

## Page anatomy

Build the page in this order from top to bottom:

1. **Header band** — `.eyebrow` (mono uppercase, e.g. `Exploration · acme/web-client`) + `<h1>` (the question being decided in serif) + `.prompt-box` (the user's original question quoted verbatim under a mono "PROMPT" label).
2. **`.approaches` grid** — CSS grid of 2-4 cards. Set `data-n="3"` (or whatever N is) on the grid so the breakpoint matches the option count.
3. **Each `<article class="approach">` card** contains, in order:
   - `<header class="approach-head">` with a numbered badge (`<span class="num">01</span>`), an `<h2>` (the approach name), and a `<p>` dek (one-line summary).
   - **Code panel** (`<div class="code"><pre>...</pre></div>`) if the approach is code-shaped. Inside the `<pre>`, mark up keywords/strings/comments/identifiers with `<span class="kw">`, `<span class="str">`, `<span class="cm">`, `<span class="fn">`. Don't use a JS highlighter — the theme is already tuned to these four classes against the slate background.
   - **Tradeoffs grid** (`<div class="tradeoffs">`): one `.row.head` with "Pro" and "Con" cells, then 3-5 `.row` blocks each with a `.cell.pro` and a `.cell.con`. The colored dots come from the CSS — don't add emoji.
   - **Chips** (`<div class="chips">`): mono pills with concrete numbers — bundle size, latency, complexity rating, anything quantifiable. Use `<strong>` for the value within the chip.
4. **`.reco` aside** — accent left-border block at the bottom. Name the recommended approach by its number AND name in bold, explain in 1-3 sentences *why*, and note conditions under which a different choice becomes correct.

## Worked example — header + one card

```html
<header class="page-head">
  <div class="eyebrow">Exploration · acme/web-client</div>
  <h1>Three ways to debounce search</h1>
  <div class="prompt-box">
    <span class="label">PROMPT</span>
    Show me three different ways to implement debounced search for the
    task filter input, with tradeoffs for each.
  </div>
</header>

<section class="approaches" data-n="3">
  <article class="approach">
    <header class="approach-head">
      <h2><span class="num">01</span>Inline useEffect + setTimeout</h2>
      <p>Debounce logic lives directly inside the component that owns the input.</p>
    </header>
    <div class="code"><pre><span class="kw">export function</span> <span class="fn">TaskSearch</span>() {
  <span class="kw">const</span> [draft, setDraft] = <span class="fn">useState</span>(<span class="str">''</span>);
  <span class="cm">// ...</span>
}</pre></div>
    <div class="tradeoffs">
      <div class="row head">
        <div class="cell">Pro</div>
        <div class="cell">Con</div>
      </div>
      <div class="row">
        <div class="cell pro">Zero new abstractions</div>
        <div class="cell con">Logic duplicated wherever search exists</div>
      </div>
    </div>
    <div class="chips">
      <span class="chip">Bundle: <strong>+0 kb</strong></span>
      <span class="chip">Reuse: <strong>low</strong></span>
    </div>
  </article>
  <!-- two more <article class="approach"> cards -->
</section>

<aside class="reco">
  <h2>Recommendation</h2>
  <p>Go with <strong>approach 02, the custom <code>useDebounce</code> hook</strong>. There are already three places using the inline pattern, so extracting one shared hook removes duplication without taking on a new dependency.</p>
</aside>
```

## Anti-patterns (each with why)

- **Don't list "approaches" as bullet paragraphs without cards.** The grid is what makes side-by-side comparison glanceable; collapsed into bullets, the reader is back to sequential prose and we might as well have shipped Markdown.
- **Don't bury tradeoffs in prose.** Show them in the 2-column pro/con grid. Prose forces the reader to extract and mentally tabulate; the grid lets them scan across approaches in seconds — that scanning ability is the whole reason we went to HTML.
- **Don't use a 2-column grid when there are 3 options.** Set `data-n="3"` so the third card aligns under the heading. Two-up with one orphan card on row two breaks the comparison shape.
- **Don't conclude with "depends on context".** The reader came to make a decision. Pick the approach that best fits the stated constraints and name it. If genuinely no winner exists, write one sentence explaining why — that's still an answer.
- **Don't use a JS syntax highlighter or default-monospace `<code>` blocks.** The theme ships `.kw`/`.str`/`.cm`/`.fn` spans tuned to the palette; a generic highlighter (Prism, highlight.js) adds bytes, breaks self-containment, and produces colors that fight the slate background.

## Permitted variants

- **2 approaches** → `data-n="2"`; still keep the recommendation aside.
- **Non-code comparisons** (architecture choices, vendor selection) → drop the code panel, keep header/tradeoffs/chips.
- **Visual design directions** (palettes, layouts, empty-state treatments) → drop BOTH the code panel and the tradeoffs grid; replace with a stage that shows the actual visual. Reference: <https://thariqs.github.io/html-effectiveness/02-exploration-visual-designs.html>. The canon uses a card-per-direction grid where each card contains a `.stage` wrapping an `.artboard` (the live mockup canvas), a small `.rationale` paragraph underneath, and optional toolbar controls (`.toolbar` + `.seg` + `.field`) when the direction is tunable. Per-direction theme overrides — class hooks like `.es-a`/`.es-b`/`.es-c`/`.es-d` on each card — let every card render its own palette without changing the surrounding chrome. H1 stays descriptive ("Four visual directions for the empty state"); H2s per card are usually omitted in favor of `.title` + `.tag`.

> **Canon reference for this workflow:** <https://thariqs.github.io/html-effectiveness/01-exploration-code-approaches.html> is the worked example this anatomy is derived from. The `data-n="N"` attribute is a flexibility enhancement — the canon hardcodes `grid-template-columns: repeat(3, 1fr)` per page since each demo knows its own card count. Both work; the `data-n` mechanism lets one stylesheet serve 2/3/4-card pages.
