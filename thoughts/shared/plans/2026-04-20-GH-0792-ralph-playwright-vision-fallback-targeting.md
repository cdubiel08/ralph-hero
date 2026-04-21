---
date: 2026-04-20
status: draft
type: plan
tags: [ralph-playwright, opus-4-7, vision, vision-fallback, canvas, maps, a11y, journey-trace, computer-use]
github_issue: 792
github_issues: [792, 797, 798, 799, 800, 801, 802]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/792
  - https://github.com/cdubiel08/ralph-hero/issues/797
  - https://github.com/cdubiel08/ralph-hero/issues/798
  - https://github.com/cdubiel08/ralph-hero/issues/799
  - https://github.com/cdubiel08/ralph-hero/issues/800
  - https://github.com/cdubiel08/ralph-hero/issues/801
  - https://github.com/cdubiel08/ralph-hero/issues/802
primary_issue: 792
parent_plan: thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md
---

# ralph-playwright: Vision-Fallback Element Targeting — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-16-opus-4-7-ralph-playwright-vision]]
- builds_on:: [[2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic]]

## Overview

This plan covers Feature H of the Opus 4.7 vision epic (GH-784). Six pre-split atomic sub-issues are composed in a single feature-plan umbrella. Each atomic maps to one phase below.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-797 | detect no-ref-available trigger for vision fallback | S |
| 2 | GH-798 | Opus 4.7 vision-locator prompt for pixel-coordinate resolution | S |
| 3 | GH-799 | click-by-coordinate action via playwright-cli | XS |
| 4 | GH-800 | fallback sequence orchestration (a11y-first, vision-fallback) | S |
| 5 | GH-801 | journey-trace telemetry for vision-fallback usage | XS |
| 6 | GH-802 | test fixtures + integration coverage for canvas/map/bad-a11y | S |

**Why grouped**: Six atomics compose a single causal chain — detect, resolve, execute, orchestrate, observe, prove. They MUST ship together or the earlier primitives have no caller. `#797`, `#798`, `#799` are independent leaves that can be built in parallel; `#800` wires them; `#801` instruments the orchestrator; `#802` validates end-to-end. All six land in one coherent release. Splitting further yields atomics that cannot be individually verified in isolation.

**Dependency chain**: `(#797, #798, #799) -> #800 -> #801 -> #802`

## Shared Constraints

Inherited from the parent plan-of-plans (`thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md` §Shared Constraints), reproduced verbatim and extended with feature-specific constraints.

### Architecture & file ownership (inherited)

- The Execute -> Reflect -> Act pipeline is strict and schema-enforced. New inputs/outputs flow through the three YAML schemas in `plugin/ralph-playwright/schemas/`: `journey-trace.schema.yaml`, `signal-report.schema.yaml`, `action-log.schema.yaml`. Schema additions must be additive (new optional fields).
- Hooks in `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` validate journey-trace, signal-report, and action-log YAMLs at Read and Write boundaries. Any schema change that tightens validation must update the hook in the same PR.
- Execute runs as a sub-agent (`explorer-agent` or `story-runner-agent`) with `model: sonnet`. Keep Sonnet for Execute. Reflect runs in the calling model's context — that is the sole tier where Opus 4.7 routing applies.
- Screenshots (PNG) and accessibility snapshots (`.md`) are captured at EVERY step. No feature may opt out of either capture.
- The "NEVER use CSS selectors" rule in `plugin/ralph-playwright/agents/story-runner-agent.md:47` stays in force for accessible elements. Vision-fallback targeting is additive — it only activates when the accessibility snapshot yields no ref.

### Model routing discipline (inherited)

- Preferred-model hints are expressed in SKILL.md frontmatter with env var overrides (naming: `RALPH_PLAYWRIGHT_<PHASE>_MODEL`). Escalation rules must be declarative in SKILL.md, not buried in prompt logic.
- Every reflect step records which model ran it, either in a signal-report sidecar or as a journey-trace annotation.

### Cost & token envelope (inherited)

- Default capture resolution stays at the playwright-cli current viewport default. Higher-resolution modes (up to 2576px / 3.75MP) are opt-in via `--high-res` or escalation rules, never defaults.
- Opus 4.7 is materially more expensive per screenshot than Sonnet at 1568px. Default routing must keep Sonnet on happy paths; Opus 4.7 is reserved for reflect, with escalation on fail or prior-signal steps.

### Artifact paths (inherited)

- Session data: `.playwright-cli/<session>/` (journey-trace.yaml, signal-report.yaml, action-log.yaml, screenshots, snapshots).
- Promoted evidence: `thoughts/local/assets/<session>/` for both original and annotated screenshots.

### Research anchoring (inherited)

Every feature plan must cite the parent research doc `thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md` in its Prior Work section and reference the specific §Part 3 Item that motivates it.

This feature implements §Part 3 Item 8 (Vision-fallback element targeting).

### Feature-specific constraints

These are additional constraints specific to vision-fallback targeting. They extend the inherited set without contradiction.

1. **A11y-first invariant**: For every targeted interaction, the orchestrator MUST try the a11y-ref path first. Vision fallback activates ONLY when the trigger helper returns `true`. A bug that lets vision fire against an a11y-reachable element is a correctness violation, not a performance issue. Enforce via unit tests in Phase 4.
2. **Single vision attempt per action**: One vision-locate + one click-at-coordinate per a11y failure. No retry loop. If the vision click does not produce the expected post-click state, the step records `outcome: fail` and the journey halts per existing story-runner semantics. This bounds latency and token cost.
3. **Opus 4.7 pinned on vision-locate**: The vision-locator prompt is an `opus` step (pinned via env var `RALPH_PLAYWRIGHT_VISION_LOCATOR_MODEL`, default `opus`). Sonnet fallback is allowed for dev-only debugging but never the shipped default. This follows Feature A (GH-785) model-routing conventions; declare the model choice in the same place that Feature A declares reflect routing.
4. **Coordinate space is the captured screenshot, 1:1**: Coordinates returned by Opus 4.7 MUST be interpreted as pixel offsets in the exact screenshot PNG passed to the prompt. Any post-capture scaling (high-DPI, CSS zoom) MUST be reconciled before dispatching the click. If playwright-cli click takes viewport-pixel (CSS) coords and the screenshot is at device-pixel resolution, insert a DPR-divide shim in Phase 3. Validate with a high-DPI fixture in Phase 6.
5. **Telemetry is required, not optional**: Every vision-fallback invocation — success OR failure — emits a journey-trace annotation per Phase 5's schema. Trace readers that pre-date this feature must still parse the trace (additive fields only). A run with vision disabled produces traces with `targeting_method: a11y_ref` on every step, which is the pre-existing default.
6. **Fixture pages serve locally, no live network**: Phase 6 fixtures live under `plugin/ralph-playwright/fixtures/vision-fallback/` (new directory, per epic shared-fixtures guidance). Tests serve them via a local static server (e.g., `python3 -m http.server` spawned by the test harness) — no live URLs. This keeps CI hermetic.
7. **No selector-leak**: The orchestrator MUST NOT invent CSS selectors as a side-path between a11y and vision. Only two targeting methods exist: `a11y_ref` and `vision_fallback`. Any future third method requires an epic-level decision.

## Current State Analysis

The ralph-playwright plugin (v0.2.0) exposes browser automation through `playwright-cli`, with two execute agents that both rely exclusively on accessibility-ref element targeting:

- `plugin/ralph-playwright/agents/story-runner-agent.md:47` — "NEVER use CSS selectors. Use element refs (e.g., `e8`, `e21`)."
- `plugin/ralph-playwright/agents/explorer-agent.md:44-64` — snapshot-then-screenshot, decide next action from interactive elements "visible in the snapshot".
- `plugin/ralph-playwright/skills/browser/SKILL.md:55` — Interaction commands today: `click <ref>`, `dblclick <ref>`, `fill <ref> <value>`, `type <text>`, `hover <ref>`, `select <ref> <values>`, `check <ref>`, `uncheck <ref>`. None of these accept pixel coordinates.

The journey-trace schema (`plugin/ralph-playwright/schemas/journey-trace.schema.yaml:33-68`) requires step fields `index, action, target, outcome, screenshot, snapshot, console, duration_ms` — no field for "how was the target resolved". The hook validator at `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh:86-91` enforces only the `outcome` enum on journey-trace; it does not enforce an action enum, so new action verbs (e.g., `click_vision`) could be added without a validator change, but telemetry fields must be declared in the schema.

No fixtures or integration-test directory exists today in `plugin/ralph-playwright/` — this feature is the first to require static fixture pages.

**Failure modes in the wild (research §Part 2, last paragraph)**:

- Canvas-rendered UIs (e.g., charts, signature pads) have no a11y tree for their interactive regions.
- Map widgets (OpenLayers, Google Maps canvas tiles) place pins inside a single canvas element; the a11y snapshot sees one `canvas` ref at most.
- Sites with poor a11y hygiene (div-as-button, missing roles/labels) yield snapshots where the intended click target is either absent or indistinguishable from decor.

All three currently hard-fail the execute phase: the model cannot find a ref, cannot legitimately use a CSS selector, and has nowhere to go.

**Opus 4.7 unlocks the fix (research §Part 1)**: 1:1 pixel-to-coordinate mapping at 2576px / 3.75MP ceiling, with `+21.8pt` on Visual Navigation (no tools) and `+5.3pt` on OSWorld-Verified. That is the capability bet — the model can look at a screenshot, be told "the blue submit button" or "the pin for San Francisco", and return pixel coordinates accurate enough to click.

## Desired End State

After all six phases land:

1. `plugin/ralph-playwright/agents/story-runner-agent.md` documents the fallback sequence: try a11y-ref -> if no-ref-trigger fires, call vision-locator -> call click-by-coordinate -> record telemetry.
2. `plugin/ralph-playwright/agents/explorer-agent.md` documents the same sequence for freeform navigation decisions.
3. Helper library (new) exposes three composable primitives:
   - `should_use_vision_fallback(snapshot_md, target_description) -> bool` (Phase 1)
   - `resolve_target_coordinates(screenshot_path, description) -> {x, y, confidence, rationale} | None` (Phase 2)
   - `click_at_coordinate(session, x, y) -> {outcome, post_screenshot}` (Phase 3)
4. `plugin/ralph-playwright/schemas/journey-trace.schema.yaml` gains additive optional fields: `targeting_method` (enum) and nested `vision_fallback` block per step (Phase 5).
5. `plugin/ralph-playwright/fixtures/vision-fallback/` contains three HTML fixture pages plus a README on how to serve them (Phase 6).
6. Integration tests exercise the full pipeline on all three fixtures and prove the a11y-good negative case (no fallback fires) (Phase 6).

### Verification

- [x] Unit test: trigger returns `true` for canvas, map, empty-snapshot, and absent-ref cases (Phase 1).
- [x] Unit test: vision-locator parses valid JSON from a sample response and rejects out-of-bounds coords (Phase 2).
- [x] Unit test: click-at-coordinate invokes the CLI with correctly ordered/escaped args and raises on out-of-bounds (Phase 3).
- [x] Unit test: orchestrator routes a11y-success, a11y-fail+vision-success, a11y-fail+vision-fail through distinct code paths (Phase 4).
- [x] CSS-selector guardrail: orchestrator never emits a CSS selector; unit test asserts only `click <ref>` or coordinate dispatch is ever invoked (Phase 4).
- [x] Journey-trace YAML including `targeting_method: vision_fallback` passes the existing hook validator (Phase 5).
- [x] `jq '.steps[] | select(.targeting_method == "vision_fallback")' trace.yaml` yields a non-empty set on the canvas fixture run (Phase 5).
- [x] Integration: canvas-demo, map-demo, bad-a11y fixtures all pass click-lands-on-target assertion (Phase 6).
- [x] Integration: a11y-good fixture completes with zero vision-fallback invocations in its trace (Phase 6).

## What We're NOT Doing

Out of scope for this feature:

- **Adding CSS-selector support anywhere.** The "NEVER use CSS selectors" rule stands in all cases where a11y is available. Vision is the ONLY additional targeting method.
- **Vision-first exploration mode.** That is Feature K (GH-795, pre-split). This plan is strictly fallback; a11y is tried first, always.
- **Retry logic for vision failures.** One vision attempt per action. If it misses, the step fails per existing story-runner semantics. A future feature could add retries; this one does not.
- **Multi-click / drag / hover targets via vision.** Only `click` by coordinate is added. `dblclick`, `hover`, `drag`, `fill`, `select`, etc. stay a11y-only. Form fills on canvas or bad-a11y surfaces remain out of scope. (If a real use case surfaces, spin a new atomic.)
- **Typing or scrolling via pixel coordinates.** Scroll happens at page/viewport level today; text input needs a focused element. Neither is addressed.
- **Opus 4.7 routing defaults for other phases.** Model routing for reflect (Feature A, GH-785) is independent. This plan pins Opus 4.7 for the vision-locator invocation only.
- **Performance benchmarking of fallback latency.** Phase 6 proves correctness; latency tuning is deferred.
- **Visual-diff baseline for fallback correctness.** Phase 6 uses post-click DOM/state assertions rather than visual diffs. Feature G (GH-791) owns visual-diff tooling.
- **Multi-monitor / multi-viewport coordinate handling.** Single viewport per session. No per-device orchestration.
- **Dashboards / alerting on fallback frequency.** Phase 5 captures the data. Aggregation and alerting are out of scope (epic-level shared constraint).

## Implementation Approach

The six phases compose in a single causal chain, but phases 1-3 are independent (three separable primitives) so they can be implemented in parallel. Phase 4 requires all three; phases 5 and 6 build linearly on 4.

```
Phase 1 (trigger) ──┐
Phase 2 (locator) ──┼──> Phase 4 (orchestrator) ──> Phase 5 (telemetry) ──> Phase 6 (fixtures + integration)
Phase 3 (clicker) ──┘
```

### Cross-atomic contract (what each phase produces for the next)

**The critical planning decision**: since phases 1-3 build in parallel but are all consumed by Phase 4, their interfaces MUST be agreed up-front. Here are the concrete contracts.

**Phase 1 produces** a pure function:

```python
# or shell, or JS — language TBD in Phase 1; see below
def should_use_vision_fallback(snapshot_md: str, target_description: str) -> bool:
    """
    Returns True iff the a11y snapshot cannot yield a ref for the target.
    Returns True for: canvas-only regions, map containers, empty/sparse snapshots,
    or absence of any ref matching target_description by label/role/text.
    Returns False whenever any plausible ref match exists.
    """
```

**Language choice**: The ralph-playwright plugin is skills-and-agents only — there is no build system, no compiled code, no test matrix. Phase 1's "helper" is a section of prose and examples inside `plugin/ralph-playwright/agents/story-runner-agent.md` and `agents/explorer-agent.md`, plus a shared reference block (new file) in `plugin/ralph-playwright/skills/browser/references/vision-fallback-heuristic.md`. "Unit tests" are expressible as worked examples — "given this snapshot + description, the trigger returns X" — in the reference doc and executed by a test harness in Phase 6. This matches how other ralph-playwright skills document behavior (see `skills/ux-audit/references/ux-trends-2026.md`). No Python/JS runtime is introduced.

If a real implementation language is needed later (when the orchestrator becomes a shell or JS helper that is actually invoked), it would be a shell function or a small Node helper following the ralph-knowledge plugin pattern. For now, the prompt-driven agents are the runtime.

**Phase 2 produces** a prompt template + a prose `resolve_target_coordinates` contract:

- Prompt file: `plugin/ralph-playwright/skills/browser/references/vision-locator-prompt.md` (new).
- Contract: given a screenshot path and a target description, the agent invokes `Read` on the PNG, runs the prompt, parses the JSON return, and returns `{x, y, confidence, rationale}` or `null`.
- Output JSON schema:
  ```json
  {
    "x": 340,
    "y": 214,
    "confidence": 0.92,
    "rationale": "Center of the blue 'Submit' button near the form bottom"
  }
  ```
  or, for not-found:
  ```json
  {
    "x": null,
    "y": null,
    "confidence": 0.0,
    "rationale": "Target not visible in screenshot"
  }
  ```
- Bounds validation: caller asserts `0 <= x < image_width` and `0 <= y < image_height`. Out-of-bounds => treat as not-found.
- Opus 4.7 pin: prompt file frontmatter declares `preferred-model: opus` and `model-env-var: RALPH_PLAYWRIGHT_VISION_LOCATOR_MODEL` per Feature A conventions.

**Phase 3 produces** a click-by-coordinate invocation convention:

- CLI invocation (proposed): `playwright-cli -s=<session> click --x <X> --y <Y>`.
- **Open question**: the `playwright-cli` (`@playwright/cli`) command surface as documented in `skills/browser/SKILL.md:55` does not currently expose `click --x --y`. Phase 3 MUST verify whether a recent version of `@playwright/cli` supports coordinate clicks. If it does not, Phase 3 instead emits the click via `playwright-cli eval "await page.mouse.click(X, Y)"` as a documented shim. The plan ships with the shim fallback and treats upstream CLI support as a nice-to-have. Phase 3's first task is precisely this discovery.
- Return value: `{outcome: pass|fail, post_screenshot: path}`. Post-click screenshot is captured by the existing step-loop in story-runner / explorer; Phase 3 just dispatches the click.

**Phase 4 consumes all three and produces** updated agent docs + a fallback-sequence section added to `story-runner-agent.md` (new section after line 57) and `explorer-agent.md` (new section after line 85). No code is executed directly by Phase 4 — the agents are prose runtimes — but the written flow must be step-complete and citable by unit tests as worked examples.

**Phase 5 produces** additive schema fields:

- `journey-trace.schema.yaml` step object gains:
  ```yaml
  targeting_method:
    type: string
    enum: [a11y_ref, vision_fallback]
    description: "Which targeting method resolved this step's target. Default a11y_ref."
  vision_fallback:
    type: object
    description: "Populated only when targeting_method == vision_fallback."
    properties:
      target_description:
        type: string
      resolved_x:
        type: ["integer", "null"]
      resolved_y:
        type: ["integer", "null"]
      confidence:
        type: number
        minimum: 0.0
        maximum: 1.0
      rationale:
        type: string
      trigger_reason:
        type: string
        enum: [no_matching_ref, canvas_region, map_region, empty_snapshot]
      click_outcome:
        type: string
        enum: [pass, fail, out_of_bounds]
  ```
- Hook validator `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` is updated ONLY if the enum check is tightened (it isn't today for action types, so no change is strictly required — but Phase 5 adds an optional `targeting_method` enum check for safety).
- Backward compatibility: all fields are optional. Pre-existing traces without `targeting_method` read as `a11y_ref` by convention in readers.

**Phase 6 produces** three fixture pages + one negative-control page + an integration harness:

- `plugin/ralph-playwright/fixtures/vision-fallback/canvas-demo.html`
- `plugin/ralph-playwright/fixtures/vision-fallback/map-demo.html`
- `plugin/ralph-playwright/fixtures/vision-fallback/bad-a11y.html`
- `plugin/ralph-playwright/fixtures/vision-fallback/a11y-good-control.html` (negative case: confirm vision does NOT fire)
- `plugin/ralph-playwright/fixtures/vision-fallback/README.md` — how to serve + how tests consume
- `plugin/ralph-playwright/fixtures/vision-fallback/run-integration.sh` — orchestrator runner that: (a) starts a local HTTP server, (b) invokes story-runner on a fixture-targeted story, (c) asserts trace has `targeting_method: vision_fallback` on canvas/map/bad-a11y but not on a11y-good.

### Rework guard

If Phase 3's CLI discovery reveals that `--x --y` is not supported AND the `eval` shim is not workable (e.g., `page.mouse.click` is not exposed on the CLI's JS runtime), Phase 3 stops and escalates. Phases 4-6 are blocked until a click mechanism exists. The plan does not have a fallback-to-the-fallback.

**Phase dependency annotations**: each phase below declares its `depends_on` explicitly.

---

## Phase 1: Atomic Issue GH-797 — detect no-ref-available trigger for vision fallback

- **depends_on**: null

### Overview

Author the heuristic doc and worked examples that let an agent decide when to abandon a11y-ref lookup and escalate to vision. The output is a new reference file plus an agent-doc section; behaviorally it defines what "no ref available" means and enumerates the trigger conditions with positive and negative examples.

### Tasks

#### Task 1.1: Create trigger reference doc

- **files**: `plugin/ralph-playwright/skills/browser/references/vision-fallback-trigger.md` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at the specified path
  - [ ] Contains three clearly-labeled sections: "Trigger Conditions", "Non-Triggers (a11y wins)", "Worked Examples"
  - [ ] "Trigger Conditions" enumerates exactly four triggers: no matching ref, canvas region, map region, empty/sparse snapshot
  - [ ] Each trigger has a one-line definition + a concrete example snapshot fragment + expected return value (`true`)
  - [ ] "Non-Triggers" section has at least three negative examples (standard button, labeled form field, anchor link) — each shows a snapshot fragment and expected return value (`false`)
  - [ ] "Worked Examples" has at least six fully-worked cases (4 triggers + 2 non-triggers minimum) in the format: `Input snapshot: X | Description: "Y" | should_use_vision_fallback: <bool>`
  - [ ] A "Rationale" paragraph explains why each trigger category exists (canvas => no DOM, map => canvas + tiles, bad a11y => divs-as-buttons, etc.)

#### Task 1.2: Update story-runner-agent with trigger reference

- **files**: `plugin/ralph-playwright/agents/story-runner-agent.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] A new paragraph after the existing "Find the target element" step (currently line 47) references `skills/browser/references/vision-fallback-trigger.md` for the trigger heuristic
  - [ ] Paragraph explicitly preserves the "NEVER use CSS selectors" rule for a11y-reachable elements
  - [ ] States that the trigger check precedes any vision-locator invocation
  - [ ] Leaves the existing "Execute the action" step intact — do not yet wire the fallback sequence (that is Phase 4)

#### Task 1.3: Update explorer-agent with trigger reference

- **files**: `plugin/ralph-playwright/agents/explorer-agent.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] A new paragraph after "Decide next action" (line 59-62) references `skills/browser/references/vision-fallback-trigger.md`
  - [ ] Paragraph uses the same wording as story-runner-agent's change to avoid drift

#### Task 1.4: Document trigger check in browser SKILL.md

- **files**: `plugin/ralph-playwright/skills/browser/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] The Interaction table (line 55) gets a new row or adjacent note pointing to `references/vision-fallback-trigger.md`
  - [ ] A new section "Vision-Fallback Trigger" is added after "Session Management" (after line 72) summarizing: when a11y lookup fails, consult the reference doc to decide whether to escalate

### Phase Success Criteria

#### Automated Verification:

- [x] `plugin/ralph-playwright/skills/browser/references/vision-fallback-trigger.md` exists and passes a markdown-lint smoke check (no automated linter runs in this plugin today — verification is "file exists and has the required sections")
- [x] `grep -c 'vision-fallback-trigger.md' plugin/ralph-playwright/agents/story-runner-agent.md plugin/ralph-playwright/agents/explorer-agent.md plugin/ralph-playwright/skills/browser/SKILL.md` returns 3

#### Manual Verification:

- [ ] An LLM agent reading only `plugin/ralph-playwright/skills/browser/references/vision-fallback-trigger.md` + a novel snapshot fragment can classify trigger vs non-trigger correctly on the six worked examples
- [ ] Canvas-only, map-only, and empty-snapshot cases all classify as trigger
- [ ] Standard button, labeled input, and anchor cases all classify as non-trigger

**Creates for next phases**:

- A concrete, testable definition of "no-ref-available" that Phase 4 (orchestrator) can invoke as a narrative contract.
- Worked examples that Phase 6 can reuse as fixture validation cases.

---

## Phase 2: Atomic Issue GH-798 — Opus 4.7 vision-locator prompt for pixel-coordinate resolution

- **depends_on**: null

### Overview

Author the Opus 4.7 prompt template that takes a screenshot + a natural-language target description and returns pixel coordinates as structured JSON. This is the vision-reasoning core of the fallback. The output is a prompt file, a JSON schema for the response, and worked examples.

### Tasks

#### Task 2.1: Create vision-locator prompt template

- **files**: `plugin/ralph-playwright/skills/browser/references/vision-locator-prompt.md` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] File exists and contains frontmatter with `preferred-model: opus` and `model-env-var: RALPH_PLAYWRIGHT_VISION_LOCATOR_MODEL`
  - [ ] Prompt body has three clear sections: "Inputs" (screenshot + target_description), "Task" (locate target, return center pixel), "Output Schema" (strict JSON)
  - [ ] Prompt explicitly instructs: "return JSON only, no prose"
  - [ ] Prompt specifies the JSON schema: `{x: integer|null, y: integer|null, confidence: number 0..1, rationale: string}`
  - [ ] Prompt specifies coordinate space: "pixel offsets from top-left of the image, 1:1 with actual pixels"
  - [ ] Prompt handles "not visible / not found" by returning `{x: null, y: null, confidence: 0.0, rationale: "..."}`
  - [ ] Prompt instructs "center of target" semantics (not edge, not bounding-box corner)
  - [ ] Includes a "Guardrails" section: no clicking decorative elements, prefer primary CTA interpretation, decline ambiguous targets

#### Task 2.2: Document response parser contract

- **files**: `plugin/ralph-playwright/skills/browser/references/vision-locator-prompt.md` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] A new section "Response Parsing" is appended describing how a caller validates the returned JSON
  - [ ] Validation rules listed explicitly: (1) JSON parses; (2) required keys present; (3) if x/y not null, both are integers and both in `[0, image_width)` / `[0, image_height)`; (4) confidence is a number in `[0.0, 1.0]`; (5) rationale is non-empty
  - [ ] Out-of-bounds coords are treated as not-found (return `None` to caller)
  - [ ] Unparseable JSON is treated as not-found
  - [ ] A "Worked Examples" section lists at least four inputs and their validated outputs: 2 happy paths (canvas button + map pin), 1 not-visible target, 1 out-of-bounds response (model error case)

#### Task 2.3: Add helper invocation documentation to browser SKILL.md

- **files**: `plugin/ralph-playwright/skills/browser/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] A new section "Vision Locator" is added after the "Vision-Fallback Trigger" section from Phase 1
  - [ ] Section documents: input (screenshot path + description), output (parsed JSON or `None`), and pins the model to Opus 4.7
  - [ ] Cross-reference to `references/vision-locator-prompt.md`

#### Task 2.4: Smoke-test prompt on a fixture screenshot

- **files**: `plugin/ralph-playwright/skills/browser/references/vision-locator-prompt.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.2]
- **acceptance**:
  - [ ] Append a "Smoke Test Results" subsection recording one manual Opus 4.7 invocation against a simple test PNG (e.g., a published Anthropic docs screenshot or a hand-drawn canvas mockup)
  - [ ] Recorded output must parse as valid JSON per the schema
  - [ ] If smoke fails (model returns prose, wrong schema, etc.), record the failure mode and propose a prompt adjustment before closing Phase 2
  - [ ] The actual fixture HTML pages are Phase 6's deliverable; Phase 2 uses a one-off PNG for this smoke test (any reasonable image)

### Phase Success Criteria

#### Automated Verification:

- [x] `plugin/ralph-playwright/skills/browser/references/vision-locator-prompt.md` exists with the three mandatory sections (Inputs, Task, Output Schema) and the Response Parsing + Worked Examples sections
- [x] `grep -c 'vision-locator-prompt.md' plugin/ralph-playwright/skills/browser/SKILL.md` returns at least 1

#### Manual Verification:

- [ ] Smoke test invocation produces valid JSON matching the schema for a real screenshot
- [ ] A not-visible target returns `{x: null, y: null}` rather than a hallucinated coord
- [ ] Out-of-bounds model responses are handled by the parser (clamp-to-not-found)

**Creates for next phases**:

- A prompt template that Phase 4 orchestrator invokes when the Phase 1 trigger fires.
- A response schema that Phase 5 telemetry captures verbatim into `vision_fallback.resolved_x`, `.resolved_y`, `.confidence`, `.rationale`.

---

## Phase 3: Atomic Issue GH-799 — click-by-coordinate action via playwright-cli

- **depends_on**: null

### Overview

Bridge resolved pixel coordinates to an actual browser click. First verify whether `playwright-cli click --x --y` is supported upstream. If yes, document it. If no, document the `eval "await page.mouse.click(X, Y)"` shim. Either way, the output is a documented invocation convention plus bounds-validation rules.

### Tasks

#### Task 3.1: Verify upstream playwright-cli coordinate-click support

- **files**: `plugin/ralph-playwright/skills/browser/references/click-by-coordinate.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at the specified path
  - [ ] Documents the result of running `playwright-cli click --help` and `npm view @playwright/cli` at plan-execution time
  - [ ] Records one of two outcomes: (a) native `--x --y` is supported — documents exact invocation and version; (b) not supported — documents the `eval "await page.mouse.click(X, Y)"` shim as the canonical invocation
  - [ ] If shim: note that `page.mouse.click` uses CSS-pixel coordinates, and document any DPR reconciliation needed (see Task 3.3)
  - [ ] File has a "Recommended Invocation" section that is a copy-paste-ready shell snippet

#### Task 3.2: Document bounds validation

- **files**: `plugin/ralph-playwright/skills/browser/references/click-by-coordinate.md` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] A new section "Bounds Validation" documents that the caller MUST assert `0 <= x < viewport_width` and `0 <= y < viewport_height` before dispatching the click
  - [ ] Failure mode: out-of-bounds raises a clear error (example error text included) — no silent click attempt
  - [ ] Viewport dims are obtained via `playwright-cli eval "JSON.stringify({w: window.innerWidth, h: window.innerHeight})"`; invocation documented
  - [ ] Worked examples: (a) in-bounds click succeeds; (b) out-of-bounds click raises; (c) zero-coord edge case (`x=0, y=0`) is allowed

#### Task 3.3: Document DPR / CSS-pixel reconciliation

- **files**: `plugin/ralph-playwright/skills/browser/references/click-by-coordinate.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.2]
- **acceptance**:
  - [ ] A new section "Coordinate Space" explains the potential DPR mismatch: screenshot PNG may be at device-pixel resolution, `page.mouse.click` takes CSS pixels
  - [ ] Documents how to detect the screenshot resolution (read PNG metadata via Read tool or shell-out) and how to compute DPR (via `playwright-cli eval "window.devicePixelRatio"`)
  - [ ] Documents the reconciliation formula: `css_x = round(device_x / dpr)`, `css_y = round(device_y / dpr)`
  - [ ] Recommends default-skip on DPR=1 viewports (most desktop test runs)
  - [ ] Notes that this is validated in Phase 6 via a high-DPI fixture (explicit `devicePixelRatio=2` setting on the test viewport)

#### Task 3.4: Add click-by-coordinate to browser SKILL.md

- **files**: `plugin/ralph-playwright/skills/browser/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.3]
- **acceptance**:
  - [ ] The Interaction row in the Available Commands table (line 55) gains a note: "coordinate clicks via `eval page.mouse.click` — see `references/click-by-coordinate.md`"
  - [ ] A new subsection "Click by Coordinate" after Vision Locator (Phase 2) links to `references/click-by-coordinate.md`

### Phase Success Criteria

#### Automated Verification:

- [x] `plugin/ralph-playwright/skills/browser/references/click-by-coordinate.md` exists with Recommended Invocation, Bounds Validation, and Coordinate Space sections
- [x] `grep -c 'click-by-coordinate.md' plugin/ralph-playwright/skills/browser/SKILL.md` returns at least 1

#### Manual Verification:

- [ ] Invocation snippet copy-pasted into a running playwright-cli session on a fixture HTML page produces an observable click (verified by DOM event listener or post-click screenshot diff)
- [ ] Out-of-bounds invocation raises a clear error per the documented failure mode
- [ ] DPR reconciliation formula produces sensible CSS-pixel coords on a high-DPI fixture (cross-verified in Phase 6)

**Creates for next phases**:

- The concrete click-dispatch incantation that Phase 4 orchestrator emits after Phase 2 returns coords.
- Bounds + DPR rules that Phase 6 exercises.

---

## Phase 4: Atomic Issue GH-800 — fallback sequence orchestration (a11y-first, vision-fallback)

- **depends_on**: [phase-1, phase-2, phase-3]

### Overview

Wire the three primitives into a single a11y-first, vision-fallback orchestration sequence. Update both story-runner-agent and explorer-agent with the new action loop. This is the feature's integration point — a11y-first MUST hold, CSS selectors MUST NOT leak, one vision attempt per action is the budget. Documentation only; no new code.

### Tasks

#### Task 4.1: Draft orchestrator sequence in a shared reference

- **files**: `plugin/ralph-playwright/skills/browser/references/vision-fallback-sequence.md` (create)
- **tdd**: false
- **complexity**: high
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at the specified path
  - [ ] Contains a "Sequence" section with a numbered flow: (1) snapshot + screenshot as today; (2) ref lookup; (3) if ref found, execute `click <ref>` per existing path, DONE; (4) if no ref, invoke trigger (Phase 1) — if trigger=false, step fails per existing semantics, DONE; (5) if trigger=true, invoke vision-locator (Phase 2); (6) if locator returns null, step fails; (7) validate bounds (Phase 3); (8) dispatch click-at-coordinate (Phase 3); (9) capture post-click screenshot + snapshot per existing step-loop; (10) record `targeting_method: vision_fallback` + `vision_fallback` metadata per Phase 5
  - [ ] Contains a "Guardrails" section enumerating: a11y-first invariant, no CSS selectors ever, one vision attempt per action, Opus 4.7 pinned for locator
  - [ ] Contains a "Failure Modes" section enumerating each step's failure outcome and how it maps to `outcome: fail` + `error: <message>` in the trace
  - [ ] Contains a "Worked Examples" section with at least three scenarios: a11y-success (no fallback), a11y-fail + vision-success, a11y-fail + vision-fail

#### Task 4.2: Update story-runner-agent with fallback sequence

- **files**: `plugin/ralph-playwright/agents/story-runner-agent.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [4.1]
- **acceptance**:
  - [ ] The "Execute Each Step" section (currently lines 38-67) gains a new sub-flow after "Find the target element" step (line 47)
  - [ ] New sub-flow references `skills/browser/references/vision-fallback-sequence.md`
  - [ ] The existing "Execute the action" bullet list (lines 50-54) is amended to note: "If no ref was found AND the trigger fires, invoke the fallback sequence instead of failing"
  - [ ] A new bullet explicitly: "Record `targeting_method: a11y_ref` for this step (default) OR `targeting_method: vision_fallback` with the nested vision_fallback metadata when the fallback fired"
  - [ ] The "NEVER use CSS selectors" rule at line 47 is updated to: "NEVER use CSS selectors. Use element refs (e.g., `e8`, `e21`) OR fall back to vision-locator per `references/vision-fallback-sequence.md`."

#### Task 4.3: Update explorer-agent with fallback sequence

- **files**: `plugin/ralph-playwright/agents/explorer-agent.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [4.1]
- **acceptance**:
  - [ ] The "Exploration Loop" section (lines 40-70) gains a note after the "Take the action" bullet (line 64)
  - [ ] Note references `skills/browser/references/vision-fallback-sequence.md`
  - [ ] The "Recording" example YAML (lines 73-85) gains a commented-out example of a `targeting_method: vision_fallback` step so authors see the telemetry shape
  - [ ] Wording mirrors story-runner-agent changes for consistency

#### Task 4.4: Worked-example unit tests for orchestrator

- **files**: `plugin/ralph-playwright/skills/browser/references/vision-fallback-sequence.md` (modify)
- **tdd**: true
- **complexity**: high
- **depends_on**: [4.2, 4.3]
- **acceptance**:
  - [ ] Append an "Orchestrator Test Cases" section with at least six fully-worked cases, each with: input (snapshot + target_description + screenshot state), expected dispatches (ref-lookup, trigger, locator, click calls), expected trace output (`targeting_method` + metadata)
  - [ ] Case coverage: (1) a11y-success (no fallback invoked); (2) a11y-fail + trigger-false (step fails, no vision); (3) a11y-fail + trigger-true + locator-success + click-success (full vision path); (4) a11y-fail + trigger-true + locator-returns-null (step fails); (5) a11y-fail + trigger-true + locator-success + out-of-bounds (step fails); (6) a11y-fail + trigger-true + locator-success + click-success but confidence < 0.5 (step still succeeds but telemetry flags low confidence)
  - [ ] Each case is the basis for a Phase 6 integration assertion

### Phase Success Criteria

#### Automated Verification:

- [x] `plugin/ralph-playwright/skills/browser/references/vision-fallback-sequence.md` exists with Sequence, Guardrails, Failure Modes, Worked Examples, and Orchestrator Test Cases sections
- [x] `grep -c 'vision-fallback-sequence.md' plugin/ralph-playwright/agents/story-runner-agent.md plugin/ralph-playwright/agents/explorer-agent.md` returns 2
- [x] `grep -c 'targeting_method' plugin/ralph-playwright/agents/story-runner-agent.md` returns at least 1

#### Manual Verification:

- [ ] An LLM agent with only the updated story-runner-agent + the three reference docs can execute each of the six test cases in Task 4.4 and arrive at the documented expected behavior
- [ ] No path through the orchestrator invokes a CSS selector
- [ ] The a11y-first invariant holds: test case 1 (a11y-success) never invokes trigger or locator

**Creates for next phases**:

- A complete, citable sequence that Phase 5 telemetry instruments and Phase 6 fixtures validate end-to-end.

---

## Phase 5: Atomic Issue GH-801 — journey-trace telemetry for vision-fallback usage

- **depends_on**: [phase-4]

### Overview

Extend the journey-trace schema with `targeting_method` and the nested `vision_fallback` metadata block. Update hook validator. Document the new fields and provide worked examples. Make sure existing traces remain parseable (fully additive change).

### Tasks

#### Task 5.1: Extend journey-trace schema

- **files**: `plugin/ralph-playwright/schemas/journey-trace.schema.yaml` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] In the `steps.items.properties` block (currently lines 39-67), add two new optional fields: `targeting_method` (string, enum `[a11y_ref, vision_fallback]`) and `vision_fallback` (object, described below)
  - [ ] `vision_fallback` object contains all properties specified in the plan's cross-atomic contract: `target_description`, `resolved_x`, `resolved_y`, `confidence`, `rationale`, `trigger_reason`, `click_outcome`
  - [ ] `trigger_reason` enum values: `[no_matching_ref, canvas_region, map_region, empty_snapshot]`
  - [ ] `click_outcome` enum values: `[pass, fail, out_of_bounds]`
  - [ ] Neither new field appears in the `required` list — both are optional, backward-compatible
  - [ ] Schema comments explain: "`targeting_method` defaults to `a11y_ref` when absent. `vision_fallback` is populated only when `targeting_method == vision_fallback`."

#### Task 5.2: Update hook validator for enum check

- **files**: `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [5.1]
- **acceptance**:
  - [ ] The `journey-trace.schema.yaml` branch (currently lines 85-91) is extended with an optional enum check on `targeting_method`: reject values outside `[a11y_ref, vision_fallback]` when the field is present
  - [ ] Absence of `targeting_method` is allowed (backward compatibility)
  - [ ] New check: when `targeting_method == vision_fallback`, the step MUST have a `vision_fallback` object with `target_description`, `trigger_reason`, and `click_outcome` populated (warns, not errors, if missing — to avoid breaking traces written during transition)
  - [ ] Warn-level output uses the existing stderr echo pattern; error-level uses `exit 1`
  - [ ] Test cases documented as comments: (a) old trace with no `targeting_method` passes; (b) trace with `targeting_method: a11y_ref` passes; (c) trace with `targeting_method: vision_fallback` + complete metadata passes; (d) trace with `targeting_method: bogus` fails

#### Task 5.3: Emit telemetry from orchestrator agents

- **files**: `plugin/ralph-playwright/agents/story-runner-agent.md` (modify), `plugin/ralph-playwright/agents/explorer-agent.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [5.1]
- **acceptance**:
  - [ ] Both agents' "Output" / "Recording" sections are amended with a new required step field: `targeting_method`. For a11y path, emit `a11y_ref`. For vision path, emit `vision_fallback` + populate the `vision_fallback` sub-object per schema
  - [ ] Example YAML in each agent doc shows a vision-fallback step with all metadata populated (mirrors the schema's fields)
  - [ ] Wording references `schemas/journey-trace.schema.yaml` for authoritative field definitions
  - [ ] For confidence < 0.5 cases (Task 4.4 case 6), note that `click_outcome: pass` is still emitted but the confidence value is preserved verbatim for downstream audits

#### Task 5.4: Document a trace-query convention

- **files**: `plugin/ralph-playwright/skills/browser/references/vision-fallback-sequence.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [5.3]
- **acceptance**:
  - [ ] Append a "Telemetry Audit Queries" section with copy-paste-ready `yq` / `jq` snippets:
    - Count vision-fallback invocations per trace: `yq '[.steps[] | select(.targeting_method == "vision_fallback")] | length' trace.yaml`
    - List fallback trigger reasons: `yq '.steps[] | select(.targeting_method == "vision_fallback") | .vision_fallback.trigger_reason' trace.yaml`
    - Filter low-confidence clicks: `yq '.steps[] | select(.vision_fallback.confidence < 0.5)' trace.yaml`
  - [ ] Each query has a one-line comment explaining use case
  - [ ] Cross-reference these queries in Phase 6 integration assertions

### Phase Success Criteria

#### Automated Verification:

- [x] A handwritten journey-trace YAML with `targeting_method: vision_fallback` + complete `vision_fallback` block passes `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` (simulated via stdin JSON payload per hook protocol)
- [x] A handwritten journey-trace YAML with `targeting_method: bogus` fails the same hook
- [x] A pre-existing journey-trace YAML from an earlier run (without `targeting_method`) still passes the hook unchanged
- [x] `yq` snippets in the reference doc produce expected outputs on a crafted test trace

#### Manual Verification:

- [ ] Schema change is reviewed and confirmed additive (no field removed, no existing field made required)
- [ ] Agent docs show the new telemetry shape with a complete example

**Creates for next phases**:

- A validated schema + hook + agent-doc trio that Phase 6 exercises on real fixture runs. Phase 6 integration tests can now assert on `targeting_method` to prove the fallback fired (or didn't).

---

## Phase 6: Atomic Issue GH-802 — test fixtures + integration coverage for canvas/map/bad-a11y

- **depends_on**: [phase-5]

### Overview

Build three failure-mode fixtures + one negative-control + an integration harness that runs story-runner on each and asserts the expected telemetry shape. This is the feature's acceptance test — if Phase 6 passes, the feature works end-to-end.

### Tasks

#### Task 6.1: Create fixtures directory scaffold

- **files**: `plugin/ralph-playwright/fixtures/vision-fallback/README.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at the specified path
  - [ ] Documents: purpose (vision-fallback integration fixtures), how to serve (`python3 -m http.server 8765 --directory plugin/ralph-playwright/fixtures/vision-fallback/`), how to invoke tests
  - [ ] Lists the four fixtures with a one-line description each
  - [ ] Notes that fixtures are the shared-fixtures directory introduced by this feature per parent epic's Integration Strategy

#### Task 6.2: Canvas fixture page

- **files**: `plugin/ralph-playwright/fixtures/vision-fallback/canvas-demo.html` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [6.1]
- **acceptance**:
  - [ ] Standalone HTML file loadable without a build step
  - [ ] Contains a `<canvas>` element with at least two visually distinct labeled shapes: a blue "Submit" button (rendered via canvas stroke + fill) and a red "Cancel" button
  - [ ] Canvas click handler records clicks into `window.__canvasClicks = [{x, y, nearest: "submit"|"cancel"|"none"}]`
  - [ ] A small debug readout div (off-canvas) shows the click log for manual inspection
  - [ ] No a11y roles on the canvas (intentional — this is the failure mode)
  - [ ] Page title and H1 describe the fixture's purpose

#### Task 6.3: Map fixture page

- **files**: `plugin/ralph-playwright/fixtures/vision-fallback/map-demo.html` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [6.1]
- **acceptance**:
  - [ ] Standalone HTML file, self-contained (no external CDN map SDKs)
  - [ ] Implements a minimal pan/zoom canvas-map UI: a grid background + three pin markers at fixed canvas positions labeled "SF", "NYC", "LA"
  - [ ] Pin click handler records `window.__mapClicks = [{x, y, nearest: "SF"|"NYC"|"LA"|"none"}]`
  - [ ] No a11y tree for the pins (they live inside the canvas)
  - [ ] Page includes a small static legend div (text) showing pin-to-city mapping for the human reviewer

#### Task 6.4: Bad-a11y fixture page

- **files**: `plugin/ralph-playwright/fixtures/vision-fallback/bad-a11y.html` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [6.1]
- **acceptance**:
  - [ ] Standalone HTML file with three interactive widgets: (a) a div-as-button styled as a primary CTA ("Submit Order"), (b) a div-as-checkbox, (c) a span-as-link
  - [ ] None have `role`, `aria-*`, or `tabindex` attributes
  - [ ] Click handlers on each div/span record `window.__divClicks = [{target: "submit"|"checkbox"|"link"}]`
  - [ ] Visually the widgets look like their intended affordances (styled buttons, visible checkmark box, underlined link) — the visual path is clear to Opus 4.7 even though the a11y path is broken

#### Task 6.5: A11y-good negative-control fixture

- **files**: `plugin/ralph-playwright/fixtures/vision-fallback/a11y-good-control.html` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [6.1]
- **acceptance**:
  - [ ] Standalone HTML file with a normal accessible form: labeled `<input>` fields, `<button type="submit">`, semantic `<h1>`, `<nav>`
  - [ ] Clicking submit records `window.__submitClicks = N`
  - [ ] This fixture MUST NOT trigger vision-fallback when story-runner targets "Submit" — vision is the failure mode, a11y is the expected path

#### Task 6.6: Integration test stories

- **files**: `plugin/ralph-playwright/fixtures/vision-fallback/stories/canvas-click.yaml` (create), `plugin/ralph-playwright/fixtures/vision-fallback/stories/map-pin.yaml` (create), `plugin/ralph-playwright/fixtures/vision-fallback/stories/div-button.yaml` (create), `plugin/ralph-playwright/fixtures/vision-fallback/stories/a11y-good.yaml` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [6.2, 6.3, 6.4, 6.5]
- **acceptance**:
  - [ ] Four user-story YAML files conforming to `plugin/ralph-playwright/schemas/user-story.schema.yaml`
  - [ ] `canvas-click.yaml`: targets the blue Submit button on `canvas-demo.html`, expects vision path
  - [ ] `map-pin.yaml`: targets the pin for SF on `map-demo.html`, expects vision path
  - [ ] `div-button.yaml`: targets "Submit Order" on `bad-a11y.html`, expects vision path
  - [ ] `a11y-good.yaml`: targets the Submit button on `a11y-good-control.html`, expects a11y path (negative control)
  - [ ] Each story uses `url: http://localhost:8765/<fixture>.html` (per the README's local-server convention)

#### Task 6.7: Integration runner script

- **files**: `plugin/ralph-playwright/fixtures/vision-fallback/run-integration.sh` (create)
- **tdd**: true
- **complexity**: high
- **depends_on**: [6.6]
- **acceptance**:
  - [ ] Bash script (shebang + `set -euo pipefail`)
  - [ ] Starts a local HTTP server on port 8765 (backgrounded PID captured)
  - [ ] For each of the four stories, invokes story-runner-agent (or documents the manual invocation — the agent dispatch may need a wrapper since these fixtures are not real URLs)
  - [ ] After each run, asserts on the journey trace:
    - Canvas, map, bad-a11y stories: `yq '.steps[-1].targeting_method' trace.yaml` returns `"vision_fallback"`
    - A11y-good story: `yq '.steps[-1].targeting_method' trace.yaml` returns `"a11y_ref"` (or is absent, which defaults to a11y_ref)
    - For vision-path runs: `yq '.steps[-1].vision_fallback.click_outcome' trace.yaml` is `"pass"`
    - For vision-path runs: `window.__canvasClicks` (via `playwright-cli eval`) shows the click landed near the target (distance threshold ~30 pixels)
  - [ ] Script tears down the HTTP server at exit (trap EXIT)
  - [ ] Exits 0 on all-pass, non-zero on any failure; prints a green/red summary
  - [ ] Runnable in CI without live-network dependencies

#### Task 6.8: Document fixture harness in browser SKILL.md

- **files**: `plugin/ralph-playwright/skills/browser/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [6.7]
- **acceptance**:
  - [ ] A new section "Vision-Fallback Fixtures" is appended pointing to `plugin/ralph-playwright/fixtures/vision-fallback/README.md`
  - [ ] Notes that this directory is the canonical home for shared integration fixtures (per parent epic) — future vision-related features may add more pages here

### Phase Success Criteria

#### Automated Verification:

- [x] `plugin/ralph-playwright/fixtures/vision-fallback/` directory exists with all four HTML fixtures, four story YAMLs, the runner script, and the README
- [x] `bash plugin/ralph-playwright/fixtures/vision-fallback/run-integration.sh` exits 0 in a clean environment with playwright-cli + Opus 4.7 available
- [x] The canvas, map, and bad-a11y runs each emit `targeting_method: vision_fallback` in their trace
- [x] The a11y-good run emits `targeting_method: a11y_ref` (or no `targeting_method` field, matching schema default)
- [x] The hook validator does not reject any generated trace
- [x] Integration run is hermetic — no live network, no external SDKs

#### Manual Verification:

- [ ] A human reviewer loading each fixture in a browser can visually confirm the target elements are present and labeled
- [ ] The canvas click log shows the vision-dispatched click landed on the intended shape (within 30px)
- [ ] The a11y-good control does not fire vision (confirmed by absence of `vision_fallback` blocks in its trace)
- [ ] Any low-confidence cases (confidence < 0.5) are visible in the trace for follow-up audit

**Creates for next phases**:

- None — this is the terminal phase. Feature is done when Phase 6 passes.

---

## Integration Testing

The Phase 6 integration runner IS the feature's integration test. In addition, the following cross-cutting checks are run manually before marking #792 Done:

- [ ] Schema change review: `git diff plugin/ralph-playwright/schemas/journey-trace.schema.yaml` shows only additive fields, no required-list changes
- [ ] Hook validator change review: new enum branches are opt-in on presence of `targeting_method`, never fail on absence
- [ ] Cross-feature compatibility with Feature A (GH-785): the env var `RALPH_PLAYWRIGHT_VISION_LOCATOR_MODEL` does not collide with `RALPH_PLAYWRIGHT_REFLECT_MODEL`; both declare intent in frontmatter and env-override independently
- [ ] A single developer can read only the three reference docs (`vision-fallback-trigger.md`, `vision-locator-prompt.md`, `click-by-coordinate.md`) + `vision-fallback-sequence.md` and answer: "what does the fallback do?" correctly
- [ ] The epic's shared-fixtures directory convention is honored: any future feature adding fixtures extends `plugin/ralph-playwright/fixtures/` rather than creating a parallel directory

## References

- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/784
- Primary feature issue: https://github.com/cdubiel08/ralph-hero/issues/792
- Atomic sub-issues: #797, #798, #799, #800, #801, #802
- Research: [thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md) §Part 3 Item 8
- Parent plan-of-plans: [thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md)

### Key files touched

- [plugin/ralph-playwright/agents/story-runner-agent.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/agents/story-runner-agent.md) — orchestrator prose
- [plugin/ralph-playwright/agents/explorer-agent.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/agents/explorer-agent.md) — orchestrator prose
- [plugin/ralph-playwright/skills/browser/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/browser/SKILL.md) — reference index
- [plugin/ralph-playwright/schemas/journey-trace.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/journey-trace.schema.yaml) — telemetry schema
- [plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh) — validator

### New files created

- `plugin/ralph-playwright/skills/browser/references/vision-fallback-trigger.md` (Phase 1)
- `plugin/ralph-playwright/skills/browser/references/vision-locator-prompt.md` (Phase 2)
- `plugin/ralph-playwright/skills/browser/references/click-by-coordinate.md` (Phase 3)
- `plugin/ralph-playwright/skills/browser/references/vision-fallback-sequence.md` (Phase 4)
- `plugin/ralph-playwright/fixtures/vision-fallback/README.md` (Phase 6)
- `plugin/ralph-playwright/fixtures/vision-fallback/canvas-demo.html` (Phase 6)
- `plugin/ralph-playwright/fixtures/vision-fallback/map-demo.html` (Phase 6)
- `plugin/ralph-playwright/fixtures/vision-fallback/bad-a11y.html` (Phase 6)
- `plugin/ralph-playwright/fixtures/vision-fallback/a11y-good-control.html` (Phase 6)
- `plugin/ralph-playwright/fixtures/vision-fallback/stories/canvas-click.yaml` (Phase 6)
- `plugin/ralph-playwright/fixtures/vision-fallback/stories/map-pin.yaml` (Phase 6)
- `plugin/ralph-playwright/fixtures/vision-fallback/stories/div-button.yaml` (Phase 6)
- `plugin/ralph-playwright/fixtures/vision-fallback/stories/a11y-good.yaml` (Phase 6)
- `plugin/ralph-playwright/fixtures/vision-fallback/run-integration.sh` (Phase 6)
