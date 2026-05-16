---
date: 2026-05-16
status: draft
type: plan
github_issue: 1274
github_issues: [1274]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1274
primary_issue: 1274
parent_plan: thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md
tags: [caretake, soul, orchestrator, schedule, heartbeat]
---

# Caretaker Team Entrypoint - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-16-GH-1267-unified-agent-system-epic]]
- builds_on:: [[2026-05-16-unified-agent-system-architecture]]

## Overview

Single S-sized feature implementing the Caretaker team orchestrator and its three heartbeat schedules.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1274 | Caretake SOUL.md (full body, replaces Feature A stub) | XS |
| 2 | GH-1274 | Caretake SKILL.md (team-orchestrator wrapper) | S |
| 3 | GH-1274 | Heartbeat schedule registrations (hourly / daily / weekly) | XS |

**Why grouped**: A single child feature `GH-1274` decomposed into three internal atomics; each is dispatchable on its own but they ship as one PR per the parent plan-of-plans' atomicity constraint.

## Shared Constraints

Inherited verbatim from `2026-05-16-GH-1267-unified-agent-system-epic.md` §Shared Constraints:

1. **No new runtime layers.** GitHub Projects V2 + `mcp__plugin_ralph-hero_ralph-github__ralph_hero__*` is the only event bus. ralph-knowledge SQLite is the only durable memory store.
2. **Skill / agent surface conventions.** Orchestrator skills live under `plugin/ralph-hero/skills/<skill-name>/SKILL.md`. Follow `hero/SKILL.md`, `autopilot/SKILL.md`, `ralph-debug-collate/SKILL.md` frontmatter shape (`description`, `argument-hint`, `context`, `hooks`, `allowed-tools`).
3. **SOUL files use a fixed schema.** `plugin/ralph-hero/skills/<team-entrypoint>/SOUL.md` with frontmatter `team:`, `voice:`, `refuses: [list]` + markdown body covering "How you talk" + at least one **Bad / Good** example. Length target: ~150-250 words of body prose.
4. **Style inheritance.** Inherits `plugin/ralph-hero/skills/STYLE.md` and `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md`. SOUL adds personality; STYLE wins for mechanics, SOUL wins for voice + refusals.
5. **iOS-friendly artifacts.** Long-running team sessions emit `result:` and `needs input:` markers for harness extraction. Large artifacts pushed via `gdrive-push` (Feature H wires this; caretake just emits the markers).
6. **Remote-trigger contract.** Caretake accepts (a) `RemoteTrigger` tool inputs, (b) `trigger:caretake` GitHub label (consumed + removed after dispatch), (c) `/schedule` cron ticks for heartbeats. Direct CLI invocation remains available.
7. **Outcome recording is automatic.** Caretake's terminal states call `outcome-recorder` (stub call until Feature E lands — record-outcome MCP call is the eventual target; see Phase 2 Task 2.4).
8. **Verification tooling.** Discovered commands for this repo:
   - Lint: `npm run lint` from `plugin/ralph-hero/mcp-server/`
   - Type-check: `npm run typecheck` from `plugin/ralph-hero/mcp-server/`
   - Tests: `npm test` from `plugin/ralph-hero/mcp-server/`
   - Skill smoke pattern: `plugin/ralph-hero/scripts/cos/smoke.sh`, `self-improve-smoke.sh`
9. **Atomicity.** XS or S only. M is a re-split signal.
10. **No OpenClaw runtime.** SOUL convention only — no gateway, no built-ins, no message bus.

### Feature-specific constraints (extended from parent)

- **Wrapping, not authoring.** All six bundled skills (`ralph-triage`, `ralph-hygiene`, `ralph-unblock`, `ralph-postmortem`, `report`, `trends`) already exist at `plugin/ralph-hero/skills/`. No edits to those skill bodies — caretake invokes them via `Skill()` calls only.
- **No regression on standalone invocation.** Each bundled skill must remain independently invokable (e.g., `/ralph-hero:ralph-hygiene` must still work). Caretake is an additional entrypoint, not a replacement.
- **SessionStart SOUL hook is provided by Feature A (GH-1268).** This plan assumes `plugin/ralph-hero/hooks/scripts/load-team-soul.sh` exists and reads `$RALPH_COMMAND=caretake`. If Feature A has not landed at impl time, the SOUL hook line in Phase 2's SKILL.md frontmatter is still authored (the hook is a no-op when the script is absent — verified by Feature A's smoke test) and Feature A's PR will pick it up.
- **Heartbeat cadence is fixed per parent plan-of-plans**: hourly hygiene, daily report, weekly trends. Override via env vars `RALPH_CARETAKE_HYGIENE_CRON`, `RALPH_CARETAKE_REPORT_CRON`, `RALPH_CARETAKE_TRENDS_CRON` (defaults match the plan).

## Current State Analysis

The six bundled skills all live under `plugin/ralph-hero/skills/` and share the same frontmatter pattern (`description`, `argument-hint`, `hooks.SessionStart` with `set-skill-env.sh RALPH_COMMAND=<name>`, `allowed-tools`). They are independently invokable via `Skill("<skill-name>")` calls and emit their own output to stdout. The `hero` skill demonstrates the team-orchestrator pattern (state machine over GitHub issues, `Agent()` dispatch, `Skill()` sub-invocation). The `autopilot` skill demonstrates `/schedule`-driven heartbeat invocation via `ScheduleWakeup`. No `caretake/` directory exists yet — Feature A is expected to create it with a SOUL.md stub; this plan replaces that stub with full body content and adds SKILL.md alongside.

The `/schedule` skill from the available-skills list creates remote routines via `CronCreate`. Heartbeat registration is a one-time bootstrap step performed by an installation script invoked manually (or by `/ralph-hero:setup-cli`); the schedule entries themselves call the caretake skill with mode flags (`--mode hygiene`, `--mode report`, `--mode trends`).

## Desired End State

After this plan completes:

- `plugin/ralph-hero/skills/caretake/SKILL.md` exists and is invokable via `/ralph-hero:caretake` with three modes: `--issue NNN` (event-driven), `--mode <hygiene|report|trends>` (heartbeat), or no args (interactive — fans out to all three modes serially as a smoke check).
- `plugin/ralph-hero/skills/caretake/SOUL.md` is fully authored (~150-250 words body) with quiet-steward voice, replacing any Feature A stub.
- Three `/schedule` routines registered and discoverable via `/schedule list`: `caretake-hourly-hygiene`, `caretake-daily-report`, `caretake-weekly-trends`.
- Standalone invocations of `ralph-triage`, `ralph-hygiene`, `ralph-unblock`, `ralph-postmortem`, `report`, `trends` are unchanged.

### Verification

- [ ] `cat plugin/ralph-hero/skills/caretake/SKILL.md | head -20` shows valid YAML frontmatter with `description`, `argument-hint`, `hooks.SessionStart`, `allowed-tools`.
- [ ] `cat plugin/ralph-hero/skills/caretake/SOUL.md | head -10` shows `team:`, `voice:`, `refuses:` frontmatter fields.
- [ ] Invoking `/ralph-hero:caretake --mode hygiene` from a fresh shell runs `ralph-hygiene` and emits a `result:` line.
- [ ] `gh project view 3 --owner cdubiel08` shows no regression in the standalone caretaker skills (their files in `plugin/ralph-hero/skills/{ralph-triage,ralph-hygiene,...}/SKILL.md` are byte-unchanged).
- [ ] `/schedule list` (or equivalent CronList) returns three entries with names starting `caretake-`.

## What We're NOT Doing

- Authoring or editing any of the six bundled skills' bodies. Wrapping only.
- Implementing the Director skill (Feature B / GH-1269). Caretake responds to its own `trigger:caretake` label directly; Director routing comes later.
- Implementing the full `outcome-recorder` (Feature E / GH-1272). Caretake calls a stub function that no-ops if Feature E hasn't landed.
- iOS-specific UX (Feature H / GH-1275). Caretake emits `result:` markers, but `gdrive-push` and ntfy wiring belong to Feature H.
- Cloud Monitoring / Langfuse event shims (Feature D / GH-1271).
- Re-implementing `/loop` or `ScheduleWakeup` semantics — heartbeat cadence is owned by `/schedule` + CronCreate.

## Implementation Approach

Three sequential phases. Phase 1 authors SOUL.md (zero risk, pure content). Phase 2 authors SKILL.md (uses SOUL via SessionStart hook; calls bundled skills via `Skill()`). Phase 3 registers the three schedules (one CronCreate call per heartbeat; safe to re-run idempotently).

**Phase dependency annotations** — Phase 1 has no deps; Phase 2 depends on Phase 1 (SOUL must exist before SKILL.md references it in frontmatter); Phase 3 depends on Phase 2 (schedules invoke `/ralph-hero:caretake` which must exist).

---

## Phase 1: Caretake SOUL.md (full body, replaces Feature A stub)

- **depends_on**: null

### Overview

Author the quiet-steward voice document. Replaces the Feature A stub (which contains only frontmatter + a placeholder body).

### Tasks

#### Task 1.1: Write caretake/SOUL.md
- **files**: `plugin/ralph-hero/skills/caretake/SOUL.md` (create or overwrite stub)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Frontmatter contains `team: caretake`, `voice: quiet-steward` (or equivalent descriptor), `refuses: [...]` with at least 3 refusal entries (e.g., "refuses to delete data without explicit confirmation", "refuses to silently archive items with open conversation threads", "refuses to push status updates that overstate progress").
  - [ ] Body is 150-250 words of prose covering "How you talk" + at least one **Bad / Good** example exchange.
  - [ ] Quiet-steward voice is consistent: low-affect, factual, deferential to the user, uses "the board" / "the project" not "I think" or "we should".
  - [ ] No emojis (per STYLE.md global rule).
  - [ ] File ends with a newline.

### Phase Success Criteria

#### Automated Verification:
- [x] `test -f plugin/ralph-hero/skills/caretake/SOUL.md` — file exists.
- [x] `head -10 plugin/ralph-hero/skills/caretake/SOUL.md | grep -E '^team:|^voice:|^refuses:'` — all three frontmatter fields present.
- [x] `wc -w plugin/ralph-hero/skills/caretake/SOUL.md` — body word count between 150 and 250 (frontmatter excluded; approximate is fine — gate is "not a stub").
- [x] `grep -E '^\*\*Bad:\*\*|^\*\*Good:\*\*' plugin/ralph-hero/skills/caretake/SOUL.md` — at least one Bad / Good example pair.

#### Manual Verification:
- [ ] Voice reads as quiet-steward, not as "another helpful assistant".
- [ ] Refusals are concrete (specific actions/situations), not abstract values.

**Creates for next phase**: A SOUL document that Phase 2's SKILL.md can reference via the SessionStart hook (`load-team-soul.sh` reads `$RALPH_COMMAND=caretake` and locates this file).

---

## Phase 2: Caretake SKILL.md (team-orchestrator wrapper)

- **depends_on**: [phase-1]

### Overview

Author the orchestrator skill body. Wraps six existing skills behind one entrypoint with three operating modes.

### Tasks

#### Task 2.1: Write caretake/SKILL.md frontmatter and skill body skeleton
- **files**: `plugin/ralph-hero/skills/caretake/SKILL.md` (create), `plugin/ralph-hero/skills/hero/SKILL.md` (read), `plugin/ralph-hero/skills/autopilot/SKILL.md` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] YAML frontmatter contains: `description` (2-3 sentence orchestrator summary), `argument-hint: "[--issue NNN | --mode <hygiene|report|trends>]"`, `context: inline`, `hooks.SessionStart` calls `set-skill-env.sh RALPH_COMMAND=caretake` AND (on a separate hook) `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/load-team-soul.sh` (Feature A's hook).
  - [ ] `allowed-tools` includes `Skill`, `Read`, `Bash`, the `ralph_hero__*` MCP tools needed for issue inspection (`get_issue`, `save_issue`, `create_comment`, `list_issues`, `pipeline_dashboard`), and `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome` (for the outcome-recorder stub call).
  - [ ] Body has a `## Workflow` section with three explicit branches: event-driven (`--issue NNN`), heartbeat (`--mode <name>`), and interactive default.
  - [ ] Event-driven branch reads the issue, classifies via labels (`trigger:caretake` → dispatch all six skills serially; `stale` → dispatch hygiene; `status-update-needed` → dispatch report; `trends-check` → dispatch trends; otherwise → dispatch triage), removes any `trigger:caretake` label after dispatch.

#### Task 2.2: Implement mode dispatch table in the SKILL.md body
- **files**: `plugin/ralph-hero/skills/caretake/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] `--mode hygiene` branch calls `Skill("ralph-hygiene")` (no arguments).
  - [ ] `--mode report` branch calls `Skill("report")`.
  - [ ] `--mode trends` branch calls `Skill("trends")`.
  - [ ] Each branch is a single `Skill()` invocation — no inline reimplementation of the bundled skill's logic.
  - [ ] Body documents the bundled-skill list (six skills) with one-line summaries each, so a future reader can see the wrap surface at a glance.

#### Task 2.3: Emit result / needs-input markers + post artifact comments
- **files**: `plugin/ralph-hero/skills/caretake/SKILL.md` (modify), `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [2.2]
- **acceptance**:
  - [ ] Every terminal exit path in the workflow body emits a `result:` line summarizing what ran (e.g., `result: caretake hygiene mode completed; 3 archive candidates surfaced`).
  - [ ] Any path that needs human intervention (e.g., stale issue with no clear owner) emits a `needs input:` line.
  - [ ] When invoked with `--issue NNN`, after dispatch, post a comment on the issue via `create_comment` using the `## Caretaker Action` artifact header per `artifact-comment-protocol.md`.
  - [ ] Body explicitly states that the bundled skills are NOT modified — caretake only invokes them.

#### Task 2.4: Outcome-recorder stub call
- **files**: `plugin/ralph-hero/skills/caretake/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.3]
- **acceptance**:
  - [ ] On terminal states (any branch that emits `result:`), the body calls `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome` with `{decision, result, trace_id_or_commit_sha}` — where `decision` is the mode/branch taken, `result` is "completed" or "needs-input", and `trace_id_or_commit_sha` is `$CLAUDE_SESSION_ID` (or commit SHA if available).
  - [ ] Body has a comment noting "When Feature E lands, this becomes a single `outcome-recorder` Skill() call; for now we call the MCP tool directly."
  - [ ] If the `knowledge_record_outcome` tool is unavailable (e.g., the MCP server isn't running), the body explicitly tolerates the failure and continues — outcome recording is best-effort.

### Phase Success Criteria

#### Automated Verification:
- [x] `test -f plugin/ralph-hero/skills/caretake/SKILL.md` — file exists.
- [x] `head -30 plugin/ralph-hero/skills/caretake/SKILL.md | grep -E 'argument-hint|allowed-tools|SessionStart'` — frontmatter shape correct.
- [x] `grep -c "Skill(" plugin/ralph-hero/skills/caretake/SKILL.md` — at least 6 invocations (one per bundled skill in the trigger:caretake branch, plus the three mode branches; standalone invocability of the six skills implies six Skill() calls in the full-fanout branch).
- [x] `grep -E "^result:|^needs input:" plugin/ralph-hero/skills/caretake/SKILL.md` — at least 3 marker examples documented in body.
- [x] `grep "knowledge_record_outcome" plugin/ralph-hero/skills/caretake/SKILL.md` — outcome stub call present.
- [x] `cd plugin/ralph-hero/mcp-server && npm run lint` — no errors (no TS files changed, but lint runs clean on the repo as a precondition).
- [x] `cd plugin/ralph-hero/mcp-server && npm test` — full vitest suite passes (no regression).
- [x] Bundled-skill file hashes unchanged: `git diff plugin/ralph-hero/skills/ralph-triage/SKILL.md plugin/ralph-hero/skills/ralph-hygiene/SKILL.md plugin/ralph-hero/skills/ralph-unblock/SKILL.md plugin/ralph-hero/skills/ralph-postmortem/SKILL.md plugin/ralph-hero/skills/report/SKILL.md plugin/ralph-hero/skills/trends/SKILL.md` — empty diff.

#### Manual Verification:
- [ ] From a fresh shell, `/ralph-hero:caretake --mode hygiene` invokes ralph-hygiene and prints a hygiene report followed by a `result:` line.
- [ ] From a fresh shell, `/ralph-hero:caretake --mode report` invokes report and posts (or dry-runs) a status update.
- [ ] From a fresh shell, `/ralph-hero:caretake --mode trends` invokes trends and prints sparklines.
- [ ] Standalone `/ralph-hero:ralph-hygiene` still works exactly as before.

**Creates for next phase**: The SKILL.md that the three `/schedule` routines invoke.

---

## Phase 3: Heartbeat schedule registrations (hourly / daily / weekly)

- **depends_on**: [phase-2]

### Overview

Register the three /schedule routines: hourly hygiene, daily report, weekly trends. Heartbeats invoke `/ralph-hero:caretake --mode <name>` on schedule.

### Tasks

#### Task 3.1: Author install script for heartbeat schedules
- **files**: `plugin/ralph-hero/scripts/caretake/install-schedules.sh` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Script is executable (`chmod +x` documented in the script header comment, applied during commit).
  - [ ] Script invokes the `/schedule` skill three times (one per heartbeat) via `claude -p` headless or equivalent, OR documents the manual three-step `/schedule create` invocation explicitly with copy-paste-ready commands when headless invocation is not available in the harness.
  - [ ] Each schedule entry has a stable name: `caretake-hourly-hygiene`, `caretake-daily-report`, `caretake-weekly-trends`.
  - [ ] Cron expressions: hourly = `0 * * * *`, daily = `0 9 * * *` (09:00 local), weekly = `0 9 * * 1` (Monday 09:00 local). Each is overridable via env var: `RALPH_CARETAKE_HYGIENE_CRON`, `RALPH_CARETAKE_REPORT_CRON`, `RALPH_CARETAKE_TRENDS_CRON`.
  - [ ] Each schedule's prompt invokes `/ralph-hero:caretake --mode <hygiene|report|trends>` with no other arguments.
  - [ ] Script is idempotent: re-running it does not create duplicate schedules. (If a schedule with the target name exists, skip or update; do not error.)
  - [ ] Script prints a summary line per schedule registered (or skipped).

#### Task 3.2: Document heartbeat schedules in caretake SKILL.md
- **files**: `plugin/ralph-hero/skills/caretake/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] SKILL.md body has a `## Heartbeat Schedules` section listing the three schedule names, cron expressions, and the env-var overrides.
  - [ ] Section includes the one-line install command: `bash plugin/ralph-hero/scripts/caretake/install-schedules.sh`.
  - [ ] Section notes that schedules are one-time bootstrap, not auto-installed on plugin load.

#### Task 3.3: Verify schedule discoverability
- **files**: `plugin/ralph-hero/scripts/caretake/install-schedules.sh` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] After running the install script, all three schedules appear in `/schedule list` output (verified manually).
  - [ ] Each schedule's `prompt` field, when inspected, contains `caretake --mode`.

### Phase Success Criteria

#### Automated Verification:
- [x] `test -x plugin/ralph-hero/scripts/caretake/install-schedules.sh` — script exists and is executable.
- [x] `bash -n plugin/ralph-hero/scripts/caretake/install-schedules.sh` — script parses (syntax check).
- [x] `grep -E "caretake-hourly-hygiene|caretake-daily-report|caretake-weekly-trends" plugin/ralph-hero/scripts/caretake/install-schedules.sh` — all three stable names present.
- [x] `grep "## Heartbeat Schedules" plugin/ralph-hero/skills/caretake/SKILL.md` — documentation section present.

#### Manual Verification:
- [ ] Running the install script on a clean machine creates three schedules visible via `/schedule list`.
- [ ] Running the install script twice does not duplicate schedules.
- [ ] An hourly tick fires `/ralph-hero:caretake --mode hygiene` (verified by observing the next scheduled run or by forcing a tick).

**Creates for next phase**: N/A — final phase.

---

## Integration Testing

- [ ] **Smoke**: From repo root, run `/ralph-hero:caretake` with no args. Verify it fans out to all three modes serially and ends with three `result:` lines (one per mode).
- [ ] **Event-driven**: Add label `trigger:caretake` to any open issue from the GitHub web UI. Run `/ralph-hero:caretake --issue NNN`. Verify the label is removed after dispatch and a `## Caretaker Action` comment is posted.
- [ ] **No-regression**: Run `/ralph-hero:ralph-hygiene` standalone. Verify behavior is unchanged vs. main.
- [ ] **Schedule end-to-end**: Run the install script, wait for the next hourly boundary, observe a `/ralph-hero:caretake --mode hygiene` invocation logged via the harness activity log (`~/.ralph-hero/activity/YYYY/MM/DD.jsonl`).
- [ ] **Feature A integration**: With Feature A's `load-team-soul.sh` in place, verify caretake's system prompt contains the SOUL body (visible in `/cos` or by inspecting the session start log).

## References

- Parent plan-of-plans: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/1274
- Related issues: https://github.com/cdubiel08/ralph-hero/issues/1267 (epic), https://github.com/cdubiel08/ralph-hero/issues/1268 (Feature A: SOUL framework — provides hook script + schema), https://github.com/cdubiel08/ralph-hero/issues/1272 (Feature E: outcome-recorder — replaces the stub call in Phase 2 Task 2.4)
- Bundled skills: `plugin/ralph-hero/skills/ralph-triage/SKILL.md`, `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md`, `plugin/ralph-hero/skills/ralph-unblock/SKILL.md`, `plugin/ralph-hero/skills/ralph-postmortem/SKILL.md`, `plugin/ralph-hero/skills/report/SKILL.md`, `plugin/ralph-hero/skills/trends/SKILL.md`
- Pattern references: `plugin/ralph-hero/skills/hero/SKILL.md` (orchestrator state machine), `plugin/ralph-hero/skills/autopilot/SKILL.md` (`/loop` + `ScheduleWakeup` heartbeat pattern), `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md` (comment header conventions)
