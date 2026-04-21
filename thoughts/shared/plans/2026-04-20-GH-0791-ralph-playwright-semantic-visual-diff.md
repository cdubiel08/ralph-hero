---
date: 2026-04-20
status: complete
type: plan-of-plans
github_issue: 791
github_issues: [791, 806, 809, 813, 816, 820]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/791
primary_issue: 791
parent_plan: thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md
child_plans:
  - thoughts/shared/plans/2026-04-20-GH-0806-baseline-screenshot-storage-scaffolding.md
  - thoughts/shared/plans/2026-04-20-GH-0809-baseline-trace-yaml-refs-step-matcher.md
  - thoughts/shared/plans/2026-04-20-GH-0813-semantic-diff-prompt-regression-emitter.md
  - thoughts/shared/plans/2026-04-20-GH-0816-reflect-phase-wiring-baseline-cli-flags.md
  - thoughts/shared/plans/2026-04-20-GH-0820-document-visual-diff-split-noise-floor-pilot.md
tags: [ralph-playwright, opus-4-7, semantic-diff, regression, reflect-phase, visual-diff, baseline]
---

# ralph-playwright: in-loop semantic visual diff — Feature Plan

## Prior Work

- builds_on:: [[2026-04-16-opus-4-7-ralph-playwright-vision]]
- builds_on:: [[2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic]]
- builds_on:: [[2026-04-20-GH-0785-ralph-playwright-reflect-opus-4-7-model-routing]]
- builds_on:: [[2026-04-20-GH-0786-reflect-structured-visual-audit-prompt]]

## Overview

Feature G of the #784 epic (Round 3 — blocked by Features A/#785 and B/#786, both now MERGED in PRs #825/#826). Five pre-split atomic sub-issues form a single user-visible capability: **in-loop semantic visual diff** — the `regression` signal type gets its first mechanism. Prior art (Chromatic/Applitools) stays for Storybook-component granularity; this work fills the *journey-level* gap where a multi-step flow changes visibly between runs and no in-loop reflect signal fires today.

| Phase | Issue | Title | Estimate | depends_on |
|-------|-------|-------|----------|------------|
| 1 | [GH-806](https://github.com/cdubiel08/ralph-hero/issues/806) | baseline screenshot storage scaffolding | XS | null |
| 2 | [GH-809](https://github.com/cdubiel08/ralph-hero/issues/809) | baseline trace-YAML refs + step matcher | S | [GH-806] |
| 3 | [GH-813](https://github.com/cdubiel08/ralph-hero/issues/813) | Opus 4.7 semantic diff prompt + regression signal emitter | S | [GH-809] |
| 4 | [GH-816](https://github.com/cdubiel08/ralph-hero/issues/816) | reflect-phase wiring + `--baseline` / `--update-baseline` CLI flags | S | [GH-813] |
| 5 | [GH-820](https://github.com/cdubiel08/ralph-hero/issues/820) | document visual-diff split + noise-floor pilot | XS | [GH-816] |

**Why strictly sequential**: unlike Feature F (#790, bbox evidence) where schema and renderer chains could run in parallel, this capability is a linear pipeline — storage under-girds matching, matching feeds the prompt, the prompt produces signals, signals merge into reflect output, and documentation closes the loop with pilot-validated defaults. No atomic can be exercised end-to-end without its predecessor.

**What gets produced at feature end**:
- A `thoughts/local/baselines/<session-slug>/` storage convention (gitignored)
- `journey-trace.yaml` schema extension: optional per-step `baseline_ref` field
- `matchSteps(currentTrace, baselineTrace)` returning `{ pairs, addedInCurrent, missingFromCurrent }`
- An Opus 4.7 semantic-diff prompt that ignores rendering noise and emits natural-language `regression` signals
- Reflect-phase integration via `--baseline PATH` and `--update-baseline` flags
- A clear SKILL.md layer division: in-loop journey-level (this feature) vs Chromatic/Applitools (Storybook-component-level)
- A pilot-validated default for the `--noise-floor` knob

## Shared Constraints

Inherited verbatim from the parent plan-of-plans (`thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md`). Extended with feature-specific constraints at the bottom.

### Architecture & file ownership (from parent)

- The Execute -> Reflect -> Act pipeline is strict and schema-enforced. Any new inputs/outputs flow through the three YAML schemas in `plugin/ralph-playwright/schemas/`: `journey-trace.schema.yaml`, `signal-report.schema.yaml`, `action-log.schema.yaml`. Schema additions must be additive (new optional fields) unless explicitly noted.
- Hooks in `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` validate journey-trace, signal-report, and action-log YAMLs at Read and Write boundaries. Any schema change that tightens validation must update the hook in the same PR.
- Execute runs as a sub-agent (`explorer-agent` or `story-runner-agent`) with `model: sonnet`. Reflect runs in the calling model's context — that is the sole tier where Opus 4.7 routing applies. This feature targets reflect exclusively.
- Screenshots (PNG) and accessibility snapshots (`.md`) are captured at EVERY step. The semantic diff consumes screenshots produced by the normal capture pipeline; it introduces no new capture responsibility.

### Model routing discipline (from parent)

- Reflect is already routed to Opus 4.7 by frontmatter (#785, MERGED in PR #825). The semantic-diff prompt *extends* reflect, inheriting that routing. No parallel routing mechanism is introduced.
- `RALPH_PLAYWRIGHT_REFLECT_MODEL` env override continues to apply. Operators who pin reflect to Sonnet accept weaker diff quality — the prompt is designed to degrade, not break.

### Prompt engineering conventions (from parent)

- Categorized checklists beat free-form instructions. The semantic-diff prompt builds on the seven-category structured audit rubric shipped by #786 (PR #826) — it is a specialization, not a replacement.
- **Explicit ignore list is non-negotiable**: anti-aliasing, font hinting, animation frames, timestamps, cursor/caret position, minor sub-pixel rendering. Stated verbatim in the prompt per the parent plan.
- Output: natural-language change descriptions (e.g. "Submit button moved ~40px down and lost its drop shadow"). No bare diff images embedded in signals. The signal carries pointers to baseline + current screenshots for reviewer context.

### Cost & token envelope (from parent)

- Semantic diff doubles per-step token input (baseline + current screenshots). This is intentional and opt-in via `--baseline`. Default reflect runs (no baseline) are unchanged.
- Default resolution stays at viewport. High-res (#794) and semantic-diff are independently opt-in. Pairing both is permitted but not automatic — operators compose them when the OCR-grade detail actually matters for diff fidelity.

### Artifact paths (from parent, with feature extension)

- Session data: `.playwright-cli/<session>/` (journey-trace.yaml, signal-report.yaml, action-log.yaml, screenshots, snapshots).
- Promoted evidence: `thoughts/local/assets/<session>/` for both original and annotated screenshots.
- **Baselines for semantic diff (this feature)**: `thoughts/local/baselines/<session-slug>/` — gitignored. The `<session-slug>` namespace is the *session slug* of the journey being baselined (i.e., the slug under `.playwright-cli/` minus the timestamp prefix, or the explicit slug if the user specified one). The storage atomic (#806) formalizes the slug-resolution rule.

### Verification tooling (from parent)

Ralph-playwright is skills/agents-only — there is no build/test matrix for the plugin itself. Feature verification is phase-specific:

- **Schema changes** (#809 extends `journey-trace.schema.yaml` with `baseline_ref`) — run a sample pipeline that reads/writes the affected YAML, confirm `validate-primitive-io.sh` does not reject.
- **Prompt changes** (#813 adds the semantic-diff prompt) — run the updated flow on one real journey with a known layout change; qualitatively assess signal quality.
- **Runtime changes** (#816 wires `--baseline` / `--update-baseline` CLI flags) — exercise on a fixture with a known layout change between runs; confirm a `regression` signal fires, and absent that change, none fires.
- **Documentation + pilot** (#820) — rewrite `skills/visual-diff/SKILL.md` intro, capture the pilot's false-positive / true-positive rates, justify the default noise-floor.

### Research anchoring (from parent)

This feature implements §Part 3 Item 7 ("In-loop semantic visual diff") of the research doc. Every atomic plan cites this anchor. Also cites the Open Question on "Semantic-diff noise floor" — the pilot sub-issue (#820) closes it.

### Feature-specific constraints

- **No parallel regression mechanism.** Opus 4.7 reflect routing (#785/PR #825) + structured visual audit prompt (#786/PR #826) are the foundation. The semantic-diff prompt EXTENDS the audit prompt (cites the seven categories as framing) — it does not introduce its own audit checklist. Concretely: a reviewer reading the final diff prompt should see "this is reflect's Step 2 visual audit, narrowed to A/B comparison".
- **Backward-compatible schema evolution.** `journey-trace.schema.yaml` gains an OPTIONAL per-step `baseline_ref` field. Existing traces without `baseline_ref` must continue to validate. The hook validator (`validate-primitive-io.sh`) gets a minimal pass-through addition; non-present means "no baseline comparison available for this step", not "invalid trace".
- **Step-matcher contract is small and stable.** `matchSteps(currentTrace, baselineTrace) -> { pairs: [{current, baseline}], addedInCurrent: [...], missingFromCurrent: [...] }`. Primary match key: normalized `(action, target)` tuple (trim/lowercase, collapse whitespace). Fallback: index-wise alignment when `(action, target)` is missing, ambiguous, or duplicated. Downstream atomics (#813 prompt, #816 wiring) consume this exact shape — any shape change requires a plan revision.
- **Regression signals do NOT embed diff images.** Per taxonomy, each emitted signal carries: `type: regression`, `title`, `description` (natural language change), `evidence: { steps: [current-index], screenshots: [current-path, baseline-path] }`. No new schema field is introduced; `regression` was already in the enum (see `signal-report.schema.yaml:23`). If a reviewer wants to see the diff, they open the two referenced screenshots.
- **`--update-baseline` is an explicit action, never implicit.** Reflect with `--baseline` ONLY reads the baseline; it never writes. `--update-baseline` is a distinct invocation that promotes a completed run's screenshots into the baseline dir (overwriting prior baselines). This separation prevents accidental baseline drift during normal exploration.
- **Missing baseline fails loudly.** `--baseline PATH` pointing at a baseline with no screenshots for the matched steps must emit a clear, actionable error — not silently produce empty-diff signals. The #816 plan owns this guard.
- **Noise-floor default is evidence-backed.** The `--noise-floor` knob ships with a default set by the pilot (#820), not by intuition. The pilot must report: false-positive rate on an unchanged run (target: ≤1 noise signal per 10 steps at default), and true-positive rate on the known-change run (target: ≥1 regression signal fires on the intentional change).
- **Chromatic/Applitools stays.** `skills/visual-diff/SKILL.md` is rewritten, not deleted. The two-layer framing is an explicit division of labor documented in #820.

## Current State Analysis

### Reflect today (post-#785, #786)

`plugin/ralph-playwright/skills/reflect/SKILL.md` (209 lines):
- Frontmatter sets `model: claude-opus-4-7` (post-#785, PR #825).
- Step 2 contains the structured seven-category visual audit (post-#786, PR #826), with concrete examples and signal-type mappings.
- Step 3 signal taxonomy (line 93) already documents `regression`: "Something that previously worked now fails (requires baseline comparison)" — but notes "requires baseline comparison" without any mechanism. THIS FEATURE FILLS THAT GAP.
- Step 4 YAML example shows the evidence block including `bboxes[]` (post-#790). No baseline or diff concepts yet.
- `allowed-tools: [Read, Write]` — no additional tools needed by this feature (prompt-only change for #813; schema/helper for #806 and #809; doc and CLI for #816 and #820).

### Visual-diff skill today

`plugin/ralph-playwright/skills/visual-diff/SKILL.md` (45 lines):
- Entirely delegates to Chromatic (default) or Applitools (alternative). Storybook-story granularity, outside the agent loop.
- No mention of in-loop or journey-level comparison.
- No cross-reference to `skills/reflect/SKILL.md`.

### Journey-trace schema today

`plugin/ralph-playwright/schemas/journey-trace.schema.yaml`:
- Step `required: [index, action, target, outcome, screenshot, snapshot, console, duration_ms]` (line 42).
- Optional fields already include: `error`, `decision_mode`, `vision_rationale`, `targeting_method`, `vision_fallback`, `capture`. Pattern for adding optional fields is well-established.
- `baseline_ref` slots in as a new optional string property pointing at a path under `thoughts/local/baselines/<session-slug>/`.

### Signal-report schema today

`plugin/ralph-playwright/schemas/signal-report.schema.yaml`:
- Signal type enum already contains `regression` (line 23). **No schema change needed for the signal itself** — only the mechanism.
- Evidence block: `steps`, `screenshots`, optional `bboxes`. Adequate for diff signals (two screenshots: current + baseline; one step index).

### Hook validator today

`plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh`:
- Enum checks for step `outcome`, `decision_mode`, `targeting_method`, `vision_fallback.trigger_reason`, `vision_fallback.click_outcome`.
- Enum checks for signal `type` and `severity`.
- Bbox structural checks (post-#808).
- **Does NOT** validate `baseline_ref` — minimal addition needed: none, actually, because the field is an optional string; existing "unknown optional field" behavior is pass-through.

### Baseline storage today

Nothing exists. `thoughts/local/` holds `assets/` (post-promotion screenshots). Adding a sibling `baselines/` directory is trivial; the gitignore add is one line.

### Pipeline ordering reminder

Semantic diff is a SPECIALIZATION of Step 2 in reflect, not a new skill. The parent plan-of-plans §Feature G specifically says `depends_on: [GH-785, GH-786]` because:
- Without #785, reflect runs on whatever model the caller uses — often Sonnet, which downsamples and cannot diff reliably.
- Without #786, the visual audit prompt is a one-liner; the diff prompt would either duplicate the seven-category structure (bad — drift risk) or reference a structure that doesn't exist (bad — empty pointer).
- With both landed, the diff prompt can cite the audit categories and inherit Opus 4.7 reflect routing without re-declaring either.

## Desired End State

After all five atomics merge:

- Operators can run reflect with `--baseline PATH` pointing at a prior `journey-trace.yaml`. The current run's screenshots are compared against the baseline's screenshots on matched steps; a `regression` signal fires for each meaningful change.
- Operators can run `--update-baseline` to promote a completed run's screenshots into the baseline dir for the given session slug.
- A first-ever run (no baseline) is indistinguishable from today's reflect — no regression.
- `thoughts/local/baselines/` is gitignored; baselines never leak into the monorepo.
- `skills/reflect/SKILL.md` documents the flag, the refresh workflow, and the ignore list. It cross-links to `skills/visual-diff/SKILL.md`.
- `skills/visual-diff/SKILL.md` opens with the two-layer framing (in-loop journey-level vs Chromatic/Applitools Storybook-component-level), includes a decision guide, and embeds a pilot-derived worked example.
- The `--noise-floor` default is justified by pilot data (false-positive rate on unchanged run, true-positive rate on known-change run).

### Verification (feature-level, rolls up atomics)

- [ ] `thoughts/local/baselines/` appears in `.gitignore`
- [ ] `thoughts/local/baselines/<session-slug>/` helper round-trips: write screenshot, read screenshot, clear "missing baseline" error on absent reads
- [ ] `journey-trace.yaml` schema validates with and without `baseline_ref` (backward compat)
- [ ] `matchSteps` returns expected pairs/added/missing on the four canonical scenarios (exact, reorder, added, removed)
- [ ] `matchSteps` falls back to index on duplicate or missing `(action, target)` pairs
- [ ] Semantic-diff emitter returns zero signals on identical input pairs
- [ ] Semantic-diff emitter returns zero signals on AA/font-hinting/timestamp noise
- [ ] Semantic-diff emitter fires exactly one `regression` signal on a real layout shift fixture
- [ ] `--baseline PATH` flag integrates diff signals into the signal report produced by reflect
- [ ] `--update-baseline` refreshes baselines for the specified session slug and is distinct from `--baseline`
- [ ] Empty-baseline-directory case fails loudly with an actionable message
- [ ] `skills/reflect/SKILL.md` documents `--baseline` and `--update-baseline` with an example invocation
- [ ] `skills/visual-diff/SKILL.md` opens with the two-layer framing; includes a decision guide; embeds a worked example from the pilot
- [ ] Cross-links between `reflect/SKILL.md` and `visual-diff/SKILL.md` render on GitHub
- [ ] Noise-floor default is documented in code comments AND in the visual-diff SKILL.md, justified by pilot data (false-positive rate on unchanged run, true-positive rate on known-change run)

## What We're NOT Doing

- **Not replacing Chromatic/Applitools.** Storybook-component-level visual diffing stays with those tools. This feature adds journey-level diffing and complements them. `visual-diff/SKILL.md` retains Chromatic setup instructions.
- **Not introducing a new signal type.** `regression` already exists in the enum. No schema-enum expansion; no validator change for the signal type.
- **Not embedding diff images.** Signal `evidence` carries filename pointers (current + baseline). Reviewers open the files; the pipeline does not produce a third "diff.png" artifact.
- **Not building a pixel-level diff tool.** The Opus 4.7 prompt *is* the diff mechanism. No ImageMagick / `sharp` / `pixelmatch` dependency is introduced.
- **Not committing baselines to git.** `thoughts/local/baselines/` is gitignored by design; baselines are per-developer state, like `.playwright-cli/` session data.
- **Not running semantic diff by default.** Absence of `--baseline` means absence of diffing — zero change to current reflect behavior.
- **Not altering capture resolution for diffs.** Default viewport capture is the baseline substrate. `--high-res` (#794) can be combined explicitly; no auto-escalation.
- **Not handling baseline-schema-drift.** If the baseline was captured with an older journey-trace schema, a best-effort read is attempted; incompatible shape errors on the loud-fail path. No migration tooling.
- **Not modifying the execute phase.** Both `explorer-agent` and `story-runner-agent` stay as-is. The diff reads from existing journey-trace outputs.
- **Not building multi-baseline merging.** One baseline per run. No "compare against best-of-three" ensemble logic.
- **Not cross-browser or cross-viewport diffing.** One screenshot per step, one baseline per step. Multi-viewport is a separate concern (out of the epic entirely).
- **Not annotating diff regions on screenshots.** Bbox annotation (#790) is its own feature. A regression signal may CARRY bboxes via #790's evidence extension (any signal type can), but the diff emitter does not *require* bbox output from the model.

## Implementation Approach

Strictly sequential. Each atomic's output is the next atomic's input:

```
#806 (storage scaffolding)
  └─> #809 (trace-YAML refs + step matcher)
        └─> #813 (semantic diff prompt + regression emitter)
              └─> #816 (reflect-phase wiring + CLI flags)
                    └─> #820 (documentation + noise-floor pilot)
```

**Why not parallel**: unlike #790 where schema and renderer chains converged at the end, here each atomic's primary artifact is consumed directly by the next. Storage → matcher (reads from storage), matcher → prompt (pairs fed to prompt), prompt → wiring (emitter invoked from reflect), wiring → doc (pilot measures wiring behavior). No "convergence point" exists.

**Recommended execution order (matches atomic numbering)**: #806 → #809 → #813 → #816 → #820. This is the order on the issue, the order in the dependency chain, and the order the sub-issues were pre-split.

### Cross-cutting file inventory

| File | Touched by | Change kind |
|------|------------|-------------|
| `.gitignore` | #806 | Add `thoughts/local/baselines/` |
| `plugin/ralph-playwright/scripts/baseline-store.mjs` (new) | #806 | Helper: `writeBaseline`, `readBaseline`, slug resolution |
| `plugin/ralph-playwright/schemas/journey-trace.schema.yaml` | #809 | Add optional `baseline_ref: string` under step properties |
| `plugin/ralph-playwright/scripts/match-steps.mjs` (new) | #809 | `matchSteps(current, baseline)` + unit tests |
| `plugin/ralph-playwright/skills/reflect/references/semantic-diff-prompt.md` (new) | #813 | Prompt template: inputs, ignore list, output format |
| `plugin/ralph-playwright/scripts/diff-emitter.mjs` (new) | #813 | Emitter: invokes Opus 4.7 on paired screenshots, parses into `regression` signals |
| `plugin/ralph-playwright/skills/reflect/SKILL.md` | #816 | Add `--baseline` / `--update-baseline` step; wire to emitter |
| `plugin/ralph-playwright/skills/visual-diff/SKILL.md` | #820 | Rewrite intro; add two-layer framing; embed worked example |
| `thoughts/shared/research/YYYY-MM-DD-semantic-diff-noise-floor-pilot.md` (new) | #820 | Pilot report with false-positive / true-positive rates |

Atomic-level plans scope their individual file touches when they enter `/ralph-plan`.

### How the storage convention propagates

A single additive scaffolding atomic (#806) establishes:
- Directory layout: `thoughts/local/baselines/<session-slug>/<step-id>.png`
- `.gitignore` entry
- `writeBaseline(sessionSlug, stepId, sourcePath)` / `readBaseline(sessionSlug, stepId)` helpers
- Explicit, testable "missing baseline" error path

Every downstream atomic references this contract:
- #809 embeds `baseline_ref` in journey-trace (relative paths under the session-slug directory)
- #813 calls `readBaseline` to load the comparison target
- #816 calls both helpers — `readBaseline` under `--baseline`, `writeBaseline` under `--update-baseline`
- #820 documents the convention as the user-facing storage contract

A change to the storage shape (e.g., nested subdirs per viewport) requires looping back through #806 first. Keep #806 minimal — no viewport sharding, no compression, no hashing. Plain `<session-slug>/<step-id>.png`.

### The step-matcher's gating contract

`matchSteps(currentTrace, baselineTrace)` is the single choke point for alignment. Its return shape `{ pairs, addedInCurrent, missingFromCurrent }` is consumed as-is by #813 (iterate `pairs` for diff calls, iterate `addedInCurrent` / `missingFromCurrent` for informational signals). Reshaping after #813 lands requires revising the prompt's input contract — avoid.

The parent plan notes the matcher is primary-key `(action, target)` with index fallback. Concrete rules (#809's responsibility):
- Normalize `(action, target)` before comparison: trim, lowercase, collapse internal whitespace runs. Rationale: Playwright action strings are user-input and easily drift on whitespace.
- Duplicate keys (same `(action, target)` appearing twice in a trace): fall back to index-wise pairing for the duplicates only — the first occurrence matches the first, second matches second, etc. Report remaining unmatched as added/missing as normal.
- Missing keys (baseline step has no `action` or no `target`): fall back to index-wise for that step only.
- Extra current steps: populate `addedInCurrent`. Missing from current: populate `missingFromCurrent`.

### The noise-floor pilot's gating decision

#820 runs ≥1 real journey twice:
- Run A (unchanged): same URL, same fixture, default noise-floor. Count any non-zero `regression` signals as false positives.
- Run B (known change): intentional layout shift injected (CSS change, DOM structure tweak). Count any step where a `regression` signal fires correctly as a true positive.

Default `--noise-floor` setting is tuned so:
- Run A false-positive rate ≤1 noise signal per 10 steps (target; if unattainable, document why and the chosen trade-off)
- Run B true-positive rate ≥1 regression fires on the intended change

The rate math and the chosen default value become verbatim content in `visual-diff/SKILL.md` via the pilot doc.

---

## Phase 1: GH-806 — baseline screenshot storage scaffolding

- **depends_on**: null

### Overview

Establish the on-disk baseline storage layout and minimal helpers. No diff behavior, no CLI flags, no schema changes. Subsequent atomics consume these helpers.

### Scope (references full atomic issue)

See [GH-806](https://github.com/cdubiel08/ralph-hero/issues/806). The atomic's own detailed implementation plan will be produced when it enters `/ralph-plan`.

### Phase Success Criteria

- [ ] `.gitignore` includes `thoughts/local/baselines/` (one-line add, placed near existing `.playwright-cli/` line)
- [ ] `plugin/ralph-playwright/scripts/baseline-store.mjs` (or shell equivalent) exposes `writeBaseline(sessionSlug, stepId, sourcePath)` and `readBaseline(sessionSlug, stepId)` entry points
- [ ] "Missing baseline" error path emits a clear, actionable message citing the session-slug and step-id
- [ ] Path convention `thoughts/local/baselines/<session-slug>/<step-id>.png` documented in a SKILL.md or reference MD
- [ ] Unit smoke test (or test harness invocation) confirms round-trip: write a fixture PNG, read it back, read an absent step errors loudly
- [ ] No CLI flag, no reflect-SKILL touch, no schema touch

**Creates for next phase**: The storage helpers #809 and #813 both call; the path convention `thoughts/local/baselines/<session-slug>/<step-id>.png` that #809 embeds in `baseline_ref`.

---

## Phase 2: GH-809 — baseline trace-YAML refs + step matcher

- **depends_on**: [GH-806]

### Overview

Extend `journey-trace.schema.yaml` with an optional per-step `baseline_ref` field and implement `matchSteps(currentTrace, baselineTrace)` returning pairs plus unmatched entries. Storage helper from #806 is consumed — no re-implementation.

### Scope (references full atomic issue)

See [GH-809](https://github.com/cdubiel08/ralph-hero/issues/809). The atomic's own detailed implementation plan will be produced when it enters `/ralph-plan`.

### Phase Success Criteria

- [ ] `journey-trace.schema.yaml` documents the optional `baseline_ref: string` field under step properties (additive; existing traces remain valid)
- [ ] `validate-primitive-io.sh` accepts traces with and without `baseline_ref` (no new enum to check; unknown optional strings pass through)
- [ ] Trace writer (the code path that emits `journey-trace.yaml`) populates `baseline_ref` when a corresponding baseline exists for the step
- [ ] `matchSteps(currentTrace, baselineTrace)` returns `{ pairs: [{current, baseline}], addedInCurrent: [...], missingFromCurrent: [...] }`
- [ ] Primary key normalization: trim/lowercase/collapse-whitespace on `(action, target)` tuples
- [ ] Fallback: index-wise pairing when primary key is missing, ambiguous, or duplicated
- [ ] Unit tests cover four canonical scenarios: exact match, reorder, extra current step, removed current step, duplicate `(action, target)` disambiguated by index
- [ ] Consumes #806 storage helper — no parallel helper created

**Creates for next phase**: `matchSteps` (the function #813's emitter iterates over) and `baseline_ref` (the trace-side marker #816 uses to confirm baselines were linked).

---

## Phase 3: GH-813 — Opus 4.7 semantic diff prompt + regression signal emitter

- **depends_on**: [GH-809]

### Overview

Author the Opus 4.7 prompt comparing current + baseline screenshots, and implement the emitter that invokes the prompt per matched pair and parses responses into `regression` signals. Consumes `matchSteps` from #809; does not re-match. Noise-floor knob lands here as an internal setting — default pending #820's pilot.

### Scope (references full atomic issue)

See [GH-813](https://github.com/cdubiel08/ralph-hero/issues/813). The atomic's own detailed implementation plan will be produced when it enters `/ralph-plan`.

### Phase Success Criteria

- [ ] Prompt template (under `plugin/ralph-playwright/skills/reflect/references/semantic-diff-prompt.md` or equivalent) explicitly instructs the model to ignore: anti-aliasing, font hinting, animation frames, timestamps, cursor/caret position, minor sub-pixel rendering
- [ ] Prompt consumes the step's `(action, target)` as context so the model grounds its comparison in intent
- [ ] Prompt asks for a bulleted list of meaningful semantic changes as natural-language sentences (e.g., "Submit button moved ~40px down and lost its drop shadow")
- [ ] Prompt returns nothing when differences are below the "meaningful change" threshold (noise floor enforced prompt-side)
- [ ] Emitter returns zero signals on identical pairs (fixture test)
- [ ] Emitter returns zero signals on AA/font-hinting/timestamp-only noise (fixture test)
- [ ] Emitter returns a populated `regression` signal on a real layout-shift fixture (fixture test)
- [ ] Natural-language descriptions follow the "Submit button moved 40px down and lost its shadow" style; raw diff dumps rejected by prompt language
- [ ] `--noise-floor` knob accepts at least `low | medium | high` values, documented in code comments; default value slot reserved for #820 to set
- [ ] Emitter consumes `matchSteps` result directly; does not re-implement matching
- [ ] Signal evidence block populates correctly: `steps: [current-index]`, `screenshots: [current-path, baseline-path]`, `tags` include `semantic-diff` and the noise-floor setting used

**Creates for next phase**: A callable emitter that `#816`'s CLI-flag wiring invokes per matched pair. The signal envelope is schema-valid on emission so #816 can append directly to the reflect-produced signal report.

---

## Phase 4: GH-816 — reflect-phase wiring + `--baseline` / `--update-baseline` CLI flags

- **depends_on**: [GH-813]

### Overview

User-facing integration. Add `--baseline PATH` (or a `reflect-diff` sub-skill — pick whichever is less invasive in `skills/reflect/SKILL.md`) that loads the baseline trace, calls `matchSteps`, iterates matched pairs through the emitter, and merges emitted `regression` signals into the existing reflect signal report. Add `--update-baseline` as a distinct action. Missing-baseline case fails loudly.

### Scope (references full atomic issue)

See [GH-816](https://github.com/cdubiel08/ralph-hero/issues/816). The atomic's own detailed implementation plan will be produced when it enters `/ralph-plan`.

### Phase Success Criteria

- [ ] `--baseline PATH` flag (or `reflect-diff` sub-skill invocation) wired into reflect
- [ ] `--baseline` loads baseline trace, calls `matchSteps`, invokes emitter per matched pair
- [ ] Emitted `regression` signals merge into the existing `signal-report.yaml` alongside reflect's other signals
- [ ] Added / removed steps (from `matchSteps` output) surface as informational signals (NOT `regression`) — map into an appropriate existing type or omit with explanation
- [ ] `--update-baseline` refreshes baselines for the session slug (overwrites prior baselines); explicit action, never implicit
- [ ] `--baseline` and `--update-baseline` are mutually exclusive in a single invocation (no silent coupling)
- [ ] Missing-baseline-directory case fails loudly with an actionable message (references path, session slug, and a hint to run `--update-baseline` first)
- [ ] `skills/reflect/SKILL.md` documents the flag, an example invocation, and the refresh workflow
- [ ] End-to-end smoke: run the flow twice with a known layout change between runs; confirm a `regression` signal fires on the changed step
- [ ] End-to-end smoke: run the flow twice with no change; confirm zero `regression` signals fire
- [ ] `signal-report.yaml` with merged diff signals validates against `signal-report.schema.yaml` via `validate-primitive-io.sh` (exits 0)

**Creates for next phase**: An operable user surface that #820 exercises in the noise-floor pilot.

---

## Phase 5: GH-820 — document visual-diff split + noise-floor pilot

- **depends_on**: [GH-816]

### Overview

Rewrite `skills/visual-diff/SKILL.md` intro to frame the two-layer division (in-loop semantic diff vs Chromatic/Applitools). Run the semantic diff against at least one real journey with a known change; capture the `regression` output; record the false-positive rate (unchanged run) and true-positive rate (known-change run). Set the shipped default `--noise-floor` based on those numbers and cite them in the doc.

### Scope (references full atomic issue)

See [GH-820](https://github.com/cdubiel08/ralph-hero/issues/820). The atomic's own detailed implementation plan will be produced when it enters `/ralph-plan`.

### Phase Success Criteria

- [ ] `skills/visual-diff/SKILL.md` opens with the two-layer framing (in-loop journey-level vs Chromatic/Applitools Storybook-component-level)
- [ ] Decision guide documents which failures belong in which layer (e.g., "component-regression on a single story" → Chromatic; "layout shift mid-journey causing CTA to drop below fold" → in-loop semantic diff)
- [ ] Worked example from a real journey included verbatim: the change, the `regression` signal(s) emitted, the natural-language descriptions
- [ ] Noise-floor default stated and justified by pilot numbers (false-positive rate on unchanged run, true-positive rate on known-change run)
- [ ] Pilot numbers recorded in `thoughts/shared/research/YYYY-MM-DD-semantic-diff-noise-floor-pilot.md` with methodology (URL, fixture change applied, run counts, step counts, signal counts)
- [ ] `skills/reflect/SKILL.md` cross-links to `skills/visual-diff/SKILL.md` (and vice versa) in their "See also" / "References" sections
- [ ] No behavior changes to emitter, storage, or CLI flags — documentation + pilot-result capture only

**Creates for next phase**: None. Feature complete at end of this phase.

---

## Integration Testing

Feature-level verification after all five atomics have landed. Run once as part of closing #791:

1. **Unchanged-run baseline setup.** Pick a stable local URL (e.g., an existing fixture under `plugin/ralph-playwright/fixtures/`). Run `/ralph-playwright:explore <url>` to produce a session. Invoke `reflect --update-baseline` on that session to promote its screenshots as the baseline.
2. **Unchanged-run diff.** Re-run the same `/ralph-playwright:explore <url>` to produce a second session. Invoke `reflect --baseline <first-session-trace>` on the second session. Assert: zero `regression` signals in the resulting `signal-report.yaml` (tolerance: ≤1 noise signal per 10 steps at default `--noise-floor`, consistent with the pilot).
3. **Known-change setup.** Modify the fixture (e.g., change a CTA button's CSS — move, resize, or restyle). This is the intentional regression.
4. **Known-change diff.** Re-run `/ralph-playwright:explore <url>` against the modified fixture; invoke `reflect --baseline <first-session-trace>`. Assert: at least one `regression` signal fires on the modified step with a natural-language description consistent with the introduced change.
5. **Schema compliance.** Confirm the produced `signal-report.yaml` exits 0 through `validate-primitive-io.sh` with `CLAUDE_PLUGIN_ROOT=plugin/ralph-playwright`.
6. **Missing-baseline loud fail.** Invoke `reflect --baseline /nonexistent/path/journey-trace.yaml`. Assert: the flow exits with a clear, actionable error message citing the bad path — does NOT emit empty-diff signals or silently proceed.
7. **`--update-baseline` explicitness.** Invoke `reflect --baseline <X> --update-baseline` together. Assert: rejected (mutually exclusive) with an actionable message, OR documented as a supported refresh-after-diff flow (whichever #816 landed).
8. **Documentation verify.** Open `skills/visual-diff/SKILL.md`; confirm the two-layer framing, decision guide, worked example, and noise-floor justification are present. Open `skills/reflect/SKILL.md`; confirm `--baseline` / `--update-baseline` documentation is present.

Integration tests are documented here so atomic authors know the shape of the umbrella verification; individual atomic PRs do not need to run this end-to-end test.

## References

- Parent epic: [GH-784](https://github.com/cdubiel08/ralph-hero/issues/784)
- This feature: [GH-791](https://github.com/cdubiel08/ralph-hero/issues/791)
- Atomic sub-issues: [GH-806](https://github.com/cdubiel08/ralph-hero/issues/806), [GH-809](https://github.com/cdubiel08/ralph-hero/issues/809), [GH-813](https://github.com/cdubiel08/ralph-hero/issues/813), [GH-816](https://github.com/cdubiel08/ralph-hero/issues/816), [GH-820](https://github.com/cdubiel08/ralph-hero/issues/820)
- Just-shipped prerequisites: [PR #825](https://github.com/cdubiel08/ralph-hero/pull/825) (Feature A — split model routing for #785), [PR #826](https://github.com/cdubiel08/ralph-hero/pull/826) (Feature B — structured visual audit prompt for #786)
- Research: [thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md) §Part 3 Item 7 + Open Questions
- Parent plan-of-plans: [thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md) Feature G
- Key files:
  - [plugin/ralph-playwright/skills/reflect/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/reflect/SKILL.md)
  - [plugin/ralph-playwright/skills/visual-diff/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/visual-diff/SKILL.md)
  - [plugin/ralph-playwright/schemas/journey-trace.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/journey-trace.schema.yaml)
  - [plugin/ralph-playwright/schemas/signal-report.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/signal-report.schema.yaml)
  - [plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh)
