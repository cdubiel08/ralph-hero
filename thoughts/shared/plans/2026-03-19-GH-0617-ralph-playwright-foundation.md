---
date: 2026-03-19
status: draft
type: plan
github_issue: 617
github_issues: [617]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/617
primary_issue: 617
parent_plan: thoughts/shared/plans/2026-03-19-GH-0616-ralph-playwright-plugin.md
tags: [playwright, plugin, scaffolding, yaml-schema, skills]
---

# GH-617: Ralph-Playwright Plugin Foundation — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-19-GH-0616-ralph-playwright-plugin]]
- builds_on:: [[2026-03-19-agent-driven-ui-testing-stochastic-exploration]]

## Overview

Single issue: establish `plugin/ralph-playwright/` directory structure, user story YAML schema, reference example stories, and setup skill. No testing logic — pure scaffolding that phases 2–4 depend on.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-617 | Plugin foundation (directory structure, YAML schema, setup skill) | XS |

## Shared Constraints

- Plugin directory: `plugin/ralph-playwright/` (sibling of `plugin/ralph-hero/` and `plugin/ralph-knowledge/`)
- Plugin registration format mirrors `plugin/ralph-knowledge/.claude-plugin/plugin.json`
- Skill files follow the `plugin/ralph-hero/skills/*/SKILL.md` naming convention
- YAML schema must be valid YAML and self-documenting (comments explain each field)
- No TypeScript / MCP server in this phase — skills and agents only
- No build/test commands apply to this phase (pure static files — YAML, JSON, Markdown)

## Current State Analysis

- `plugin/ralph-playwright/` does not exist
- `plugin/ralph-knowledge/.claude-plugin/plugin.json` is the reference format for plugin registration (has `name`, `version`, `description`, `author`, etc.). The parent plan specifies a more minimal format for ralph-playwright with explicit `skills` and `agents` arrays
- Skills in ralph-hero use YAML frontmatter with `name`, `description`, `argument-hint` keys; body is markdown
- No existing user story schema in the repo — this phase defines the canonical format

## Desired End State

### Verification
- [ ] `plugin/ralph-playwright/.claude-plugin/plugin.json` is valid JSON with correct metadata
- [ ] `plugin/ralph-playwright/schemas/user-story.schema.yaml` is valid, well-commented YAML defining all story fields
- [ ] `plugin/ralph-playwright/schemas/example-auth.yaml` is valid YAML containing ≥1 happy, ≥2 sad, and ≥1 edge story
- [ ] `plugin/ralph-playwright/skills/setup/SKILL.md` has YAML frontmatter and clear step-by-step install instructions for all 3 MCPs + browsers + story directory

## What We're NOT Doing

- No story-gen, explore, test-e2e, a11y-scan, storybook-test, or visual-diff skills (phases 2–4)
- No explorer-agent or story-runner-agent (phases 2–3)
- No TypeScript, MCP server, or build tooling
- No `author` / `homepage` / `repository` / `license` fields in plugin.json (keep minimal, matching parent plan spec)
- No CI workflow integration (deferred per parent plan)

## Implementation Approach

Four files, no interdependencies — all can be created in any order. The schema file is the most critical as it defines the contract for all subsequent phases.

---

## Phase 1: Plugin Foundation (GH-617)

### Overview

Create the `plugin/ralph-playwright/` directory with plugin registration, YAML schema + example, and setup skill.

### Tasks

#### Task 1.1: Plugin registration file
- **files**: `plugin/ralph-playwright/.claude-plugin/plugin.json` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File is valid JSON (parseable with `JSON.parse`)
  - [ ] Contains fields: `name` ("ralph-playwright"), `version` ("0.1.0"), `description` (mentions "polymorphic UI testing", covers story generation, E2E, a11y, Storybook, visual regression)
  - [ ] Declares `skills` array with 7 entries: `["skills/setup", "skills/story-gen", "skills/explore", "skills/test-e2e", "skills/a11y-scan", "skills/storybook-test", "skills/visual-diff"]`
  - [ ] Declares `agents` array with 2 entries: `["agents/story-runner-agent.md", "agents/explorer-agent.md"]`

#### Task 1.2: User story YAML schema
- **files**: `plugin/ralph-playwright/schemas/user-story.schema.yaml` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File is valid YAML
  - [ ] Defines all required fields with inline comments: `name` (string), `type` (happy|sad|edge), `url` (string), `workflow` (multiline string)
  - [ ] Defines optional fields with inline comments: `persona` (string), `tags` (list of string)
  - [ ] Includes the 8 sad path heuristics as a comment block: empty required field, invalid format, wrong credentials, unauthorized access, duplicate submission, rate limiting, empty state, boundary values
  - [ ] Schema is self-documenting — a builder can author stories from reading this file alone

#### Task 1.3: Example auth stories
- **files**: `plugin/ralph-playwright/schemas/example-auth.yaml` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] File is valid YAML
  - [ ] Contains ≥1 story with `type: happy` (successful login flow with redirect verification)
  - [ ] Contains ≥2 stories with `type: sad` (wrong password + empty fields at minimum)
  - [ ] Contains ≥1 story with `type: edge` (accessibility / keyboard navigation story)
  - [ ] Every story has: `name`, `type`, `url`, `workflow` (≥3 workflow steps each)
  - [ ] All stories use `http://localhost:3000` as the base URL (generic localhost example)
  - [ ] Story for unauthenticated dashboard access is included (tests redirect behavior)

#### Task 1.4: Setup skill
- **files**: `plugin/ralph-playwright/skills/setup/SKILL.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File has YAML frontmatter with `name: ralph-playwright:setup` and a description mentioning first-time setup, MCP installation, and browser validation
  - [ ] Step 1 covers mandatory Playwright MCP: both `settings.local.json` snippet AND `claude mcp add` CLI form
  - [ ] Step 2 covers a11y MCP: `claude mcp add a11y-accessibility -- npx -y a11y-mcp-server`
  - [ ] Step 3 covers Storybook MCP: `npm install -D @storybook/addon-mcp` + `claude mcp add storybook-mcp --transport http http://localhost:6006/mcp --scope project`, notes Storybook 9.1.16+ requirement
  - [ ] Step 4 covers browser install: `npx playwright install chromium` with full-browser variant
  - [ ] Step 5 covers story directory creation: `mkdir -p playwright-stories` + `.gitignore` entry for `playwright-results/`
  - [ ] Validation section: version check command (`npx playwright --version`) and expected minimum (1.56.0)
  - [ ] Next steps section links to story-gen, explore, and test-e2e skills

### Phase Success Criteria

#### Automated Verification:
- [ ] `node -e "require('./plugin/ralph-playwright/.claude-plugin/plugin.json')"` — no errors
- [ ] `python3 -c "import yaml; yaml.safe_load(open('plugin/ralph-playwright/schemas/user-story.schema.yaml'))"` — no errors
- [ ] `python3 -c "import yaml; yaml.safe_load(open('plugin/ralph-playwright/schemas/example-auth.yaml'))"` — no errors

#### Manual Verification:
- [ ] Setup skill is readable and unambiguous — a developer unfamiliar with Playwright MCP could follow it
- [ ] Example stories cover happy, sad, AND edge — visible diversity of story types
- [ ] Schema comments are sufficient to author new stories without reading the plan

**Creates for next phase**: `schemas/user-story.schema.yaml` (Phase 2 story-gen and explore skills must conform to this schema); `plugin.json` (Phase 2 adds skills to the `skills/` directory)

---

## Integration Testing

- [ ] After all 4 phases complete: install plugin and verify all 7 skills appear in Claude Code skill list
- [ ] Run `/ralph-playwright:setup` and verify all install steps execute without error

## References

- Parent plan: `thoughts/shared/plans/2026-03-19-GH-0616-ralph-playwright-plugin.md`
- Research: `thoughts/shared/research/2026-03-19-agent-driven-ui-testing-stochastic-exploration.md`
- Reference plugin format: `plugin/ralph-knowledge/.claude-plugin/plugin.json`
- Reference skill format: `plugin/ralph-knowledge/skills/setup/SKILL.md`
- Issue: https://github.com/cdubiel08/ralph-hero/issues/617
