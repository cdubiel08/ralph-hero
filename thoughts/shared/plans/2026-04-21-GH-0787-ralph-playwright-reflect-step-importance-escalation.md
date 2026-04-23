---
date: 2026-04-21
status: draft
type: plan
github_issue: 787
github_issues: [787]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/787
primary_issue: 787
parent_plan: thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md
tags: [ralph-playwright, opus-4-7, reflect-phase, model-routing, escalation, signal-report]
---

# ralph-playwright: Route reflect by step importance — escalate on fail / prior-signal — Implementation Plan

## Prior Work

- builds_on:: [[2026-04-16-opus-4-7-ralph-playwright-vision]]
- builds_on:: [[2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic]]
- builds_on:: [[2026-04-20-GH-0785-ralph-playwright-reflect-opus-4-7-model-routing]]
- builds_on:: [[2026-04-20-GH-0786-reflect-structured-visual-audit-prompt]]

## Overview

Single-issue plan (Feature C / Round 2 of the #784 epic). Layer a **per-step escalation ladder** on top of the reflect-phase model routing shipped by #785 (direct-invocation frontmatter `model: claude-opus-4-7`) and the structured audit prompt shipped by #786. Today reflect either runs entirely on Opus 4.7 (direct invocation, honoring #785's frontmatter hint) or entirely on the caller's model (when embedded as an in-line step inside explore / test-e2e / a11y-scan / capture / ux-audit). There is no per-step routing — every step pays Opus 4.7 token cost or no step does.

This feature introduces a declarative escalation policy that the reflecting model reads at the top of Step 2 and applies while iterating steps:

- **Baseline (happy-path steps)**: Sonnet 4.6 is sufficient — mechanical presence checks, non-ambiguous layout passes.
- **Escalate to Opus 4.7** when either trigger fires: `outcome == fail` for the current step, OR step N-1 raised at least one signal.

Recording is via a new optional `reflect_meta.by_step` block in `signal-report.yaml` (additive schema change — sidecar in the same file, not a new file). The hook validator gains enum checks for the new `reason` field. Documentation goes into `skills/reflect/SKILL.md` as a new `## Step-Importance Escalation` section.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-787 | Add `reflect_meta` sidecar to signal-report schema + hook validator | S |
| 2 | GH-787 | Declare escalation ladder in reflect SKILL.md + Step 2 runtime policy | S |
| 3 | GH-787 | Pilot validation — run reflect against a known-mixed trace | S |

**Why one PR, three phases**: the schema addition (Phase 1) is inert without the SKILL.md policy that teaches the model to populate it (Phase 2); the policy is unverified without the pilot (Phase 3). Shipping as one PR matches the pattern set by #785 and #786, both single-issue multi-phase plans.

## Shared Constraints

Inherited verbatim from [parent epic plan](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md#shared-constraints), extended with feature-specific constraints below.

### Architecture & file ownership (inherited)

- The Execute -> Reflect -> Act pipeline is strict and schema-enforced. Any new inputs/outputs flow through the three YAML schemas in `plugin/ralph-playwright/schemas/`: `journey-trace.schema.yaml`, `signal-report.schema.yaml`, `action-log.schema.yaml`. Schema additions must be additive (new optional fields).
- Hooks in `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` validate journey-trace, signal-report, and action-log YAMLs at Read and Write boundaries. **Any schema change that tightens validation must update the hook in the same PR** — this plan does exactly that.
- Execute runs as a sub-agent (`explorer-agent` or `story-runner-agent`) with `model: sonnet`. Keep Sonnet for Execute. Reflect runs in the calling model's context — that is the sole tier where Opus 4.7 routing applies.
- Screenshots (PNG) and accessibility snapshots (`.md`) are captured at EVERY step. No feature may opt out of either capture.

### Model routing discipline (inherited + sharpened)

- Preferred-model hints are expressed in SKILL.md frontmatter with env var overrides (naming: `RALPH_PLAYWRIGHT_<PHASE>_MODEL`). **Escalation rules must be declarative in SKILL.md, not buried in prompt logic** — this feature's central constraint. The rules live in a new dedicated SKILL.md section so they are auditable by humans and inspectable by future tooling without executing the skill.
- Every reflect step records which model ran it, **either in a signal-report sidecar or as a journey-trace annotation** — this plan picks the signal-report sidecar per the analysis in "Current State Analysis → Recording venue choice" below.

### Cost & token envelope (inherited)

- Default capture resolution stays at the playwright-cli current viewport default.
- Opus 4.7 is materially more expensive per screenshot than Sonnet at 1568px. **Default routing must keep Sonnet on happy paths; Opus 4.7 is reserved for reflect with escalation on fail or prior-signal steps** — this feature is precisely that Shared Constraint manifested as policy.

### Research anchoring (inherited)

This plan cites `thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md` §Part 3 Item 3 ("Route by step importance, not globally") as the motivating recommendation.

### Feature-specific constraints

- **Declarative policy, not runtime code.** The escalation ladder is a SKILL.md section the reflecting model reads and applies. Mirrors #785's approach (frontmatter hint is declarative; no env-reader runtime). The `RALPH_PLAYWRIGHT_REFLECT_MODEL` env override from #785 remains the ultimate escape hatch — if set, it pins the model for all steps and escalation rules are ignored. This layering preserves #785's contract.
- **Additive schema change only.** The `reflect_meta` field is optional at the top level of signal-report.yaml. Existing signal-reports without it remain valid. Hook validator gates the new enum values but treats absence as pass (same idiom used by `decision_mode`, `targeting_method`, and `vision_fallback` on journey-trace — see [plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh:91-148](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh#L91-L148)).
- **No changes to execute agents.** `agents/explorer-agent.md:4` and `agents/story-runner-agent.md:4` stay on `model: sonnet`. This feature touches reflect policy only.
- **No changes to the sibling reflect-embedding skills in this PR.** `explore/SKILL.md`, `test-e2e/SKILL.md`, `a11y-scan/SKILL.md`, `capture/SKILL.md`, `ux-audit/SKILL.md` continue to inline their own reflect steps. Escalation policy is documented in the canonical `skills/reflect/SKILL.md`; sibling skills inherit the policy *by reference* (cross-ref only) in this PR. Per-sibling propagation of escalation rules is a follow-up concern.
- **Trigger semantics — precise.** The escalation ladder has exactly two triggers:
  1. `outcome == fail` on step N -> reflect step N runs on Opus 4.7.
  2. One or more signals emitted for step N-1 -> reflect step N runs on Opus 4.7.
  Triggers OR together — if either fires, Opus 4.7 is used. Both-fire is the same as either-fires. Step 0 can never trigger `prior-signal` (no prior step), so step 0 runs on Sonnet unless step 0 itself has `outcome == fail`.
- **"Prior signal" scope.** A prior-signal trigger fires when step N-1 has at least one emitted signal of ANY type or severity. This is deliberately broad — the goal is to catch "something unusual was seen at N-1, so N deserves a closer look". A severity filter (e.g., "only critical/high prior signals escalate") is an open question for iteration, noted but not in scope here.
- **Iteration order matters.** The reflecting model MUST iterate steps in ascending `index` order. The prior-signal trigger requires knowing whether step N-1 emitted a signal, which means step N-1 must be classified before step N. No out-of-order iteration.
- **Env override dominance.** If `RALPH_PLAYWRIGHT_REFLECT_MODEL` is set, it overrides BOTH the frontmatter default AND the escalation ladder. All steps run on the env-pinned model; `reflect_meta.by_step[*].reason` records `env_override` for each step in that case.

### Prompt engineering conventions (inherited from #786's work)

- The Step 2 structured visual audit prompt from #786 stays intact. This feature adds a small *prelude* to Step 2 that defines the per-step model-picking decision before entering the existing seven-category audit. #786's categories, examples, and signal-type mappings are not touched.

### Verification tooling (inherited)

Ralph-playwright is skills/agents-only — no build/test matrix for the plugin itself. Feature verification is phase-specific:

- **Schema change (Phase 1)**: run the updated hook against (a) a pre-existing #785/#786-era signal-report (must still pass — backward compatibility), (b) a new-shape signal-report with `reflect_meta` populated (must pass), (c) a new-shape signal-report with an invalid `reason` enum value (must fail), (d) a new-shape with `reflect_meta.by_step[index]` missing `model` (must fail).
- **Prompt/policy change (Phase 2)**: qualitative reading of the updated SKILL.md — every acceptance criterion in §Desired End State is mechanically checkable.
- **Pilot (Phase 3)**: reflect against a synthesized 4-step journey-trace with one failing step and one step following a signal-raising step; confirm the generated signal-report's `reflect_meta.by_step` matches the expected shape.

## Current State Analysis

### What reflect does today (post #785 + #786)

- `plugin/ralph-playwright/skills/reflect/SKILL.md:1-8` declares frontmatter with `model: claude-opus-4-7` (shipped by #785). This means direct `Skill("ralph-playwright:reflect")` invocations default to Opus 4.7.
- Step 2 (lines 23-80) is the structured seven-category visual audit shipped by #786. The model iterates steps in the trace, reads screenshot + snapshot + console, classifies findings, and writes signals.
- Step 4 (lines 101-162) writes the signal-report.yaml with `trace_id`, `timestamp`, `signals[]`, and `summary`. No per-step model-recording today.
- The `## Model Routing` section at lines 183-209 documents the frontmatter hint and the `RALPH_PLAYWRIGHT_REFLECT_MODEL` env override. Scope caveat: the frontmatter hint fires only on direct invocations; embedded reflect (explore / test-e2e / a11y-scan / capture / ux-audit) inherits the caller's model.

### What's missing for #787

1. **No per-step escalation.** Direct-invocation reflect runs entirely on Opus 4.7 (cost issue). Embedded reflect runs entirely on the caller's model (no escalation at all).
2. **No mechanism to record which model ran a given step.** The signal-report schema has no model-attribution fields. Aggregation, cost audits, and retrospective routing tuning are therefore impossible.
3. **No declarative policy surface.** Anyone reading `skills/reflect/SKILL.md` today cannot find a specification that says "happy-path steps use Sonnet, fail steps escalate".

### How sibling features handle "per-step flags" and "sub-object schemas" (pattern reuse)

Two recent landing patterns are directly relevant:

- **#794 `capture` sub-object on each journey-trace step** — [plugin/ralph-playwright/schemas/journey-trace.schema.yaml:117-133](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/journey-trace.schema.yaml#L117-L133) defines an optional per-step `capture` object with `resolution`, `device_scale_factor`, `mode`. Absence means default viewport; presence means high-res opt-in. The hook validator treats absence as backward-compatible pass. This is the exact idiom #787 needs for `reflect_meta`.
- **#792 `targeting_method` + `vision_fallback` sub-object on each journey-trace step** — [plugin/ralph-playwright/schemas/journey-trace.schema.yaml:84-116](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/journey-trace.schema.yaml#L84-L116) adds an optional enum plus a conditional sub-object. Hook validator at lines 98-148 enforces enum membership with `null`-passes-through semantics. Exact pattern to copy for the `reason` enum in `reflect_meta`.
- **#785 frontmatter `model:` hint + env override** — canonical declarative pattern for "pick a model at skill-load time". #787 extends this by adding per-step overrides via policy, not by duplicating the mechanism.

### Recording venue choice — signal-report sidecar vs journey-trace annotation

The issue acceptance criterion says "signal-report sidecar OR journey-trace annotation". Trade-off analysis:

| Venue | Pros | Cons |
|-------|------|------|
| **signal-report top-level `reflect_meta`** (chosen) | Owned by the reflect phase that produces it; no cross-schema coupling; co-located with the signals it's reasoning about; no impact on execute-phase schemas; idiomatic to "what reflect observed + classified"; sibling precedent exists (summary, by_severity are top-level). | Creates a new optional top-level field in signal-report (additive; hook must learn it). |
| journey-trace per-step annotation | Reuses the `capture` sub-object pattern closely. | Crosses phase boundaries — the journey-trace is execute's output; retrofitting reflect's metadata onto it couples phases; also, when reflect is embedded inside explore (where the same agent writes both artifacts), the boundary is blurrier but the schema separation is still meaningful. |

**Decision**: signal-report sidecar. The reflect phase writes signal-report.yaml and reflect-phase metadata belongs there. This preserves the clean Execute (writes journey-trace) -> Reflect (writes signal-report) -> Act (writes action-log) boundary that the rest of the plugin maintains.

### Files reviewed

- [plugin/ralph-playwright/skills/reflect/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/reflect/SKILL.md) — primary edit target for Phase 2
- [plugin/ralph-playwright/schemas/signal-report.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/signal-report.schema.yaml) — edit target for Phase 1 (add `reflect_meta` block)
- [plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh) — edit target for Phase 1 (add `reason` enum check and shape validation for `reflect_meta.by_step`)
- [plugin/ralph-playwright/schemas/journey-trace.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/journey-trace.schema.yaml) — read-only; pattern reference (lines 84-148 for optional sub-object idioms)
- [plugin/ralph-playwright/README.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/README.md) — optional cross-ref addition in Phase 2
- [plugin/ralph-playwright/skills/browser/references/vision-fallback-trigger.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/browser/references/vision-fallback-trigger.md) — not an edit target; read as precedent for declarative trigger-rule docs under `references/`
- [thoughts/shared/plans/2026-04-20-GH-0785-ralph-playwright-reflect-opus-4-7-model-routing.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0785-ralph-playwright-reflect-opus-4-7-model-routing.md) — inherited conventions
- [thoughts/shared/plans/2026-04-20-GH-0786-reflect-structured-visual-audit-prompt.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0786-reflect-structured-visual-audit-prompt.md) — inherited conventions

## Desired End State

After this feature merges:

1. **`signal-report.yaml` may include a top-level `reflect_meta` block** documenting which model ran each step and why. Schema addition is additive; pre-existing signal-reports still validate. Shape:
   ```yaml
   reflect_meta:
     default_model: claude-sonnet-4-6         # baseline when no trigger fires
     escalated_model: claude-opus-4-7         # used when escalation triggers fire
     by_step:
       0:
         model: claude-sonnet-4-6
         reason: default
       1:
         model: claude-opus-4-7
         reason: fail_escalation              # step 1 had outcome==fail
       2:
         model: claude-opus-4-7
         reason: prior_signal_escalation      # step 1 raised a signal
       3:
         model: claude-sonnet-4-6
         reason: default                      # happy path, no prior signal
   ```
2. **`plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` enforces the `reason` enum** (`default | fail_escalation | prior_signal_escalation | env_override`) when `reflect_meta` is present. Absence is pass (backward-compatible). Invalid enum values fail validation with a clear error message that names the step index.
3. **`plugin/ralph-playwright/skills/reflect/SKILL.md` has a new `## Step-Importance Escalation` section** declaring the escalation ladder, the two triggers, the three outcomes (`default_model`, `escalated_model`, or env-override), and the recording requirement. A short prelude in Step 2 tells the reflecting model to apply the ladder when iterating steps.
4. **A pilot run produces a signal-report whose `reflect_meta.by_step` matches the expected shape** for a synthesized 4-step trace with known failing/prior-signal steps.
5. **No changes to execute agents, other SKILL.md files, or journey-trace schema.** Diff scope is exactly four files.

### Verification

- [x] `signal-report.schema.yaml` defines `reflect_meta` as an optional top-level property with the shape above.
- [x] `validate-primitive-io.sh` passes a pre-#787 signal-report (no `reflect_meta`) — backward compatibility.
- [x] `validate-primitive-io.sh` passes a #787-compliant signal-report with `reflect_meta` populated and all `reason` values in the enum.
- [x] `validate-primitive-io.sh` rejects a signal-report where any `reflect_meta.by_step[*].reason` is outside the enum, naming the offending step index.
- [x] `validate-primitive-io.sh` rejects a signal-report where `reflect_meta.by_step[N].model` is missing (required sub-field).
- [x] `skills/reflect/SKILL.md` contains a `## Step-Importance Escalation` section covering: the two triggers (fail, prior-signal), the default vs escalated model, the env-override dominance, the iteration-order requirement, and the recording obligation.
- [x] `skills/reflect/SKILL.md` Step 2 begins with a 3-5 line prelude instructing the model to apply the escalation ladder.
- [x] Pilot signal-report against the synthesized trace validates against the updated schema and has `reflect_meta.by_step` entries for each of the 4 steps, with reasons matching the expected ladder.
- [x] `agents/explorer-agent.md:4` and `agents/story-runner-agent.md:4` still read `model: sonnet` (unchanged — not in diff).
- [x] `skills/reflect/SKILL.md` frontmatter still reads `model: claude-opus-4-7` (unchanged — the direct-invocation default from #785 is preserved).

## What We're NOT Doing

- **Running code at hook-time that reads `RALPH_PLAYWRIGHT_REFLECT_MODEL`.** The env var stays a SKILL.md-documented convention. The reflecting model is instructed to check the env var first and short-circuit the escalation ladder if set; no hook-level enforcement is added.
- **Propagating escalation policy into sibling skills (explore, test-e2e, a11y-scan, capture, ux-audit).** Those skills continue to inline their own reflect prompts. They gain access to the escalation ladder by reference (cross-ref in `skills/reflect/SKILL.md` and plugin README), but their inline prompts are not rewritten here. Per-sibling propagation is a follow-up concern noted but out of scope.
- **Changing the signal taxonomy, severity scale, or schema for signals.** The seven-category audit and five signal types stay as-is.
- **Adding severity-filtered prior-signal triggers.** "Any signal of any severity on N-1 escalates N" is the rule. A stricter rule (e.g., "only critical/high prior signals escalate") is deferred — noted as an open question in §Open Questions below.
- **Cost reporting, aggregation, or dashboards.** `reflect_meta` is the raw data that enables future reporting; building the reports is not in scope.
- **Retrofitting `reflect_meta` onto historical signal-reports.** Old reports pass validation without it. No migration script.
- **Changing the `## Model Routing` section from #785.** It remains the canonical home for frontmatter + env-override docs. The new `## Step-Importance Escalation` section is a sibling, not a replacement.
- **Touching `validate-primitive-io.sh` beyond adding the `reflect_meta` checks.** Existing checks for signal `type`, `severity`, and `bboxes` are untouched.

## Implementation Approach

Three sequential phases. Phase 1 ships the schema + hook (machinery). Phase 2 writes the SKILL.md policy that instructs the reflecting model to populate `reflect_meta`. Phase 3 pilots the whole thing against a hand-crafted 4-step trace.

The phases cannot be split across PRs because the schema is inert without the policy, and the policy is unverifiable without the pilot — same rationale as #785 and #794.

---

## Phase 1: Add `reflect_meta` sidecar to signal-report schema + hook validator

- **depends_on**: null

### Overview

Add an optional top-level `reflect_meta` block to `signal-report.schema.yaml` describing which model ran each step of reflect and the reason. Update `validate-primitive-io.sh` to (a) accept absence as pass (backward-compatible), (b) enforce the `reason` enum when present, (c) require `model` and `reason` on each `by_step` entry.

### Tasks

#### Task 1.1: Extend `signal-report.schema.yaml` with optional `reflect_meta` block

- **files**: [plugin/ralph-playwright/schemas/signal-report.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/signal-report.schema.yaml) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] A new top-level property `reflect_meta` is defined under `properties:`, not added to `required:` (so absence remains valid).
  - [ ] `reflect_meta` has three sub-fields (all optional at the outer level, required inside `by_step` entries):
    ```yaml
    reflect_meta:
      type: object
      description: "Per-step model attribution recorded by the reflect phase when the step-importance escalation ladder was applied. Optional; absence means the recording was not emitted (e.g., env-override set, or a writer that predates GH-787)."
      properties:
        default_model:
          type: string
          description: "Model used for happy-path steps (typically claude-sonnet-4-6)."
        escalated_model:
          type: string
          description: "Model used when an escalation trigger fired (typically claude-opus-4-7)."
        by_step:
          type: object
          description: "Map from step index (stringified integer) to the model+reason that ran that step. Keys MUST be present for every step in the source journey-trace."
          additionalProperties:
            type: object
            required: [model, reason]
            properties:
              model:
                type: string
                description: "Full model ID that ran this step (e.g., claude-sonnet-4-6, claude-opus-4-7)."
              reason:
                type: string
                enum: [default, fail_escalation, prior_signal_escalation, env_override]
                description: "Why this model was chosen. default = baseline (no trigger fired); fail_escalation = step outcome==fail; prior_signal_escalation = step N-1 raised a signal; env_override = RALPH_PLAYWRIGHT_REFLECT_MODEL set."
    ```
  - [ ] The shape mirrors the #794 `capture` idiom — optional outer object with required fields inside. Comment at the top of the schema block cross-refs GH-787 and the issue URL for provenance.
  - [ ] No existing fields (`trace_id`, `timestamp`, `signals`, `summary`) are modified or reordered.
  - [ ] File ends without trailing whitespace.

#### Task 1.2: Extend `validate-primitive-io.sh` with `reflect_meta` checks

- **files**: [plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh) (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] A new validation block is added INSIDE the existing `if [[ "$SCHEMA" == "signal-report.schema.yaml" ]]; then` branch (starting at [line 151](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh#L151)), AFTER the bbox validation block that ends at line 220, BEFORE the block's closing `fi`.
  - [ ] The block performs these checks, each following the idiom already used for `targeting_method`/`trigger_reason` checks at lines 98-148:
    1. If `reflect_meta` is absent (`yq '.reflect_meta'` returns `null`), skip all further checks and fall through. Backward compatibility preserved.
    2. If `reflect_meta.by_step` is present, iterate each entry. For each entry:
       - Require `model` to be non-null, non-empty string. On failure: `ERROR: reflect_meta.by_step[<index>].model missing or empty`.
       - Require `reason` to be non-null and in the enum `[default, fail_escalation, prior_signal_escalation, env_override]`. On failure: `ERROR: reflect_meta.by_step[<index>].reason must be one of [default, fail_escalation, prior_signal_escalation, env_override], got <actual>`.
  - [ ] All error messages name the offending step index (matches the debug-friendly style of the bbox validator at lines 183-215).
  - [ ] Uses the same BSD-grep-safe filtering idiom (filter `null`/`~` in a separate pass before enum-matching) documented in the existing block at lines 107-112.
  - [ ] No existing checks are modified; the new block is additive-only.
  - [ ] The `set -euo pipefail` at line 14 is respected — every new `yq` invocation tolerates `null` returns via the `|| true` idiom that the rest of the script uses.

#### Task 1.3: Seed hook test fixtures (scratch, not committed)

- **files**: `/tmp/gh787-hook-cases/*.yaml` (create, scratch only — not committed)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] Four scratch YAML fixtures are created under `/tmp/gh787-hook-cases/`:
    1. `pre-787.yaml` — minimal schema-valid signal-report without `reflect_meta`. The hook MUST pass this (exit 0) — backward compat.
    2. `valid-787.yaml` — signal-report with `reflect_meta` populated for 3 steps, all `reason` values in enum. Hook MUST pass (exit 0).
    3. `invalid-reason.yaml` — signal-report with one `by_step` entry using `reason: bogus_enum_value`. Hook MUST fail (exit 1) with a message naming the step index.
    4. `missing-model.yaml` — signal-report with one `by_step` entry omitting `model`. Hook MUST fail (exit 1) with a message naming the step index.
  - [ ] Each fixture is run through the hook with the documented stdin idiom:
    ```bash
    echo '{"tool_input": {"file_path": "/tmp/gh787-hook-cases/<name>.yaml"}}' \
      | CLAUDE_PLUGIN_ROOT="$PWD/plugin/ralph-playwright" \
        bash plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh
    echo "exit=$?"
    ```
    Outcomes are recorded in the PR description (or a sidecar scratch note under `thoughts/local/`). The fixtures themselves are NOT committed — they are ephemeral verification artifacts.
  - [ ] Any hook bug surfaced by these fixtures is fixed in Task 1.2 before moving to Phase 2.

### Phase Success Criteria

#### Automated Verification

- [x] `validate-primitive-io.sh` exits 0 on the `pre-787.yaml` fixture (backward compat).
- [x] `validate-primitive-io.sh` exits 0 on the `valid-787.yaml` fixture.
- [x] `validate-primitive-io.sh` exits 1 on the `invalid-reason.yaml` fixture, stderr names the step index.
- [x] `validate-primitive-io.sh` exits 1 on the `missing-model.yaml` fixture, stderr names the step index.
- [x] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors (sanity check; ralph-hero MCP server is unchanged by this feature but CI must stay green).
- [x] `cd plugin/ralph-hero/mcp-server && npm test` — all passing (ralph-playwright is skills-only but CI runs this across all plugins).

#### Manual Verification

- [ ] Reading the updated `signal-report.schema.yaml`: `reflect_meta` section is correctly placed, the comment references GH-787, and the required/optional field split is correct.
- [ ] Reading the updated `validate-primitive-io.sh`: new block is inside the signal-report branch, uses the BSD-grep-safe idiom, and does not perturb the existing bbox/type/severity checks.

**Creates for next phase**: A schema-plus-hook combination that is inert until a caller populates `reflect_meta`. Phase 2 teaches the reflecting model to populate it.

---

## Phase 2: Declare escalation ladder in reflect SKILL.md + Step 2 runtime policy

- **depends_on**: [phase-1]

### Overview

Add a new `## Step-Importance Escalation` section to `plugin/ralph-playwright/skills/reflect/SKILL.md` documenting the ladder. Add a 3-5 line prelude to Step 2 telling the reflecting model to apply the ladder when iterating steps, and instructing it to populate `reflect_meta` in the output. Add a cross-ref from the existing `## Model Routing` section and from `plugin/ralph-playwright/README.md`.

### Tasks

#### Task 2.1: Add `## Step-Importance Escalation` section to `skills/reflect/SKILL.md`

- **files**: [plugin/ralph-playwright/skills/reflect/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/reflect/SKILL.md) (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [phase-1]
- **acceptance**:
  - [ ] A new `## Step-Importance Escalation` section is appended **after** the existing `## Model Routing` section (currently ending around line 209) and **before** any other trailing content. The frontmatter, `## Input`, `## Process` (Steps 1-5), and `## Model Routing` sections are all unchanged in structure — only new content is added below.
  - [ ] The section contains these labeled subsections in order:
    - **Ladder** — a short paragraph stating: reflect picks a per-step model from a two-tier ladder; default is Sonnet 4.6 for happy-path steps; escalate to Opus 4.7 when either trigger fires.
    - **Triggers** — a bulleted list of the two triggers with precise definitions:
      1. `outcome == fail` on the CURRENT step (step N).
      2. One or more signals were emitted for the PRIOR step (step N-1).
      Also: these triggers OR together; either firing escalates.
    - **Iteration order** — one-sentence requirement: steps must be iterated in ascending `index` order, so that prior-signal state is known before the next step's decision.
    - **Env override dominance** — one paragraph: if `RALPH_PLAYWRIGHT_REFLECT_MODEL` is set, it pins the model for all steps regardless of trigger state; in that case, record `reason: env_override` in `reflect_meta.by_step[*]`.
    - **Direct invocation vs embedded reflect** — one paragraph: when reflect is invoked directly via `Skill("ralph-playwright:reflect")`, the frontmatter `model: claude-opus-4-7` (#785) is the session default; the escalation ladder still applies per-step *within* the reflect invocation (Opus stays pinned at session level, but the `reason` field still records whether a step would have escalated, enabling cost audits). When reflect is embedded as a step inside `explore`/`test-e2e`/`a11y-scan`/`capture`/`ux-audit`, the escalation ladder governs per-step model selection *within* that embedded context. See §Scope caveat in `## Model Routing` for the canonical split.
    - **Recording obligation** — a one-paragraph instruction: after classifying all steps, populate `reflect_meta` in the signal-report with `default_model`, `escalated_model`, and `by_step[*]`. Reference the schema at [plugin/ralph-playwright/schemas/signal-report.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/signal-report.schema.yaml) for exact field semantics.
    - **Example** — a small YAML fragment mirroring §Desired End State #1's example above, so the model has a concrete template.
  - [ ] Section length is <= 80 lines total (including the example). This is a skill doc; the longer narrative / cost discussion lives in the plugin README.
  - [ ] The section includes a link to the parent research doc: `thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md` §Part 3 Item 3.
  - [ ] The section includes a "See also" line pointing to `## Model Routing` for frontmatter + env-override docs, and to `plugin/ralph-playwright/README.md` for the plugin-level narrative.

#### Task 2.2: Add escalation prelude to Step 2 of the `## Process` block

- **files**: [plugin/ralph-playwright/skills/reflect/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/reflect/SKILL.md) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] A 3-5 line prelude is inserted at the START of Step 2 (currently line 24, just below `### Step 2: Examine each step`), BEFORE the existing "For each step in the trace:" language that introduces #786's seven-category audit.
  - [ ] The prelude instructs: (a) iterate steps in ascending index order, (b) before entering the seven-category audit for step N, decide whether to escalate by applying the triggers from `## Step-Importance Escalation` below, (c) record the chosen model and reason in a per-step tally that will be emitted as `reflect_meta.by_step` in Step 4.
  - [ ] The prelude does NOT re-state the full escalation logic — it refers the reader to `## Step-Importance Escalation` for the canonical rules. Keeps Step 2 lean.
  - [ ] No other text in Step 2 is modified. The seven-category audit from #786 is structurally intact.
  - [ ] A link from the prelude to the `## Step-Importance Escalation` section uses a standard markdown anchor (`[§ Step-Importance Escalation](#step-importance-escalation)`).

#### Task 2.3: Extend Step 4 (Write signal report) with `reflect_meta` instruction

- **files**: [plugin/ralph-playwright/skills/reflect/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/reflect/SKILL.md) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.2]
- **acceptance**:
  - [ ] The Step 4 YAML example (currently lines 105-128) is extended to show the optional `reflect_meta` block after `summary:`. The example mirrors the schema shape with two or three example steps showing different `reason` values (at minimum one `default` and one `fail_escalation`).
  - [ ] A sentence is added immediately after the YAML block instructing: "Populate `reflect_meta` when the step-importance escalation ladder was applied (i.e., whenever reflect classified more than one step). Omit it if reflect was invoked on a single-step trace where no ladder decision was made." A short rationale: omission still validates; the hook treats absence as pass.
  - [ ] No signal-type table (Step 3) is touched; no severity rubric is touched; no Step 5 report template is touched.

#### Task 2.4: Cross-link from `## Model Routing` and from `plugin/ralph-playwright/README.md`

- **files**: [plugin/ralph-playwright/skills/reflect/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/reflect/SKILL.md) (modify), [plugin/ralph-playwright/README.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/README.md) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.3]
- **acceptance**:
  - [ ] A new sentence is appended to the `## Model Routing` "See also" area (currently around line 207-209 of `skills/reflect/SKILL.md`): "For per-step escalation rules (Sonnet happy-path -> Opus on fail or prior-signal), see the [§ Step-Importance Escalation](#step-importance-escalation) section below."
  - [ ] A new bullet or section is added to `plugin/ralph-playwright/README.md` under the existing `## Model Routing` heading (currently ending around line 62): a short paragraph noting that per-step escalation within reflect is declared in `skills/reflect/SKILL.md § Step-Importance Escalation`. The README gains no more than 8 new lines — it remains navigational, not comprehensive.
  - [ ] No existing README links are broken; all relative paths still resolve.

### Phase Success Criteria

#### Automated Verification

- [x] Frontmatter of `skills/reflect/SKILL.md` still parses as valid YAML (no duplicate or malformed keys introduced during the edits). A quick check: `yq '.' <(sed -n '1,/^---$/p' plugin/ralph-playwright/skills/reflect/SKILL.md | sed '1d;$d')` or equivalent.
- [x] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors.
- [x] `cd plugin/ralph-hero/mcp-server && npm test` — all passing.

#### Manual Verification

- [ ] Read the updated `skills/reflect/SKILL.md` top-to-bottom and confirm:
  - Frontmatter `model: claude-opus-4-7` unchanged.
  - Steps 1 and 5 unchanged.
  - Step 2 has a new prelude that refers to the new section.
  - Step 3 (signal taxonomy) unchanged.
  - Step 4 YAML example now shows `reflect_meta`.
  - `## Model Routing` section unchanged apart from the new "See also" line at the end.
  - New `## Step-Importance Escalation` section is present and follows the seven-subsection structure from Task 2.1.
- [ ] Read the updated `plugin/ralph-playwright/README.md` and confirm the new note under `## Model Routing` with a working link.
- [ ] Confirm `agents/explorer-agent.md` and `agents/story-runner-agent.md` are NOT in the diff.
- [ ] Confirm `schemas/journey-trace.schema.yaml` and `schemas/action-log.schema.yaml` are NOT in the diff.

**Creates for next phase**: A SKILL.md policy that, when a reflecting model follows it, produces `reflect_meta`-populated signal-reports.

---

## Phase 3: Pilot validation — run reflect against a known-mixed trace

- **depends_on**: [phase-2]

### Overview

Construct (or reuse) a 4-step journey-trace with a known distribution of `outcome` values and prior-signal states, then manually invoke `/ralph-playwright:reflect` against it. Confirm the resulting signal-report's `reflect_meta.by_step` matches the expected ladder, and confirm the hook validator passes.

### Tasks

#### Task 3.1: Produce a 4-step synthesized journey-trace with mixed outcomes

- **files**: `.playwright-cli/gh787-pilot-<YYYYMMDD-HHMM>/journey-trace.yaml` (create, scratch — not committed)
- **tdd**: false
- **complexity**: low
- **depends_on**: [phase-2]
- **acceptance**:
  - [ ] The trace is hand-authored to conform to [schemas/journey-trace.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/journey-trace.schema.yaml). Placeholder screenshot/snapshot paths point to empty PNG/MD files (hand-created with `touch` or similar) so the schema validator does not reject missing paths.
  - [ ] Exactly 4 steps with the following shape (ensures the full ladder is exercised):
    - Step 0: `action: navigate`, `outcome: pass`, no console errors. Expected: reflect emits no signals, `reflect_meta.by_step[0]` = `{model: claude-sonnet-4-6, reason: default}`.
    - Step 1: `action: click`, `outcome: fail` (error field non-null). Expected: fail_escalation trigger; `reflect_meta.by_step[1]` = `{model: claude-opus-4-7, reason: fail_escalation}`.
    - Step 2: `action: fill`, `outcome: pass`. Because step 1 failed (and should have surfaced at least one `error` signal), the prior-signal trigger fires. Expected: `reflect_meta.by_step[2]` = `{model: claude-opus-4-7, reason: prior_signal_escalation}`.
    - Step 3: `action: verify`, `outcome: pass`. Step 2 emitted no signals (happy path passing step). Expected: `reflect_meta.by_step[3]` = `{model: claude-sonnet-4-6, reason: default}`.
  - [ ] The journey-trace passes `validate-primitive-io.sh` before the pilot run (sanity check that the test input is itself schema-valid).

#### Task 3.2: Invoke `/ralph-playwright:reflect` against the pilot trace and capture the output

- **files**: none (runtime invocation producing `.playwright-cli/gh787-pilot-<session>/signal-report.yaml`)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] Invoke `Skill("ralph-playwright:reflect", "<trace-path>")` OR run from a `/ralph-playwright:reflect <trace-path>` CLI if accessible. Because step 0's and step 2's screenshots are placeholder empty PNGs, the model is expected to emit minimal or no visual signals for those steps — that is fine, the mechanism under test is the escalation recording, not signal quality.
  - [ ] The run completes and writes `.playwright-cli/gh787-pilot-<session>/signal-report.yaml`.
  - [ ] The produced signal-report has a top-level `reflect_meta` block with `default_model`, `escalated_model`, and `by_step` populated for indices 0, 1, 2, 3.
  - [ ] Reasons match the expected ladder from Task 3.1 (with one concession: if the model's step-1 reflection produces no signal at all despite `outcome: fail` — e.g., because the placeholder screenshot carries no visible error — then step-2's prior-signal trigger may not fire. Record the observed behavior honestly; the plan acceptance is that `reflect_meta` is populated and reasons are in the enum, not that the model's emergent signal emission on placeholder PNGs matches a prediction).
  - [ ] A second pilot run is performed with `RALPH_PLAYWRIGHT_REFLECT_MODEL=claude-sonnet-4-6` set: every `by_step[*].reason` must be `env_override`, and every `model` field must read `claude-sonnet-4-6`. Unset the env var after this check. **Alternative acceptable outcome**: if the runtime does not enforce env-var overrides (same advisory status as #785 Task 3.4), document the observed behavior and accept "the env var is a documented convention that future tooling can honor" — the recording of `reason: env_override` is a prompt-level obligation on the model, not a runtime enforcement.

#### Task 3.3: Validate the pilot signal-report via the hook

- **files**: [plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh) (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.2]
- **acceptance**:
  - [ ] Run the hook against the pilot signal-report:
    ```bash
    echo "{\"tool_input\": {\"file_path\": \"$PWD/.playwright-cli/gh787-pilot-<session>/signal-report.yaml\"}}" \
      | CLAUDE_PLUGIN_ROOT="$PWD/plugin/ralph-playwright" \
        bash plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh
    echo "exit=$?"
    ```
    Exit code MUST be 0.
  - [ ] If exit is non-zero, read stderr, fix the issue either in the model's output (by revising the Phase 2 prompt) or in the hook (if a legitimate validator bug is exposed) in that order of preference — prompt tuning is cheaper than hook changes.
  - [ ] Record the pilot observations (expected vs observed reasons per step, env-override behavior) in `thoughts/local/pilots/2026-04-21-GH-0787-reflect-escalation-pilot.md` (user-local; gitignored). The note captures: the trace structure, each step's outcome, each step's emitted signals (count and types), the resulting `reflect_meta.by_step[*]`, the env-override observation, and any deltas from the expected ladder with explanations.

### Phase Success Criteria

#### Automated Verification

- [x] `validate-primitive-io.sh` exits 0 on the pilot signal-report.
- [x] `reflect_meta.by_step` contains entries for all 4 step indices.
- [x] All `reason` values in the pilot are within the enum `[default, fail_escalation, prior_signal_escalation, env_override]`.
- [x] All `model` values are non-empty strings.

#### Manual Verification

- [ ] The pilot note at `thoughts/local/pilots/2026-04-21-GH-0787-reflect-escalation-pilot.md` is written and contains observed vs expected reasons per step.
- [ ] The env-override observation is documented (either the enforced-override outcome or the advisory-only outcome).
- [ ] No signal-report fields outside `reflect_meta` were unexpectedly modified (diff the pilot signal-report against the shape from Step 4 Task 2.3's example).

**Creates for next phase**: Nothing — this is the final phase. The pilot note feeds the PR description as evidence that the policy+schema+hook combine to produce valid output.

---

## Integration Testing

- [x] Full PR diff shows exactly four files changed:
  1. `plugin/ralph-playwright/schemas/signal-report.schema.yaml` (Phase 1 schema addition).
  2. `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` (Phase 1 hook addition).
  3. `plugin/ralph-playwright/skills/reflect/SKILL.md` (Phase 2 policy and prelude and Step 4 example extension).
  4. `plugin/ralph-playwright/README.md` (Phase 2 cross-ref).
  5. `thoughts/shared/plans/2026-04-21-GH-0787-ralph-playwright-reflect-step-importance-escalation.md` (this plan document itself, committed with the implementation PR per project convention).
- [x] `agents/explorer-agent.md:4` and `agents/story-runner-agent.md:4` are NOT in the diff (execute agents stay on Sonnet).
- [x] `schemas/journey-trace.schema.yaml` and `schemas/action-log.schema.yaml` are NOT in the diff.
- [x] `skills/explore/SKILL.md`, `skills/test-e2e/SKILL.md`, `skills/a11y-scan/SKILL.md`, `skills/capture/SKILL.md`, `skills/ux-audit/SKILL.md` are NOT in the diff (sibling reflect-embedding skills are not propagated in this PR).
- [x] A pre-existing signal-report without `reflect_meta` (e.g., from a #785 / #786 verification run) passes the updated hook — backward compatibility confirmed.
- [x] A #787-compliant signal-report with `reflect_meta` populated passes the updated hook.
- [x] The hook rejects enum violations and missing-`model` errors with actionable messages naming the step index.
- [x] Verification pilot (Phase 3) produced a valid signal-report.yaml with `reflect_meta.by_step` covering all 4 steps and all `reason` values in enum.

## Unblocks

Per the epic's Deployment Order (plan-of-plans §Integration Strategy):

- **Feature C is on the critical path.** #787 completes the reflect-phase trinity (A = #785 model slot, B = #786 structured prompt, C = #787 escalation by step importance). With this merge, the reflect phase has per-step model selection wired end-to-end.
- **Not a direct blocker for downstream features** (#791 declares `depends_on: [GH-785, GH-786]` — does not depend on #787). However, #787's `reflect_meta` recording is the data substrate for eventual cost reporting and routing tuning; those are future features outside this epic.

## Open Questions

- **Severity-filtered prior-signal triggers.** Current rule: any signal on N-1 escalates N. Under pilot load, this may be too eager (a single `low`-severity typography signal on N-1 will escalate N). If pilot or production telemetry shows over-escalation, a follow-up issue should narrow the trigger to "critical/high signals on N-1 escalate N". Not in scope here.
- **Severity-filtered fail triggers.** Current rule: any `outcome: fail` escalates. Arguably every fail warrants closer analysis, so no filter is likely needed — but confirm empirically.
- **Escalation on N-2 signals, not just N-1.** If multiple consecutive happy-path steps should de-escalate eventually, N-1-only is correct. If signals are sticky ("system is in a bad state, be careful for 3 steps"), N-2 may be relevant. Defer to follow-up.
- **Embedded-reflect propagation.** How do the five sibling skills that inline reflect inherit this policy? Options: (a) add a cross-ref to each sibling's reflect sub-step (five edits), (b) factor reflect into a shared reference doc under `skills/reflect/references/` (new convention), (c) leave them untouched and rely on the canonical policy living at `skills/reflect/SKILL.md`. Current PR chose (c) to keep the diff small; (b) is probably the right long-term answer. Not in scope here.
- **Interaction with `--high-res` (GH-794).** Both features are step-importance opt-ins. A natural composition: fail-escalated steps should also be high-res-recaptured on rerun. But that requires a rerun loop that today does not exist — noted and deferred.

## References

- **Issue**: https://github.com/cdubiel08/ralph-hero/issues/787
- **Parent epic**: https://github.com/cdubiel08/ralph-hero/issues/784
- **Research**: [thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md) §Part 3 Item 3
- **Plan-of-plans**: [thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md)
- **Sibling plan (Feature A, shipped)**: [thoughts/shared/plans/2026-04-20-GH-0785-ralph-playwright-reflect-opus-4-7-model-routing.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0785-ralph-playwright-reflect-opus-4-7-model-routing.md) — established frontmatter `model:` hint + env-override pattern.
- **Sibling plan (Feature B, shipped)**: [thoughts/shared/plans/2026-04-20-GH-0786-reflect-structured-visual-audit-prompt.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0786-reflect-structured-visual-audit-prompt.md) — Step 2 structured audit this plan's prelude slots on top of.
- **Pattern reference (per-step sub-object schema, shipped as #794)**: [plugin/ralph-playwright/schemas/journey-trace.schema.yaml:117-133](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/journey-trace.schema.yaml#L117-L133) — the `capture` sub-object idiom `reflect_meta` copies.
- **Pattern reference (hook enum-check with null-passthrough, shipped as #801)**: [plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh:98-148](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh#L98-L148) — the BSD-grep-safe enum validation pattern Phase 1 Task 1.2 copies.
- **Sibling precedent (env var + frontmatter for vision-locator model, shipped as #792)**: [plugin/ralph-playwright/skills/browser/SKILL.md:133](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/browser/SKILL.md#L133) — `RALPH_PLAYWRIGHT_VISION_LOCATOR_MODEL` establishes the per-phase env var naming convention this plan inherits via `RALPH_PLAYWRIGHT_REFLECT_MODEL`.
- **Files to modify**:
  - [plugin/ralph-playwright/schemas/signal-report.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/signal-report.schema.yaml)
  - [plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh)
  - [plugin/ralph-playwright/skills/reflect/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/reflect/SKILL.md)
  - [plugin/ralph-playwright/README.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/README.md)
- **Files to leave unchanged (explicit)**:
  - [plugin/ralph-playwright/agents/explorer-agent.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/agents/explorer-agent.md) — stays on `model: sonnet`.
  - [plugin/ralph-playwright/agents/story-runner-agent.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/agents/story-runner-agent.md) — stays on `model: sonnet`.
  - [plugin/ralph-playwright/schemas/journey-trace.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/journey-trace.schema.yaml) — no changes; reflect-phase metadata lives in signal-report, not journey-trace.
  - [plugin/ralph-playwright/schemas/action-log.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/action-log.schema.yaml) — no act-phase changes.
  - [plugin/ralph-playwright/skills/explore/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/explore/SKILL.md), [skills/test-e2e/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/test-e2e/SKILL.md), [skills/a11y-scan/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/a11y-scan/SKILL.md), [skills/capture/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/capture/SKILL.md), [skills/ux-audit/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/ux-audit/SKILL.md) — sibling reflect-embedding skills; escalation policy inherited by reference (cross-ref only). Per-sibling propagation is a follow-up.
