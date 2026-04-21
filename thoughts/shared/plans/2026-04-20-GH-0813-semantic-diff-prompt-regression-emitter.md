---
date: 2026-04-20
status: draft
type: plan
github_issue: 813
github_issues: [813]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/813
primary_issue: 813
parent_plan: thoughts/shared/plans/2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff.md
tags: [ralph-playwright, opus-4-7, semantic-diff, regression, prompt-engineering, emitter]
---

# ralph-playwright: Opus 4.7 semantic diff prompt + regression signal emitter — Implementation Plan

## Prior Work

- builds_on:: [[2026-04-16-opus-4-7-ralph-playwright-vision]]
- builds_on:: [[2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic]]
- builds_on:: [[2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff]]
- builds_on:: [[2026-04-20-GH-0785-ralph-playwright-reflect-opus-4-7-model-routing]]
- builds_on:: [[2026-04-20-GH-0786-reflect-structured-visual-audit-prompt]]

## Overview

Atomic #813 of Feature G. Author the Opus 4.7 semantic-diff prompt and the emitter that invokes it per `matchSteps` pair, parses the response into `regression` signals conforming to `signal-report.schema.yaml`, and respects a `--noise-floor` knob (default pending #820's pilot).

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-813 | Opus 4.7 semantic diff prompt + regression signal emitter | S |

## Shared Constraints

Inherited verbatim from the parent feature plan (§Shared Constraints). Relevant items:

### Model routing discipline (from parent)

- Reflect is routed to Opus 4.7 via frontmatter (MERGED in PR #825 / #785). The emitter INVOKES Opus 4.7; it does not re-route. For the emitter's entry-point language, "call the reflect-model" is equivalent to "call Opus 4.7 unless `RALPH_PLAYWRIGHT_REFLECT_MODEL` is set".
- The emitter MUST degrade gracefully under Sonnet (returns conservative diff output) without crashing. The prompt is designed to degrade, not break.

### Prompt engineering conventions (from parent)

- Categorized checklists beat free-form instructions. This prompt EXTENDS the seven-category structured audit from #786 (PR #826) — it does not duplicate it. Concretely: the semantic-diff prompt cites `"the seven visual-audit categories from reflect's Step 2"` and then narrows to A/B comparison.
- **Explicit ignore list, stated verbatim**: anti-aliasing, font hinting, animation frames, timestamps, cursor/caret position, minor sub-pixel rendering. Plus the "meaningful change threshold" framing from the atomic issue body.
- Output: bulleted list of natural-language change descriptions. Returns nothing when below threshold.

### Prompt engineering conventions (atomic-specific)

- The prompt must reference reflect's Step 2 seven categories by NAME so reviewers see the lineage. It should NOT re-author the categories — just say "apply reflect's Step 2 structured visual audit, restricted to A/B comparison".
- The output format for the PROMPT is a bulleted list of sentences, each in the "Submit button moved 40px down and lost its shadow" style — concrete subject + concrete change + (optional) concrete quantity. Raw diff dumps, image descriptions, or unrelated UX critique are explicitly forbidden.
- The emitter parses the prompt output deterministically. Empty response (no bullets, or only a no-change sentinel line) → zero signals. Non-empty response → one signal per bullet.

### Atomic-specific constraints

- **No inline prompt in SKILL.md.** The prompt lives in a reference file (`plugin/ralph-playwright/skills/reflect/references/semantic-diff-prompt.md`), not inside `reflect/SKILL.md`. This keeps `reflect/SKILL.md` focused on the operator-facing flow (Step 1-5) and centralizes prompt text in one place. Reflect SKILL.md will LINK to the reference in #816's SKILL.md wiring task.
- **Zero new runtime deps in the emitter.** The emitter reads images using `fs/promises`, calls the model via whatever mechanism reflect uses today (inherited from the calling agent / skill context), and parses the model response as plain text. No SDK vendoring, no `sharp`, no `pixelmatch`.
- **Emitter consumes `matchSteps` result as-is.** Does not re-match. Does not sort. Iterates `pairs` for diff calls; iterates `addedInCurrent` / `missingFromCurrent` to return an informational payload (the reflect-phase wiring in #816 is the one that decides how to surface those — the emitter just reports them).
- **`--noise-floor` knob.** Accepted values: `low | medium | high`. Semantics are prompt-side (the prompt's threshold language varies by level). Default: `medium`, pending #820's pilot (which may retune). The emitter's exported API takes a `noiseFloor` option; operators set the default via env `RALPH_PLAYWRIGHT_DIFF_NOISE_FLOOR` and #816's `--noise-floor` flag in reflect wiring.

## Current State Analysis

### Reflect today (post-#785, #786, #790)

`plugin/ralph-playwright/skills/reflect/SKILL.md`:
- Frontmatter: `model: claude-opus-4-7` (line 4) — emitter inherits this routing.
- Step 2 structured audit: seven categories with examples and signal-type mappings (lines 27-58).
- Step 3 taxonomy: `regression` defined at line 89 as "Something that previously worked now fails (requires baseline comparison)". THIS ATOMIC'S EMITTER FILLS THE REQUIREMENT.
- Step 4 YAML example includes `bboxes`; the diff emitter may OPTIONALLY populate `bboxes` for signals that reference a concrete region (e.g., "Submit button moved 40px down" — the model can describe a box around the "after" position). This is not required in this atomic — #790's bbox extension is additive across signal types.

### `matchSteps` today (post-#809)

`plugin/ralph-playwright/scripts/match-steps.mjs` exports:
- `matchSteps(currentTrace, baselineTrace) -> { pairs, addedInCurrent, missingFromCurrent }`
- `normalizeActionTarget(action, target) -> normalized-string`

### Storage helper today (post-#806)

`plugin/ralph-playwright/scripts/baseline-store.mjs` exports `readBaseline(sessionSlug, stepId)` throwing `BaselineNotFoundError` on absence. The emitter CALLS `readBaseline` to resolve baseline PNG paths before invoking the model.

### Signal schema today

`plugin/ralph-playwright/schemas/signal-report.schema.yaml`:
- `regression` is already in the type enum (line 23).
- Evidence: `steps[]`, `screenshots[]`, optional `bboxes[]`. Adequate for diff signals.
- Severity enum: `critical | high | medium | low`. Diff signals default to `medium` unless the prompt flags a blocker (e.g., primary CTA off-screen → `critical`).

### Pipeline surface today

Reflect invocations today call the model directly via the Claude Code skill runtime. Inside a skill, the model-call mechanism is the calling environment's responsibility (the skill body is prose; model calls happen when the skill is Skill-invoked or embedded as Agent(...)). For the emitter, "invoke the model" means: produce the prompt text and image payload, and either (a) return that payload for the calling skill to execute, or (b) execute directly via whatever model-invocation surface is available in the runtime context. Because ralph-playwright is skills-only (no MCP server on the plugin's side for this), option (a) is the clean separation: the emitter prepares the prompt-and-pair payload and returns "calls" that the consuming skill executes.

This atomic chooses option (a): the emitter is a **prompt-payload builder + response parser**. The consuming skill (#816's reflect wiring) is responsible for the actual model invocation between build and parse. Rationale:
- Matches how the plugin's skills work today (prompts in SKILL.md, model calls orchestrated by the runtime).
- Keeps the emitter unit-testable without a model in the loop (the tests cover response-parsing behavior with synthesized responses).
- Keeps zero new runtime deps — no SDK vendoring.

### Files reviewed

- `plugin/ralph-playwright/skills/reflect/SKILL.md` (209 lines) — frontmatter, Step 2 categories, Step 3 taxonomy
- `plugin/ralph-playwright/schemas/signal-report.schema.yaml` (107 lines) — signal envelope, regression enum entry
- `plugin/ralph-playwright/scripts/match-steps.mjs` (post-#809) — matcher output shape
- `plugin/ralph-playwright/scripts/baseline-store.mjs` (post-#806) — `readBaseline` + `BaselineNotFoundError`
- `plugin/ralph-playwright/skills/browser/references/vision-locator-prompt.md` — pattern reference (the one existing prompt-reference file in the plugin)

## Desired End State

After this atomic merges:

- `plugin/ralph-playwright/skills/reflect/references/semantic-diff-prompt.md` is the single source of truth for the diff prompt text. It references reflect's Step 2 seven categories by name; states the ignore list verbatim; specifies the output format (bullet list of change sentences); includes a concrete example output; documents the three noise-floor levels.
- `plugin/ralph-playwright/scripts/diff-emitter.mjs` exports:
  - `buildDiffPayloads(pairs, { noiseFloor, readBaseline }) -> PayloadArray`
  - `parseDiffResponse(responseText, { currentStep, baselinePath, currentPath, noiseFloor }) -> Signal[]`
  - A small module-level helper `renderPrompt({ action, target, noiseFloor }) -> string` used by both the payload-builder and the tests
- `plugin/ralph-playwright/scripts/diff-emitter.test.mjs` covers: identical pair → no signals (parser smoke), AA-noise-only response → no signals, real-layout-shift response → one `regression` signal with correct evidence block, multi-bullet response → multiple signals, noise-floor variants produce different prompt text.
- `--noise-floor` is exposed on the emitter API (default `medium`). No reflect SKILL.md change yet — that is #816.
- Zero new runtime deps. Emitter is a pure Node ESM module.

### Verification

- [ ] Reference file `semantic-diff-prompt.md` exists under `plugin/ralph-playwright/skills/reflect/references/`
- [ ] Prompt text includes all six ignore items verbatim: anti-aliasing, font hinting, animation frames, timestamps, cursor/caret position, sub-pixel rendering
- [ ] Prompt text cites "reflect Step 2 seven categories" by reference (does NOT inline them)
- [ ] Prompt text specifies "bulleted list of natural-language change descriptions" and forbids "raw diff dumps" / "image descriptions"
- [ ] Prompt text documents the three noise-floor levels with short rubric per level
- [ ] `diff-emitter.mjs` exports `buildDiffPayloads`, `parseDiffResponse`, `renderPrompt`
- [ ] Payload builder iterates `pairs` from `matchSteps`, calls `readBaseline` for each to resolve baseline path
- [ ] Payload includes: prompt text (from `renderPrompt`), two image paths (current + baseline), step context (index, action, target)
- [ ] Parser on empty/sentinel response returns `[]`
- [ ] Parser on bullet-list response returns one `Signal` per bullet
- [ ] Each produced `Signal` has `type: 'regression'`, `severity` (defaulted or per-bullet heuristic), `title` (first sentence or first N chars), `description` (full bullet), `evidence: { steps: [currentStep.index], screenshots: [currentPath, baselinePath] }`, `tags: ['semantic-diff', noiseFloor]`
- [ ] `node --test plugin/ralph-playwright/scripts/diff-emitter.test.mjs` exits 0
- [ ] A produced signal-report that merges diff signals with regular reflect signals passes `validate-primitive-io.sh`

## What We're NOT Doing

- **No direct model invocation inside the emitter.** The emitter builds payloads and parses responses; it does not call the model. #816's reflect-wiring does the calling.
- **No CLI flag plumbing.** `--baseline` / `--update-baseline` / `--noise-floor` flags are #816's responsibility. This atomic exposes the knobs via the emitter API (function options) and env vars only.
- **No reflect SKILL.md touch in this atomic.** The reference file is linked from reflect SKILL.md in #816.
- **No new signal type.** `regression` was already in the enum.
- **No automatic bbox generation.** Diff signals may CARRY bboxes if the model returns coordinate-like content, but this atomic does not coerce or require them. Bbox population is a free-form possibility; the parser accepts bbox-like structures if present in the response but does not fail on absence.
- **No auto-severity escalation.** All diff signals default to `severity: medium`. Operators / reviewers tune via #820's pilot or follow-up tuning; not this atomic.
- **No retry / backoff on model errors.** A model failure propagates as an exception; #816 decides how to surface it (probably: emit a meta-signal explaining the diff failed on step N, but do not block reflect's other signals).
- **No caching.** Each diff call is independent. If a session re-runs, diff re-runs.
- **No baseline image pre-processing.** Pass the PNG path to the model as-is. No resize, no format conversion.

## Implementation Approach

Two new files: a prompt reference and an emitter module. Test file lands with the emitter. Order: prompt reference first (so the emitter can import or `fs.readFile` the text consistently), then emitter, then tests.

---

## Phase 1: GH-813 — Opus 4.7 semantic diff prompt + regression signal emitter

- **depends_on**: [GH-809]

### Overview

Author the reference prompt file. Implement the payload-builder and response-parser. Cover the noise-floor knob. Unit-test the parser against synthesized model responses.

### Tasks

#### Task 1.1: Author the semantic-diff prompt reference

- **files**:
  - `plugin/ralph-playwright/skills/reflect/references/semantic-diff-prompt.md` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] File is a plain markdown document, no YAML frontmatter (matches the existing `plugin/ralph-playwright/skills/browser/references/` pattern)
  - [ ] Opens with a one-paragraph orientation: "This prompt powers the in-loop semantic visual diff in `reflect`'s `--baseline` mode (see #791/#816). It compares a current screenshot against its matched baseline screenshot from a prior run and emits a bulleted list of meaningful visual changes, framed in the same rubric as reflect's Step 2 structured visual audit."
  - [ ] References reflect's Step 2 seven categories BY NAME (layout integrity, typography, imagery, state visibility, visual hierarchy, chart & data UIs, viewport/responsive) with a one-line pointer to `skills/reflect/SKILL.md` Step 2 — does NOT re-author the categories
  - [ ] Ignore list stated verbatim: "Ignore these as rendering noise, not regressions: anti-aliasing, font hinting, animation frames, timestamps, cursor/caret position, minor sub-pixel rendering."
  - [ ] Output specification:
    - "Return a markdown bulleted list. One bullet per meaningful change."
    - "Each bullet is a single natural-language sentence: <subject> <change> [quantity/direction]. Examples: 'Submit button moved ~40px down and lost its drop shadow.' 'Primary navigation changed from horizontal to hamburger; three links removed.' 'Error banner replaced with inline field-level errors.'"
    - "Do NOT describe the images. Do NOT produce raw diff output. Do NOT describe unchanged elements."
    - "If there are no meaningful changes, return exactly the single line: `NO-MEANINGFUL-CHANGES`"
  - [ ] Noise-floor rubric:
    - `low`: Include any change you can see. Minor alignment shifts, color variations, font-weight changes all count.
    - `medium` (default): Include changes that affect visual hierarchy, readability, or user affordance. Skip micro-alignments and color palette tweaks that preserve intent.
    - `high`: Include only changes that meaningfully alter layout, state, or functionality. Skip stylistic refinements.
  - [ ] Input slots documented: `{{ACTION}}`, `{{TARGET}}`, `{{NOISE_FLOOR}}` — the prompt template carries these placeholders; `renderPrompt` fills them
  - [ ] Concrete example section at the bottom: shows a prompt with placeholders filled and a realistic expected response of 2-3 bullets

#### Task 1.2: Author `diff-emitter.mjs`

- **files**:
  - `plugin/ralph-playwright/scripts/diff-emitter.mjs` (create)
- **tdd**: true (tests in Task 1.3 drive shape)
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] ESM `.mjs`, uses only `node:fs/promises`, `node:path`, and imports from `./baseline-store.mjs` and `./match-steps.mjs`
  - [ ] Reads the prompt template from `plugin/ralph-playwright/skills/reflect/references/semantic-diff-prompt.md` at module load OR on each call (either is acceptable; favor on-each-call for simplicity unless profiling says otherwise)
  - [ ] Exports `renderPrompt({ action, target, noiseFloor })` returning the template with placeholders substituted
  - [ ] Exports `buildDiffPayloads(pairs, { noiseFloor = 'medium', sessionSlug, stepIdFor = (s) => String(s.index).padStart(2, '0') })`:
    - For each pair: resolves baseline path via `readBaseline(sessionSlug, stepIdFor(pair.baseline))`; returns an array of `{ currentStep, baselineStep, currentPath: pair.current.screenshot, baselinePath, prompt: renderPrompt({action, target, noiseFloor}), noiseFloor }`
    - On `BaselineNotFoundError`, propagates the error with context about which pair failed
  - [ ] Exports `parseDiffResponse(responseText, { currentStep, currentPath, baselinePath, noiseFloor })`:
    - Trims and normalizes the response
    - If the response equals `NO-MEANINGFUL-CHANGES` (case-insensitive, optional leading / trailing whitespace), returns `[]`
    - Otherwise parses bullet lines (lines starting with `- ` or `* `), emitting one signal per bullet
    - Each signal:
      - `type: 'regression'`
      - `severity: 'medium'` (default — an optional heuristic may upgrade to `high` on keywords `off-screen`, `hidden`, `blocks`, `unreadable` but this is optional and must be clearly documented in code if implemented)
      - `title: <first-40-chars-of-bullet-ending-on-word-boundary>`
      - `description: <full bullet text, stripped of leading `- `>`
      - `evidence.steps: [currentStep.index]`
      - `evidence.screenshots: [currentPath, baselinePath]` (both filenames as-is from the input payload)
      - `tags: ['semantic-diff', noiseFloor]`
    - Lines not matching a bullet pattern are ignored (robustness against model chatty preambles)
  - [ ] Exports `DiffEmitterError` subclassing `Error` with a `.code` for emitter-specific error paths (payload-build failure, response-parse failure). `BaselineNotFoundError` from #806 propagates as-is.
  - [ ] Module exports are named (not default)
  - [ ] All functions pure except for prompt-template I/O

#### Task 1.3: Test suite `diff-emitter.test.mjs`

- **files**:
  - `plugin/ralph-playwright/scripts/diff-emitter.test.mjs` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] Uses `node:test` + `node:assert/strict`
  - [ ] Test `renderPrompt` substitutes `{{ACTION}}`, `{{TARGET}}`, `{{NOISE_FLOOR}}` in the template
  - [ ] Test `renderPrompt` on each of `low`, `medium`, `high` produces three distinguishable texts (the noise-floor rubric paragraph differs per level)
  - [ ] Test `parseDiffResponse('NO-MEANINGFUL-CHANGES', ctx)` returns `[]`
  - [ ] Test `parseDiffResponse('  NO-MEANINGFUL-CHANGES\n', ctx)` (whitespace-tolerant) returns `[]`
  - [ ] Test a multi-bullet response produces N signals matching the bullet count:
    ```
    - Submit button moved ~40px down and lost its drop shadow.
    - Primary navigation collapsed from horizontal tabs to hamburger menu.
    ```
    returns 2 signals, first `description` contains "Submit button moved", second `description` contains "Primary navigation"
  - [ ] Test produced signal `type === 'regression'`, `severity === 'medium'`, `tags` includes `'semantic-diff'` AND the noise-floor value, `evidence.steps === [currentStep.index]`, `evidence.screenshots` contains both current and baseline paths
  - [ ] Test response with chatty preamble + bullets parses correctly (ignore non-bullet lines):
    ```
    After reviewing both screenshots I noticed the following meaningful changes:
    - Submit button moved ~40px down and lost its drop shadow.

    Those are the ones worth flagging at the medium noise floor.
    ```
    returns 1 signal
  - [ ] Test `buildDiffPayloads` with a mock `readBaseline` (injected via module stub pattern or direct function param — prefer the direct-param approach by accepting `readBaseline` in the options bag for testability) iterates pairs and returns payload array of matching length
  - [ ] Test `buildDiffPayloads` propagates the underlying `BaselineNotFoundError` when a baseline is missing — does not swallow
  - [ ] Schema-conformance test: pass a synthesized signal through the signal-report shape (embed in a minimal `signal-report.yaml` dict) and confirm it validates against `signal-report.schema.yaml` via a small `yq`-backed assertion OR by direct property-shape matching (since the hook validator is shell-based, property-shape matching in the unit test is acceptable)
  - [ ] `node --test plugin/ralph-playwright/scripts/diff-emitter.test.mjs` exits 0

### Phase Success Criteria

#### Automated Verification:
- [ ] `node --test plugin/ralph-playwright/scripts/diff-emitter.test.mjs` — exits 0, all tests green
- [ ] `node --test plugin/ralph-playwright/scripts/` — all three plugin test files (annotate, baseline-store, match-steps, diff-emitter) pass together
- [ ] Synthesized signal-report containing a diff-generated `regression` signal passes `validate-primitive-io.sh` with `CLAUDE_PLUGIN_ROOT=plugin/ralph-playwright` (exit 0)
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` — all passing

#### Manual Verification:
- [ ] Reviewer reads `semantic-diff-prompt.md` and confirms the seven categories are referenced (not duplicated), the ignore list is verbatim, the output format is unambiguous, and noise-floor rubrics are distinguishable
- [ ] Reviewer confirms `diff-emitter.mjs` has zero new external dependencies and uses `readBaseline` from #806 for baseline resolution
- [ ] Reviewer confirms the parser's empty-response and chatty-preamble handling matches the documented prompt contract (model MAY add preamble; parser MUST be robust)
- [ ] Reviewer runs one manual diff call against a local fixture with an intentional change (not required as part of PR checks; useful for sanity) and observes a natural-language `regression` bullet

**Creates for next phase**: `buildDiffPayloads` + `parseDiffResponse` (called by #816's reflect-phase wiring), the prompt reference file (linked from reflect SKILL.md in #816), and the `noiseFloor` option (wired to a CLI flag in #816).

---

## Integration Testing

No integration test at the atomic level beyond the schema-conformance check. The emitter's output merging with reflect's other signals is exercised at the feature level (parent plan §Integration Testing, steps 2-5).

## References

- Parent feature plan: [thoughts/shared/plans/2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0791-ralph-playwright-semantic-visual-diff.md)
- Parent epic plan-of-plans: [thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md) Feature G
- Research: [thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md) §Part 3 Item 7 + Open Question on noise-floor
- Issue: https://github.com/cdubiel08/ralph-hero/issues/813
- Upstream atomics:
  - [GH-806](https://github.com/cdubiel08/ralph-hero/issues/806) — provides `readBaseline` + `BaselineNotFoundError`
  - [GH-809](https://github.com/cdubiel08/ralph-hero/issues/809) — provides `matchSteps` output shape
- Downstream consumer: [GH-816](https://github.com/cdubiel08/ralph-hero/issues/816) — wires emitter into reflect flow with CLI flags
- Just-shipped foundation:
  - [PR #825](https://github.com/cdubiel08/ralph-hero/pull/825) — reflect Opus 4.7 routing (`model: claude-opus-4-7` frontmatter the emitter inherits)
  - [PR #826](https://github.com/cdubiel08/ralph-hero/pull/826) — reflect Step 2 seven-category structured audit (cited by the diff prompt)
- Reference pattern: [plugin/ralph-playwright/skills/browser/references/vision-locator-prompt.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/browser/references/vision-locator-prompt.md) — existing reference-file idiom
- Signal schema (unchanged): [plugin/ralph-playwright/schemas/signal-report.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/signal-report.schema.yaml)
