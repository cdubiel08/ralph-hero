---
date: 2026-03-19
status: draft
type: plan
github_issue: 619
github_issues: [619]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/619
primary_issue: 619
parent_plan: thoughts/shared/plans/2026-03-19-GH-0616-ralph-playwright-plugin.md
tags: [playwright, e2e-testing, story-execution, a11y, agents, skills]
---

# GH-619: Ralph-Playwright Story Execution — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-19-GH-0616-ralph-playwright-plugin]]
- builds_on:: [[2026-03-19-GH-0617-ralph-playwright-foundation]]
- builds_on:: [[2026-03-19-GH-0618-ralph-playwright-story-generation]]
- builds_on:: [[2026-03-19-agent-driven-ui-testing-stochastic-exploration]]

## Overview

Single issue: implement the core testing loop — test-e2e orchestrator skill, story-runner-agent, and a11y-scan standalone skill. This is the execution layer that consumes YAML stories from Phase 2 and produces pass/fail reports with screenshots and a11y violations.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-619 | Story execution (test-e2e skill, story-runner-agent, a11y-scan skill) | S |

## Shared Constraints

- Inherits all constraints from parent plan (GH-616)
- Depends on GH-617: YAML schema defines the story format consumed by test-e2e and story-runner-agent
- Depends on GH-618: story-gen/explore produce `playwright-stories/` input consumed by test-e2e
- story-runner-agent uses `@playwright/mcp` tools exclusively — no direct Playwright SDK imports
- Element targeting: accessibility tree snapshot first, find by label/role/text — NOT by CSS selectors
- Named Playwright sessions: each story-runner-agent gets its own isolated session `story-<name-kebab>-<8-char-uuid>`
- Screenshots at `playwright-results/<story-kebab>_<uuid>/<index>_<step-slug>.png`
- A11y check is best-effort: injected when `a11y-accessibility` MCP is registered, skipped silently otherwise
- On step failure: capture console errors, skip remaining steps, stop immediately (no retry)
- No TypeScript / MCP server — skills and agents only

## Current State Analysis

- No test execution skills exist in the repo
- Phase 1 schema (`user-story.schema.yaml`) defines the input format: `name`, `type`, `url`, `workflow` fields
- Phase 2 (GH-618) produces `playwright-stories/**/*.yaml` files as input
- `@playwright/mcp` provides: `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_evaluate`, `browser_screenshot`
- `a11y-mcp-server` provides `test_accessibility(url)` for WCAG audits
- Parallel agent execution: test-e2e spawns one story-runner-agent per YAML file simultaneously

## Desired End State

### Verification
- [ ] `test-e2e` skill globs `playwright-stories/**/*.yaml` and spawns one agent per file
- [ ] `story-runner-agent` returns structured JSON result with per-step status and screenshots
- [ ] A11y violations appear in story-runner-agent output when a11y MCP is registered
- [ ] A sad path story correctly produces `status: fail` when expected error message is absent
- [ ] `a11y-scan` skill runs 3 axe-core checks per URL and reports by severity (critical/serious/moderate/minor)
- [ ] All three files have correct YAML frontmatter

## What We're NOT Doing

- No Storybook component testing (Phase 4)
- No visual regression (Phase 4)
- No CI/CD workflow integration (deferred per parent plan D3)
- No MCP server for result persistence (deferred per parent plan D4)
- No retry logic on step failure (fail fast, capture state, stop)
- No browser selection UI — defaults to Chromium (Playwright default)

## Implementation Approach

story-runner-agent can be written independently; test-e2e references it so benefits from it existing first. a11y-scan is fully independent. Write all three in parallel.

---

## Phase 1: Story Execution (GH-619)

### Overview

Create `skills/test-e2e/SKILL.md`, `agents/story-runner-agent.md`, and `skills/a11y-scan/SKILL.md`. These give agents the complete workflow to discover, run, and report on user story YAML files using Playwright MCP.

### Tasks

#### Task 1.1: story-runner-agent
- **files**: `plugin/ralph-playwright/agents/story-runner-agent.md` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] YAML frontmatter has `name: story-runner-agent`, description mentioning single story execution, `@playwright/mcp`, screenshots, a11y check, structured JSON result; `model: claude-sonnet-4-6`
  - [ ] Input section: defines expected input as `{ name, type, url, persona, workflow }`
  - [ ] Session setup: creates named session `story-<story-name-kebab>-<8-char-uuid>` and screenshot directory `playwright-results/<story-name-kebab>_<uuid>/`
  - [ ] Step execution loop: for each non-empty workflow line — (1) `browser_snapshot` before acting, (2) locate element by label/role/text (NOT CSS), (3) execute action (navigate/click/fill/type/verify), (4) screenshot `<index>_<step-slug>.png`
  - [ ] Assertion handling: verify steps use snapshot state; explicit pass/fail determination documented
  - [ ] Failure handling: record failure message + expected vs actual, capture JS console errors via `browser_evaluate("(window.__consoleErrors || [])")`, mark remaining steps SKIPPED, stop immediately
  - [ ] A11y check: after final step (or after failure), if `a11y-accessibility` MCP registered → call `test_accessibility(url: <current page URL>)`, attach violations to result
  - [ ] Output format: JSON with fields `story`, `type`, `status` (pass/fail), `duration` (ms), `steps` (array of `{step, status, screenshot?, error?, consoleErrors?}`), `a11yViolations` (array of `{rule, impact, description, wcag}`)
  - [ ] Example output JSON included showing both a passing step and a failing step

#### Task 1.2: test-e2e skill
- **files**: `plugin/ralph-playwright/skills/test-e2e/SKILL.md` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] YAML frontmatter has `name: ralph-playwright:test-e2e` and description mentioning parallel agents, playwright-stories/, pass/fail aggregation, a11y violations, optional type/tag/story filters
  - [ ] Step 1 (Discover): glob `playwright-stories/**/*.yaml`; if none found → suggest story-gen and explore skills by name
  - [ ] Filters documented: `--type happy|sad|edge`, `--tags auth,login`, `--story "Login succeeds"` (substring match on name)
  - [ ] Step 2 (Fan out): spawn one `story-runner-agent` per YAML file simultaneously; each agent receives the full story object; named sessions ensure isolation
  - [ ] Step 3 (Aggregate): wait for all agents; produce unified report with: total count, pass count, fail count, skip count, a11y violation count; PASSED section (name, duration); FAILED section (name, failed step, expected vs actual, screenshot path, console errors); A11Y VIOLATIONS section (page, rule, impact, WCAG reference)
  - [ ] Report format matches the example from parent plan exactly (double-equals header, emoji indicators)
  - [ ] Results directory `playwright-results/` noted as auto-created by agents

#### Task 1.3: a11y-scan skill
- **files**: `plugin/ralph-playwright/skills/a11y-scan/SKILL.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] YAML frontmatter has `name: ralph-playwright:a11y-scan` and description mentioning standalone WCAG 2.2 AA audit, axe-core, a11y-mcp-server, without full story execution
  - [ ] Prerequisites section: `a11y-mcp-server` must be registered (link to setup skill)
  - [ ] Step 1: accepts URL(s) from arguments or prompts; multiple URLs run in parallel
  - [ ] Step 2: for each URL runs 3 checks: `test_accessibility(url)` (WCAG violations), `check_color_contrast(url)` (contrast ratios), `check_aria_attributes(url)` (ARIA validity)
  - [ ] Step 3: report format uses 4 severity levels with emoji: critical (🔴), serious (🟠), moderate (🟡), minor (⚪); each violation shows affected element, suggested fix, and WCAG rule reference
  - [ ] Example report output included matching parent plan format

### Phase Success Criteria

#### Automated Verification:
- [ ] All 3 files exist at expected paths
- [ ] Frontmatter is valid YAML in all 3 files

#### Manual Verification:
- [ ] story-runner-agent: element targeting rule (label/role/text, not CSS) is explicit and unambiguous
- [ ] test-e2e: parallel execution is clearly stated ("simultaneously", not sequentially)
- [ ] test-e2e: filter flags (`--type`, `--tags`, `--story`) are documented with examples
- [ ] a11y-scan: all 3 MCP tool calls are named exactly (`test_accessibility`, `check_color_contrast`, `check_aria_attributes`)
- [ ] Sad path test scenario: agent reading story-runner-agent instructions alone can determine when a "Verify error message appears" step should pass vs fail

**Creates for next phase**: `agents/story-runner-agent.md` is standalone and not consumed by Phase 4; `skills/a11y-scan/SKILL.md` completes the a11y coverage alongside story-runner-agent's per-story a11y check

---

## Integration Testing

- [ ] After this phase: run `test-e2e` against `schemas/example-auth.yaml` stories on a localhost app — verify screenshots appear per step in `playwright-results/`
- [ ] Verify a sad path story (wrong password) correctly fails when expected error message is absent from page
- [ ] Verify multiple stories run simultaneously (check log timestamps overlap)
- [ ] Run `a11y-scan` on a page with known issues — verify at least one violation reported with WCAG reference

## References

- Parent plan: `thoughts/shared/plans/2026-03-19-GH-0616-ralph-playwright-plugin.md`
- Foundation plan: `thoughts/shared/plans/2026-03-19-GH-0617-ralph-playwright-foundation.md`
- Story generation plan: `thoughts/shared/plans/2026-03-19-GH-0618-ralph-playwright-story-generation.md`
- Research: `thoughts/shared/research/2026-03-19-agent-driven-ui-testing-stochastic-exploration.md`
- Issue: https://github.com/cdubiel08/ralph-hero/issues/619
