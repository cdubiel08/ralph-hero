# Reference: Design system & component variants

Two sub-shapes share this reference.

**Canon:** <https://thariqs.github.io/html-effectiveness/05-design-system.html> (token reference)
· <https://thariqs.github.io/html-effectiveness/06-component-variants.html> (variant matrix)
**JS budget:** None (token reference) to Interactive (≤ ~60 lines: variant-matrix toolbar).

The point of both: render design *as design*. Tokens become swatches, components become real
styled HTML you can copy from — not screenshots, not descriptions.

---

## (a) Living design system — token reference

**Trigger:** "document our design tokens", "show the design system", "render these tokens".
No JS — everything is static styled HTML.

**Anatomy:**
- **Colors** → `.swatch-grid` of `.swatch` (a colored `.sw-chip` block + `.sw-meta` with
  `.sw-name` + `.sw-hex`).
- **Type scale** → `.type-scale` of `.type-row`, each pairing a live specimen
  (`.t-display`/`.t-h1`/`.t-h2`/`.t-body`/`.t-small`/`.t-caption`) with `.type-meta` (size /
  weight / line-height).
- **Spacing** → `.spacing-ruler` of `.space-row` (a `.space-bar` whose width *is* the token + a
  `.space-label`).
- **Radii / shadows** → `.token-cards` of `.radius-card` / `.shadow-card` (a `.demo` block + a
  `.lbl`).
- **Components** → `.component-sheet` of `.component` blocks (`.cmp-name` + `.component-stage`
  rendering the real `.btn` variants, `.demo-input`, `.badge` variants).

```html
<div class="swatch-grid">
  <div class="swatch"><div class="sw-chip" style="background:#2e5d7e"></div>
    <div class="sw-meta"><div class="sw-name">accent</div><div class="sw-hex">#2e5d7e</div></div></div>
</div>

<div class="type-scale">
  <div class="type-row"><div class="t-h1">The quick brown fox</div>
    <div class="type-meta">30px · 500 · 1.15</div></div>
</div>

<div class="component"><div class="cmp-name">Button</div>
  <div class="component-stage">
    <button class="btn btn-primary">Primary</button>
    <button class="btn btn-secondary">Secondary</button>
    <button class="btn btn-ghost">Ghost</button>
    <button class="btn btn-danger">Danger</button>
  </div></div>
```

---

## (b) Component variant matrix

**Trigger:** "show every variant of X", "lay out all states of this component", "card variant
matrix". Interactive: a toolbar drives the live cards.

**Anatomy:** a **`.toolbar`** of `.control`s (`.control-label` + a `.radio-group` of `.seg`
buttons, and/or one `input[type=range]` with a `.control-value`) → a **`.variant-grid`** of
`.variant-cell` (a `.variant-label` + a `.card` in each variant: `.v-flat`/`.v-outlined`/
`.v-elevated`/`.v-stripe`/`.v-inset`/`.v-horizontal`) → a **`.snippet-panel`** echoing the markup
of the current selection. The toolbar must actually mutate the cards — a static grid is just a
worse contact sheet.

```html
<div class="toolbar">
  <div class="control"><span class="control-label">Density</span>
    <div class="radio-group">
      <button class="seg on" data-density="cozy">Cozy</button>
      <button class="seg" data-density="compact">Compact</button>
    </div></div>
  <div class="control"><span class="control-label">Radius <span class="control-value" id="rv">10px</span></span>
    <input type="range" min="0" max="20" value="10" id="radius"></div>
</div>

<div class="variant-grid">
  <div class="variant-cell"><span class="variant-label">elevated</span>
    <div class="card v-elevated">…</div></div>
  <!-- one cell per variant -->
</div>

<div class="snippet-panel"><div class="snippet-head">selected markup</div>
  <pre>&lt;div class="card v-elevated"&gt;…&lt;/div&gt;</pre></div>

<script>
const grid = document.querySelector('.variant-grid');
const rv = document.getElementById('rv');
document.getElementById('radius').addEventListener('input', e => {
  rv.textContent = e.target.value + 'px';
  grid.querySelectorAll('.card').forEach(c => c.style.borderRadius = e.target.value + 'px');
});
document.querySelectorAll('.radio-group .seg').forEach(seg => seg.addEventListener('click', () => {
  const g = seg.closest('.radio-group');
  g.querySelectorAll('.seg').forEach(s => s.classList.remove('on'));
  seg.classList.add('on');
  grid.dataset.density = seg.dataset.density;
}));
</script>
```

## Anti-patterns (group, each with why)

- **Don't screenshot components.** Render them as real styled HTML so the tokens are inspectable
  and the markup is copy-able — that round-trip back into the next prompt is the whole point.
- **For the matrix, the toolbar must drive the cards.** If the controls don't mutate anything,
  drop them and ship a static contact sheet; a fake toolbar is worse than none.
- **Don't invent a parallel palette.** Pull swatches from the real `:root` vars; a design-system
  doc that drifts from the tokens it documents is actively misleading.
- **Keep the spacing bars literal.** A `.space-bar` whose width equals the token value teaches the
  scale at a glance; a uniform bar with a number beside it doesn't.
