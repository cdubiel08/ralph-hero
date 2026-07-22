---
date: 2026-07-22
status: draft
type: plan
tags: [scheduling, launchd, catch-up, brief, runbook, ways-of-working]
github_issue: 1555
github_issues: [1555]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1555
primary_issue: 1555
estimate: S
---

# Scheduled daily brief preparation — local Claude Code scheduled task + runbook

## Prior Work

- builds_on:: [[2026-07-19-GH-1550-ways-of-working-action-surfaces]] — the epic research doc; § "Scheduled delivery is dead" documents the cos post-mortem and names the dream-loop launchd template as "the surviving scheduled-job pattern."
- builds_on:: [[2026-07-19-GH-1550-epic-ways-of-working-surfaces]] — the plan-of-plans; Feature E's scope statement and the resolved "Scheduled delivery" design decision (local Claude Code scheduled task, not cloud Routines, not launchd+ntfy resurrection).
- builds_on:: [[2026-07-22-GH-1557-group-catch-up-brief]] — the group plan that shipped Feature C (`catch-up --mode brief --prepare`), the exact mode this plan schedules. Merged today via PR #1583.

## Overview

Feature C shipped `/ralph:catch-up --mode brief --prepare` on main: a headless, zero-prompt mode that counts the human queue (decisions, unblocks, incubating thoughts), fires at most one `PushNotification` per day, and records the day in `~/.ralph-hero/brief/last-prepared` so a same-day re-run is a silent no-op. Feature E's job is narrow: wire a **thin, machine-local trigger** that calls this mode each weekday morning, and document the setup/teardown as a runbook. No new brief logic — the once-per-day idempotency guard the issue asks for already exists inside the mode (SKILL.md's `--prepare` branch); this plan points a schedule at it rather than rebuilding it.

The cos post-mortem is the guardrail: the prior morning-brief scheduling attempt (GH-1255, deleted with `plugin/ralph-hero/` in GH-1438) was a parallel stack — its own scripts, its own launchd job, its own ntfy push channel, zero ties to the plugin's verb surface — and a refactor deleted it without anyone noticing. This plan keeps every piece of brief logic inside the plugin (already true after Feature C) and confines the out-of-band footprint to one launchd plist that shells out to `claude -p "/ralph:catch-up --mode brief --prepare"`.

## Current State Analysis

`/ralph:catch-up --mode brief --prepare` exists and works end-to-end when invoked interactively or via `claude -p` from a session with the ralph plugin loaded (`ralph/skills/catch-up/SKILL.md:155-161`, `ralph/skills/catch-up/brief-composition.md:60-89`). Nothing currently calls it on a schedule — there is no cron job, launchd plist, or runbook for it anywhere in the repo.

The repo's only surviving scheduled-job precedent is the ralph-knowledge dream-loop (`scripts/dream/bootstrap.sh` + `scripts/dream/launchd/com.dubiel.dream-loop.plist.template`): an idempotent bootstrap script that renders a plist from a `__HOME__`/`__PROJECTS_DIR__`/`__USER__`-templated file and `launchctl load`s it. The prior cos-mode morning-brief scheduling work (GH-1255) also used a launchd plist template with the same shape, but its supporting code and template were deleted in GH-1438 — only its plan document survives in `thoughts/shared/plans/2026-05-15-GH-1255-cos-phase3-morning-brief-ntfy.md`, kept as historical record. That plan explicitly reasoned that a single scheduled job does not justify an installer/bootstrap script ("no `install-launchd.sh` helper... Defer the helper to Phase 6 when 4+ plists exist") and had the operator `cp` + hand-edit + `launchctl load` the template directly.

No repo file or doc references a native Claude Code cron facility (`CronCreate`/`CronList` or similar) — a grep across `ralph/`, `scripts/`, and `docs/` for `CronCreate`, `CronList`, and `claude cron` returns nothing. The established headless-invocation pattern for this codebase is `claude -p "<slash command>" --dangerously-skip-permissions` (`docs/plans/2026-03-06-ralph-cli-feedback-ux-impl.md:109-113`, the `run_headless()` function used by the (now-legacy) `ralph` CLI wrapper). `which claude` on this machine resolves to `/Users/dubiel/.local/bin/claude` — outside launchd's default minimal `PATH`, so the plist must set `PATH` explicitly.

### Key Discoveries

- `ralph/skills/catch-up/SKILL.md:159` — the `--prepare` branch reads `~/.ralph-hero/brief/last-prepared`; if it equals today's date it emits `Brief already prepared today.` and stops with no push, no reads. This IS the once-per-day idempotency guard the issue asks for — Feature E's job is to point a schedule at it, not add a second guard.
- `ralph/skills/catch-up/brief-composition.md:60-89` (§ Prepare (headless)) — zero prompts, zero mutations, exactly one `PushNotification`, marker write to `~/.ralph-hero/brief/last-prepared` (creating the parent dir on first run), terminal line `Brief prepared: N decisions, M unblocks, K thoughts.`
- `thoughts/shared/research/2026-07-19-GH-1550-ways-of-working-action-surfaces.md:61,75` — the cos post-mortem lesson verbatim, and the explicit naming of "dream-loop launchd template as the surviving scheduled-job pattern (`scripts/dream/`)."
- `scripts/dream/launchd/com.dubiel.dream-loop.plist.template:1-36` — the only plist template currently in the repo; uses `__HOME__`/`__PROJECTS_DIR__`/`__USER__` placeholders substituted via `sed` (`scripts/dream/bootstrap.sh:148-159`), `StartCalendarInterval` with a single `Hour`/`Minute` dict (fires every day — dream-loop has no weekday filter, unlike what this plan needs), `RunAtLoad: false`, and `EnvironmentVariables.PATH` set explicitly because launchd's default `PATH` won't resolve `uv`/`claude`.
- `thoughts/shared/plans/2026-05-15-GH-1255-cos-phase3-morning-brief-ntfy.md:124-125,211-236,238-259` — the deleted-but-documented cos precedent: (a) a 5-dict `StartCalendarInterval` array (`Weekday` 1-5, Mon-Fri) is the standard macOS launchd pattern for weekday-only firing — no single "weekdays" key exists; (b) for exactly one scheduled job, the plan explicitly decided against an installer script in favor of `cp` + hand-edit + `launchctl load`, deferring a dispatcher/installer to "Phase 6 when 4+ plists exist."
- `docs/plans/2026-03-06-ralph-cli-feedback-ux-impl.md:109-113` — `claude -p "$cmd" --dangerously-skip-permissions </dev/null` is the established headless-invocation shape for unattended ralph verb dispatch; needed here because a launchd job has no TTY to approve MCP tool calls (`next_actions`, `PushNotification`).
- `which claude` → `/Users/dubiel/.local/bin/claude` (verified on this machine) — confirms the plist's `PATH` must include a `.local/bin` entry, not just Homebrew paths.
- `ralph/skills/catch-up/SKILL.md:48` — `--mode brief` is refused inside `--loop` even with `--prepare` set, with the refusal message explicitly naming "the #1555 scheduled task" as the owner of the daily cadence — confirming the scheduling mechanism must live outside the skill's own `--loop` machinery.
- Reference-file budget: `ralph/skills/catch-up/` already carries 5 sibling reference files (`brief-composition.md`, `dashboard-render.md`, `narrative-synthesis.md`, `next-action-ranking.md`, `report-composition.md`) against the restructure's 3-4 guideline — confirms the runbook belongs as a new section inside the existing `brief-composition.md`, not a new sibling file.

## Desired End State

1. A launchd plist template exists at `scripts/brief/launchd/com.ralph.brief-prepare.plist.template`, following the dream-loop `__HOME__`/`__PROJECTS_DIR__`/`__USER__` substitution convention, that fires `claude -p "/ralph:catch-up --mode brief --prepare" --dangerously-skip-permissions` from the repo root on weekday mornings only (5-dict `StartCalendarInterval` array, Mon-Fri).
2. `ralph/skills/catch-up/brief-composition.md` carries a `## Scheduling runbook` section documenting: one-time setup (render + `launchctl load`), verify (`launchctl list`), forcing a same-day re-push (delete the marker file), and teardown (`launchctl unload` + remove the plist).
3. No brief-logic code changes — `--prepare`'s behavior is untouched; only a new out-of-band trigger and its documentation are added.
4. An operator following the runbook end-to-end sees the plist load, fire at the scheduled weekday time (or on manual trigger), and produce the same `PushNotification` + marker-write behavior as an interactive `--prepare` invocation.

### Verification

- [ ] `plutil -lint scripts/brief/launchd/com.ralph.brief-prepare.plist.template` exits 0 (macOS-only check; this repo's scheduled-job tooling is macOS-specific, matching the dream-loop precedent).
- [ ] The template's `ProgramArguments` invokes exactly `/ralph:catch-up --mode brief --prepare` with `--dangerously-skip-permissions`.
- [ ] The template's `StartCalendarInterval` has 5 `Weekday` entries (1 through 5).
- [ ] `ralph/skills/catch-up/brief-composition.md` contains a `## Scheduling runbook` heading with setup, verify, force-re-push, and teardown subsections.
- [ ] Manual: after `launchctl load`, a manually triggered run (`claude -p "/ralph:catch-up --mode brief --prepare" --dangerously-skip-permissions` from the repo root) produces the same terminal output and marker-file write as an interactive `--prepare` session.

## What We're NOT Doing

- No cloud Routines — the epic already documented that they don't honor committed plugin settings and ruled them out.
- No ntfy / pi-based resurrection of the cos-mode stack — the trigger shells out to `claude -p` directly; the phone/desktop push is Feature C's existing `PushNotification` call, not a new notification channel.
- No schedule-only code path — the plist fires the exact `/ralph:catch-up --mode brief --prepare` mode Feature C already ships. Per the epic's Integration Strategy ("C → E: the schedule invokes the same skill mode; there is no schedule-only code path"), testing the schedule means running `--prepare` by hand; this plan adds no test-only scaffolding.
- No new idempotency mechanism — the once-per-day guard already lives in `SKILL.md`'s `--prepare` branch (`~/.ralph-hero/brief/last-prepared`); this plan only documents how to trigger the mode that already owns it.
- No installer/bootstrap script — a single scheduled job doesn't justify one (see Design Decisions). Setup is a documented `cp`/`sed` + `launchctl load` runbook, matching the cos-phase3 single-job precedent.
- No EOD digest, week review, or any additional scheduled job — exactly one weekday-morning fire, matching the issue's stated scope.
- No changes to `brief-composition.md` § Prepare (headless) logic, `next_actions` enumeration, or the idea-file glob — those are Feature C/A/D territory, already shipped.

## Design Decisions & Open Ambiguities

- **Scheduling mechanism** — options: a Claude Code native cron/scheduled-task facility; a launchd plist following the dream-loop template; cloud Routines. **Decided: launchd plist, dream-loop pattern.** A repo-wide grep for `CronCreate`, `CronList`, and `claude cron` found zero precedent or reference in `ralph/`, `scripts/`, or `docs/` — no such facility is used or documented anywhere in this codebase. Cloud Routines are already rejected at the epic level. The dream-loop launchd template is proven on this machine, is explicitly named by the epic's own research doc as "the surviving scheduled-job pattern," and satisfies the cos post-mortem lesson exactly as well as any alternative would (all brief logic already lives in the plugin after Feature C; the plist is only the thin trigger).
- **Bootstrap script vs. runbook-only setup** — options: a full idempotent bootstrap script mirroring `scripts/dream/bootstrap.sh`; a documented manual `cp`/`sed` + `launchctl load` runbook. **Decided: runbook-only.** Unlike dream-loop, this job needs no config-discovery step (no roots to glob, no DB path to resolve) — setup reduces to one placeholder-substitution command plus `launchctl load`. The deleted cos-phase3 plan reasoned explicitly that a single scheduled job doesn't justify an installer script, deferring that until "4+ plists exist." One job here too.
- **Plist filename convention** — options: a literal-username filename matching dream-loop's `com.dubiel.dream-loop.plist.template`; a generic `com.ralph.*` filename with placeholder-only substitution inside. **Decided: generic `com.ralph.brief-prepare.plist.template`.** Keeps the template portable for any operator who clones the repo (no hardcoded username in the filename) while still using dream-loop's `__HOME__`/`__PROJECTS_DIR__`/`__USER__` substitution convention for the Label and paths inside.
- **Weekday-only firing** — options: a single `StartCalendarInterval` dict (fires every day); a 5-dict array with `Weekday` 1-5. **Decided: 5-dict weekday array**, matching both the cos-phase3 precedent and the issue's explicit "each weekday morning" scope — no macOS launchd key supports a single "weekdays" filter.
- **Fire time** — **Decided: 07:00 local**, hand-editable in the runbook before `launchctl load`. The issue only specifies "morning"; 07:00 leaves the push ready before a typical workday start without being the same clock slot as the unrelated dream-loop (03:00).

- **Headless permission surface** — options: `--dangerously-skip-permissions` (the repo's proven `run_headless()` precedent); a scoped `--allowedTools` allowlist naming exactly the tools `--prepare` touches. **Decided: ship the runbook with the proven skip-permissions shape, and include a documented hardening step to migrate to a scoped `--allowedTools` list once the exact headless plugin-context tool names are verified on this machine.** The blast radius is materially bounded: `--prepare` is zero-mutation by contract (read-only board queries, one PushNotification, one marker-file write) — part of why deferring the allowlist is acceptable. A blanket bypass on a scheduled job is a real (if machine-local) permission-surface cost, but an untested allowlist risks a silently hung/failed schedule — the worse outcome for a fire-and-forget trigger, and the exact failure the once-per-day push would mask. The runbook's verify step (manual headless run) is the natural moment to test and record the scoped variant; the hardening note carries the candidate tool list.

None — no open design decisions.

## Implementation Approach

Single phase, additive only: one new plist template file plus one new runbook section in an existing reference doc. No mcp-server, hook, or skill-logic changes — the phase touches only `scripts/brief/` (new) and `ralph/skills/catch-up/brief-composition.md` (append).

## Phase 1: Launchd trigger + scheduling runbook
- **depends_on**: null

### Overview
Add the plist template that fires `claude -p "/ralph:catch-up --mode brief --prepare"` weekday mornings, and document its full setup/verify/force-re-push/teardown lifecycle inside `brief-composition.md`.

### Changes Required

#### 1. Launchd plist template
**File**: `scripts/brief/launchd/com.ralph.brief-prepare.plist.template` (create)
**Changes**: New plist template, dream-loop shape:
- `Label`: `com.__USER__.brief-prepare`
- `ProgramArguments`: `/bin/bash -lc "cd __PROJECTS_DIR__/ralph-hero && claude -p '/ralph:catch-up --mode brief --prepare' --dangerously-skip-permissions"`
- `StartCalendarInterval`: array of 5 dicts, `Weekday` 1 through 5, each with `Hour: 7`, `Minute: 0`
- `StandardOutPath` / `StandardErrorPath`: `__HOME__/Library/Logs/ralph-brief-prepare.out` / `.err`
- `EnvironmentVariables.PATH`: `__HOME__/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` (covers the verified `claude` binary location plus `gh`/`git`)
- `RunAtLoad`: `false`
- A leading XML comment documenting the install workflow (cp target, `sed` substitution, `launchctl load`), mirroring the cos-phase3 template's header-comment convention.

#### 2. Scheduling runbook
**File**: `ralph/skills/catch-up/brief-composition.md` (modify — append after § Prepare (headless))
**Changes**: New `## Scheduling runbook` section with four subsections:
- **Setup** — the `sed -e "s|__HOME__|...|g" ...` render command writing to `~/Library/LaunchAgents/com.$(whoami).brief-prepare.plist`, followed by `launchctl load`. INCLUDE an env-prerequisite line: the plist's `/bin/bash -lc` login shell does NOT source the interactive zsh profile, so RALPH_* scope vars exported only there never reach the scheduled run — the vars MUST live in the tracked `<repo>/.claude/settings.json` (root CLAUDE.md § Environment Variables: scope vars only in a gitignored/shell location leave headless sessions board-blind with `owner is required`).
- **Verify** — `launchctl list | grep brief-prepare` should show the label loaded; the first manual headless run must print real counts (`Brief prepared: N decisions, M unblocks, K thoughts.`), NOT an `owner is required` error — that error means the env prerequisite above is unmet.
- **Force a re-push** (marker-file note) — delete `~/.ralph-hero/brief/last-prepared` and re-run `claude -p "/ralph:catch-up --mode brief --prepare" --dangerously-skip-permissions` to bypass the once-per-day guard for testing.
- **Teardown** — `launchctl unload` then remove the copied plist from `~/Library/LaunchAgents/`.
Also note explicitly: this is the only out-of-band piece (cos lesson honored); the schedule invokes the exact mode Feature C ships, so there is no separate code path to test.

### Success Criteria

#### Automated Verification
- [x] `plutil -lint scripts/brief/launchd/com.ralph.brief-prepare.plist.template` exits 0
- [x] `grep -c "<key>Weekday</key>" scripts/brief/launchd/com.ralph.brief-prepare.plist.template` returns `5`
- [x] `grep -q "catch-up --mode brief --prepare" scripts/brief/launchd/com.ralph.brief-prepare.plist.template`
- [x] `grep -q "^## Scheduling runbook" ralph/skills/catch-up/brief-composition.md`
- [x] `grep -q "last-prepared" ralph/skills/catch-up/brief-composition.md` (runbook references the same marker path § Prepare already documents — no drift between the two sections)

#### Manual Verification
- [ ] Run the Setup commands on a macOS machine with the repo cloned at the expected path; `launchctl list | grep brief-prepare` shows the job loaded.
- [ ] Manually invoke `claude -p "/ralph:catch-up --mode brief --prepare" --dangerously-skip-permissions` from the repo root; confirm it produces the `Brief prepared: N decisions, M unblocks, K thoughts.` terminal line (or `Brief already prepared today.` if already run once today) and that `~/.ralph-hero/brief/last-prepared` holds today's date.
- [ ] Delete the marker file and re-run; confirm a second `PushNotification` fires the same day (force-re-push works as documented).
- [ ] Run Teardown; confirm `launchctl list | grep brief-prepare` returns nothing.

## Testing Strategy

### Unit Tests
None — no code changes; the plist and doc section are not covered by the vitest or hook-test suites.

### Integration Tests
None. Per the epic's Integration Strategy, "testing E is running C's `--prepare` by hand" — the plist is a thin trigger around already-tested logic (Feature C's own tests cover `--prepare`'s behavior).

### Manual Testing Steps
Covered under Phase 1 § Manual Verification above: install, verify loaded, manual fire, force-re-push, teardown.

## Migration Notes

Purely additive and opt-in: a new template file plus a new doc section. No existing behavior changes — an operator who never runs the Setup commands sees nothing different. Rollback is symmetric: run Teardown (`launchctl unload` + remove the copied plist); the template and runbook can also simply be left uninstalled. No state-machine, schema, or MCP-server changes.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1555
- Epic plan: `thoughts/shared/plans/2026-07-19-GH-1550-epic-ways-of-working-surfaces.md` (Feature E scope + Scheduled delivery decision)
- Research: `thoughts/shared/research/2026-07-19-GH-1550-ways-of-working-action-surfaces.md` (cos post-mortem, dream-loop-as-surviving-pattern)
- Sibling group plan (Feature C, ships `--prepare`): `thoughts/shared/plans/2026-07-22-GH-1557-group-catch-up-brief.md`
- Shipped mode: `ralph/skills/catch-up/SKILL.md` § `--mode brief`, `ralph/skills/catch-up/brief-composition.md` § Prepare (headless)
- Dream-loop precedent: `scripts/dream/bootstrap.sh`, `scripts/dream/launchd/com.dubiel.dream-loop.plist.template`
- Deleted cos-mode precedent (historical, single-job "no installer" reasoning): `thoughts/shared/plans/2026-05-15-GH-1255-cos-phase3-morning-brief-ntfy.md`
- Headless invocation pattern: `docs/plans/2026-03-06-ralph-cli-feedback-ux-impl.md` (`run_headless()`, `claude -p ... --dangerously-skip-permissions`)
