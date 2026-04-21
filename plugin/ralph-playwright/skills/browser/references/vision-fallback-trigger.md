---
title: Vision-Fallback Trigger Heuristic
phase: 1
issue: 797
parent: 792
---

# Vision-Fallback Trigger Heuristic

This reference defines when a `ralph-playwright` agent should abandon accessibility-ref targeting and escalate to vision-based pixel-coordinate resolution.

It is a **prose contract** consumed by LLM runtimes (story-runner-agent, explorer-agent). There is no compiled helper — the "helper" is this document plus its worked examples. The trigger is interpreted per-step.

Contract signature (interpreted by agents, not executed):

```
should_use_vision_fallback(snapshot_md: str, target_description: str) -> bool
```

The predicate returns `true` iff the a11y snapshot cannot yield a ref for the target. Returns `false` whenever any plausible ref match exists.

**A11y-first invariant**: a matching ref ALWAYS wins. If a ref exists, vision fallback MUST NOT activate, regardless of quality heuristics.

## Trigger Conditions

Exactly four triggers fire the vision fallback. If any of these is true AND no matching ref exists, return `true`.

### 1. No matching ref

No element in the snapshot corresponds to `target_description` by label, role, or text content.

- Definition: scan the snapshot for any element whose `name`, `role`, or nearby text is a plausible match for the target description. If zero plausible matches, this trigger fires.
- Example snapshot fragment:
  ```
  - button "Log in" [ref=e3]
  - link "Forgot password?" [ref=e4]
  ```
- Target description: `"Submit order"`
- Expected: `true` (no Submit Order ref anywhere in snapshot)

### 2. Canvas region

The target lives inside a `<canvas>` element, which emits at most a single ref for the canvas itself; none of its painted children are accessible.

- Definition: the snapshot shows a `canvas` element (possibly with `role=img`) and the target description refers to a shape/button/pin that the canvas draws internally.
- Example snapshot fragment:
  ```
  - canvas [ref=e12]
  ```
- Target description: `"the blue Submit button"` (painted inside the canvas)
- Expected: `true`

### 3. Map region

A specialization of canvas: a map widget (OpenLayers, Google Maps canvas tile mode) renders pins into tiled canvas layers. The a11y tree sees only the map container.

- Definition: snapshot contains a `canvas` or `div` with name/role suggesting a map (`"Map"`, `"map"`, `role=application` + map label) and the target is a pin or region.
- Example snapshot fragment:
  ```
  - application "Map of United States" [ref=e5]
  ```
- Target description: `"the pin for San Francisco"`
- Expected: `true`

### 4. Empty / sparse snapshot

The snapshot is empty, near-empty, or contains only structural shells (body, root div) with no named interactive elements matching the visible viewport.

- Definition: fewer than 3 interactive elements (`button`, `link`, `textbox`, `checkbox`, etc.) with usable names in the snapshot, AND the screenshot clearly shows interactive content.
- Example snapshot fragment:
  ```
  - generic [ref=e1]
    - generic [ref=e2]
  ```
- Target description: `"Primary CTA"`
- Expected: `true`

## Non-Triggers (a11y wins)

When any of these conditions holds, return `false`. The a11y path MUST be tried and the vision fallback MUST NOT activate.

### Standard button

- Example snapshot fragment:
  ```
  - button "Submit" [ref=e8]
  ```
- Target description: `"Submit"`
- Expected: `false` (ref e8 is a plausible match; use a11y)

### Labeled form field

- Example snapshot fragment:
  ```
  - textbox "Email address" [ref=e11]
  - button "Sign in" [ref=e12]
  ```
- Target description: `"Email address"`
- Expected: `false`

### Anchor link with visible text

- Example snapshot fragment:
  ```
  - link "Pricing" [ref=e20]
  ```
- Target description: `"Pricing link"`
- Expected: `false`

## Worked Examples

Each line below is an input-to-output mapping suitable for unit-style verification. Format: `Input snapshot | Description | should_use_vision_fallback`.

| # | Input snapshot (abbreviated) | Target description | Result | Trigger reason |
|---|-------------------------------|--------------------|--------|----------------|
| 1 | `- canvas [ref=e12]` | "Blue Submit button" | `true` | canvas_region |
| 2 | `- application "Map of US" [ref=e5]` | "Pin for NYC" | `true` | map_region |
| 3 | `- generic [ref=e1]` only | "Primary CTA" | `true` | empty_snapshot |
| 4 | `- button "Log in" [ref=e3]; - link "Forgot password?" [ref=e4]` | "Submit order" | `true` | no_matching_ref |
| 5 | `- button "Submit" [ref=e8]` | "Submit" | `false` | n/a (a11y wins) |
| 6 | `- textbox "Email address" [ref=e11]` | "Email address" | `false` | n/a (a11y wins) |
| 7 | `- link "Pricing" [ref=e20]` | "Pricing link" | `false` | n/a (a11y wins) |
| 8 | `- canvas [ref=e12]; - button "Submit" [ref=e13]` | "Submit" | `false` | ref e13 wins, even though canvas is present |

Example 8 is especially important: the presence of a canvas does NOT automatically trigger vision. The trigger only fires when the target lives inside the canvas AND no a11y ref matches.

## Rationale

Each trigger category exists for a concrete reason:

- **canvas_region**: canvas elements paint bitmap content. Painted shapes/buttons/labels have no DOM children; the a11y tree cannot see them. Vision is the only signal.
- **map_region**: same underlying issue (canvas-based rendering) but with characteristic patterns (named map container, pins-as-painted-sprites). Called out separately so telemetry can distinguish map failures from generic canvas failures.
- **no_matching_ref**: the snapshot captured real content but none of it matches the target. Either the target is behind an overlay, off-screen, or rendered by a non-a11y-accessible widget. Vision can still see it.
- **empty_snapshot**: pathological a11y hygiene (React app without role/aria-label, div soup without semantic tags). Bad a11y is a common reason vision-fallback exists.

## Cross-references

- This trigger is the first gate in the orchestrator sequence defined in [`vision-fallback-sequence.md`](vision-fallback-sequence.md).
- Vision-locator prompt (the callee when this returns `true`): [`vision-locator-prompt.md`](vision-locator-prompt.md).
- Click dispatch (invoked after locator returns coords): [`click-by-coordinate.md`](click-by-coordinate.md).
- Telemetry emission (orchestrator reports `trigger_reason` into `journey-trace.yaml`): see `vision_fallback.trigger_reason` in [`../../../../schemas/journey-trace.schema.yaml`](../../../../schemas/journey-trace.schema.yaml).
