# Reference: Illustrations & diagrams

Two sub-shapes share this reference.

**Canon:** <https://thariqs.github.io/html-effectiveness/10-svg-illustrations.html> (figure
sheet) · <https://thariqs.github.io/html-effectiveness/13-flowchart-diagram.html> (flowchart)
**JS budget:** Micro (figure sheet: copy buttons) to Interactive (flowchart: ≤ ~60 lines, as
*data + a render/click loop*, not imperative DOM building).

Inline SVG gives you a real pen. Hand-author it; never emit a raster image or pull in Mermaid via
`<script src>` — that breaks self-containment and you lose the ability to tweak by hand.

---

## (a) SVG figure sheet

**Trigger:** "draw the figures for this post", "illustrate X", "make diagrams I can paste out".
Multiple independent figures, each extractable on its own.

**Anatomy:** a **`.fig-sheet`** grid of `.figure` cards, each with a `.fig-canvas` (one inline
`<svg>`), a `.fig-cap` (`.fig-title` + `.fig-sub`), and an optional `.fig-palette` of `.sw-chip`
swatches so the figure's colors are reusable. Micro JS (optional): a per-figure "copy SVG"
button.

```html
<div class="fig-sheet">
  <figure class="figure">
    <div class="fig-canvas"><svg viewBox="0 0 200 120" width="200" height="120">
      <rect x="20" y="30" width="160" height="60" rx="10" fill="#e6dcc4" stroke="#2e5d7e"/>
      <text x="100" y="65" text-anchor="middle" font-size="13" fill="#1b2329">job queue</text>
    </svg></div>
    <figcaption class="fig-cap"><div class="fig-title">Work queue</div>
      <div class="fig-sub">Producers enqueue; workers drain.</div></figcaption>
    <div class="fig-palette"><span class="sw-chip" style="background:#2e5d7e"></span>
      <span class="sw-chip" style="background:#e6dcc4"></span></div>
  </figure>
</div>
```

---

## (b) Annotated flowchart

**Trigger:** "draw the deploy pipeline", "flowchart this process", "show the failure paths".
Clicking a node reveals its detail.

**Anatomy:** `.page-head` → a **`.flow-layout`** (two columns) placing a `.flow-canvas` (one large
inline `<svg>`) next to a `.flow-legend`. Nodes are `<g class="node">` (add `.gate`/`.ok`/`.bad`
to encode state) each with a `<rect>` + `<text>`; edges are `<path class="edge">` (define one
`<marker id="arrow">` for the arrowhead). Clicking a node toggles `.sel` and fills a `.flow-hint`
panel in the legend (`.where` for the file/command).

**Author the JS as data + a small loop**, not 96 lines of hand-built DOM:

```html
<div class="flow-layout">
  <div class="flow-canvas"><svg viewBox="0 0 360 220">
    <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="#847d6c"/></marker></defs>
    <path class="edge" d="M80,50 L80,90"/>
    <g class="node" data-id="build"><rect x="20" y="20" width="120" height="32" rx="8"/>
      <text x="80" y="40" text-anchor="middle">build</text></g>
    <g class="node gate" data-id="tests"><rect x="20" y="90" width="120" height="32" rx="8"/>
      <text x="80" y="110" text-anchor="middle">tests pass?</text></g>
    <g class="node bad" data-id="rollback"><rect x="200" y="90" width="120" height="32" rx="8"/>
      <text x="260" y="110" text-anchor="middle">rollback</text></g>
  </svg></div>
  <div class="flow-legend"><div class="label">STEP DETAIL</div>
    <div class="flow-hint" id="hint">Click a step to see what runs.</div></div>
</div>

<script>
const detail = {
  build:    { t: "Compile + bundle", w: "ci/build.sh" },
  tests:    { t: "Gate: unit + e2e must pass", w: "ci/test.sh" },
  rollback: { t: "Failure path: redeploy last green", w: "ci/rollback.sh" },
};
const hint = document.getElementById('hint');
document.querySelectorAll('.node').forEach(n => n.addEventListener('click', () => {
  document.querySelectorAll('.node').forEach(x => x.classList.remove('sel'));
  n.classList.add('sel');
  const d = detail[n.dataset.id];
  hint.innerHTML = d.t + '<div class="where">' + d.w + '</div>';
}));
</script>
```

## Anti-patterns (group, each with why)

- **Don't emit a raster image or a Mermaid `<script>`.** Inline hand-authored SVG is the point —
  self-contained and tweakable by hand. A `<script src>` to a diagram CDN breaks the one-file
  guarantee.
- **Don't make flowchart nodes undifferentiated boxes.** Encode state in the class
  (`.gate`/`.ok`/`.bad`) so the diagram carries meaning at a glance, not just topology.
- **Don't build the flowchart with 90 lines of imperative DOM.** Author the SVG by hand and keep
  the JS to a data table + a click loop — that's what keeps it inside the interactive budget and
  legible.
- **Keep figures independent.** Each `.figure` should stand alone so the reader can copy one SVG
  out without dragging the others along.
