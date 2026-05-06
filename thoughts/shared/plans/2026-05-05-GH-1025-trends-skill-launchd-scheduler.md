---
date: 2026-05-05
status: draft
type: plan
tags: [metrics, trends, skill, launchd, scheduler, snapshots]
github_issue: 1025
github_issues: [1025]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1025
primary_issue: 1025
parent_plan: thoughts/shared/plans/2026-05-05-GH-1019-product-performance-over-time.md
---

# Phase 4: Trends skill + launchd scheduler — Implementation Plan

## Prior Work

- builds_on:: [[2026-05-05-GH-1019-product-performance-over-time]]
- builds_on:: [[2026-05-05-GH-1019-critique-v2]]

## Overview

One issue mapped to a single phase: surface trends to the user as a `/ralph-hero:trends` skill, ship an opt-in launchd template that captures a snapshot daily, and add a `--with-trends` flag to the existing `report` skill that appends a Trends section to the status update body when sufficient history exists.

| Phase | Issue   | Title                                       | Estimate |
|-------|---------|---------------------------------------------|----------|
| 1     | GH-1025 | Phase 4: Trends skill + launchd scheduler   | S        |

## Shared Constraints

Inherited verbatim from the parent plan-of-plans (`2026-05-05-GH-1019-product-performance-over-time.md`):

- Storage location: `~/.ralph-hero/snapshots/<owner>/<projectNumber>.jsonl`. Logs under `~/.ralph-hero/snapshots/run.log`.
- launchd template precedent: `scripts/dream/launchd/com.dubiel.dream-loop.plist.template`. Hard-codes `/Users/dubiel/...` paths — preserve that pattern (template is hand-edited per machine before `cp` to `~/Library/LaunchAgents/`).
- log rotation precedent: `scripts/dream/logrotate.sh` (cap at 1000 lines, atomic via `tail` + `mv`).
- env resolution precedent: `plugin/ralph-hero/scripts/resolve-env.sh` — source it; do not reimplement.
- Skill frontmatter follows the project's existing pattern (see `plugin/ralph-hero/skills/report/SKILL.md`): `description`, `argument-hint`, `context: fork`, `model`, `hooks.SessionStart` invoking `set-skill-env.sh RALPH_COMMAND=<name>`, `allowed-tools` listing fully-qualified MCP tool names with the `mcp__plugin_ralph-hero_ralph-github__` prefix.
- No new MCP tools are introduced in this phase. The skill consumes `ralph_hero__capture_snapshot` (Phase 1) and `ralph_hero__metrics_trends` (Phase 3). This issue depends on those tools being registered.
- No retention/compaction policy is added in v1.

Phase-specific constraints (discovered while reading codebase):

- The `report` skill currently uses `model: sonnet` and only declares two `allowed-tools`. To consume trends, its `allowed-tools` list must be extended with `mcp__plugin_ralph-hero_ralph-github__ralph_hero__metrics_trends`. Do not change its `model`.
- The skill's argument-hint string must remain a single bracketed list (see existing format) — append `[optional: --with-trends]` to it.
- Skills in this repo use the `mcp__plugin_ralph-hero_ralph-github__` namespace prefix for `allowed-tools`, NOT the bare `ralph_hero__` prefix. The parent issue body lists tools without the namespace; the actual SKILL.md must use the prefix to match the existing `report/SKILL.md`.

## Current State Analysis

- `plugin/ralph-hero/skills/report/SKILL.md` exists and posts a markdown status update via `create_status_update`. It has no awareness of snapshots or trends today.
- `plugin/ralph-hero/scripts/resolve-env.sh` provides `ralph_resolve_env` and `ralph_bridge_env`. It is a sourced helper, not an executable.
- No existing skill in `plugin/ralph-hero/skills/` invokes a snapshot tool.
- No `plugin/ralph-hero/scripts/snapshot/` directory exists yet.
- The dream-loop precedent in `scripts/dream/` lives at the *repo* root, not under `plugin/ralph-hero/scripts/`. This issue places its scheduler under `plugin/ralph-hero/scripts/snapshot/` (per parent plan §Phase 4) — that is the intended location for plugin-scoped scheduling artifacts and is consistent with the parent plan's task table.
- The dream-loop launchd plist hard-codes `/Users/dubiel/projects/ralph-hero/scripts/dream/...` paths and uses a `bash -lc 'cd ... && uv run ... && ./logrotate.sh'` ProgramArguments invocation. Mirror that shape.
- Phases 1 and 3 (issues #1022 and #1024) ship `ralph_hero__capture_snapshot` and `ralph_hero__metrics_trends` respectively. This issue does not register either tool itself.

## Desired End State

A user can:

1. Run `/ralph-hero:trends` (optionally with `--since 30d`) and see a fresh markdown trends report with sparklines and deltas.
2. Run `/ralph-hero:report --with-trends` and have the posted status update body include a "Trends" section when `≥2` snapshots exist for the project.
3. Copy `plugin/ralph-hero/scripts/snapshot/launchd/com.ralph.snapshot.plist.template` to `~/Library/LaunchAgents/com.ralph.snapshot.plist` (hand-editing paths if `$HOME` differs), `launchctl load` it, and have a snapshot row appear at the next 06:00 fire.
4. Inspect `~/.ralph-hero/snapshots/run.log` for clean run history (rotated to 1000 lines).

### Verification

- [ ] `plutil -lint plugin/ralph-hero/scripts/snapshot/launchd/com.ralph.snapshot.plist.template` succeeds.
- [ ] `bash -n plugin/ralph-hero/scripts/snapshot/run.sh` parses cleanly.
- [ ] `plugin/ralph-hero/skills/trends/SKILL.md` parses as a skill (frontmatter valid; `allowed-tools` list resolves to registered tool names).
- [ ] `plugin/ralph-hero/skills/report/SKILL.md` exposes `--with-trends` and adds `metrics_trends` to its `allowed-tools`.
- [ ] On a project with ≥2 prior snapshots, `/ralph-hero:trends` produces a markdown report with sparklines.
- [ ] `launchctl load ~/Library/LaunchAgents/com.ralph.snapshot.plist` exits 0 and the next fire writes one JSONL row.
- [ ] `report --with-trends` appends a Trends section when ≥2 snapshots exist; omits it (silently) otherwise.

## What We're NOT Doing

- No new MCP tools (those are Phases 1 and 3).
- No automatic plist install — the template is opt-in, hand-edited, and `launchctl load`-ed by the user.
- No `--with-trends` default flip in v1; default off, opt-in only.
- No retention/compaction of `run.log` beyond the 1000-line `tail` rotation that mirrors dream-loop.
- No CI verification of the plist or skill (Phase 5 / GH-1026 owns documentation + fixtures + CI verification).
- No changes to existing `pipeline_dashboard`, `create_status_update`, or `metrics_*` tool signatures.

## Implementation Approach

Single phase, four tasks corresponding to the four rows of the Phase 4 task table in the parent plan. Tasks 4.0 and 4.3 are pure markdown (skills); 4.1 is bash; 4.2 is XML plist text. None require TypeScript changes or new MCP-server code.

Tasks 4.0 and 4.1 are independent (no internal ordering). Task 4.2 depends on 4.1 (the plist invokes `run.sh`). Task 4.3 is independent of the others; it modifies a different file. All four are file-create / file-modify operations; complexity is low across the board.

---

## Phase 1: Trends skill + launchd scheduler (GH-1025)

- **depends_on**: [GH-1022, GH-1024]

### Overview

Ship the user-facing surface for the snapshot/trends pipeline: a new `trends` skill, an opt-in launchd template that triggers a daily snapshot, and a `--with-trends` flag on the existing `report` skill.

### Tasks

#### Task 1.1: Create `trends` skill (parent task 4.0)
- **files**: `plugin/ralph-hero/skills/trends/SKILL.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/skills/trends/SKILL.md`.
  - [ ] Frontmatter contains: `description`, `argument-hint: "[optional: --since 30d]"`, `context: fork`, `model: haiku`, `hooks.SessionStart` invoking `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=trends`.
  - [ ] `allowed-tools` lists exactly two entries (matching `report/SKILL.md` namespace style): `mcp__plugin_ralph-hero_ralph-github__ralph_hero__capture_snapshot` and `mcp__plugin_ralph-hero_ralph-github__ralph_hero__metrics_trends`.
  - [ ] Body documents the workflow: parse `--since` (default `7d`), call `capture_snapshot` (no args = current project, default 7d window), then call `metrics_trends` with `format: "markdown"` and the parsed `since` value, then print the returned markdown to the user.
  - [ ] Body explicitly notes the skill does NOT post anywhere — output goes to stdout only.

#### Task 1.2: Create snapshot runner script (parent task 4.1)
- **files**: `plugin/ralph-hero/scripts/snapshot/run.sh` (create), `plugin/ralph-hero/scripts/resolve-env.sh` (read), `scripts/dream/logrotate.sh` (read for pattern)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `bash -n plugin/ralph-hero/scripts/snapshot/run.sh` exits 0.
  - [ ] First line is `#!/usr/bin/env bash` and second non-comment line is `set -euo pipefail`.
  - [ ] Sources `resolve-env.sh` from the same `plugin/ralph-hero/scripts/` directory using `$(dirname "$0")/../resolve-env.sh`.
  - [ ] Calls `ralph_bridge_env` to populate `RALPH_GH_OWNER`, `RALPH_GH_PROJECT_NUMBER`, etc.
  - [ ] Invokes the MCP server's `capture_snapshot` tool. Implementation choice: shell out to a one-shot `node -e` invocation against the published MCP server, OR (simpler, preferred) call the existing `plugin/ralph-hero/scripts/<existing-cli>` if one exists; if no existing CLI shell exists, document inline as a TODO in a comment that Phase 5 (GH-1026) will firm up the invocation contract. Pick whichever matches an already-shipped pattern in `plugin/ralph-hero/scripts/`. (Note: the parent plan does not specify a CLI shape — research the directory at implementation time and match the closest existing pattern, e.g., `npx ralph-hero-mcp-server` one-shot if present.)
  - [ ] `STDOUT` and `STDERR` redirected to `~/.ralph-hero/snapshots/run.log` (append).
  - [ ] After the capture invocation, calls a logrotate routine equivalent to `scripts/dream/logrotate.sh`: cap `~/.ralph-hero/snapshots/run.log` at 1000 lines via `tail -n 1000 | mv` atomic rotation. Either inline the rotation or copy/refer-to a shared helper — match dream-loop conventions exactly.
  - [ ] Script exits non-zero if the capture invocation fails.

#### Task 1.3: Create launchd plist template (parent task 4.2)
- **files**: `plugin/ralph-hero/scripts/snapshot/launchd/com.ralph.snapshot.plist.template` (create), `scripts/dream/launchd/com.dubiel.dream-loop.plist.template` (read for pattern)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/scripts/snapshot/launchd/com.ralph.snapshot.plist.template`.
  - [ ] `plutil -lint <path>` exits 0 (the template is valid XML even with hard-coded paths).
  - [ ] `<key>Label</key>` value is `com.ralph.snapshot`.
  - [ ] `ProgramArguments` is a `bash -lc` invocation that `cd`s to `/Users/dubiel/projects/ralph-hero/plugin/ralph-hero/scripts/snapshot` and runs `./run.sh` (mirroring the dream-loop plist's shape; users hand-edit `/Users/dubiel/...` paths per machine before `cp` to `~/Library/LaunchAgents/`).
  - [ ] `StartCalendarInterval` schedules `Hour: 6, Minute: 0` (daily 06:00 local time).
  - [ ] `StandardOutPath` and `StandardErrorPath` point to `/tmp/ralph-snapshot.out` and `/tmp/ralph-snapshot.err` respectively.
  - [ ] `EnvironmentVariables.PATH` set to `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin` (matches dream-loop precedent).
  - [ ] `RunAtLoad` is `<false/>`.
  - [ ] No `EnvironmentVariables.RALPH_*_TOKEN` keys — tokens flow through `gh auth token` fallback per repo convention.

#### Task 1.4: Add `--with-trends` to `report` skill (parent task 4.3)
- **files**: `plugin/ralph-hero/skills/report/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `argument-hint` extended with `[optional: --with-trends]` (preserved single-string format).
  - [ ] `allowed-tools` list extended with `mcp__plugin_ralph-hero_ralph-github__ralph_hero__metrics_trends`.
  - [ ] Step 1 (Parse Arguments) documents the new flag: default off; when set, the report body will append a "Trends" section.
  - [ ] A new step (placed between Step 4 "Compose Report Body" and Step 5 "Determine Final Status", or appended to Step 4 as a sub-step) describes the Trends-append behavior:
    - Only run when `--with-trends` is passed.
    - Call `metrics_trends` with `format: "markdown"`, default `since`.
    - If the response indicates `<2` snapshots (or returns an empty trends payload), do NOT append the section and do NOT fail — silently skip.
    - Otherwise, append the returned markdown under a `## Trends` H2 to the body composed in Step 4.
  - [ ] `model: sonnet` and `context: fork` are unchanged.
  - [ ] Existing dry-run behavior continues to display the (now-extended) body.

### Phase Success Criteria

#### Automated Verification:
- [ ] `plutil -lint plugin/ralph-hero/scripts/snapshot/launchd/com.ralph.snapshot.plist.template` — exits 0.
- [ ] `bash -n plugin/ralph-hero/scripts/snapshot/run.sh` — exits 0.
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` — clean (no source files touched, but verifies repo health).
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` — green (no test changes; smoke check that no skill-loader test is broken by frontmatter changes).
- [ ] `grep -n "allowed-tools" plugin/ralph-hero/skills/trends/SKILL.md` returns exactly the two expected MCP tool names.
- [ ] `grep -n "with-trends" plugin/ralph-hero/skills/report/SKILL.md` finds the flag in both `argument-hint` and the body.

#### Manual Verification:
- [ ] On a project with ≥2 snapshots, `/ralph-hero:trends` prints markdown with sparklines and deltas to stdout.
- [ ] On a project with 0 or 1 snapshots, `/ralph-hero:trends` still runs (capture writes one row) and `metrics_trends` returns an "insufficient history" payload that the skill prints without crashing.
- [ ] `cp plugin/ralph-hero/scripts/snapshot/launchd/com.ralph.snapshot.plist.template ~/Library/LaunchAgents/com.ralph.snapshot.plist && launchctl load ~/Library/LaunchAgents/com.ralph.snapshot.plist` succeeds (after hand-editing `/Users/dubiel/...` paths if needed).
- [ ] After one fire (or a manual `launchctl start com.ralph.snapshot`), `tail -1 ~/.ralph-hero/snapshots/<owner>/<projectNumber>.jsonl` is a valid snapshot row and `~/.ralph-hero/snapshots/run.log` contains the run output.
- [ ] `launchctl list | grep ralph-snapshot` shows status `0` after a successful run.
- [ ] `/ralph-hero:report --with-trends` (dry-run) shows a body that includes a `## Trends` section.
- [ ] `/ralph-hero:report` (no flag) produces unchanged output relative to pre-Phase-4 behavior.

**Creates for next phase**: All user-visible Phase 4 surfaces (skill, scheduler template, `--with-trends` flag) — Phase 5 (GH-1026) consumes these to write README + CLAUDE.md docs and lock down CI.

---

## Integration Testing

- [ ] End-to-end: capture two snapshots one minute apart (overriding `capturedAt` if needed), then run `/ralph-hero:trends` and confirm `delta1d` is non-null and a sparkline renders.
- [ ] End-to-end: load the launchd plist on a dev machine, force-fire via `launchctl start`, and confirm a JSONL row appears.
- [ ] Regression: run the existing `/ralph-hero:report` (no flag) on a project and confirm output is byte-identical to a pre-modification baseline.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1025
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/1019
- Parent plan: `thoughts/shared/plans/2026-05-05-GH-1019-product-performance-over-time.md` (Phase 4)
- Plan critique (v2, APPROVED): `thoughts/shared/reviews/2026-05-05-GH-1019-critique-v2.md`
- Precedent — launchd template: `scripts/dream/launchd/com.dubiel.dream-loop.plist.template`
- Precedent — log rotation: `scripts/dream/logrotate.sh`
- Precedent — env resolution helper: `plugin/ralph-hero/scripts/resolve-env.sh`
- Existing skill (modify target): `plugin/ralph-hero/skills/report/SKILL.md`
- Sibling phases (dependencies): GH-1022 (capture_snapshot), GH-1024 (metrics_trends)
- Sibling phase (consumer): GH-1026 (docs + CI)
