---
date: 2026-04-20
status: draft
type: plan
github_issue: 820
github_issues: [820]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/820
primary_issue: 820
parent_plan: thoughts/shared/plans/2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff.md
tags: [ralph-playwright, semantic-diff, documentation, pilot, noise-floor, visual-diff]
---

# ralph-playwright: document visual-diff split + noise-floor pilot — Implementation Plan

## Prior Work

- builds_on:: [[2026-04-16-opus-4-7-ralph-playwright-vision]]
- builds_on:: [[2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic]]
- builds_on:: [[2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff]]

## Overview

Atomic #820 of Feature G. Documentation + pilot. Rewrite `skills/visual-diff/SKILL.md` to describe the two-layer division of labor (in-loop semantic diff vs Chromatic/Applitools). Run the semantic diff against at least one real journey with a known change; record the pilot results; set the shipped `--noise-floor` default based on those numbers and cite them in the doc.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-820 | document visual-diff split + noise-floor pilot | XS |

## Shared Constraints

Inherited verbatim from the parent feature plan (§Shared Constraints). Key items relevant here:

### Architecture & file ownership (from parent)

- This is a documentation + empirical-measurement atomic. No schema change, no script change, no flag change beyond setting a default value that #816 reserved.
- The research doc flags "Semantic-diff noise floor" as an Open Question; this atomic CLOSES it.

### Feature-specific constraints (from parent)

- **Chromatic/Applitools stays.** `skills/visual-diff/SKILL.md` is REWRITTEN (intro + framing + worked example), not deleted. Tool-setup content for Chromatic and Applitools is preserved, reorganized under the "component-granularity layer" side of the new framing.
- **Noise-floor default is evidence-backed.** The pilot must report: false-positive rate on an unchanged run, true-positive rate on the known-change run. Targets: ≤1 noise signal per 10 steps at default (false positive ceiling); ≥1 regression fires on the injected change (true positive floor).

### Atomic-specific constraints

- **Pilot must use the real toolchain.** The pilot runs `/ralph-playwright:reflect` with `--baseline` against a local fixture — same flow operators will use in production. Synthesizing responses in code is NOT acceptable here; the goal is to measure actual prompt+model behavior at default viewport resolution, which is what #816's CLI invokes.
- **Pilot must produce reviewable artifacts.** The pilot's `journey-trace.yaml`, `signal-report.yaml`, and a short methodology note live under `thoughts/shared/research/` OR `thoughts/local/pilots/` depending on whether the data is shareable. Prefer `thoughts/shared/research/` for the methodology doc (publishable research); if the PNGs are proprietary, keep them in `thoughts/local/` with paths cited in the methodology doc.
- **Noise-floor default is writable via code, not just prose.** The default lives in one canonical place (probably `diff-emitter.mjs`'s `DEFAULT_NOISE_FLOOR` constant or a dedicated config file). The pilot updates that constant if the data warrants. `skills/reflect/SKILL.md` and `skills/visual-diff/SKILL.md` both cite the default by value, not by a hard-coded copy.
- **Cross-links are bidirectional.** `skills/reflect/SKILL.md` already got the "See also → visual-diff" link in #816. This atomic adds the reverse link in `skills/visual-diff/SKILL.md`.

## Current State Analysis

### Visual-diff skill today (pre-atomic)

`plugin/ralph-playwright/skills/visual-diff/SKILL.md` (45 lines):
- Entirely delegates to Chromatic (default) or Applitools (alternative). Storybook-story granularity, outside the agent loop.
- No mention of in-loop or journey-level comparison.
- No cross-reference to `skills/reflect/SKILL.md`.
- Structure: Tool Detection → Chromatic section → Applitools section → "When to choose Applitools" section.

### Reflect skill today (post-#816)

`skills/reflect/SKILL.md` has:
- A new "Semantic Visual Diff" section between Step 5 and Model Routing (per #816 Task 1.4)
- Example invocations for `--baseline` and `--update-baseline`
- A "See also" link to `skills/visual-diff/SKILL.md`

### Noise-floor default today (post-#813)

`plugin/ralph-playwright/scripts/diff-emitter.mjs` (#813):
- `DEFAULT_NOISE_FLOOR = 'medium'` (or equivalent exported constant)
- `renderPrompt({ noiseFloor })` adjusts the threshold-language paragraph per level
- Options accept `noiseFloor` with fallback to the default

If #813 did NOT export a canonical default constant, this atomic adds it as part of the noise-floor tuning (one-line change + re-export).

### Diff CLI surface today (post-#816)

`/ralph-playwright:reflect --baseline <prior-trace> <current-trace>` is operational. `--update-baseline` is operational. This atomic USES the CLIs; it does not change them.

### Files reviewed

- `plugin/ralph-playwright/skills/visual-diff/SKILL.md` (45 lines) — primary edit target
- `plugin/ralph-playwright/skills/reflect/SKILL.md` (post-#816) — reciprocal cross-link target (already has the outgoing link)
- `plugin/ralph-playwright/scripts/diff-emitter.mjs` (post-#813) — `DEFAULT_NOISE_FLOOR` constant target

## Desired End State

After this atomic merges:

- `skills/visual-diff/SKILL.md` opens with a two-layer framing explaining "in-loop semantic diff (this plugin, journey-level) vs component visual regression (Chromatic/Applitools, Storybook-level)".
- The doc contains a decision guide: which failures belong in which layer.
- The doc embeds a worked example from the pilot: what the injected change was, what the semantic diff emitted (the natural-language regression bullet), and why that's different from what Chromatic would catch on the same code change.
- The noise-floor default is stated and justified: "Default is `<level>`. This was chosen based on a pilot on `<fixture>` showing `<false-positive-rate>` false positives on an unchanged run and `<true-positive-rate>` true positives on a run with an injected `<change-kind>`."
- The pilot methodology is captured in a standalone research doc under `thoughts/shared/research/YYYY-MM-DD-semantic-diff-noise-floor-pilot.md`.
- `skills/visual-diff/SKILL.md` cross-links to `skills/reflect/SKILL.md` (reciprocal of the link added by #816).
- If the pilot data warrants, `DEFAULT_NOISE_FLOOR` in `diff-emitter.mjs` is updated; the doc cites the updated value.

### Verification

- [ ] `skills/visual-diff/SKILL.md` intro frames the two layers in ≤2 paragraphs
- [ ] Decision guide section lists at least five concrete example scenarios and routes each to the correct layer (e.g., "button padding change on a stable storybook story" → Chromatic/Applitools; "layout shift mid-journey dropping CTA below fold" → in-loop semantic diff)
- [ ] Worked example shows: (a) the injected change, (b) the emitted `regression` signal's natural-language description, (c) the relative strength of the two layers on this change
- [ ] Noise-floor default value stated, and the justification cites the pilot's false-positive rate and true-positive rate (actual numbers)
- [ ] Pilot methodology doc exists under `thoughts/shared/research/` with date-prefix; documents URL, fixture change applied, run counts, step counts, signal counts, default-noise-floor decision
- [ ] `skills/visual-diff/SKILL.md` has a "See also" block linking `skills/reflect/SKILL.md`
- [ ] `DEFAULT_NOISE_FLOOR` in `diff-emitter.mjs` matches the value cited in both SKILL.md files
- [ ] Chromatic setup instructions preserved (reorganized under the "component-layer" heading, not removed)
- [ ] Applitools setup instructions preserved (same treatment)

## What We're NOT Doing

- **No emitter change beyond the default value.** The emitter's behavior is fixed by #813. This atomic may flip the default noise-floor constant but does NOT add new parameters, new signal types, or new prompt variants.
- **No reflect SKILL.md rewrite.** #816 already documented the flags. This atomic only verifies the cross-link is there; it does not rewrite reflect SKILL.md.
- **No CI / auto-run for the pilot.** The pilot is a one-time measurement. Its result is committed as documentation; the pilot script is not rerun on every CI build.
- **No Chromatic / Applitools integration code change.** The existing setup instructions for those tools are preserved; only the framing around them changes.
- **No new signal type.** `regression` stays. No taxonomy expansion.
- **No automated noise-floor tuning.** The default is chosen manually based on pilot data. Future retuning is a follow-up atomic if the community reports different rates on their own sites.
- **No multi-fixture pilot.** One real fixture is enough to set a sensible default. More fixtures → more confidence but diminishing returns; capture as a follow-up if needed.
- **No cross-viewport pilot.** Default viewport only. High-res (#794) interactions with diff are out of scope.

## Implementation Approach

Two parts: the pilot (produces data), then the documentation (consumes the data). Doing them in this order means the doc can cite specific numbers, not hedge with "the noise floor is tuned empirically and a pilot is recommended".

Task order:

1. Run the pilot: invoke the #816 flow twice, once against an unchanged fixture, once with an injected change. Capture signal counts and qualitative signal text.
2. If data supports it, flip `DEFAULT_NOISE_FLOOR` in `diff-emitter.mjs` (or confirm `medium` is correct).
3. Write the pilot methodology doc.
4. Rewrite `skills/visual-diff/SKILL.md` intro, add decision guide, embed worked example, cite noise-floor default.
5. Add the reciprocal cross-link.

---

## Phase 1: GH-820 — documentation + noise-floor pilot

- **depends_on**: [GH-816]

### Overview

Run the pilot. Write the pilot report. Rewrite the visual-diff SKILL.md. Add the cross-link. Adjust the default noise-floor constant if warranted.

### Tasks

#### Task 1.1: Run the noise-floor pilot

- **files**:
  - `plugin/ralph-playwright/fixtures/semantic-diff-smoke/` (reuse or extend — created in #816 Task 1.5)
  - `.playwright-cli/<pilot-session-A>/` and `.playwright-cli/<pilot-session-B>/` (produced during pilot; do not commit — ephemeral under `.gitignore`)
  - `thoughts/local/pilots/2026-04-20-GH-0820-semantic-diff-noise-floor-raw.md` (create — raw observations; gitignored under `*.local.md`)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Fixture has at least two variants: `unchanged.html` (the baseline) and `known-change.html` (baseline + one intentional layout change). Reuse from #816 Task 1.5 if available; if not, create them here.
  - [ ] **Run A (unchanged)**:
    - `/ralph-playwright:explore http://localhost:8765/unchanged.html` → session A-baseline
    - `/ralph-playwright:reflect <A-baseline-trace> --update-baseline` → promote
    - `/ralph-playwright:explore http://localhost:8765/unchanged.html` → session A-current (same URL, re-rendered)
    - `/ralph-playwright:reflect <A-current-trace> --baseline <A-baseline-trace>` at default `--noise-floor=medium`
    - Count `regression` signals in the resulting `signal-report.yaml`. Each is a false positive.
    - Repeat at `--noise-floor=low` and `--noise-floor=high`. Record counts per level.
  - [ ] **Run B (known change)**:
    - `/ralph-playwright:explore http://localhost:8765/known-change.html` → session B-current
    - `/ralph-playwright:reflect <B-current-trace> --baseline <A-baseline-trace>` at default `--noise-floor=medium`
    - Count `regression` signals. At least one should describe the injected change (true positive).
    - Repeat at `--noise-floor=low` and `--noise-floor=high`. Record counts + qualitative descriptions per level.
  - [ ] Raw notes capture: per-level false-positive count, per-level true-positive count, per-level description quality (verbatim bullets are useful; paste them)
  - [ ] Convert counts to per-step rates: false positives per 10 steps at each level
  - [ ] Pick a default:
    - `low` if false-positive rate at `medium` is too low for the recall desired AND step count is low enough to tolerate noise
    - `medium` if the rate hits the target ≤1 false positive per 10 steps AND the true positive fires
    - `high` only if `medium` produces unacceptable false positives on the unchanged run
  - [ ] Document the reasoning in the raw notes file (stays gitignored until distilled into the research doc in Task 1.3)

#### Task 1.2: Confirm or update `DEFAULT_NOISE_FLOOR`

- **files**:
  - `plugin/ralph-playwright/scripts/diff-emitter.mjs` (modify, conditionally)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Inspect the current `DEFAULT_NOISE_FLOOR` constant (set to `'medium'` by #813)
  - [ ] If the pilot data confirms `medium`, leave as-is; annotate the constant with a JSDoc comment citing the pilot doc path (created in Task 1.3)
  - [ ] If the pilot data supports flipping to `low` or `high`, change the constant; re-run `diff-emitter.test.mjs` and `reflect-diff-runner.test.mjs` to ensure tests still pass (tests should be level-agnostic — if they aren't, they have a bug and should be relaxed)
  - [ ] Corresponding update in any SKILL.md that hard-codes the default literal (should be none if #813/#816 cited the constant via code reference rather than string literal; otherwise fix)

#### Task 1.3: Write the pilot methodology research doc

- **files**:
  - `thoughts/shared/research/2026-04-20-semantic-diff-noise-floor-pilot.md` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Frontmatter: `date`, `topic`, `tags: [ralph-playwright, semantic-diff, noise-floor, pilot]`, `status: complete`, `type: research`, `github_issue: 820`
  - [ ] Summary section (≤2 paragraphs): what was tested, what was learned, what was decided
  - [ ] Methodology section documents:
    - Fixture used (path under `plugin/ralph-playwright/fixtures/semantic-diff-smoke/`)
    - Injected change (exact diff — CSS rule added, element moved, etc.)
    - Run counts (A / B, each at three noise-floor levels — six runs total)
    - Step counts per run
  - [ ] Results section contains a table:
    ```
    Noise-floor  |  A: false positives  |  B: true positives  |  Notes
    low          |  X / N steps         |  Y (incl. injected) |  <notes>
    medium       |  X / N steps         |  Y (incl. injected) |  <notes>
    high         |  X / N steps         |  Y (incl. injected) |  <notes>
    ```
    With actual numbers filled in from the pilot.
  - [ ] Decision section: which level is shipped as default, and why. Cross-link to `diff-emitter.mjs` `DEFAULT_NOISE_FLOOR` by relative repo path.
  - [ ] Worked example section: one bullet from Run B (true positive) shown verbatim, illustrating the natural-language output style.
  - [ ] Open questions section: what the pilot did NOT cover (e.g., high-res, multi-viewport, different UI styles). These become follow-up tickets or rest as known gaps.

#### Task 1.4: Rewrite `skills/visual-diff/SKILL.md`

- **files**:
  - `plugin/ralph-playwright/skills/visual-diff/SKILL.md` (modify — rewrite intro + add sections; preserve tool-setup content)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] Frontmatter unchanged in form; description may be updated to reflect two-layer framing (e.g., "Storybook-component visual regression via Chromatic/Applitools; for journey-level in-loop semantic diff see `reflect --baseline`")
  - [ ] New intro section "Two Layers of Visual Regression":
    - Paragraph 1: frame the two layers (in-loop journey-level in reflect vs component-level via Chromatic/Applitools)
    - Paragraph 2: "Both layers are complementary. Neither replaces the other."
  - [ ] New "Decision Guide" subsection with at least 5 scenarios, each mapped to a layer:
    | Scenario | Layer |
    |----------|-------|
    | Button padding tweak in a Storybook story | Chromatic/Applitools |
    | Layout shift mid-journey pushing primary CTA below fold | In-loop semantic diff |
    | Color-palette change affecting every component | Chromatic/Applitools |
    | Error-state design regression (missing error banner after form submit) | In-loop semantic diff |
    | Font-weight regression on a single story | Chromatic/Applitools |
    | Third-party widget rendering differently after upgrade | In-loop semantic diff |
  - [ ] New "Worked Example (in-loop semantic diff)" subsection reproduces the worked example from the pilot doc. Includes the verbatim bullet text.
  - [ ] New "Noise floor" subsection cites the default level + pilot-derived rationale. Links to `thoughts/shared/research/2026-04-20-semantic-diff-noise-floor-pilot.md`.
  - [ ] Existing Chromatic setup content preserved under a new heading "Component-Level Layer: Chromatic"
  - [ ] Existing Applitools setup content preserved under "Component-Level Layer: Applitools Eyes"
  - [ ] Existing "When to choose Applitools over Chromatic" content preserved with its section heading
  - [ ] New "See also" section at the bottom links to `skills/reflect/SKILL.md` (the in-loop side) and cites the parent epic issue #784 + feature issue #791
  - [ ] File grows from 45 lines to ~120-150 lines (rough target; not a hard limit)

#### Task 1.5: Verify reciprocal cross-link in `skills/reflect/SKILL.md`

- **files**:
  - `plugin/ralph-playwright/skills/reflect/SKILL.md` (verify; no modify unless link is absent)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.4]
- **acceptance**:
  - [ ] Confirm the "See also" link to `skills/visual-diff/SKILL.md` added in #816 Task 1.4 is present
  - [ ] If absent (drift), add the link in the "Semantic Visual Diff" section
  - [ ] No other changes to `reflect/SKILL.md`

### Phase Success Criteria

#### Automated Verification:
- [ ] `node --test plugin/ralph-playwright/scripts/` — all plugin test files pass (regression proof that changing `DEFAULT_NOISE_FLOOR` did not break tests)
- [ ] The produced `signal-report.yaml` from Run A at the shipped default level passes `validate-primitive-io.sh` and contains ≤1 `regression` per 10 steps
- [ ] The produced `signal-report.yaml` from Run B at the shipped default level contains ≥1 `regression` signal whose description references the injected change
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` — all passing

#### Manual Verification:
- [ ] Reviewer reads `visual-diff/SKILL.md` and can, in under 30 seconds, identify which layer handles a given real-world regression scenario
- [ ] Reviewer reads the pilot methodology doc and is convinced the noise-floor default is evidence-backed, not guessed
- [ ] Reviewer confirms cross-links render correctly on GitHub (relative-path links work both directions)
- [ ] Reviewer confirms the Chromatic + Applitools setup instructions are preserved (nothing lost in the rewrite)
- [ ] Reviewer reviews the worked example and agrees the natural-language regression bullet is more actionable than a raw pixel-diff screenshot would be

**Creates for next phase**: None. Feature complete at end of this phase.

---

## Integration Testing

No separate integration test. The pilot (Task 1.1) IS the integration test — it runs the full #806 → #809 → #813 → #816 stack against a real fixture and observes emergent behavior. Parent plan §Integration Testing step 2-5 covers the same ground in a more structured form; the pilot feeds its data into the default-setting decision.

## References

- Parent feature plan: [thoughts/shared/plans/2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff.md)
- Parent epic plan-of-plans: [thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md) Feature G
- Research: [thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md) §Part 3 Item 7 + Open Questions on "Semantic-diff noise floor"
- Issue: https://github.com/cdubiel08/ralph-hero/issues/820
- Upstream atomic: [GH-816](https://github.com/cdubiel08/ralph-hero/issues/816) (provides the `--baseline` / `--update-baseline` CLI flow used by the pilot)
- Target files:
  - [plugin/ralph-playwright/skills/visual-diff/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/visual-diff/SKILL.md)
  - `thoughts/shared/research/2026-04-20-semantic-diff-noise-floor-pilot.md` (new)
  - `plugin/ralph-playwright/scripts/diff-emitter.mjs` (conditional edit)
  - [plugin/ralph-playwright/skills/reflect/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/reflect/SKILL.md) (verification only)
