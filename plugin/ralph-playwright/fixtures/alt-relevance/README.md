# alt-relevance fixture

Static HTML page exercising the alt-text relevance sub-procedure in [`plugin/ralph-playwright/skills/a11y-scan/SKILL.md`](../../skills/a11y-scan/SKILL.md). Introduced by [GH-789](https://github.com/cdubiel08/ralph-hero/issues/789) to verify that a correctly-configured `/ralph-playwright:a11y-scan` run flags images with mismatched accessible names (alt / aria-label / figcaption / aria-labelledby) while leaving good and decorative images alone. Mirrors the fixture pattern introduced by sibling [GH-788](https://github.com/cdubiel08/ralph-hero/issues/788) ([`low-contrast/`](../low-contrast/)).

Uses no JavaScript and no external assets (all images are local SVGs). Servable from any static server.

## Cases

Each case is wrapped in a `<section>` carrying `data-alt-relevance-case="i" | "ii" | "iii" | "iv" | "v" | "vi"` and a visible `<h2>` label so the expected-signals block below and the emitted signal-report can reference cases unambiguously.

| Case | Selector | Element | Accessible name source | Accessible name | Visible content | Grade | Expected signal |
|------|----------|---------|-------------------------|-----------------|-----------------|-------|-----------------|
| i | `[data-alt-relevance-case="i"] img` | `<img>` | `alt` | `"Golden retriever sitting on a porch"` | Golden dog sitting on wooden porch | ACCURATE | **none** |
| ii | `[data-alt-relevance-case="ii"] img` | `<img>` | `alt` | `"Red Submit button"` | Golden dog sitting on wooden porch | INACCURATE | `a11y_violation`, severity `medium`, tags `[alt-relevance]` |
| iii | `[data-alt-relevance-case="iii"] img` | `<img>` | `alt` | `"Weather forecast"` | Bar chart titled "Quarterly Sales 2025" (chart = information-critical) | INACCURATE | `a11y_violation`, severity `high`, tags `[alt-relevance, information-critical]` |
| iv | `[data-alt-relevance-case="iv"] img` | `<img>` | `alt=""` | (empty — decorative) | Thin grey horizontal line | (SKIP — decorative) | **none** |
| v | `[data-alt-relevance-case="v"] figure` | `<figure><img><figcaption>` | `figcaption` | `"Tabby cat napping on a windowsill"` | Tabby cat napping on a windowsill | ACCURATE | **none** |
| vi | `[data-alt-relevance-case="vi"] [role="img"]` | `<div role="img">` | `aria-label` | `"Orange triangle warning icon"` | Orange warning triangle with exclamation mark | ACCURATE | **none** |

Per the rubric in [`skills/a11y-scan/SKILL.md`](../../skills/a11y-scan/SKILL.md) §(d):

- **ACCURATE** -> no signal.
- **PARTIAL** -> `a11y_violation` severity `low` (no cases in this fixture hit PARTIAL; the bad alts are egregious enough to be INACCURATE. A future fixture case could exercise PARTIAL with something like `alt="image"` on a specific photo).
- **INACCURATE** -> `a11y_violation` severity `medium`, escalated to `high` when the image is information-critical (charts, diagrams, product photos, warning icons).

## How to verify

1. Start a static server in this directory. From the repository root:

    ```
    python3 -m http.server 8766 --directory plugin/ralph-playwright/fixtures/alt-relevance
    ```

2. Invoke the skill against the fixture:

    ```
    /ralph-playwright:a11y-scan http://localhost:8766/
    ```

3. Open the emitted `.playwright-cli/<session>/signal-report.yaml` and confirm the signals below.

## Expected Signals

The correctly-configured reflect step must emit exactly two `[alt-relevance]` signals (cases ii and iii) and zero for the other four cases. Other `a11y_violation` signals (heading hierarchy, labels, contrast, etc.) may also appear from the other a11y-scan heuristics and are orthogonal to this fixture — they must NOT carry the `alt-relevance` tag.

### Case i — good alt (ACCURATE)

- **No `[alt-relevance]` signal expected.** Emitting one is a false-positive regression.
- The alt `"Golden retriever sitting on a porch"` accurately describes the visible dog.

### Case ii — bad alt (INACCURATE)

- **Signal type**: `a11y_violation`.
- **Severity**: `medium` (egregious mismatch but not an information-critical image — it's a decorative photo of a dog).
- **Title pattern**: `Alt-text mismatch: 'Red Submit button'` (first 40 chars of accessible name).
- **Description must include**:
  - A one-line summary of the form `Image depicts: <dog on porch observation>. Author-provided alt/label: "Red Submit button". Relevance grade: INACCURATE.`
  - `source=alt`
  - `WCAG 2.2 SC 1.1.1 Non-text Content (Level A)`
  - A remediation suggestion referencing the visible content (e.g., `suggested alt: "Golden retriever sitting on a porch"` or semantically equivalent).
- **Tags** (exact, order not significant): `["alt-relevance"]`.
- **Evidence**: at least one step index (whichever step captured case ii) and its screenshot filename.

### Case iii — misleading alt on chart (INACCURATE, information-critical)

- **Signal type**: `a11y_violation`.
- **Severity**: `high` (escalated from `medium` because the image is a chart — information-critical per rubric §(e)).
- **Title pattern**: `Alt-text mismatch: 'Weather forecast'`.
- **Description must include**:
  - A one-line summary noting the image depicts a bar chart of quarterly sales, with author-provided alt `"Weather forecast"`. Relevance grade INACCURATE.
  - `source=alt`
  - `WCAG 2.2 SC 1.1.1 Non-text Content (Level A)`
  - A remediation suggestion referencing the chart (e.g., `suggested alt: "Bar chart of quarterly sales 2025, with Q3 highest at 85"` or semantically equivalent; the chart label "Quarterly Sales 2025" is visible in the image).
- **Tags** (exact): `["alt-relevance", "information-critical"]`.
- **Evidence**: step index and screenshot filename for case iii.

### Case iv — decorative (alt="")

- **No `[alt-relevance]` signal expected.**
- A signal here is the primary false-positive risk for this feature — the decorative-image sanity check §(h) must catch it before emit. If case iv produces an `[alt-relevance]` signal, the prompt has regressed and the run must be discarded.

### Case v — figure + figcaption (ACCURATE)

- **No `[alt-relevance]` signal expected.**
- The accessible name comes from `<figcaption>` (since the `<img>` itself has `alt=""` — within a `<figure>` the figcaption is the accessible name per HTML spec). `"Tabby cat napping on a windowsill"` accurately describes the visible cat.

### Case vi — aria-label on role="img" (ACCURATE)

- **No `[alt-relevance]` signal expected.**
- The accessible name comes from `aria-label` on a `<div role="img">`. `"Orange triangle warning icon"` accurately describes the visible CSS-rendered orange warning triangle.

## Severity acceptance band

Per the rubric, severity for INACCURATE cases is `medium` by default, escalated to `high` when the image is information-critical. Both `medium` and `high` are acceptable for case ii (a reviewer could reasonably classify a dog photo as information-critical on, say, a pet-adoption page); `low` is **not** correct for ii or iii because the alts are egregiously mismatched, not merely weaker-than-visible. For case iii, `high` is preferred (chart is clearly information-critical), but `medium` is an acceptable miss on the escalation rule — flag as a prompt-tuning item, not a regression.

## Invariants across all cases

- **Schema acceptance**: `hooks/scripts/validate-primitive-io.sh` must not reject the emitted `signal-report.yaml`. This fixture reuses the existing `a11y_violation` enum entry — no new signal type is introduced. The `tags` array in the schema is already unrestricted ([`schemas/signal-report.schema.yaml:47-50`](../../schemas/signal-report.schema.yaml#L47-L50)).
- **Decorative-image hygiene**: case iv must never appear in the emitted signals with an `[alt-relevance]` tag. This is the primary false-positive risk.
- **Cross-skill isolation**: `/ralph-playwright:explore` (not `a11y-scan`) run against the same URL must NOT emit any `[alt-relevance]` signals. The alt-text relevance prompt lives only in `a11y-scan`.
- **Tag hygiene**: `[alt-relevance]` is always present on signals produced by this sub-procedure. `[information-critical]` is additive (only on severity-escalated signals).
- **Signal count**: exactly two `[alt-relevance]` violations per run (cases ii and iii). Cases i, iv, v, vi must not contribute an `[alt-relevance]` signal.
- **WCAG citation**: every `[alt-relevance]` signal's description must cite `WCAG 2.2 SC 1.1.1 Non-text Content (Level A)` verbatim. Missing or altered citations are a prompt-adherence regression.

## Fixture asset policy

All six images are small local SVGs (< 3 KB each) under [`img/`](img/). SVG chosen over raster PNG because:

1. No binary blobs to commit.
2. Offline-usable with zero external dependencies.
3. Vision models can recognize simple SVG shapes reliably (the alt-relevance judgment does not depend on photo-realism — it depends on whether the model can tell a dog from a submit button, a bar chart from a weather map, and a warning triangle from a kitten).

This matches the plan's Open Question 5 fallback ("If committing small PNG assets … conflicts with repo policies about binary files … the inline SVG approach removes the binary dependency").

## Recording runbook results

After a run, append your observations (emitted signals, severity, timing, any false positives on case iv) to the end of this file under a dated subheading, or capture them in `.playwright-cli/<session>/signal-report.yaml` plus a short pilot note in `thoughts/shared/research/` per the "Act" step's research-note convention. If the run emits an `[alt-relevance]` signal for case iv, treat it as a high-priority prompt-tuning follow-up.

## Related

- Skill: [`plugin/ralph-playwright/skills/a11y-scan/SKILL.md`](../../skills/a11y-scan/SKILL.md)
- Fixture index: [`../README.md`](../README.md) (once GH-788 ships the shared fixture index)
- Issue: [GH-789](https://github.com/cdubiel08/ralph-hero/issues/789)
- Parent plan: [`thoughts/shared/plans/2026-04-20-GH-0789-ralph-playwright-alt-text-relevance-validation.md`](../../../../thoughts/shared/plans/2026-04-20-GH-0789-ralph-playwright-alt-text-relevance-validation.md)
- Parent epic: [GH-784](https://github.com/cdubiel08/ralph-hero/issues/784)
- Sibling fixture: [GH-788 low-contrast](https://github.com/cdubiel08/ralph-hero/issues/788)
- WCAG 2.2 SC 1.1.1 (Non-text Content — Level A): https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html
