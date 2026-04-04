---
date: 2026-04-04
status: draft
type: plan
github_issue: 730
github_url: https://github.com/cdubiel08/ralph-hero/issues/730
tags: [playwright, planning, cross-plugin, a11y, ui-testing]
---

# Playwright-Aware Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ralph-hero's research and planning pipeline playwright-aware so that frontend work automatically gets UI validation steps when ralph-playwright is installed.

**Architecture:** Four skill markdown files are modified — both research skills gain playwright detection and baseline capture, both plan skills gain UI Validation phase generation. No hero/SKILL.md changes needed (prerequisite GH-732 migrates hero to Skill() dispatch, which gives skills sub-agent access for explorer-agent dispatch).

**Prerequisite:** GH-732 — Migrate hero from Agent() to Skill() dispatch. Without this, ralph-research's Agent() calls for explorer-agent won't execute in autonomous mode.

**Tech Stack:** Markdown skill files (no TypeScript, no tests, no build)

---

### Task 1: Add Playwright Baseline Capture to ralph-research (Autonomous)

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-research/SKILL.md`

**Context:** The autonomous research skill is 342 lines. It needs: (1) flag parsing for `--playwright`/`--no-playwright`, (2) playwright detection via installed_plugins.json, (3) dev server lifecycle, (4) explorer-agent dispatch for baseline capture, (5) appending `## UI Baseline` to the research doc. This skill runs without human interaction — it decides autonomously whether to capture a baseline.

- [ ] **Step 1: Update argument-hint to include playwright flags**

In the frontmatter, update the argument-hint line to add playwright flags:

```
argument-hint: "[optional-issue-number] [--playwright] [--no-playwright] [--ux-audit]"
```

- [ ] **Step 2: Verify frontmatter is valid**

Run: `head -10 plugin/ralph-hero/skills/ralph-research/SKILL.md`
Expected: Valid YAML frontmatter with updated argument-hint

- [ ] **Step 3: Add playwright baseline section after the research document is written**

After the step where the research document is generated and committed (the main research workflow), but before the issue-linking and completion steps, insert a new section:

```markdown
### Playwright UI Baseline (conditional)

After writing the research document, optionally capture a UI baseline for frontend-relevant work.

**Skip entirely if:**
- `--no-playwright` was set in args

**Detection (when not skipped):**
1. Read `~/.claude/plugins/installed_plugins.json`
2. Check for a key containing `ralph-playwright` (e.g., `ralph-playwright@ralph-hero`)
3. If not found and `--playwright` not forced: skip — ralph-playwright is not installed

**Frontend relevance (when ralph-playwright detected):**
1. Review the research findings just written — affected files, issue description, component types
2. If the work involves frontend files (.tsx, .jsx, .css, .html, .vue, .svelte), component directories, route/page modifications, UI/UX/visual/layout/accessibility concerns: mark as frontend-relevant
3. If `--playwright` is set: always treat as frontend-relevant
4. If not frontend-relevant: skip baseline capture

**Dev server lifecycle:**
1. Resolve the start command in priority order:
   a. Env var `RALPH_PLAYWRIGHT_DEV_CMD`
   b. Memory — check if a prior conversation saved the dev command for this project
   c. Auto-detect from `package.json` (`dev`, `start`, or `serve` scripts)
2. Start the dev server in background via `Bash(command, run_in_background=true)`
3. Poll for readiness: `curl -s -o /dev/null -w "%{http_code}" http://localhost:<port>` every 2s, timeout 30s
4. If the dev server fails to start: log warning, skip baseline, continue
5. Teardown: use `RALPH_PLAYWRIGHT_DEV_TEARDOWN_CMD` if set, otherwise kill the background process PID

**Baseline capture:**
Dispatch an explorer-agent:
```
Agent(subagent_type="ralph-playwright:explorer-agent",
      prompt="Explore http://localhost:<port> with goal: capture accessibility baseline and key user flows relevant to issue #NNN. Focus on routes mentioned in the research: [routes from findings]. Take accessibility snapshots at each page. Session: <date>-baseline-GH-NNN",
      description="UI baseline GH-NNN")
```

**Detect tooling** (in parallel with explorer-agent):
- Check `playwright-stories/` directory: `ls playwright-stories/*.yaml 2>/dev/null | wc -l`
- Check `package.json` for storybook: `grep -E "storybook/addon-vitest|storybook/test-runner" package.json`
- Check `package.json` for visual regression: `grep -E "chromatic|@applitools" package.json`

**Append to research doc:**
After explorer-agent completes, read the journey trace from `.playwright-cli/<session>/journey-trace.yaml` and append a `## UI Baseline` section:

```markdown
## UI Baseline

**Captured**: YYYY-MM-DD
**Dev server**: `<resolved command>` (port <port>)
**Routes scanned**: /route1, /route2, ...

### Accessibility
- Total violations: N
- Critical: N, Serious: N, Moderate: N
- Categories: [category (count), ...]
- Full report: [journey trace](.playwright-cli/<session>/journey-trace.yaml)

### Flow State
- Entry point: /route
- Key flows: flow1 -> flow2, ...
- Screenshots: [screenshots](.playwright-cli/<session>/)

### Tooling Detected
- Storybook: yes/no (addon name if yes)
- Visual regression: chromatic/applitools/none
- Existing user stories: N files in playwright-stories/
```

Commit the updated research doc:
```bash
git add thoughts/shared/research/...
git commit -m "docs(research): add UI baseline for GH-NNN"
git push origin main
```

**Tear down dev server.**
```

- [ ] **Step 4: Verify the section is syntactically correct**

Run: `wc -l plugin/ralph-hero/skills/ralph-research/SKILL.md`
Expected: Line count increased by ~70-80 lines from original 342

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-research/SKILL.md
git commit -m "feat(ralph-research): add playwright UI baseline capture for frontend work"
```

---

### Task 2: Add Playwright Baseline Capture to Interactive Research Skill

**Files:**
- Modify: `plugin/ralph-hero/skills/research/SKILL.md`

**Context:** The interactive research skill is 272 lines. Same baseline capture as ralph-research, but with user prompts: ask before starting dev server, offer to save dev command to memory on first auto-detection.

- [ ] **Step 1: Add playwright baseline step between Step 6 and Step 7**

After Step 6 (Generate research document) and before Step 7 (Add GitHub permalinks), insert:

```markdown
### Step 6.5: Playwright UI Baseline (conditional)

If `--no-playwright` was NOT set in args:

1. **Detect ralph-playwright**: Read `~/.claude/plugins/installed_plugins.json`, check for a key containing `ralph-playwright`
2. **Assess frontend relevance**: Based on the research findings just written, decide if the work involves frontend/UI/UX changes. Consider: affected file types (.tsx, .jsx, .css, .html, .vue, .svelte), component directories, route/page modifications, visual or accessibility concerns. If `--playwright` is set, skip this assessment and treat as frontend-relevant.
3. **If both conditions met**, offer baseline capture:
   ```
   This research involves frontend changes and ralph-playwright is installed.
   Would you like me to capture a UI baseline? This establishes:
   - Current accessibility violation count (for regression detection)
   - Key user flow state (screenshots + accessibility snapshots)
   - Available tooling (Storybook, Chromatic, existing user stories)

   I'll need to start the dev server. [Y/n]
   ```
4. **If user agrees**:
   a. Resolve dev server command:
      - Check env var `RALPH_PLAYWRIGHT_DEV_CMD`
      - Check memory for saved dev server command
      - Auto-detect from `package.json` (`dev`, `start`, `serve` scripts)
   b. Start dev server in background, poll for readiness (timeout 30s)
   c. If this is the first auto-detection success, offer: "Want me to remember `<command>` as this project's dev server for future sessions?" (save to memory if yes)
   d. Dispatch explorer-agent for baseline:
      ```
      Agent(subagent_type="ralph-playwright:explorer-agent",
            prompt="Explore http://localhost:<port> with goal: capture accessibility baseline and key user flows. Focus on routes identified in this research. Session: <date>-baseline-GH-NNN",
            description="UI baseline GH-NNN")
      ```
   e. In parallel, detect tooling:
      - `playwright-stories/` directory existence and file count
      - `package.json` entries for storybook, chromatic, applitools
   f. After explorer-agent completes, read the journey trace and append `## UI Baseline` section to the research document (same format as Task 1)
   g. Tear down dev server (use `RALPH_PLAYWRIGHT_DEV_TEARDOWN_CMD` if set, otherwise kill PID)
5. **If user declines or ralph-playwright not installed**: Continue to Step 7 without baseline
```

- [ ] **Step 2: Verify file structure**

Run: `wc -l plugin/ralph-hero/skills/research/SKILL.md`
Expected: Line count increased by ~60-70 lines from original 272

- [ ] **Step 3: Commit**

```bash
git add plugin/ralph-hero/skills/research/SKILL.md
git commit -m "feat(research): add interactive playwright UI baseline capture"
```

---

### Task 3: Add UI Validation Phase Generation to ralph-plan (Autonomous)

**Files:**
- Modify: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`

**Context:** The ralph-plan skill is 522 lines. It needs: (1) flag parsing for `--playwright`/`--no-playwright`/`--ux-audit` in the argument-hint, (2) awareness of `## UI Baseline` in research docs during context gathering, (3) a UI Validation phase template appended as the final phase when baseline data exists.

- [ ] **Step 1: Update argument-hint to include playwright flags**

On line 4, change:
```
argument-hint: [optional-issue-number] [--research-doc path] [--parent-plan path] [--sibling-context text]
```
to:
```
argument-hint: [optional-issue-number] [--research-doc path] [--parent-plan path] [--sibling-context text] [--playwright] [--no-playwright] [--ux-audit]
```

- [ ] **Step 2: Verify frontmatter is valid**

Run: `head -10 plugin/ralph-hero/skills/ralph-plan/SKILL.md`
Expected: Valid YAML frontmatter with updated argument-hint

- [ ] **Step 3: Add playwright flag documentation after the Configuration section**

After the Configuration section (after line 59), before the `# Ralph GitHub Plan` heading, insert:

```markdown
## Playwright Flags

If `--playwright`, `--no-playwright`, or `--ux-audit` appear in the args:
- `--no-playwright`: Do NOT generate a UI Validation phase, regardless of baseline data
- `--playwright`: Generate a UI Validation phase even if no `## UI Baseline` section exists in research
- `--ux-audit`: Include `ux-audit` in the UI Validation phase (implies `--playwright`)
```

- [ ] **Step 4: Add UI Baseline awareness to Step 3 (Gather Group Context)**

In Step 3, after item 2 (`Read research-mapped files directly`), add item 2.5:

```markdown
2.5. **Check for UI Baseline**: After reading each research document, check if it contains a `## UI Baseline` section. If found:
   - Extract: capture date, dev server command/port, routes scanned, a11y violation counts, tooling detected (storybook, visual-diff, existing user stories)
   - Store this data for use in Step 5 (UI Validation phase generation)
   - If `--no-playwright` is set: ignore the baseline section entirely
```

- [ ] **Step 5: Add UI Validation phase template to Step 5 (Create Implementation Plan)**

After the main plan template section (after the `## Integration Testing` / `## References` closing), add:

```markdown
### UI Validation Phase (conditional)

If a `## UI Baseline` was found in the research document (or `--playwright` flag is set), append a final phase to the plan:

```markdown
## Phase N: UI Validation

depends_on: [phase-N-1]

### Overview
Run browser-based validation against the completed implementation to verify UI quality, accessibility compliance, and visual correctness.

### Tasks

#### Task N.1: Start dev server
- **files**: package.json (read)
- **tdd**: false
- **complexity**: low
- **acceptance**:
  - [ ] Dev server running and responding on expected port

#### Task N.2: Accessibility audit
- **skill**: /ralph-playwright:a11y-scan
- **tdd**: false
- **complexity**: medium
- **acceptance**:
  - [ ] No new a11y violations beyond baseline of {baseline_violation_count}

[CONDITIONAL — include if existing user stories detected in baseline tooling:]
#### Task N.3: End-to-end story tests
- **skill**: /ralph-playwright:test-e2e
- **tdd**: false
- **complexity**: medium
- **acceptance**:
  - [ ] All user stories in playwright-stories/ pass

[CONDITIONAL — include if storybook detected in baseline tooling:]
#### Task N.4: Component tests
- **skill**: /ralph-playwright:storybook-test
- **tdd**: false
- **complexity**: medium
- **acceptance**:
  - [ ] All Storybook interaction and a11y tests pass

[CONDITIONAL — include if chromatic or applitools detected in baseline tooling:]
#### Task N.5: Visual regression
- **skill**: /ralph-playwright:visual-diff
- **tdd**: false
- **complexity**: medium
- **acceptance**:
  - [ ] No unintended visual regressions

[CONDITIONAL — include only if --ux-audit flag is set:]
#### Task N.6: UX audit
- **skill**: /ralph-playwright:ux-audit
- **tdd**: false
- **complexity**: medium
- **acceptance**:
  - [ ] UX audit score meets target thresholds

#### Task N.last: Tear down dev server
- **tdd**: false
- **complexity**: low
- **acceptance**:
  - [ ] Dev server process terminated

### Phase Success Criteria

#### Automated Verification:
- [ ] a11y-scan ��� no new violations beyond baseline
[CONDITIONAL] - [ ] test-e2e — all stories pass
[CONDITIONAL] - [ ] storybook-test — all component tests pass
[CONDITIONAL] - [ ] visual-diff — no unintended regressions
[CONDITIONAL] - [ ] ux-audit — scores meet thresholds

#### Manual Verification:
- [ ] Review promoted screenshots for visual quality
```

**Phase number**: Set `N` to one more than the last implementation phase. Set `depends_on` to the last implementation phase.

**Conditional tasks**: Only include tasks whose conditions are met per the UI Baseline's `### Tooling Detected` section. Always include Task N.1 (start server), Task N.2 (a11y-scan), and Task N.last (tear down).

**When no UI Baseline exists but `--playwright` is set**: Generate the phase with only a11y-scan (default) and any tooling detectable from `package.json` at plan time. Omit baseline violation counts from acceptance criteria.

**Ralph-playwright skill menu** (for LLM awareness — use judgment to include additional skills if the work warrants it):
- `a11y-scan` — WCAG 2.2 AA accessibility audit
- `test-e2e` — run user story YAML files
- `story-gen` — generate user stories from feature description (not used in autonomous mode)
- `explore` — freeform URL exploration
- `storybook-test` — Storybook component tests
- `visual-diff` ��� visual regression via Chromatic/Applitools
- `ux-audit` — UX trends evaluation (explicit opt-in only)
```

- [ ] **Step 6: Verify file is well-formed**

Run: `grep -c "## Phase" plugin/ralph-hero/skills/ralph-plan/SKILL.md`
Expected: Count includes the new UI Validation phase template

- [ ] **Step 7: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-plan/SKILL.md
git commit -m "feat(ralph-plan): generate UI Validation phase from playwright baseline"
```

---

### Task 4: Add Interactive Playwright Flow to plan Skill

**Files:**
- Modify: `plugin/ralph-hero/skills/plan/SKILL.md`

**Context:** The interactive plan skill is 505 lines. Same UI Validation phase generation as ralph-plan, but with user consultation on which skills to include and an offer for story-gen.

- [ ] **Step 1: Add playwright awareness to Step 2 (Research & Discovery)**

After Step 2's item 4 (`Present findings and design options`), add item 5:

```markdown
5. **Playwright validation awareness**:
   If `--no-playwright` was NOT set in args:
   a. Read `~/.claude/plugins/installed_plugins.json` and check for `ralph-playwright`
   b. If installed AND the research reveals frontend-relevant work (or `--playwright` forced):
      - Check the research document for a `## UI Baseline` section
      - If no baseline exists, offer to capture one:
        ```
        I noticed this work involves frontend changes and ralph-playwright is available.
        Would you like me to capture a UI baseline before we plan? This helps write
        concrete verification criteria (e.g., "no new a11y violations beyond current 3").

        I'll need to start the dev server to do this. [Y/n]
        ```
      - If user agrees: resolve dev server command (env var `RALPH_PLAYWRIGHT_DEV_CMD` → memory → auto-detect from package.json), start it, dispatch explorer-agent for baseline, append `## UI Baseline` to research doc, tear down
      - If auto-detection succeeds for the first time, suggest: "Want me to save `<command>` as this project's dev server command for future sessions?"
```

- [ ] **Step 2: Add playwright consultation to Step 3 (Plan Structure Development)**

After the plan structure outline in Step 3, before "Get feedback on structure", add:

```markdown
   If ralph-playwright is available and the work is frontend-relevant, include the UI Validation phase in the proposed structure and consult the user:

   ```
   Since this involves frontend work and ralph-playwright is available, I'm including
   a UI Validation phase at the end:

   ## Proposed playwright validations:
   - [x] a11y-scan (accessibility audit) — always recommended
   [if user stories exist:] - [x] test-e2e (end-to-end story tests)
   [if storybook detected:] - [x] storybook-test (component tests)
   [if visual regression tool detected:] - [x] visual-diff (visual regression)

   Would you also like to:
   - Generate user stories with story-gen for new flows? [y/N]
   - Include a ux-audit (UX trends evaluation)? [y/N]

   You can add or remove any of these.
   ```

   Adjust the UI Validation phase based on the user's response.
```

- [ ] **Step 3: Add UI Validation phase to Step 4 (Detailed Plan Writing)**

In the plan template section of Step 4, after the `## Testing Strategy` / `## References` section, add:

```markdown
**UI Validation Phase**: If playwright validation was agreed upon in Step 3, append the UI Validation phase as the final phase using the same template structure defined in the ralph-plan skill (see `plugin/ralph-hero/skills/ralph-plan/SKILL.md` — "UI Validation Phase (conditional)" section). Adjust task selection based on the user's choices from the consultation.
```

- [ ] **Step 4: Verify file structure**

Run: `wc -l plugin/ralph-hero/skills/plan/SKILL.md`
Expected: Line count increased by ~50-60 lines from original 505

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/skills/plan/SKILL.md
git commit -m "feat(plan): add interactive playwright validation flow with user consultation"
```

---

### Task 5: Final Review and Consistency Check

**Files:**
- Read: all four modified skill files

- [ ] **Step 1: Verify all four files parse correctly**

Run:
```bash
head -10 plugin/ralph-hero/skills/ralph-research/SKILL.md
head -10 plugin/ralph-hero/skills/research/SKILL.md
head -10 plugin/ralph-hero/skills/ralph-plan/SKILL.md
head -10 plugin/ralph-hero/skills/plan/SKILL.md
```
Expected: All show valid YAML frontmatter

- [ ] **Step 2: Verify consistency across files**

Check that:
1. The `## UI Baseline` section format is identical between ralph-research (writes it) and research (writes it)
2. The flag names (`--playwright`, `--no-playwright`, `--ux-audit`) are consistent across all files
3. The plugin detection method (`installed_plugins.json` key containing `ralph-playwright`) is consistent
4. The dev server resolution order (env var → memory → auto-detect) is consistent
5. The skill tiering rules match the spec: a11y-scan always, test-e2e if stories, storybook-test if installed, visual-diff if installed, ux-audit if explicit
6. ralph-plan and plan both reference the same UI Validation phase template structure

- [ ] **Step 3: Verify no unintended changes**

Run: `git diff --stat`
Expected: Only the four skill files modified

- [ ] **Step 4: Commit any remaining changes**

```bash
git status
```
