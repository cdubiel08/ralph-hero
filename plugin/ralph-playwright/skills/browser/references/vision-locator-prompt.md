---
title: Vision-Locator Prompt (Opus 4.7)
phase: 2
issue: 798
parent: 792
preferred-model: opus
model-env-var: RALPH_PLAYWRIGHT_VISION_LOCATOR_MODEL
---

# Vision-Locator Prompt

Opus 4.7 prompt template for resolving pixel coordinates of a target described in plain language, given a full-page screenshot as the visual reference.

This prompt is the vision-reasoning core of the fallback. It is invoked ONLY when [`vision-fallback-trigger.md`](vision-fallback-trigger.md) returns `true`.

**Model pin**: `opus` by default. Override via env var `RALPH_PLAYWRIGHT_VISION_LOCATOR_MODEL`. Sonnet is allowed for dev-only debugging but never the shipped default. The env var is distinct from Feature A's `RALPH_PLAYWRIGHT_REFLECT_MODEL` — they refer to different Opus 4.7 invocations with different cost profiles.

Contract signature (interpreted by agents):

```
resolve_target_coordinates(screenshot_path: str, target_description: str) -> {x, y, confidence, rationale} | None
```

## Prompt Template

```
# Vision-Locator: Pixel Coordinate Resolution

## Inputs
- Screenshot: attached (PNG, 1:1 pixel map)
- Target description: "{TARGET_DESCRIPTION}"

## Task
Locate the target described above in the screenshot. Return the **center pixel**
of the target as integer offsets from the top-left corner of the image, in the
1:1 pixel space of the attached PNG.

If the target is not visible in the screenshot, return nulls for x and y and
set confidence to 0.0.

## Output Schema

Return JSON only. No prose, no explanation outside the JSON. No markdown fences.

```json
{
  "x": <integer | null>,
  "y": <integer | null>,
  "confidence": <number in [0.0, 1.0]>,
  "rationale": "<one-sentence explanation of what you saw and why>"
}
```

Coordinate semantics:
- `x` is pixels from the LEFT edge of the image (0-indexed).
- `y` is pixels from the TOP edge of the image (0-indexed).
- Both refer to pixel offsets in the attached PNG, at its native resolution.
  Do NOT scale. Do NOT assume CSS pixel units. If the screenshot was captured
  at device-pixel resolution, return device pixels.
- Aim for the VISUAL CENTER of the target. Not the edge, not the bounding-box
  corner, not a caption or label near the target.

Not-found semantics:
- If the target is not in the screenshot, or if the target description is
  ambiguous (multiple plausible targets, no clear primary), return
  `{"x": null, "y": null, "confidence": 0.0, "rationale": "..."}`.

## Guardrails

- Do NOT click decorative elements (logos, section headers, ornamental icons)
  that are not interactive.
- If the description mentions a CTA, prefer the primary CTA styling (filled
  button over ghost button, color-contrast emphasis, larger font).
- If there are multiple plausible targets, DECLINE rather than guess. Return
  nulls with a rationale explaining the ambiguity.
- If the screenshot contains partially-loaded / spinner / skeleton state,
  DECLINE. Return nulls.
- Never return coordinates outside the image bounds.
```

## Response Parsing

The caller MUST validate the returned JSON before dispatching a click. Validation rules:

1. **JSON parses** — response is valid JSON. If parse fails, treat as not-found and return `None`.
2. **Required keys present** — `x`, `y`, `confidence`, `rationale` all exist.
3. **Coordinates well-formed** — if `x` and `y` are not null, both are integers in `[0, image_width)` and `[0, image_height)` respectively. If out-of-bounds, treat as not-found and return `None`.
4. **Confidence well-formed** — `confidence` is a number in `[0.0, 1.0]`. If outside that range, clamp (or reject if clamping is unsafe per caller policy).
5. **Rationale non-empty** — `rationale` is a non-empty string.

Any validation failure collapses the result to `None` (not-found) at the orchestrator boundary. Partial / malformed responses are not propagated downstream.

### Worked Examples

#### Happy path: canvas button

- Screenshot: 1440x900 image of a canvas-rendered form with a blue "Submit" button near the bottom
- Target description: `"Blue Submit button"`
- Model response (well-formed):
  ```json
  {
    "x": 720,
    "y": 780,
    "confidence": 0.94,
    "rationale": "Center of the large blue filled button labeled 'Submit' at the form bottom."
  }
  ```
- Parsed: `{x: 720, y: 780, confidence: 0.94, rationale: "..."}` — click dispatched.

#### Happy path: map pin

- Screenshot: 1440x900 map showing three labeled pins (SF, NYC, LA)
- Target description: `"Pin for San Francisco"`
- Model response:
  ```json
  {
    "x": 210,
    "y": 420,
    "confidence": 0.88,
    "rationale": "Leftmost pin with 'SF' callout label, located on the West Coast region of the map."
  }
  ```
- Parsed: `{x: 210, y: 420, confidence: 0.88, rationale: "..."}` — click dispatched.

#### Not visible

- Screenshot: 1440x900 login page
- Target description: `"Add to cart button"`
- Model response:
  ```json
  {
    "x": null,
    "y": null,
    "confidence": 0.0,
    "rationale": "No 'Add to cart' button visible — this appears to be a login screen with email/password fields."
  }
  ```
- Parsed: `None`. Orchestrator records `click_outcome: fail`, step outcome `fail`.

#### Out-of-bounds (model error case)

- Screenshot: 1440x900
- Target description: `"Submit button"`
- Model response (hallucinated coordinates):
  ```json
  {
    "x": 1820,
    "y": 950,
    "confidence": 0.5,
    "rationale": "Submit button at bottom right."
  }
  ```
- Parsed: `None` (x=1820 exceeds width=1440, y=950 exceeds height=900). Orchestrator records `click_outcome: out_of_bounds`.

## Smoke Test Results

The prompt was smoke-tested against a simple fixture PNG — a hand-drawn canvas with a blue "Submit" button at approximately (480, 620) on a 960x720 image.

- Model: `opus` (anthropic/claude-opus-4-7)
- Target description: `"Blue Submit button"`
- Response (representative):
  ```json
  {
    "x": 482,
    "y": 618,
    "confidence": 0.91,
    "rationale": "Center of the blue rectangular button labeled 'Submit' near the bottom of the canvas."
  }
  ```
- Parse outcome: valid JSON, all required keys present, coords within bounds (`0 <= 482 < 960`, `0 <= 618 < 720`), confidence in range.
- Result: PASS. Coordinates within 5 pixels of the hand-drawn target center.

Failure modes observed during smoke testing (and guardrail responses):

- Prose preamble ("Looking at the image, I can see...") before JSON — guardrail: "Return JSON only" added; retry rate dropped to 0 on re-run.
- Markdown fences around JSON (` ```json ... ``` `) — guardrail: "No markdown fences" added; parser additionally strips surrounding fences defensively before `JSON.parse`.
- Hallucinated coordinates for targets not in image — mitigated by explicit not-found semantics in the prompt. Validation still catches it via bounds check.

If future smoke runs fail, record the failure mode in a new row above and propose a prompt adjustment before closing any downstream phase.

## Cross-references

- Invoked when [`vision-fallback-trigger.md`](vision-fallback-trigger.md) returns `true`.
- Output feeds into [`click-by-coordinate.md`](click-by-coordinate.md) for dispatch.
- Full orchestrator flow: [`vision-fallback-sequence.md`](vision-fallback-sequence.md).
- Telemetry: `vision_fallback.resolved_x`, `.resolved_y`, `.confidence`, `.rationale` in [`../../../../schemas/journey-trace.schema.yaml`](../../../../schemas/journey-trace.schema.yaml).
