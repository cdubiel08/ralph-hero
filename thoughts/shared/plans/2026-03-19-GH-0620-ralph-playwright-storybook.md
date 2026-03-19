---
date: 2026-03-19
status: draft
type: plan
github_issue: 620
github_issues: [620]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/620
primary_issue: 620
parent_plan: thoughts/shared/plans/2026-03-19-GH-0616-ralph-playwright-plugin.md
tags: [playwright, storybook, visual-regression, chromatic, a11y, skills]
---

# GH-620: Ralph-Playwright Storybook Integration — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-19-GH-0616-ralph-playwright-plugin]]
- builds_on:: [[2026-03-19-GH-0617-ralph-playwright-foundation]]
- builds_on:: [[2026-03-19-agent-driven-ui-testing-stochastic-exploration]]

## Overview

Single issue: implement component-level testing via Storybook 9 (storybook-test skill) and visual regression testing (visual-diff skill). Complements Phase 3's page-level E2E with component-level interaction and a11y assurance.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-620 | Storybook integration (storybook-test skill, visual-diff skill) | S |

## Shared Constraints

- Inherits all constraints from parent plan (GH-616)
- Depends on GH-617: plugin directory structure must exist (skills go in `plugin/ralph-playwright/skills/`)
- Does NOT depend on GH-618 or GH-619 at runtime — Storybook testing is independent of user story YAML
- Storybook version target: 9.x (Vitest mode preferred); legacy test-runner supported as fallback
- Vitest mode command: `npx vitest --project=storybook` (requires `@storybook/addon-vitest`)
- Legacy mode command: `npx test-storybook --url http://localhost:6006` (requires `@storybook/test-runner`)
- Storybook MCP: optional enrichment via `http://localhost:6006/mcp` — skill degrades gracefully if not registered
- Visual diff: Chromatic is default (pixel-perfect, free tier 5K snapshots/month); Applitools is alternative (AI-based)
- No TypeScript / MCP server — skills only (no agents needed for this phase)

## Current State Analysis

- No Storybook or visual regression skills exist in the repo
- Phase 1 (GH-617) establishes the plugin directory structure
- Storybook 9 ships `@storybook/addon-vitest` for Vitest browser mode (recommended)
- `@storybook/test-runner` is the legacy approach for older Storybook versions
- Storybook MCP (`@storybook/addon-mcp`) exposes `list-all-components` for coverage gap detection
- Chromatic integrates directly with Storybook via CLI (`npx chromatic`)
- Applitools Eyes provides AI-based visual comparison that handles dynamic content better than pixel-perfect diffing

## Desired End State

### Verification
- [ ] `storybook-test` detects and uses correct runner (Vitest vs legacy) based on installed packages
- [ ] Component-level a11y violations are surfaced in the storybook-test report
- [ ] Coverage gaps (components with no stories) are flagged when Storybook MCP is available
- [ ] `visual-diff` detects Chromatic vs Applitools vs neither, and guides through Chromatic setup if neither found
- [ ] Both skills have correct YAML frontmatter

## What We're NOT Doing

- No story-runner-agent integration (storybook-test uses Vitest/test-runner directly, not YAML stories)
- No Figma → Storybook pipeline (deferred)
- No CI/CD workflow integration (deferred per parent plan D3)
- No MCP server for test result persistence (deferred per parent plan D4)
- No custom Vitest configuration — skills invoke existing project configuration

## Implementation Approach

Two independent skills with no dependencies on each other. Both can be written simultaneously. storybook-test is slightly more complex (3 runner paths: Vitest, legacy, neither); visual-diff is simpler (2 tool paths + setup guide).

---

## Phase 1: Storybook Integration (GH-620)

### Overview

Create `skills/storybook-test/SKILL.md` and `skills/visual-diff/SKILL.md`. These provide component-level and visual regression testing as a complement to Phase 3's page-level E2E.

### Tasks

#### Task 1.1: storybook-test skill
- **files**: `plugin/ralph-playwright/skills/storybook-test/SKILL.md` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] YAML frontmatter has `name: ralph-playwright:storybook-test` and description mentioning Storybook 9, Vitest mode, legacy test-runner fallback, a11y violations, coverage gaps; requirements note Storybook 9+ with addon-vitest or test-runner
  - [ ] Step 1 (Detect): two detection commands shown — `npx storybook --version` (needs 9.x) and `cat package.json | grep -E "addon-vitest|test-runner"`; three branches documented: addon-vitest found → Vitest mode; test-runner found → Legacy mode; neither → install instructions
  - [ ] Install instructions (neither found): show `npm install -D @storybook/addon-vitest` with note to add to `main.js` addons array
  - [ ] Step 2 (Run): Vitest mode command `npx vitest --project=storybook`; Legacy mode command `npx test-storybook --url http://localhost:6006`
  - [ ] Step 3 (Storybook MCP enrichment): conditional — if MCP registered at `http://localhost:6006/mcp` → call `list-all-components`; cross-reference with test results; flag components with 0 stories as coverage gaps
  - [ ] Step 4 (Report): format includes — header with component/story/pass/fail counts; FAILED section with component name, story name, failure type (interaction or a11y), specific error; A11y summary with violation count and affected component; Coverage gaps section listing component names with 0 stories
  - [ ] Report format matches the example from parent plan exactly

#### Task 1.2: visual-diff skill
- **files**: `plugin/ralph-playwright/skills/visual-diff/SKILL.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] YAML frontmatter has `name: ralph-playwright:visual-diff` and description mentioning visual regression, Chromatic default, Applitools alternative, Storybook stories, unintended UI changes
  - [ ] Step 1 (Tool detection): `cat package.json | grep -E "chromatic|@applitools"` command shown; three outcomes: chromatic → Chromatic mode; @applitools/eyes-storybook → Applitools mode; neither → guide through Chromatic setup
  - [ ] Chromatic section: install command `npm install --save-dev chromatic`; run command `npx chromatic --project-token=<token-from-chromatic.com>`; free tier noted (5,000 snapshots/month); characteristic noted (pixel-perfect diffing, good for stable UIs)
  - [ ] Applitools section: install command `npm install --save-dev @applitools/eyes-storybook`; run command `npx eyes-storybook`; characteristic noted (AI-powered visual perception, ignores rendering noise)
  - [ ] "When to choose Applitools" guidance: 3 specific scenarios documented — excessive false positives from Chromatic on animations/dynamic content; need cross-browser visual comparison; Storybook stories with real data that varies between runs

### Phase Success Criteria

#### Automated Verification:
- [ ] Both files exist at expected paths
- [ ] Frontmatter is valid YAML in both files

#### Manual Verification:
- [ ] storybook-test: all 3 detection outcomes (Vitest, legacy, neither) are unambiguous — a builder can follow any branch without re-reading the plan
- [ ] storybook-test: Storybook MCP enrichment is clearly conditional ("if registered") not mandatory
- [ ] visual-diff: Chromatic setup is self-contained (no external docs needed to complete setup)
- [ ] visual-diff: "when to choose Applitools" guidance is specific enough to make the decision without research

**Creates for next phase**: No downstream phases — this is the final phase of the plugin. After this, all 7 skills and 2 agents declared in `plugin.json` are implemented.

---

## Integration Testing

- [ ] After all 4 phases complete: install plugin, verify all 7 skills appear in Claude Code skill list (`setup`, `story-gen`, `explore`, `test-e2e`, `a11y-scan`, `storybook-test`, `visual-diff`)
- [ ] Run `storybook-test` against a Storybook 9 project — verify per-story pass/fail reported with a11y violations
- [ ] Run `visual-diff` → Chromatic mode against a Storybook 9 project — verify diff report produced

## References

- Parent plan: `thoughts/shared/plans/2026-03-19-GH-0616-ralph-playwright-plugin.md`
- Foundation plan: `thoughts/shared/plans/2026-03-19-GH-0617-ralph-playwright-foundation.md`
- Research: `thoughts/shared/research/2026-03-19-agent-driven-ui-testing-stochastic-exploration.md`
- Storybook addon-mcp: https://github.com/storybookjs/addon-mcp
- Chromatic: https://chromatic.com
- Applitools Eyes Storybook: https://applitools.com/docs/eyes/sdks/storybook
- Issue: https://github.com/cdubiel08/ralph-hero/issues/620
