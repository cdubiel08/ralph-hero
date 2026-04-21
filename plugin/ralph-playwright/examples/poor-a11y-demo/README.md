# poor-a11y demo fixture

Synthetic static-HTML fixture for validating `/ralph-playwright:explore --vision-first`
against the default ref-mode on a page with deliberate accessibility violations.

- Issue: [#818](https://github.com/cdubiel08/ralph-hero/issues/818)
- Parent feature: [#795](https://github.com/cdubiel08/ralph-hero/issues/795)
- Grandparent epic: [#784](https://github.com/cdubiel08/ralph-hero/issues/784)

## Why synthetic?

We chose a checked-in fixture over a real public site because:

- Reproducible — the fixture does not change between runs, so metric deltas are
  attributable to the mode change, not to site drift.
- No legal / trademark concerns with exercising a live third party.
- The a11y gaps can be made precise enough that ref-mode is *expected* to stall
  or wander. Real sites either have tolerable a11y (bad demo) or degrade over
  time (bad reproducibility).

## How to serve

No build step. Any static HTTP server works:

```bash
cd plugin/ralph-playwright/examples/poor-a11y-demo
python3 -m http.server 8765
# -> open http://localhost:8765/ in a browser
```

`file://` URLs also work for a quick local dry-run, but some playwright-cli
features expect `http(s)://`, so prefer the static server.

## Goal string for explorers

```
"add the green widget to the cart and reach the confirmation screen"
```

The happy path is 3 clicks:

1. Green "green widget" card on the home screen → product page
2. Orange "add" button on the green widget page → cart page
3. Pink "finish" button on the cart page → confirmation page ("ordered")

## Intentional a11y violations

The fixture deliberately includes these violations. DO NOT "clean them up" —
they are the test.

- No landmark regions (`<header>`, `<nav>`, `<main>`, `<footer>` all absent).
- The three product cards on the home screen are generic `<div>`s with
  `aria-hidden="true"` — sighted users see three colored squares; the
  accessibility tree sees nothing interactive.
- The primary "add" and "finish" CTAs are generic `<div>`s, no `role="button"`,
  no `aria-label`, no `tabindex`. They are styled orange/pink respectively so
  vision-first can pick them out, but ref-mode sees no interactive element.
- Decoy `<a href="#">` links with empty text content surface in the a11y tree
  as untitled refs — ref-mode will likely try these first and land on the
  `404 - nothing here` decoy screen.
- An unlabeled `<input type="text">` on the cart screen — no `<label>`,
  no `aria-label`, no `placeholder`.
- No `<h1>` on screens other than the home screen (broken landmark hierarchy).

## Expected outcome

- **Ref-mode** — Expected to hit the decoy links on the home screen first. If
  it recovers and tries the product cards, their `aria-hidden="true"` should
  make them invisible to the snapshot. Likely result: wander, stall, or fail
  to reach the confirmation screen within the 20-interaction budget.
- **Vision-first mode** — Expected to recognise the green card, the orange CTA,
  and the pink CTA as the salient interactive affordances on each screen and
  reach the confirmation screen in 3-5 interactions.

Honest note: these are expectations, not guarantees. Phase 4's research doc
records the actual outcome, including null results if ref-mode surprisingly
succeeds or vision-first surprisingly fails. See [the demo research
doc](../../../../thoughts/shared/research/2026-04-20-vision-first-exploration-demo.md)
for findings.

## Reproduction steps

From the repo root:

```bash
# Terminal 1 — serve the fixture
cd plugin/ralph-playwright/examples/poor-a11y-demo
python3 -m http.server 8765

# Terminal 2 — ref-mode baseline
/ralph-playwright:explore http://localhost:8765/ "add the green widget to the cart and reach the confirmation screen"

# Terminal 2 — vision-first mode, same goal
/ralph-playwright:explore --vision-first http://localhost:8765/ "add the green widget to the cart and reach the confirmation screen"
```

Each run produces `.playwright-cli/<session>/{journey-trace.yaml,exploration-metrics.yaml}` plus screenshots and snapshots. The second run's Step 4 summary renders the comparison table against the first.
