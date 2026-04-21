---
date: 2026-04-20
status: draft
type: plan
github_issue: 796
github_issues: [796, 819, 821, 822, 823, 824]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/796
  - https://github.com/cdubiel08/ralph-hero/issues/819
  - https://github.com/cdubiel08/ralph-hero/issues/821
  - https://github.com/cdubiel08/ralph-hero/issues/822
  - https://github.com/cdubiel08/ralph-hero/issues/823
  - https://github.com/cdubiel08/ralph-hero/issues/824
primary_issue: 796
parent_plan: thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md
tags: [ralph-playwright, opus-4-7, story-gen, sad-paths, vision, prompt-engineering]
---

# ralph-playwright: Sad-Path Inference from Screenshots in story-gen — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-16-opus-4-7-ralph-playwright-vision]]
- builds_on:: [[2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic]]

## Overview

Feature L / Round 1 of the #784 epic. Today, `plugin/ralph-playwright/skills/story-gen/SKILL.md:44-52` uses eight hardcoded sad-path heuristics (required-field-empty, wrong-credentials, etc.) that fire regardless of whether the target UI actually exhibits those failure modes. With Opus 4.7's pixel-level perception, we can *look at* the rendered UI and infer sad paths grounded in visible state — a form without a visible error container, a list that never defines an empty state, a tooltip that clips at the viewport edge, a submit button next to fields with no validation hints.

This plan coordinates 5 pre-split atomics into a single feature PR: a new prompt fragment (#819), a structured output schema extension (#821), pipeline wiring in `story-gen` (#822), an auto-feed path that reuses `explorer-agent` screenshots when `story-gen` runs in URL mode (#823), and a fixture-based test harness (#824). All changes are additive to the existing heuristic pipeline — vision-inferred sad paths are emitted *alongside* the hardcoded eight, tagged with `source: vision` vs `source: heuristic`, and the user reviews/prunes before the final stories YAML is written.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-819 | Design vision-grounded sad-path inference prompt for story-gen | S |
| 2 | GH-821 | Output schema for vision-inferred sad paths in story-gen | XS |
| 3 | GH-822 | Wire vision sad-path generation into story-gen pipeline | S |
| 4 | GH-823 | Feed explorer-agent screenshots into vision sad-path inference (URL mode) | S |
| 5 | GH-824 | Test coverage for vision sad-path inference on representative screenshots | S |

**Dependency graph**: {Phase 1, Phase 2} -> Phase 3 -> {Phase 4, Phase 5}. Phases 1 and 2 are independent (prompt design is schema-unaware in v1; schema is prompt-unaware) and can be dispatched in parallel. Phase 3 merges them into the runtime. Phases 4 and 5 are independent consumers of Phase 3 — URL-mode integration (4) and test coverage (5) can land in parallel once the pipeline lights up.

**Why grouped**: All five atomics touch a single skill (`story-gen`) and depend on a single pair of new artifacts (the prompt fragment + schema shape). Splitting them across PRs would force three separate merges of a partially-functional feature; grouping lets us ship one coherent change with prompt + schema + wiring + URL-mode + tests.

## Shared Constraints

Inherited verbatim from the parent plan-of-plans (`thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md` §Shared Constraints), then extended with feature-specific constraints discovered during targeted research.

### Architecture & file ownership

- The Execute -> Reflect -> Act pipeline is strict and schema-enforced. Any new inputs/outputs flow through the three YAML schemas in `plugin/ralph-playwright/schemas/`: `journey-trace.schema.yaml`, `signal-report.schema.yaml`, `action-log.schema.yaml`. Schema additions must be additive (new optional fields). This feature touches the **user-story schema** (not one of the three primitive schemas) but must still keep changes additive so the existing `schemas/example-auth.yaml` continues to parse.
- Hooks in `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` validate journey-trace, signal-report, and action-log YAMLs at Read and Write boundaries. The user-story schema is NOT currently hook-validated (the hook only patterns-matches the three primitive artifacts). This plan does not add hook validation for user-story.yaml; it remains convention-enforced via example parity and the story-gen SKILL.md spec.
- Execute runs as a sub-agent (`explorer-agent` or `story-runner-agent`) with `model: sonnet`. No Execute-phase change in this feature. Vision sad-path inference runs in the **calling model's context** (story-gen is invoked by a user-facing agent) — this is the sole tier where Opus 4.7 perception applies.
- Screenshots (PNG) and accessibility snapshots (`.md`) are captured at EVERY step. When story-gen runs in URL mode (Step 0), the existing `explorer-agent` already produces screenshots at every step — this feature reuses them, it does not add new capture paths.
- The "NEVER use CSS selectors" rule in `plugin/ralph-playwright/agents/story-runner-agent.md:50` stays in force — unrelated to this feature (story-gen emits workflows, it does not execute them).

### Model routing discipline

- Vision sad-path inference is inherently an Opus-4.7-class capability (pixel-level perception, bbox reasoning). The prompt must be written assuming Opus 4.7 is the caller. No env-var override is introduced here; model selection is governed by how story-gen is invoked.
- No per-step model annotation is required for this feature — story-gen is not part of the Execute -> Reflect -> Act loop that #787 annotates. The inference is invoked once (not per-step) as a single model call with a screenshot set.

### Cost & token envelope

- Default capture resolution stays at the playwright-cli current viewport default. This feature does NOT opt into `--high-res` (that is #794's surface). If sad-path inference quality suffers on dense UIs, the user can manually escalate via #794's flag once it lands, but this plan does not depend on or require it.
- Opus 4.7 is materially more expensive per screenshot than Sonnet. To keep cost bounded in URL mode (Phase 4), apply a filtering heuristic on the journey-trace steps before passing screenshots to the vision prompt (documented in Phase 4). Do not pass all 20 explorer-agent steps to the vision call.

### Prompt engineering conventions

- Categorized checklists beat free-form instructions. The vision sad-path prompt (Phase 1) must cover **exactly four detection categories** named in the parent issue acceptance criteria:
  1. Missing error handlers (empty form submits, broken actions with no error UI)
  2. Un-designed empty states (lists/tables/containers with no empty-state UI rendered)
  3. Tooltip / popover viewport overflow (truncation at viewport edges)
  4. Form fields without visible validation hints (no asterisk, no helper text, no inline feedback)
- Each finding must ground in visual location (bbox or element description) and a one-sentence rationale. Free-form prose is not acceptable output.
- Prompt must request structured output aligned to the Phase 2 schema — not prose that downstream code would then parse regex-style.
- A short rubric / worked example must be included in the prompt so the model's first output is calibrated.

### Artifact paths

- Generated stories: `playwright-stories/<feature-kebab-name>.yaml` (existing convention, unchanged).
- Screenshot inputs (URL mode): `.playwright-cli/<session>/*.png` (existing explorer-agent output, unchanged).
- Screenshot inputs (manual mode): any user-supplied path; the prompt must tolerate both absolute and repo-relative paths.
- Test fixtures: `plugin/ralph-playwright/skills/story-gen/fixtures/` (new directory created by this feature). Three PNG fixtures + one tiny test harness. Does not collide with any existing convention in the plugin (no other skill currently ships fixtures).
- Inferred-sad-path intermediate buffer (between generation and user review): ephemeral, held in conversation / skill context. Not persisted to disk as a separate file. The final pruned set lands directly in the stories YAML.

### Verification tooling

Ralph-playwright is skills/agents-only — there is no build/test matrix for the plugin itself. Each phase specifies its own verification:

- **Phase 1** (prompt design): prompt text is readable by a skill loader (no syntactic breakage in SKILL.md); a dry-read test against one fixture yields well-structured output (qualitative, not scored).
- **Phase 2** (schema): the extended schema must still validate `schemas/example-auth.yaml` unchanged; a new example file demonstrates a vision-inferred entry.
- **Phase 3** (pipeline wiring): end-to-end dry-run on one fixture set confirms heuristic + vision sad paths both appear, user-review gate triggers, dropped entries are not in output.
- **Phase 4** (URL mode): end-to-end dry-run against a live or saved journey trace confirms auto-pickup of screenshots; zero-screenshot fallback logs cleanly without erroring.
- **Phase 5** (test coverage): 2-3 fixture screenshots plus a runnable test script; each fixture asserts at least one detection category; malformed output fails the test.
- **Repo-level CI** (`cd plugin/ralph-hero/mcp-server && npm run build && npm test`): must stay green. This feature does not touch MCP server source, so it should pass trivially — but it is a gate on the commit.

### Research anchoring

All five atomics cite the parent research doc `thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md` §Part 3 Item 12 for motivation. The plan-of-plans epic (`2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md` §Feature L) identifies this feature as depends_on: null — independent of all other epic features, touches only story-gen.

### Feature-specific constraints discovered during targeted research

- The current story-gen SKILL.md declares `allowed-tools: Bash(playwright-cli *), Agent, Read, Write`. The Read tool is what lets it consume screenshots (PNG files) — no new tool grant is needed for vision inference to work. Do NOT add anything to `allowed-tools` unless Phase 4 explicitly needs a new capability (it does not — reading journey-trace.yaml and the referenced PNGs uses Read already).
- The existing heuristic sad paths are enumerated in both `story-gen/SKILL.md:46-52` and in a comment block in `schemas/user-story.schema.yaml:16-25`. These two lists must stay in sync. Phase 3 updates SKILL.md; Phase 2 updates the schema comment block. No runtime code reads these lists — they are instruction text for the model and documentation for humans.
- The plugin has no existing `fixtures/` directory anywhere under `plugin/ralph-playwright/`. Phase 5 creates the convention. Place fixtures under `plugin/ralph-playwright/skills/story-gen/fixtures/` (skill-scoped) rather than plugin-scoped `plugin/ralph-playwright/fixtures/`, because the fixtures are story-gen-specific. The plan-of-plans §Integration Strategy mentions a future plugin-level `plugin/ralph-playwright/fixtures/` directory for cross-feature fixtures; this feature's skill-scoped fixtures can be moved there later without breaking anything.
- `explorer-agent` is not modified by this feature — confirmed by #823's out-of-scope list. Integration happens entirely on the story-gen side by reading the journey-trace.yaml the agent already writes.
- `journey-trace.schema.yaml` is NOT modified by this feature. The `steps[].screenshot` field is already required and sufficient. Filtering happens at read time in story-gen, not at capture time.
- The user-story schema (`plugin/ralph-playwright/schemas/user-story.schema.yaml`) is YAML-commented prose rather than a strict JSON Schema. Extending it means adding comment blocks and field documentation, not a `required:` list update. Keep this tone consistent in Phase 2.

## Current State Analysis

`skills/story-gen/SKILL.md:44-52` implements sad-path generation as a static list of eight heuristics. Every generated stories YAML applies the same eight patterns regardless of whether the target UI actually exhibits those failure modes. This produces two failure patterns in practice:

1. **False positives**: heuristics fire for features that cannot structurally exhibit them. A read-only detail page receives a "Duplicate/already-exists submission" sad path that has no meaningful workflow.
2. **False negatives**: heuristics miss UI-specific failures that are visible in a screenshot. A form page with no error container never gets a "when validation fails, where does the error appear?" sad path — because the existing heuristics ask about field-level validation, not about the missing error-surfacing affordance.

The research doc (`thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md` §Part 3 Item 12) identifies this as a concrete Opus-4.7 upgrade target: "With 4.7, optionally inspect the actual UI and propose sad paths grounded in what's visible — missing error handlers, empty states not designed, tooltips cut off at viewport edge, form fields without visible validation hints."

### Files reviewed

- `plugin/ralph-playwright/skills/story-gen/SKILL.md` (70 lines) — primary edit target (Phase 1 + Phase 3 + Phase 4)
- `plugin/ralph-playwright/schemas/user-story.schema.yaml` (25 lines) — extended by Phase 2
- `plugin/ralph-playwright/schemas/example-auth.yaml` (62 lines) — parity reference; must still parse under Phase 2's extended schema
- `plugin/ralph-playwright/schemas/journey-trace.schema.yaml` (85 lines) — read-only reference for Phase 4 to know the `steps[].screenshot` field path
- `plugin/ralph-playwright/agents/explorer-agent.md` (104 lines) — read-only reference; producer of the journey trace that Phase 4 consumes. NOT modified.
- `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` (115 lines) — does not cover user-story YAMLs today; not updated.
- `plugin/ralph-playwright/skills/explore/SKILL.md:70-73` — shows an existing story-gen hook point ("Optionally generate user stories from discovered flows"). Noted but not touched — explore is a separate entry path; story-gen's own Step 0 is the one that runs explorer-agent.

### How the five atomics compose

- **Phase 1 / #819** creates `plugin/ralph-playwright/skills/story-gen/prompts/sad-path-vision.md` (new file) containing the categorized vision prompt, a structured output instruction, a worked example, and references to the four detection categories.
- **Phase 2 / #821** extends `plugin/ralph-playwright/schemas/user-story.schema.yaml` with a new `inferred_sad_paths:` section schema (documentation-as-schema) and adds `plugin/ralph-playwright/schemas/example-vision-sad-paths.yaml` demonstrating a well-formed vision-inferred entry.
- **Phase 3 / #822** updates `plugin/ralph-playwright/skills/story-gen/SKILL.md` (Step 2's Sad-paths subsection) to add an optional vision-grounded generation step that: takes screenshots as input, loads the Phase 1 prompt, emits Phase 2's schema, merges with heuristic sad paths, and runs a user-review gate before YAML write.
- **Phase 4 / #823** updates `plugin/ralph-playwright/skills/story-gen/SKILL.md` Step 0 (the explorer-agent spawn path) to auto-pick up screenshots from the journey trace, apply a filtering heuristic (form pages / empty results / error states), and feed them into Phase 3's pipeline. Graceful zero-screenshot fallback.
- **Phase 5 / #824** creates `plugin/ralph-playwright/skills/story-gen/fixtures/` with 2-3 representative PNG screenshots + a `test.sh` (or equivalent tiny harness) that invokes the vision step per fixture and asserts at least one expected category surfaces. Includes a `TESTING.md` with re-run instructions.

## Desired End State

After all five phases merge:

- `story-gen` supports an optional vision-grounded sad-path inference step that runs **alongside** (never replacing) the existing eight heuristics.
- A new prompt fragment at `plugin/ralph-playwright/skills/story-gen/prompts/sad-path-vision.md` instructs Opus 4.7 to examine screenshots and emit structured candidates across the four named detection categories.
- A new schema shape in `plugin/ralph-playwright/schemas/user-story.schema.yaml` documents the `category | evidence | proposed_story | source` fields, and `plugin/ralph-playwright/schemas/example-vision-sad-paths.yaml` demonstrates a valid example.
- When the user invokes `story-gen` with a `--vision-sad-paths` flag (or natural-language equivalent), the pipeline:
  1. Collects screenshots (manual path or explorer-agent auto-feed)
  2. Runs the vision prompt against each screenshot
  3. Emits inferred candidates alongside the heuristic eight, tagged `source: vision` vs `source: heuristic`
  4. Prompts the user to keep/drop per entry
  5. Writes only the kept entries into `playwright-stories/<slug>.yaml`
- When `story-gen` runs in URL mode (Step 0 → explorer-agent), screenshots from the journey trace auto-feed the vision step. A filtering heuristic keeps cost bounded. Zero-screenshot case logs gracefully.
- `plugin/ralph-playwright/skills/story-gen/fixtures/` ships 2-3 representative screenshots with a runnable test harness that asserts expected categories surface.
- `schemas/example-auth.yaml` parses unchanged. The existing heuristic sad-path behavior is regression-free when the flag is unset.

### Verification

- [ ] **Phase 1**: prompt fragment exists at `plugin/ralph-playwright/skills/story-gen/prompts/sad-path-vision.md`, covers all four categories, requires structured output, includes a worked example
- [ ] **Phase 2**: `user-story.schema.yaml` documents the new fields; `example-vision-sad-paths.yaml` demonstrates a well-formed entry; `example-auth.yaml` still parses
- [ ] **Phase 3**: `story-gen/SKILL.md` Step 2 documents the new `--vision-sad-paths` option; dry-run against one fixture shows merged heuristic+vision candidates; user-review gate runs before YAML write; dropped entries absent from final YAML
- [ ] **Phase 4**: `story-gen/SKILL.md` Step 0 auto-picks up screenshots from journey trace; filtering heuristic documented; zero-screenshot case handled without error
- [ ] **Phase 5**: 2-3 fixture screenshots committed; `test.sh` (or equivalent) runs and asserts at least one category per fixture; malformed output fails the test; `TESTING.md` documents re-run
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` exits 0 (unchanged)
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes (unchanged)

## What We're NOT Doing

- **Not replacing the eight heuristics.** Heuristics remain the default. Vision inference is opt-in. Parent issue AC explicitly says "emit generated sad paths alongside existing heuristic-based ones".
- **Not modifying `explorer-agent.md`.** Integration is entirely on the story-gen side consuming the existing journey-trace.yaml output. Confirmed by #823's out-of-scope.
- **Not adding a new signal type.** `data_interpretation` is Feature I's surface (#793). Vision sad-path output is not a signal report — it is a user-story candidate. The signal-report schema is untouched.
- **Not adding `--high-res` handling.** Default capture resolution is fine for the four detection categories. If quality suffers, #794 adds `--high-res` independently; this plan does not depend on it.
- **Not modifying `journey-trace.schema.yaml`.** The `steps[].screenshot` field is sufficient.
- **Not adding hook validation for `user-story.yaml`.** The hook (`validate-primitive-io.sh`) only pattern-matches primitive artifacts (journey-trace, signal-report, action-log). User-story YAMLs stay convention-enforced via example parity. Adding a user-story hook is a separate cleanup.
- **Not running a quantitative accuracy evaluation.** Phase 5 is a confidence-check on prompt + schema + pipeline behavior. Precision/recall measurements on a large corpus are out of scope.
- **Not doing end-to-end test-e2e runs.** Phase 5 asserts the vision step's output shape/categories. Running the resulting stories YAML through `/ralph-playwright:test-e2e` is separate work.
- **Not changing story-gen's output YAML shape beyond the `source` comment/annotation.** The canonical user-story schema has `stories[].{ name, type, url, persona, tags, workflow }`. Vision-derived entries emit the same shape; `source: vision` is either a YAML comment (does not break parsers) OR a dedicated intermediate field stripped before final write — Phase 2 decides.
- **Not introducing a new CLI or MCP tool.** All changes are SKILL.md-level. The feature is invoked through normal story-gen usage with an extra flag or natural-language trigger.
- **Not touching `explore/SKILL.md`.** `explore` has its own user-story generation hook (`skills/explore/SKILL.md:70-73`) that references the schema comment block. If we want explore to benefit, that is a follow-up; this plan leaves explore untouched.
- **Not adding alt-text relevance, pixel-contrast, or annotated-bbox rendering.** Those live in Features D, E, F (#788, #789, #790) and have their own plans.

## Implementation Approach

The dependency graph is shallow: two foundational atomics (prompt design + schema) can land in parallel. The third atomic merges them into story-gen. The fourth and fifth atomics are parallel consumers of the third.

**Parallelization map**:

- **Round 1 (phases 1, 2)**: parallel. Phase 1 designs prompt text under `prompts/sad-path-vision.md`; Phase 2 extends the schema under `schemas/`. Files are disjoint; no collision.
- **Round 2 (phase 3)**: sequential. Must wait for both Phase 1 and Phase 2 to complete because the pipeline references both artifacts.
- **Round 3 (phases 4, 5)**: parallel. Phase 4 adds URL-mode auto-feed to SKILL.md Step 0; Phase 5 adds fixtures + test harness under `skills/story-gen/fixtures/`. Both consume Phase 3's runtime but touch disjoint files/subsections.

**Shared constraints** from §Shared Constraints apply to every phase. In particular:
- All four detection categories must appear in Phase 1's prompt, Phase 2's schema enum, Phase 3's documentation, and Phase 5's fixture assertions.
- The `source: vision | heuristic` distinction must be consistent across Phase 2's schema, Phase 3's merge logic, and Phase 5's fixture assertions.

---

## Phase 1: GH-819 — Design vision-grounded sad-path inference prompt for story-gen

- **depends_on**: null

### Overview

Author a new prompt fragment at `plugin/ralph-playwright/skills/story-gen/prompts/sad-path-vision.md` that instructs Opus 4.7 to examine one or more screenshots and surface vision-grounded sad-path candidates across the four detection categories. The prompt requires structured output aligned to the Phase 2 schema and includes a worked example to calibrate the model's first run.

### Tasks

#### Task 1.1: Draft the sad-path vision prompt text

- **files**: `plugin/ralph-playwright/skills/story-gen/prompts/sad-path-vision.md` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] File created at `plugin/ralph-playwright/skills/story-gen/prompts/sad-path-vision.md`
  - [ ] Prompt opens with a one-paragraph framing that tells the model: input is one or more screenshots; output is a structured list of vision-inferred sad-path candidates; happy-path flows are NOT its job
  - [ ] Prompt explicitly instructs detection across all four named categories with a sentence-long rubric per category:
    - **Missing error handlers**: forms that submit without a visible error-surfacing container (no `.error`, no `[role=alert]`, no inline red text visible); actions (delete, archive) without a visible "Are you sure?" confirmation or without a visible result indicator
    - **Un-designed empty states**: lists, tables, card grids, or drop zones that render with zero items and no visible empty-state message, illustration, or CTA to populate
    - **Tooltip / popover viewport overflow**: tooltips or popovers that clip at a viewport edge (right edge, bottom edge) or are truncated; dropdown menus that fall off-screen
    - **Form fields without visible validation hints**: input fields with no asterisk, no helper text, no placeholder explaining format, no inline validation feedback pattern
  - [ ] Prompt requires each finding to include a visual-location anchor (either a rough bbox `{x, y, w, h}` in screenshot pixels, OR a natural-language element description if bbox output is unreliable)
  - [ ] Prompt requires each finding to include a one-sentence rationale ("why this is a sad-path gap")
  - [ ] Prompt requires each finding to include a proposed user-story fragment (`{ name, type: sad, url, workflow }`) that the user would actually run if they adopted the suggestion
  - [ ] Prompt requires structured (schema-aligned) output — explicit instruction to emit YAML or JSON matching the Phase 2 schema shape, NOT prose
  - [ ] Prompt includes a short (1-2 entry) worked example showing: a screenshot-description sentence, a finding in the structured shape, the evidence block populated, the proposed_story populated
  - [ ] Prompt includes a calibration note: "You are Opus 4.7. Use your 1:1 pixel coordinate capability when providing bbox values. If bbox is unreliable for a given UI region, fall back to a clear element description."
  - [ ] Prompt includes an explicit **do-not** clause: do not invent sad paths that are not grounded in the screenshot; if the screenshot shows no sad-path signals in a category, emit zero entries for that category
  - [ ] Length target: 80-180 lines of markdown (enough for the four category rubrics + worked example; too long risks diluting attention)

#### Task 1.2: Confirm the prompt is loadable by SKILL.md at runtime

- **files**: `plugin/ralph-playwright/skills/story-gen/SKILL.md` (read only — do not modify in this phase)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Read `plugin/ralph-playwright/skills/story-gen/SKILL.md` and confirm the `allowed-tools` list includes `Read` — this is what lets SKILL.md's runtime load `prompts/sad-path-vision.md`
  - [ ] Confirm the prompt file is a sibling of `SKILL.md` in the same skill directory tree — so relative-path loading from SKILL.md works
  - [ ] Record in this plan's Phase 3 reference section: "Phase 3 task 3.1 will reference the prompt via the path `plugin/ralph-playwright/skills/story-gen/prompts/sad-path-vision.md` when instructing the model which file to read"
  - [ ] No SKILL.md changes in this phase; wiring happens in Phase 3

### Phase Success Criteria

#### Automated Verification:
- [ ] File exists at `plugin/ralph-playwright/skills/story-gen/prompts/sad-path-vision.md`
- [ ] File parses as valid markdown (no broken front-matter, no unclosed code fences) — check via `head -5` and visual read
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors (ralph-hero MCP server unchanged by this feature; CI gate stays green)

#### Manual Verification:
- [ ] Reviewer reads the prompt and confirms all four categories are present with rubric + instruction
- [ ] Reviewer confirms the prompt requires structured output and includes a worked example
- [ ] Reviewer confirms the do-not clause prevents hallucinated findings

**Creates for next phase**: A loadable prompt fragment that Phase 3's SKILL.md update will reference by path. Phase 2 does not consume this file directly — the two phases are independent — but Phase 3 binds them together.

---

## Phase 2: GH-821 — Output schema for vision-inferred sad paths in story-gen

- **depends_on**: null

### Overview

Extend `plugin/ralph-playwright/schemas/user-story.schema.yaml` with a documented section for vision-inferred sad-path candidates, and commit `plugin/ralph-playwright/schemas/example-vision-sad-paths.yaml` as a well-formed example. The schema shape carries evidence metadata (category, location, rationale, screenshot reference) alongside the canonical user-story fields. Existing `example-auth.yaml` must still parse.

### Tasks

#### Task 2.1: Extend the user-story schema documentation

- **files**: `plugin/ralph-playwright/schemas/user-story.schema.yaml` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Add a new top-level documented section (alongside the existing `stories:` prose definition) describing `inferred_sad_paths:` — a list of candidates with these per-entry fields:
    - `category`: enum of exactly five values: `missing_error_handler | empty_state_gap | tooltip_overflow | missing_validation_hint | other`
    - `evidence`: object with required sub-fields:
      - `screenshot_path`: string — path to the PNG input (absolute or repo-relative)
      - `bbox_or_description`: string — either `"{x, y, w, h}"` pixel bbox or a natural-language element description
      - `rationale`: string — one-sentence explanation of why this is a sad-path gap
    - `proposed_story`: object with the canonical user-story fields: `{ name, type: sad, url, workflow }` (same shape as entries under `stories:`)
    - `source`: literal string `"vision"` — present on every inferred entry to distinguish from heuristic
  - [ ] The four named enum values correspond 1:1 to the four detection categories in Phase 1's prompt — no naming divergence
  - [ ] `other` is reserved for edge cases the model identifies that do not fit the four named categories — the prompt (Phase 1) should strongly bias toward the named four but `other` exists as a safety valve
  - [ ] The schema-as-comment-prose style matches the existing file's idiom (not a JSON Schema `required:` list)
  - [ ] The existing `stories:` documentation block is unchanged
  - [ ] The existing "Sad path heuristics" comment block (lines 16-25) is unchanged — vision inference is additive, not a replacement
  - [ ] A short comment block at the top of the new section documents the four detection categories (names only, full rubric lives in the Phase 1 prompt)
  - [ ] A cross-reference comment states: "The `source` field distinguishes origin. Heuristic entries (from `skills/story-gen/SKILL.md:46-52`) do not carry `source`; vision-inferred entries carry `source: vision` until merged into the final stories YAML, at which point `source` is either preserved as a YAML comment OR dropped — see `skills/story-gen/SKILL.md` Step 3 for the final-write convention."

#### Task 2.2: Create an example file demonstrating a vision-inferred candidate

- **files**: `plugin/ralph-playwright/schemas/example-vision-sad-paths.yaml` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] File created at `plugin/ralph-playwright/schemas/example-vision-sad-paths.yaml`
  - [ ] Contains at least three `inferred_sad_paths:` entries covering three of the four named categories (pick: `missing_error_handler`, `empty_state_gap`, `missing_validation_hint`)
  - [ ] Each entry has all four top-level keys (`category`, `evidence`, `proposed_story`, `source`)
  - [ ] Each `evidence` block has all three sub-fields populated (`screenshot_path`, `bbox_or_description`, `rationale`)
  - [ ] Each `proposed_story` is a realistic user-story fragment (name, type: sad, url, workflow) for the scenario
  - [ ] `source` is literal `"vision"` on every entry
  - [ ] File parses as valid YAML (`yq '.' <path>` exits 0 OR equivalent sanity check by visual inspection — no unescaped colons, consistent indentation)
  - [ ] The example includes at least one bbox-format evidence entry AND at least one description-format evidence entry (demonstrating both valid shapes of `bbox_or_description`)
  - [ ] Placeholder URLs use `http://localhost:3000/...` to match the style of `example-auth.yaml`

#### Task 2.3: Confirm the existing example-auth.yaml still parses under the extended schema

- **files**: `plugin/ralph-playwright/schemas/example-auth.yaml` (read only — must not be modified)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] Read `plugin/ralph-playwright/schemas/example-auth.yaml` unchanged from main
  - [ ] Confirm it contains only `stories:` (no `inferred_sad_paths:` section) — which is valid because the new section is optional
  - [ ] Confirm a YAML parser on the file exits 0 (`yq '.' plugin/ralph-playwright/schemas/example-auth.yaml`) — unchanged parseability
  - [ ] Confirm the schema's `stories:` prose definition has not drifted (re-read `user-story.schema.yaml` lines 1-15)

### Phase Success Criteria

#### Automated Verification:
- [ ] `yq '.' plugin/ralph-playwright/schemas/example-auth.yaml` exits 0
- [ ] `yq '.' plugin/ralph-playwright/schemas/example-vision-sad-paths.yaml` exits 0
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors

#### Manual Verification:
- [ ] Reviewer reads `user-story.schema.yaml` and confirms the new `inferred_sad_paths:` section is documented with all four fields
- [ ] Reviewer confirms the enum has exactly five values (four named + `other`)
- [ ] Reviewer reads `example-vision-sad-paths.yaml` and confirms three categories are demonstrated with full fields

**Creates for next phase**: A schema shape that Phase 3's merge logic conforms to. The enum values in `category` are the ones Phase 3 tags on vision-derived entries and Phase 5's test harness asserts against.

---

## Phase 3: GH-822 — Wire vision sad-path generation into story-gen pipeline

- **depends_on**: [phase-1, phase-2]

### Overview

Integrate vision-grounded sad-path generation into `skills/story-gen/SKILL.md` as an opt-in step in Step 2 (the Sad-paths subsection around lines 44-52). When enabled, the pipeline loads the Phase 1 prompt, runs it against input screenshots, emits Phase 2-schema-aligned candidates, merges them with the heuristic eight, presents the combined list to the user for per-entry keep/drop review, and writes only kept entries to the final YAML. Heuristic behavior is unchanged when the flag is unset.

### Tasks

#### Task 3.1: Add the vision-sad-paths subsection to SKILL.md Step 2

- **files**: `plugin/ralph-playwright/skills/story-gen/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] After the existing "Sad paths — automatically derived, apply ALL applicable heuristics" block (lines 44-52), insert a new "Vision-grounded sad paths (optional)" subsection
  - [ ] Subsection documents an invocation trigger: either an explicit `--vision-sad-paths` flag OR a natural-language trigger ("generate vision sad paths", "inspect the UI for sad paths") that the skill recognizes and activates — pick one and document it explicitly. Recommended: document BOTH (flag for deterministic scripting; natural-language for conversational use)
  - [ ] Subsection documents input requirements: at least one screenshot path is required. Screenshots may come from:
    - A user-supplied path (manual mode) — single file or directory
    - A prior session's journey trace — the user specifies `.playwright-cli/<session>/`
    - The explorer-agent journey trace auto-feed (URL mode — wired by Phase 4)
  - [ ] Subsection documents the execution steps:
    1. Read the prompt at `plugin/ralph-playwright/skills/story-gen/prompts/sad-path-vision.md`
    2. For each input screenshot, invoke the prompt with the screenshot as vision input
    3. Collect structured output conforming to `inferred_sad_paths:` schema (per `plugin/ralph-playwright/schemas/user-story.schema.yaml`)
    4. Tag each entry `source: vision`
    5. Tag the existing heuristic sad paths `source: heuristic` (internal tagging, pre-merge)
    6. Merge both sets into a single review list
  - [ ] Subsection documents the review gate (between generation and YAML write):
    - Present the merged list to the user with per-entry metadata: `[source: vision | heuristic]`, category, proposed_story.name
    - Offer three actions: keep-all, drop-all, per-entry (default)
    - For per-entry mode: prompt the user y/n for each candidate
    - Only kept entries proceed to YAML write
  - [ ] Subsection documents YAML-output behavior:
    - Heuristic-kept entries write exactly as today (unchanged shape under `stories:`)
    - Vision-kept entries write under `stories:` with the same canonical shape (`name, type: sad, url, workflow, persona, tags`)
    - The `source: vision` tag is preserved as a YAML comment above each vision-derived story (e.g., `# source: vision (category: empty_state_gap)`) — does NOT break parsers; gives humans provenance
  - [ ] Subsection documents the default behavior when the flag/trigger is absent: heuristics-only, no regression — today's behavior is preserved
  - [ ] Subsection ends with a one-paragraph "When to use" note: prefer vision mode for UIs the user has actually seen; prefer heuristics-only for generating baseline stories from a description-only input
  - [ ] Existing Step 3 (Output YAML), Step 4 (Present and iterate), Step 0 (Observe), Step 1 (Gather input) are unchanged
  - [ ] The existing 8-heuristic list (lines 46-52) is unchanged

#### Task 3.2: Define the merge and review logic at a level of detail that impl can follow

- **files**: `plugin/ralph-playwright/skills/story-gen/SKILL.md` (modify — same file as 3.1, continues the subsection)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] The subsection added in 3.1 includes a worked example showing:
    - Input: a single screenshot path
    - Vision output: 2-3 `inferred_sad_paths:` entries (at least one per category across the examples)
    - Heuristic output: the 8 heuristics applied to whatever URL the user named
    - Merged review list: a numbered table / bullet list the user sees
    - After user keeps 5 of the 10+ candidates: the final YAML shows 5 `stories:` entries (some with `source: vision` comment)
  - [ ] The worked example uses a concrete hypothetical (e.g., "login page at http://localhost:3000/login") — not abstract `<slug>` placeholders
  - [ ] The subsection explicitly states: the vision step's model call is a single call per screenshot (NOT a per-step loop) — this keeps cost bounded and matches how Opus 4.7 batches multi-image analysis in one prompt
  - [ ] The subsection notes a cost-awareness caveat: "In URL mode with many screenshots, Phase 4's filter heuristic restricts inputs. In manual mode, the user controls input volume."

#### Task 3.3: End-to-end dry-run confirms merged behavior on a captured screenshot

- **files**:
  - `plugin/ralph-playwright/skills/story-gen/SKILL.md` (read)
  - `plugin/ralph-playwright/skills/story-gen/prompts/sad-path-vision.md` (read)
  - `plugin/ralph-playwright/schemas/user-story.schema.yaml` (read)
  - `thoughts/local/pilots/2026-04-20-GH-0822-vision-sad-paths-pilot.md` (create) — pilot notes (user-local; gitignored)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.2]
- **acceptance**:
  - [ ] Capture or reuse one real screenshot of a UI known to exhibit at least two of the four categories (e.g., a login form without visible validation hints AND an adjacent empty dashboard list)
  - [ ] Invoke `/ralph-playwright:story-gen` with `--vision-sad-paths` against the screenshot (or with the natural-language trigger)
  - [ ] Confirm: the vision prompt runs, 1+ vision-inferred candidates are produced conforming to `inferred_sad_paths:` schema
  - [ ] Confirm: the 8 heuristics also produce candidates (for the same URL / description)
  - [ ] Confirm: the merged review list presents both sets with `source` labels
  - [ ] Confirm: the user-review gate prompts per-entry (or keep-all / drop-all)
  - [ ] Drop at least one candidate during review; confirm it does NOT appear in the final YAML
  - [ ] Confirm: final YAML parses cleanly (`yq '.' playwright-stories/<slug>.yaml` exits 0)
  - [ ] Confirm: kept vision entries have a `# source: vision (...)` YAML comment; kept heuristic entries do not have a `source` comment (preserving the current shape)
  - [ ] Confirm: invoking `story-gen` WITHOUT the flag on the same description produces only the 8-heuristic output (regression check)
  - [ ] Record pilot findings (screenshot used, categories surfaced, candidate count, keep/drop choices, final YAML excerpt) in `thoughts/local/pilots/2026-04-20-GH-0822-vision-sad-paths-pilot.md`

### Phase Success Criteria

#### Automated Verification:
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` — all passing
- [ ] `yq '.' playwright-stories/<pilot-slug>.yaml` exits 0 on the pilot output
- [ ] `yq '.' plugin/ralph-playwright/schemas/example-auth.yaml` still exits 0 (regression gate)

#### Manual Verification:
- [ ] Reviewer reads the updated SKILL.md Step 2 and confirms the new subsection documents flag, input, execution, review gate, and YAML-output
- [ ] Reviewer reads the pilot note and confirms merged behavior + drop-on-review both worked
- [ ] Reviewer confirms heuristic-only default behavior is regression-free

**Creates for next phase**: A runtime pipeline that Phase 4 (URL mode auto-feed) and Phase 5 (fixture tests) both invoke. From this point on, both downstream phases are independent.

---

## Phase 4: GH-823 — Feed explorer-agent screenshots into vision sad-path inference (URL mode)

- **depends_on**: [phase-3]

### Overview

Close the loop between Step 0 (explorer-agent URL observation) and the Phase 3 vision sad-path pipeline. When `story-gen` is invoked with a URL and the explorer-agent produces a journey trace, the screenshots from that trace auto-feed the vision step — no manual path supplied. A filtering heuristic keeps cost bounded by picking key-state screenshots rather than all ~20 steps. Graceful fallback when the trace produces zero screenshots.

### Tasks

#### Task 4.1: Document auto-feed in SKILL.md Step 0

- **files**: `plugin/ralph-playwright/skills/story-gen/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Step 0 ("Observe — optional") is extended (not replaced) with a new sub-bullet describing the auto-feed behavior: "When `--vision-sad-paths` is also active, the screenshots referenced by `steps[].screenshot` in `.playwright-cli/<session>/journey-trace.yaml` auto-feed the Phase 3 vision step — the user does not need to supply screenshots manually"
  - [ ] Step 0 documents the filtering heuristic (see Task 4.2 for selection logic): "A filter restricts which screenshots are passed to the vision prompt to control cost. Default filter: keep screenshots where `steps[].action` is one of `navigate`, `click`, `fill` AND the `target` contains keywords suggesting a form, list, or empty state"
  - [ ] Step 0 documents the override: user can pass `--all-screenshots` (or natural-language equivalent) to disable the filter and feed every screenshot
  - [ ] Step 0 documents the graceful-fallback: if the journey trace has zero usable screenshots (e.g., explorer-agent exited early with no captures), log a one-line note ("vision sad-path inference skipped — zero screenshots in journey trace") and continue with heuristics-only sad-path generation. The overall story-gen run does NOT fail.
  - [ ] Step 0 cross-references Step 2's vision-sad-paths subsection: "See Step 2 → Vision-grounded sad paths for the full invocation semantics"
  - [ ] Existing Step 0 sub-steps (spawn explorer-agent, read trace, use flows as input) are unchanged

#### Task 4.2: Specify the screenshot filtering heuristic

- **files**: `plugin/ralph-playwright/skills/story-gen/SKILL.md` (modify — continues 4.1's Step 0 extension)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [4.1]
- **acceptance**:
  - [ ] Heuristic is explicit and deterministic (not "pick interesting ones"). Documented rules, in order of precedence:
    1. **Include**: any step where `outcome == "fail"` (failures already interesting for sad-path analysis)
    2. **Include**: any step where `action == "navigate"` AND the `target` resolves to a new path (first-visit of each unique URL — captures initial-state screenshots)
    3. **Include**: any step where `action` is `fill` or `click` AND the `target` string contains any of these keywords (case-insensitive): `form`, `submit`, `login`, `sign`, `search`, `filter`, `cart`, `checkout`, `list`, `table`, `empty`, `error`
    4. **Exclude**: steps where `action == "verify"` (verification steps rarely add new visual state)
    5. **Exclude**: steps where the screenshot path does not resolve to a readable PNG (broken references)
  - [ ] Heuristic caps the filtered set at 8 screenshots maximum — if more match, prefer: (a) all fail-outcome steps, (b) all first-visit-navigates, (c) then distribute remaining budget across keyword matches. Document this cap explicitly.
  - [ ] Document that the user can override with `--all-screenshots` (pass every screenshot, no filter, no cap)
  - [ ] Document that users can also pass an explicit screenshot list to bypass the heuristic entirely (e.g., `--screenshots path/to/a.png,path/to/b.png` — or the equivalent natural-language phrasing)
  - [ ] Include a worked example: a 15-step journey trace → apply heuristic → yields 5 screenshots (fail on step 7, initial navigates at 0 and 3, keyword matches at 5 and 12) → vision step runs 5 times

#### Task 4.3: Zero-screenshot and broken-reference fallback paths

- **files**: `plugin/ralph-playwright/skills/story-gen/SKILL.md` (modify — Step 0 extension)
- **tdd**: false
- **complexity**: low
- **depends_on**: [4.2]
- **acceptance**:
  - [ ] Document the zero-screenshot case: "If the filter yields zero screenshots AND no manual paths were supplied, skip the vision step silently (one-line note to the user: 'Skipped vision sad-path inference — no suitable screenshots found'). Heuristic sad paths proceed normally. The `story-gen` run succeeds."
  - [ ] Document the broken-reference case: "If a filtered screenshot path does not resolve on disk, log a one-line warning ('screenshot not found: <path>, skipping') and continue with the remaining screenshots. If ALL references are broken, falls back to zero-screenshot case."
  - [ ] Document the manual-path-override preservation: "When the user supplies an explicit manual path via `--screenshots`, the filter heuristic is NOT applied; the user's list is used verbatim"
  - [ ] Document that the manual-screenshot-path code path from Phase 3 continues to work unchanged — this phase is strictly additive

#### Task 4.4: End-to-end dry-run on a URL-mode story-gen invocation

- **files**:
  - `plugin/ralph-playwright/skills/story-gen/SKILL.md` (read)
  - `thoughts/local/pilots/2026-04-20-GH-0823-url-mode-pilot.md` (create) — pilot notes (user-local)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [4.3]
- **acceptance**:
  - [ ] Identify or launch a small test app at a localhost URL (could be a tiny static HTML with a form + list + empty state — or any real dev server running)
  - [ ] Invoke `/ralph-playwright:story-gen --url http://localhost:<port> --vision-sad-paths` (or natural-language equivalent)
  - [ ] Confirm: explorer-agent runs, produces `.playwright-cli/<session>/journey-trace.yaml` with N steps
  - [ ] Confirm: filter heuristic picks K screenshots where K ≤ 8 AND K reflects the documented selection rules
  - [ ] Confirm: vision step runs once per selected screenshot
  - [ ] Confirm: merged review list appears with both heuristic and vision candidates
  - [ ] Confirm: final YAML written to `playwright-stories/<slug>.yaml`
  - [ ] Run a second invocation against a URL that produces zero usable screenshots (e.g., force explorer-agent to fail quickly by pointing at an invalid URL); confirm the graceful-fallback path: vision step skipped with log line, heuristics-only output succeeds, no error exit
  - [ ] Run a third invocation with `--all-screenshots` against the same URL as the first test; confirm the filter is bypassed and every screenshot feeds vision (subject to the 8-cap? NO — `--all-screenshots` also removes the cap; document if this is the intent)
  - [ ] Confirm: the Phase 3 manual-path flow still works — invoke `story-gen` with `--screenshots <manual-path.png> --vision-sad-paths` WITHOUT a `--url`; confirm the URL-mode additions did NOT regress manual mode
  - [ ] Record pilot findings (URL, step count, filter selection, pilot YAML excerpt, any fallback path exercised) in `thoughts/local/pilots/2026-04-20-GH-0823-url-mode-pilot.md`

### Phase Success Criteria

#### Automated Verification:
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` — all passing
- [ ] `yq '.' playwright-stories/<pilot-slug>.yaml` exits 0 on each pilot output
- [ ] `yq '.' plugin/ralph-playwright/schemas/example-auth.yaml` still exits 0 (regression gate)

#### Manual Verification:
- [ ] Reviewer reads the updated SKILL.md Step 0 and confirms auto-feed + filtering heuristic + zero-screenshot fallback are all documented
- [ ] Reviewer reads the pilot note and confirms all three dry-run invocations (url + flag, zero-screenshot fallback, manual-mode regression check) worked as specified
- [ ] Reviewer confirms `explorer-agent.md` was NOT modified

**Creates for next phase**: No direct input to Phase 5. Phase 5 is an independent consumer of Phase 3's runtime.

---

## Phase 5: GH-824 — Test coverage for vision sad-path inference on representative screenshots

- **depends_on**: [phase-3]

### Overview

Commit 2-3 representative fixture screenshots plus a lightweight test harness that invokes the vision sad-path step against each fixture and asserts at least one expected detection category surfaces. This is a confidence-check on prompt + schema + pipeline behavior, not an exhaustive accuracy evaluation. Ralph-playwright has no MCP server / no vitest config, so the harness matches plugin conventions (shell script or tiny node script). A `TESTING.md` documents how to re-run.

### Tasks

#### Task 5.1: Create the fixtures directory with representative screenshots

- **files**:
  - `plugin/ralph-playwright/skills/story-gen/fixtures/01-form-no-validation-hints.png` (create)
  - `plugin/ralph-playwright/skills/story-gen/fixtures/02-list-no-empty-state.png` (create)
  - `plugin/ralph-playwright/skills/story-gen/fixtures/03-tooltip-viewport-overflow.png` (create)
  - `plugin/ralph-playwright/skills/story-gen/fixtures/README.md` (create) — describes each fixture's expected category
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Directory created at `plugin/ralph-playwright/skills/story-gen/fixtures/`
  - [ ] Three PNG fixture screenshots committed, each targeting one detection category:
    - `01-form-no-validation-hints.png`: a form (login, signup, or similar) with at least two input fields that show no asterisk, no helper text, no inline validation feedback — demonstrates **missing_validation_hint**
    - `02-list-no-empty-state.png`: a list / table / grid UI rendered with zero items and no empty-state message, illustration, or populate-CTA visible — demonstrates **empty_state_gap**
    - `03-tooltip-viewport-overflow.png`: a tooltip or popover clipped at a viewport edge — demonstrates **tooltip_overflow**
  - [ ] Each PNG is real UI (not a synthetic mockup that the model would trivially categorize) — can be captured from a small test app, a public page, or a fixture HTML page the author creates
  - [ ] Each PNG is ≤ 500 KB (keeps git repo small; binary files commit is acceptable for fixtures under this size)
  - [ ] PNG dimensions are representative of typical screenshots (e.g., 1024×768 or 1280×800) — not tiny thumbnails
  - [ ] `README.md` in the fixtures directory documents, per fixture:
    - Filename
    - Expected primary detection category
    - Optionally expected secondary categories
    - Source (how the fixture was captured, or a URL if it is a public page snapshotted)
  - [ ] The fourth category (**missing_error_handler**) is noted in the README as "not yet covered — follow-up fixture" — this is acceptable per the parent issue which says "2-3 representative fixtures" (not four)
  - [ ] A copyright / provenance note in the README confirms the fixtures were captured by the author (or from a page the author has permission to snapshot for test purposes)

#### Task 5.2: Create the test harness script

- **files**: `plugin/ralph-playwright/skills/story-gen/fixtures/test.sh` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [5.1]
- **acceptance**:
  - [ ] File created at `plugin/ralph-playwright/skills/story-gen/fixtures/test.sh` and has shebang `#!/usr/bin/env bash`; file mode is 0755
  - [ ] Script sets `set -euo pipefail`
  - [ ] Script invokes the vision sad-path step against each fixture — invocation mode matches what Phase 3 documented (e.g., `story-gen` with `--vision-sad-paths --screenshots <fixture-path>` OR the natural-language equivalent captured in a `claude` one-shot prompt). Pick the simplest invocation path that exists after Phase 3 lands and document it here.
  - [ ] Script captures the vision step's structured output (the `inferred_sad_paths:` YAML fragment, NOT the final merged YAML — we want to assert the vision step's own output)
  - [ ] Script asserts, for each fixture:
    - The output parses as valid YAML (exit 0 on `yq '.inferred_sad_paths' <output>`)
    - At least one entry has `category` matching the fixture's expected primary category (e.g., `02-list-no-empty-state.png` → at least one `category: empty_state_gap`)
    - At least one entry per fixture has `evidence.screenshot_path` referencing the fixture filename
    - At least one entry per fixture has a non-empty `evidence.rationale`
  - [ ] Script fails the test if:
    - Output does not parse as YAML (schema regression)
    - Zero entries are produced for a fixture (model-calibration regression or prompt regression)
    - Expected category does not appear in any entry (prompt regression)
  - [ ] Script exits 0 on all-pass, 1 on any failure
  - [ ] Script prints a human-readable summary: `PASS fixture 01: missing_validation_hint (+2 other entries)` / `FAIL fixture 02: empty_state_gap not detected`
  - [ ] Runtime budget: script should complete within ~60 seconds for 3 fixtures on a typical machine. If model latency is higher, the test is still useful — it is not time-sensitive.

#### Task 5.3: Document re-run instructions

- **files**:
  - `plugin/ralph-playwright/skills/story-gen/fixtures/TESTING.md` (create)
  - `plugin/ralph-playwright/skills/story-gen/SKILL.md` (modify — small pointer only)
- **tdd**: false
- **complexity**: low
- **depends_on**: [5.2]
- **acceptance**:
  - [ ] `TESTING.md` created at `plugin/ralph-playwright/skills/story-gen/fixtures/TESTING.md`
  - [ ] Documents: prerequisites (Claude Code CLI, `yq` installed, vision sad-paths feature merged)
  - [ ] Documents: how to run (`bash plugin/ralph-playwright/skills/story-gen/fixtures/test.sh` — absolute or relative invocation)
  - [ ] Documents: how to interpret output (PASS/FAIL lines, exit code)
  - [ ] Documents: when to add a new fixture (add a PNG, update README.md, add a new assertion block in test.sh)
  - [ ] Documents: how to update expected categories if prompt behavior intentionally changes
  - [ ] Documents a troubleshooting section: what if all fixtures fail (prompt regression? model change? screenshot quality?)
  - [ ] `SKILL.md` modification: at the very end of the document (after Step 4), add one line: "**Testing**: see `fixtures/TESTING.md` for fixture-based confidence tests of the vision sad-path step." — pointer only, no functional change

#### Task 5.4: Run the harness to validate the full chain

- **files**:
  - `plugin/ralph-playwright/skills/story-gen/fixtures/test.sh` (read & execute)
  - `thoughts/local/pilots/2026-04-20-GH-0824-fixture-pilot.md` (create) — pilot notes (user-local)
- **tdd**: false
- **complexity**: low
- **depends_on**: [5.3]
- **acceptance**:
  - [ ] Execute `bash plugin/ralph-playwright/skills/story-gen/fixtures/test.sh` from repo root
  - [ ] Confirm: each fixture is processed and produces an `inferred_sad_paths:` output
  - [ ] Confirm: expected categories surface for each fixture (PASS lines in output)
  - [ ] Confirm: exit code is 0
  - [ ] Intentionally introduce a malformed-output case (temporarily break the prompt path or rename a fixture) to confirm: the test DOES fail (exit code 1) on regression. Restore after.
  - [ ] Record pilot findings (run duration, PASS/FAIL per fixture, categories observed beyond the primary, any surprising outputs) in `thoughts/local/pilots/2026-04-20-GH-0824-fixture-pilot.md`

### Phase Success Criteria

#### Automated Verification:
- [ ] `bash plugin/ralph-playwright/skills/story-gen/fixtures/test.sh` exits 0
- [ ] `yq '.' plugin/ralph-playwright/schemas/example-auth.yaml` still exits 0 (regression gate)
- [ ] `yq '.' plugin/ralph-playwright/schemas/example-vision-sad-paths.yaml` still exits 0 (regression gate)
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` — all passing

#### Manual Verification:
- [ ] Reviewer reads `fixtures/README.md` and `fixtures/TESTING.md` and confirms fixture provenance + re-run instructions are clear
- [ ] Reviewer reads the pilot note and confirms all 3 fixtures PASS and the induced-failure case correctly fails the harness
- [ ] Reviewer opens each PNG fixture and confirms it visually exhibits the declared category

**Creates for next phase**: Not applicable — final phase.

---

## Integration Testing

- [ ] **Cross-phase smoke test**: after all 5 phases merge, run `/ralph-playwright:story-gen --url <localhost-test-app> --vision-sad-paths` end-to-end. Confirm: explorer-agent captures → filter heuristic selects → vision prompt runs → merged review list appears → user prunes → final YAML writes → `yq '.' playwright-stories/<slug>.yaml` exits 0 → final YAML contains BOTH `# source: vision` comments AND unannotated heuristic entries.
- [ ] **Regression gate on heuristic-only behavior**: run `/ralph-playwright:story-gen --url <test-app>` WITHOUT `--vision-sad-paths`. Confirm: identical behavior to pre-merge; only 8 heuristic sad paths are generated; no vision-related code paths execute.
- [ ] **Schema parity**: `schemas/example-auth.yaml` parses under the extended schema unchanged. Newly-minted `schemas/example-vision-sad-paths.yaml` parses and is a complete illustration.
- [ ] **Fixture regression**: `bash plugin/ralph-playwright/skills/story-gen/fixtures/test.sh` runs clean post-merge.
- [ ] **Documentation coherence**: the four detection categories are named identically in (a) Phase 1 prompt, (b) Phase 2 schema enum, (c) Phase 3 SKILL.md subsection, (d) Phase 5 fixture README. Reviewer grep-checks the four strings across all files in the final PR.

## References

- Research: [thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md) §Part 3 Item 12
- Parent plan-of-plans: [thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md) §Feature L
- Primary edit target: [plugin/ralph-playwright/skills/story-gen/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/story-gen/SKILL.md) (especially lines 44-52 for Phase 3, Step 0 for Phase 4, and the document tail for Phase 5)
- Schema edit target: [plugin/ralph-playwright/schemas/user-story.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/user-story.schema.yaml)
- Parity reference: [plugin/ralph-playwright/schemas/example-auth.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/example-auth.yaml)
- Journey trace input: [plugin/ralph-playwright/schemas/journey-trace.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/journey-trace.schema.yaml)
- Explorer-agent (unmodified producer): [plugin/ralph-playwright/agents/explorer-agent.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/agents/explorer-agent.md)
- Related epic sub-issue (URL mode also relevant to Feature K): https://github.com/cdubiel08/ralph-hero/issues/795
- Issues in this plan:
  - https://github.com/cdubiel08/ralph-hero/issues/796 (parent M issue)
  - https://github.com/cdubiel08/ralph-hero/issues/819 (prompt design)
  - https://github.com/cdubiel08/ralph-hero/issues/821 (output schema)
  - https://github.com/cdubiel08/ralph-hero/issues/822 (pipeline wiring)
  - https://github.com/cdubiel08/ralph-hero/issues/823 (URL-mode auto-feed)
  - https://github.com/cdubiel08/ralph-hero/issues/824 (test coverage)
- Epic: https://github.com/cdubiel08/ralph-hero/issues/784
