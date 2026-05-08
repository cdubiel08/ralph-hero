---
date: 2026-05-08
status: draft
type: plan
github_issue: 1137
github_issues: [1137]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1137
primary_issue: 1137
parent_plan: thoughts/shared/plans/2026-05-07-GH-1136-autopilot-skill.md
tags: [skill, autopilot, scaffold, hero, autonomous]
---

# Autopilot Phase 1 — Skill Scaffold + Safety Check + Pick-Next-Actionable Plan

## Prior Work

- builds_on:: [[2026-05-07-GH-1136-autopilot-skill]]

## Overview

Single-issue plan for GH-1137, which is Phase 1 of the parent plan-of-plans (`2026-05-07-GH-1136-autopilot-skill.md`). Creates the `/ralph-hero:autopilot` skill directory with frontmatter, configuration block, argument parsing, safety check (Step 0), state decode (Step 1), pick-next-actionable (Step 2), and the In-Review filter (Step 2.5). No looping yet — this phase produces a working "do one issue and stop" skill that subsequent phases extend.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1137 | Autopilot: skill scaffold + safety check + pick-next-actionable | XS |

## Shared Constraints

Inherited from parent plan-of-plans `2026-05-07-GH-1136-autopilot-skill.md`. Highlights that bind this phase:

1. **Pure markdown skill** — no TypeScript / MCP changes in any phase. The skill body composes existing tools.
2. **Opt-in safety** — `RALPH_AUTOPILOT_ENABLE=true` is required. Hard refusal otherwise. Unattended automation is opt-in by design.
3. **Cross-tick state lives on the `prompt` field** (not on the audit log). The state-decode logic written here must accept `--state=BASE64` equals-form to handle base64 padding (`=` chars). Argument parser: everything after the first `=` is the value, including additional `=` from padding.
4. **Frontmatter shape mirrors `hero` skill** — same `context: inline`, `SessionStart` hook stub for `RALPH_COMMAND=autopilot`, plus `ScheduleWakeup` added to `allowed-tools`. Frontmatter `PreToolUse` registration for the wakeup gate is added in Phase 4 (this phase may either omit or include a stub reference; the gate file is created in Phase 4).
5. **Configuration block** — resolved at load time via backtick shell substitution: Owner, Repo, Project, Autopilot enabled, Max iterations (default 20), Audit log path. Mirror `hero/SKILL.md:48-53`.
6. **In-Review filter (Step 2.5) is load-bearing** — without it autopilot would falsely escalate just-PR'd issues after 3 ticks. Both filter rules MUST land in this phase, even though the loop machinery comes in Phase 3.
7. **Resolved configuration** for runtime lookups (echoed by load-time backticks): Owner=cdubiel08, Repo=ralph-hero, Project=3.
8. **No new dependencies** — `package.json` unchanged; `npm test` continues to pass without modification.

## Current State Analysis

The existing skill directory is `plugin/ralph-hero/skills/`. There is currently no `autopilot/` subdirectory. Reference frontmatter and configuration patterns:

- `plugin/ralph-hero/skills/hero/SKILL.md` lines 1-50: the canonical frontmatter shape for a top-level orchestrator skill (description, argument-hint, context, hooks, allowed-tools).
- `plugin/ralph-hero/skills/hero/SKILL.md` lines 47-53: the canonical "Configuration (resolved at load time)" block.
- `plugin/ralph-hero/skills/finish/SKILL.md` line 4: example multi-flag `argument-hint` syntax.
- `plugin/ralph-hero/hooks/scripts/set-skill-env.sh` — used by `SessionStart` hooks to write `RALPH_COMMAND=<value>` for downstream gates.
- `plugin/ralph-hero/mcp-server/src/lib/directions.ts:180-185` — `ACTIONABLE_PHASES` set; `In Review` is included, which is the reason Step 2.5 filter is required.

## Desired End State

After this phase:

- `plugin/ralph-hero/skills/autopilot/SKILL.md` exists.
- The skill is loadable by Claude Code: appears in `/help`, frontmatter parses cleanly.
- Invoking with `RALPH_AUTOPILOT_ENABLE` unset → safety-check refusal with copy-pasteable enable command.
- With `RALPH_AUTOPILOT_ENABLE=true` and an empty backlog → stops with "Backlog empty".
- With one XS issue in `Ready for Plan` → reports the picked issue and stops (no dispatch, no loop yet — Phase 2/3 work).
- An issue in `In Review` is filtered out by Step 2.5 and never picked.
- `npm test` in `plugin/ralph-hero/mcp-server/` still passes (unchanged — no MCP code touched).

### Verification

- [ ] Skill file exists at `plugin/ralph-hero/skills/autopilot/SKILL.md`
- [ ] YAML frontmatter parses with `python -c "import yaml; yaml.safe_load(open('plugin/ralph-hero/skills/autopilot/SKILL.md').read().split('---')[1])"`
- [ ] No new TypeScript files added
- [ ] `npm test` (in `plugin/ralph-hero/mcp-server/`) passes (unchanged)
- [ ] `/ralph-hero:autopilot` listed by `/help` after plugin reload
- [ ] Safety check refuses cleanly without `RALPH_AUTOPILOT_ENABLE=true`
- [ ] Empty backlog → "Backlog empty" stop message
- [ ] One XS in `Ready for Plan` → picked-issue report, no dispatch
- [ ] An issue in `In Review` is filtered out and not picked

## What We're NOT Doing

- **No dispatch logic** — `Skill("ralph-hero:hero", ...)` invocation is Phase 2.
- **No `git worktree list` check** — Phase 2.
- **No pre/post `get_issue` diff** — Phase 2.
- **No `ScheduleWakeup` call** — Phase 3.
- **No termination conditions** beyond Step 2.5's "no candidates → STOP" — Phase 3.
- **No audit log file** at `~/.ralph-hero/autopilot.jsonl` — Phase 4.
- **No PreToolUse hook gate** for `ScheduleWakeup` — Phase 4 (the frontmatter slot may be left absent here and added in Phase 4, or stubbed).
- **No README / CLAUDE.md / eval-scenarios.md edits** — Phase 5.

## Implementation Approach

A single new markdown file. The implementer follows the parent-plan §Phase 1 structure verbatim — frontmatter (lines 116-138 of parent plan), Configuration block (lines 140-147), Steps 0/1/2/2.5 (lines 153-200). No invention required; the parent plan provides drop-in copy.

**Phase dependency annotations**

This is a single-phase plan; the lone phase has `depends_on: null`.

---

## Phase 1: Skill Scaffold + Safety Check + Pick-Next-Actionable

- **depends_on**: null

### Overview

Create `plugin/ralph-hero/skills/autopilot/SKILL.md` with frontmatter, Configuration block, and Steps 0 through 2.5. The file ends after Step 2.5 — Steps 3+ are added in subsequent phases (issues #1138, #1139, #1140).

### Tasks

#### Task 1.1: Create skill directory and SKILL.md frontmatter

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Directory `plugin/ralph-hero/skills/autopilot/` exists
  - [ ] File `plugin/ralph-hero/skills/autopilot/SKILL.md` exists
  - [ ] Frontmatter contains: `description`, `argument-hint: "[--max-iterations N] [--auto-merge] [--dry-run] [--state=BASE64]"`, `context: inline`
  - [ ] `hooks.SessionStart` registers `set-skill-env.sh RALPH_COMMAND=autopilot` (path: `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh`)
  - [ ] `allowed-tools` lists exactly: `Read`, `Write`, `Bash`, `Skill`, `Agent`, `ScheduleWakeup`, and the seven `mcp__plugin_ralph-hero_ralph-github__ralph_hero__*` tools (`next_actions`, `list_issues`, `get_issue`, `save_issue`, `create_comment`, `pipeline_dashboard`)
  - [ ] No `PreToolUse` hook in this phase (added in Phase 4 / GH-1140)
  - [ ] YAML parses: `python -c "import yaml; yaml.safe_load(open('plugin/ralph-hero/skills/autopilot/SKILL.md').read().split('---')[1])"` exits 0

#### Task 1.2: Add Configuration block

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] `## Configuration (resolved at load time)` heading present
  - [ ] Backtick-substituted lines for: Owner (`RALPH_GH_OWNER`), Repo (`RALPH_GH_REPO`), Project (`RALPH_GH_PROJECT_NUMBER`), Autopilot enabled (`RALPH_AUTOPILOT_ENABLE`, default `false`), Max iterations (`RALPH_AUTOPILOT_MAX_ITERATIONS`, default `20`)
  - [ ] Audit log path documented as `~/.ralph-hero/autopilot.jsonl` (file is created in Phase 4 — line is informational here)
  - [ ] Block matches the shape of `plugin/ralph-hero/skills/hero/SKILL.md:47-53`

#### Task 1.3: Add Step 0 safety check

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] `## Step 0: Safety check` heading present
  - [ ] Body instructs: if `RALPH_AUTOPILOT_ENABLE` is not "true", STOP immediately
  - [ ] Refusal message includes copy-pasteable command: `export RALPH_AUTOPILOT_ENABLE=true`
  - [ ] No fallthrough — the skill body must terminate before Step 1 if the variable is missing

#### Task 1.4: Add Step 1 argument parsing + state decode

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] `## Step 1: Argument parsing + state decode` heading present
  - [ ] Documents four flags: `--max-iterations N` (default `${RALPH_AUTOPILOT_MAX_ITERATIONS:-20}`), `--auto-merge` (default false), `--dry-run` (default false), `--state=BASE64` (cross-tick state, equals-form)
  - [ ] Specifies equals-form parsing rule: "everything after the first `=` is the value, including additional `=` from base64 padding"
  - [ ] If `--state` present: base64-decode + JSON-parse to `{iteration, no_progress_streak, started_at, history}`
  - [ ] If `--state` absent: initialize `{iteration: 1, no_progress_streak: 0, started_at: <now>, history: []}`
  - [ ] Example JSON shape included in body (matches parent plan lines 168-174)

#### Task 1.5: Add Step 2 pick-next-actionable

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.4]
- **acceptance**:
  - [ ] `## Step 2: Pick the next actionable issue` heading present
  - [ ] Calls `next_actions(audience="agent", limit=10)` (limit 10 per parent plan, raised from default 5 to give Step 2.5 headroom)
  - [ ] Empty `items` → STOP with "Backlog empty"; final summary; do NOT call `ScheduleWakeup`
  - [ ] Filters to `kind == "issue"` only (skip PR / lock-stale / tree-continue directions)
  - [ ] If no `kind == "issue"` candidates after filter → STOP, same as empty backlog
  - [ ] Otherwise: top issue-kind direction is the candidate, passed to Step 2.5

#### Task 1.6: Add Step 2.5 In-Review filter

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.5]
- **acceptance**:
  - [ ] `## Step 2.5: Skip "human-gated" candidates (In-Review filter)` heading present
  - [ ] Background paragraph cites `plugin/ralph-hero/mcp-server/src/lib/directions.ts:180-185` (ACTIONABLE_PHASES includes `In Review`)
  - [ ] Filter rule 1 documented: `candidates = candidates.filter(c => c.workflowState !== "In Review")`
  - [ ] Filter rule 2 documented: `candidates = candidates.filter(c => !state.history.some(h => h.issue === c.issue && h.outcome === "pr_landed"))`
  - [ ] `--auto-merge` carve-out: for MVP, filter remains ON regardless; auto-merge In-Review handling tracked as follow-up (matches parent plan line 196)
  - [ ] Empty post-filter result → STOP with `outcome=backlog_empty`; final report mentions in-review PRs awaiting human merge
  - [ ] Non-empty post-filter result → top remaining candidate is the picked issue; subsequent steps are added in later phases (file ends here for Phase 1)

#### Task 1.7: End-of-phase comment block

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.6]
- **acceptance**:
  - [ ] After Step 2.5, the file ends with a brief inline note (HTML comment OK) such as `<!-- Steps 3+ added in subsequent phases (GH-1138, GH-1139, GH-1140) -->`
  - [ ] No dangling section headers (no `## Step 3:` placeholder)
  - [ ] Closing fence/whitespace clean (single trailing newline)

### Phase Success Criteria

#### Automated Verification:
- [ ] `test -f plugin/ralph-hero/skills/autopilot/SKILL.md`
- [ ] `python -c "import yaml; yaml.safe_load(open('plugin/ralph-hero/skills/autopilot/SKILL.md').read().split('---')[1])"` exits 0
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes (unchanged)
- [ ] `git diff --stat` shows only the new skill file (no MCP server source touched)

#### Manual Verification:
- [ ] `/ralph-hero:autopilot` is listed by `/help` after plugin reload
- [ ] Invoking with `RALPH_AUTOPILOT_ENABLE` unset → safety-check refusal with copy-pasteable enable command
- [ ] With `RALPH_AUTOPILOT_ENABLE=true` and an empty backlog → stops with "Backlog empty"
- [ ] With one XS issue in `Ready for Plan` → reports the picked issue and stops (no dispatch — Phase 2)
- [ ] An issue in `In Review` is filtered out and not picked even when it is the top `next_actions` direction

**Creates for next phase**: A working scaffold ending after Step 2.5, with a chosen `<picked>` issue identifier in scope. Phase 2 (GH-1138) appends Steps 3-6 (worktree check, pre-state capture, hero dispatch, post-state diff) starting from the picked issue.

---

## Integration Testing

Phase-1-only — full integration (loop, audit log, hook gate, eval scenarios) is verified in later phases. For Phase 1, the manual verification list above is the integration test.

## References

- Parent plan-of-plans: [thoughts/shared/plans/2026-05-07-GH-1136-autopilot-skill.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-07-GH-1136-autopilot-skill.md)
- Issue: [GH-1137](https://github.com/cdubiel08/ralph-hero/issues/1137)
- Parent issue: [GH-1136](https://github.com/cdubiel08/ralph-hero/issues/1136)
- Reference skill (frontmatter shape): `plugin/ralph-hero/skills/hero/SKILL.md`
- Reference skill (multi-flag argument-hint): `plugin/ralph-hero/skills/finish/SKILL.md`
- Action ranking: `plugin/ralph-hero/mcp-server/src/lib/directions.ts:180-185` (ACTIONABLE_PHASES — the reason Step 2.5 filter is needed)
- SessionStart hook helper: `plugin/ralph-hero/hooks/scripts/set-skill-env.sh`
