---
date: 2026-03-19
status: draft
type: plan
github_issue: 618
github_issues: [618]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/618
primary_issue: 618
parent_plan: thoughts/shared/plans/2026-03-19-GH-0616-ralph-playwright-plugin.md
tags: [playwright, story-generation, skills, agents, sad-paths]
---

# GH-618: Ralph-Playwright Story Generation — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-19-GH-0616-ralph-playwright-plugin]]
- builds_on:: [[2026-03-19-GH-0617-ralph-playwright-foundation]]
- builds_on:: [[2026-03-19-agent-driven-ui-testing-stochastic-exploration]]

## Overview

Single issue: implement two story-generation skills (text-to-YAML and live-URL-to-YAML) and the fallback explorer agent. Both skills automatically apply the 8 sad path heuristics defined in the Phase 1 schema.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-618 | Story generation (story-gen, explore, explorer-agent) | S |

## Shared Constraints

- Inherits all constraints from parent plan (GH-616)
- Depends on GH-617: `plugin/ralph-playwright/schemas/user-story.schema.yaml` must exist (defines output schema)
- Output YAML must conform to the canonical schema from Phase 1: fields `name`, `type`, `url`, `workflow` (required); `persona`, `tags` (optional)
- Stories saved to `playwright-stories/<feature-kebab-name>.yaml` in the consuming project
- Sad path heuristics are mandatory — both skills must apply all 8 automatically
- Version detection logic: `npx playwright --version` → v1.56.0+ uses Planner; older uses fallback
- Explorer agent uses `@playwright/mcp` tools exclusively (no direct Playwright SDK)
- No TypeScript / MCP server — skills and agents only (SKILL.md + agent markdown files)
- No build/test commands apply (pure static skill/agent markdown files)

## Current State Analysis

- No story-generation skills exist in the repo
- Phase 1 (GH-617) defines the user story YAML schema at `plugin/ralph-playwright/schemas/user-story.schema.yaml`
- The 8 sad path heuristics are documented in the schema file from Phase 1
- Playwright Planner (`npx playwright init-agents --loop=claude`) is the primary exploration path for v1.56.0+
- `@playwright/mcp` direct navigation is the fallback for older Playwright versions
- Stagehand is a pivot path for complex SPAs (documented as deferred in parent plan)

## Desired End State

### Verification
- [ ] `story-gen` skill produces valid YAML output with ≥1 happy path and ≥1 sad path for any login/form description
- [ ] `explore` skill contains version detection logic (v1.56+ → Planner path; older → fallback)
- [ ] `explorer-agent` enforces ≤20 flows and 2-level depth limit with visited URL tracking
- [ ] All three files have correct YAML frontmatter
- [ ] Output YAML from both skills uses `playwright-stories/<name>.yaml` path convention

## What We're NOT Doing

- No test execution (Phase 3)
- No Stagehand integration (deferred per parent plan D2)
- No Figma MCP pipeline (deferred per parent plan D1)
- No actual Playwright execution in the skill files themselves — skills describe the process for the agent
- No TypeScript, MCP server, or build tooling

## Implementation Approach

Three files in dependency order: story-gen and explorer-agent can be written simultaneously; explore skill references the explorer-agent so benefits from it existing first. All three are pure markdown/YAML skill definitions.

---

## Phase 1: Story Generation Skills (GH-618)

### Overview

Create `story-gen/SKILL.md`, `explore/SKILL.md`, and `agents/explorer-agent.md`. These three files give agents the complete workflow to create user story YAML from either text descriptions or live URLs.

### Tasks

#### Task 1.1: story-gen skill
- **files**: `plugin/ralph-playwright/skills/story-gen/SKILL.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] YAML frontmatter has `name: ralph-playwright:story-gen` and description mentioning text/PRD input, automatic sad paths, and `playwright-stories/` output directory
  - [ ] Step 1 (Gather input): lists 4 inputs — feature description (minimum 1-2 sentences), target URL, user personas (defaults: anonymous/registered user), explicit edge cases
  - [ ] Step 2 (Generate): defines 3 categories with concrete rules:
    - Happy paths: primary goal achieved, optional variants, multi-step workflows
    - Sad paths: all 8 heuristics explicitly listed (empty field → validation error; invalid format → format error; wrong credentials → error + data cleared; unauthorized → redirect; duplicate → conflict; rate limited → throttle; network error → graceful; empty state → empty UI)
    - Edge paths: ≥3 mandatory (empty/zero state, max boundary input, accessibility keyboard/aria story)
  - [ ] Step 3 (Output): specifies `playwright-stories/<feature-kebab-name>.yaml`, all required fields listed, persona recommended
  - [ ] Step 4 (Present): shows count summary (N happy, N sad, N edge) and offers to run test-e2e

#### Task 1.2: explorer-agent
- **files**: `plugin/ralph-playwright/agents/explorer-agent.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] YAML frontmatter has `name: explorer-agent`, description mentioning fallback exploration and `@playwright/mcp`, `model: claude-sonnet-4-6`
  - [ ] Instructions specify: navigate with `browser_navigate`, snapshot with `browser_snapshot`, identify all interactive elements (nav links, buttons/CTAs, forms + fields, dropdowns/modals/tabs)
  - [ ] Depth limit explicitly stated: max 2 levels deep
  - [ ] Flow limit explicitly stated: stop after 20 unique flows
  - [ ] Visited URL tracking explicitly required (to prevent loops)
  - [ ] Output format is JSON array with fields: `name`, `startUrl`, `steps` (array of strings), `type` (happy/sad/edge), `formFound` (boolean)
  - [ ] Example JSON output included with ≥2 example flows

#### Task 1.3: explore skill
- **files**: `plugin/ralph-playwright/skills/explore/SKILL.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] YAML frontmatter has `name: ralph-playwright:explore` and description mentioning live URL, Playwright Planner primary path, @playwright/mcp fallback, automatic sad path augmentation
  - [ ] Prerequisites section: app must be running, `@playwright/mcp` must be registered
  - [ ] Step 1 (Version check): `npx playwright --version` command shown; v1.56.0+ → Planner; older → fallback; explicit version threshold documented
  - [ ] Primary path (Planner): `npx playwright init-agents --loop=claude` command shown; post-Planner steps: parse Markdown plan → convert flows to YAML → infer type (success→happy, error→sad) → save to `playwright-stories/<page-name>-discovered.yaml`
  - [ ] Fallback path: spawns `explorer-agent` with target URL; converts JSON output to canonical YAML schema
  - [ ] Step 2 (Sad path augmentation): 4 augmentation rules — forms found → invalid input + empty submission stories; auth-protected pages → unauthenticated access story; destructive actions → confirmation/cancellation story; data-loading components → empty state + error state story
  - [ ] Step 3 (Output): reports N happy discovered + N sad generated; suggests `/ralph-playwright:test-e2e`
  - [ ] Pivot note: Stagehand pivot documented — trigger condition (< 5 flows on complex SPA), install command, brief description of `stagehand.observe()` and `stagehand.agent()` approaches

### Phase Success Criteria

#### Automated Verification:
- [ ] `python3 -c "import yaml; [yaml.safe_load(open(f)) for f in ['plugin/ralph-playwright/skills/story-gen/SKILL.md', 'plugin/ralph-playwright/skills/explore/SKILL.md', 'plugin/ralph-playwright/agents/explorer-agent.md']]"` — no YAML frontmatter parse errors (note: frontmatter only, not full file)
- [ ] All 3 files exist at expected paths

#### Manual Verification:
- [ ] story-gen skill: all 8 sad path heuristics are explicitly listed (not just referenced)
- [ ] explore skill: version check command and both execution paths are unambiguous
- [ ] explorer-agent: a builder could implement it from reading only this file — depth/flow limits, output format, and visited-URL tracking are all specified

**Creates for next phase**: `agents/explorer-agent.md` (referenced by explore skill); `skills/story-gen/SKILL.md` and `skills/explore/SKILL.md` (Phase 3 test-e2e suggests these as story sources in its "none found" fallback)

---

## Integration Testing

- [ ] After Phase 3 complete: run `story-gen` on "a login page with email/password" description → verify output has ≥1 happy, ≥2 sad, ≥1 edge stories in valid YAML
- [ ] Run `explore` against `https://playwright.dev` (public stable URL) → verify it produces valid YAML with correct schema fields

## References

- Parent plan: `thoughts/shared/plans/2026-03-19-GH-0616-ralph-playwright-plugin.md`
- Foundation plan: `thoughts/shared/plans/2026-03-19-GH-0617-ralph-playwright-foundation.md`
- Research: `thoughts/shared/research/2026-03-19-agent-driven-ui-testing-stochastic-exploration.md`
- Issue: https://github.com/cdubiel08/ralph-hero/issues/618
