---
date: 2026-04-20
status: draft
type: plan-of-plans
tags: [ralph-playwright, opus-4-7, vision, reflect-phase, a11y, visual-regression, computer-use]
github_issue: 784
github_issues: [784, 785, 786, 787, 788, 789, 790, 791, 792, 793, 794, 795, 796]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/784
primary_issue: 784
child_plans: []
---

# ralph-playwright: Opus 4.7 vision upgrade — Plan of Plans

## Prior Work

- builds_on:: [[2026-04-16-opus-4-7-ralph-playwright-vision]]

## Strategic Context

Opus 4.7 is materially better at eyes-on-glass work than its predecessors. Public benchmarks show +5-22 point jumps over Opus 4.6 across visual reasoning, computer use, and document understanding, and the resolution ceiling tripled (to 2576px / 3.75MP with 1:1 pixel coordinates). XBOW's proprietary acuity benchmark jumped 44 points.

ralph-playwright (v0.2.0) is structurally well-positioned to exploit this: every skill composes through an Execute -> Reflect -> Act pipeline that already captures both screenshots and accessibility snapshots at every step. But today the visual half of every step is analyzed with a single one-line instruction — "look for visual anomalies, layout issues, error states" — and a schema-defined `regression` signal type has no mechanism because visual diffing is delegated entirely to Chromatic/Applitools at Storybook-story granularity. Accessibility snapshots drive most classification; screenshots are captured but barely read.

This epic closes that gap with 12 concrete improvements in three bands:

- **Reflect-phase quality** (#785, #786, #787) — route Opus 4.7 to reflect, give it a real audit checklist, escalate by step importance.
- **New capabilities** (#788, #789, #790, #791, #792, #793) — pixel-computed contrast, alt-text relevance, annotated bboxes, in-loop semantic diff, vision-fallback targeting for canvas/maps/bad-a11y, `data_interpretation` signal type.
- **Capture & exploration** (#794, #795, #796) — `--high-res` flag, vision-driven explorer mode, vision-grounded sad-path inference in story-gen.

Success = the `regression` signal type becomes mechanism-backed at journey level, the `a11y_violation` signal type covers contrast and alt-relevance grounded in pixels, and visual evidence produced by the pipeline is both richer (bboxes, annotations) and more action-oriented (natural-language change descriptions).

## Shared Constraints

These apply to every feature. Each feature's plan must inherit them verbatim; no feature is free to contradict them.

### Architecture & file ownership

- The Execute -> Reflect -> Act pipeline is strict and schema-enforced. Any new inputs/outputs flow through the three YAML schemas in `plugin/ralph-playwright/schemas/`: `journey-trace.schema.yaml`, `signal-report.schema.yaml`, `action-log.schema.yaml`. Schema additions must be additive (new optional fields) unless explicitly noted.
- Hooks in `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` validate journey-trace, signal-report, and action-log YAMLs at Read and Write boundaries. Any schema change that tightens validation must update the hook in the same PR.
- Execute runs as a sub-agent (`explorer-agent` or `story-runner-agent`) with `model: sonnet`. Keep Sonnet for Execute. Reflect runs in the calling model's context — that is the sole tier where Opus 4.7 routing applies.
- Screenshots (PNG) and accessibility snapshots (`.md`) are captured at EVERY step. No feature may opt out of either capture.
- The "NEVER use CSS selectors" rule in `plugin/ralph-playwright/agents/story-runner-agent.md:50` stays in force for accessible elements. Vision-fallback targeting (#792) is additive — it only activates when the accessibility snapshot yields no ref.

### Model routing discipline

- Preferred-model hints are expressed in SKILL.md frontmatter with env var overrides (naming: `RALPH_PLAYWRIGHT_<PHASE>_MODEL`). Escalation rules must be declarative in SKILL.md, not buried in prompt logic.
- Every reflect step records which model ran it, either in a signal-report sidecar or as a journey-trace annotation. This enables cost audits and retrospective routing tuning.

### Cost & token envelope

- Default capture resolution stays at the playwright-cli current viewport default. Higher-resolution modes (up to 2576px, 2576px / 3.75MP ceiling) are opt-in via `--high-res` or escalation rules, never defaults.
- Opus 4.7 is materially more expensive per screenshot than Sonnet at 1568px. Default routing must keep Sonnet on happy paths; Opus 4.7 is reserved for reflect, with escalation on fail or prior-signal steps.

### Prompt engineering conventions

- Categorized checklists beat free-form instructions. A rewritten reflect prompt (#786) must cover: layout integrity, typography, imagery, state visibility, visual hierarchy, chart & data UIs, viewport/responsive.
- Semantic-diff prompts (#791) must explicitly ignore: anti-aliasing, font hinting, animation frames, and timestamps. Output natural-language change descriptions, never bare diff images.
- Contrast-estimation prompts (#788) must respect large-text thresholds: 4.5:1 normal, 3:1 for text >= 18pt or >= 14pt bold.
- Alt-text relevance prompts (#789) must treat decorative images (`alt=""`) as compliant — not as violations.

### Artifact paths

- Session data: `.playwright-cli/<session>/` (journey-trace.yaml, signal-report.yaml, action-log.yaml, screenshots, snapshots).
- Promoted evidence: `thoughts/local/assets/<session>/` for both original and annotated screenshots.
- Baselines for semantic diff: `thoughts/local/baselines/<session-slug>/` (gitignored).

### Verification tooling

Ralph-playwright is skills/agents-only — there is no build/test matrix for the plugin itself. Feature verification is phase-specific and must be spelled out in each feature plan. Suggested checks per feature:

- **Schema changes** — run a sample pipeline that reads/writes the affected YAML, confirm `validate-primitive-io.sh` does not reject.
- **Prompt changes** — run the updated skill on one real journey; qualitatively assess signal quality.
- **Runtime changes** (e.g., `--high-res`, vision-fallback) — exercise on a fixture page with the target failure mode; confirm the new path fires.
- **CI** — plugin-level checks via `plugin/ralph-hero/mcp-server/npm test` still apply to any MCP-side changes (none expected in this epic), and `ralph-knowledge` tests still pass (not touched here).

### Research anchoring

Every feature plan must cite the parent research doc `thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md` in its Prior Work section and reference the specific §Part 3 Item that motivates it.

## Feature Decomposition

Each feature below corresponds directly to an existing GitHub issue under #784. Five of the twelve (#790, #791, #792, #795, #796) are already decomposed into atomics by `/ralph-split` and have their own internal dependency chains — their feature plans will consume those pre-split atomics.

### Feature A: Split model routing — Opus 4.7 for reflect, Sonnet for execute (GH-785)
- **depends_on**: null
- **produces**:
  - `plugin/ralph-playwright/skills/reflect/SKILL.md` frontmatter — `preferred-model: opus` hint
  - Env var convention: `RALPH_PLAYWRIGHT_REFLECT_MODEL` override (documented)
  - README / SKILL.md documentation for the execute/reflect split
- **Estimated atomics**: 1-2 (SKILL.md edit + doc block; no sub-issues today)
- **Why first**: foundational. #786 and #787 layer on top. Without a declared reflect-model slot there is nothing for later features to escalate to.

### Feature B: Structured visual audit prompt for reflect (GH-786)
- **depends_on**: null
- **produces**:
  - Rewritten `plugin/ralph-playwright/skills/reflect/SKILL.md:22-30` — categorized checklist (layout integrity, typography, imagery, state visibility, visual hierarchy, chart & data UIs, viewport/responsive)
  - Schema-conformant outputs remain valid (signal-report still passes validate-primitive-io.sh)
- **consumes**: none (SKILL.md edit is self-contained; preferred-model hint from A is optional)
- **Estimated atomics**: 1-2
- **Parallel with A**: yes. The categorized prompt helps regardless of which model runs reflect — a richer prompt is strictly better under Sonnet too.

### Feature C: Route reflect by step importance (GH-787)
- **depends_on**: [GH-785]
- **produces**:
  - Escalation rules in `plugin/ralph-playwright/skills/reflect/SKILL.md` — Sonnet on happy paths, Opus 4.7 on `outcome=fail` or prior-signal steps
  - Per-step model-used annotation in signal-report sidecar or journey-trace extension
- **consumes**: Feature A's model-selection slot
- **Estimated atomics**: 1-2
- **Why after A**: the escalation ladder needs a defined reflect-model slot to escalate into. Cannot land before A.

### Feature D: Pixel-computed color contrast in a11y-scan (GH-788)
- **depends_on**: null (can run before or alongside A/B, but benefits from A)
- **produces**:
  - Contrast-estimation prompt in `plugin/ralph-playwright/skills/a11y-scan/SKILL.md` reflect step
  - Output convention: `a11y_violation` with tag `[pixel-computed]` — or new `contrast_violation` signal type (decide in plan)
  - Large-text threshold compliance (4.5:1 normal, 3:1 for >= 18pt or >= 14pt bold)
- **Estimated atomics**: 1-2 (prompt + threshold doc + fixture-based validation)
- **Note**: if this feature introduces a new signal type, it must update `schemas/signal-report.schema.yaml:23` enum AND the hook validator in the same change, mirroring the pattern in #793.

### Feature E: Alt-text relevance validation via screenshot (GH-789)
- **depends_on**: null
- **produces**:
  - Alt-relevance prompt in `plugin/ralph-playwright/skills/a11y-scan/SKILL.md`
  - `a11y_violation` with tag `[alt-relevance]` for mismatches; decorative images (`alt=""`) pass
- **Estimated atomics**: 1-2
- **Parallel with D**: yes. Both are a11y-scan extensions that read screenshots; they can land independently.

### Feature F: Annotated evidence screenshots with bounding boxes (GH-790)
- **depends_on**: null
- **produces**:
  - `schemas/signal-report.schema.yaml:33-46` — `bboxes` array added to evidence block (fields: `screenshot`, `x`, `y`, `w`, `h`, `note`)
  - Updated `hooks/scripts/validate-primitive-io.sh` accepting `bboxes`
  - Chosen annotation renderer — one of (a) playwright-cli `annotate` subcommand, (b) Node helper using `sharp`, (c) SVG sidecar overlays — decision recorded in the plan
  - `*.annotated.png` emitted alongside originals; both promoted in act phase
  - Reflect SKILL.md teaches the model to populate `bboxes` when applicable
- **consumes**: none directly, but Feature B's structured prompt makes bbox population more likely in practice
- **Pre-split atomics**: #803 (design spike), #805 (schema), #808 (hook validator), #811 (renderer impl), #814 (SKILL.md), #817 (act-phase promotion). Dependency chain: #803 -> #805 -> #808 -> #811 -> #814 -> #817.
- **Estimated atomics**: 6 (already split)

### Feature G: In-loop semantic visual diff (GH-791)
- **depends_on**: [GH-785, GH-786]
- **produces**:
  - `--baseline PATH` flag on reflect (or new `reflect-diff` sub-skill)
  - Step matcher: primary by `(action, target)`, fallback to index
  - Opus 4.7 semantic-diff prompt that ignores anti-aliasing, font hinting, animation frames, timestamps
  - `regression` signals with natural-language change descriptions
  - Baseline storage `thoughts/local/baselines/<session-slug>/` (gitignored)
  - `--update-baseline` action
  - `skills/visual-diff/SKILL.md` documents the Chromatic/Applitools-vs-in-loop split
- **consumes**: Feature A (Opus 4.7 reflect slot) and Feature B (structured visual reasoning)
- **Pre-split atomics**: #806 (baseline storage scaffolding), #809 (baseline trace-YAML refs + step matcher), #813 (semantic diff prompt + regression emitter), #816 (reflect-phase wiring + CLI flags), #820 (documentation + noise-floor pilot). Dependency chain: #806 -> #809 -> #813 -> #816 -> #820.
- **Estimated atomics**: 5 (already split)
- **Why after A and B**: the diff prompt is a specialization of the reflect prompt; it only makes sense once Opus 4.7 is routed to reflect (A) and the visual-audit prompt structure exists (B). Landing G first would produce brittle overlapping prompt scaffolding.

### Feature H: Vision-fallback element targeting for canvas/maps/bad-a11y (GH-792)
- **depends_on**: null
- **produces**:
  - No-ref-available trigger in story-runner and explorer
  - Opus 4.7 vision-locator prompt resolving natural-language target -> pixel coordinates
  - `playwright-cli click --x --y` coordinate action
  - Fallback orchestration (a11y-first, vision-fallback) — "NEVER use CSS selectors" rule stays for accessible elements
  - Journey-trace telemetry for fallback usage
  - Test fixtures covering canvas/map/bad-a11y pages
- **Pre-split atomics**: #797 (no-ref trigger), #798 (vision-locator prompt), #799 (click-by-coordinate), #800 (fallback orchestration), #801 (telemetry), #802 (test fixtures). Dependency chain: (#797, #798, #799) -> #800 -> #801 -> #802.
- **Estimated atomics**: 6 (already split)
- **Independence**: does not depend on other features in this epic; touches different surfaces (agents + playwright-cli click path).

### Feature I: `data_interpretation` signal type (GH-793)
- **depends_on**: null
- **produces**:
  - `schemas/signal-report.schema.yaml:23` enum extended with `data_interpretation`
  - `skills/reflect/SKILL.md:35-41` taxonomy table documents the type with examples
  - Hook validator updated if strict enum check is enforced
  - Optional 1-2 example signals in a test fixture
- **Estimated atomics**: 1 (XS)
- **Independence**: smallest feature. Can land first or last; no coupling.

### Feature J: `--high-res` screenshot flag for critical steps (GH-794)
- **depends_on**: null
- **produces**:
  - `--high-res` flag on the playwright-cli screenshot call path
  - Documentation for when to use it (OCR, dense tables, receipts, charts, failure re-capture)
  - Confirmation that underlying playwright-cli accepts resolution override
  - Optional empirical token cost measurement on a real session
- **Estimated atomics**: 1-2
- **Independence**: capture-path change only; touches explorer/story-runner at a narrow point.

### Feature K: Vision-driven exploration mode in explorer-agent (GH-795)
- **depends_on**: null
- **produces**:
  - `--vision-first` mode flag on explore skill and explorer-agent
  - Vision-first decision prompt in explorer-agent
  - `decision_mode` and `vision_rationale` fields in journey-trace schema
  - Success-metrics logging + ref-vs-vision comparison summary
  - Demo and validation on a poor-a11y test target
  - Documentation for when to reach for it
- **Pre-split atomics**: #804 (mode flag), #807 (vision-first prompt), #810 (schema fields), #812 (success metrics), #815 (docs), #818 (demo on poor-a11y target). Dependency chain: #804 -> (#807, #810) -> #812 -> #818 -> #815.
- **Estimated atomics**: 6 (already split)

### Feature L: Sad-path inference from screenshots in story-gen (GH-796)
- **depends_on**: null
- **produces**:
  - Vision-grounded sad-path generation option in `skills/story-gen/SKILL.md`
  - Detection: missing error handlers, empty-state design gaps, tooltip viewport overflow, form fields without visible validation hints
  - Generated sad paths emitted alongside existing heuristic-based ones
  - User chooses which to keep before writing stories YAML
  - Documentation for the new option
- **Pre-split atomics**: #819 (design prompt), #821 (output schema), #822 (pipeline wiring), #823 (explorer-agent feed for URL mode), #824 (test coverage).
- **Estimated atomics**: 5 (already split)
- **Independence**: only touches story-gen; no reflect-pipeline coupling.

## Integration Strategy

The 12 features compose cleanly because they touch distinct surfaces inside a pipeline that is already strictly schema-enforced. Integration is primarily sequential at the two coupling points below; everything else is parallel.

### Coupling points

1. **Reflect-phase trinity (A -> C, A+B -> G)**. Features A, B, C form the reflect-phase core. A declares the model slot, B rewrites the prompt, C adds escalation. G (semantic diff) consumes both A (Opus 4.7 routing) and B (structured prompt) and must land after them. This is the critical path for the epic.

2. **Schema additions (F, I, and possibly D)**. Each schema change to `signal-report.schema.yaml` must update the hook validator in `hooks/scripts/validate-primitive-io.sh` in the same PR. F adds `bboxes`, I adds the `data_interpretation` enum entry, and D may add `contrast_violation`. These changes are additive and commute — any order is fine — but each PR must ship schema + hook + documentation together or the pipeline rejects its own outputs.

### Shared integration tests

Every feature plan must include at least one end-to-end validation that runs the relevant skill against a real fixture and confirms:

- The resulting YAML validates against the updated schema
- `hooks/scripts/validate-primitive-io.sh` does not reject Read or Write
- Signal quality improves qualitatively (where the feature targets signal quality)

Shared fixtures live under (recommended) `plugin/ralph-playwright/fixtures/` — a new directory introduced by whichever feature needs test pages first. Canvas-heavy page, low-contrast page, poor-a11y page, chart-dense page — add them lazily as features require.

### Deployment order

- **Wave 1 (parallel)**: A (#785), B (#786), D (#788), E (#789), F (#790), H (#792), I (#793), J (#794), K (#795), L (#796)
- **Wave 2 (after A)**: C (#787)
- **Wave 3 (after A and B)**: G (#791)

No feature requires a staged rollout — all changes are developer-facing (new prompts, schemas, flags, env vars). Users opt in via flags or env vars; defaults remain conservative.

### Release cadence

Ship features independently; no "release train" is required. Ralph-playwright is skills/agents-only — no npm publish, no version bump ceremony. Merge order should respect the dependency graph but each merge is releasable.

## Feature Sequencing

Feature execution order is derived from the `depends_on` graph in the Feature Decomposition above. Features with `depends_on: null` can be planned in parallel. Features with `depends_on: [GH-NNN]` wait until the referenced feature's plan is complete before planning begins.

- **Round 1 (no deps — plan in parallel)**: A (#785), B (#786), D (#788), E (#789), F (#790), H (#792), I (#793), J (#794), K (#795), L (#796)
- **Round 2 (after A is planned)**: C (#787)
- **Round 3 (after A and B are planned)**: G (#791)

No separate wave section is needed — the dependency graph IS the sequencing.

After committing this plan-of-plans document, feature-level `depends_on` edges are synced to GitHub `blockedBy` relationships using `sync_plan_graph`.

## What We're NOT Doing

Explicitly out of scope for this epic:

- **Swapping the execute-phase agent model off Sonnet.** Execute stays on Sonnet (mechanical click/fill). Changing it is a separate question, tracked nowhere.
- **Changing playwright-cli internals beyond the specific hooks.** The `--high-res` flag (J) and click-by-coordinate (H) are the only additions; the CLI's wire protocol to Playwright stays as-is.
- **Replacing Chromatic/Applitools.** Storybook-component-level visual diffing stays with those tools. Feature G adds journey-level diffing and complements them — documented clearly in `skills/visual-diff/SKILL.md` as part of G.
- **Moving reflect into a sub-agent.** Reflect continues to run in the calling model's context. This keeps the agent tool-allowlist narrow and lets Opus 4.7 route through natural model-switching rather than an agent frontmatter change.
- **OCR tooling integration.** `--high-res` is the OCR enabler; no new PIL/Tesseract dependency is introduced. Opus 4.7's pixel-level transcription is the answer.
- **Prompt caching, cost metrics dashboards, or routing dashboards.** Per-step model recording (Feature C) produces the data; aggregation/reporting is a future feature, not this epic.
- **Schema migrations that break older signal-reports or journey-traces.** All schema changes in this epic are additive. Old artifacts remain readable.
- **Per-viewport / per-device orchestration.** Screenshots continue to be captured at one viewport per step. Multi-viewport audits are a separate concern.
- **Model swap for explorer-agent/story-runner-agent.** Both stay on Sonnet. Vision-first exploration (K) is a prompt-shape change, not a model change.
- **Cross-repo coordination.** All 12 features land in `cdubiel08/ralph-hero`; the ralph-playwright plugin is a sibling of ralph-hero / ralph-knowledge inside the same monorepo.
