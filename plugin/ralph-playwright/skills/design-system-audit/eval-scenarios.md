---
type: eval-scenarios
skill: design-system-audit
date: 2026-04-25
---

# design-system-audit — Eval Scenarios

Three scenarios for grading the 5-ring, 6-tier maturity assessment. Each scenario fixes the codebase shape so a reviewer can compare the generated `design-system-audit-report.md` against expected scoring.

A separate `evals/evals.json` exists with structured prompts for the auto-eval harness; this `eval-scenarios.md` provides human-readable rubrics for manual review.

## Scenario A: React shadcn project — full scoring

**Input**: User runs the skill in a Next.js 14 codebase with shadcn/ui installed, Tailwind, CVA for variants, a `tokens.css` file with CSS custom properties, no Storybook, no CLAUDE.md, 8 components in `components/ui/`

**Expected Behavior**:
- Step 1 detects React/Next.js, shadcn (via `cva` + `@radix-ui/*` deps), Tailwind, CSS-variable tokens
- Asks only the questions the codebase cannot answer (team size, primary goal, Figma usage, migration?)
- Walks Rings 1-5 in Step 2 using scan results + answers
- Generates `design-system-audit-report.md` with full scoring tables
- Recommends Quick Wins tailored to the React/shadcn stack

**Assertions**:
- [ ] Report file written to `./design-system-audit-report.md` (or user-specified path)
- [ ] Framework correctly identified as React/Next.js with shadcn ecosystem
- [ ] Ring 1 token tier scored Tier 2-3 (CSS custom properties + Tailwind, no DTCG)
- [ ] Ring 1 component tier scored Tier 2-3 (typed components with CVA variants)
- [ ] Ring 3 (AI Automation) scored Tier 0-1 if no CLAUDE.md present
- [ ] Ring 4 scored Tier 0-1 if no Storybook/Chromatic detected
- [ ] At least one Quick Win mentions writing a CLAUDE.md for the existing components
- [ ] Action plan references shadcn/v0/Figma Make ecosystem advantages

## Scenario B: Angular project with playbook reference

**Input**: User runs the skill in an Angular 17 codebase with `angular.json`, no token files, 12 components in `shared/components/`, no CLAUDE.md, no Storybook, team of 8

**Expected Behavior**:
- Step 1 detects Angular via `angular.json`
- Asks team size + Figma + migration questions
- Step 4 reads `references/angular-playbook.md` and includes the full Angular playbook in the report
- Action plan uses the phased Angular roadmap (Foundation → Bridge → AI → Quality)
- Quick Wins reference Angular-specific patterns (input unions for variants, `signal()` API, etc.)

**Assertions**:
- [ ] Report identifies Angular 17
- [ ] Ring 1 tokens scored Tier 0-1 (no token files found)
- [ ] Report's "Framework-Specific Guidance" section quotes from `angular-playbook.md` (CLAUDE.md template snippet, component manifest schema reference)
- [ ] Action plan is phased per Angular Acceleration Playbook
- [ ] At least one Quick Win mentions Angular-specific tooling (e.g., `ng generate component` patterns)
- [ ] Step 5 offers to deep-dive into the Angular playbook

## Scenario C: "No design system at all" — fast track flow

**Input**: User runs the skill in a vanilla JS/HTML project (no framework config, no `package.json` design deps, no token files, scattered inline styles)

**Expected Behavior**:
- Step 1 detects no framework, no tokens, no component lib, no AI config
- Step 1 fast-track triggers: skips detailed Ring 2-5 questioning
- Scores everything Tier 0-1
- Jumps straight to the "If You Only Do 5 Things" Quick Wins from `maturity-checklist.md`
- Action plan is greenfield-oriented (Foundation → Bridge → AI → Quality)

**Assertions**:
- [ ] Report explicitly notes "Fast track: no design system detected"
- [ ] All 5 rings scored Tier 0 or Tier 1
- [ ] Report does NOT include detailed checkpoint-by-checkpoint scoring (skipped per fast track)
- [ ] Quick Wins section sourced directly from "If You Only Do 5 Things" in `maturity-checklist.md`
- [ ] Greenfield action plan phases are present (not migration phases)
- [ ] Report does not interrogate the user with all 60 checkpoints (respects fast track)

## Negative scenario: Reference file missing — graceful error

**Input**: Skill invoked but the `references/maturity-checklist.md` file is absent (e.g., partial install)

**Expected Behavior**:
- Glob lookup for `**/design-system-audit/references/maturity-checklist.md` returns empty
- Skill surfaces the error message documented in the SKILL.md "Error handling" callout
- Skill stops before scoring

**Assertions**:
- [ ] Error message names the missing file path
- [ ] Error message instructs the user to verify plugin install
- [ ] No `design-system-audit-report.md` is written
- [ ] Skill exits cleanly without falling back to inferring tier definitions from memory

## Notes

- Scenarios A-C should be executed in fixture repos (or codebases with the described shape) so the scan results are deterministic.
- The negative scenario can be simulated by temporarily renaming `references/maturity-checklist.md` to verify the Glob error handling lands.
