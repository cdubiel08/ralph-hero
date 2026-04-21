---
title: Vision-Fallback Orchestrator Sequence
phase: 4
issue: 800
parent: 792
---

# Vision-Fallback Orchestrator Sequence

This is the single source of truth for how `ralph-playwright` agents execute a targeted interaction when the a11y path may not be available. It composes three primitives:

1. [`vision-fallback-trigger.md`](vision-fallback-trigger.md) — trigger predicate
2. [`vision-locator-prompt.md`](vision-locator-prompt.md) — Opus 4.7 pixel-coordinate resolver
3. [`click-by-coordinate.md`](click-by-coordinate.md) — CLI dispatch primitive

This doc is prose-runtime: the LLM agent (story-runner-agent, explorer-agent) reads it and follows the numbered sequence.

## Sequence

Execute the following for each targeted interaction (click, fill, etc.). This replaces the former single-step "find ref and act" flow. The sequence preserves the a11y-first invariant.

1. **Capture snapshot and screenshot.** As today. Use `playwright-cli snapshot` and `playwright-cli screenshot`. Both outputs feed downstream.
2. **Ref lookup.** Search the snapshot for a ref matching the target (by label, role, visible text). Apply existing matching heuristics unchanged.
3. **If a ref is found** — dispatch `click <ref>` (or the appropriate a11y verb: `fill`, `type`, `hover`, etc.) and record the step with `targeting_method: a11y_ref`. DONE. Vision fallback MUST NOT fire.
4. **If no ref is found** — invoke the trigger predicate from `vision-fallback-trigger.md`, passing the snapshot and target description.
   - If trigger returns `false`, the step **fails per existing semantics**. Record the step with `outcome: fail` and `error: "No ref match and no fallback trigger fired."`. Do NOT invoke the vision locator. DONE.
   - If trigger returns `true`, continue.
5. **Invoke vision locator.** Use the Opus 4.7 prompt from `vision-locator-prompt.md`, passing the screenshot and target description. Parse the response per the Response Parsing rules in that doc.
   - If the parser returns `None` (not-found / invalid / out-of-bounds at locator level), the step fails. Record `targeting_method: vision_fallback`, `vision_fallback.resolved_x: null`, `vision_fallback.resolved_y: null`, `vision_fallback.click_outcome: fail`. DONE.
   - Otherwise continue with `{x, y, confidence, rationale}`.
6. **Bounds validation (pre-dispatch).** Per `click-by-coordinate.md`, assert `0 <= x < viewport_width` and `0 <= y < viewport_height`.
   - If out-of-bounds, record `vision_fallback.click_outcome: out_of_bounds`, step `outcome: fail`. DO NOT dispatch click. DONE.
7. **DPR reconciliation (if needed).** Per `click-by-coordinate.md`, read `window.devicePixelRatio`; if DPR != 1, divide device-pixel coords by DPR. Continue with CSS-pixel coordinates.
8. **Dispatch click by coordinate.** Invoke the eval shim:
   ```bash
   playwright-cli -s="${SESSION}" eval "await page.mouse.click(${CSS_X}, ${CSS_Y})"
   ```
9. **Capture post-click screenshot and snapshot.** Unchanged — the existing step loop does this.
10. **Record telemetry.** Set `targeting_method: vision_fallback` on the step and populate the `vision_fallback` sub-object:
    - `target_description`: the original target description
    - `resolved_x`, `resolved_y`: the coords returned by the locator (device pixels, pre-DPR-reconciliation — keep audit integrity)
    - `confidence`: the locator's confidence
    - `rationale`: the locator's rationale
    - `trigger_reason`: which trigger fired (`no_matching_ref`, `canvas_region`, `map_region`, or `empty_snapshot`)
    - `click_outcome`: `pass` (eval succeeded), `fail` (eval error), or `out_of_bounds` (pre-dispatch)

## Guardrails

Enforced by this sequence and validated by worked tests below.

- **A11y-first invariant.** A matching ref ALWAYS wins. Steps 2-3 execute before any trigger check. A bug that invokes trigger OR locator when a ref was available is a correctness violation. See Orchestrator Test Case 1.
- **No CSS selectors.** The "NEVER use CSS selectors" rule stands unchanged. There are exactly two targeting methods: `a11y_ref` and `vision_fallback`. No third method exists. Any future third method requires an epic-level decision.
- **One vision attempt per action.** Exactly one trigger-check + one locator call + one click-dispatch per a11y failure. No retry loop. If the vision-dispatched click does not produce the expected post-click state, the step fails per existing story-runner semantics.
- **Opus 4.7 pinned for locator.** Enforced via env var `RALPH_PLAYWRIGHT_VISION_LOCATOR_MODEL` (default `opus`). Must not collide with Feature A's `RALPH_PLAYWRIGHT_REFLECT_MODEL`.
- **Bounds validation mandatory.** Out-of-bounds coords from the locator MUST be caught pre-dispatch. Do NOT dispatch click and rely on browser to clamp/reject.

## Failure Modes

Each step has a defined failure outcome and a canonical trace mapping.

| Step | Failure | Trace mapping |
|------|---------|---------------|
| 2 Ref lookup | No match AND trigger false | `outcome: fail`, no `targeting_method` (a11y path was attempted but exhausted) |
| 4 Trigger check | Returns false | same as above |
| 5 Locator call | Returns None | `targeting_method: vision_fallback`, `vision_fallback.click_outcome: fail`, `outcome: fail` |
| 6 Bounds check | Out-of-bounds | `targeting_method: vision_fallback`, `vision_fallback.click_outcome: out_of_bounds`, `outcome: fail` |
| 8 Dispatch | Eval error | `targeting_method: vision_fallback`, `vision_fallback.click_outcome: fail`, `outcome: fail` |

## Worked Examples

### Example A: a11y-success (no fallback)

- Snapshot: `- button "Submit" [ref=e8]`
- Target: `"Submit"`
- Step 2 finds `e8` → Step 3 dispatches `click e8` → records `targeting_method: a11y_ref` → DONE.
- Trigger, locator, bounds, click-by-coord all unused.

### Example B: a11y-fail + vision-success

- Snapshot: `- canvas [ref=e12]`
- Target: `"Blue Submit button"`
- Step 2 finds no matching ref.
- Step 4 invokes trigger → returns `true` with `trigger_reason: canvas_region`.
- Step 5 invokes locator → returns `{x: 720, y: 780, confidence: 0.94, rationale: "..."}`.
- Step 6 bounds check passes (viewport 1440x900).
- Step 7 DPR=1 → no reconciliation.
- Step 8 dispatches `page.mouse.click(720, 780)` → eval succeeds.
- Step 9 captures post-click.
- Step 10 records `targeting_method: vision_fallback`, full `vision_fallback` metadata, `click_outcome: pass`.

### Example C: a11y-fail + vision-fail

- Snapshot: `- canvas [ref=e12]`
- Target: `"Add to cart"` (target is not on this canvas)
- Step 2 finds no matching ref.
- Step 4 trigger returns `true` with `trigger_reason: canvas_region`.
- Step 5 locator returns `{x: null, y: null, confidence: 0.0, rationale: "No 'Add to cart' visible."}`. Parser returns `None`.
- Step 10 records `targeting_method: vision_fallback`, `resolved_x: null`, `resolved_y: null`, `confidence: 0.0`, `click_outcome: fail`, step `outcome: fail`.

## Orchestrator Test Cases

Six fully-worked cases covering the complete decision matrix. Each is the basis for Phase 6 integration assertions.

### Case 1: a11y-success (no fallback invoked)

- **Input**: snapshot contains `- button "Submit" [ref=e8]`, target `"Submit"`, screenshot present.
- **Expected dispatches**: `click e8`. NO trigger call, NO locator call, NO click-by-coord.
- **Trace**: step has `targeting_method: a11y_ref`, no `vision_fallback` block, `outcome: pass`.
- **Invariant check**: a11y-first holds. Trigger must NOT be invoked when a ref exists.

### Case 2: a11y-fail + trigger-false (step fails, no vision)

- **Input**: snapshot `- button "Log in" [ref=e3]; - link "Forgot password?" [ref=e4]`, target `"Sign up"`, screenshot present.
- **Expected dispatches**: trigger invoked (returns `false` — there is a sign-up link absent from this page but not matching any trigger category). NO locator call, NO click-by-coord.
- **Trace**: step has `outcome: fail`, `error: "No ref match and no fallback trigger fired."`. No `targeting_method` set.

**Note on interpretation**: trigger returning `false` means "no ref AND no canvas/map/empty-snapshot condition" — the likely cause is that the target is genuinely absent from this page. The step fails cleanly without spending a vision budget.

### Case 3: a11y-fail + trigger-true + locator-success + click-success (full vision path)

- **Input**: snapshot `- canvas [ref=e12]`, target `"Blue Submit button"`, screenshot 1440x900.
- **Expected dispatches**:
  - trigger invoked → `true`, `trigger_reason: canvas_region`
  - locator invoked → `{x: 720, y: 780, confidence: 0.94, rationale: "..."}`
  - bounds check → pass
  - DPR check → 1
  - click-by-coord → `page.mouse.click(720, 780)` succeeds
- **Trace**: step has `targeting_method: vision_fallback`, `vision_fallback.resolved_x: 720`, `.resolved_y: 780`, `.confidence: 0.94`, `.rationale: "..."`, `.trigger_reason: canvas_region`, `.click_outcome: pass`, `outcome: pass`.

### Case 4: a11y-fail + trigger-true + locator-returns-null (step fails)

- **Input**: snapshot `- canvas [ref=e12]`, target `"Add to cart"` (absent from canvas), screenshot present.
- **Expected dispatches**: trigger → `true, canvas_region`. Locator → `None`. NO click-by-coord.
- **Trace**: `targeting_method: vision_fallback`, `vision_fallback.resolved_x: null`, `.resolved_y: null`, `.confidence: 0.0`, `.click_outcome: fail`, `outcome: fail`.

### Case 5: a11y-fail + trigger-true + locator-success + out-of-bounds (step fails)

- **Input**: snapshot `- canvas [ref=e12]`, target `"Submit button"`, screenshot 1440x900. Locator returns `(1820, 950)` (hallucinated).
- **Expected dispatches**: trigger → `true, canvas_region`. Locator → `{x: 1820, y: 950, ...}`. Bounds check → fail. NO click-by-coord.
- **Trace**: `targeting_method: vision_fallback`, `vision_fallback.resolved_x: 1820`, `.resolved_y: 950`, `.click_outcome: out_of_bounds`, `outcome: fail`.

### Case 6: a11y-fail + trigger-true + locator-success + click-success, confidence < 0.5

- **Input**: same as Case 3 but locator returns `{x: 720, y: 780, confidence: 0.35, rationale: "Ambiguous between Submit and Next — chose Submit based on color."}`.
- **Expected dispatches**: trigger → `true, canvas_region`. Locator → well-formed. Bounds → pass. Click → succeeds.
- **Trace**: `targeting_method: vision_fallback`, `vision_fallback.confidence: 0.35`, `.click_outcome: pass`, `outcome: pass`.
- **Audit flag**: downstream audit queries should surface low-confidence successes for human review. The click still happens — confidence is a signal, not a gate. See "Telemetry Audit Queries" below.

## Telemetry Audit Queries

Copy-paste ready `yq` / `jq` snippets for auditing vision-fallback usage. Targets the journey trace YAML (typically at `.playwright-cli/<session>/journey-trace.yaml`).

```bash
# Count vision-fallback invocations per trace
yq '[.steps[] | select(.targeting_method == "vision_fallback")] | length' trace.yaml

# List trigger reasons (debugging which failure modes fired)
yq '.steps[] | select(.targeting_method == "vision_fallback") | .vision_fallback.trigger_reason' trace.yaml

# Filter low-confidence clicks (flag for human review)
yq '.steps[] | select(.vision_fallback.confidence < 0.5)' trace.yaml

# Find out-of-bounds locator responses (model hallucinating coords)
yq '.steps[] | select(.vision_fallback.click_outcome == "out_of_bounds")' trace.yaml

# Compute vision-fallback success rate
yq '[.steps[] | select(.targeting_method == "vision_fallback") | .vision_fallback.click_outcome == "pass"] | (. | length) as $total | [.[] | select(. == true)] | length | "pass rate: \(.) / \($total)"' trace.yaml
```

Each query is idempotent against an unmodified trace. Phase 6 integration runner uses the first and last in its assertions.

## Cross-references

- Trigger predicate: [`vision-fallback-trigger.md`](vision-fallback-trigger.md)
- Locator prompt: [`vision-locator-prompt.md`](vision-locator-prompt.md)
- Click dispatch: [`click-by-coordinate.md`](click-by-coordinate.md)
- Telemetry schema: [`../../../../schemas/journey-trace.schema.yaml`](../../../../schemas/journey-trace.schema.yaml)
- Hook validator: [`../../../../hooks/scripts/validate-primitive-io.sh`](../../../../hooks/scripts/validate-primitive-io.sh)
