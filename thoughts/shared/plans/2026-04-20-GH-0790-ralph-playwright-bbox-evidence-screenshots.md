---
date: 2026-04-20
status: draft
type: plan
github_issue: 790
github_issues: [790, 803, 805, 808, 811, 814, 817]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/790
primary_issue: 790
parent_plan: thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md
tags: [ralph-playwright, opus-4-7, bbox, annotation, signal-report, schema, evidence]
---

# ralph-playwright: annotated evidence screenshots with bounding boxes — Feature Plan

## Prior Work

- builds_on:: [[2026-04-16-opus-4-7-ralph-playwright-vision]]
- builds_on:: [[2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic]]

## Overview

Feature F of the epic (#784). Six pre-split atomic sub-issues, each executed and landed independently; this document is the umbrella that orders them, documents the cross-cutting surfaces, and captures the open design decision so the spike (#803) does not land in isolation. Each atomic gets its own detailed implementation plan when it enters `/ralph-plan` individually.

| Phase | Issue | Title | Estimate | depends_on |
|-------|-------|-------|----------|------------|
| 1 | [GH-803](https://github.com/cdubiel08/ralph-hero/issues/803) | bbox renderer design spike (pick annotation approach) | XS | null |
| 2 | [GH-805](https://github.com/cdubiel08/ralph-hero/issues/805) | add `bboxes` to signal-report schema evidence block | XS | null |
| 3 | [GH-808](https://github.com/cdubiel08/ralph-hero/issues/808) | extend hook validator to accept `bboxes` | XS | [GH-805] |
| 4 | [GH-811](https://github.com/cdubiel08/ralph-hero/issues/811) | implement bbox annotation renderer (chosen approach) | S | [GH-803] |
| 5 | [GH-814](https://github.com/cdubiel08/ralph-hero/issues/814) | teach reflect SKILL.md to populate `bboxes` | XS | [GH-805] |
| 6 | [GH-817](https://github.com/cdubiel08/ralph-hero/issues/817) | promote annotated screenshot alongside original in act | S | [GH-811] |

**Why grouped**: These six atomics form a single user-visible capability — annotated evidence screenshots driven by Opus 4.7's bounding-box output. Shipping any one atomic alone produces no visible effect. Shipping them as a single umbrella ensures the schema, validator, renderer, prompt, and act-phase wiring all land in a coherent order. Atomics 1, 2, 3, 5 are XS; 4 and 6 are S. Total: 6 atomics.

## Shared Constraints

Inherited verbatim from the parent plan-of-plans (`thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md`). Extended with feature-specific constraints at the bottom.

### Architecture & file ownership (from parent)

- The Execute -> Reflect -> Act pipeline is strict and schema-enforced. Any new inputs/outputs flow through the three YAML schemas in `plugin/ralph-playwright/schemas/`: `journey-trace.schema.yaml`, `signal-report.schema.yaml`, `action-log.schema.yaml`. Schema additions must be additive (new optional fields) unless explicitly noted.
- Hooks in `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` validate journey-trace, signal-report, and action-log YAMLs at Read and Write boundaries. Any schema change that tightens validation must update the hook in the same PR.
- Execute runs as a sub-agent (`explorer-agent` or `story-runner-agent`) with `model: sonnet`. Keep Sonnet for Execute. Reflect runs in the calling model's context — that is the sole tier where Opus 4.7 routing applies.
- Screenshots (PNG) and accessibility snapshots (`.md`) are captured at EVERY step. No feature may opt out of either capture.
- The "NEVER use CSS selectors" rule in `plugin/ralph-playwright/agents/story-runner-agent.md:50` stays in force for accessible elements.

### Prompt engineering conventions (from parent)

- Categorized checklists beat free-form instructions.

### Artifact paths (from parent)

- Session data: `.playwright-cli/<session>/` (journey-trace.yaml, signal-report.yaml, action-log.yaml, screenshots, snapshots).
- Promoted evidence: `thoughts/local/assets/<session>/` for both original and annotated screenshots.

### Verification tooling (from parent)

Ralph-playwright is skills/agents-only — there is no build/test matrix for the plugin itself. Feature verification is phase-specific:

- **Schema changes** — run a sample pipeline that reads/writes the affected YAML, confirm `validate-primitive-io.sh` does not reject.
- **Prompt changes** — run the updated skill on one real journey; qualitatively assess signal quality.
- **Runtime changes** — exercise on a fixture with the target failure mode; confirm the new path fires.

### Research anchoring (from parent)

Every feature plan must cite the parent research doc `thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md` in Prior Work. This feature implements Part 3 Item 6 ("Annotated evidence screenshots").

### Feature-specific constraints

- **Minimal-dependencies posture**: ralph-playwright ships no npm-built artifacts today (it is skills/agents only; `playwright-cli` is installed externally via `/ralph-playwright:setup`). Any renderer decision that adds a runtime dependency (e.g. `sharp`) must be justified against zero-dep alternatives (SVG sidecar, Node-stdlib-only PNG write) in the spike doc.
- **Deterministic output**: `foo.png` + identical bboxes must always produce byte-identical `foo.annotated.png`. Non-deterministic rendering would poison downstream semantic diff (#791) by introducing spurious pixel noise at annotation boundaries.
- **Filename convention is a contract**: `<stem>.annotated.png` sibling to `<stem>.png`. This convention is referenced across atomics and should not drift. A signal with `evidence.bboxes[].screenshot: "03_checkout.png"` maps to a promoted `03_checkout.annotated.png` in `thoughts/local/assets/<session>/`.
- **Schema-first ordering**: The schema change (#805) MUST ship before or with the hook validator (#808). Signal reports containing `bboxes` produced by a newer reflect SKILL.md (#814) would be rejected by an older validator. In practice the two land in the same PR per parent-plan coupling rule.
- **No opt-in flag on the signal-report side**: `bboxes` is an additive optional field. Old signal reports without `bboxes` continue to validate. The renderer and act-phase promotion are triggered by the *presence* of `bboxes`, not by a command-line flag.
- **Coordinate system**: 1:1 with the PNG pixels (no DPR scaling, no downsample). This is Opus 4.7's contract and is stated in the parent research doc.

## Current State Analysis

### Signal-report schema today

`plugin/ralph-playwright/schemas/signal-report.schema.yaml:33-46` defines `evidence` as:

```yaml
evidence:
  type: object
  required: [steps, screenshots]
  properties:
    steps:
      type: array
      items: { type: integer }
    screenshots:
      type: array
      items: { type: string }
```

No bounding-box carrier exists. Evidence is limited to "which step" and "which screenshot file".

### Validator today

`plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh:93-104` does a minimal enum check on `signals[].type` and `signals[].severity`. It does NOT walk `evidence` subtrees; extending it to check `bboxes[]` integrity requires new `yq` passes. The existing pattern (enum grep + exit 1 on violation) provides the template.

### Reflect today

`plugin/ralph-playwright/skills/reflect/SKILL.md:26` says only: "Read the screenshot (the PNG file at the `screenshot` path) — look for visual anomalies, layout issues, error states". The YAML example in Step 4 (lines 53-69) does not mention `bboxes`. The model is given the image but never told it can emit coordinates.

### Act / capture today

Multiple act-phase entry points promote screenshots to `thoughts/local/assets/`:

- `plugin/ralph-playwright/skills/capture/SKILL.md:72-97` — single-step capture → promote one screenshot
- `plugin/ralph-playwright/skills/explore/SKILL.md:49-75` — multi-step explore → promote evidence screenshots
- `plugin/ralph-playwright/skills/test-e2e/SKILL.md:58-69` — test run → promote failure screenshots

All three currently copy the original only. An annotated sibling must be produced and promoted when bboxes are present on the signal that references the screenshot.

The action log enum (`plugin/ralph-playwright/schemas/action-log.schema.yaml:23`) already includes `screenshot_promoted` — no schema change is needed for logging annotated copies. Each promotion (original + annotated) emits one log entry.

### Renderer today

There is no renderer. No `plugin/ralph-playwright/scripts/` directory exists; the plugin contains only skills, agents, schemas, hooks, and a plugin manifest. The design spike (#803) must pick where rendering code lives and what dependencies it needs.

## Desired End State

A reflect run on a journey trace produces a signal report whose signals can carry pixel-accurate `bboxes` tied to evidence screenshots. The validator accepts and sanity-checks those bboxes. The act phase invokes a renderer that emits `<stem>.annotated.png` with rectangles (and optional labels) drawn over the original. Both original and annotated get promoted to `thoughts/local/assets/<session>/`. The action log captures both promotions.

### Verification (feature-level, rolls up atomics)

- [x] Signal reports with `bboxes` validate against schema and hook
- [x] Signal reports without `bboxes` still validate (backward compatible)
- [x] Validator rejects malformed bboxes (negative coords, zero dims, screenshot not in `evidence.screenshots`) with a readable error
- [x] Reflect SKILL.md teaches model to emit `bboxes` on region-specific signals and to omit on whole-page signals
- [x] Renderer emits deterministic `<stem>.annotated.png` with red rectangles + labels when `note` is present
- [x] Renderer exits 0 with no output when bboxes array is empty
- [x] Act phase (capture, explore, test-e2e paths) promotes both original and `.annotated.png` when bboxes exist
- [x] Action log records one `screenshot_promoted` per file (original + annotated)
- [x] End-to-end: one real journey produces at least one signal with `bboxes`, validator passes, renderer emits, act promotes both, note references both

## What We're NOT Doing

- **Mutating playwright-cli itself**. The external npm package `@playwright/cli` is not modified. If the spike picks approach (a) "extend playwright-cli with an `annotate` subcommand", that means shipping a wrapper script inside ralph-playwright that mimics a CLI surface — not opening a PR against upstream `@playwright/cli`.
- **Client-side interactive viewer for SVG sidecar**. If the spike picks (c), the SVG is produced as a sibling artifact only. Rendering it overlaid on the PNG in a browser is out of scope (documented as a future idea in the spike if chosen).
- **Baseline / diff support for annotated screenshots**. Semantic diff (#791) operates on the ORIGINAL screenshot. Annotated output is evidence, not a diff input. Feature G will explicitly skip `*.annotated.png` when walking a session.
- **Retroactive annotation**. Old sessions without `bboxes` do not get re-rendered. Only signals produced after #814 lands will carry bboxes.
- **Tight coupling to reflect-prompt structure**. The reflect SKILL.md change (#814) is a prompt addition; it does not depend on the structured visual audit prompt (#786 Feature B) — though B makes the model more likely to notice the regions worth annotating.
- **Multi-bbox overlap resolution**. If two bboxes overlap, both are drawn — no merge, no z-ordering logic. Document the behavior in the renderer; callers can deduplicate if desired.
- **Bbox coordinate rounding policies**. Model emits integers per the schema (schema constrains to `type: integer`). If floats sneak through, validator rejects. Renderer does not coerce.
- **New signal type**. Bboxes attach to existing signal types (`anomaly`, `a11y_violation`, `ux_issue`, `error`, `regression`). This feature adds no enum entries.

## Implementation Approach

Six atomics in two parallel chains that re-converge at the act phase.

```
      Chain A (renderer):     #803 (spike) ──▶ #811 (renderer impl) ──▶ #817 (act promotion) ◀──┐
                                                                                                │
      Chain B (schema):       #805 (schema) ──┬──▶ #808 (hook validator)                        │
                                              │                                                 │
                                              └──▶ #814 (reflect SKILL.md)                      │
                                                                                                │
      Integration convergence: #817 consumes both chains (renderer from A, schema from B) ──────┘
```

Round 1 (all `depends_on: null`): #803 and #805 can be worked in parallel.
Round 2 (after #803): #811.
Round 2 (after #805): #808 and #814 in parallel.
Round 3 (after #811): #817.

The feature is complete when #817 lands. #805 and #808 typically land in the same PR (schema + hook coupling rule from parent plan).

**Recommended execution order** (if sequentialized): #803 → #805 → #808 → #811 → #814 → #817. This matches the order the issue body lists and is the order the sub-issues were pre-split. Parallel execution is safe when worktrees isolate the edits, but linear execution is lowest-coordination.

### Why this ordering is correct

- #803 before #811: without a chosen approach, the renderer atomic has no spec to code against.
- #805 before #808 and #814: hook validator and reflect prompt both reference the new schema shape. Landing validator/prompt before schema breaks validation on the first signal emitted.
- #811 before #817: act-phase promotion calls the renderer. No renderer → no promotion.
- #817 last: integration point. Requires BOTH the renderer (to produce `.annotated.png`) AND the reflect prompt update (to populate `bboxes` so the act phase has something to render from).

### Cross-cutting file inventory

Each atomic touches a narrow slice. Together, the feature touches these files:

| File | Touched by | Change kind |
|------|------------|-------------|
| `plugin/ralph-playwright/schemas/signal-report.schema.yaml` | #805 | Add `bboxes` array under `evidence.properties` |
| `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` | #808 | Add `yq` pass over `.signals[].evidence.bboxes[]` |
| `plugin/ralph-playwright/skills/reflect/SKILL.md` | #814 | Update Step 2 guidance + Step 4 YAML example |
| `plugin/ralph-playwright/skills/capture/SKILL.md` | #817 | Promote `.annotated.png` sibling when bboxes present |
| `plugin/ralph-playwright/skills/explore/SKILL.md` | #817 | Same (act-phase section) |
| `plugin/ralph-playwright/skills/test-e2e/SKILL.md` | #817 (if applicable) | Same for failure-screenshot promotion |
| `plugin/ralph-playwright/scripts/annotate.*` or `plugin/ralph-playwright/skills/annotate/` | #811 | New renderer code (location TBD by spike) |
| `thoughts/shared/research/YYYY-MM-DD-bbox-renderer-decision.md` | #803 | New decision doc |

Atomic-level plans will scope their individual file touches when they enter `/ralph-plan` individually; the above is the umbrella inventory.

### How the schema change propagates

A single additive edit to `signal-report.schema.yaml:33-46` is the keystone. Every other atomic references it:

- #808 reads the schema shape to know what shape to validate
- #814 embeds the shape in the reflect SKILL.md YAML example
- #811 consumes the shape at runtime (accepts a list of `{screenshot, x, y, w, h, note?}` objects from the signal report)
- #817 reads signals whose `evidence.bboxes[]` is populated and dispatches to the renderer

This means if the spike (#803) or any downstream atomic uncovers a need to change the schema shape (e.g. add `color` or `label_position`), the change loops back through #805 first, then fans out. Keep the schema minimal in #805; add fields later if needed.

### The spike's gating decision

#803 produces a short decision doc naming one of:
- (a) **Extend playwright-cli with an `annotate` subcommand**: ralph-playwright ships a node script that registers as `playwright-cli annotate`. Likely infeasible without forking the external package — probably dispreferred.
- (b) **Node helper using `sharp`**: ships a Node script under `plugin/ralph-playwright/scripts/annotate.mjs` that requires `sharp`. Adds native-binding dep.
- (c) **SVG sidecar overlays**: produce `<stem>.annotated.svg` referencing the PNG with `<image>` + drawn `<rect>` elements. Zero dependencies. Downside: "annotated.png" filename convention would need relaxation — the parent issue explicitly says `.annotated.png`, so this option changes the contract. The spike must either (i) justify relaxing the filename to `.annotated.svg`, OR (ii) pair SVG with a headless PNG rasterizer (reintroduces a dep, defeating the purpose of c).

Most likely winner is (b), given the issue's explicit PNG requirement. The spike decides.

---

## Phase 1: GH-803 — bbox renderer design spike

- **depends_on**: null

### Overview

Short decision doc comparing the three rendering approaches against ralph-playwright's minimal-dependencies posture. Picks one, documents the renderer interface `(png_path, bboxes[]) -> annotated_png_path`, and notes the filename convention `<stem>.annotated.png`.

### Scope (references full atomic issue)

See [GH-803](https://github.com/cdubiel08/ralph-hero/issues/803) for the full atomic spec. The atomic's own detailed implementation plan will be produced when it enters `/ralph-plan`.

### Phase Success Criteria

- [x] Decision doc committed under `thoughts/shared/research/` with filename `YYYY-MM-DD-bbox-renderer-decision.md`
- [x] Chosen approach posted as a comment on #790
- [x] Renderer interface signature + input/output contract documented
- [x] Downstream renderer issue (#811) updated with chosen approach (comment + label)

**Creates for next phase**: A locked rendering approach (a/b/c) so #811 has a concrete implementation target. No other phase depends on this one.

---

## Phase 2: GH-805 — add `bboxes` to signal-report schema evidence block

- **depends_on**: null

### Overview

Single schema edit. Add an optional `bboxes` array under `evidence.properties` in `plugin/ralph-playwright/schemas/signal-report.schema.yaml`. Keep optional (not in `evidence.required`) to preserve backward compatibility.

### Scope (references full atomic issue)

See [GH-805](https://github.com/cdubiel08/ralph-hero/issues/805) for the exact YAML shape to add.

### Phase Success Criteria

- [x] `bboxes` array present under `evidence.properties` matching the shape in #805's body
- [x] Field is optional (not added to `evidence.required`)
- [x] Existing example signal reports (if any) still validate
- [x] Schema diff limited to the `evidence` block

**Creates for next phase**: The schema shape that #808 validates and #814 documents in the reflect prompt example.

---

## Phase 3: GH-808 — extend hook validator to accept `bboxes` in signal-report

- **depends_on**: [GH-805]

### Overview

Extend `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` signal-report branch to walk `.signals[].evidence.bboxes[]` and enforce: non-negative `x`,`y`; positive `w`,`h`; `screenshot` reference appears in parent signal's `evidence.screenshots`.

### Scope (references full atomic issue)

See [GH-808](https://github.com/cdubiel08/ralph-hero/issues/808). Follows the same pattern as existing enum checks in the script.

### Phase Success Criteria

- [x] Validator exits 0 for reports with valid `bboxes`
- [x] Validator exits 0 for reports with no `bboxes` (backward compat)
- [x] Validator exits 1 with a useful message on malformed coords
- [x] Validator exits 1 on `bbox.screenshot` not appearing in `evidence.screenshots`
- [x] Happy-path + two failure-mode test cases documented in PR description

**Note on PR coupling**: Per parent-plan coupling rule, #805 and #808 typically land in the SAME PR. A validator that rejects `bboxes` while the schema allows it is inconsistent; a validator that accepts `bboxes` while the schema disallows is also inconsistent. Atomic authors may merge the two PRs if that helps.

**Creates for next phase**: None directly — this phase hardens the schema change. #817 consumes the validated output via the reflect → act pipeline.

---

## Phase 4: GH-811 — implement bbox annotation renderer (chosen approach)

- **depends_on**: [GH-803]

### Overview

Implement the renderer picked by the spike. Given `foo.png` + list of bboxes, emits deterministic `foo.annotated.png` with red rectangles (3px stroke, high-contrast color) and optional `note` labels rendered above each box with a solid-background pill for legibility.

### Scope (references full atomic issue)

See [GH-811](https://github.com/cdubiel08/ralph-hero/issues/811). Implementation location TBD by spike (`plugin/ralph-playwright/scripts/` vs `plugin/ralph-playwright/skills/annotate/` vs extending playwright-cli).

### Phase Success Criteria

- [x] `foo.png` + valid bboxes emits `foo.annotated.png` alongside original
- [x] Empty bboxes array → no annotated output, exit 0
- [x] Output deterministic across runs (byte-identical on identical input)
- [x] Documented invocation (CLI or Node helper)
- [x] Unit tests cover: one bbox, multiple bboxes, bbox at image edge, missing `note`

**Creates for next phase**: A callable renderer entry point that #817 invokes during act-phase promotion.

---

## Phase 5: GH-814 — teach reflect SKILL.md to populate `bboxes` when applicable

- **depends_on**: [GH-805]

### Overview

Prompt update only. Update `plugin/ralph-playwright/skills/reflect/SKILL.md` Step 4 YAML example to include `bboxes`, add an explicit rule on when to populate vs. omit, and add a brief bullet near Step 2 reminding the model to note pixel coordinates while examining each screenshot.

### Scope (references full atomic issue)

See [GH-814](https://github.com/cdubiel08/ralph-hero/issues/814). Concrete YAML example must use realistic coords (not `0,0,0,0`).

### Phase Success Criteria

- [x] Reflect SKILL.md documents the `bboxes` field with a concrete YAML example matching the schema in #805
- [x] Rule for when to populate vs. omit is explicit (populate for region-specific signals; omit for whole-page signals)
- [x] Pixel coords explicitly described as 1:1 with the screenshot image (no scaling)
- [x] No behavioral changes outside the documented skill update

**Independence from #811**: The prompt change can land before the renderer. Until #811 ships, the model may emit `bboxes` but nothing is drawn — the act phase will simply skip rendering (no crash). This graceful degradation is intentional.

**Creates for next phase**: Signals with populated `bboxes` flowing into act phase, giving #817 something to render.

---

## Phase 6: GH-817 — promote annotated screenshot alongside original in act phase

- **depends_on**: [GH-811]

### Overview

Wire the renderer into the act / capture flow. For each screenshot referenced by a signal with `bboxes`, invoke the renderer (from #811) to emit `<stem>.annotated.png` next to the original in the session directory. Copy both files into `thoughts/local/assets/<note-slug>/` preserving naming. Append both promotions to the action log as `screenshot_promoted` entries with appropriate `from`/`to` paths.

### Scope (references full atomic issue)

See [GH-817](https://github.com/cdubiel08/ralph-hero/issues/817). Touches `capture/SKILL.md:72-97` and `explore/SKILL.md:49-75`. The `test-e2e/SKILL.md:58-69` failure-promotion path is in scope if signals on failure steps carry bboxes; otherwise left to a follow-up.

### Phase Success Criteria

- [x] Signals with bboxes produce an annotated sibling in the session directory
- [x] Both original and annotated files copy into the note's asset directory
- [x] Action log contains one `screenshot_promoted` entry per file
- [x] Signals without bboxes do not invoke the renderer (no regression on existing flow)
- [x] End-to-end walkthrough in PR description or scripted fixture run

**Implicit dependency on #805 and #814**: This phase assumes the signal report it reads can carry `bboxes` (schema: #805) and that reflect populated them (prompt: #814). If #817 lands before either, it is harmless (no signals have bboxes → the new code path is never taken). But the FEATURE-level end-to-end verification requires all five other atomics to have landed first.

**Creates for next phase**: None. Feature complete at end of this phase.

---

## Integration Testing

Feature-level verification after all six atomics have landed. This test is run once as part of closing #790:

1. Run `/ralph-playwright:capture http://example.com/some-page` with a note argument.
2. Seed a synthetic `bboxes` entry into the produced `signal-report.yaml` (simulates the reflect model populating bboxes). Coordinates chosen to fall inside the captured PNG.
3. Re-run the act phase (by re-reading the edited signal report).
4. Verify:
   - `.playwright-cli/<session>/00_page.annotated.png` exists and differs byte-for-byte from `00_page.png` only in the annotation region
   - `thoughts/local/assets/<note-slug>/00_page.png` and `thoughts/local/assets/<note-slug>/00_page.annotated.png` both exist
   - `.playwright-cli/<session>/action-log.yaml` contains two `screenshot_promoted` entries
   - `validate-primitive-io.sh` accepts the signal-report.yaml containing bboxes
5. Separately, produce a malformed signal-report with `bboxes[].x: -5` and confirm the validator rejects it with a readable error.

Integration test is documented here so atomic authors know the shape of the umbrella verification; individual atomic PRs do not need to run this end-to-end test.

## References

- Parent epic: [GH-784](https://github.com/cdubiel08/ralph-hero/issues/784)
- This feature: [GH-790](https://github.com/cdubiel08/ralph-hero/issues/790)
- Atomic sub-issues: [GH-803](https://github.com/cdubiel08/ralph-hero/issues/803), [GH-805](https://github.com/cdubiel08/ralph-hero/issues/805), [GH-808](https://github.com/cdubiel08/ralph-hero/issues/808), [GH-811](https://github.com/cdubiel08/ralph-hero/issues/811), [GH-814](https://github.com/cdubiel08/ralph-hero/issues/814), [GH-817](https://github.com/cdubiel08/ralph-hero/issues/817)
- Research: [thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md) §Part 3 Item 6
- Plan-of-plans: [thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md) Feature F
- Key files:
  - [plugin/ralph-playwright/schemas/signal-report.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/signal-report.schema.yaml)
  - [plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh)
  - [plugin/ralph-playwright/skills/reflect/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/reflect/SKILL.md)
  - [plugin/ralph-playwright/skills/capture/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/capture/SKILL.md)
