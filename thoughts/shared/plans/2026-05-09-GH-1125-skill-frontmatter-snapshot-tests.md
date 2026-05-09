---
date: 2026-05-09
status: draft
type: plan
github_issue: 1125
github_issues: [1125]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1125
primary_issue: 1125
parent_plan: thoughts/shared/plans/2026-05-07-GH-1118-test-coverage-hardening-epic.md
tags: [testing, skills, agents, frontmatter, mcp-server]
---

# Skill + Agent Frontmatter Snapshot Tests for Top-5 Autonomous Skills - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-07-GH-1118-test-coverage-hardening-epic]]

## Overview

Single-issue plan for GH-1125 (XS, P2). Adds vitest snapshot/invariant tests guarding required frontmatter fields on the five most-dispatched autonomous skills and their backing agents. Not behavior evals — these are guards against accidental field deletion.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1125 | Skill frontmatter snapshot tests for top-5 autonomous skills | XS |

## Shared Constraints

Inherited from parent epic plan-of-plans (`2026-05-07-GH-1118-test-coverage-hardening-epic.md`):

- All new tests live in `plugin/ralph-hero/mcp-server/src/__tests__/` and run under the existing `npm test` (vitest with coverage).
- No new top-level dependencies; use what is already in `mcp-server/package.json`. (`yaml@^2.7.0` is already a dep — confirmed.)
- Tests must run hermetically — no network, no GitHub API.
- Do NOT add full behavior/prompt evals. Frontmatter invariants only.

Feature-specific constraints (discovered while reading SKILL.md / agent files):

- Skills (`plugin/ralph-hero/skills/*/SKILL.md`) do **not** carry a `tools:` field. The runtime `tools:` allowlist lives on the corresponding agent (`plugin/ralph-hero/agents/*-agent.md`). The issue body says "Reads SKILL.md" and asserts `tools` on it — that is incorrect against the current repo layout. The plan reconciles this by:
  - Asserting `name` / `description` / `model` on the **skill** SKILL.md.
  - Asserting `tools` allowlist invariants on the matching **agent** `.md` (which is where the runtime enforcement boundary actually lives, per `MEMORY.md feedback_allowlist_not_blacklist.md`).
- The five skills under test and their agent counterparts:
  | Skill | Agent file |
  |-------|------------|
  | `ralph-impl` | `agents/impl-agent.md` |
  | `ralph-plan` | `agents/plan-agent.md` |
  | `ralph-research` | `agents/research-agent.md` |
  | `ralph-pr` | `agents/pr-agent.md` |
  | `ralph-merge` | `agents/merge-agent.md` |
- Agent `tools:` is a **comma-separated string** in the current files, not a YAML array (verified via `agents/impl-agent.md`). The test must split on `,` and trim.
- Minimum required GitHub MCP tool floor (the lowest common denominator that every one of these agents must keep): `mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue` and `mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue`. Per-agent extras (e.g., `list_sub_issues`, `create_comment`) are NOT asserted to avoid drift — the test guards the floor only.

## Current State Analysis

- `plugin/ralph-hero/mcp-server/src/__tests__/` already contains ~30 vitest files; pattern is direct `it()` / `describe()` blocks, no special harness.
- `yaml` (v2) is already a runtime dep — `parseDocument` / `parse` available.
- Each skill SKILL.md begins with a `---\n…\n---` YAML block; agents follow the same pattern.
- Vitest discovery is per-package, rooted at `mcp-server/`. The test file resolves skill/agent paths relative to `__dirname` walking up three levels: `../../../skills/<skill>/SKILL.md` and `../../../agents/<agent>.md`.
- No existing test reads SKILL.md or agent files — this is greenfield.

## Desired End State

A new vitest file that, on every `npm test` run, parses the YAML frontmatter of the five skills + five agents and asserts a small invariant set. CI fails if anyone deletes `tools:` from an agent or `model:` from a skill.

### Verification

- [ ] `npm test` passes from `plugin/ralph-hero/mcp-server/` with the new file present.
- [ ] Locally deleting `tools:` from `agents/impl-agent.md` causes the suite to fail with a message naming `impl-agent` and `tools`.
- [ ] Locally deleting `model:` from `skills/ralph-plan/SKILL.md` causes the suite to fail with a message naming `ralph-plan` and `model`.

## What We're NOT Doing

- No behavior or prompt-eval tests.
- No schema validation beyond field presence + type checks.
- No tests for non-autonomous skills (interactive `plan`, `impl`, `research`, etc.).
- No assertion of the full per-agent tool list (avoids drift; only the floor is enforced).
- No new package.json scripts — runs under existing `npm test`.

## Implementation Approach

Single file, single phase. The test file uses `describe.each` to generate per-skill and per-agent test cases, parses YAML frontmatter with the already-installed `yaml` package, and asserts presence + type. Failure messages embed the skill/agent name so output is self-locating.

---

## Phase 1: Add skill + agent frontmatter snapshot tests

- **depends_on**: null

### Overview

Create one vitest file under `plugin/ralph-hero/mcp-server/src/__tests__/` that reads the five skills' `SKILL.md` and the five matching agent files, parses their YAML frontmatter, and asserts the required-field invariants. Verify the suite is wired into `npm test` (no script changes required — vitest discovers `*.test.ts` automatically).

### Tasks

#### Task 1.1: Add the test file
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/skill-frontmatter.test.ts` (create), `plugin/ralph-hero/skills/ralph-impl/SKILL.md` (read), `plugin/ralph-hero/skills/ralph-plan/SKILL.md` (read), `plugin/ralph-hero/skills/ralph-research/SKILL.md` (read), `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (read), `plugin/ralph-hero/skills/ralph-merge/SKILL.md` (read), `plugin/ralph-hero/agents/impl-agent.md` (read), `plugin/ralph-hero/agents/plan-agent.md` (read), `plugin/ralph-hero/agents/research-agent.md` (read), `plugin/ralph-hero/agents/pr-agent.md` (read), `plugin/ralph-hero/agents/merge-agent.md` (read)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exports nothing — pure test file with `describe`/`it` blocks.
  - [ ] Uses `yaml` (already a dep) to parse frontmatter; uses Node `fs.readFileSync` + `node:path` only.
  - [ ] Resolves skill paths via `join(__dirname, "../../../skills", skillName, "SKILL.md")` and agent paths via `join(__dirname, "../../../agents", agentName + ".md")`.
  - [ ] Defines a constant `SKILLS = ["ralph-impl","ralph-plan","ralph-research","ralph-pr","ralph-merge"]` and a parallel `AGENTS = ["impl-agent","plan-agent","research-agent","pr-agent","merge-agent"]`.
  - [ ] Helper `readFrontmatter(absPath: string): Record<string, unknown>` that:
    - Reads file, matches `/^---\n([\s\S]*?)\n---/`, throws with the path if no match, else returns `parseYaml(match[1])`.
  - [ ] `describe.each(SKILLS)("skill frontmatter: %s", …)` block asserts:
    - `fm.name` is a non-empty string.
    - `fm.description` is a non-empty string.
    - `fm.model` is defined (string).
  - [ ] `describe.each(AGENTS)("agent frontmatter: %s", …)` block asserts:
    - `fm.name` matches the agent file name (without `.md`).
    - `fm.description` is a non-empty string.
    - `fm.model` is defined.
    - `fm.tools` is defined (string OR array — current files use comma-separated string; future-proof both).
    - When normalized to a list (split on `,` + trim if string), it includes BOTH `mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue` AND `mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue`.
  - [ ] Failure messages embed the skill/agent name (use the `%s` template label so vitest output identifies the failing case).

#### Task 1.2: Verify failure modes locally
- **files**: `plugin/ralph-hero/agents/impl-agent.md` (read), `plugin/ralph-hero/skills/ralph-plan/SKILL.md` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] With the suite green, temporarily comment out `tools:` in `agents/impl-agent.md`; run `npx vitest run src/__tests__/skill-frontmatter.test.ts` from `mcp-server/`; observe failure naming `impl-agent` and `tools`. Revert.
  - [ ] Temporarily comment out `model:` in `skills/ralph-plan/SKILL.md`; rerun; observe failure naming `ralph-plan` and `model`. Revert.
  - [ ] No code committed for this task — purely a verification step. (Document the two failure outputs in the PR description.)

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` from `plugin/ralph-hero/mcp-server/` — no errors.
- [ ] `npm test` from `plugin/ralph-hero/mcp-server/` — all passing, including the 10 new test cases (5 skills × 1 group + 5 agents × 1 group, give or take per-`it` granularity).
- [ ] `npx vitest run src/__tests__/skill-frontmatter.test.ts` — the new file alone passes.

#### Manual Verification:
- [ ] Test failure output, when a field is removed, clearly identifies which skill/agent and which field. (Confirmed via Task 1.2.)

**Creates for next phase**: N/A — single-phase plan.

---

## Integration Testing

- [ ] Full `npm test` in `plugin/ralph-hero/mcp-server/` passes locally and in CI (`ci.yml` Node 18/20/22 matrix).
- [ ] No coverage threshold regressions (Phase 2 of the parent epic added thresholds; the new file is plain test code that does not lower line/branch coverage).

## References

- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/1118
- This issue: https://github.com/cdubiel08/ralph-hero/issues/1125
- Parent epic plan: [thoughts/shared/plans/2026-05-07-GH-1118-test-coverage-hardening-epic.md, Phase 7](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-07-GH-1118-test-coverage-hardening-epic.md)
- Skills under test: `plugin/ralph-hero/skills/{ralph-impl,ralph-plan,ralph-research,ralph-pr,ralph-merge}/SKILL.md`
- Agents (where `tools:` actually lives): `plugin/ralph-hero/agents/{impl,plan,research,pr,merge}-agent.md`
- Memory note on allowlist semantics: `feedback_allowlist_not_blacklist.md`
