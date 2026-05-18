---
date: 2026-05-17
status: draft
type: plan
tags: [plan, dispatch, loops, triggers, automation, roadmap, monitor, push-notification, remote-trigger, routines]
git_commit: 7931b4689d4e9454e4bcb877d6a0f2715579aa9d
git_branch: main
research_doc: thoughts/shared/research/2026-05-17-claude-code-dispatch-surfaces.md
---

# Plan: Incrementally adopt under-used Claude Code dispatch primitives

> **Companion research**: [[2026-05-17-claude-code-dispatch-surfaces]] documents all eleven dispatch surfaces and identifies the eight under-exploited ones this plan addresses.

## Overview

ralph-hero already exercises 9 of Claude Code's 11 dispatch surfaces deeply (`Agent`, background sessions, `/loop` fixed + dynamic, `/schedule`/`CronCreate`, `ScheduleWakeup`, hooks, MCP-driven triggers) plus an out-of-band `launchd` + `ntfy` integration. Four surfaces are referenced in code but **not exercised end-to-end**:

1. **`Monitor` tool** — allowlisted in `finish-agent` but the skill body still polls
2. **`PushNotification`** — bypassed in favor of a self-hosted `ntfy` bridge
3. **`RemoteTrigger` / Routines** — Director has a priority-1 contract for it but no producer fires it
4. **Cloud-driven autopilot trigger** — high-severity GCP alerts create GitHub Issues but don't fire autopilot

This plan brings each one online in a separate, independently-shippable phase. Each phase is XS or S — the smallest change that adds a new automation path without touching the others. Phases are ordered by ratio of leverage to risk; the first three close existing planned-but-unfinished work, the last three open new automation surfaces.

The unifying constraint: **no phase reduces the safety of an existing path**. autopilot's opt-in gate, hero's per-phase model tiers, Director's table-driven routing, and the worktree-isolation gates all remain in force. New surfaces compose with the existing pipeline at well-defined seams (Director's RemoteTrigger contract, hooks at terminal markers, etc.).

## Current State Analysis

Cross-referencing the research doc against the codebase:

- **Phase 1 prereq** — `plugin/ralph-hero/agents/finish-agent.md` already includes `Monitor` in its `tools:` allowlist (per [[2026-05-05-GH-0760-monitor-tool-ci-watch]]). The skill body in `plugin/ralph-hero/skills/finish/SKILL.md` (or wherever finish-agent's body lives) still uses `Bash run_in_background:true` plus polling. No new infrastructure needed.
- **Phase 2 prereq** — `plugin/ralph-hero/scripts/lib/push-on-completion.sh` is called from `ralph-merge` Step 9c and `cos/morning-brief.sh`. The bash helper shells out to `curl` against the `RALPH_COS_NTFY_TOPIC` server. `PushNotification` is not in any skill's allowlist yet.
- **Phase 3 prereq** — `plugin/ralph-hero/skills/director/SKILL.md:36-42` documents the priority-1 RemoteTrigger contract. `extract issue_number and team from the tool payload` is the existing call signature. No Routine in the repo produces this signal.
- **Phase 4 prereq** — `plugin/ralph-hero/scripts/monitoring-bridge/` creates GitHub Issues from GCP Cloud Monitoring alerts. Issues land in the project board's `Backlog` workflow state. autopilot must be already running to pick them up.
- **Phase 5 prereq** — GitHub Actions workflows (`route-issues.yml`, `sync-issue-state.yml`, etc.) react to GitHub events but stay in GitHub's runtime. No webhook reaches Claude Code today.
- **Phase 6 prereq** — `/schedule` heartbeats install via `plugin/ralph-hero/scripts/caretake/install-schedules.sh` using `Skill("schedule", …)` with `durable: false` (the default). Killing the session kills the heartbeat; only `launchd` survives.

The shared assumption across phases: the GitHub Projects V2 board remains the **system-of-record** for work. New trigger paths add new ways to *reach* the board, not new shadow queues.

## Desired End State

After all phases land:

- **finish-agent watches CI via `Monitor`** instead of polling Bash. Wakes Claude only when a new line appears in the run log. Latency drops from `poll_interval` to "near-instant"; token spend drops because polling sleeps are replaced by event waits.
- **Terminal-state markers fire `PushNotification`** (alongside the existing ntfy bridge). Users with the Remote Control mobile app paired see notifications without running an ntfy server. The ntfy bridge stays as the fallback for unpaired hosts.
- **`monitoring-bridge` produces a `RemoteTrigger`** when an alert is `CRITICAL`. Director receives the tool input directly, skips classification, and dispatches `caretakers` with the alert context. The alert→action latency drops from "next autopilot tick" to "immediate".
- **A `Routine` is registered for PR-merged webhooks** so that an external merge (a teammate clicking Merge in the GitHub UI) fires `ralph-merge`'s Step 9c push and outcome-collector mirror, even if no local autopilot session was running.
- **One heartbeat (caretaker hygiene) is durable** via `Skill("schedule", "...", durable: true)` so it survives session restart. The `launchd` template stays as backup; users can pick whichever they prefer.
- **High-severity alerts fire autopilot** through a Routine that calls `RemoteTrigger` on Director, bypassing the autopilot opt-in env-var check (because Director's priority-1 path is explicitly exempt — the gate guards the `Skill("loop")` entry, not Director's direct dispatch).

## What This Plan Does NOT Do (Deliberate Non-Goals)

- Does **not** replace `launchd` templates with cloud Routines wholesale. The two coexist; users opt into one per heartbeat based on whether they want host-pinned (free, requires their machine on) or cloud-hosted (subscription usage, survives host downtime).
- Does **not** introduce agent teams or `SendMessage`. Those remain experimental and out of scope.
- Does **not** change Director's classification algorithm. The `event-classes.md` taxonomy and the trigger:* > automation-label > workflow_state priority order stay intact.
- Does **not** modify the autopilot opt-in gate. `RALPH_AUTOPILOT_ENABLE=true` is still required for `Skill("loop")` from autopilot's body. The Director priority-1 path bypasses this by design — direct dispatch from a RemoteTrigger is intentional.
- Does **not** add per-phase `ScheduleWakeup` to worker agents (hero, watch, caretake, per-phase agents). Single-shot operator semantics remain.

## Phases

Each phase has: GitHub issue scope, files owned, verification steps, and a self-contained PR. Phases are independent — Phase 3 can ship before Phase 2 if reviewer bandwidth differs.

---

### Phase 1 — Adopt `Monitor` in finish-agent's CI watch (closes GH-0760)

**Scope.** Replace the polling Bash pattern in finish-agent's CI-watch step with a `Monitor` call.

**Files.**
- `plugin/ralph-hero/skills/finish/SKILL.md` (or wherever finish-agent's CI-watch step is documented) — replace the polling block with the Monitor call below.
- `plugin/ralph-hero/agents/finish-agent.md` — confirm `Monitor` is in `tools:`; add it if missing.

**Change.** Find the section that currently looks like:
```
gh run watch <run-id> &
# then poll status with sleep loop
```
Replace with:
```
Monitor(command: "gh run watch <run-id> --exit-status",
        goal: "wait for CI run to complete; surface failure logs immediately")
```

**Verification.**
- Run finish on a PR with a CI run pending → Monitor surfaces each status line; Claude wakes on completion (success or failure) instead of polling.
- Run finish on a PR with no pending CI → Monitor returns immediately; no sleep loops.
- Run finish on a PR whose CI fails → Monitor surfaces the failure line; Claude reacts within one model turn.
- Telemetry check: with `RALPH_DEBUG=true` and OTel pointing at local Langfuse, the trace shows a `mcp.tool.Monitor` span instead of N×`mcp.tool.Bash(sleep …)` spans.

**Rollback.** Single PR, single file. Revert restores polling behavior.

**Closes / supersedes.** [[2026-05-05-GH-0760-monitor-tool-ci-watch]] — that plan already covers this phase in detail.

---

### Phase 2 — Add native `PushNotification` alongside ntfy

**Scope.** Add a single `PushNotification` call at terminal-state markers (`Done`, `Human Needed`, `failed:`) in `ralph-merge` and the team orchestrators, alongside the existing `push-on-completion.sh` ntfy call. Both fire; users with the Remote Control mobile app paired see two notifications (acceptable for one cycle) — Phase 2.5 (below) collapses to one.

**Files.**
- `plugin/ralph-hero/skills/ralph-merge/SKILL.md` — at Step 9c, add `PushNotification(title="Merged #NNN", body="...")` after the existing ntfy curl.
- `plugin/ralph-hero/skills/caretake/SKILL.md` — at "Human Needed" escalation, add `PushNotification(title="Human Needed #NNN", body="...")`.
- `plugin/ralph-hero/skills/hero/SKILL.md` — at failure terminal, add `PushNotification(title="Failed #NNN", body="...")`.
- All four allowlists: add `PushNotification` to `allowed-tools`.

**Phase 2.5 (separate small PR, optional).** Once Phase 2 is validated and users confirm the native notification arrives, gate the ntfy curl on `RALPH_NTFY_LEGACY=true` so default behavior is single notification via `PushNotification`. ntfy stays as the explicit fallback for users without the mobile app paired.

**Verification.**
- Trigger a merge with `RALPH_COS_NTFY_TOPIC` set and Remote Control paired → both notifications arrive.
- Trigger a merge without the topic env var → only `PushNotification` fires (ntfy curl is a no-op when topic is unset; verify by reading `push-on-completion.sh`).
- Trigger on Bedrock/Vertex (if any user runs there) → `PushNotification` no-ops gracefully; ntfy fires normally.

**Rollback.** Per-file revert. Each skill is independent.

---

### Phase 3 — Wire a producer for Director's `RemoteTrigger` contract

**Scope.** Add a producer that fires `RemoteTrigger` against Director when `monitoring-bridge` ingests a `CRITICAL`-severity alert. Today, `monitoring-bridge` creates a GitHub Issue and waits for autopilot to pick it up. After this phase, critical alerts fire Director directly via a Routine; the issue is still created (for audit), but dispatch happens immediately.

**Files.**
- `plugin/ralph-hero/scripts/monitoring-bridge/relay.sh` (or equivalent) — after creating the GitHub Issue, if alert severity is `CRITICAL`, invoke `gh routine fire ralph-hero-critical-alert --data '{"issue_number": NNN, "team": "caretakers"}'`.
- `plugin/ralph-hero/scripts/monitoring-bridge/README.md` — document the new Routine and how to create it (one-time `gh routine create` or `RemoteTrigger` from a setup skill).
- `plugin/ralph-hero/skills/director/IOS-REMOTE.md` — add a section showing the RemoteTrigger payload shape (the Director side already accepts it; this is documentation).

**One-time setup (run by user via setup skill).**
```
RemoteTrigger(
  name: "ralph-hero-critical-alert",
  prompt: "Run /ralph-hero:director — the harness passes issue_number and team via tool input.",
  trigger: {type: "api"},
  model: "sonnet",
  repos: ["cdubiel08/ralph-hero"]
)
```

**Verification.**
- Manually fire the Routine with a known test issue: `curl -X POST <routine-fire-url> -d '{"issue_number": 123, "team": "caretakers"}'`. Verify Director receives the input, skips taxonomy classification, and dispatches caretakers.
- Force a CRITICAL alert through `monitoring-bridge` (use the existing `smoke.sh` test) → verify GitHub Issue is created AND Routine fires within ~30 seconds.
- Force a WARNING-severity alert → verify GitHub Issue is created and no Routine fires (Routine is gated on CRITICAL only).

**Rollback.** Delete the Routine and revert the relay.sh change. No state to clean up.

**New risk.** Routine consumes subscription usage on every CRITICAL alert. Document the rate in the README and consider a per-day cap in `monitoring-bridge` (e.g., max 10 RemoteTrigger fires per 24h).

---

### Phase 4 — Add a Routine for PR-merged webhook

**Scope.** Register a GitHub-triggered Routine that fires when a PR is merged on `main` (any author, not just ralph-hero PRs). The Routine runs `ralph-merge` Step 9c equivalents (push notification + outcome mirror) so external merges propagate into the same observability surfaces as ralph-hero-driven merges.

**Files.**
- `plugin/ralph-hero/scripts/routines/setup-pr-merged-routine.sh` (new) — wraps `RemoteTrigger` invocation with the appropriate filters.
- `plugin/ralph-hero/docs/routines.md` (new) — single page documenting all Routines ralph-hero uses, with setup commands.

**One-time setup.**
```
RemoteTrigger(
  name: "ralph-hero-pr-merged",
  prompt: "A PR was merged. Run the post-merge propagation: push notification + outcome mirror + (optionally) trigger autopilot if Done queue has fresh items.",
  trigger: {
    type: "github",
    event: "pull_request",
    filter: {action: "closed", is_merged: true, base_branch: "main"}
  },
  model: "haiku",
  repos: ["cdubiel08/ralph-hero"]
)
```

**Verification.**
- Merge a PR via the GitHub UI (not via `ralph-merge`) → Routine fires, push notification arrives, outcome mirror updated.
- Merge a PR via `ralph-merge` → Routine fires AND `ralph-merge` Step 9c fires; both are idempotent (verify outcome-collector handles double-write or gate the second).

**New risk.** Routine fires on every merge to main. Document the per-account hourly cap (the research notes that GitHub webhook caps apply during research preview). If we hit the cap, fall back to `launchd`-polled PR list.

---

### Phase 5 — Make one heartbeat durable via `/schedule`'s `durable: true`

**Scope.** Migrate the caretaker hygiene heartbeat from session-scoped `Skill("schedule", …)` to `durable: true` so it survives session restart. Compare durability against the existing `launchd` template; the user picks whichever survives their failure modes.

**Files.**
- `plugin/ralph-hero/scripts/caretake/install-schedules.sh` — change one of the three `/schedule create` invocations to pass `durable: true`. Document the trade-off in a comment block above the line.
- `plugin/ralph-hero/skills/caretake/SKILL.md` — note the new durable behavior in the heartbeat-installation section.

**Verification.**
- Run `install-schedules.sh`, verify `~/.claude/scheduled_tasks.json` (or wherever durable tasks land) contains the new entry.
- Kill the current Claude Code session; start a new one; verify the heartbeat fires on schedule without re-running `install-schedules.sh`.
- Verify `CronList()` shows the durable task with the correct cron expression after a fresh session start.
- 7-day expiry test: scheduled task auto-deletes after 7 days. Document a recurring refresh job (or rely on `install-schedules.sh` being re-run as a setup step).

**Rollback.** Re-run `install-schedules.sh` with the default `durable: false` after deleting the durable entry via `CronDelete(<task-id>)`.

**New risk.** 7-day expiry. Either accept it (user re-runs setup script weekly) or add a launchd job that re-runs `install-schedules.sh` every 6 days to refresh. Pick during implementation.

---

### Phase 6 — High-severity alerts fire autopilot via Routine + RemoteTrigger

**Scope.** Extend Phase 3's Routine to optionally fire autopilot (not just dispatch a single team) when the alert is `CRITICAL` AND the affected backlog has >=3 pending items. This is the largest phase because it crosses into autopilot's opt-in gate.

**Design.** The Routine fires `RemoteTrigger` against Director with a special payload `{team: "builders", issue_number: NNN, auto_continue: true}`. Director sees `auto_continue: true` and, after dispatching the named issue, also sets a sentinel that hero (or a new wrapper) reads to decide whether to invoke `/ralph-hero:autopilot` after completing the named issue.

**Files.**
- `plugin/ralph-hero/skills/director/SKILL.md` — add Step 4.5: if `RemoteTrigger` payload includes `auto_continue: true`, write `${TMPDIR}/ralph-autopilot-continue` sentinel before dispatch. Document under the remote-trigger contract.
- `plugin/ralph-hero/skills/hero/SKILL.md` — after a successful run, if `${TMPDIR}/ralph-autopilot-continue` exists AND `RALPH_AUTOPILOT_ENABLE=true`, invoke `Skill("ralph-hero:autopilot")` as the last step. Delete the sentinel after read.
- `plugin/ralph-hero/scripts/monitoring-bridge/relay.sh` — when severity is `CRITICAL` AND backlog count >=3 (query `next_actions`), include `auto_continue: true` in the Routine payload.

**Verification.**
- Fire a CRITICAL alert with a small backlog (<3 items) → Routine fires, Director dispatches one team, no autopilot continuation.
- Fire a CRITICAL alert with a large backlog (>=3 items) → Routine fires, Director dispatches, sentinel written, hero completes, autopilot fires, drains queue.
- Fire with `RALPH_AUTOPILOT_ENABLE` unset → sentinel is written but hero's check fails (gate held), no autopilot fires. Sentinel must still be cleaned up (consider a hook).

**Risks.**
- Sentinel cleanup is brittle. Use a hook (PostToolUse on Skill("ralph-hero:autopilot")) or a 5-minute TTL via `find -mmin +5 -delete` in a SessionStart hook.
- autopilot consumes more usage. Document the rate-limit consideration and recommend `RALPH_AUTOPILOT_MAX_RUNS_PER_DAY` env var (new) as a soft cap.
- Cross-machine drift: the sentinel is per-host (`$TMPDIR`). A Routine fires in the cloud; the sentinel must live there or be conveyed via the trigger payload. Re-evaluate during implementation — may need to push the `auto_continue` flag through Director into hero's args rather than via a filesystem sentinel.

**Closes.** No prior plan exists. Open GH issue when starting this phase.

---

## Cross-Cutting Concerns

### Telemetry

Every phase should leave a trace footprint visible in the local Langfuse harness when `RALPH_DEBUG=true` is set. Verification of each phase includes "check the trace contains the new span". This is the same convention as existing phases (per `CLAUDE.md` § "OpenTelemetry export").

### Rate limits and subscription usage

Phases 3, 4, 6 introduce calls into Anthropic's cloud (Routines + RemoteTrigger). Document the per-day usage projection in each phase's PR description so the user can decide whether to enable.

### Hook gate coverage

Phase 3 (RemoteTrigger → Director) and Phase 6 (autopilot via RemoteTrigger) **deliberately bypass** the `autopilot-enable-gate.sh` opt-in. This is correct — the gate is for the human-typed `/autopilot` entrypoint. RemoteTrigger paths require explicit Routine creation (a separate setup step) that serves the same opt-in purpose.

If we want belt-and-suspenders, add a new gate `remote-trigger-enable-gate.sh` matched on `Skill` calls from Director when `DISPATCH_REASON=RemoteTrigger`, gated on `RALPH_REMOTE_TRIGGER_ENABLE=true`. Defer to user preference during Phase 3 implementation.

### Documentation rollup

After Phase 4 (Routines) and Phase 5 (durable scheduling), update `plugin/ralph-hero/docs/unified-agent-system.md` with a new section "External Trigger Surfaces" enumerating: GitHub webhook → Routine, Cloud Monitoring → RemoteTrigger, ntfy + PushNotification dual-write, durable vs session-scoped scheduling.

## Sequencing and Dependencies

```
Phase 1 (Monitor in finish)         — independent, ship first
Phase 2 (PushNotification dual-write) — independent, can ship in parallel with Phase 1
   |
   v
Phase 2.5 (collapse ntfy to fallback) — depends on Phase 2 validated
Phase 3 (Critical-alert RemoteTrigger) — independent; can ship after Phase 1 or Phase 2
Phase 4 (PR-merged Routine)          — depends on Phase 3's Routine setup pattern documented
Phase 5 (Durable heartbeat)          — independent
Phase 6 (Autopilot via RemoteTrigger) — depends on Phase 3 (RemoteTrigger producer pattern) AND Phase 1 (Monitor in finish, so CI watch doesn't get caught in autopilot loops)
```

Minimum viable adoption: Phase 1 + Phase 2. These two close the "planned but not implemented" gaps and don't introduce new cloud usage. Everything beyond is opt-in expansion.

## Verification (end-to-end)

After all phases land:

1. **Trigger via iOS label**: GitHub mobile app adds `trigger:builders` to issue #N → Director picks up on next `/loop` tick → builders dispatches → ... → Done → `PushNotification` arrives on phone. (Existing path, unchanged.)
2. **Trigger via critical alert**: GCP alert fires CRITICAL → `monitoring-bridge` creates issue + fires Routine → Director receives RemoteTrigger payload → caretakers dispatches → ... → terminal state → `PushNotification`. (New: Phase 3 path.)
3. **Trigger via webhook**: Teammate merges a PR via UI → Routine fires → `PushNotification` + outcome mirror. (New: Phase 4 path.)
4. **Trigger via heartbeat**: Caretaker hygiene fires every 4 hours, surviving session restart. (Modified: Phase 5 path.)
5. **Auto-drain after critical alert**: CRITICAL alert + backlog >=3 → Director dispatches first issue → on completion, autopilot fires automatically → drains queue → terminal `PushNotification`. (New: Phase 6 path.)

Each path uses a **distinct trigger surface**. Together, they cover the four under-exploited primitives identified in the research doc.

## Open Questions (defer to implementation)

1. **Cloud Routines vs `launchd` for the same heartbeat.** Phase 5 picks one heartbeat (caretaker hygiene) for durable conversion. After validation, do we migrate the others (watcher, scout) or leave them session-scoped + `launchd`-backed? Decide based on Phase 5 user experience.
2. **Sentinel vs payload-passing for `auto_continue`** (Phase 6). Filesystem sentinel is host-local; payload-passing requires extending Director's interface. Pick during Phase 6 design.
3. **Per-Routine rate limit defaults.** Phase 3 and Phase 4 introduce Routines that can fire frequently (PR merges, CRITICAL alerts). Default to no cap and add as needed, or pre-set conservative caps?
4. **`PushNotification` failure modes.** Does the tool error if Remote Control is not paired? If yes, we need a try/catch shape that doesn't fail the parent skill. Verify during Phase 2.
