---
date: 2026-04-20
status: draft
type: plan
github_issue: 788
github_issues: [788]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/788
primary_issue: 788
parent_plan: thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md
tags: [ralph-playwright, a11y, wcag, contrast, opus-4-7, vision]
---

# ralph-playwright: pixel-computed color contrast in a11y-scan — Implementation Plan

## Prior Work

- builds_on:: [[2026-04-16-opus-4-7-ralph-playwright-vision]]
- builds_on:: [[2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic]]

## Overview

Single-issue plan for GH-788 (Feature D in the #784 epic): extend `a11y-scan` so its reflect step uses Opus 4.7's vision to pick foreground and background pixels for every visible text run, compute WCAG 2.x contrast ratios in-prompt, and emit `a11y_violation` signals tagged `[pixel-computed]` for every failure. Replaces the unenforceable DOM-based "contrast" criterion at `skills/a11y-scan/SKILL.md:39` with a mechanism grounded in actual rendered pixels.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-788 | ralph-playwright: pixel-computed color contrast in a11y-scan | S |

## Shared Constraints

Inherited verbatim from the parent plan-of-plans ([2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md)):

### Architecture & file ownership
- Execute -> Reflect -> Act pipeline is strict and schema-enforced. Any schema changes must be additive.
- Hooks in `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` validate signal-report.yaml at Read/Write boundaries.
- Reflect runs in the calling model's context — Opus 4.7 routing is this feature's interlocutor, not a sub-agent.
- Screenshots (PNG) and accessibility snapshots (`.md`) are captured at EVERY step. This feature reads the screenshot directly, no new capture.
- No CSS selector usage; no change to element targeting.

### Model routing discipline
- This feature does not declare a new model slot. It depends on whatever reflect-model is resolved by Feature A (#785). For the life of this plan, Opus 4.7 is the target model for the contrast prompt; if Sonnet runs reflect, the prompt still degrades gracefully — contrast estimates will be noisier but not broken.

### Cost & token envelope
- Default capture resolution stays at playwright-cli's current viewport default. Contrast estimation from default-resolution screenshots is Opus 4.7's documented sweet spot.
- No opt-in to `--high-res` (Feature J) is required here; when J lands, high-res screenshots will produce more accurate contrast readings automatically.

### Prompt engineering conventions
- Contrast-estimation prompts must respect large-text thresholds: **4.5:1 for normal text, 3:1 for large text (>=18pt OR >=14pt bold)**, matching WCAG 2.2 SC 1.4.3.
- Categorized checklists beat free-form instructions. The contrast section is a self-contained sub-checklist under the existing reflect step.

### Artifact paths
- Signal output lives in `.playwright-cli/<session>/signal-report.yaml`.
- Evidence screenshots are referenced by filename (already captured by execute).

### Research anchoring
- Research: [2026-04-16-opus-4-7-ralph-playwright-vision.md §Part 3 Item 4](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md) — motivates pixel-computed contrast as a targeted fill of the unenforceable DOM criterion at `a11y-scan/SKILL.md:39`.

### Feature-specific decisions (adopted here, not in parent plan)

**Signal-type decision: use `a11y_violation` with tag `[pixel-computed]`, NOT a new `contrast_violation` type.**

Rationale:
- The epic plan-of-plans says "if this feature introduces a new signal type, it must update `schemas/signal-report.schema.yaml:23` enum AND the hook validator in the same change, mirroring the pattern in #793." A new type is allowed but not required.
- Sibling Feature E (#789, alt-text relevance) uses the same pattern — `a11y_violation` with tag `[alt-relevance]`. Mirroring it keeps a11y-scan signal-type surface narrow.
- Downstream consumers (act phase, WCAG reporting) already key off `a11y_violation`. A new type would require updating the act skill, any consumers, and docs.
- The `[pixel-computed]` tag is discoverable, sortable, and distinguishes pixel-derived contrast failures from hypothetical future DOM-derived ones.

**Contrast math location: in-prompt computation, not post-processing.**

Rationale:
- Opus 4.7 is documented to handle "pixel-level data transcription" and low-level perception; asking the model to emit both the sampled fg/bg sRGB values AND the computed ratio in one turn is within its capability and avoids a second round-trip or a helper script.
- The prompt includes the WCAG formula for the model to apply step-by-step, making the ratio auditable in-signal (the signal description includes the fg hex, bg hex, and computed ratio — a reviewer can verify the arithmetic without re-running the model).
- Keeps ralph-playwright's minimal-dependency posture intact — no new `sharp`/`color`/`tinycolor` libraries.

**Text-on-image handling: pick the immediate background pixel under the text, not a fictional "mean background".**

Rationale:
- WCAG's effective contrast is pixel-local; a dark text overlaying a varied photo fails contrast only if the immediate pixels behind the characters are insufficient. The prompt must instruct the model to sample the background pixels immediately adjacent to each glyph stroke, not a bounding-box average.
- When text sits on a gradient or photo, the prompt asks the model to report the worst-case local ratio across the text run (as a conservative measure), and flag "variable background" in the signal description.

## Current State Analysis

From [plugin/ralph-playwright/skills/a11y-scan/SKILL.md:32-43](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/a11y-scan/SKILL.md#L32-L43):

```
### Step 2: Reflect (a11y signals only)

Read the journey trace. For each step, examine the accessibility snapshot (`.md` file) for:

- **Missing or empty labels**: ...
- **Color contrast**: Text against background ratios below 4.5:1 (normal) or 3:1 (large)   <-- LINE 39
- **Missing alt text**: ...

Classify all findings as `a11y_violation` signals with WCAG success criteria references.
```

The bullet point lists contrast as a criterion but the step examines only the `.md` accessibility snapshot. DOM trees contain no rendered-color information — CSS computed style can tell you declared text/background colors at specific nodes, but `playwright-cli`'s accessibility snapshot is a logical tree, not a CSS computed-style dump. Today this criterion is **listed but unenforceable**.

The signal-report schema already supports this feature without change: `a11y_violation` is in the enum at [schemas/signal-report.schema.yaml:23](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/signal-report.schema.yaml#L23), severity enum covers critical/high/medium/low, and the `tags` array is already free-form, so a `[pixel-computed]` tag requires no schema change.

The hook validator at [hooks/scripts/validate-primitive-io.sh:93-99](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh#L93-L99) already accepts `a11y_violation` as a valid signal type. No validator update is needed for this feature.

No test-fixtures directory exists yet under `plugin/ralph-playwright/`. The parent plan says: "Shared fixtures live under (recommended) `plugin/ralph-playwright/fixtures/` — a new directory introduced by whichever feature needs test pages first." This feature introduces the `fixtures/` directory with one low-contrast page.

## Desired End State

### Verification

- [ ] `a11y-scan` reflect step includes a pixel-computed contrast sub-checklist with WCAG formula and thresholds (4.5:1 normal, 3:1 large).
- [ ] Signal output uses `type: a11y_violation` with `tags` containing `[pixel-computed, wcag-1.4.3]` (large-text failures also tag `[large-text]`).
- [ ] Signal description fields include the sampled fg and bg sRGB values (as hex), the computed ratio (2 decimal places), the WCAG threshold that was missed, and the text content that failed.
- [ ] Running `a11y-scan` against the fixture at `plugin/ralph-playwright/fixtures/low-contrast/index.html` produces at least one `a11y_violation` signal tagged `[pixel-computed]` for the known-failing text block.
- [ ] Running `a11y-scan` against a known-passing reference fixture produces no `[pixel-computed]` violations for text that meets 4.5:1 (normal) or 3:1 (large).
- [ ] `validate-primitive-io.sh` passes on the emitted signal-report.yaml (no schema rejection).
- [ ] Decorative/near-invisible text conventionally used for spacing (`color: transparent`, zero-opacity) is not flagged — the prompt instructs the model to ignore text with `opacity: 0` or font-size 0 that is invisible to users.
- [ ] Documentation in SKILL.md (the bullet at line 39) updated from a DOM-phrased criterion to a vision-phrased criterion, retaining WCAG cross-reference.

## What We're NOT Doing

- **Not adding a new signal-type enum value.** Decided above — `a11y_violation` + tag `[pixel-computed]` covers the need; no schema change required.
- **Not rendering pixel inspectors in-prompt via PIL/sharp.** Opus 4.7 handles pixel-level transcription directly per Anthropic's docs. If accuracy proves insufficient post-launch, a follow-up issue can add tool-use for a color sampler.
- **Not computing APCA or WCAG 3.0 contrast.** WCAG 2.2 SC 1.4.3 only — the current AA baseline that #788 acceptance criteria call out.
- **Not enforcing enhanced AAA thresholds (7:1 / 4.5:1).** AA only. AAA can be a follow-up driven by consumer demand.
- **Not validating contrast against state changes** (hover, focus, visited). Current reflect reads one static screenshot per step. If focus/hover states are captured as separate steps by execute, those get contrast checked too, for free, but no new per-state orchestration.
- **Not computing contrast for text inside `<svg>`, `<canvas>`, video, or embedded PDFs.** The prompt can still flag visible low-contrast text in those if the model perceives it, but we make no guarantees.
- **Not adding automatic fix suggestions** beyond WCAG-standard guidance (text that fails 4.5:1 needs darker fg or lighter bg by N points of luminance). The act skill may synthesize more; that's out of scope here.
- **Not coupling to Feature A (#785) model routing.** This plan lands standalone. If reflect runs on Sonnet, the contrast estimates will be noisier but still shaped correctly; a signal with wrong ratio is mitigated by the hex fg/bg being in the signal description (a reviewer can recompute).
- **Not wiring to Feature F (#790) bounding boxes.** Cross-reference: when F lands, the contrast-failure signal should populate a `bbox` around the failing text run. That is a one-line prompt extension after F's schema lands, NOT this feature's work.

## Implementation Approach

One phase: extend the `a11y-scan` SKILL.md reflect step with a pixel-computed contrast sub-checklist, add an end-to-end-runnable low-contrast fixture, run the skill against the fixture to confirm signals fire, and update the user-facing docs line at `a11y-scan/SKILL.md:39` so the contrast bullet reflects what the mechanism actually does.

No schema changes. No hook changes. No new signal type. The feature is a prompt engineering change plus a fixture, with a verified-against-fixture end-to-end test.

---

## Phase 1: Pixel-computed contrast in a11y-scan (GH-788)

- **depends_on**: null

### Overview

Rewrite the contrast bullet and add a contrast sub-checklist to `skills/a11y-scan/SKILL.md`'s reflect step. The sub-checklist tells the model: (a) for each text run visible in the screenshot, sample fg and bg sRGB pixels at the glyph stroke, (b) apply the WCAG 2.x relative-luminance formula, (c) compute the contrast ratio, (d) compare against the WCAG 2.2 SC 1.4.3 threshold (4.5:1 normal, 3:1 large), (e) emit an `a11y_violation` signal for every failure, with the hex fg/bg, ratio, and text content in the description and tags `[pixel-computed, wcag-1.4.3]` (plus `[large-text]` when applicable). Add a low-contrast fixture so the feature is verifiable against a known-failing page. Emit the result through the existing signal-report pipeline — no schema or hook changes.

### Tasks

#### Task 1.1: Create low-contrast test fixture

- **files**: `plugin/ralph-playwright/fixtures/low-contrast/index.html` (create), `plugin/ralph-playwright/fixtures/low-contrast/README.md` (create), `plugin/ralph-playwright/fixtures/README.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `fixtures/README.md` at directory root explains the fixtures directory convention (introduced by this feature per parent plan recommendation) and lists the fixtures in the tree.
  - [ ] `fixtures/low-contrast/index.html` is a static HTML page with at least 4 labeled text samples:
    - Sample A: normal-weight 16px body text with deliberately failing contrast (e.g., `#888` text on `#fff` background — ratio ~3.54:1, fails 4.5:1).
    - Sample B: normal-weight 16px body text with passing contrast (e.g., `#595959` text on `#fff` — ratio ~7:1, passes 4.5:1).
    - Sample C: large-weight text (24px bold, i.e. >=18pt equivalent) with passing contrast for large-text threshold but failing normal-text threshold (e.g., `#949494` text on `#fff` — ratio ~2.8:1, fails 3:1 large). Goal: exercise the large-text branch.
    - Sample D: white text over a mid-tone photographic/gradient background image via CSS background-image — to exercise text-on-image logic.
  - [ ] Each sample is wrapped in a labeled container with `data-contrast-case="A|B|C|D"` and a visible heading, so the README + signal report can reference cases unambiguously.
  - [ ] `fixtures/low-contrast/README.md` documents each case, the expected computed ratio (to 2 decimals), and whether it should or should not trigger a `[pixel-computed]` violation when a11y-scan is run on the page.
  - [ ] Page is servable from `python3 -m http.server` or any static server — no build step.

#### Task 1.2: Extend a11y-scan SKILL.md reflect step with pixel-contrast sub-checklist

- **files**: `plugin/ralph-playwright/skills/a11y-scan/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Line 39 (`**Color contrast**:`) rewritten from DOM-phrased to vision-phrased: "**Color contrast (pixel-computed from screenshot)**: For every text run visible in the screenshot, sample the rendered foreground pixel at a glyph stroke and the immediate background pixel adjacent to it. Apply the WCAG 2.x contrast ratio formula. Flag violations per the thresholds below."
  - [ ] A new subsection `#### Pixel-computed contrast sub-checklist` added immediately after the existing bullet list (before the "Classify all findings..." paragraph). It contains:
    - **(a) What to sample**: for each visible text run, pick ONE foreground pixel at a glyph stroke and ONE background pixel immediately adjacent to the stroke (within ~2 px). For text over non-uniform backgrounds (image, gradient), sample the worst-case background pixel across the text run and flag the signal description with "variable background: worst-case sampled".
    - **(b) What to skip**: text with `opacity: 0` from the accessibility snapshot; text smaller than 6 px rendered (illegible at any contrast); decorative repetitive glyphs used as icon fonts where the accessibility snapshot reveals them as aria-hidden or decorative.
    - **(c) The formula** (inline, verbatim so the model can quote it):
      ```
      L = 0.2126 * R_lin + 0.7152 * G_lin + 0.0722 * B_lin
      where for each channel c in {R, G, B} normalized to [0, 1]:
        c_lin = c / 12.92                      if c <= 0.03928
        c_lin = ((c + 0.055) / 1.055) ^ 2.4    otherwise
      ratio = (L_light + 0.05) / (L_dark + 0.05)
      ```
    - **(d) Thresholds**:
      - Normal text: ratio must be >= 4.5:1. Below is a fail.
      - Large text (>=18 pt / 24 px OR >=14 pt / 18.66 px bold): ratio must be >= 3:1. Below is a fail.
      - Heuristic for detecting large text from pixels: text whose x-height exceeds ~12 px (normal weight) or ~10 px (bold) qualifies as large. When uncertain, report in description.
    - **(e) Output shape**: for each failure, emit an `a11y_violation` signal whose:
      - `severity`: critical if ratio < 3.0:1 (effectively unreadable); high if 3.0 <= ratio < threshold; medium if ratio is at-threshold within ±0.1:1 (ambiguous, reviewer to confirm).
      - `title`: `"Insufficient contrast: <ratio>:1 on '<first 40 chars of text>'"`
      - `description`: includes fg hex, bg hex, computed ratio (2 decimal places), applicable threshold (4.5:1 or 3:1), the text content that failed, WCAG 2.2 SC 1.4.3 reference, and remediation guidance ("increase fg darkness by N luminance points OR lighten bg").
      - `evidence.steps`: the step indices where the text is visible.
      - `evidence.screenshots`: the screenshot filenames.
      - `tags`: `["pixel-computed", "wcag-1.4.3"]`; add `"large-text"` when the large-text threshold applied; add `"variable-background"` when text was on an image/gradient.
  - [ ] A "Self-audit" final bullet instructs the model: before emitting any `[pixel-computed]` signal, re-check its own arithmetic — "L for fg = ..., L for bg = ..., (max+0.05)/(min+0.05) = ..., threshold = ..., verdict = fail/pass". This keeps computed ratios auditable.
  - [ ] The Step 3 `Act` block is unchanged (existing promotion/issue-creation flow handles any `a11y_violation` already).
  - [ ] No change to the signal-report schema reference or hook notes; the feature explicitly relies on the existing `a11y_violation` enum entry.
  - [ ] The SKILL.md explanation explicitly notes "This is pixel-computed; requires Opus 4.7 (or comparable vision model) at reflect time for best accuracy. Sonnet will produce noisier estimates but signal shape is preserved."

#### Task 1.3: Reference contrast-specific model guidance in a11y-scan SKILL.md

- **files**: `plugin/ralph-playwright/skills/a11y-scan/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] A short `## Reflect model notes` subsection added at the bottom of the SKILL.md (above or below the Step 4 Report block — placement reviewer's choice). Content:
    - Pixel-computed contrast in Step 2 requires a vision-capable model at reflect.
    - Preferred: Opus 4.7 (2576px image ceiling, 1:1 pixel-to-coordinate mapping, documented pixel-level transcription).
    - Acceptable fallback: Sonnet 4.6; accuracy degrades proportionally with perceptual resolution.
    - When Feature A (#785) lands, the reflect model will be resolved by the env var `RALPH_PLAYWRIGHT_REFLECT_MODEL` or the skill-level preferred-model hint. This feature does not declare a new env var.
  - [ ] No code changes outside SKILL.md.

#### Task 1.4: End-to-end fixture validation

- **files**: `plugin/ralph-playwright/fixtures/low-contrast/expected-signals.md` (create), `plugin/ralph-playwright/fixtures/low-contrast/README.md` (modify — add "How to verify" section)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - [ ] `expected-signals.md` documents the expected signals the model should emit for each of samples A-D (counts, tags, approximate ratios, severity bands). It is documentation not a machine-checked spec — this feature has no automated test matrix because ralph-playwright is skills/agents-only per parent plan.
  - [ ] `fixtures/low-contrast/README.md` "How to verify" section contains a runbook:
    1. Start a static server: `python3 -m http.server 8765 --directory plugin/ralph-playwright/fixtures/low-contrast`.
    2. Invoke `/ralph-playwright:a11y-scan http://localhost:8765/`.
    3. Read the emitted `.playwright-cli/<session>/signal-report.yaml`.
    4. Expected: at least one `a11y_violation` with `tags: [pixel-computed, wcag-1.4.3, ...]` for sample A (normal-text fail).
    5. Expected: at least one `a11y_violation` with `tags: [..., large-text]` for sample C (large-text fail).
    6. Expected: no `[pixel-computed]` violation for sample B (normal-text pass).
    7. Expected: a `[pixel-computed, variable-background]` violation for sample D if the overlay is insufficient.
    8. `validate-primitive-io.sh` does not reject the emitted signal-report.yaml at Read time.
  - [ ] Runbook results recorded inline (or in a pilot-log file) once executed, with any deltas noted as future-work bullets.

### Phase Success Criteria

#### Automated Verification

- [ ] `yq .` parses `plugin/ralph-playwright/skills/a11y-scan/SKILL.md` frontmatter without error (existing hooks/tooling).
- [ ] When a11y-scan is executed against the low-contrast fixture, the resulting `.playwright-cli/<session>/signal-report.yaml` passes `hooks/scripts/validate-primitive-io.sh` — specifically no "Invalid signal types" or "Invalid signal severities" errors (because we reuse the existing `a11y_violation` enum entry).

#### Manual Verification

- [ ] Run `/ralph-playwright:a11y-scan` against the fixture URL with Opus 4.7 as the reflect model. Confirm at least the critical failures (samples A and C) are detected.
- [ ] Confirm each emitted signal contains: `tags` including `pixel-computed` and `wcag-1.4.3`; `description` with fg hex, bg hex, computed ratio, and text content.
- [ ] Sanity-check one ratio by hand: e.g., `#888` on `#fff` — expected ratio ~3.54:1 via WCAG 2.x formula. If the model's emitted ratio is outside ±0.15 of the hand-computed value, note it as a model-accuracy concern in the pilot log and tune prompt wording.
- [ ] Running a11y-scan against a conventionally accessible page (e.g., `https://webaim.org/resources/contrastchecker/`) produces no `[pixel-computed]` false positives for clearly compliant text.
- [ ] SKILL.md diff is reviewable in a single sitting (under ~80 lines of change).

**Creates for next phase**: not applicable — single-phase plan. However, this feature produces the `plugin/ralph-playwright/fixtures/` directory convention, which sibling features (#789 alt-relevance, #790 annotated evidence, #791 semantic diff, #792 vision-fallback) are expected to extend. The `fixtures/README.md` sets the pattern.

---

## Integration Testing

- [ ] Cross-skill: run a fresh `/ralph-playwright:explore` (freeform, not a11y-scan) against the low-contrast fixture. Confirm that the reflect phase (unchanged here) does NOT emit `[pixel-computed]` contrast violations — that tag is only produced by the a11y-scan prompt, preserving separation of concerns.
- [ ] Signal coexistence: when a11y-scan emits a `[pixel-computed]` contrast failure on the same step as a DOM-derived violation (e.g., missing label), both signals appear in the report without collision, and both flow through the act phase unmodified.
- [ ] Hook invariance: run `validate-primitive-io.sh` on the emitted report; confirm no new enum values cause rejection (this is a negative assertion — we deliberately did not add a new enum value).

## References

- Parent plan-of-plans: [thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md) — Feature D section, lines 113-120.
- Research: [thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md §Part 3 Item 4](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md).
- Issue: [#788](https://github.com/cdubiel08/ralph-hero/issues/788).
- Sibling epic issues (for cross-reference): [#789 alt-text relevance](https://github.com/cdubiel08/ralph-hero/issues/789) (mirrors the tag-on-existing-type pattern used here), [#785 model routing](https://github.com/cdubiel08/ralph-hero/issues/785), [#790 bounding boxes](https://github.com/cdubiel08/ralph-hero/issues/790) (future bbox integration).
- WCAG 2.2 SC 1.4.3 (Contrast — Minimum): https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html.
- WCAG relative-luminance definition: https://www.w3.org/WAI/GL/wiki/Relative_luminance.
- Files referenced:
  - [plugin/ralph-playwright/skills/a11y-scan/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/a11y-scan/SKILL.md)
  - [plugin/ralph-playwright/schemas/signal-report.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/signal-report.schema.yaml)
  - [plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh)

## Open Questions

1. **Opus 4.7 in-prompt arithmetic reliability**. The plan asks the model to both sample pixels AND compute the WCAG ratio in one pass. If pilot evidence shows the model consistently mis-computes the formula (e.g., skips the gamma-correction branch), a follow-up issue should add a tiny helper (Python or Node) that takes `(fg_hex, bg_hex)` and emits the authoritative ratio — the model would then emit only sampled hex codes. Not blocking for this plan.
2. **Sub-pixel antialiasing effect on sampled fg color**. Antialiased glyph edges produce blended colors that are neither pure fg nor pure bg. The prompt says "sample at a glyph stroke", which empirically lands on a partially-blended pixel for small text. If this produces optimistic ratios (ratio higher than actual perceived contrast), the prompt may need "sample the darkest core stroke pixel" language. Recommend piloting then tuning.
3. **Large-text detection from pixels alone**. The prompt gives an x-height heuristic (~12 px), but determining font-weight from pixels is unreliable for condensed or medium weights. If misclassification of large-text threshold becomes a measurable issue, we could cross-reference the DOM snapshot for computed-style font-size / font-weight when available, and fall back to pixel heuristic only when DOM is unavailable.
4. **AAA scope**. Issue #788 asks for AA only. Adding an AAA threshold (7:1 / 4.5:1) would be trivial once the AA logic works. Defer to user demand.
5. **Interaction with Feature F (#790) when it lands**. Once bounding boxes are in the schema, each `[pixel-computed]` signal should include a bbox around the failing text run. That is a prompt-level extension after F's schema ships; not in this plan but worth recording here so the integration isn't forgotten.
6. **Interaction with Feature J (#794) `--high-res`**. Default-resolution screenshots may be too coarse for small-text contrast at 10-12 px font. When J lands, a11y-scan may want to opt into `--high-res` at capture time. Cross-reference only; not blocking.
7. **False-positive risk on visual effects**. Text with a drop-shadow or text-stroke can read as high-contrast to users even when the sampled fg vs. bg pair alone would fail. WCAG 2.x's formula does not account for shadows/strokes. Acknowledge this limitation in SKILL.md; noted in the "variable background" caveat but could deserve a dedicated `[effects-aided]` tag later.
