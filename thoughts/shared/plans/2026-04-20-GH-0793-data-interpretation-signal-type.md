---
date: 2026-04-20
status: draft
type: plan
github_issue: 793
github_issues: [793]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/793
primary_issue: 793
parent_plan: thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md
tags: [ralph-playwright, opus-4-7, reflect-phase, signal-schema, chart-ui]
---

# ralph-playwright: add data_interpretation signal type — Implementation Plan

## Prior Work

- builds_on:: [[2026-04-16-opus-4-7-ralph-playwright-vision]]
- builds_on:: [[2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic]]

## Overview

Single-issue XS plan implementing §Part 3 Item 9 of the Opus 4.7 vision research. Adds a new `data_interpretation` entry to the signal-report type enum to capture dashboard / chart / data-viz misreads that don't fit cleanly into `anomaly` or `ux_issue`. Leverages Opus 4.7's documented +13 point CharXiv gain.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-793 | ralph-playwright: add data_interpretation signal type | XS |

**Why single-phase**: standalone XS. No sub-issues, no blockers, no downstream coupling. Schema + SKILL.md + hook validator + fixture all land in one atomic change.

## Shared Constraints

Inherited verbatim from the parent plan-of-plans [2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md). Feature-specific constraints appended at the end.

### Architecture & file ownership

- The Execute -> Reflect -> Act pipeline is strict and schema-enforced. Any new inputs/outputs flow through the three YAML schemas in `plugin/ralph-playwright/schemas/`: `journey-trace.schema.yaml`, `signal-report.schema.yaml`, `action-log.schema.yaml`. Schema additions must be additive (new optional fields) unless explicitly noted.
- Hooks in `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` validate journey-trace, signal-report, and action-log YAMLs at Read and Write boundaries. Any schema change that tightens validation must update the hook in the same PR.
- Execute runs as a sub-agent (`explorer-agent` or `story-runner-agent`) with `model: sonnet`. Keep Sonnet for Execute. Reflect runs in the calling model's context — that is the sole tier where Opus 4.7 routing applies.
- Screenshots (PNG) and accessibility snapshots (`.md`) are captured at EVERY step. No feature may opt out of either capture.
- The "NEVER use CSS selectors" rule in `plugin/ralph-playwright/agents/story-runner-agent.md:50` stays in force for accessible elements.

### Prompt engineering conventions

- Categorized checklists beat free-form instructions. Taxonomy tables must include examples.
- Schema enum additions are additive — do not reorder or remove existing values.

### Artifact paths

- Session data: `.playwright-cli/<session>/` (journey-trace.yaml, signal-report.yaml, action-log.yaml, screenshots, snapshots).
- Fixtures: `plugin/ralph-playwright/fixtures/` — created lazily as features require.

### Verification tooling

- Ralph-playwright is skills/agents-only — no build/test matrix for the plugin itself.
- Schema-change verification: hand-write a sample signal-report.yaml that uses the new enum value and confirm `hooks/scripts/validate-primitive-io.sh` accepts it (exit 0). Write a second fixture using a deliberately-bogus value and confirm the hook rejects it (exit 1).
- Prompt-change verification: read the updated SKILL.md end-to-end and confirm a reader (human or LLM) could decide when to emit `data_interpretation` vs `anomaly` vs `ux_issue` without ambiguity.

### Research anchoring

- Research: [thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md) — §Part 3 Item 9 motivates this feature.

### Feature-specific constraints

- No new required schema fields; the addition must be backwards-compatible with existing signal-report.yaml files. Old reports without `data_interpretation` signals continue to validate.
- The taxonomy description in SKILL.md must make the distinction between `data_interpretation` and the existing types explicit, with at least 4 concrete examples (axis label missing, legend-data mismatch, unreadable density, unlabeled units), matching the research doc's Item 9 and Item 2's "Chart & data UIs" checklist.
- Hook validator must enforce the full extended enum in one place — do not leave stale regex fragments elsewhere in the file.

## Current State Analysis

Three artifacts co-define the signal-type contract. All three must change in lockstep:

1. **Schema** — [plugin/ralph-playwright/schemas/signal-report.schema.yaml:23](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/signal-report.schema.yaml#L23) declares the enum:
   ```yaml
   type:
     type: string
     enum: [anomaly, regression, a11y_violation, ux_issue, error]
   ```

2. **Reflect SKILL.md taxonomy** — [plugin/ralph-playwright/skills/reflect/SKILL.md:35-41](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/reflect/SKILL.md#L35-L41) gives the model the classification table. Today it lists 5 types; the "visual" bullet in `anomaly` is the only mention of chart-like concerns.

3. **Hook validator** — [plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh:94](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh#L94) hard-codes the enum in a regex:
   ```bash
   INVALID_TYPES=$(yq '.signals[].type' "$FILE_PATH" 2>/dev/null | grep -v -E '^(anomaly|regression|a11y_violation|ux_issue|error)$' || true)
   ```
   If the schema adds a value but the regex is not updated, the hook rejects its own valid outputs.

No fixtures directory currently exists under `plugin/ralph-playwright/`. The parent plan-of-plans anticipates one at `plugin/ralph-playwright/fixtures/`; this feature may seed it with the first chart-UI fixture signal-report.

The reflect SKILL.md itself has no "examples" section today — the taxonomy table is the only guidance the model gets. Extending the table is the least-intrusive way to teach the new type.

## Desired End State

- The string `data_interpretation` is a valid `signals[].type` value per the schema.
- A hand-written signal-report.yaml emitting a `data_interpretation` signal passes `hooks/scripts/validate-primitive-io.sh` with exit 0.
- A hand-written signal-report.yaml emitting a bogus type (e.g. `data_interp`) still fails validation with exit 1.
- The reflect SKILL.md taxonomy table has a 6th row documenting `data_interpretation` with at least 4 concrete examples (axis label missing, legend-data mismatch, chart density, unlabeled units).
- The fixtures directory exists and contains a signal-report example demonstrating correct `data_interpretation` usage, suitable for manual verification and for future plans (Features D, F) that may seed additional fixtures.

### Verification

- [ ] Schema YAML parses correctly (yq loads it without error) and the enum array contains exactly `[anomaly, regression, a11y_violation, ux_issue, error, data_interpretation]`.
- [ ] Hook validator regex in `validate-primitive-io.sh:94` accepts all 6 types (unit-test by piping strings through the same grep).
- [ ] Hook validator rejects `data_interp` (typo case) and any other non-enum value.
- [ ] Fixture signal-report file at `plugin/ralph-playwright/fixtures/data-interpretation-example/signal-report.yaml` validates against the hook.
- [ ] Reflect SKILL.md taxonomy table contains a `data_interpretation` row with >= 4 concrete examples.

## What We're NOT Doing

- **No new required fields** on the signal schema (e.g. `chart_type`, `expected_value`, `observed_value` from the task prompt's suggestion). The research doc §Part 3 Item 9 only specifies adding the enum value; structured chart fields are over-scoping for an XS. If a future plan (post-epic) wants chart-specific evidence fields, they land as optional sub-fields under `evidence.chart_context` — tracked as a follow-up, not here. Rationale: keep the change strictly additive and backwards-compatible per the shared constraint; avoid coupling this XS to a downstream design decision.
- **No schema versioning bump.** Additive enum extension does not break older readers who can treat unknown enum values as "unclassified" — the hook is the enforcement point, not consumer code.
- **No changes to `anomaly` or `ux_issue` definitions.** The taxonomy row for `data_interpretation` must draw the boundary clearly in its description, but the other five rows stay as-is to avoid rippling changes.
- **No reflect-phase prompt rewrite.** Feature B (#786) owns the structured-audit-prompt rewrite. This plan touches only the taxonomy table (Step 3 of SKILL.md), not the checklist in Step 2.
- **No hook validator refactor.** The regex-based approach is what exists; this plan extends it by one alternation and nothing more.
- **No model-routing changes.** Feature A (#785) owns Opus 4.7 routing for reflect. This plan works regardless of which model runs reflect.
- **No act-phase changes.** `data_interpretation` signals flow through the act phase using the existing evidence contract (`steps`, `screenshots`, `tags`).

## Implementation Approach

Single phase with four small tasks. Phase-level dependency annotation: `depends_on: null`.

The natural ordering is schema -> hook -> SKILL.md -> fixture: schema establishes the contract, hook enforces it, SKILL.md teaches the model to use it, fixture demonstrates correct usage and gives manual verification a target. Tasks 1.1 -> 1.2 have a strict dependency (hook regex must match schema enum); 1.3 and 1.4 depend on both but are independent of each other.

---

## Phase 1: data_interpretation signal type — schema + hook + SKILL.md + fixture

- **depends_on**: null

### Overview

Extend the signal-type enum in the schema, update the hook validator regex, document the new type in the reflect SKILL.md taxonomy with concrete examples, and seed a fixture demonstrating usage. All four changes ship together.

### Tasks

#### Task 1.1: Extend the signal-type enum in the schema

- **files**: [plugin/ralph-playwright/schemas/signal-report.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/signal-report.schema.yaml) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Line 23 enum reads exactly: `enum: [anomaly, regression, a11y_violation, ux_issue, error, data_interpretation]`
  - [ ] No other lines in the file change.
  - [ ] `yq '.properties.signals.items.properties.type.enum' plugin/ralph-playwright/schemas/signal-report.schema.yaml` prints all six values in order.
  - [ ] File remains valid YAML (yq load succeeds with exit 0).

#### Task 1.2: Update the hook validator regex

- **files**: [plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh) (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Line 94 regex reads exactly: `grep -v -E '^(anomaly|regression|a11y_violation|ux_issue|error|data_interpretation)$'`
  - [ ] No other lines in the file change (severity regex on line 99 stays as-is).
  - [ ] Manual verification: `echo 'data_interpretation' | grep -v -E '^(anomaly|regression|a11y_violation|ux_issue|error|data_interpretation)$'` prints nothing (accepted).
  - [ ] Manual verification: `echo 'data_interp' | grep -v -E '^(anomaly|regression|a11y_violation|ux_issue|error|data_interpretation)$'` prints `data_interp` (rejected).
  - [ ] Shellcheck (if available) does not flag new issues.

#### Task 1.3: Document the new type in reflect SKILL.md taxonomy

- **files**: [plugin/ralph-playwright/skills/reflect/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/reflect/SKILL.md) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] The taxonomy table at lines 35-41 gains a new row for `data_interpretation`.
  - [ ] The row's "When" column includes >= 4 concrete examples drawn from the research doc: axis label missing, legend-data mismatch, chart density (unreadable), unlabeled units.
  - [ ] The description differentiates from `anomaly` (which covers layout/visual glitches) and `ux_issue` (which covers nav/feedback confusion). One example phrasing: "Dashboard or chart misinterpretation: axis label missing, legend does not match data, unreadable density, unlabeled units, incorrect numeric callouts, misleading visualizations."
  - [ ] The table remains valid Markdown — header row pipe-count matches data rows.
  - [ ] No other sections of SKILL.md change.

#### Task 1.4: Seed a fixture demonstrating correct usage

- **files**: `plugin/ralph-playwright/fixtures/data-interpretation-example/signal-report.yaml` (create), `plugin/ralph-playwright/fixtures/data-interpretation-example/README.md` (create)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - [ ] Directory `plugin/ralph-playwright/fixtures/data-interpretation-example/` exists.
  - [ ] `signal-report.yaml` is a valid signal-report per the schema: contains `trace_id` (any valid UUID), `timestamp` (ISO-8601), `signals` array with at least one `type: data_interpretation` entry, and a `summary` with `total_signals`, `by_severity`, `recommendation`.
  - [ ] The example signal has `evidence.steps` and `evidence.screenshots` populated (placeholder screenshot filename is fine, e.g. `03_dashboard.png`); `description` references one of the canonical examples (axis label, legend mismatch, density, unlabeled units).
  - [ ] Simulating the hook on the fixture: when run through `hooks/scripts/validate-primitive-io.sh` with a manufactured stdin payload `{"tool_input":{"file_path":"<absolute path to fixture>"}}`, the script exits 0.
  - [ ] A negative companion fixture (same dir, file `signal-report.invalid.yaml`) uses `type: data_interp` (typo). Running the hook against it exits 1 with a message matching `Invalid signal types`.
  - [ ] `README.md` briefly (4-8 lines) explains what the fixture demonstrates and how to run the hook manually against both files.

### Phase Success Criteria

#### Automated Verification

- [ ] `yq '.properties.signals.items.properties.type.enum' plugin/ralph-playwright/schemas/signal-report.schema.yaml` outputs 6 values in the expected order.
- [ ] `bash -n plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` — no syntax errors.
- [ ] `echo 'data_interpretation' | grep -v -E '^(anomaly|regression|a11y_violation|ux_issue|error|data_interpretation)$'` — empty output (accepted).
- [ ] `echo 'data_interp' | grep -v -E '^(anomaly|regression|a11y_violation|ux_issue|error|data_interpretation)$'` — prints `data_interp` (rejected).
- [ ] Positive fixture passes the hook script (exit 0) when stdin carries its absolute path.
- [ ] Negative fixture fails the hook script (exit 1) with `Invalid signal types` in stderr.

#### Manual Verification

- [ ] A human reader can tell from the updated SKILL.md taxonomy when to emit `data_interpretation` vs `anomaly` or `ux_issue` without needing to read the research doc.
- [ ] A future reflect run on a chart-heavy page (e.g. a dashboard fixture to be added by Feature B or a later iteration) would plausibly emit `data_interpretation` signals matching the taxonomy description.
- [ ] No stale references to the 5-type enum remain elsewhere in `plugin/ralph-playwright/` — spot-check agents/ and other skills/ for any hardcoded enum mentions.

**Creates for next phase**: N/A — single-phase plan. The fixtures directory is seeded for Feature F (#790, bboxes) and Feature D (#788, contrast) to extend.

---

## Integration Testing

Single-phase feature; "integration" is hook-level conformance only:

- [ ] Schema + hook + positive fixture + negative fixture combine into a coherent enforcement loop (valid shapes pass, typos fail).
- [ ] No existing signal-report.yaml under `.playwright-cli/` (if any exist on disk) is broken — additive enum extension preserves old values.
- [ ] No other schema under `plugin/ralph-playwright/schemas/` references the signal-type enum. (Verified by grep during implementation.)

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/793
- Parent plan-of-plans: [thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md) — Feature I
- Research: [thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md) — §Part 3 Item 9
- Related issues in the epic: #784 (epic), #785, #786, #787, #788, #789, #790, #791, #792, #794, #795, #796
