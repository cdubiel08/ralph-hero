# Semantic Diff Prompt (Opus 4.7)

This prompt powers the in-loop semantic visual diff in `reflect`'s `--baseline` mode (see #791/#816). It compares a current screenshot against its matched baseline screenshot from a prior run and emits a bulleted list of meaningful visual changes, framed in the same rubric as reflect's Step 2 structured visual audit.

The diff prompt does NOT re-author the seven-category audit — it borrows the rubric by reference. The seven categories are documented in [`../SKILL.md`](../SKILL.md) Step 2:

- **Layout integrity** — overlap, clipping, horizontal overflow, broken stacking
- **Typography** — truncation, mixed faces, unintended size jumps, broken kerning
- **Imagery** — broken placeholders, missing thumbnails, aspect-ratio squish, pixelation
- **State visibility** — lingering spinners, missing feedback, error/success confusion
- **Visual hierarchy** — wrong CTA emphasis, destructive-as-primary, competing primaries
- **Chart & data UIs** — missing axis/units, legend/data mismatch, illegible density
- **Viewport / responsive** — unintended scroll, fold-clipping, container escape

Apply that rubric, restricted to A/B comparison: surface differences between the two screenshots that fall into any of those seven categories. Do NOT enumerate the categories in your output — they are the lens, not the answer.

## Model pin

Inherits the reflect skill's `model: claude-opus-4-7` frontmatter (see `../SKILL.md` § Model Routing). Override via `RALPH_PLAYWRIGHT_REFLECT_MODEL`. The diff prompt is designed to degrade — under Sonnet it returns a more conservative bullet list rather than crashing.

## Prompt Template

```
# Semantic Visual Diff: Baseline vs Current

## Inputs
- Baseline screenshot: attached as the FIRST image (PNG, 1:1 pixel map)
- Current screenshot: attached as the SECOND image (PNG, 1:1 pixel map)
- Step context:
  - action: "{{ACTION}}"
  - target: "{{TARGET}}"
- Noise floor: {{NOISE_FLOOR}}

## Task

Compare the two screenshots. Apply reflect's Step 2 structured visual audit (the
seven categories: layout integrity, typography, imagery, state visibility,
visual hierarchy, chart & data UIs, viewport/responsive — see `../SKILL.md`
Step 2 for the full rubric), restricted to A/B comparison. Surface MEANINGFUL
visual changes between the baseline and the current screenshot.

Ignore these as rendering noise, not regressions: anti-aliasing, font hinting,
animation frames, timestamps, cursor/caret position, minor sub-pixel rendering.

## Noise-Floor Rubric

The `{{NOISE_FLOOR}}` setting governs the meaningful-change threshold:

- **low** — Include any change you can see. Minor alignment shifts, color
  variations, font-weight changes all count.
- **medium** (default) — Include changes that affect visual hierarchy,
  readability, or user affordance. Skip micro-alignments and color palette
  tweaks that preserve intent.
- **high** — Include only changes that meaningfully alter layout, state, or
  functionality. Skip stylistic refinements.

Apply the rubric for the level you were given. Be conservative when in doubt:
the cost of a missed regression is a follow-up PR; the cost of a false-positive
flood is operator fatigue.

## Output Format

Return a markdown bulleted list. One bullet per meaningful change. Each bullet
is a single natural-language sentence: <subject> <change> [quantity/direction].

Examples of correct bullet style:

- Submit button moved ~40px down and lost its drop shadow.
- Primary navigation changed from horizontal to hamburger; three links removed.
- Error banner replaced with inline field-level errors.
- Hero image replaced with broken-image placeholder glyph.
- Pricing column truncated; "/month" suffix no longer visible.

Do NOT describe the images. Do NOT produce raw diff output. Do NOT describe
unchanged elements. Do NOT enumerate the seven audit categories. Do NOT include
preamble like "Looking at the two screenshots..." or summary like "Those are
the changes I noticed."

If there are no meaningful changes, return exactly the single line:

NO-MEANINGFUL-CHANGES

(All caps, hyphens, no bullet, no surrounding prose.)
```

## Concrete Example

### Filled prompt

```
# Semantic Visual Diff: Baseline vs Current

## Inputs
- Baseline screenshot: attached as the FIRST image (PNG, 1:1 pixel map)
- Current screenshot: attached as the SECOND image (PNG, 1:1 pixel map)
- Step context:
  - action: "click"
  - target: "#submit"
- Noise floor: medium

[... rest of template body ...]
```

### Expected response (real layout shift)

```
- Submit button moved ~40px down and lost its drop shadow.
- Form-field error styling switched from inline red text to a top-of-form banner.
- Primary CTA color changed from solid blue to an outlined ghost variant.
```

### Expected response (identical or trivial-noise pair)

```
NO-MEANINGFUL-CHANGES
```

### Expected response (chatty preamble — parser tolerates this)

```
After reviewing both screenshots I noticed the following meaningful changes:

- Submit button moved ~40px down and lost its drop shadow.

Those are the ones worth flagging at the medium noise floor.
```

The parser ignores non-bullet lines, so chatty preamble does not produce phantom
signals. Models are nudged away from preamble by the explicit "Do NOT include
preamble" instruction, but the parser is robust either way.

## Input Slots

The template carries three placeholders, filled by `renderPrompt()` in
`scripts/diff-emitter.mjs`:

| Slot | Source | Example |
|------|--------|---------|
| `{{ACTION}}` | `step.action` from the journey trace | `click` |
| `{{TARGET}}` | `step.target` from the journey trace | `#submit` |
| `{{NOISE_FLOOR}}` | `noiseFloor` option (default `medium`) | `low` / `medium` / `high` |

The image attachments (baseline + current PNGs) are NOT placeholders inside the
prompt text — they are passed to the model as separate vision inputs by the
calling skill (#816's reflect-phase wiring), in the order baseline-then-current.
