---
date: 2026-04-20
status: draft
type: plan
github_issue: 789
github_issues: [789]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/789
primary_issue: 789
parent_plan: thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md
tags: [ralph-playwright, opus-4-7, vision, a11y, alt-text]
---

# ralph-playwright: Alt-Text Relevance Validation via Screenshot — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-16-opus-4-7-ralph-playwright-vision]]
- builds_on:: [[2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic]]

## Overview

Single XS/S issue (#789, estimate S, Feature E in the epic). Extends the existing a11y-scan reflect step to not just check alt-attribute presence but to verify that the alt text actually describes what is visible in the corresponding image region of the screenshot. Decorative images (`alt=""`) remain compliant. Mismatches emit `a11y_violation` signals tagged `[alt-relevance]`.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-789 | ralph-playwright: alt-text relevance validation via screenshot | S |

**Standalone feature**: single phase, single PR. No sub-issues, no split needed.

## Shared Constraints

Inherited verbatim from the parent plan-of-plans ([GH-0784](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md)):

### Architecture & file ownership
- Execute -> Reflect -> Act pipeline is strict and schema-enforced. Any new inputs/outputs flow through the three YAML schemas in [plugin/ralph-playwright/schemas/](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas). Schema additions must be additive unless explicitly noted.
- Hooks in [plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh) validate journey-trace, signal-report, and action-log YAMLs at Read and Write boundaries. Any schema change that tightens validation must update the hook in the same PR.
- Execute runs as a sub-agent with `model: sonnet`. Reflect runs in the calling model's context — that is the sole tier where Opus 4.7 routing applies.
- Screenshots (PNG) and accessibility snapshots (`.md`) are captured at EVERY step. No feature may opt out of either capture.
- The "NEVER use CSS selectors" rule in [plugin/ralph-playwright/agents/story-runner-agent.md:50](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/agents/story-runner-agent.md#L50) stays in force.

### Cost & token envelope
- Default capture resolution stays at the playwright-cli current viewport default.
- Opus 4.7 is materially more expensive per screenshot than Sonnet at 1568px. Alt-text relevance analysis runs in the reflect phase only (Opus 4.7 by default via GH-785).

### Prompt engineering conventions
- **Decorative images are compliant**: `alt=""` (empty-string explicit alt) is the WCAG-recommended pattern for presentational images. The prompt MUST NOT flag these. Only flag when `alt` is present, non-empty, AND fails to describe the visible content.
- Alt-text relevance prompts must treat three cases distinctly:
  1. **Missing `alt` attribute entirely** — already caught by existing [skills/a11y-scan/SKILL.md:40](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/a11y-scan/SKILL.md#L40) check; do NOT duplicate here.
  2. **Explicit `alt=""`** — decorative, compliant, skip.
  3. **Non-empty `alt`** — run relevance check against the visible image region.

### Artifact paths
- Session data: `.playwright-cli/<session>/` (journey-trace.yaml, signal-report.yaml, action-log.yaml, screenshots, snapshots).
- Promoted evidence: `thoughts/local/assets/<session>/`.
- Fixture pages for verification: `plugin/ralph-playwright/fixtures/alt-relevance/` (new directory; first fixture set of this epic).

### Feature-specific constraints (extensions)
- **No new skill**. This is a reflect-step addition inside the existing `a11y-scan` skill. No new CLI flag, no new environment variable.
- **No new signal type**. Uses the existing `a11y_violation` enum value with a new tag `[alt-relevance]`. This means zero changes to [schemas/signal-report.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/signal-report.schema.yaml) and zero changes to [hooks/scripts/validate-primitive-io.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh). The `tags` field on a signal is already an unrestricted array of strings ([signal-report.schema.yaml:47-50](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/signal-report.schema.yaml#L47-L50)).
- **WCAG anchoring**: Alt-text relevance violations map to WCAG 2.2 Success Criterion [1.1.1 Non-text Content (Level A)](https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html). The description emitted in signals must cite this criterion.
- **Image region access strategy**: The reflect model has access to the full step screenshot. It does NOT need to separately fetch `<img src>` URLs — for single-page visible images, the rendered pixels in the screenshot ARE the authoritative content the user sees. Hidden or off-screen images in the DOM are out of scope for this feature (they are a separate a11y concern tracked elsewhere). See Task 1.2 for the cropping / referencing approach.

### Research anchoring
Per parent plan requirement, this feature derives from research doc [thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md) §Part 3 Item 5 ("Alt-text relevance validation").

## Current State Analysis

From [plugin/ralph-playwright/skills/a11y-scan/SKILL.md:40](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/a11y-scan/SKILL.md#L40), the Step 2 Reflect checklist currently contains a single bullet for images:

> - **Missing alt text**: Images without `alt` attribute

This check operates solely against the accessibility snapshot `.md` file (per [skills/a11y-scan/SKILL.md:32](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/a11y-scan/SKILL.md#L32) "examine the accessibility snapshot (`.md` file)"). It has three gaps:

1. **No relevance check** — an image with `alt="Submit button"` over a photograph of a dog passes the existing check despite the alt being wrong.
2. **No aria-label or figcaption coverage** — `<img aria-label="...">`, `<figure><img><figcaption>...</figcaption></figure>`, and `<img role="img" aria-labelledby="...">` are not mentioned.
3. **No decorative-image distinction** — the current one-liner says "Images without `alt` attribute" but does not explicitly exempt `alt=""`. A naive reader could over-flag.

The accessibility snapshot captured by `playwright-cli snapshot` already includes image alt text (observable in Playwright's `_snapshotForAI` which emits lines like `- img "alt text here" [ref=eXX]`). This is the DOM-level signal. The screenshot PNG contains the rendered pixels. Cross-referencing the two is what this feature adds.

Relevant files:
- [plugin/ralph-playwright/skills/a11y-scan/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/a11y-scan/SKILL.md) — target for edit
- [plugin/ralph-playwright/schemas/signal-report.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/signal-report.schema.yaml) — no edit required (tags array is unrestricted)
- [plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh) — no edit required
- [plugin/ralph-playwright/skills/reflect/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/reflect/SKILL.md) — reflect step context, no edit required (a11y-scan has its own reflect step)
- [plugin/ralph-playwright/agents/explorer-agent.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/agents/explorer-agent.md) — drives execution for a11y-scan; no edit required

## Desired End State

After this plan lands:

1. The a11y-scan SKILL.md Step 2 Reflect section contains a new image-relevance sub-procedure that:
   - Iterates every image reference in the accessibility snapshot that has non-empty alt text, aria-label, or an associated figcaption/aria-labelledby.
   - For each, uses the step's screenshot PNG to locate the image region and judge whether the alt text accurately describes what the image depicts.
   - Emits `a11y_violation` signals with tag `[alt-relevance]` and severity derived from a simple rubric.
   - Explicitly skips decorative images (`alt=""`) without emitting a violation.
2. A fixtures directory under `plugin/ralph-playwright/fixtures/alt-relevance/` contains a static HTML page exercising six cases: (i) good alt, (ii) bad/mismatched alt, (iii) misleading alt, (iv) decorative `alt=""`, (v) figcaption-provided label, (vi) aria-label on `role="img"`. This fixture can be served locally and audited end-to-end to verify the new prompt produces the expected signal set.
3. A short README at `plugin/ralph-playwright/fixtures/alt-relevance/README.md` explains the expected reflect outcome per case (the "answer key") so future regressions are detectable.

### Verification
- [ ] Running `/ralph-playwright:a11y-scan` against the fixture page produces exactly the signals documented in the fixture README (0 signals for cases i, iv, v, vi; 2 signals for cases ii, iii, both tagged `[alt-relevance]`).
- [ ] Running `/ralph-playwright:a11y-scan` on a real application page with a mix of good and decorative images produces no false positives on `alt=""` images and flags at most one true positive per genuinely mismatched alt.
- [ ] [plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh) does not reject the generated `signal-report.yaml` (it should not — no schema change).
- [ ] The WCAG 1.1.1 reference appears in the description of every emitted `[alt-relevance]` signal.

## What We're NOT Doing

- **Not modifying the signal-report schema.** Using the existing `a11y_violation` type with a new tag is sufficient; adding a dedicated `alt_relevance_violation` type would duplicate the a11y taxonomy without benefit. If downstream consumers need to filter, they can grep the tags array.
- **Not adding a separate skill.** The logic belongs inside `a11y-scan` because it is one of several a11y-scan reflect heuristics, not a standalone audit flow.
- **Not fetching image `src` URLs to re-download pixels.** The already-captured step screenshot is the source of truth for what the user sees. Hidden / off-screen / lazy-loaded images that are never in frame are out of scope.
- **Not performing object-detection or pixel-exact bounding-box extraction.** Opus 4.7 can identify image regions visually without sidecar metadata. Bounding-box capture is handled by a separate feature (GH-790 Feature F — Annotated evidence screenshots with bounding boxes) and this plan does not block on it. If GH-790 lands first, a later amendment can reuse its bbox output; if it lands later, alt-relevance signals will carry textual region descriptions and populate `bboxes` opportunistically.
- **Not adding pixel-level contrast checks.** That is GH-788 Feature D. Orthogonal.
- **Not changing the a11y-scan execute phase or the explorer-agent.** All changes are in the reflect-phase prompt inside a11y-scan/SKILL.md.
- **Not handling dynamic / post-interaction image swaps.** If a `<img>` changes `src` between steps, each step's reflect examines the state-at-capture. No cross-step history is built.
- **Not handling `<svg>` elements.** Their accessible name comes from `<title>` / `aria-label`; scoring SVG relevance against rendered pixels is materially harder (often abstract shapes) and deferred.
- **Not handling CSS background-images.** They are not `<img>` elements and are usually decorative in practice; out of scope.

## Implementation Approach

Single phase, three tasks:

- **Task 1.1** — Extend `skills/a11y-scan/SKILL.md` Step 2 with a new sub-procedure `Image alt-text relevance check`. This is the core prompt change. The prompt uses the already-captured step screenshot (no new capture primitive) and iterates images identified in the accessibility snapshot. Includes explicit decorative-image exemption, covers aria-label / figcaption / aria-labelledby, and produces signals with WCAG 1.1.1 citation and `[alt-relevance]` tag. No schema changes.
- **Task 1.2** — Create a static fixture page under `plugin/ralph-playwright/fixtures/alt-relevance/` with six images exercising the prompt's branching. Add a README documenting the expected reflect outcome per case.
- **Task 1.3** — End-to-end manual verification: serve the fixture via any local static server, run `/ralph-playwright:a11y-scan` against it, diff the resulting signal-report against the fixture README's expected-signal block. Record the result as a PR comment.

Task 1.1 is the only source change that ships to users; Task 1.2 provides the regression fixture; Task 1.3 proves the prompt works.

---

## Phase 1: Alt-text relevance validation in a11y-scan

- **depends_on**: null

### Overview

Extend the a11y-scan reflect phase with a screenshot-grounded alt-text relevance check that cross-references the image's rendered pixels with its accessible name (alt / aria-label / figcaption). Flag mismatches as `a11y_violation` tagged `[alt-relevance]` and leave decorative images alone. Ship a fixture page + expected-signal README for regression verification.

### Tasks

#### Task 1.1: Extend a11y-scan reflect prompt with alt-text relevance sub-procedure

- **files**: `plugin/ralph-playwright/skills/a11y-scan/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] A new checklist item "Alt-text relevance (screenshot-grounded)" replaces the existing "Missing alt text" bullet at line 40 or is added immediately after it, with clear separation between the existence check and the relevance check.
  - [ ] The new sub-procedure begins by enumerating images from the accessibility snapshot that have non-empty accessible names. Accessible name sources to consider, in order: (a) `alt` attribute on `<img>`, (b) `aria-label` on `<img>` or `role="img"` element, (c) `<figcaption>` within an enclosing `<figure>`, (d) `aria-labelledby` target text.
  - [ ] The sub-procedure explicitly states: "If the alt attribute is present but empty (`alt=\"\"`), the image is marked as decorative by the author. Do NOT flag. Skip to the next image." This sentence must appear verbatim or near-verbatim.
  - [ ] The sub-procedure states: "For each image with a non-empty accessible name, locate the image in the step's screenshot PNG and judge whether the accessible name accurately describes what is visible. You are reading the same screenshot the sighted user sees."
  - [ ] A relevance rubric is provided with three grades: ACCURATE (accessible name captures the primary subject and intent), PARTIAL (accessible name is technically related but misses the key content or is overly generic like "image" / "photo"), INACCURATE (accessible name describes something not depicted or contradicts the image).
  - [ ] The emit rules state: ACCURATE -> no signal. PARTIAL -> `a11y_violation` severity `low`. INACCURATE -> `a11y_violation` severity `medium`. If the image appears to convey information critical to page understanding (e.g., a chart, diagram, product photo on an e-commerce page), escalate severity to `high`.
  - [ ] Each emitted signal's `tags` array includes the literal string `alt-relevance`.
  - [ ] Each emitted signal's `description` field cites "WCAG 2.2 SC 1.1.1 Non-text Content (Level A)" and quotes both the image region description and the author-provided accessible name verbatim in the form: `Image depicts: <model's observation>. Author-provided alt/label: "<quoted text>". Relevance grade: <PARTIAL|INACCURATE>.`
  - [ ] Each emitted signal's `evidence.steps` points to the step index where the image appeared; `evidence.screenshots` lists that step's screenshot filename.
  - [ ] A final note instructs: "If GH-790 bounding-box output is available, populate `evidence.bboxes` with the image's bounding rectangle. If not available, omit the field." (This keeps forward compatibility without hard-coupling to GH-790.)
  - [ ] The existing "Missing alt text" check semantics are preserved — missing `alt` still emits an `a11y_violation` (unchanged behavior); the new branch handles the presence-but-wrong case.
  - [ ] SKILL.md frontmatter is not changed (allowed-tools already covers Read/Write/Bash/Agent).
  - [ ] The YAML frontmatter parses correctly and `ls plugin/ralph-playwright/skills/a11y-scan/SKILL.md` still resolves.

#### Task 1.2: Create alt-relevance fixture page and expected-signal README

- **files**: `plugin/ralph-playwright/fixtures/alt-relevance/index.html` (create), `plugin/ralph-playwright/fixtures/alt-relevance/README.md` (create), `plugin/ralph-playwright/fixtures/alt-relevance/img/` (create directory with placeholder image files — may reference remote placeholders via an existing public placeholder service if committing binaries is undesirable, but prefer local 1-5KB PNGs so the fixture is offline-usable)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `index.html` is a single static page with six labeled sections (case-i through case-vi), each containing one image element. The page is self-contained HTML+CSS, no JS required, renders standalone when opened via `file://` or any static server.
  - [ ] **Case i (good alt)**: `<img src="img/dog.png" alt="Golden retriever sitting on a porch" width="200">`. The image file must actually depict a dog on a porch (a simple illustration / photo that an LLM can recognize is sufficient — no photo-realism required).
  - [ ] **Case ii (bad alt)**: `<img src="img/dog.png" alt="Red Submit button" width="200">` — same dog image, wildly unrelated alt.
  - [ ] **Case iii (misleading alt)**: `<img src="img/chart.png" alt="Weather forecast" width="300">` where `chart.png` is a simple bar chart of sales data (again, simple illustration is fine).
  - [ ] **Case iv (decorative)**: `<img src="img/divider.png" alt="" width="300" height="4">` — a thin decorative horizontal rule.
  - [ ] **Case v (figure + figcaption)**: `<figure><img src="img/cat.png" width="200"><figcaption>Tabby cat napping on a windowsill</figcaption></figure>` — where `cat.png` depicts a cat on a windowsill (accurate description).
  - [ ] **Case vi (aria-label on role=img)**: `<div role="img" aria-label="Orange triangle warning icon" style="..."></div>` with a CSS-styled orange triangle shape OR `<img src="img/triangle.png" aria-label="Orange triangle warning icon">` — choose whichever renders reliably offline.
  - [ ] `README.md` documents the purpose of the fixture, how to serve it locally (`python3 -m http.server 8080` example), and contains an "Expected Signals" block listing — per case — the exact expected reflect outcome: case i no signal, case ii one `a11y_violation` tagged `[alt-relevance]` severity medium/high, case iii one `a11y_violation` tagged `[alt-relevance]` severity medium/high, case iv no signal, case v no signal, case vi no signal (assuming the label is accurate to the shape).
  - [ ] README notes the acceptable severity range for the flagged cases (medium or high are both correct per the rubric in Task 1.1; low is not correct for these egregious mismatches).
  - [ ] Image files committed are small (< 50 KB each) to keep the plugin payload light; if binaries are problematic, use an inline SVG approach documented in the README.

#### Task 1.3: End-to-end fixture verification and PR evidence

- **files**: none modified; produces a `.playwright-cli/<session>/signal-report.yaml` artifact and a PR comment transcript
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - [ ] The fixture is served locally (documented command from Task 1.2 README).
  - [ ] `/ralph-playwright:a11y-scan` is invoked against the served fixture URL. The skill completes without errors. The reflect phase runs under Opus 4.7 (either naturally, if the user is on Opus, or manually — record which).
  - [ ] The resulting `.playwright-cli/<session>/signal-report.yaml` is diffed against the expected-signal block in the fixture README. Diff results are captured in the PR description or a PR comment.
  - [ ] Any deviation from the fixture README is either (a) resolved by tightening the Task 1.1 prompt and re-running, or (b) documented as a known-false-positive/negative with justification.
  - [ ] `hooks/scripts/validate-primitive-io.sh` does not reject the generated signal-report.yaml at write time (visible as hook success in the skill run log).

### Phase Success Criteria

#### Automated Verification:

ralph-playwright is skills/agents-only — there is no build/test matrix for the plugin itself. The only automated gate that applies is the artifact validator:

- [x] `bash plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` accepts the generated `signal-report.yaml` from Task 1.3 (invoked indirectly by the write hook; confirmed by hook-success log line). Verified at implementation time with a sample signal-report matching the README oracle — `type=a11y_violation` passes the enum check and `tags=["alt-relevance"]` passes the unrestricted-string-array check. Validator exit 0.
- [x] `yq '.' plugin/ralph-playwright/skills/a11y-scan/SKILL.md` parses the front-matter YAML without error.

#### Manual Verification:

- [ ] Prompt changes in Task 1.1 read cleanly end-to-end (a human reviewer can follow the alt-relevance branch without re-reading the prompt).
- [ ] Fixture README's "Expected Signals" block matches the actual `signal-report.yaml` from Task 1.3 on a per-case basis.
- [ ] Running the same audit twice produces the same signals (qualitative determinism check — given vision model non-determinism, minor variance in wording is acceptable but the pass/fail call per case must be stable).

**Creates for next phase**: N/A — this is the only phase. Ships as a single PR. Downstream features in the epic (GH-790 bounding boxes) can read `[alt-relevance]` signals and enrich them retrospectively; no API contract is promised here beyond the signal tag.

---

## Integration Testing

Because this is a single-phase standalone feature with no cross-phase handoff, integration testing collapses into Task 1.3. Specifically:

- [ ] End-to-end: local fixture served, a11y-scan run, signal-report produced, compared against expected outcomes per fixture README.
- [ ] Cross-feature sanity: running a11y-scan against the fixture ALSO exercises the existing heading-hierarchy, label, contrast, and alt-presence checks. Confirm these continue to behave as before — the new branch must not shadow or short-circuit the existing branches.
- [ ] Real-app smoke: run a11y-scan against at least one real application page containing `alt=""` spacer images to confirm no regression on decorative-image handling.

## References

- Research: [thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md) §Part 3 Item 5
- Parent plan-of-plans: [thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md) (Feature E)
- Issue: https://github.com/cdubiel08/ralph-hero/issues/789
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/784
- Adjacent features: GH-788 (pixel contrast — also a11y-scan extension), GH-790 (bounding boxes — optional enrichment source)
- WCAG 2.2 SC 1.1.1: https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html

## Open Questions

Captured here (not blocking the plan):

1. **Severity floor for `[alt-relevance]` violations** — the rubric in Task 1.1 uses `low` for PARTIAL and `medium`/`high` for INACCURATE. Is `low` the right floor? Arguably any mismatch fails WCAG 1.1.1 and should be at least `medium`. Default applied here is `low` for PARTIAL because screen-reader users still get more information from a near-miss label than from a missing one; strong empirical justification would downgrade or upgrade this.
2. **Handling of multiple images with identical `src` but different contexts** — if a page repeats the same decorative icon 10 times with `alt=""`, the prompt will correctly skip all 10. If a page repeats a hero image with differing alt text per context, each instance is judged independently. No special deduplication.
3. **Handling of CSS-transformed images** — if CSS `transform: rotate(180deg)` inverts an image, the pixels are rotated but the alt is not. The prompt judges against the pixels (what the user sees), which is correct per WCAG. No special handling needed, but worth documenting.
4. **Bounding-box field name alignment** — Task 1.1 references `evidence.bboxes` forward-compatibly. GH-790 Feature F has not yet been planned; if its plan names the field differently (e.g., `evidence.bounding_boxes`), this feature's prompt should be amended in the same PR that lands the bbox schema change. Low risk — a one-line prompt edit.
5. **Fixture binary policy** — committing small PNG assets under `plugin/ralph-playwright/fixtures/` is the pragmatic choice but may conflict with repo policies about binary files. If it does, Task 1.2's fallback (inline SVG) removes the binary dependency. Check existing `plugin/ralph-playwright/` binary policy before committing images.
