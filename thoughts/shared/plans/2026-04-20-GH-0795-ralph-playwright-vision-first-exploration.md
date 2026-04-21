---
date: 2026-04-20
status: draft
type: plan
github_issue: 795
github_issues: [795, 804, 807, 810, 812, 815, 818]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/795
  - https://github.com/cdubiel08/ralph-hero/issues/804
  - https://github.com/cdubiel08/ralph-hero/issues/807
  - https://github.com/cdubiel08/ralph-hero/issues/810
  - https://github.com/cdubiel08/ralph-hero/issues/812
  - https://github.com/cdubiel08/ralph-hero/issues/815
  - https://github.com/cdubiel08/ralph-hero/issues/818
primary_issue: 795
parent_plan: thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md
tags: [ralph-playwright, opus-4-7, vision, explorer-agent, computer-use, a11y]
---

# ralph-playwright: vision-driven exploration mode in explorer-agent — Feature Plan

## Prior Work

- builds_on:: [[2026-04-16-opus-4-7-ralph-playwright-vision]]
- builds_on:: [[2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic]]

## Overview

6 atomic sub-issues implementing Feature K from the Opus 4.7 vision epic: an optional `--vision-first` exploration mode for `explorer-agent` that reasons about screenshots rather than accessibility-snapshot element refs.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-804 | Add `--vision-first` mode flag to explore skill and explorer-agent | XS |
| 2a | GH-807 | Implement vision-first decision prompt in explorer-agent | S |
| 2b | GH-810 | Add `decision_mode` and `vision_rationale` fields to journey-trace schema | XS |
| 3 | GH-812 | Success-metrics logging and ref-vs-vision comparison summary | S |
| 4 | GH-818 | Demo and validate vision-first on a poor-a11y test target | S |
| 5 | GH-815 | Document when to use `--vision-first` mode | XS |

**Why grouped**: The atomics form a pre-split dependency chain that lands a single opt-in feature. Phase 1 plumbs the flag through the skill/agent boundary with no behavior change. Phase 2a rewires the decision loop; Phase 2b extends the trace schema — both consume the flag but do not depend on each other. Phase 3 cannot run without the schema (2b) or a vision-first loop that uses it (2a). Phase 4 validates empirically once metrics exist (3). Phase 5 documents findings from the demo (4). Landing all six in one feature keeps the `--vision-first` surface coherent (flag -> prompt -> schema -> metrics -> evidence -> docs) instead of shipping a half-wired flag.

**Dependency chain**: #804 -> {#807, #810} -> #812 -> #818 -> #815.

## Shared Constraints

Inherited verbatim from the parent plan-of-plans ([2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md#shared-constraints)):

### Architecture & file ownership

- Any new inputs/outputs flow through the three YAML schemas in `plugin/ralph-playwright/schemas/`. **Schema additions must be additive (new optional fields only).** This feature adds `decision_mode` and `vision_rationale` as optional step fields and an optional `input.mode` echo — no existing consumer breaks.
- Hooks in [plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh) validate journey-trace YAMLs at Read and Write. The current hook enforces top-level `required` keys and the `steps[].outcome` enum only (lines 85-91). Because our new fields are optional, the hook does **not** need to be updated unless we decide to enum-guard `decision_mode` (we will — see Phase 2b).
- `explorer-agent` continues to run as a sub-agent with `model: sonnet`. The vision-first prompt change is a prompt-shape change, not a model swap.
- Screenshots (PNG) and accessibility snapshots (`.md`) continue to be captured at EVERY step, in both modes. Vision-first mode reads the snapshot for the record but does not use it for decisioning.
- The "NEVER use CSS selectors" rule stays in force for `story-runner-agent`. `explorer-agent` is allowed to emit coordinate or visual-description targets in vision-first mode since the exploration contract never claimed element-ref discipline in the first place.

### Model routing discipline

- This feature does **not** introduce a new model slot. Sonnet continues to drive `explorer-agent` because the vision-first loop primarily changes what the agent reasons about, not which model reasons. Reflect (which runs outside this feature) is where Opus 4.7 routing applies.
- No per-step model annotation is added by this feature; Feature C (GH-787) owns that.

### Cost & token envelope

- Default capture resolution stays at the playwright-cli current viewport default. Vision-first mode does NOT auto-opt into `--high-res` (Feature J, GH-794). If an operator wants high-res + vision-first, they pass both flags independently.
- Vision-first is opt-in: default explore runs stay on the ref-based path, unchanged.

### Prompt engineering conventions

- The vision-first decision rubric must be declarative and categorized, not free-form — consistent with the parent epic's "categorized checklists beat free-form instructions" rule.
- The rubric must name visual targets in human-readable form (e.g., "blue primary CTA, top-right, only enabled button on page"), not raw pixel coordinates. Coordinate extraction is a secondary resolution step, not the decision primitive.

### Artifact paths

- Session data: `.playwright-cli/<session>/` (journey-trace.yaml, signal-report.yaml, action-log.yaml, screenshots, snapshots). Vision-first adds one sibling file: `.playwright-cli/<session>/exploration-metrics.yaml`.
- Poor-a11y fixture (Phase 4) lives under `plugin/ralph-playwright/examples/poor-a11y-demo/` — a new top-level directory. `examples/` is introduced by this feature for demo fixtures; future features (e.g., Feature H, Feature L) may reuse it.
- Demo research doc: `thoughts/shared/research/2026-04-<NN>-vision-first-exploration-demo.md`.

### Verification tooling

Ralph-playwright is skills/agents-only — no npm build/test matrix applies to this feature's code paths directly. Verification per phase:

- **Phase 1 (flag plumbing)** — invoke `/ralph-playwright:explore` without and with `--vision-first`; confirm default path is byte-identical in the prompt surface (no behavior change) and that the flag reaches the agent spawn.
- **Phase 2a (vision-first prompt)** — manual dry-run on one localhost app; confirm the loop emits steps with visual-description targets.
- **Phase 2b (schema fields)** — write a sample journey-trace with `decision_mode: vision-first` and `vision_rationale: "..."` and confirm `validate-primitive-io.sh` does not reject. Also write a legacy trace without the fields and confirm it still passes (backward compat).
- **Phase 3 (metrics)** — run explore twice on the same URL+goal in different modes; confirm `exploration-metrics.yaml` appears in each session dir and the comparison table renders.
- **Phase 4 (demo)** — the whole feature validates end-to-end on the poor-a11y fixture.
- **Phase 5 (docs)** — lint-free Markdown, cross-links resolve.

### Research anchoring

- Parent research: [2026-04-16-opus-4-7-ralph-playwright-vision.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md), §Part 3 Item 11 (vision-driven exploration mode).
- Parent epic: #784. Feature K in the plan-of-plans.

## Current State Analysis

**explorer-agent today** ([plugin/ralph-playwright/agents/explorer-agent.md:40-70](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/agents/explorer-agent.md#L40-L70)): the Exploration Loop captures snapshot + screenshot + console at each state, then "decides next action based on" (1) the goal, (2) interactive elements **visible in the snapshot** (links, buttons, forms, tabs), (3) visited URLs. Step 5 takes the action and records `{ index, action, target, outcome, screenshot, snapshot, console, duration_ms, error }` with `target` as "human-readable description of what was acted on" (e.g., "Products link").

**explore skill today** ([plugin/ralph-playwright/skills/explore/SKILL.md:19-29](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/explore/SKILL.md#L19-L29)): Step 1 (Execute) spawns `explorer-agent` with `{ url, goal, session, persona }`. Step 4 (Summary) reports "N steps explored, N signals found (by severity)", research note path, promoted screenshot count, user stories generated.

**journey-trace schema today** ([plugin/ralph-playwright/schemas/journey-trace.schema.yaml:33-68](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/journey-trace.schema.yaml#L33-L68)): step `required: [index, action, target, outcome, screenshot, snapshot, console, duration_ms]`. `error` is optional. `input` is a free-form object ("Echo of the execute input for reproducibility") so adding `input.mode` is implicit — no schema change needed for that echo.

**Hook validator today** ([plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh:85-91](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh#L85-L91)): for journey-traces, enforces top-level `required` + step `outcome` enum only. Our new optional fields pass without hook changes. If we choose to strictly enum-guard `decision_mode`, we add a parallel check to the hook.

**Gap**: on sites with poor a11y hygiene (missing labels, generic `<div>` buttons, `aria-hidden` critical elements, canvas/map renderers), the snapshot-ref-based decision loop stalls — refs point to uninformative elements, the agent re-visits loops, or exploration terminates early with no new paths. Opus 4.7's +21.8 pts on Visual Navigation and +44 on XBOW's acuity benchmark suggests screenshot-first reasoning could unlock these sites. But the hypothesis is untested; we need evidence before recommending it as a default.

**Related work**:
- Feature H (GH-792) — vision-fallback element targeting. Uses vision ONLY when a11y snapshot yields no ref. This feature uses vision as the **primary** driver. Both features can coexist and compose: a vision-first explore session could still use #792's coordinate-click primitive to execute the action once the target is chosen visually. No direct dependency in either direction.

## Desired End State

An operator runs:

```bash
/ralph-playwright:explore --vision-first http://localhost:3000 "discover checkout flow"
```

and gets:

1. An explore session where every step's decision is driven by screenshot reasoning.
2. A `journey-trace.yaml` where each step has `decision_mode: vision-first` and `vision_rationale: "primary blue CTA, top-right — only enabled button visible"`, plus top-level `input.mode: vision-first`.
3. An `exploration-metrics.yaml` sidecar with: `mode`, `goal_achieved`, `total_steps`, `passed`, `failed`, `duration_ms`, `unique_urls`, `dead_ends`.
4. If a prior ref-mode run for the same URL+goal exists in the same assets tree, the Step 4 summary prints a side-by-side comparison table.
5. Documentation in `explore/SKILL.md` telling the operator when to reach for this mode (poor a11y, canvas-heavy, custom widgets) and what it costs (more tokens, slower, less-precise click targeting).
6. A committed demo showing the mode succeeding on a poor-a11y fixture that ref-mode gets stuck on (or honest findings if it does not).

### Verification

- [ ] `/ralph-playwright:explore` without flag behaves byte-identically to pre-feature baseline.
- [ ] `/ralph-playwright:explore --vision-first` runs end-to-end on a localhost app and produces a valid journey-trace.
- [ ] `validate-primitive-io.sh` accepts both a legacy trace (no new fields) and a vision-first trace (with new fields).
- [ ] `exploration-metrics.yaml` is written for both modes.
- [ ] Demo research doc exists under `thoughts/shared/research/` showing both modes run on the poor-a11y fixture with comparison table.
- [ ] `explore/SKILL.md` has a "Modes" or "When to use vision-first" section listing at least 3 site classes and the known costs.

## What We're NOT Doing

- **No model swap**. `explorer-agent` stays on Sonnet. If an operator wants Opus 4.7 driving the vision-first loop, they invoke the skill with Opus as their top-level model; we do not force it.
- **No auto-promotion to default**. `--vision-first` stays opt-in regardless of demo results in Phase 4. Changing the default is a separate decision that would require a deprecation window and a broader signal-quality comparison.
- **No `story-runner-agent` changes**. Vision-first exploration is a freeform-exploration feature. Structured story execution remains strictly accessibility-ref-based.
- **No reflect-pipeline coupling**. Reflect continues to read both screenshots and snapshots. The fact that snapshots had no role in vision-first decisioning does not mean reflect ignores them.
- **No new signal-report types**. This feature does not introduce `vision_targeting_failure` or similar. If the vision-first loop stalls, it fails with existing signal types (`anomaly`, `ux_issue`).
- **No CI for the demo fixture**. Phase 4 checks the fixture in under `plugin/ralph-playwright/examples/`, but we do not wire it into GitHub Actions. That is a follow-up if the demo lands cleanly.
- **No cross-run baseline storage in thoughts/local/baselines/**. Metrics comparison reads prior sessions from the same `.playwright-cli/` tree or assets dir; it does not reuse the visual-diff baseline mechanism (Feature G, GH-791).
- **No token cost measurement**. Parent epic's open question about Opus 4.7 cost per screenshot is NOT answered here. Phase 4 records duration_ms but not token counts.

## Implementation Approach

Each phase below corresponds to one atomic GitHub issue. Phase dependencies match the `depends_on` graph in the parent plan-of-plans:

```
Phase 1 (GH-804) -> Phase 2a (GH-807)
                 -> Phase 2b (GH-810)
Phase 2a + 2b    -> Phase 3 (GH-812)
Phase 3          -> Phase 4 (GH-818)
Phase 4          -> Phase 5 (GH-815)
```

Phase 2a and 2b can run in parallel after Phase 1 completes. Every other phase is strictly sequential.

**Ref-vs-vision comparison design** (shared across phases 2b, 3, 4):

- **Primary key** for pairing: `(url, goal)` tuple. Operator-chosen session names encode these, but we do not parse session names. Instead, the metrics file records `url` and `goal` verbatim.
- **Comparison surface**: `.playwright-cli/<session>/exploration-metrics.yaml` for every session. On the most recent run, `explore/SKILL.md` Step 4 walks sibling directories under `.playwright-cli/` and picks the most recent metrics file with the same `(url, goal)` and a different `mode` to compare against.
- **Comparison fields** (printed side-by-side in Step 4 output):
  - `goal_achieved` (boolean; true iff the agent's final step recorded `outcome: pass` and its `target` matched goal semantics, else inferred false)
  - `total_steps`, `passed`, `failed`, `duration_ms` (carried from journey-trace `summary`)
  - `unique_urls` (count of distinct URLs visited, computed from `steps[].target` for navigate actions + the starting URL)
  - `dead_ends` (count of steps where the action produced no new URL and the snapshot after the step matches the snapshot before the step; approximated via filename hash comparison)
- **Not compared**: screenshot-quality metrics, signal counts, per-step reasoning text. Those remain in the per-session research note (Step 3) if the operator runs reflect.

---

## Phase 1: GH-804 — Add `--vision-first` mode flag to explore skill and explorer-agent

- **depends_on**: null

### Overview

Plumb the `--vision-first` flag from the slash-command surface through the explore skill into the `explorer-agent` spawn payload as a `mode` input. No behavior change — the default path is byte-identical and the agent accepts `mode: ref | vision-first` with `ref` as default.

### Tasks

#### Task 1.1: Document `--vision-first` flag in explore/SKILL.md Prerequisites

- **files**: `plugin/ralph-playwright/skills/explore/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Prerequisites or a new "Modes" subsection lists `--vision-first` as an optional flag
  - [ ] Default behavior is stated explicitly: "Without the flag, explore uses accessibility-snapshot-ref navigation (ref mode)."
  - [ ] Cross-link to [#795](https://github.com/cdubiel08/ralph-hero/issues/795) epic context (one-line reference)
  - [ ] No behavioral promises beyond flag existence (no "works better on poor a11y" claims yet — those land in Phase 5)

#### Task 1.2: Parse `--vision-first` from skill arguments and pass to agent spawn

- **files**: `plugin/ralph-playwright/skills/explore/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Step 1 (Execute) shows the Agent spawn receiving `mode: vision-first` when the flag is present, `mode: ref` otherwise (or unset — agent default wins)
  - [ ] Parsing logic is declarative: Step 1 preamble says "If arguments contain `--vision-first`, set `mode: vision-first`; else `mode: ref`"
  - [ ] Backward compat: existing invocations without the flag produce the same spawn payload as before (no `mode` key OR `mode: ref` — either is fine, document which)

#### Task 1.3: Extend explorer-agent Input section to accept `mode`

- **files**: `plugin/ralph-playwright/agents/explorer-agent.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Input section lists `mode: ref | vision-first` with "Optional; defaults to `ref` when omitted"
  - [ ] Input section preamble notes that the field is read but behaviorally unused in this phase (full behavior lands in Phase 2a)
  - [ ] Exploration Loop and Recording sections are not modified (behavior-preserving change)

### Phase Success Criteria

#### Automated Verification

- [ ] Manual: grep for `--vision-first` in `skills/explore/SKILL.md` returns matches.
- [ ] Manual: grep for `mode:` in `agents/explorer-agent.md` Input section returns a match.
- [ ] Hook: `validate-primitive-io.sh` is unchanged; no schema touched in this phase.

#### Manual Verification

- [ ] Invoking `/ralph-playwright:explore http://localhost:3000 "some goal"` (no flag) produces a journey-trace identical in shape to pre-phase baseline.
- [ ] Invoking with `--vision-first` produces a journey-trace (default ref-path, since Phase 2a has not landed) and echoes `mode: vision-first` nowhere problematic — no crash.

**Creates for next phase**: The `mode` input contract on `explorer-agent` that Phase 2a branches on.

---

## Phase 2a: GH-807 — Implement vision-first decision prompt in explorer-agent

- **depends_on**: [phase-1]

### Overview

Add a "Vision-First Loop" section to `explorer-agent.md` that parallels the existing "Exploration Loop". When `mode=vision-first`, step 4 (Decide next action) is driven by the screenshot. The agent names the visual target (e.g., "the blue 'Add to cart' button, top-right") and extracts an approximate bounding box or pixel coordinate; the action is resolved via coordinates or nearest-ref fallback.

### Tasks

#### Task 2a.1: Add Vision-First Loop section to explorer-agent.md

- **files**: `plugin/ralph-playwright/agents/explorer-agent.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] New section "Vision-First Loop" appears after the existing "Exploration Loop" section and is invoked when `mode=vision-first`
  - [ ] Section has steps 1-5 parallel to the ref-mode loop: snapshot, screenshot, read console state, decide next action (vision-driven), take action
  - [ ] Step 4 of the vision-first loop instructs: "Examine the screenshot. Identify interactive regions. Select the next target by naming it in human-readable form (color/shape/position/label-if-visible). Extract an approximate bounding box or center-coordinate for the target."
  - [ ] A rubric appears inline: "Prefer obvious primary CTAs. Avoid revisiting visually-identical states. Bias toward unexplored visual regions."
  - [ ] Stop conditions (goal achieved, 20 interactions, loop detection, no new paths) are reused verbatim from the ref loop
  - [ ] The agent still captures both snapshot and screenshot (snapshot is kept for the record but not consulted for decisions in vision-first mode)

#### Task 2a.2: Define target-resolution contract for vision-first actions

- **files**: `plugin/ralph-playwright/agents/explorer-agent.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [2a.1]
- **acceptance**:
  - [ ] Section documents how the visual target resolves to a concrete playwright-cli command:
    - Primary: if a nearest accessibility-snapshot ref is confidently visible at the target coordinates, use `playwright-cli click <ref>` (graceful convergence with ref mode)
    - Fallback: if no ref is resolvable, emit a coordinate-based click. Note that coordinate-click depends on Feature H (GH-792) landing; until then, document the fallback as "record the visual target and skip the action; surface the miss in the journey-trace error field"
  - [ ] `target` field in recorded step is the human-readable visual description in vision-first mode (e.g., "blue primary CTA top-right"), not an element ref or URL
  - [ ] No interaction with Feature H beyond this documentation note — this feature does not block on #792

#### Task 2a.3: Update Recording section to show vision-first step shape

- **files**: `plugin/ralph-playwright/agents/explorer-agent.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2a.1, 2a.2]
- **acceptance**:
  - [ ] Recording section's example step YAML includes a commented alternative: "In vision-first mode, additionally emit `decision_mode: vision-first` and `vision_rationale: \"...\"`" — BUT the schema wiring happens in Phase 2b; this phase only documents the intent in the prose
  - [ ] The existing step shape (index, action, target, outcome, screenshot, snapshot, console, duration_ms, error) stays intact for backward compat

### Phase Success Criteria

#### Automated Verification

- [ ] Manual: grep for "Vision-First Loop" in `agents/explorer-agent.md` returns a match.
- [ ] Hook: no schema changes in this phase; `validate-primitive-io.sh` unchanged.

#### Manual Verification

- [ ] Dry-run on one localhost app (any running dev server) with `--vision-first` succeeds end-to-end.
- [ ] Produced steps have `target` fields that are visual descriptions (not element refs), at least for steps where vision drove the decision.
- [ ] The agent does NOT loop indefinitely (stop conditions honored).

**Creates for next phase**: a functioning vision-first execution loop whose step records will consume the schema fields added in Phase 2b / 3.

---

## Phase 2b: GH-810 — Add `decision_mode` and `vision_rationale` fields to journey-trace schema

- **depends_on**: [phase-1]

(Parallel with Phase 2a after Phase 1 completes.)

### Overview

Extend `journey-trace.schema.yaml` so each step records which decision mode produced it and, for vision-first steps, the one-line visual rationale the agent used. Extend the top-level `input` documentation to show `mode` echo. Update `explorer-agent.md` Recording section's example step YAML to show the new fields.

### Tasks

#### Task 2b.1: Add `decision_mode` step field to journey-trace schema

- **files**: `plugin/ralph-playwright/schemas/journey-trace.schema.yaml` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `steps[].properties.decision_mode` added as optional (not in `required`) with `type: string` and `enum: [ref, vision-first]`
  - [ ] Description: "Decision mode that produced this step. Defaults to `ref` when omitted for backward compatibility."
  - [ ] Existing traces without the field remain valid against the updated schema

#### Task 2b.2: Add `vision_rationale` step field to journey-trace schema

- **files**: `plugin/ralph-playwright/schemas/journey-trace.schema.yaml` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2b.1]
- **acceptance**:
  - [ ] `steps[].properties.vision_rationale` added as optional with `type: ["string", "null"]`
  - [ ] Description: "Short free-text describing what the agent saw and why it picked the target. Expected to be non-null when `decision_mode: vision-first`, null otherwise."
  - [ ] No cross-field `required` constraint enforcing "if vision-first then rationale" — we document the expectation but do not gate it at the schema level (keep validator simple)

#### Task 2b.3: Document `input.mode` echo convention

- **files**: `plugin/ralph-playwright/schemas/journey-trace.schema.yaml` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `input` property description extended: "Echo of the execute input for reproducibility. When the caller passes a `mode` field, it MUST be echoed here (e.g., `input.mode: vision-first`)."
  - [ ] `input` remains a free-form object (no nested `properties` block added) — consistent with current schema posture

#### Task 2b.4: Update hook validator to enum-guard `decision_mode`

- **files**: `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2b.1]
- **acceptance**:
  - [ ] In the `journey-trace.schema.yaml` branch (current lines 85-91), add a parallel check: if any `steps[].decision_mode` is present, it must match `^(ref|vision-first)$`; absent values pass
  - [ ] The check uses the same `yq | grep -v -E` pattern already in the file
  - [ ] Running the hook against a legacy trace (no `decision_mode`) exits 0
  - [ ] Running against a trace with `decision_mode: bogus` exits 1

#### Task 2b.5: Update explorer-agent.md Recording section example

- **files**: `plugin/ralph-playwright/agents/explorer-agent.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2b.1, 2b.2]
- **acceptance**:
  - [ ] Recording section's YAML example shows both fields, clearly flagged as vision-first-only:
    ```yaml
    - index: <N>
      action: "click"
      target: "blue primary CTA, top-right"
      decision_mode: vision-first     # optional; omit for ref mode
      vision_rationale: "only enabled button visible above the fold"
      outcome: pass
      screenshot: ...
      snapshot: ...
      console: []
      duration_ms: <ms>
      error: null
    ```
  - [ ] The ref-mode example (existing) stays unchanged

### Phase Success Criteria

#### Automated Verification

- [ ] Manual: `yq .steps[0].properties.decision_mode.enum plugin/ralph-playwright/schemas/journey-trace.schema.yaml` (the exact path differs with array-items schema structure; the point is that the field exists and has the enum).
- [ ] Hook test: write a legacy trace, run validate-primitive-io.sh, exit 0. Write a vision-first trace, run again, exit 0. Write a trace with `decision_mode: wat`, run again, exit 1.

#### Manual Verification

- [ ] Read a sample journey-trace from a prior explore session (any existing `.playwright-cli/*/journey-trace.yaml`), confirm it still validates.
- [ ] Read a newly-written vision-first journey-trace, confirm it validates.

**Creates for next phase**: schema fields + hook acceptance that Phase 3 populates and reads for metrics.

---

## Phase 3: GH-812 — Success-metrics logging and ref-vs-vision comparison summary

- **depends_on**: [phase-2a, phase-2b]

### Overview

When `/ralph-playwright:explore` finishes a session (either mode), compute a small metrics file and write it alongside the journey-trace. If a prior run on the same URL+goal in the other mode is discoverable, print a side-by-side comparison table in the final report. Document the metrics-file schema inline in `explore/SKILL.md`.

### Tasks

#### Task 3.1: Define exploration-metrics.yaml shape inline in SKILL.md

- **files**: `plugin/ralph-playwright/skills/explore/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `explore/SKILL.md` adds a new subsection (under Step 4 or as a new Step) titled "Exploration Metrics" with the following YAML spec:
    ```yaml
    mode: ref | vision-first
    url: <starting URL>
    goal: <verbatim goal string>
    session: <session name>
    goal_achieved: <boolean>
    total_steps: <int>
    passed: <int>
    failed: <int>
    duration_ms: <int>
    unique_urls: <int>
    dead_ends: <int>
    ```
  - [ ] Each field has a one-line description
  - [ ] `mode` is required; if caller passed no mode, default is `ref`
  - [ ] File path: `.playwright-cli/<session>/exploration-metrics.yaml`

#### Task 3.2: Extend Step 4 (Summary) to compute and write metrics

- **files**: `plugin/ralph-playwright/skills/explore/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] Step 4 reads `journey-trace.yaml` and computes:
    - `goal_achieved`: true iff the terminal step's `outcome == pass` AND the step's action or target references a goal-fulfilling condition (documented as "operator judgment; default to `false` if uncertain")
    - `total_steps`, `passed`, `failed`, `duration_ms` from trace `summary`
    - `unique_urls`: count distinct URLs from steps where action is navigate (`action == "navigate"` -> `target` is URL) plus the starting URL
    - `dead_ends`: count steps where the post-action snapshot path equals the pre-action snapshot path AND no URL change occurred (approximation documented as such)
  - [ ] `mode` is taken from `input.mode` echo (set in Phase 2b); missing `mode` is recorded as `ref`
  - [ ] Metrics file is written to `.playwright-cli/<session>/exploration-metrics.yaml` before Step 4's summary print
  - [ ] Metrics computation is documented in prose; we do not ship a helper script in this phase

#### Task 3.3: Discover prior-run metrics and render comparison table

- **files**: `plugin/ralph-playwright/skills/explore/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.2]
- **acceptance**:
  - [ ] Step 4 walks sibling directories under `.playwright-cli/` (and optionally the same `thoughts/local/assets/` tree if it exists for the current session) looking for prior `exploration-metrics.yaml` files with the SAME `url` and `goal` but a DIFFERENT `mode` from the current run
  - [ ] If at least one prior run is found, the most recent is paired with the current run; older matches are noted as "also found: N prior runs for this URL/goal".
  - [ ] Comparison table is printed in the Step 4 summary output:
    ```
    Metric          Ref    Vision-first
    ------          ---    ------------
    goal_achieved   true   true
    total_steps     12     14
    passed          11     13
    failed          1      1
    duration_ms     45120  58300
    unique_urls     6      7
    dead_ends       2      0
    ```
  - [ ] If no prior run exists, the table is skipped silently (no error)
  - [ ] The comparison discovery logic is documented in prose, not code; ralph-playwright is skills/agents-only

#### Task 3.4: Update Step 4 report text to include metrics location

- **files**: `plugin/ralph-playwright/skills/explore/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.2]
- **acceptance**:
  - [ ] Step 4 report line added: "Metrics: `.playwright-cli/<session>/exploration-metrics.yaml`"
  - [ ] If comparison table rendered, report line added: "Compared against: `.playwright-cli/<prior-session>/exploration-metrics.yaml` (<prior mode>)"

### Phase Success Criteria

#### Automated Verification

- [ ] Manual: invoke explore twice — once without flag (ref), once with `--vision-first` — on the same URL+goal in sequence. Confirm two `exploration-metrics.yaml` files exist, one per session.
- [ ] Manual: on the second invocation, the Step 4 report contains the comparison table.

#### Manual Verification

- [ ] Open both metrics files, confirm fields match the inline spec.
- [ ] `goal_achieved` values match human assessment of the runs (spot check).
- [ ] No crash when no prior run exists (first-ever run of a new goal).

**Creates for next phase**: the metrics + comparison surface that Phase 4's demo report will cite as evidence.

---

## Phase 4: GH-818 — Demo and validate vision-first on a poor-a11y test target

- **depends_on**: [phase-3]

### Overview

Pick or configure one concrete poor-a11y web target, run exploration twice (ref mode and vision-first mode) on the same URL+goal, and record the comparison as validation evidence. Write a research doc with findings and a keep/drop/iterate recommendation.

### Tasks

#### Task 4.1: Create synthetic poor-a11y fixture

- **files**: `plugin/ralph-playwright/examples/poor-a11y-demo/index.html` (create), `plugin/ralph-playwright/examples/poor-a11y-demo/README.md` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] `index.html` is a single-file static page with: generic `<div>` buttons (no `role="button"` or `aria-label`), no input labels, no landmark regions, critical CTAs styled with color-only affordance
  - [ ] Page has a clear "happy path" goal achievable in 3-5 clicks (e.g., "Add an item to cart and reach the confirmation screen")
  - [ ] Page runs as a static file (file:// or any static server) — no build step
  - [ ] `README.md` documents: how to serve it (`python3 -m http.server 8000` in the examples dir), the intended goal string, what makes it poor-a11y (bullet list of violations)
  - [ ] Decision note documented in README: "We chose a synthetic fixture over a real public site because (a) reproducible, (b) no legal/trademark concerns, (c) we can make the a11y gaps precise enough that ref-mode is expected to stall."

#### Task 4.2: Run ref-mode baseline on fixture

- **files**: reads the live fixture, writes to `.playwright-cli/<date>-explore-poor-a11y-ref/`
- **tdd**: false
- **complexity**: medium
- **depends_on**: [4.1]
- **acceptance**:
  - [ ] Fixture is running at a known localhost URL
  - [ ] `/ralph-playwright:explore <url> "reach the confirmation screen"` (no flag) runs end-to-end
  - [ ] Journey-trace, signal-report, action-log, and exploration-metrics files all exist in the session dir
  - [ ] `exploration-metrics.yaml` has `mode: ref` and non-null `goal_achieved`

#### Task 4.3: Run vision-first mode on same fixture

- **files**: reads the live fixture, writes to `.playwright-cli/<date>-explore-poor-a11y-vision/`
- **tdd**: false
- **complexity**: medium
- **depends_on**: [4.2]
- **acceptance**:
  - [ ] `/ralph-playwright:explore --vision-first <url> "reach the confirmation screen"` runs end-to-end (same URL and goal as 4.2)
  - [ ] Journey-trace has `input.mode: vision-first` and per-step `decision_mode: vision-first` + `vision_rationale: "..."`
  - [ ] `exploration-metrics.yaml` has `mode: vision-first`
  - [ ] Step 4 summary renders the comparison table (prior ref run is discoverable)

#### Task 4.4: Write demo research doc

- **files**: `thoughts/shared/research/2026-04-<NN>-vision-first-exploration-demo.md` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [4.3]
- **acceptance**:
  - [ ] Research doc has standard frontmatter (`date`, `type: research`, `tags: [ralph-playwright, vision, exploration, demo]`, `github_issue: 818`)
  - [ ] Includes: goal + target description (cross-link to `examples/poor-a11y-demo/`), success/failure for each mode, step counts, dead-ends, duration, screenshots showing a moment where vision-first succeeded and ref-mode got stuck (if observed)
  - [ ] Has a clear "Recommendation" section: one of `keep` / `drop` / `iterate`
  - [ ] If the recommendation updates the docs (Phase 5), flag it in the doc so Phase 5 can cite it
  - [ ] If ref-mode surprisingly succeeds (null result), document the honest finding rather than cherry-picking evidence

#### Task 4.5: Cross-link demo from issue #795 and #818

- **files**: none directly; this is a GitHub comment posting step
- **tdd**: false
- **complexity**: low
- **depends_on**: [4.4]
- **acceptance**:
  - [ ] Comment on #818 links to the research doc
  - [ ] Comment on #795 links to the research doc in a "Demo Evidence" section
  - [ ] Parent epic #784 is not commented on (Phase 5 docs are the outward-facing artifact; #784 tracks progress via sub-issue completion)

### Phase Success Criteria

#### Automated Verification

- [ ] Fixture files exist and the README's serve-command works.
- [ ] Both `.playwright-cli/` session dirs exist and have all expected files.
- [ ] Research doc exists at the expected path.

#### Manual Verification

- [ ] Reading the research doc, the keep/drop/iterate recommendation is justified by the metrics comparison.
- [ ] Screenshots (if any) are clear evidence.
- [ ] The doc avoids claiming outcomes not supported by the data.

**Creates for next phase**: empirical findings that the Phase 5 docs cite.

---

## Phase 5: GH-815 — Document when to use `--vision-first` mode

- **depends_on**: [phase-4]

### Overview

Add operator guidance on when vision-first exploration is worth the cost vs. default ref-based mode. Informed by Phase 4 demo findings. This is the "how do I decide" doc piece.

### Tasks

#### Task 5.1: Add "When to use vision-first" section to explore/SKILL.md

- **files**: `plugin/ralph-playwright/skills/explore/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] New section "When to use `--vision-first`" (either under Prerequisites or as a new top-level "Modes" section)
  - [ ] Lists at least 3 site classes where vision-first is preferable:
    - Poor a11y hygiene (missing labels, generic `<div>` buttons, aria-hidden critical elements)
    - Canvas-heavy apps (maps, whiteboards, custom chart libraries)
    - Custom widgets (drag-and-drop, color pickers, complex DnD)
  - [ ] Lists known costs/tradeoffs:
    - Higher token spend per step (screenshot reasoning vs. compact snapshot)
    - Slower per-step latency
    - Potentially less-precise click targeting (coordinates vs. element refs)

#### Task 5.2: Cross-link sibling epic features

- **files**: `plugin/ralph-playwright/skills/explore/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [5.1]
- **acceptance**:
  - [ ] Section cross-links to #792 (vision-fallback targeting) as "Use with #792's coordinate-click primitive if your target app has no accessibility refs at all"
  - [ ] Section cross-links to #794 (`--high-res`) as "Combine with `--high-res` for OCR-dense pages (tables, receipts, dense charts)"
  - [ ] Links use full GitHub issue URLs (not just `#NNN` references) so they resolve in published docs

#### Task 5.3: Cite Phase 4 findings in the docs section

- **files**: `plugin/ralph-playwright/skills/explore/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [5.1]
- **acceptance**:
  - [ ] Section includes a "Demo" subsection (2-3 sentences) summarizing Phase 4's findings
  - [ ] Links to the research doc written in Task 4.4
  - [ ] If Phase 4 recommended `drop`, this section STILL documents the flag but adds a prominent caveat ("Demo evidence suggests limited benefit on current test targets; use with caution.")
  - [ ] If Phase 4 recommended `iterate`, this section links to follow-up issues

### Phase Success Criteria

#### Automated Verification

- [ ] Manual: grep for "When to use" in `skills/explore/SKILL.md` returns a match.
- [ ] Manual: all links to other GitHub issues resolve (URLs are well-formed).

#### Manual Verification

- [ ] Read the section — an operator new to the feature can decide whether to use it from the docs alone.
- [ ] The demo findings are fairly represented (no glossing over null results).

**Creates for next phase**: n/a (final phase).

---

## Integration Testing

End-to-end integration validation covering the full feature:

- [ ] On any localhost app, `/ralph-playwright:explore --vision-first` succeeds end-to-end and the resulting journey-trace validates against the updated schema.
- [ ] Rerun without the flag; confirm both traces have different `input.mode` values and per-step `decision_mode` where applicable.
- [ ] `validate-primitive-io.sh` passes for both traces.
- [ ] `exploration-metrics.yaml` is written for both runs.
- [ ] Comparison table renders in the second run's Step 4 summary.
- [ ] Phase 4's demo is replayable by a new operator following the fixture README.

## References

### Research & parent plans

- Parent research: [thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md) (§Part 3 Item 11)
- Parent plan-of-plans: [thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md) (Feature K)
- Parent epic: [#784](https://github.com/cdubiel08/ralph-hero/issues/784)

### Atomic issues (execution order)

- Phase 1: [#804 — mode flag](https://github.com/cdubiel08/ralph-hero/issues/804)
- Phase 2a: [#807 — vision-first prompt](https://github.com/cdubiel08/ralph-hero/issues/807)
- Phase 2b: [#810 — schema fields](https://github.com/cdubiel08/ralph-hero/issues/810)
- Phase 3: [#812 — metrics + comparison](https://github.com/cdubiel08/ralph-hero/issues/812)
- Phase 4: [#818 — demo on poor-a11y target](https://github.com/cdubiel08/ralph-hero/issues/818)
- Phase 5: [#815 — documentation](https://github.com/cdubiel08/ralph-hero/issues/815)

### Code references

- [plugin/ralph-playwright/agents/explorer-agent.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/agents/explorer-agent.md) — primary file for Phase 1.3, 2a.1, 2a.2, 2a.3, 2b.5
- [plugin/ralph-playwright/skills/explore/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/explore/SKILL.md) — primary file for Phase 1.1, 1.2, 3.1, 3.2, 3.3, 3.4, 5.1, 5.2, 5.3
- [plugin/ralph-playwright/schemas/journey-trace.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/journey-trace.schema.yaml) — primary file for Phase 2b.1, 2b.2, 2b.3
- [plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh) — modified in Phase 2b.4

### Related work (non-blocking)

- [#792](https://github.com/cdubiel08/ralph-hero/issues/792) — vision-fallback element targeting (Feature H). Complementary: if #792 lands first, vision-first's coordinate-click fallback lights up; if not, vision-first's fallback records the miss and surfaces it.
- [#794](https://github.com/cdubiel08/ralph-hero/issues/794) — `--high-res` screenshot flag (Feature J). Complementary: operators combining `--vision-first --high-res` get OCR-grade screenshots driving the vision loop, at correspondingly higher cost.
