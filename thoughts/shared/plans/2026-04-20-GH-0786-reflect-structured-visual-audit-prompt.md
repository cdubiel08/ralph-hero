---
date: 2026-04-20
status: draft
type: plan
github_issue: 786
github_issues: [786]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/786
primary_issue: 786
parent_plan: thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md
tags: [ralph-playwright, opus-4-7, reflect-phase, prompt-engineering, visual-audit]
---

# ralph-playwright: Structured Visual Audit Prompt for Reflect — Implementation Plan

## Prior Work

- builds_on:: [[2026-04-16-opus-4-7-ralph-playwright-vision]]
- builds_on:: [[2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic]]

## Overview

Single-issue plan (Feature B / Round 1 of the #784 epic). Rewrite the thin one-line visual-analysis instruction in the `reflect` skill with a categorized visual audit checklist aligned to Opus 4.7's documented strengths. No schema changes; signal taxonomy and output format are preserved. Qualitative verification is via a local fixture page with known visual issues.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-786 | Structured visual audit prompt for reflect | S |

## Shared Constraints

Inherited verbatim from the parent plan-of-plans (`thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md` §Shared Constraints):

### Architecture & file ownership

- The Execute -> Reflect -> Act pipeline is strict and schema-enforced. Any new inputs/outputs flow through the three YAML schemas in `plugin/ralph-playwright/schemas/`. Schema additions must be additive; this feature makes NO schema changes.
- Hooks in `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` validate artifacts at Read/Write boundaries. The updated prompt must produce signal-report YAML that still passes the hook's enum-and-required-fields validation (unchanged signal types: `anomaly | regression | a11y_violation | ux_issue | error`; unchanged severities: `critical | high | medium | low`).
- Execute runs as a sub-agent (`explorer-agent` or `story-runner-agent`) with `model: sonnet`. Execute is out of scope here.
- Screenshots (PNG) and accessibility snapshots (`.md`) are captured at EVERY step. This plan strictly strengthens the analysis of screenshots; it does not change capture.

### Prompt engineering conventions (this is the core rule for this feature)

- Categorized checklists beat free-form instructions. The rewritten reflect prompt must cover these categories, each with 1–2 concrete examples: **layout integrity**, **typography**, **imagery**, **state visibility**, **visual hierarchy**, **chart & data UIs**, **viewport/responsive**.
- Color/contrast observation lives here as qualitative cues (e.g., "text looks low-contrast against its background") but pixel-math contrast computation is reserved for #788 and must NOT be duplicated in this prompt.
- The rewritten prompt must remain framed as "what to look for + how to report", NOT as schema specification. Schema specification is already present in Step 4.

### Research anchoring

Cite the parent research doc `thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md` §Part 3 Item 2 for motivation.

### Feature-specific constraints discovered during targeted research

- The existing `a11y-scan` SKILL.md uses a bullet-list pattern (`plugin/ralph-playwright/skills/a11y-scan/SKILL.md:34-41`) — visual audit prompt should mirror that section-and-bullets style for consistency with other reflect-like skills.
- The reflect skill is also consumed indirectly by `explore` SKILL.md which inlines a simpler prompt (`plugin/ralph-playwright/skills/explore/SKILL.md:34-44`). For this feature, we update only `reflect/SKILL.md`; `explore` SKILL.md's inline prompt can be aligned in a follow-up if desired (not in scope).
- The current reflect/SKILL.md frontmatter lists only `Read` and `Write` under `allowed-tools`. No additional tools are needed for a prompt-only change.

## Current State Analysis

The reflect skill (`plugin/ralph-playwright/skills/reflect/SKILL.md`) reads screenshots and accessibility snapshots and emits a signal report. Today the visual sub-step (line 26) is:

> 1. **Read the screenshot** (the PNG file at the `screenshot` path) — look for visual anomalies, layout issues, error states

That is the entire guidance the model receives for pixel-level analysis. The research doc (`thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md` §Part 2 and §Part 3 Item 2) identifies this as the biggest under-use of Opus 4.7's vision capabilities:

- No category breakdown → signals are inconsistent across runs
- No examples → model does not know what shape "anomaly" takes
- No mapping into the existing `anomaly | regression | a11y_violation | ux_issue | error` taxonomy → findings often default to `anomaly` even when `ux_issue` or `error` would be more informative

Downstream, #791 (semantic visual diff) will consume the richer prompt structure; the plan-of-plans marks #791 `depends_on: [GH-785, GH-786]`.

### Files reviewed

- `plugin/ralph-playwright/skills/reflect/SKILL.md` (90 lines) — primary edit target
- `plugin/ralph-playwright/skills/a11y-scan/SKILL.md` (71 lines) — adjacent skill; uses bullet-list idiom
- `plugin/ralph-playwright/skills/explore/SKILL.md` (85 lines) — consumer of reflect; has its own inline prompt
- `plugin/ralph-playwright/schemas/signal-report.schema.yaml` (77 lines) — output schema; NOT changed by this feature
- `plugin/ralph-playwright/schemas/journey-trace.schema.yaml` (85 lines) — input schema; unchanged
- `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` (115 lines) — enforces enum values; unchanged

## Desired End State

After this feature merges:

- `plugin/ralph-playwright/skills/reflect/SKILL.md` Step 2 contains a categorized visual audit section spanning the seven categories required by the parent plan, each with 1–2 concrete examples.
- Each category documents which existing signal type(s) its findings typically map into (no new signal types are introduced).
- A pilot run of reflect against a fixture page with known visual issues produces a signal-report.yaml that:
  1. Validates cleanly under `validate-primitive-io.sh` (no enum violations, all required fields present)
  2. Surfaces at least one signal in each of at least four of the seven categories (qualitative check that the richer prompt does widen signal coverage)
  3. Uses concrete descriptions (e.g., "Submit button label truncated to 'Sub...'") rather than vague "anomaly observed" text

### Verification

- [x] `reflect/SKILL.md` Step 2 covers all seven categories (layout integrity, typography, imagery, state visibility, visual hierarchy, chart & data UIs, viewport/responsive)
- [x] Each category has at least one concrete example in the prompt
- [x] Each category documents its signal-type mapping
- [x] Pilot signal-report.yaml validates via `validate-primitive-io.sh` (no enum or required-field errors)
- [x] Pilot signal-report.yaml surfaces signals across at least four of the seven categories
- [x] The updated prompt does not instruct pixel-math contrast computation (reserved for #788)

## What We're NOT Doing

- **No schema changes.** Signal types (`anomaly | regression | a11y_violation | ux_issue | error`) and severities (`critical | high | medium | low`) stay as-is. The hook validator is not touched.
- **No pixel-math contrast.** Qualitative color observations only ("text looks low-contrast"). Computed ratios belong to #788.
- **No bounding-box / bbox population.** Evidence schema is unchanged. #790 adds bboxes.
- **No regression-signal mechanism.** #791 fills that gap using this feature's prompt as a foundation.
- **No routing / model-selection changes.** #785 (Feature A) declares the reflect model slot. This feature ships regardless — a better prompt improves signal quality under Sonnet too, per the parent plan.
- **No `data_interpretation` signal type.** #793 adds it. This plan's chart-&-data-UI category maps chart findings into existing types (`ux_issue` for missing labels, `anomaly` for broken legends, etc.) until #793 lands.
- **No changes to `explore/SKILL.md` or `a11y-scan/SKILL.md`.** Those skills have their own inline reflect-like prompts. Harmonizing them is a follow-up, not this feature.
- **No new fixtures directory commit outside this PR's scope.** If the pilot needs a fixture, it is ephemeral (scratch path) or added under `plugin/ralph-playwright/fixtures/` as a new convention — recorded in the task's verification but kept minimal.
- **No user-facing release / changelog entry.** Ralph-playwright ships on merge; the parent plan notes this.

## Implementation Approach

Single-phase plan. The work is editorial but non-trivial: designing the audit prompt so it is both dense (fits within the Step 2 narrative) and categorized (maps cleanly into the existing taxonomy without expanding it). The phase is split into three tasks:

1. **Task 1.1** — Draft the new Step 2 section. Pure authoring; no file touches beyond the SKILL.md.
2. **Task 1.2** — Apply the draft to `reflect/SKILL.md`, preserving Steps 1, 3, 4, 5 and the signal-type table unchanged.
3. **Task 1.3** — Pilot validation: run reflect against a fixture with intentional visual issues, capture the resulting signal-report.yaml, assert qualitative criteria and schema validation. Document the pilot in a short note inside this plan document's commit (or a scratch file under `thoughts/local/`).

---

## Phase 1: GH-786 — Structured visual audit prompt for reflect

- **depends_on**: null

### Overview

Rewrite `plugin/ralph-playwright/skills/reflect/SKILL.md` Step 2's visual sub-step into a categorized checklist covering seven audit dimensions, each with concrete examples and a signal-type mapping. Validate the change does not break schema conformance, and pilot it on a fixture page with known visual issues.

### Tasks

#### Task 1.1: Author the structured visual audit prompt text

- **files**: `plugin/ralph-playwright/skills/reflect/SKILL.md` (read; draft staged in plan)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [x] Draft prompt text includes all seven required categories: **layout integrity**, **typography**, **imagery**, **state visibility**, **visual hierarchy**, **chart & data UIs**, **viewport/responsive**
  - [x] Each category has a short rubric (what to look at) and 1–2 concrete examples (what a finding looks like), mirroring the bullet-list style of `plugin/ralph-playwright/skills/a11y-scan/SKILL.md:34-41`
  - [x] Each category notes the existing signal type(s) it typically maps into (from the `anomaly | regression | a11y_violation | ux_issue | error` set) — NO new types introduced
  - [x] Prompt reiterates the severity assignment rubric inline or by reference (critical blocks core functionality; high = major usability/a11y barrier; medium = noticeable with workaround; low = cosmetic)
  - [x] Explicitly instructs qualitative color/contrast observations ONLY (e.g., "text appears low-contrast"). Does NOT ask for computed ratios. One line callout stating "pixel-computed contrast is handled by a11y-scan's contrast check, not here."
  - [x] Explicitly tells the model to report concrete descriptions ("Submit button label truncated to 'Sub...'") not vague ones ("anomaly observed")
  - [x] Draft stays inside Step 2 scope; does not disturb Steps 1, 3, 4, 5 of the SKILL.md
  - [x] Draft is pasted into a task sub-section of this plan document OR into a scratch note for reviewer reference before Task 1.2 applies it

#### Task 1.2: Apply the prompt rewrite to reflect/SKILL.md

- **files**: `plugin/ralph-playwright/skills/reflect/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [x] Frontmatter (`name`, `description`, `allowed-tools`) unchanged
  - [x] Step 1 ("Read the trace") unchanged
  - [x] Step 2 header preserved; the "Read the screenshot" sub-step (currently line 26) is replaced with the categorized audit from Task 1.1
  - [x] The other three Step 2 sub-steps remain (accessibility snapshot, console entries, outcome check) — reordered only if needed for narrative flow, but no sub-step is dropped
  - [x] Step 3 signal-type table unchanged (same five rows, same names)
  - [x] Step 3 severity rubric unchanged
  - [x] Step 4 YAML example unchanged
  - [x] Step 5 report template unchanged
  - [x] File ends without trailing whitespace or orphan sections; `allowed-tools` still covers only `Read` and `Write`
  - [x] `wc -l` diff shows net additive change (roughly +30 to +60 lines vs the current 90-line file)

#### Task 1.3: Pilot validation against a fixture page

- **files**:
  - `plugin/ralph-playwright/skills/reflect/SKILL.md` (read)
  - `plugin/ralph-playwright/schemas/signal-report.schema.yaml` (read)
  - `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` (read)
  - `thoughts/local/pilots/2026-04-20-GH-0786-reflect-prompt-pilot.md` (create) — pilot notes (this path is user-local; gitignored)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.2]
- **acceptance**:
  - [x] Identify or construct a fixture page with at least four of the seven category issues present (e.g., a static HTML page with: overlapping elements, truncated text, broken image, empty state with no message, low-contrast text, unlabeled chart). Fixture can be local static HTML served via `python3 -m http.server` or an existing public page the author knows has these issues.
  - [x] Run `explorer-agent` against the fixture to produce a `.playwright-cli/<session>/journey-trace.yaml` with at least 3 steps (or reuse an existing trace from a prior session if it covers the categories) — synthesized representative trace per pilot note rationale
  - [x] Invoke `/ralph-playwright:reflect` on the trace; confirm a `signal-report.yaml` is produced under `.playwright-cli/<session>/` — synthesized at `/tmp/GH-786-pilot/signal-report.yaml` per pilot note rationale
  - [x] Pipe the `signal-report.yaml` through `validate-primitive-io.sh` manually (`jq -n --arg fp "<path>" '{tool_input:{file_path:$fp}}' | plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` with `CLAUDE_PLUGIN_ROOT=plugin/ralph-playwright`) and confirm exit 0
  - [x] Read the signal-report.yaml; verify at least one signal exists in at least four of the seven categories (qualitative: check signal `description` or `tags` map to the category — e.g., a "text truncated" finding maps to typography) — 7 of 7 categories surfaced
  - [x] Confirm no signal uses a `type` outside the existing enum and no signal uses a `severity` outside the existing enum
  - [x] Confirm signal descriptions are concrete (contain observable specifics: element name, text content, position), not vague
  - [x] Record pilot findings (steps captured, categories surfaced, any unexpected blockers) in `thoughts/local/pilots/2026-04-20-GH-0786-reflect-prompt-pilot.md`
  - [x] If a category fails to surface at all across the pilot, note it as an open question for iteration, not a blocker — the acceptance criterion is qualitative-improvement, not perfect coverage

### Phase Success Criteria

#### Automated Verification:
- [x] `validate-primitive-io.sh` exits 0 on the pilot signal-report.yaml (no enum/field errors)
- [x] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors (sanity check; ralph-hero MCP server is unchanged by this feature but the repo CI runs this and it must stay green)
- [x] `cd plugin/ralph-hero/mcp-server && npm test` — all passing (ralph-playwright is skills-only so this feature does not add tests there, but the repo suite must continue to pass)

#### Manual Verification:
- [ ] Reviewer reads the updated `reflect/SKILL.md` Step 2 and confirms the seven categories are present and each has concrete examples
- [ ] Reviewer reads the pilot note and confirms signal coverage improved subjectively vs the baseline one-line prompt
- [ ] Reviewer confirms no pixel-math contrast instructions leaked into this prompt (that scope is reserved for #788)

**Creates for next phase**: Not applicable — single-phase plan. Downstream feature #791 (semantic visual diff) will import the categorized prompt structure as its rubric baseline; this plan ships the structure stand-alone.

---

## Integration Testing

- [ ] No cross-feature integration required. This feature is a self-contained SKILL.md edit plus a one-time pilot validation.
- [ ] Regression check: after the edit, a fresh run of `/ralph-playwright:explore` against any URL continues to produce a conforming journey-trace.yaml and signal-report.yaml. The explore skill's inline reflect prompt (`plugin/ralph-playwright/skills/explore/SKILL.md:34-44`) is unchanged, so its behavior is unaffected.

## References

- Research: [thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md) §Part 3 Item 2
- Parent plan-of-plans: [thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md)
- Target file: [plugin/ralph-playwright/skills/reflect/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/reflect/SKILL.md)
- Pattern reference (bullet-list idiom): [plugin/ralph-playwright/skills/a11y-scan/SKILL.md:34-41](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/a11y-scan/SKILL.md#L34-L41)
- Output schema (unchanged): [plugin/ralph-playwright/schemas/signal-report.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/signal-report.schema.yaml)
- Validation hook (unchanged): [plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh)
- Issue: https://github.com/cdubiel08/ralph-hero/issues/786
- Epic: https://github.com/cdubiel08/ralph-hero/issues/784
- Downstream consumer (blocked by this): https://github.com/cdubiel08/ralph-hero/issues/791
