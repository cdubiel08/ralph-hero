---
date: 2026-04-20
status: draft
type: plan
github_issue: 816
github_issues: [816]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/816
primary_issue: 816
parent_plan: thoughts/shared/plans/2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff.md
tags: [ralph-playwright, opus-4-7, semantic-diff, reflect-phase, cli, baseline]
---

# ralph-playwright: reflect-phase wiring + `--baseline` / `--update-baseline` CLI flags — Implementation Plan

## Prior Work

- builds_on:: [[2026-04-16-opus-4-7-ralph-playwright-vision]]
- builds_on:: [[2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic]]
- builds_on:: [[2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff]]
- builds_on:: [[2026-04-20-GH-0785-ralph-playwright-reflect-opus-4-7-model-routing]]
- builds_on:: [[2026-04-20-GH-0786-reflect-structured-visual-audit-prompt]]

## Overview

Atomic #816 of Feature G. Integrate the semantic visual diff into the `reflect` phase and expose it to operators via `--baseline PATH` and `--update-baseline` CLI flags. This is the user-facing surface that lights up once baseline storage (#806), step matching (#809), and the diff emitter (#813) are in place.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-816 | reflect-phase wiring + `--baseline` / `--update-baseline` CLI flags | S |

## Shared Constraints

Inherited verbatim from the parent feature plan (§Shared Constraints). Key items relevant here:

### Architecture & file ownership (from parent)

- Reflect runs in the calling model's context (not a sub-agent). The `--baseline` flag modifies reflect's behavior by adding a diff phase between Step 2 (visual audit) and Step 4 (write signal report). It does NOT introduce a new agent or change the `model:` frontmatter.
- The reflect SKILL.md is the operator-facing documentation surface. This atomic ADDS a flag documentation section + usage example; it preserves the existing Steps 1-5 structure.

### Feature-specific constraints (from parent)

- **Regression signals do NOT embed diff images.** Signal evidence: `steps: [current-index]`, `screenshots: [current-path, baseline-path]`. No third "diff.png" artifact.
- **`--update-baseline` is an explicit action, never implicit.** Reflect with `--baseline` only reads; never writes. `--update-baseline` is a distinct, explicit invocation.
- **Missing baseline fails loudly.** Actionable error message when `--baseline` is provided but the baseline directory has no screenshots for matched steps.
- **No parallel regression mechanism.** Builds on #785 (Opus 4.7 reflect routing), #786 (structured visual audit), #806 (storage), #809 (matcher), #813 (prompt + emitter). No new model-call framework introduced here.

### Atomic-specific constraints

- **Pick `--baseline` flag approach over `reflect-diff` sub-skill.** The issue body offers either route; this plan picks `--baseline` on the existing reflect skill because:
  1. The diff is a specialization of reflect's Step 2, not an independent workflow. Keeping it as a flag on reflect keeps the skill tree flat.
  2. `--update-baseline` is the natural symmetric flag. A separate `reflect-diff` sub-skill would need its own refresh verb and the plugin's skill-count budget is finite.
  3. `skills/visual-diff/SKILL.md` stays the alternate-layer pointer (Chromatic/Applitools for component granularity). Carving a third `reflect-diff` skill dilutes the division of labor #820 is about to document.
  If a reviewer prefers the sub-skill approach during implementation, re-plan via `/ralph-plan` to switch — this decision is explicit and revisable.
- **Mutually exclusive flags.** `--baseline` and `--update-baseline` cannot be combined in one invocation. Using both emits an error citing the conflict. Rationale: `--update-baseline` overwrites baselines; running it in the same invocation that also tries to diff would be ambiguous (diff against old or new?).
- **Invocation accepts the baseline path as a TRACE path, not a directory.** `--baseline ./path/to/journey-trace.yaml` points at a prior run's trace file. The session slug is resolved from the trace's `session` field; baseline PNGs are looked up under `thoughts/local/baselines/<slug>/<stepId>.png`. This keeps the operator's mental model simple: "compare against this prior run" rather than "compare against this baseline directory".
- **`--update-baseline` accepts an optional trace path defaulting to the most recent session**. Usage: `/ralph-playwright:reflect --update-baseline ./path/to/journey-trace.yaml` promotes that run's screenshots into the baseline dir for its slug. Without a path, the flow uses the most recently written trace under `.playwright-cli/`.
- **Added / removed steps do NOT emit `regression` signals.** Per parent constraint "regression signals have natural-language descriptions": an added / removed step is not a regression; it's a diff. Map those to an existing informational type (`anomaly` with tag `[step-added-vs-baseline]` or `[step-missing-vs-baseline]`, severity `low`), OR include them only as a summary block in the report (no signal emission). This plan picks the `anomaly`-with-tags option because it stays inside the signal machinery and surfaces automatically in reports.

## Current State Analysis

### Reflect today (post-#785, #786, #790)

`plugin/ralph-playwright/skills/reflect/SKILL.md`:
- Frontmatter: `model: claude-opus-4-7`, `allowed-tools: [Read, Write]`.
- Step 1: Read the trace.
- Step 2: Examine each step (seven-category structured visual audit, per-step).
- Step 3: Classify signals.
- Step 4: Write signal report.
- Step 5: Report.
- Model Routing section documents the Opus 4.7 default + `RALPH_PLAYWRIGHT_REFLECT_MODEL` override.

The skill is invoked either directly (`/ralph-playwright:reflect <trace>`) or inline from `explore`, `test-e2e`, `a11y-scan`, `capture`, `ux-audit`.

### Artifacts produced by atomics upstream

- `plugin/ralph-playwright/scripts/baseline-store.mjs` (from #806): `readBaseline`, `writeBaseline`, `resolveSessionSlug`, `resolveStepId`, `BaselineNotFoundError`
- `plugin/ralph-playwright/scripts/match-steps.mjs` (from #809): `matchSteps`
- `plugin/ralph-playwright/schemas/journey-trace.schema.yaml` (from #809): optional `baseline_ref` field
- `plugin/ralph-playwright/scripts/diff-emitter.mjs` (from #813): `buildDiffPayloads`, `parseDiffResponse`, `renderPrompt`
- `plugin/ralph-playwright/skills/reflect/references/semantic-diff-prompt.md` (from #813): the prompt itself

### Files reviewed

- `plugin/ralph-playwright/skills/reflect/SKILL.md` (209 lines) — primary edit target
- `plugin/ralph-playwright/skills/browser/SKILL.md` — pattern reference for flag documentation style
- `plugin/ralph-playwright/skills/explore/SKILL.md` — pattern reference for `--vision-first` flag doc (lines 19-24 document an opt-in flag with a companion `When to use` section, same style this atomic uses for `--baseline`)

## Desired End State

After this atomic merges:

- Operators can run `/ralph-playwright:reflect --baseline ./path/to/prior/journey-trace.yaml <current-trace>` and receive a signal report with `regression` signals for meaningful layout changes.
- Operators can run `/ralph-playwright:reflect --update-baseline ./path/to/journey-trace.yaml` (or omit the path to use the latest) and promote that run's screenshots into the baseline dir.
- `--baseline` without a corresponding populated baseline dir fails with an actionable error message; does not emit empty-diff signals.
- Reflect's signal-report.yaml continues to validate under `validate-primitive-io.sh`. The diff signals merge into the existing `signals[]` array; schema unchanged.
- `skills/reflect/SKILL.md` documents both flags, an example invocation, the refresh workflow, and cross-links to `skills/visual-diff/SKILL.md` (the latter is rewritten in #820).

### Verification

- [x] `--baseline PATH` flag wired into reflect invocation path
- [x] `--update-baseline [PATH]` flag wired, distinct from `--baseline`
- [x] Mutually exclusive check fires when both are provided together
- [x] `--baseline` loads the prior trace, calls `matchSteps`, resolves baseline paths via `readBaseline`, invokes the emitter for each matched pair, merges results into the signal report
- [x] Emitter invocation respects `RALPH_PLAYWRIGHT_DIFF_NOISE_FLOOR` env var (or `--noise-floor` sub-flag if the operator passes it)
- [x] Added / removed steps emit `anomaly` signals with appropriate tags, not `regression`
- [x] Missing-baseline directory case fails loudly: error message cites the expected baseline path, the session slug, and a hint to run `--update-baseline` first
- [x] `--update-baseline` copies each PNG from the target run's `.playwright-cli/<session>/` into `thoughts/local/baselines/<slug>/<NN>.png`, overwriting prior baselines
- [x] `--update-baseline` logs which files were promoted (count + paths) to stdout; does not emit a signal report
- [x] `skills/reflect/SKILL.md` contains a new section documenting both flags with an example invocation
- [x] `skills/reflect/SKILL.md` cross-links to `skills/visual-diff/SKILL.md` in a "See also" block
- [ ] End-to-end smoke: run the flow twice with a known layout change between runs; confirm a `regression` signal fires on the changed step
- [ ] End-to-end smoke: run the flow twice without any change; confirm no `regression` signals fire (modulo noise-floor tolerance from the pilot — this atomic ships with default `medium`; #820 may retune)
- [x] Signal report with merged diff signals passes `validate-primitive-io.sh`

## What We're NOT Doing

- **No new skill.** The diff is added to `reflect` via flags. No `reflect-diff` sub-skill is created.
- **No execute-phase change.** `explorer-agent` and `story-runner-agent` stay on `model: sonnet` and do not emit `baseline_ref`. #816 populates `baseline_ref` AT REFLECT-LOAD-TIME on the current trace for downstream visibility; the execute-phase artifacts are untouched.
- **No noise-floor retuning in this atomic.** Default stays `medium`. #820 runs the pilot and updates the default; this atomic ships with a placeholder that #820 either confirms or revises in a follow-up PR.
- **No diff-image artifact.** Signal evidence points at two PNG paths; no third "diff.png" is rendered.
- **No auto-promotion on successful diff.** Operators who want to accept a change as the new baseline re-invoke `--update-baseline` explicitly. Symmetry with Git: staging and committing are distinct acts.
- **No visual-diff SKILL.md rewrite.** Rewrite is #820's job. This atomic only adds cross-link in `reflect/SKILL.md`.
- **No multi-trace diff.** One baseline trace, one current trace. Ensemble diff is out of scope.
- **No partial-run diff.** Diff runs on whatever steps `matchSteps` pairs; no per-step include/exclude filter. Operators skip baseline by not passing `--baseline`.
- **No CI / auto-run.** `--baseline` is manual / scripted on the operator's side. No default-on behavior.

## Implementation Approach

The reflect skill is prose (YAML frontmatter + Markdown describing the flow). The "wiring" is: (a) skill-documentation additions teaching the runtime what the flags mean and how to route them, and (b) script helpers under `plugin/ralph-playwright/scripts/` the skill invokes via `Bash(node ...)` for the diff phase and the baseline-update phase.

The plan has three tasks:

1. Author `reflect-diff-runner.mjs` — the orchestrator that takes a current trace + baseline trace, runs the full diff pipeline (load traces, call matchSteps, call buildDiffPayloads, invoke the model, call parseDiffResponse, merge signals), and returns the merged signal array. Callable as CLI for skill use.
2. Author `update-baseline.mjs` — the orchestrator for the `--update-baseline` path. Reads a trace, iterates its steps, copies each step's screenshot into the baseline dir via `writeBaseline`. Emits a summary line.
3. Update `skills/reflect/SKILL.md` to document the flags, the flow, and the cross-links. Include the CLI invocations for both helpers.

Why this split: step 1 and 2 are orchestration logic (non-trivial; testable as Node modules). Step 3 is documentation (must match what reviewers see). Keeping the orchestration in Node scripts (instead of inline shell in the SKILL.md) lets the tests cover behavior rather than prose.

---

## Phase 1: GH-816 — reflect-phase wiring + `--baseline` / `--update-baseline` CLI flags

- **depends_on**: [GH-813]

### Overview

Author the diff-runner and baseline-updater scripts. Document the flags in `reflect/SKILL.md`. End-to-end smoke-test against a local fixture.

### Tasks

#### Task 1.1: Author `reflect-diff-runner.mjs`

- **files**:
  - `plugin/ralph-playwright/scripts/reflect-diff-runner.mjs` (create)
- **tdd**: true (tests in Task 1.3 cover module)
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [x] ESM `.mjs`, uses only `node:fs/promises`, `node:path`, a YAML parser (if `yq` is available in the plugin's environment, shelling out to it via `child_process.execFile` is acceptable; otherwise use a tiny inline YAML parser — PREFER the `yq` shell-out because the existing hook already depends on `yq` per `validate-primitive-io.sh`, keeping dep surface constant), and imports from `./baseline-store.mjs`, `./match-steps.mjs`, `./diff-emitter.mjs`
  - [x] CLI surface: `node plugin/ralph-playwright/scripts/reflect-diff-runner.mjs --current PATH --baseline PATH [--noise-floor LEVEL] [--out PATH]` (options parsed manually; no `commander` / `yargs` dep)
  - [x] Function surface (exported for tests): `runReflectDiff({ currentTracePath, baselineTracePath, noiseFloor, modelInvoker })`:
    - Loads `currentTracePath` as YAML
    - Loads `baselineTracePath` as YAML
    - Calls `matchSteps(current, baseline)`
    - Calls `buildDiffPayloads(pairs, { noiseFloor, sessionSlug: resolveSessionSlug(baseline.session) })`
    - For each payload: calls `modelInvoker(payload)` to get the response text, then `parseDiffResponse(responseText, context)` to get signals
    - Builds informational signals for `addedInCurrent` and `missingFromCurrent`:
      - Each becomes one `anomaly` signal with `severity: low`, `tags: ['step-added-vs-baseline']` or `['step-missing-vs-baseline']`, description includes the step's `(action, target)`
    - Returns `{ signals: [...diffSignals, ...infoSignals], meta: { pairsCount, addedCount, missingCount, noiseFloor } }`
  - [x] `modelInvoker` is a dependency-injection parameter. Default (production) implementation: call Claude via whatever mechanism is available in the skill runtime context. For the SCRIPT CLI path, the default modelInvoker is a thin shell-out to a separate tool (skipped if no credentials available — the CLI then prints a sane error). For TESTING, a stub modelInvoker is injected that returns pre-canned response text. This keeps the module testable.
  - [x] Missing baseline file at `baselineTracePath` → fail loudly with a readable error
  - [x] Missing baseline PNG for a matched pair (`BaselineNotFoundError` from `readBaseline`) → fail loudly citing the pair's step index, session slug, and expected path
  - [x] If `--out` is provided, write the produced signal array to that YAML file (embedded in a minimal signal-report.yaml envelope); otherwise print to stdout as JSON

#### Task 1.2: Author `update-baseline.mjs`

- **files**:
  - `plugin/ralph-playwright/scripts/update-baseline.mjs` (create)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] ESM `.mjs`, minimal deps (`fs/promises`, `path`, `./baseline-store.mjs`)
  - [x] CLI surface: `node plugin/ralph-playwright/scripts/update-baseline.mjs --trace PATH` (or no arg → find the most recent `.playwright-cli/<session>/journey-trace.yaml`)
  - [x] Function surface (exported for tests): `updateBaseline({ tracePath })`:
    - Loads the trace
    - Resolves session slug from `trace.session`
    - Iterates `trace.steps[]`; for each step with a non-empty `screenshot` path, calls `writeBaseline(slug, step.index, step.screenshot)`
    - Returns `{ promoted: [{ stepIndex, dest }, ...], slug, tracePath }`
  - [x] CLI prints a summary: `N screenshots promoted to thoughts/local/baselines/<slug>/` with the path list
  - [x] Missing trace path → fail loudly with the standard error envelope

#### Task 1.3: Unit tests for both orchestrators

- **files**:
  - `plugin/ralph-playwright/scripts/reflect-diff-runner.test.mjs` (create)
  - `plugin/ralph-playwright/scripts/update-baseline.test.mjs` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - [x] `reflect-diff-runner.test.mjs` covers:
    - Happy path: two traces, three matching steps, stub modelInvoker returns one bullet per pair → 3 regression signals + 0 info signals
    - Added step: current has one extra step → 0 regression + 1 `anomaly` with `tag: step-added-vs-baseline`
    - Missing step: baseline has one extra step → 0 regression + 1 `anomaly` with `tag: step-missing-vs-baseline`
    - Identical response (`NO-MEANINGFUL-CHANGES`): 0 signals
    - Missing baseline file (trace exists but PNG absent): throws with a readable error citing step / slug / path
    - `noiseFloor` option propagates to the payload builder (verify by capturing the payloads with a spy-modelInvoker)
  - [x] `update-baseline.test.mjs` covers:
    - Trace with N steps whose screenshots exist in a tmp session dir → N files promoted to a tmp baseline dir; `promoted.length === N`
    - Trace with a step whose screenshot path is missing on disk → the step is skipped with a warning but other steps still promote; returned `promoted` excludes the skipped step
    - Trace with no steps → empty `promoted`, no error
    - Slug resolution matches `resolveSessionSlug(trace.session)` from `baseline-store.mjs`
  - [x] Both tests use `os.tmpdir()` / `fs.mkdtemp` for scratch space; cleanup in after-hooks
  - [x] `node --test plugin/ralph-playwright/scripts/reflect-diff-runner.test.mjs plugin/ralph-playwright/scripts/update-baseline.test.mjs` exits 0

#### Task 1.4: Update `skills/reflect/SKILL.md` with flag documentation

- **files**:
  - `plugin/ralph-playwright/skills/reflect/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - [x] Input section (line 12-15) keeps the existing "Path to a journey trace YAML file" sentence and adds: "Optional flags — `--baseline PATH` to run semantic visual diff against a prior run's trace; `--update-baseline [PATH]` to promote a completed run's screenshots into the baseline dir."
  - [x] A new section BEFORE the Model Routing section titled **Semantic Visual Diff (`--baseline` / `--update-baseline`)** explains:
    1. What the flag does ("compare current screenshots against a prior run's baselines; emit `regression` signals for meaningful changes")
    2. When to use it (intentional regression checks, pre-release sanity sweeps, investigating "something feels different" reports)
    3. Example invocation (matches the explore skill's flag-documentation style, lines 19-24):
       ```
       /ralph-playwright:reflect ./current/journey-trace.yaml \
         --baseline ./prior/journey-trace.yaml
       ```
    4. Refresh workflow: run normally; when satisfied, invoke `--update-baseline ./path/to/trace.yaml` to accept the current state as the new baseline. Stress the explicit-action framing.
    5. Missing-baseline failure mode: cite the actionable error message so operators know what to expect
    6. Mutual-exclusivity note: `--baseline` and `--update-baseline` cannot combine in one invocation
    7. Noise-floor knob: `RALPH_PLAYWRIGHT_DIFF_NOISE_FLOOR=low|medium|high` (default `medium`, may be updated by #820's pilot)
    8. Pointer to the diff prompt text: `plugin/ralph-playwright/skills/reflect/references/semantic-diff-prompt.md` (linked)
    9. **See also** subsection linking `skills/visual-diff/SKILL.md` with a one-line "for Storybook-component-level pixel diffing, see Chromatic/Applitools integration" pointer
  - [x] CLI invocation for the underlying script is shown as an escape hatch for operators who want to automate:
    ```
    node plugin/ralph-playwright/scripts/reflect-diff-runner.mjs \
      --current ./current/journey-trace.yaml \
      --baseline ./prior/journey-trace.yaml \
      --noise-floor medium \
      --out ./signal-report.yaml
    ```
  - [x] `--update-baseline` CLI escape hatch:
    ```
    node plugin/ralph-playwright/scripts/update-baseline.mjs \
      --trace ./current/journey-trace.yaml
    ```
  - [x] Steps 1-5 of the existing flow remain intact. The new section is additive, placed between Step 5 and the Model Routing section.
  - [x] `allowed-tools` frontmatter gains `Bash(node *)` (or more narrowly `Bash(node plugin/ralph-playwright/scripts/*)`) to let the skill invoke the orchestrator scripts. Existing `Read` and `Write` remain.

#### Task 1.5: End-to-end smoke test against a fixture

- **files**:
  - `plugin/ralph-playwright/fixtures/semantic-diff-smoke/` (create) — minimal local HTML fixture with an intentional CSS change between "v1" and "v2" variants
  - `thoughts/local/pilots/2026-04-20-GH-0816-semantic-diff-smoke.md` (create, gitignored) — pilot notes
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1, 1.2, 1.4]
- **acceptance**:
  - [x] Fixture directory contains `v1.html` and `v2.html`; the only difference is a CSS change on the primary CTA (e.g., `margin-top` increase + `box-shadow: none`) and/or the addition of a visible element
  - [x] A short `README.md` in the fixture directory documents how to serve it (`python3 -m http.server -d ./plugin/ralph-playwright/fixtures/semantic-diff-smoke 8765`) and the expected diff outcome
  - [ ] Operator runs `/ralph-playwright:explore http://localhost:8765/v1.html` to produce the baseline session
  - [ ] Operator runs `/ralph-playwright:reflect <baseline-session-trace> --update-baseline` to promote the baseline PNGs
  - [ ] Operator runs `/ralph-playwright:explore http://localhost:8765/v2.html` to produce the "current" session
  - [ ] Operator runs `/ralph-playwright:reflect <current-session-trace> --baseline <baseline-session-trace>` and confirms:
    - At least one `regression` signal fires with a natural-language description consistent with the injected change
    - `validate-primitive-io.sh` exits 0 on the produced `signal-report.yaml`
    - `signal-report.yaml` also validates through the unit-test's property-shape matcher if re-run
  - [ ] Re-running the same flow against `v1.html` with `v1.html` as both baseline and current produces zero `regression` signals (at default noise-floor)
  - [x] Pilot notes capture: observed signal count, description quality, false-positive count, any surprises (template seeded; values pending live operator run)

### Phase Success Criteria

#### Automated Verification:
- [x] `node --test plugin/ralph-playwright/scripts/reflect-diff-runner.test.mjs` — exits 0
- [x] `node --test plugin/ralph-playwright/scripts/update-baseline.test.mjs` — exits 0
- [x] `node --test plugin/ralph-playwright/scripts/` — all plugin test files pass together
- [x] `validate-primitive-io.sh` exits 0 on a synthesized `signal-report.yaml` containing diff + informational signals
- [x] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors
- [x] `cd plugin/ralph-hero/mcp-server && npm test` — all passing

#### Manual Verification:
- [ ] Reviewer reads updated `reflect/SKILL.md` and confirms: flag docs are complete, example invocations are copy-paste-ready, See-also pointer to `visual-diff/SKILL.md` renders
- [ ] Reviewer confirms the pilot note captured in Task 1.5 shows a natural-language regression description (not a diff dump)
- [ ] Reviewer confirms missing-baseline error message is actionable (cites slug, step, path)
- [ ] Reviewer confirms `--baseline` + `--update-baseline` together emits a clear mutual-exclusivity error
- [ ] Reviewer confirms `--noise-floor` env override works (tested by flipping to `high` and rerunning)

**Creates for next phase**: The fully-wired flow that #820's pilot exercises at scale. #820 uses these CLIs verbatim.

---

## Integration Testing

Feature-level integration testing is defined in the parent plan's §Integration Testing (steps 1-8). This atomic's smoke test (Task 1.5) covers the happy path and one failure mode; the parent integration test covers the full matrix including missing-baseline, mutual-exclusivity, and schema compliance.

## References

- Parent feature plan: [thoughts/shared/plans/2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff.md)
- Parent epic plan-of-plans: [thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md) Feature G
- Research: [thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md) §Part 3 Item 7
- Issue: https://github.com/cdubiel08/ralph-hero/issues/816
- Upstream atomics:
  - [GH-806](https://github.com/cdubiel08/ralph-hero/issues/806) — `baseline-store.mjs` helpers
  - [GH-809](https://github.com/cdubiel08/ralph-hero/issues/809) — `match-steps.mjs`
  - [GH-813](https://github.com/cdubiel08/ralph-hero/issues/813) — `diff-emitter.mjs` + prompt reference
- Downstream consumer: [GH-820](https://github.com/cdubiel08/ralph-hero/issues/820) — pilot + visual-diff/SKILL.md rewrite
- Target files:
  - [plugin/ralph-playwright/skills/reflect/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/reflect/SKILL.md)
  - `plugin/ralph-playwright/scripts/reflect-diff-runner.mjs` (new)
  - `plugin/ralph-playwright/scripts/update-baseline.mjs` (new)
- Pattern reference (flag documentation idiom): [plugin/ralph-playwright/skills/explore/SKILL.md lines 19-51](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/explore/SKILL.md)
