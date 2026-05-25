# Reference: Slide deck

**Interactive-tier** — read `assets/interactive.css` and inline it after `theme.css`.

**Canon:** <https://thariqs.github.io/html-effectiveness/09-slide-deck.html>
**JS budget:** Interactive (≤ ~60 lines — really ~25 for arrow-key nav).

A handful of `<section>` tags and ~20 lines of JS is a slide deck. Point it at a thread or a doc
and get something to arrow-key through in a meeting — no Keynote, no export step.

## Page anatomy

Wrap everything in `<div class="deck">`. Each slide is a `<section class="slide">`; exactly one
carries `.on` at a time (the JS toggles it). Inside each, use a `.slide-inner`.

- **Title slide** → `.slide.title-slide` with `<h1>`, `.subtitle`, `.byline`.
- **Shipped list** → `.ship-list` of `.ship-item` (`.ship-dot` + `.ship-title` + `.ship-desc` +
  `.ship-ref`).
- **Progress** → `.prog-list` of `.prog-item` (`.prog-head` with `.prog-title` + `.prog-pct`, then
  a `.prog-track` > `.prog-fill` whose width is the percent).
- **Metrics** → `.metrics` row of `.metric` (`.metric-label` + `.metric-value` + `.metric-delta`,
  add `.down` for a negative delta); reuse a small inline `<svg>` sparkline in `.sparkline-wrap`.
- **Decision** → `.decision-card` (`.decision-q` + `.options` of `.opt`, mark the recommended one
  `.lean`).
- **Next steps** → `.next-list`.

Add a `.deck-nav` indicator and the arrow-key script at the end of the body:

```html
<div class="deck">
  <section class="slide title-slide on"><div class="slide-inner">
    <h1>Platform Eng</h1><div class="subtitle">Week of Mar 10</div>
    <div class="byline">— infra team</div></div></section>

  <section class="slide"><div class="slide-inner">
    <div class="eyebrow">Shipped</div>
    <div class="ship-list">
      <div class="ship-item"><span class="ship-dot"></span>
        <div><div class="ship-title">Queue-backed notifications</div>
          <div class="ship-desc">Delivery moved off the request path.</div>
          <div class="ship-ref">#312</div></div></div>
    </div></div></section>

  <section class="slide"><div class="slide-inner">
    <div class="metrics">
      <div class="metric"><div class="metric-label">p95 latency</div>
        <div class="metric-value">180ms</div><div class="metric-delta">−40ms</div></div>
      <div class="metric"><div class="metric-label">Error rate</div>
        <div class="metric-value">0.4%</div><div class="metric-delta down">+0.1%</div></div>
    </div></div></section>
</div>
<div class="deck-nav" id="nav">1 / 3</div>

<script>
const slides = [...document.querySelectorAll('.slide')];
let i = 0;
const nav = document.getElementById('nav');
function show(n){
  i = Math.max(0, Math.min(slides.length - 1, n));
  slides.forEach((s, k) => s.classList.toggle('on', k === i));
  nav.textContent = (i + 1) + ' / ' + slides.length;
}
addEventListener('keydown', e => {
  if (e.key === 'ArrowRight' || e.key === ' ') show(i + 1);
  if (e.key === 'ArrowLeft') show(i - 1);
});
addEventListener('click', () => show(i + 1));
show(0);
</script>
```

## Anti-patterns (each with why)

- **Don't make slides scroll as one long page.** Arrow-key, one-at-a-time is what makes it a deck
  rather than a report. If you want a scroll document, that's `references/research.md`.
- **Don't overload a slide.** One idea per `<section>`. A slide that needs scrolling has become a
  page; split it.
- **Don't invent parallel chart classes.** Reuse the metric/sparkline vocabulary; a deck and a
  status report should look like the same hand drew them.
- **Don't add a build step or an export.** The whole appeal is one HTML file you arrow-key through
  — keep it that way.
