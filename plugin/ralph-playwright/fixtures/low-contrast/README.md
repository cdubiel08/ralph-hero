# low-contrast fixture

Static HTML page that deliberately violates WCAG 2.2 SC 1.4.3 (Contrast — Minimum) in four documented ways. Introduced by [GH-788](https://github.com/cdubiel08/ralph-hero/issues/788) to exercise the pixel-computed contrast sub-checklist in [`plugin/ralph-playwright/skills/a11y-scan/SKILL.md`](../../skills/a11y-scan/SKILL.md).

Uses no JavaScript, no build step, and no external assets. Servable from any static server.

## Cases

Each case is wrapped in a `<section>` carrying `data-contrast-case="A" | "B" | "C" | "D"` and a visible `<h2>` label, so the expected-signals oracle and signal-report output can reference cases unambiguously.

| Case | Selector | Font size / weight | Foreground | Background | Expected ratio | WCAG threshold | Verdict |
|------|----------|--------------------|------------|------------|----------------|----------------|---------|
| A | `[data-contrast-case="A"] .sample` | 16 px / 400 | `#888888` | `#ffffff` | ~3.54:1 | 4.5:1 (normal) | **FAIL** — emit `a11y_violation` tagged `[pixel-computed, wcag-1.4.3]` |
| B | `[data-contrast-case="B"] .sample` | 16 px / 400 | `#595959` | `#ffffff` | ~7.00:1 | 4.5:1 (normal) | **PASS** — emit no `[pixel-computed]` violation |
| C | `[data-contrast-case="C"] .sample` | 24 px / 700 | `#9a9a9a` | `#ffffff` | ~2.81:1 | 3:1 (large) | **FAIL** — emit `a11y_violation` tagged `[pixel-computed, wcag-1.4.3, large-text]` |
| D | `[data-contrast-case="D"] .sample` | 16 px / 400 | `#ffffff` | gradient `#222` → `#e8e8e8` | local worst-case ~1.1:1 on right edge | 4.5:1 (normal) | **FAIL** (variable) — emit `a11y_violation` tagged `[pixel-computed, wcag-1.4.3, variable-background]` |

All ratios are computed to 2 decimal places using the WCAG 2.x relative-luminance formula exactly as quoted in [`skills/a11y-scan/SKILL.md`](../../skills/a11y-scan/SKILL.md):

```
L = 0.2126 * R_lin + 0.7152 * G_lin + 0.0722 * B_lin
where for each channel c in {R, G, B} normalized to [0, 1]:
  c_lin = c / 12.92                      if c <= 0.03928
  c_lin = ((c + 0.055) / 1.055) ^ 2.4    otherwise
ratio = (L_light + 0.05) / (L_dark + 0.05)
```

A hand-computed sanity check for case A:
- `#888` = (136, 136, 136). Normalized channel c = 136/255 = 0.5333. c_lin = ((0.5333 + 0.055)/1.055)^2.4 = 0.5576^2.4 ≈ 0.2461. L_fg = 0.2126*0.2461 + 0.7152*0.2461 + 0.0722*0.2461 = 0.2461.
- `#fff` = (255, 255, 255). L_bg = 1.0.
- Ratio = (1.0 + 0.05) / (0.2461 + 0.05) = 1.05 / 0.2961 ≈ **3.55:1**. Fails 4.5:1.

The fixture's reported ratios include ±0.15 tolerance for model-driven pixel-sampling noise (antialiasing blends edge pixels); a signal emitted within this band is considered correct.

## How to verify

1. Start a static server in this directory. From the repository root:

    ```
    python3 -m http.server 8765 --directory plugin/ralph-playwright/fixtures/low-contrast
    ```

2. Invoke the skill against the fixture:

    ```
    /ralph-playwright:a11y-scan http://localhost:8765/
    ```

3. Open the emitted `.playwright-cli/<session>/signal-report.yaml` and confirm the signals below.

### Expected signals

- **Case A** — at least one `a11y_violation` whose `tags` include `pixel-computed` and `wcag-1.4.3`, whose `description` includes `#888888` (fg) and `#ffffff` (bg) in hex and a computed ratio of 3.54:1 ± 0.15, and whose failing text references "The quick brown fox" from case A's sample paragraph. Severity: `high` (3.0 ≤ ratio < 4.5).
- **Case B** — no `[pixel-computed]` violation. A false positive here is a prompt-quality bug.
- **Case C** — at least one `a11y_violation` whose `tags` include `pixel-computed`, `wcag-1.4.3`, and `large-text`, with fg `#9a9a9a`, bg `#ffffff`, and a ratio of 2.81:1 ± 0.15. Severity: `critical` (ratio < 3.0:1).
- **Case D** — at least one `a11y_violation` whose `tags` include `pixel-computed`, `wcag-1.4.3`, and `variable-background`. The signal's `description` should note "variable background: worst-case sampled" and include a hex background sample from the near-white right edge.

### Invariants

- `validate-primitive-io.sh` must not reject the emitted `signal-report.yaml` at Read time. This fixture deliberately reuses the existing `a11y_violation` signal-type enum entry; any "Invalid signal types" error is a regression.
- Running `/ralph-playwright:explore` (not `a11y-scan`) against the same URL must NOT emit any `[pixel-computed]` contrast violations. The pixel-computed contrast prompt lives only in the `a11y-scan` skill; cross-skill leakage is a separation-of-concerns bug.

### Recording runbook results

After a run, append your observations (emitted signals, ratios, timing) to the end of this file under a dated subheading, or capture them in `.playwright-cli/<session>/signal-report.yaml` plus a short pilot note in `thoughts/shared/research/` per the "Act" step's research-note convention. If the model's computed ratio is outside the ±0.15 tolerance for any of cases A–C, log it as a model-accuracy concern for follow-up prompt tuning.

## Related

- Skill: [`plugin/ralph-playwright/skills/a11y-scan/SKILL.md`](../../skills/a11y-scan/SKILL.md)
- Expected-signals oracle: [`expected-signals.md`](expected-signals.md)
- Issue: [GH-788](https://github.com/cdubiel08/ralph-hero/issues/788)
- Parent plan: [`thoughts/shared/plans/2026-04-20-GH-0788-pixel-computed-color-contrast.md`](../../../../thoughts/shared/plans/2026-04-20-GH-0788-pixel-computed-color-contrast.md)
