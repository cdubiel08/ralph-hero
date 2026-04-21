---
date: 2026-04-20
status: draft
type: plan
github_issue: 794
github_issues: [794]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/794
primary_issue: 794
parent_plan: thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md
tags: [ralph-playwright, opus-4-7, vision, screenshot, capture, resolution, ocr, token-cost]
---

# ralph-playwright: `--high-res` screenshot flag for critical steps — Implementation Plan

## Prior Work

- builds_on:: [[2026-04-16-opus-4-7-ralph-playwright-vision]]
- builds_on:: [[2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic]]

## Overview

Single-issue plan (Feature J in the epic). Three phases to (1) wire a `--high-res` opt-in flag through the capture call path and record the resolution on every step, (2) teach all four downstream consumers how to benefit from higher-resolution images, (3) verify dimensions and token cost empirically on a real session.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-794 | Thread `--high-res` through capture path + journey-trace | S |
| 2 | GH-794 | Downstream consumer documentation (reflect, a11y-scan) | S |
| 3 | GH-794 | Verification + empirical token-cost note | S |

**Why grouped**: All three phases ship in a single PR because the flag and schema additions are inert until a caller surfaces them, and downstream skills cannot exploit high-res images until both are in place. Splitting would produce multiple releases of dormant machinery.

## Shared Constraints

Inherited verbatim from [parent epic plan](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md#shared-constraints):

### Architecture & file ownership

- The Execute -> Reflect -> Act pipeline is strict and schema-enforced. Any new inputs/outputs flow through the three YAML schemas in `plugin/ralph-playwright/schemas/`. Schema additions must be additive (new optional fields) unless explicitly noted.
- Hooks in `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` validate journey-trace, signal-report, and action-log YAMLs at Read and Write boundaries. Any schema change that tightens validation must update the hook in the same PR.
- Execute runs as a sub-agent (`explorer-agent` or `story-runner-agent`) with `model: sonnet`. Keep Sonnet for Execute. Reflect runs in the calling model's context — that is the sole tier where Opus 4.7 routing applies.
- Screenshots (PNG) and accessibility snapshots (`.md`) are captured at EVERY step. No feature may opt out of either capture.

### Cost & token envelope

- Default capture resolution stays at the playwright-cli current viewport default. Higher-resolution modes (up to 2576px, 3.75MP ceiling) are opt-in via `--high-res` or escalation rules, never defaults.
- Opus 4.7 is materially more expensive per screenshot than Sonnet at 1568px. Default routing must keep Sonnet on happy paths; Opus 4.7 is reserved for reflect.

### Artifact paths

- Session data: `.playwright-cli/<session>/` (journey-trace.yaml, signal-report.yaml, action-log.yaml, screenshots, snapshots).
- Promoted evidence: `thoughts/local/assets/<session>/`.

### Research anchoring

This plan cites parent research `thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md` §Part 3 Item 10 — "Higher screenshot resolution for critical steps."

### Feature-specific constraints (additive)

- **Flag name, default, and semantics.** `--high-res` is a boolean opt-in. Absence = current viewport default. Presence = raise capture toward Opus 4.7's 2576px / 3.75MP ceiling for that specific screenshot invocation only.
- **Resolution target when high-res is on.** Aim for the longest dimension ≤ 2576px and total pixel area ≤ 3.75MP. If the viewport is already wider than 2576px, clamp to 2576 on the long axis; if DPR scaling would push over 3.75MP, fall back to the next-lower DPR step. Exact bounding behavior is part of Phase 1.
- **Implementation preference: deviceScaleFactor over viewport size.** The flag scales pixel density at capture time rather than changing the viewport. This keeps the layout identical to the user's real viewport, which matters for layout, contrast, and chart reflect prompts that assume real-world rendering. Viewport-change semantics (different breakpoints) belong to `ux-audit`'s multi-viewport passes, not to `--high-res`.
- **No implicit upgrades.** This feature does NOT add any automatic "escalate on failure" logic. Automatic escalation is out of scope here — it's Feature C territory (#787) and should not be tangled with the opt-in flag.
- **Pair-with-model discipline.** High-res images consume dramatically more tokens. A caller requesting `--high-res` for a step that will be read by Sonnet-at-1568px wastes tokens with no benefit. The documentation in Phase 2 must steer callers to pair `--high-res` with Opus 4.7 reflect or with OCR-heavy manual inspection.

## Current State Analysis

Screenshots today are captured by four direct call sites using the same invocation shape:

- [plugin/ralph-playwright/skills/capture/SKILL.md:30](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/capture/SKILL.md#L30) — `playwright-cli -s=<session> screenshot --filename=".playwright-cli/<session>/00_page.png"`
- [plugin/ralph-playwright/skills/browser/SKILL.md:33](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/browser/SKILL.md#L33) — generic documentation of the screenshot command
- [plugin/ralph-playwright/agents/story-runner-agent.md:58](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/agents/story-runner-agent.md#L58) — structured E2E execution
- [plugin/ralph-playwright/agents/explorer-agent.md:51](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/agents/explorer-agent.md#L51) — freeform exploration

None of these call sites pass any size-related arg. The `ux-audit` skill is the only existing consumer that uses a size-related CLI-level flag (`playwright-cli --viewport 375x812 navigate ...`), setting a precedent for a top-level flag rather than a per-command flag — which is relevant to where we thread `--high-res`.

The journey-trace schema does not record the resolution of each screenshot. Today there is no way for reflect to know whether a given PNG was captured at 1024x768, 1920x1080, or 2576x1932 — the model just sees the pixels. That's fine when every caller uses the default but it becomes a diagnostic blind spot the moment some steps become high-res.

Downstream consumers that will benefit most:

- **reflect** ([skills/reflect/SKILL.md:22-30](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/reflect/SKILL.md#L22-L30)) — signal classification relies on actually seeing what's in the screenshot. At 1568px the model can detect a broken layout; at 2576px it can read a dense table or a receipt. Feature B (GH-786, structured audit prompt) extends this further but it lands independently.
- **a11y-scan** ([skills/a11y-scan/SKILL.md:39-41](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/a11y-scan/SKILL.md#L39-L41)) — already lists color contrast and alt-text checks as criteria but cannot satisfy them from the DOM alone. Features D (#788, contrast) and E (#789, alt relevance) will add the prompts; high-res is the precondition that makes them trustworthy.
- **explore** ([skills/explore/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/explore/SKILL.md)) — consumes reflect indirectly via step 2.
- **ux-audit** already has its own multi-viewport discipline; `--high-res` may occasionally be useful for the primary 1280px pass when chart or typography fidelity matters, but ux-audit already captures aggressively. Not a primary beneficiary.

`ralph-playwright` has no build/test matrix. Verification is pipeline-based: run a skill, read the artifacts, confirm the hook does not reject and the output looks right. `validate-primitive-io.sh` checks required fields; additive optional fields are safe.

## Desired End State

A caller explicitly opts into high-res capture for specific steps, the flag propagates through the CLI invocation, the resulting PNG is measurably larger and is readable by Opus 4.7, the journey-trace records which step was captured at what resolution, and the reflect/a11y-scan SKILL.md files document when to reach for it.

### Verification

- [ ] `playwright-cli` accepts `--high-res` (or an equivalent device-scale-factor override) without error — confirmed at the CLI level and documented.
- [ ] A capture run with `--high-res` produces a PNG whose longest dimension is meaningfully larger than the default (e.g., ≥ 2x the viewport width) and whose total pixel area is ≤ 3.75MP.
- [ ] `journey-trace.yaml` step entries record capture resolution when non-default, so reflect and audits can reason about it.
- [ ] `validate-primitive-io.sh` does not reject a journey-trace that includes the new optional `capture` sub-field.
- [ ] All four screenshot call sites (capture, browser, story-runner-agent, explorer-agent) document the flag's existence and when it should be passed, without changing default behavior.
- [ ] Downstream consumer SKILL.md files (reflect, a11y-scan) document what high-res buys them and what it does not.
- [ ] An empirical token-cost delta for one real session is recorded in a research note or an appendix to this plan.

## What We're NOT Doing

- **Changing default capture resolution.** Default stays at current playwright-cli behavior. `--high-res` is strictly opt-in.
- **Automatic high-res escalation on failure.** That is Feature C (#787) territory and must not be coupled to this flag. Callers who want to re-capture at high-res after a failure do so manually or via a skill they wrote on top of this primitive.
- **Changing the capture viewport.** Layout stays identical to what the user requested; this flag scales DPR, not breakpoints.
- **Introducing a new dependency** (no PIL, no Tesseract, no sharp — just the CLI already in use).
- **Changing the screenshot filename convention** (still `<index>_<slug>.png`). No `.hi.png` suffix; resolution lives in the trace, not the filename.
- **Annotating bounding boxes** — that's Feature F (#790).
- **Baseline comparison / regression detection** — that's Feature G (#791).
- **OCR tool integration.** Opus 4.7 reads the high-res image directly; no external OCR pipeline.
- **Touching visual-diff, storybook-test, story-gen, setup skills.** None of them compose through the core capture call path in a way that would benefit.

## Implementation Approach

Three phases. Phase 1 is the wiring; Phase 2 is documentation; Phase 3 is verification. All three land in one PR because the wiring is inert without the docs, and the docs are untrustworthy without verification.

**Phase dependency annotations:**
- Phase 1 `depends_on: null` — can start immediately.
- Phase 2 `depends_on: [phase-1]` — cannot document semantics until the exact flag spelling and schema shape are final.
- Phase 3 `depends_on: [phase-1, phase-2]` — verification runs against the final flag and final documentation; token-cost measurement benchmarks the end-to-end pipeline.

---

## Phase 1: Thread `--high-res` through capture call path + journey-trace

- **depends_on**: null

### Overview

Decide where `--high-res` lives (top-level CLI flag vs per-command flag), add it to the four call sites without changing default behavior, and extend `journey-trace.schema.yaml` with an optional `capture` sub-object on each step that records resolution and scale factor when non-default.

### Tasks

#### Task 1.1: Investigate playwright-cli capabilities for resolution override

- **files**: none modified; investigation only
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Confirmed which of the following `playwright-cli` surfaces the high-res knob: (a) a top-level `--device-scale-factor <N>` flag on the CLI (analogous to the existing `--viewport WxH` flag used in ux-audit), (b) per-command args on `screenshot`, (c) a session-level `open` option. Recommendation: (a) by analogy with `--viewport`, applied to the session via `open`.
  - [ ] Confirmed the flag's actual spelling in `@playwright/cli`. If no native flag exists, document the playwright-cli eval-based fallback: `playwright-cli -s=<session> eval "await page.setViewportSize({ width: W*2, height: H*2 })"` or similar.
  - [ ] Decided whether `--high-res` expands to a single fixed deviceScaleFactor (e.g. 2.0), a target longest-edge (e.g. 2576), or both with clamping logic. Recommendation: single alias `--high-res` maps to `--device-scale-factor 2` capped so longest edge ≤ 2576 and area ≤ 3.75MP.
  - [ ] Findings recorded as an appendix to this plan (or inline in Task 1.2).

#### Task 1.2: Update `browser/SKILL.md` with the canonical flag documentation

- **files**: `plugin/ralph-playwright/skills/browser/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] New section "High-resolution captures" added to `browser/SKILL.md` after the "Path Construction" section.
  - [ ] Documents the exact flag spelling (from Task 1.1) and shows a before/after example. Example target form: `playwright-cli --device-scale-factor 2 -s=<session> screenshot --filename=...` OR `playwright-cli --high-res -s=<session> screenshot --filename=...` (choose based on 1.1 findings).
  - [ ] Documents the 2576px / 3.75MP ceiling and what happens if the viewport × scale factor exceeds it (clamp behavior).
  - [ ] Documents the token-cost warning: "High-res screenshots consume ~3x more tokens than default viewport captures. Use only when the downstream reflect phase needs the precision (OCR of tables/receipts, dense chart labels, pixel-computed contrast)."
  - [ ] Adds a link to `skills/reflect/SKILL.md` and `skills/a11y-scan/SKILL.md` explaining what each skill does with high-res images.

#### Task 1.3: Extend `journey-trace.schema.yaml` with optional `capture` per-step metadata

- **files**: `plugin/ralph-playwright/schemas/journey-trace.schema.yaml` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Added optional `capture` object to each step under `properties.steps.items.properties`, with sub-fields:
    - `resolution`: `string` pattern `"^\\d+x\\d+$"` — the actual pixel dimensions of the PNG (e.g. `"2560x1440"`).
    - `device_scale_factor`: `number` minimum 1 — the DPR used for this screenshot.
    - `mode`: `string` enum `[default, high-res]` — caller-declared intent.
  - [ ] `capture` is NOT added to the `required` list — existing journey-traces remain valid.
  - [ ] Schema file's top comment updated to mention the new field.

#### Task 1.4: Update `validate-primitive-io.sh` to not reject journey-traces with the new field

- **files**: `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` (read; possibly no modification needed)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] Confirmed the hook's current implementation validates only required top-level fields and enumerated sub-fields it explicitly knows about (step outcomes, signal types, severities, action types). Additive optional step fields are accepted by current behavior.
  - [ ] If the hook logic turns out to be stricter than assumed, add explicit passthrough for `capture` sub-fields without rejecting unknown sub-keys.
  - [ ] A sample journey-trace with `capture: { resolution: "2560x1440", device_scale_factor: 2, mode: high-res }` on one step passes validation (smoke test in Phase 3).

#### Task 1.5: Update `explorer-agent.md` to support the `--high-res` opt-in

- **files**: `plugin/ralph-playwright/agents/explorer-agent.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.2, 1.3]
- **acceptance**:
  - [ ] Input section gains an optional `high_res_steps` input — a list of step indices or a predicate (e.g. "all steps on pages matching `/checkout`"). Default empty.
  - [ ] Recording section instructs the agent to populate `step.capture` with `{ resolution, device_scale_factor, mode }` whenever the step used `--high-res` (or the resolution is otherwise non-default).
  - [ ] The screenshot command snippet at line 51 is extended with an inline example showing the high-res variant, kept next to the default command.
  - [ ] The agent is explicitly warned NOT to default to high-res on every step; the input must opt in.

#### Task 1.6: Update `story-runner-agent.md` to support the `--high-res` opt-in

- **files**: `plugin/ralph-playwright/agents/story-runner-agent.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.2, 1.3]
- **acceptance**:
  - [ ] Input section acknowledges a new optional `high_res_steps` field in the user-story YAML or as an agent-level input. Default empty (no high-res).
  - [ ] Step-execution section records `step.capture` when a step used the flag.
  - [ ] Screenshot command snippet at line 58 gains a high-res variant next to the default.
  - [ ] "NEVER use CSS selectors" rule is untouched.

#### Task 1.7: Update `capture/SKILL.md` to accept a `high_res` input

- **files**: `plugin/ralph-playwright/skills/capture/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2, 1.3]
- **acceptance**:
  - [ ] The Input section gains `high_res: boolean` (default false) as a 4th optional input.
  - [ ] Step 1 "Execute" screenshot command at line 30 is shown in both default and high-res forms.
  - [ ] Step 1 "Execute" journey-trace snippet adds the `capture` sub-object when `high_res=true`.
  - [ ] The Summary section reports which mode was used.

#### Task 1.8: Optional: extend `user-story.schema.yaml` to permit per-step `high_res` intent

- **files**: `plugin/ralph-playwright/schemas/user-story.schema.yaml` (modify if feasible; read first)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] Read the current `user-story.schema.yaml` shape.
  - [ ] If it supports a structured `workflow` (list of steps), add optional `high_res: boolean` per step.
  - [ ] If workflow is free-text today, SKIP this task and document in the capture/browser SKILL.md that story-runner takes high-res intent via an agent-level arg instead.

### Phase Success Criteria

#### Automated Verification:
- [ ] `validate-primitive-io.sh` accepts a journey-trace with the new optional `capture` sub-object (smoke test in Phase 3).
- [ ] `validate-primitive-io.sh` still accepts journey-traces WITHOUT the `capture` sub-object (backward compat).

#### Manual Verification:
- [ ] Review each modified SKILL.md/agent.md for: correct flag spelling, correct example paths, no unintended change to default behavior.
- [ ] Review schema diff for additive-only change.

**Creates for next phase**: Canonical flag spelling, schema shape, and capture-side wiring. Phase 2 relies on the finalized flag name and schema to write accurate downstream documentation.

---

## Phase 2: Downstream consumer documentation (reflect, a11y-scan)

- **depends_on**: [phase-1]

### Overview

Teach the reflect and a11y-scan skills when `--high-res` helps their analysis, when it's wasted, and how to surface the capture metadata in signals. No prompt rewrites here (those are Features B, D, E); this phase is strictly about recognizing and benefiting from the existing flag.

### Tasks

#### Task 2.1: Update `reflect/SKILL.md` with a "Capture resolution" note

- **files**: `plugin/ralph-playwright/skills/reflect/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] A new subsection "Capture resolution" added under Step 2 (before Step 3 classification), placed at or near line 30.
  - [ ] Explains that `step.capture.mode` of `high-res` means the screenshot is suitable for: OCR of text in images, dense tabular data, fine chart annotations, receipts/forms with small type.
  - [ ] Explains that `high-res` screenshots SHOULD be reviewed carefully — the model is likely expected to produce observations that a default-res screenshot could not yield.
  - [ ] Explains the pairing rule: high-res + Sonnet-at-1568px is wasted. High-res pairs best with Opus 4.7 (once Feature A #785 routes it here).
  - [ ] No change to the existing four-sub-step visual review loop; this is an additive capture-awareness note.

#### Task 2.2: Update `a11y-scan/SKILL.md` with a high-res usage guidance block

- **files**: `plugin/ralph-playwright/skills/a11y-scan/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] A new subsection "When to request `--high-res` captures" added under Step 2 at or near line 41 (right after the criteria list).
  - [ ] Lists use cases: pixel-computed color contrast (pre-cursor to Feature D #788), alt-text relevance (pre-cursor to Feature E #789), small-type form labels, focus indicators that are thin/faint.
  - [ ] Notes that current a11y criteria — missing labels, broken tab order — do NOT benefit from high-res and should use the default.
  - [ ] Links back to `browser/SKILL.md` for the canonical flag syntax.

#### Task 2.3: Update `explore/SKILL.md` with a pointer to `--high-res`

- **files**: `plugin/ralph-playwright/skills/explore/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] A one-paragraph note added to Step 1 (Execute, freeform) at or near line 29 explaining: if the exploration goal involves OCR-style observation (reading tables, receipts, charts, dense UIs), pass `high_res_steps` to `explorer-agent` for the relevant steps.
  - [ ] Warns that explore already captures more screenshots than most skills, so blanket high-res would multiply token cost; prefer step-specific opt-in.

#### Task 2.4: Decide what `ux-audit` does with `--high-res`

- **files**: `plugin/ralph-playwright/skills/ux-audit/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Decision recorded in the SKILL.md: either (a) the 1280px primary pass can optionally run with `--high-res` for typography/chart fidelity, or (b) ux-audit explicitly stays at default resolution because it already does multi-viewport captures. Recommendation: (b) — add a one-line note under Step 2a explaining that ux-audit prefers breadth (multi-viewport) over depth (high-res) and that callers who need both should run a follow-up `capture --high-res` on specific URLs.

#### Task 2.5: Update `test-e2e/SKILL.md` to surface high-res on failed steps

- **files**: `plugin/ralph-playwright/skills/test-e2e/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] A one-paragraph note added near Step 2 (Execute) explaining that story YAML files MAY declare `high_res_steps` for critical assertion steps (e.g., "verify the subtotal on the receipt is $42.17"); default remains off.
  - [ ] Explicitly notes this feature does NOT auto-recapture failed steps at high-res — that's Feature C (#787).

### Phase Success Criteria

#### Automated Verification:
- [ ] No automated checks — documentation changes only. Markdown renders cleanly (visual review).

#### Manual Verification:
- [ ] Read each of the five modified SKILL.md files top-to-bottom and confirm the `--high-res` references are consistent with the Phase 1 flag spelling.
- [ ] Confirm no SKILL.md file recommends `--high-res` as the default.

**Creates for next phase**: Nothing material — Phase 3 verifies the end-to-end story from this documentation.

---

## Phase 3: Verification + empirical token-cost note

- **depends_on**: [phase-1, phase-2]

### Overview

Run a real capture session with and without the flag, confirm dimensions, confirm schema validation, and record the token-cost delta empirically so future callers can make informed decisions. This phase produces a short research note (not a separate research doc — just an appendix section added to this plan or a linked note under `thoughts/local/`).

### Tasks

#### Task 3.1: Run a default-resolution capture against a real page

- **files**: none (produces `.playwright-cli/<session>/` artifacts only)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `playwright-cli` capture session run against a page with known dense content (recommendation: an internal Storybook page with a dense table, or a fixture HTML with a receipt-like layout; fall back to any public site with a dense data table).
  - [ ] Produces `.playwright-cli/<session>/00_page.png` at default viewport resolution.
  - [ ] PNG dimensions recorded (e.g., `file <path>` output or a one-liner with `identify` / `sips`).

#### Task 3.2: Run a high-res capture against the same page

- **files**: none (produces `.playwright-cli/<session>/` artifacts only)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] Same page re-captured with `--high-res` (or equivalent from Phase 1).
  - [ ] PNG dimensions meaningfully larger: longest dimension ≥ 2x default, total area ≤ 3.75MP.
  - [ ] Journey-trace shows the `capture` sub-object with `mode: high-res` and the actual resolution.
  - [ ] `validate-primitive-io.sh` does not reject the journey-trace.
  - [ ] The two PNGs look visually identical at the original viewport — no unintended layout changes (confirming the DPR-scaling-not-viewport-changing strategy).

#### Task 3.3: Measure empirical token cost for Opus 4.7 reading both PNGs

- **files**: `thoughts/shared/plans/2026-04-20-GH-0794-ralph-playwright-high-res-screenshot-flag.md` (modify — append appendix)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.1, 3.2]
- **acceptance**:
  - [ ] A minimal reflect prompt ("describe the content of this screenshot in one paragraph") is sent to Opus 4.7 with each PNG.
  - [ ] Token counts for input images recorded (from API usage metadata or Anthropic's published token-cost formula for images).
  - [ ] The delta (high-res tokens / default tokens) is recorded along with dollar-cost estimates at current Opus 4.7 pricing.
  - [ ] A one-paragraph qualitative assessment is recorded: "Did high-res enable any observation that default-res missed?" For a dense-table fixture, expected answer is yes for specific cell values.
  - [ ] This appendix includes the raw number the parent epic needs to inform defaults (epic plan §Cost & token envelope).

#### Task 3.4: Smoke-test each downstream consumer against the high-res capture

- **files**: none (produces signal-report.yaml artifacts)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.2]
- **acceptance**:
  - [ ] `reflect` skill run against the high-res journey-trace. Resulting signal-report has at least one signal whose description references fine-grained detail (e.g., specific cell value, small typography) that would have been invisible at default resolution.
  - [ ] `a11y-scan` skill run against the same page with `--high-res` selectively applied. Confirmed that a11y-scan accepts the high-res screenshots without error (even though current a11y prompts don't exploit the extra pixels — Feature D/E will).
  - [ ] `validate-primitive-io.sh` does not reject any produced artifact.

### Phase Success Criteria

#### Automated Verification:
- [ ] `validate-primitive-io.sh` accepts all journey-trace and signal-report artifacts produced in this phase.
- [ ] Image dimensions confirmed via CLI (`sips -g pixelWidth -g pixelHeight <path>` on macOS, or `file <path>`).

#### Manual Verification:
- [ ] Visual inspection of default-res vs high-res PNG confirms same layout, higher pixel density.
- [ ] Reflect signal-report on high-res shows observations unavailable in default-res.
- [ ] Token-cost appendix recorded in this plan document.

**Creates for next phase**: None (final phase).

---

## Integration Testing

- [ ] End-to-end: fresh capture run via `/ralph-playwright:capture <url> --high-res` produces a PNG of the expected size, records `capture.mode=high-res` in the trace, passes schema validation, and is reflected by Opus 4.7 with observations that default-res would not have yielded.
- [ ] End-to-end: fresh `test-e2e` run on a story YAML declaring `high_res_steps: [2]` applies high-res only to step 2; step 0, 1, 3+ stay at default resolution; trace records the mix correctly.
- [ ] Cross-feature readiness check: Feature D (#788, contrast) and Feature E (#789, alt relevance) plans cite this one as a precondition for their pixel-computed prompts.

## Cost / benefit summary

**Benefit**: Unlocks use cases that are currently impossible in the reflect pipeline — OCR of table cells, receipt verification, chart-label reading, pixel-computed color contrast. These are the exact use cases that justify Opus 4.7 over Sonnet; without higher resolution, routing Opus 4.7 to reflect buys less than it could.

**Cost**: Image tokens scale with pixel count. Moving from ~1.15MP to ~3.75MP is a ~3.25x increase in image-token input for that screenshot. On a 20-step journey with all steps high-res, that is materially expensive on Opus 4.7. This is why the feature is opt-in and paired with explicit guidance to target specific steps, not whole journeys.

**Envelope**: Default journey token cost is unchanged. `--high-res` is surgical. The primary intended caller pattern is "default everywhere except these 2-3 critical verification steps."

## References

- Parent epic issue: https://github.com/cdubiel08/ralph-hero/issues/784
- This issue: https://github.com/cdubiel08/ralph-hero/issues/794
- Research: [thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md) §Part 3 Item 10
- Epic plan-of-plans: [thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md)
- Anthropic Opus 4.7 docs: https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7
