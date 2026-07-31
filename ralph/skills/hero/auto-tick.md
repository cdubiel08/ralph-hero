# Hero Auto tick — internal dispatch step

> Consulted by `/ralph:hero --mode auto`. **Not a public mode.** `--tick` appears in no mode table and no `argument-hint`; it exists only as the inner command that `--mode auto`'s `/loop` wrapper re-issues on every cadence. A human never types it.

Director-only step: classify one event, dispatch the correct verb, stop. Full event taxonomy in [../shared/event-taxonomy.md](../shared/event-taxonomy.md).

## Procedure

1. **Parse + detect input source.** `--issue NNN` → `TARGET_ISSUE=NNN`, skip to step 3. `RemoteTrigger` tool input (deprecated) → extract `issue_number`+`team`, set `DISPATCH_REASON=RemoteTrigger`, skip to step 4. Otherwise → step 2.

2. **Read the queue.**

   ```
   next_actions({ audience: "agent" })
   ```

   Empty queue → emit `result: Queue empty. No events to dispatch.` and STOP. Otherwise pick the top-ranked direction and resolve `TARGET_ISSUE` per [../shared/event-taxonomy.md](../shared/event-taxonomy.md) (kind rules).

   **Audience MUST be `agent`, not the `human` default.** This is the autonomous orchestrator path (and the engine of `--mode auto`), so it must get the XS/S estimate penalty (`audiencePenalty` in `directions.ts`) and the Backlog/null-state triage fallback (the agent-only `scored.length === 0` branch). Under the human default, hero ranks XL like XS and idles on `Queue empty.` while Backlog holds untriaged work — the GH-1479 regression. Guarded by `ralph/hooks/scripts/__tests__/hero-auto-tick-audience.test.sh`. Sibling-file audit: `dispatch.md` and `watch-dispatch.md` hold no other queue-read call sites.

3. **Fetch + classify.** `get_issue({ number: TARGET_ISSUE })`, then apply the [../shared/event-taxonomy.md](../shared/event-taxonomy.md) priority order:

   `trigger:*` labels → **`blocked:*` labels (watcher routing)** → automation labels → `workflow_state`

   Set `TEAM`, `ENTRYPOINT`, `DISPATCH_REASON`, `CONSUMED_LABEL`, and — for the `blocked:*` tier only — `DISPATCH_ARG`:

   | Label | TEAM | ENTRYPOINT | DISPATCH_ARG | DISPATCH_REASON | CONSUMED_LABEL |
   |---|---|---|---|---|---|
   | prefix `blocked:pr-` | caretakers | `ralph:caretake` | `--mode watch --kind pr` | `blocked:pr` | none |
   | exact `blocked:upstream` | caretakers | `ralph:caretake` | `--mode watch --kind upstream` | `blocked:upstream` | none |

4. **Dispatch.**
   - **`blocked:*` tier** → `Skill(ENTRYPOINT, args=DISPATCH_ARG)`. This is a **board-wide watcher sweep**, NOT scoped to `NNN` — the watch mode ignores an issue argument.
   - **All other tiers** → `Skill(ENTRYPOINT, args="NNN")` (bare issue number).
   - **Unimplemented team** (memorykeepers) → emit `needs input: team <name> not yet implemented; skipping dispatch.`

5. **Consume label.** Only the `trigger:*` tier sets `CONSUMED_LABEL`; when it is set, call `save_issue({ number: TARGET_ISSUE, labels: ISSUE_LABELS minus CONSUMED_LABEL })`. The `blocked:*` tier (`CONSUMED_LABEL=none` — the watcher owns that label's lifecycle), the automation-label tier, and the `RemoteTrigger` path all skip this step.

6. **Emit the result marker.**

   ```
   result: Dispatched #NNN to <team> via <entrypoint>. (reason: <DISPATCH_REASON>)
   ```

## Result lines

Both are re-fire signals for the `hero:auto` continuation row — neither is terminal:

| Line | Meaning | Wrapper response |
|---|---|---|
| `result: Dispatched #NNN to <team> via <entrypoint>.` | Productive tick | Tight cadence (60-270s) |
| `result: Queue empty. No events to dispatch.` | Idle, **not** done | 1h ceiling, keep watching |

Every tick owes a `ScheduleWakeup` — see [SKILL.md](SKILL.md) § --mode auto for the never-terminate contract and the four `autopilot-*` hooks that enforce it.
