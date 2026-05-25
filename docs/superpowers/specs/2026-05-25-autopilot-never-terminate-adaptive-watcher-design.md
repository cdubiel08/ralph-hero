# Design: `/ralph:hero --auto --loop` as a never-terminating adaptive watcher

**Date:** 2026-05-25
**Status:** Implemented (slim `ralph:` plugin only; legacy `ralph-hero` + Director path treated as deprecated)
**Scope:** Core + slim-path stop-gate hardening
**Idle cadence:** Flat 1h (3600s) ceiling

## Problem

`/ralph:hero --auto --loop` was a **drain**: it looped via `/loop` dynamic mode
and **terminated** on `result: Queue empty.`, sleeping a clock delay between ticks
(60–270s after a dispatch, ~1200s idle). The user wants a **never-terminating
adaptive watcher** instead: tight cadence during bursts, back off to a 1h ceiling
when idle, never stop, run until cancelled via `/tasks`.

## Key findings

1. **`ScheduleWakeup` clamps to [60s, 3600s].** The user accepted a 1h max idle
   delay, so we stay on `/loop` (Approach C — cheapest). No background poller.

2. **Two copies of the hooks exist.** The slim `ralph:` plugin ships its own
   `ralph/hooks/scripts/autopilot-*.sh`; `/ralph:hero` resolves
   `${CLAUDE_PLUGIN_ROOT}` to `ralph/`, so those are the hooks that fire. The
   legacy `plugin/ralph-hero/hooks/scripts/` copies serve only the deprecated
   `ralph-hero:*` plugin and were left untouched.

3. **The slim hooks' `RALPH_SUBCOMMAND=auto` discriminator was a latent no-op.**
   `RALPH_SUBCOMMAND` is set by a plain `export` in the SKILL's Step 0, not via
   `set-skill-env`/`CLAUDE_ENV_FILE`. Per this repo's env model only
   `CLAUDE_ENV_FILE` writes persist across Bash/hook processes — so the slim
   enforcement hooks never fired for the auto path. This is the likely reason the
   loop behaved as purely prompt-governed (and thus felt time-based with no
   re-fire guarantee). The fix avoids `RALPH_SUBCOMMAND` entirely.

## Design

Reclassify `hero:auto` from a **drain** (stops on `Queue empty`) to a
**never-terminating adaptive watcher**. `Queue empty.` becomes an *idle backoff*
signal (3600s flat), not a stop. The loop ends only on `/tasks` cancellation.

Enforcement uses signals hooks can actually trust: `RALPH_COMMAND=hero` (set via
`CLAUDE_ENV_FILE` at SessionStart) plus the `Skill` tool payload. Two
session-scoped sentinels:

- **`ralph-hero-autoloop-<sid>`** — armed when the postcheck observes
  `Skill("loop", "…--mode classify…")` (the `--mode auto` launch; uniquely
  identifies the watcher vs. one-shot classify, default, or `--mode watch`).
  Gates the Stop hook so non-auto hero runs are never blocked.
- **`ralph-hero-pending-wakeup-<sid>`** — set on every tick that still owes a
  `ScheduleWakeup` (on the loop launch, and on either classify result line —
  `Dispatched #…` and `Queue empty.` both require one under never-terminate);
  cleared by the wakeup-clear hook when `ScheduleWakeup` fires.

Stop is blocked only when **both** sentinels are present (armed watcher + a tick
that didn't schedule its wakeup) → the silent-drop failure mode becomes a loud,
recoverable block instead of a dropped loop.

## Changes (all under `ralph/` — the slim plugin)

1. **`ralph/skills/shared/loop-wrapper.md`** — `hero:auto` manifest row: both
   result lines re-fire; no terminal sentinel; idle bucket 3600s flat. Heartbeat
   note lists `hero:auto` as never-terminate (adaptive cadence).
2. **`ralph/skills/hero/SKILL.md`** — `--mode auto` section rewritten: explicit
   never-terminate continuation rules (Dispatched → 60–270s; Queue empty → 3600s
   idle backoff, NOT terminal; every tick must `ScheduleWakeup`; cancel via
   `/tasks`).
3. **`ralph/CLAUDE.md`** — suitability-matrix `hero --mode auto` row + the
   ScheduleWakeup-rules paragraph updated to the never-terminate contract and the
   actual hook mechanism.
4. **`ralph/hooks/scripts/autopilot-director-postcheck.sh`** — key on
   `RALPH_COMMAND=hero`; arm `autoloop` from the `Skill("loop", …--mode classify…)`
   payload; mark `pending` for the launch and for both classify result lines
   (never-terminate).
5. **`ralph/hooks/scripts/autopilot-wakeup-clear.sh`** — key on
   `RALPH_COMMAND=hero`; clear `pending` on `ScheduleWakeup`; reject 300s; message
   references the 3600s ceiling.
6. **`ralph/hooks/scripts/autopilot-stop-gate.sh`** — key on `RALPH_COMMAND=hero`;
   block only when `autoloop` AND `pending` present; never-terminate message
   (cancel via `/tasks`); re-entry cleanup of both sentinels.
7. **`ralph/hooks/scripts/__tests__/autopilot-auto-watcher.test.sh`** — 22
   assertions across all three hooks (discriminator, arming, never-terminate
   pending on Queue empty, 300s reject, clear-on-wakeup, block/allow, re-entry).
   All pass.

## Risks / notes

- **Other slim hooks still gate on `RALPH_SUBCOMMAND`** (`hero-dispatch-log.sh`,
  `triage-no-skill-dispatch.sh`, `split-estimate-gate.sh`, `triage-state-gate.sh`).
  If finding #3 holds broadly, those gates may also be ineffective. Out of scope
  here; flagged for a follow-up audit. The auto-watcher fix is robust regardless
  of whether `RALPH_SUBCOMMAND` propagates.
- **Legacy `ralph-hero:autopilot` is untouched** and keeps its terminate-on-empty
  behavior via its own hook copies. Deprecated per the user.
- **No deterministic multi-tick proof.** Enforcement assumes `PostToolUse:Skill`
  fires for `Skill("loop")` and that `ScheduleWakeup` is the dynamic-mode wakeup
  mechanism (both well-established). If a future `/loop` re-fire re-runs classify
  without re-wrapping `Skill("loop")`, the persisted `autoloop` sentinel still
  holds and `pending` is still set from classify result lines.

## Out of scope

- Aligning the legacy `ralph-hero` plugin / Director path.
- A background poller / `Monitor` design (ruled out by the 1h-ceiling acceptance).
- Multi-hour idle ceilings (impossible within the `ScheduleWakeup` clamp).
- Broader `RALPH_SUBCOMMAND` propagation audit.
