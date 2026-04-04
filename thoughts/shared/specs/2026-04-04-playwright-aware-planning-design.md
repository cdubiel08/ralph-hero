---
date: 2026-04-04
status: draft
type: spec
title: Playwright-Aware Planning
github_issue: 730
github_url: https://github.com/cdubiel08/ralph-hero/issues/730
tags: [playwright, planning, cross-plugin, a11y, ui-testing]
---

# Playwright-Aware Planning

## Problem

Ralph-hero's planning skills generate verification steps (npm test, npm run build, lint) but have no awareness of ralph-playwright's UI validation capabilities. When planning frontend/UI/UX work, the planner misses opportunities to include accessibility audits, end-to-end story tests, visual regression checks, and other browser-based validation that ralph-playwright provides.

## Solution

Make the research and planning pipeline playwright-aware so that frontend work automatically gets UI validation steps when ralph-playwright is installed.

## Design Decisions

- **Frontend detection**: LLM judgment from context (research doc, affected files, issue description) — no rigid heuristics or labels. `--playwright` / `--no-playwright` flags for explicit override.
- **Validation placement**: Dedicated final "UI Validation" phase appended to the plan, not per-phase inline checks.
- **Baseline capture**: Research phase captures current UI state (a11y violations, flow screenshots) so the plan can write verification criteria against concrete baselines.
- **Dev server lifecycle**: Managed by the skill/orchestrator — start before captures, tear down after.

## Plugin Detection

Check for `ralph-playwright` in `~/.claude/plugins/installed_plugins.json`. This is the canonical registry Claude Code maintains. A simple file read — no MCP tool needed. Skipped entirely when `--no-playwright` is set.

## Dev Server Resolution

The command to start/stop the dev server is resolved in priority order:

1. **Env var** — `RALPH_PLAYWRIGHT_DEV_CMD` (start command) and `RALPH_PLAYWRIGHT_DEV_TEARDOWN_CMD` (cleanup command), set in `settings.local.json`
2. **Memory** — check for a saved memory about the project's dev server command/port
3. **Auto-detection** — scan `package.json` for `dev`, `start`, or `serve` scripts; detect framework-specific patterns (Next.js, Vite, CRA, etc.)

Teardown defaults to killing the process started in step 2. The explicit teardown env var handles complex cases (e.g., `docker-compose down`, stopping multiple services).

In interactive mode, when auto-detection succeeds for the first time, suggest saving the dev command to memory for future runs.

## Skill Tiering

Which ralph-playwright skills get included in the UI Validation phase:

| Skill | Condition |
|-------|-----------|
| `a11y-scan` | Always included (default) |
| `test-e2e` | Included if user stories exist in `playwright-stories/` |
| `story-gen` | Interactive mode only — ask user if they want stories generated |
| `storybook-test` | Included if `@storybook/addon-vitest` or `@storybook/test-runner` detected in `package.json` |
| `visual-diff` | Included if `chromatic` or `@applitools` detected in `package.json` |
| `ux-audit` | Only if `--ux-audit` explicitly passed |

The LLM has access to the full menu and can reference any ralph-playwright capability in its reasoning, but the defaults above guide automatic selection.

## Flag Interface

Both research and planning skills accept these flags via their args string:

| Flag | Effect |
|------|--------|
| `--playwright` | Force playwright integration even if LLM wouldn't have chosen it |
| `--no-playwright` | Suppress playwright integration entirely, skip detection |
| `--ux-audit` | Include ux-audit in the UI Validation phase (implies `--playwright`) |

Flags are parsed from the skill's args string. In hero pipeline mode, hero passes flags when invoking skills via `Skill()`.

## Architecture: Unified Dispatch (Simplified)

**UPDATE 2026-04-04**: Empirical testing confirmed that `Skill()` invocation honors the `model:` field AND allows sub-agent dispatch. This eliminates the autonomous/interactive split — both paths use the same mechanism. See [dispatch architecture research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-04-hero-dispatch-architecture-single-vs-team.md).

**Prerequisite**: GH-732 (migrate hero from Agent() to Skill() dispatch). Once hero calls `Skill("ralph-hero:ralph-research")` instead of `Agent("ralph-hero:research-agent")`, the research skill runs inline with full sub-agent access.

### Unified Flow (both autonomous and interactive)

All four skills (`ralph-research`, `research`, `ralph-plan`, `plan`) handle playwright detection and dispatch identically:

**Research skills (`ralph-research` and `research`):**
1. Detect ralph-playwright availability
2. If frontend-relevant (LLM judgment or `--playwright` forced): start dev server, dispatch explorer-agent for baseline capture
3. Append `## UI Baseline` section to research findings
4. Tear down dev server
5. Interactive mode (`research`): ask user for URL on auto-detection failure, offer to save dev command to memory

**Plan skills (`ralph-plan` and `plan`):**
1. Detect ralph-playwright availability
2. Read `## UI Baseline` from research doc (if it exists)
3. Generate UI Validation phase with tiered skills based on baseline data
4. Interactive mode (`plan`): consult user on which playwright validations to include, offer story-gen

## UI Baseline Section Format

Added to research findings documents when baseline capture runs:

```markdown
## UI Baseline

**Captured**: 2026-04-04
**Dev server**: `npm run dev` (port 3000)
**Routes scanned**: /login, /dashboard, /settings

### Accessibility (a11y-scan)
- Total violations: 3
- Critical: 0, Serious: 1, Moderate: 2
- Categories: color-contrast (1), form-labels (1), heading-order (1)
- Full report: [a11y baseline](.playwright-cli/2026-04-04-baseline/a11y-report.yaml)

### Flow State (explore)
- Entry point: /login
- Key flows discovered: login → dashboard, dashboard → settings
- Screenshots: [baseline screenshots](.playwright-cli/2026-04-04-baseline/)
- Research note: thoughts/shared/research/2026-04-04-app-exploration.md

### Tooling Detected
- Storybook: yes (@storybook/addon-vitest)
- Visual regression: chromatic
- Existing user stories: 4 files in playwright-stories/
```

## UI Validation Phase Format

Appended as the final phase in implementation plans:

```markdown
## Phase N: UI Validation

depends_on: [phase-N-1]

### Overview
Run browser-based validation against the completed implementation to verify UI quality, accessibility compliance, and visual correctness.

### Tasks

#### Task N.1: Start dev server
- files: package.json (read)
- complexity: low
- acceptance: Dev server running and responding on expected port

#### Task N.2: Accessibility audit
- skill: /ralph-playwright:a11y-scan
- acceptance: No new a11y violations beyond baseline of 3

#### Task N.3: End-to-end story tests
- skill: /ralph-playwright:test-e2e
- acceptance: All user stories in playwright-stories/ pass

#### Task N.4: Component tests
- skill: /ralph-playwright:storybook-test
- acceptance: All Storybook interaction and a11y tests pass

#### Task N.5: Visual regression
- skill: /ralph-playwright:visual-diff
- acceptance: No unintended visual regressions

#### Task N.6: Tear down dev server
- complexity: low
- acceptance: Dev server process terminated

### Phase Success Criteria

#### Automated Verification
- [ ] a11y-scan — no new violations beyond baseline
- [ ] test-e2e — all stories pass
- [ ] storybook-test — all component tests pass
- [ ] visual-diff — no unintended regressions

#### Manual Verification
- [ ] Review promoted screenshots for visual quality
```

Tasks N.3–N.5 are conditionally included based on the skill tiering rules. Only tasks whose conditions are met appear in the generated plan.

## Files Changed

| File | Change |
|------|--------|
| `plugin/ralph-hero/skills/ralph-research/SKILL.md` | Add playwright detection, dev server lifecycle, explorer-agent dispatch for baseline capture, append `## UI Baseline` to findings |
| `plugin/ralph-hero/skills/research/SKILL.md` | Same as ralph-research plus interactive prompts (ask for URL on failure, offer to save dev cmd to memory) |
| `plugin/ralph-hero/skills/ralph-plan/SKILL.md` | Read `## UI Baseline` from research doc, generate UI Validation phase with tiered skills, `--no-playwright` flag parsing |
| `plugin/ralph-hero/skills/plan/SKILL.md` | Same as ralph-plan plus interactive consultation on skill selection, offer story-gen |

### Not Changed

- `plugin/ralph-hero/skills/hero/SKILL.md` — no playwright-specific changes needed (prerequisite GH-732 migrates to Skill() dispatch separately)
- `plugin/ralph-hero/skills/ralph-impl/SKILL.md` — already executes verification from plan checkboxes
- `plugin/ralph-hero/skills/ralph-val/SKILL.md` — already validates against plan criteria
- `plugin/ralph-hero/agents/*` — no changes needed
- `plugin/ralph-playwright/skills/*` — consumed as-is, no modifications
- MCP server — no changes

### Prerequisite

- GH-732: Migrate hero from Agent() to Skill() dispatch — required for ralph-research to have sub-agent access in autonomous mode

## What We're NOT Doing

- No per-phase inline playwright checks — all validation is in the final phase
- No new MCP tools for plugin detection
- No changes to ralph-playwright skills themselves
- No automatic story generation in autonomous mode — only interactive mode asks the user
- No changes to ralph-impl or ralph-val — they consume the plan as-is
- No changes to hero/SKILL.md for playwright (hero migration is a separate prerequisite issue)
