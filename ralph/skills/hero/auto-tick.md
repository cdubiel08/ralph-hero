# `--mode auto` + Auto tick

Full contract for hero's autonomous watcher, split out of `SKILL.md` (which stays limited to dispatch + step skeletons per `ralph/CLAUDE.md`'s ~200-line convention). `SKILL.md`'s `## --mode auto` heading points here.

## `--mode auto`

Autonomous **never-terminating adaptive watcher** via `/loop` dynamic mode. This mode does NOT drain-and-stop: it loops until the user deliberately cancels via `/tasks`. While the queue has actionable work it re-fires on a tight cadence; when the queue is idle it backs off to a 1h ceiling and keeps watching, so new issues, merged-PR fallout, or `trigger:*` labels are picked up within at most an hour. Opt-in enforced by `autopilot-enable-gate.sh` — if `RALPH_AUTOPILOT_ENABLE != true`, the `Skill("loop", …)` call exits 2 with a deterministic message.

**`--loop [duration]` does not apply here.** `--mode auto` always self-loops once dispatched — it never checks `$ARGUMENTS` for a `--loop` flag — and its cadence is adaptive (60-270s busy / 3600s flat when idle), not a fixed interval. Any `--loop <duration>` token the caller passes alongside `--mode auto` (or `--auto`) is silently ignored; there is no override knob. The `[duration]` form of `--loop` is meaningful only for `--mode watch` (see its own section in `SKILL.md`), which does read `$ARGUMENTS` for an interval override.

Emit `Skill("loop", args="Run /ralph:hero --tick on the next-most-important event on the project queue\n\n<continuation prompt from loop-wrapper.md § Continuation-prompt template, hero:auto manifest row>")`. Fill `{INNER_COMMAND}` = `Run /ralph:hero --tick on the next-most-important event on the project queue`, `{PROGRESS_SENTINELS}` = `result: Dispatched #NNN to <team> via <entrypoint>` (the line the tick step emits on every successful dispatch — see step 6 of § Auto tick below). There are **no terminal sentinels** — this loop never ends on its own.

**Continuation rules (LOAD-BEARING):**
- `result: Dispatched #NNN …` → busy/burst → `ScheduleWakeup` 60-270s (warm-cache continuation; drains as fast as the queue produces work).
- `result: Queue empty.` → **idle, NOT terminal** → `ScheduleWakeup` **3600s flat** (the 1h ceiling), then re-check. Do NOT end the loop.
- **Every tick MUST call `ScheduleWakeup`** — there is no clean self-exit. `autopilot-stop-gate.sh` (keyed to `RALPH_COMMAND=hero`, armed once `Skill("loop", …/ralph:hero --tick…)` is observed) blocks session exit with a loud message if a tick returns without a wakeup. Never 300s (`autopilot-wakeup-clear.sh` rejects it). Cancel only via `/tasks` → delete the pending wakeup.

Do not maintain an iteration counter — `/loop` and the `--tick` step own that.

> **Use the `hero:auto` row, NOT `hero:default`.** `--mode auto` wraps the internal `--tick` step, whose result lines are `result: Dispatched #NNN …` and `result: Queue empty.` — not the `result: Hero complete …` / `result: Hero paused …` lines on the `hero:default` row. The `hero:auto` row treats BOTH tick result lines as re-fire signals (Dispatched → tight cadence, Queue empty → 1h idle backoff) so the watcher never falls through to a terminal stop.

## Auto tick (internal — dispatched only by --mode auto's loop wrapper)

Director-only step: classify one event, dispatch the correct verb, stop. Not a public mode — `--tick` appears in no mode table or argument-hint in `SKILL.md`; it exists only as the inner command `--mode auto`'s `/loop` wrapper re-issues on every cadence. Full taxonomy in [../shared/event-taxonomy.md](../shared/event-taxonomy.md).

1. **Parse + detect input source.** `--issue NNN` → `TARGET_ISSUE=NNN`, skip to step 3. `RemoteTrigger` tool input (deprecated) → extract `issue_number`+`team`, set `DISPATCH_REASON=RemoteTrigger`, skip to step 4. Otherwise → step 2.
2. **Read `next_actions({ audience: "agent" })`.** Empty queue → emit `result: Queue empty. No events to dispatch.` STOP. Pick top-ranked direction; resolve `TARGET_ISSUE` per [../shared/event-taxonomy.md](../shared/event-taxonomy.md) (kind rules). **Audience MUST be `agent` (not the `human` default):** this is the autonomous orchestrator path (and the engine of `--mode auto`), so it must get the XS/S estimate penalty (`audiencePenalty` in `directions.ts`) and the Backlog/null-state triage fallback (the agent-only `scored.length === 0` branch). With the human default, hero ranks XL like XS and idles on `Queue empty.` while Backlog has untriaged work. Sibling-file audit: `dispatch.md` and `watch-dispatch.md` have no other queue-read call sites.
3. **Fetch + classify.** `get_issue({ number: TARGET_ISSUE })`. Apply [../shared/event-taxonomy.md](../shared/event-taxonomy.md) priority order: `trigger:*` labels → **`blocked:*` labels (watcher routing)** → automation labels → `workflow_state`. Set `TEAM`, `ENTRYPOINT`, `DISPATCH_REASON`, `CONSUMED_LABEL`, and (for `blocked:*`) `DISPATCH_ARG`. For the `blocked:*` tier: a label prefix-matching `blocked:pr-` → `TEAM=caretakers`, `ENTRYPOINT=ralph:caretake`, `DISPATCH_ARG="--mode watch --kind pr"`, `DISPATCH_REASON=blocked:pr`, `CONSUMED_LABEL=none`; exact `blocked:upstream` → `DISPATCH_ARG="--mode watch --kind upstream"`, `DISPATCH_REASON=blocked:upstream`, `CONSUMED_LABEL=none`.
4. **Dispatch.** For the `blocked:*` tier, `Skill(ENTRYPOINT, args=DISPATCH_ARG)` — i.e. `Skill("ralph:caretake", args="--mode watch --kind pr")` or `Skill("ralph:caretake", args="--mode watch --kind upstream")`, a **board-wide watcher sweep** NOT scoped to `NNN` (the watcher mode ignores an issue arg). For all other tiers, `Skill(ENTRYPOINT, args="NNN")` (bare issue number). Unimplemented team (memorykeepers) → emit `needs input: team <name> not yet implemented; skipping dispatch.`
5. **Consume label.** If `CONSUMED_LABEL` set (only the `trigger:*` tier sets it): `save_issue({ number: TARGET_ISSUE, labels: ISSUE_LABELS minus CONSUMED_LABEL })`. The `blocked:*` tier (`CONSUMED_LABEL=none` — the watcher owns the label lifecycle), automation labels, and `RemoteTrigger` paths skip this step.
6. **Emit result marker:** `result: Dispatched #NNN to <team> via <entrypoint>. (reason: <DISPATCH_REASON>)`.
