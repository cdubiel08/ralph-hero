---
date: 2026-04-04
status: draft
type: plan
github_issue: 736
github_issues: [736, 737, 738, 739]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/736
  - https://github.com/cdubiel08/ralph-hero/issues/737
  - https://github.com/cdubiel08/ralph-hero/issues/738
  - https://github.com/cdubiel08/ralph-hero/issues/739
primary_issue: 736
parent_plan: thoughts/shared/plans/2026-04-04-playwright-aware-planning.md
tags: [playwright, skills, research, planning, a11y]
---

# Playwright-Aware Skills - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-04-playwright-aware-planning]]
- builds_on:: [[2026-04-04-playwright-aware-planning-design]]

## Overview

4 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-736 | Playwright baseline capture in autonomous research skill (ralph-research) | XS |
| 2 | GH-737 | Playwright baseline capture in interactive research skill | XS |
| 3 | GH-738 | UI Validation phase generation in autonomous plan skill (ralph-plan) | XS |
| 4 | GH-739 | Interactive playwright consultation flow in plan skill | XS |

**Why grouped**: All 4 issues modify skill markdown files to add playwright awareness. Phase 1 defines the `## UI Baseline` format that Phase 3 reads. Phase 2 mirrors Phase 1's behavior with user prompts. Phase 4 mirrors Phase 3's template with user consultation.

## Shared Constraints

1. **Tech stack**: All changes are to markdown skill files (`.md`). No TypeScript, no tests, no build steps.
2. **Frontmatter preservation**: Each skill's YAML frontmatter must remain valid after edits. Only the `argument-hint` field changes.
3. **Flag consistency**: All 4 skills use the same flag names: `--playwright`, `--no-playwright`, `--ux-audit`.
4. **Plugin detection method**: All skills detect ralph-playwright by reading `~/.claude/plugins/installed_plugins.json` and checking for a key containing `ralph-playwright`.
5. **Dev server resolution order**: env var `RALPH_PLAYWRIGHT_DEV_CMD` -> memory -> auto-detect from `package.json` (`dev`, `start`, `serve` scripts).
6. **UI Baseline format**: The `## UI Baseline` section written by research skills and read by plan skills must use the exact format defined in the [design spec](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/specs/2026-04-04-playwright-aware-planning-design.md#ui-baseline-section-format).
7. **Skill tiering**: a11y-scan always, test-e2e if stories exist, storybook-test if tooling detected, visual-diff if tooling detected, ux-audit if `--ux-audit` explicit.
8. **No verification commands**: These are markdown files — no `npm test`, `npm run build`, or lint applies.

## Current State Analysis

- **ralph-research/SKILL.md** (343 lines): Autonomous research skill. `argument-hint` at line 4 currently `[optional-issue-number]`. Step 7 (Commit and Push) ends at line 257. Step 8 (Update GitHub Issue) starts at line 259. New playwright section goes between them.
- **research/SKILL.md** (273 lines): Interactive research skill. Step 6 (Generate research document) ends at line 188. Step 7 (Add GitHub permalinks) starts at line 189. New Step 6.5 goes between them.
- **ralph-plan/SKILL.md** (522 lines): Autonomous plan skill. `argument-hint` at line 4. Configuration section at lines 53-59. Step 3 item 2 at line 164. Plan template closing at line 347.
- **plan/SKILL.md** (505 lines): Interactive plan skill. Step 2 item 4 at line 159. Step 3 at lines 178-197. Step 4 template closing at line 321.

## Desired End State

### Verification
- [ ] All 4 skill files have valid YAML frontmatter (check with `head -10`)
- [ ] `--playwright`, `--no-playwright`, `--ux-audit` flags documented consistently across all 4 files
- [ ] Plugin detection logic (`installed_plugins.json`) identical in all 4 files
- [ ] Dev server resolution order (env var -> memory -> auto-detect) identical in all 4 files
- [ ] `## UI Baseline` section format in both research skills matches spec exactly
- [ ] UI Validation phase template in both plan skills uses same structure
- [ ] Skill tiering (a11y-scan always, others conditional) consistent in both plan skills
- [ ] No unintended changes to existing skill logic

## What We're NOT Doing

- No changes to hero/SKILL.md (GH-732 handles dispatch migration separately)
- No changes to ralph-impl, ralph-val, or any agent definitions
- No changes to ralph-playwright skills (consumed as-is)
- No MCP server changes
- No new tools or hooks

## Implementation Approach

Phase 1 is the foundation — it defines the `## UI Baseline` format, flag parsing, plugin detection, and dev server lifecycle patterns. Phases 2 and 3 can then run in parallel: Phase 2 mirrors Phase 1 for interactive mode, Phase 3 reads the baseline format to generate plans. Phase 4 depends on Phase 3 for the template reference.

---

## Phase 1: GH-736 — Playwright baseline capture in autonomous research skill
- **depends_on**: null

### Overview
Add playwright detection and UI baseline capture to `ralph-research`. This phase defines the canonical patterns (flag parsing, plugin detection, dev server lifecycle, `## UI Baseline` format) that all subsequent phases reference.

### Tasks

#### Task 1.1: Update argument-hint in frontmatter
- **files**: [`plugin/ralph-hero/skills/ralph-research/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-research/SKILL.md) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Line 4 reads: `argument-hint: "[optional-issue-number] [--playwright] [--no-playwright] [--ux-audit]"`
  - [ ] `head -10` shows valid YAML frontmatter

#### Task 1.2: Insert Playwright UI Baseline section
- **files**: [`plugin/ralph-hero/skills/ralph-research/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-research/SKILL.md) (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] New `### Playwright UI Baseline (conditional)` section exists between Step 7 (line 257) and Step 8 (line 259)
  - [ ] Section includes skip condition: `--no-playwright` set in args
  - [ ] Plugin detection: reads `~/.claude/plugins/installed_plugins.json`, checks for key containing `ralph-playwright`
  - [ ] Frontend relevance: checks affected file types (.tsx, .jsx, .css, .html, .vue, .svelte), component dirs, route modifications, UI/accessibility concerns; `--playwright` forces frontend-relevant
  - [ ] Dev server lifecycle: resolve command (env var `RALPH_PLAYWRIGHT_DEV_CMD` -> memory -> auto-detect), start in background, poll readiness (curl every 2s, 30s timeout), teardown (env var `RALPH_PLAYWRIGHT_DEV_TEARDOWN_CMD` or kill PID)
  - [ ] Explorer-agent dispatch: `Agent(subagent_type="ralph-playwright:explorer-agent", prompt="Explore http://localhost:<port>...")` with session name `<date>-baseline-GH-NNN`
  - [ ] Parallel tooling detection: check `playwright-stories/` count, grep `package.json` for storybook/chromatic/applitools
  - [ ] Append `## UI Baseline` section to research doc matching spec format: Captured date, Dev server command/port, Routes scanned, Accessibility (violation counts by severity/category), Flow State (entry point, flows, screenshots), Tooling Detected (storybook yes/no, visual regression type, existing story count)
  - [ ] Commit updated research doc: `git add && git commit -m "docs(research): add UI baseline for GH-NNN" && git push`
  - [ ] Dev server teardown after baseline capture
  - [ ] Graceful failure: if dev server fails to start, log warning, skip baseline, continue research

### Phase Success Criteria

#### Automated Verification:
- [x] `head -10 plugin/ralph-hero/skills/ralph-research/SKILL.md` shows valid YAML frontmatter with updated argument-hint
- [x] `grep -c "Playwright UI Baseline" plugin/ralph-hero/skills/ralph-research/SKILL.md` returns 1
- [x] `grep -c "installed_plugins.json" plugin/ralph-hero/skills/ralph-research/SKILL.md` returns >= 1
- [x] `grep -c "explorer-agent" plugin/ralph-hero/skills/ralph-research/SKILL.md` returns >= 1
- [x] `wc -l plugin/ralph-hero/skills/ralph-research/SKILL.md` shows ~420 lines (original 343 + ~75 new)

#### Manual Verification:
- [x] Section reads naturally as skill instructions for an LLM agent
- [x] All flag behaviors documented clearly

**Creates for next phase**: The `## UI Baseline` section format and plugin detection pattern that Phase 2 mirrors and Phase 3 consumes.

---

## Phase 2: GH-737 — Playwright baseline capture in interactive research skill
- **depends_on**: [phase-1]

### Overview
Add playwright detection and UI baseline capture to the interactive `research` skill. Same behavior as Phase 1 but with user prompts: ask before capturing, offer to save dev command to memory.

### Tasks

#### Task 2.1: Insert Step 6.5 for Playwright UI Baseline
- **files**: [`plugin/ralph-hero/skills/research/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/research/SKILL.md) (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] New `### Step 6.5: Playwright UI Baseline (conditional)` section exists between Step 6 (line 188) and Step 7 (line 189)
  - [ ] `--no-playwright` skip condition documented
  - [ ] Plugin detection via `~/.claude/plugins/installed_plugins.json` — identical method to Phase 1
  - [ ] Frontend relevance assessment — same criteria as Phase 1; `--playwright` forces it
  - [ ] User prompt offered: "This research involves frontend changes and ralph-playwright is installed. Would you like me to capture a UI baseline?" with explanation of what baseline captures
  - [ ] Dev server resolution: env var -> memory -> auto-detect (same order as Phase 1)
  - [ ] First auto-detection success offers: "Want me to remember `<command>` as this project's dev server for future sessions?" (save to memory if yes)
  - [ ] Explorer-agent dispatch: identical `Agent()` call to Phase 1
  - [ ] Parallel tooling detection: identical to Phase 1
  - [ ] `## UI Baseline` section format: identical to Phase 1
  - [ ] Dev server teardown after capture
  - [ ] User decline path: "Continue to Step 7 without baseline"
  - [ ] `wc -l` shows ~340 lines (original 273 + ~65 new)

### Phase Success Criteria

#### Automated Verification:
- [x] `grep -c "Step 6.5" plugin/ralph-hero/skills/research/SKILL.md` returns 1
- [x] `grep -c "installed_plugins.json" plugin/ralph-hero/skills/research/SKILL.md` returns >= 1
- [x] `grep -c "explorer-agent" plugin/ralph-hero/skills/research/SKILL.md` returns >= 1
- [x] `grep "RALPH_PLAYWRIGHT_DEV_CMD" plugin/ralph-hero/skills/research/SKILL.md` returns a match

#### Manual Verification:
- [x] User prompt text is clear and actionable
- [x] Memory save offer reads naturally

**Creates for next phase**: Nothing directly — Phase 3 reads `## UI Baseline` from research docs written by both Phase 1 and Phase 2.

---

## Phase 3: GH-738 — UI Validation phase generation in autonomous plan skill
- **depends_on**: [phase-1]

### Overview
Make `ralph-plan` generate a UI Validation phase as the final plan phase when a `## UI Baseline` section exists in the research document or `--playwright` is forced.

### Tasks

#### Task 3.1: Update argument-hint and add flag documentation
- **files**: [`plugin/ralph-hero/skills/ralph-plan/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-plan/SKILL.md) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Line 4 argument-hint includes `[--playwright] [--no-playwright] [--ux-audit]` after existing flags
  - [ ] New `## Playwright Flags` section exists after the Configuration section (after line 59), documenting: `--no-playwright` suppresses UI Validation phase, `--playwright` forces it, `--ux-audit` includes ux-audit (implies `--playwright`)
  - [ ] `head -10` shows valid YAML frontmatter

#### Task 3.2: Add UI Baseline awareness to Step 3
- **files**: [`plugin/ralph-hero/skills/ralph-plan/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-plan/SKILL.md) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] New item 2.5 exists after item 2 in Step 3 (after line 164): "**Check for UI Baseline**"
  - [ ] Item 2.5 instructs: after reading each research doc, check for `## UI Baseline` section
  - [ ] If found: extract capture date, dev server command/port, routes scanned, a11y violation counts, tooling detected (storybook, visual-diff, existing user stories)
  - [ ] Data stored for use in Step 5 UI Validation phase generation
  - [ ] `--no-playwright` set: ignore baseline section entirely

#### Task 3.3: Add UI Validation phase template to Step 5
- **files**: [`plugin/ralph-hero/skills/ralph-plan/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-plan/SKILL.md) (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.2]
- **acceptance**:
  - [ ] New `### UI Validation Phase (conditional)` section exists after the plan template block (after line 347)
  - [ ] Condition: `## UI Baseline` found in research doc OR `--playwright` flag set
  - [ ] Template includes: Phase N with `depends_on: [phase-N-1]`
  - [ ] Task N.1: Start dev server (always)
  - [ ] Task N.2: a11y-scan with skill reference `/ralph-playwright:a11y-scan` and baseline violation count in acceptance criteria (always)
  - [ ] Task N.3: test-e2e with skill reference `/ralph-playwright:test-e2e` — CONDITIONAL on existing user stories detected
  - [ ] Task N.4: storybook-test with skill reference `/ralph-playwright:storybook-test` — CONDITIONAL on storybook addon detected
  - [ ] Task N.5: visual-diff with skill reference `/ralph-playwright:visual-diff` — CONDITIONAL on chromatic/applitools detected
  - [ ] Task N.6: ux-audit with skill reference `/ralph-playwright:ux-audit` — CONDITIONAL on `--ux-audit` flag
  - [ ] Task N.last: Tear down dev server (always)
  - [ ] Phase Success Criteria with automated checks per included task and manual "review promoted screenshots"
  - [ ] When no baseline but `--playwright` set: generate with a11y-scan default only + any tooling detectable from `package.json`
  - [ ] Ralph-playwright skill menu listed for LLM awareness
  - [ ] `wc -l` shows ~620 lines (original 522 + ~95 new)

### Phase Success Criteria

#### Automated Verification:
- [x] `head -10 plugin/ralph-hero/skills/ralph-plan/SKILL.md` shows valid YAML with updated argument-hint
- [x] `grep -c "Playwright Flags" plugin/ralph-hero/skills/ralph-plan/SKILL.md` returns 1
- [x] `grep -c "UI Baseline" plugin/ralph-hero/skills/ralph-plan/SKILL.md` returns >= 2 (item 2.5 + template)
- [x] `grep -c "UI Validation Phase" plugin/ralph-hero/skills/ralph-plan/SKILL.md` returns >= 1
- [x] `grep -c "a11y-scan" plugin/ralph-hero/skills/ralph-plan/SKILL.md` returns >= 1

#### Manual Verification:
- [x] UI Validation phase template is complete and follows plan template conventions
- [x] Conditional task gating conditions are clear

**Creates for next phase**: The UI Validation phase template that Phase 4 references.

---

## Phase 4: GH-739 — Interactive playwright consultation flow in plan skill
- **depends_on**: [phase-3]

### Overview
Add interactive playwright validation flow to the `plan` skill with user consultation on which skills to include and an offer for story-gen.

### Tasks

#### Task 4.1: Add playwright awareness to Step 2
- **files**: [`plugin/ralph-hero/skills/plan/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/plan/SKILL.md) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] New item 5 exists after item 4 in Step 2 (after line 159): "**Playwright validation awareness**"
  - [ ] `--no-playwright` skip condition
  - [ ] Plugin detection via `~/.claude/plugins/installed_plugins.json`
  - [ ] Frontend relevance assessment from research findings; `--playwright` forces it
  - [ ] If both conditions met and no `## UI Baseline` in research: offer to capture baseline with user prompt explaining value
  - [ ] If user agrees: resolve dev server command (env var -> memory -> auto-detect), start, dispatch explorer-agent, append baseline to research doc, teardown
  - [ ] First auto-detection offers memory save

#### Task 4.2: Add playwright consultation to Step 3
- **files**: [`plugin/ralph-hero/skills/plan/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/plan/SKILL.md) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [4.1]
- **acceptance**:
  - [ ] New content in Step 3 between plan outline (line 183) and feedback request (line 196)
  - [ ] Presents checklist to user: `[x] a11y-scan` (always), `[x] test-e2e` (if stories), `[x] storybook-test` (if detected), `[x] visual-diff` (if detected)
  - [ ] Asks: "Would you also like to: Generate user stories with story-gen? Include a ux-audit?"
  - [ ] User can add/remove validations

#### Task 4.3: Add UI Validation phase to Step 4
- **files**: [`plugin/ralph-hero/skills/plan/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/plan/SKILL.md) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [4.2]
- **acceptance**:
  - [ ] New content after the plan template section (before line 321)
  - [ ] References the UI Validation phase template from ralph-plan: "use the same template structure defined in `plugin/ralph-hero/skills/ralph-plan/SKILL.md`"
  - [ ] Adjusts task selection based on user choices from Step 3 consultation
  - [ ] `wc -l` shows ~560 lines (original 505 + ~55 new)

### Phase Success Criteria

#### Automated Verification:
- [x] `grep -c "Playwright validation awareness" plugin/ralph-hero/skills/plan/SKILL.md` returns 1
- [x] `grep -c "a11y-scan" plugin/ralph-hero/skills/plan/SKILL.md` returns >= 1
- [x] `grep -c "story-gen" plugin/ralph-hero/skills/plan/SKILL.md` returns >= 1
- [x] `grep -c "UI Validation" plugin/ralph-hero/skills/plan/SKILL.md` returns >= 1

#### Manual Verification:
- [x] User consultation prompts are clear and actionable
- [x] Checklist format is easy to modify

**Creates for next phase**: N/A — this is the final phase.

---

## Integration Testing

- [x] Cross-file consistency: flag names `--playwright`/`--no-playwright`/`--ux-audit` identical in all 4 files
- [x] Cross-file consistency: plugin detection method (`installed_plugins.json` key containing `ralph-playwright`) identical in all 4 files (research skills + interactive plan; autonomous plan reads from research doc instead)
- [x] Cross-file consistency: dev server resolution order (env var -> memory -> auto-detect) identical in all 4 files (research skills + interactive plan; autonomous plan reads from research doc instead)
- [x] Cross-file consistency: `## UI Baseline` section format in both research skills matches spec
- [x] Cross-file consistency: skill tiering rules in both plan skills match spec
- [x] `git diff --stat` shows only the 4 skill files modified (+ plan checkpoint)

## References

- Parent plan: [2026-04-04-playwright-aware-planning.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-04-playwright-aware-planning.md)
- Design spec: [2026-04-04-playwright-aware-planning-design.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/specs/2026-04-04-playwright-aware-planning-design.md)
- Parent issue: [GH-730](https://github.com/cdubiel08/ralph-hero/issues/730)
- Prerequisite (done): [GH-732](https://github.com/cdubiel08/ralph-hero/issues/732) — hero Skill() dispatch migration
