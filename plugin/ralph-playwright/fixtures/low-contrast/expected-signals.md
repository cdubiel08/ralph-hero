# expected-signals: low-contrast fixture

Documentation-only oracle listing the `a11y_violation` signals that a correctly-configured `/ralph-playwright:a11y-scan` run against [`index.html`](index.html) should emit. Not a machine-checked spec — ralph-playwright is skills/agents-only per the parent plan. Use this file to hand-verify the runbook results.

All ratios are from the WCAG 2.x relative-luminance formula quoted verbatim in [`../../skills/a11y-scan/SKILL.md`](../../skills/a11y-scan/SKILL.md). The `±0.15` tolerance on ratios accounts for model-driven pixel-sampling noise (antialiasing blends edge pixels).

## Case A — normal-fail

- **Signal type**: `a11y_violation`.
- **Severity**: `high` (3.0 ≤ ratio < 4.5).
- **Title pattern**: `Insufficient contrast: 3.54:1 on 'The quick brown fox jumps over the lazy'` (approximate; first 40 chars of failing text).
- **Description must include**:
  - `fg=#888888`
  - `bg=#ffffff`
  - `ratio=3.54:1` (± 0.15)
  - `threshold=4.5:1`
  - The failing text (quoted).
  - `WCAG 2.2 SC 1.4.3 (Contrast — Minimum)`
  - Remediation guidance (darken fg OR lighten bg).
- **Tags** (exact set, order not significant): `["pixel-computed", "wcag-1.4.3"]`.
- **Evidence**: at least one step index (whichever step captured case A) and its screenshot filename.

## Case B — normal-pass

- **No `[pixel-computed]` signal expected.**
- A signal here is a false-positive regression. Computed ratio ~7.00:1 on `#595959` / `#ffffff` comfortably exceeds 4.5:1.
- Other `a11y_violation` types (e.g., heading hierarchy) may still appear but must not carry the `pixel-computed` tag.

## Case C — large-text fail

- **Signal type**: `a11y_violation`.
- **Severity**: `critical` (ratio < 3.0:1).
- **Title pattern**: `Insufficient contrast: 2.81:1 on 'Headline sample: 24 px bold.'` (approximate).
- **Description must include**:
  - `fg=#9a9a9a`
  - `bg=#ffffff`
  - `ratio=2.81:1` (± 0.15)
  - `threshold=3:1` (large-text threshold applied because the sample is 24 px bold).
  - WCAG reference and remediation as above.
- **Tags** (exact set): `["pixel-computed", "wcag-1.4.3", "large-text"]`.
- **Evidence**: step index and screenshot filename for case C.

## Case D — variable background

- **Signal type**: `a11y_violation`.
- **Severity**: `critical` or `high` depending on which portion of the gradient the model sampled as worst-case. White-on-near-white on the right edge of the gradient produces a ratio near 1.05:1 (critical).
- **Title pattern**: `Insufficient contrast: 1.1:1 on 'The quick brown fox jumps over the lazy'` (approximate; ratio varies with sampled bg).
- **Description must include**:
  - `fg=#ffffff`
  - `bg=#<worst-case hex> (variable background: worst-case sampled)` — likely something near `#d8d8d8`–`#e8e8e8`.
  - Computed ratio to 2 decimal places.
  - `threshold=4.5:1`
  - WCAG reference and remediation.
- **Tags** (exact set): `["pixel-computed", "wcag-1.4.3", "variable-background"]`.
- **Evidence**: step index and screenshot filename for case D.

## Self-audit block (present in every `[pixel-computed]` signal description)

Per the SKILL.md sub-checklist (f), every pixel-computed signal description must contain a restated arithmetic block of the form:

```
L for fg (hex=<fg>) = <per-channel c_lin, then L>
L for bg (hex=<bg>) = <per-channel c_lin, then L>
ratio = (max(L_fg, L_bg) + 0.05) / (min(L_fg, L_bg) + 0.05) = <value>
applicable threshold = <4.5:1 | 3:1> (reason: <normal | large-text>)
verdict = fail
```

If the restated arithmetic block is missing, the run has not applied the prompt correctly — flag it as a prompt-adherence regression.

## Invariants across all cases

- **Schema acceptance**: `hooks/scripts/validate-primitive-io.sh` must not reject the emitted `signal-report.yaml`. This fixture reuses the existing `a11y_violation` enum entry; no new signal type is introduced.
- **Cross-skill isolation**: `/ralph-playwright:explore` (the non-a11y skill) run against the same URL must emit ZERO `[pixel-computed]` signals. The pixel-computed contrast prompt lives only in `a11y-scan`.
- **Tag hygiene**: `[pixel-computed]` always co-occurs with `[wcag-1.4.3]`. `[large-text]` and `[variable-background]` are additive — a single signal may carry both if a large-text run sits on a variable background.
- **Signal count**: at least 3 `[pixel-computed]` violations per run against this fixture (cases A, C, D). Case B must not contribute a `[pixel-computed]` violation.

## Known false-positive risks

These are documented fundamental limitations of the WCAG 2.x formula plus pixel sampling; they are NOT regressions to fix in this plan:

- Text with a drop-shadow, text-stroke, or anti-aliased edge may read as higher-contrast to a human viewer than the raw fg/bg pair suggests. The fixture does not include such effects to keep the oracle crisp.
- Sub-pixel antialiasing on small text can produce a blended fg sample that is optimistic (higher contrast than the core stroke). The prompt mitigates this by instructing the model to sample the darkest core stroke pixel. Persistent antialiasing-induced drift is a future prompt-tuning task, not a fixture defect.
