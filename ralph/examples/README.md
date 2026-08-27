# Driving the lanes — transport recipes (copy and own)

ralph ships **capabilities with stable contracts** (typed selectors, gate tools, skills);
*how they are driven* is yours. A lane is a typed selector + a judgment skill + a goal.
Cadence is not configured anywhere — it is **derived per pass from what the queue is
blocked on**, and the skills are single-pass operators that end by reporting exactly what
a driver needs to pace or stop. Everything in this file is an example recipe, not a
harness ralph executes: copy it, edit it, own it. (Design axiom, GH-1712: scripts are
examples; contracts are doctrine.)

## The lanes and their goals

A lane's **goal** is its termination condition, typed against its selector. Every
transport — attended or not — stops (or sleeps long) when the goal holds:

| Lane | Selector | One pass does | Goal (stop condition) |
|---|---|---|---|
| work | `board next` | one Backlog item end-to-end (`/ralph:work`) | empty `next` — everything left is blocked, foreign, or Human Needed |
| deliver | `board deliver-queue` | one In Review item's follow-through (`/ralph:deliver`) | empty `next` **and** no time-bounded blocked row (`settling`, `retry-window`, `deferred`). Time-bounded rows don't stop the lane — they set the next wake to the earliest `windowExpiresAt`. Rows only a human can clear (`no-pr`, Human Needed) never keep it awake |
| tend | `board tend-queue` | a bounded hygiene batch (`/ralph:tend`) | one clean sweep — a pass with `checked>0, acted=0` and no new observations; re-entry is by accumulation, not polling |
| dispatch | `board brief` + fleet/lead state | exercise the standing authorities (`/ralph:dispatch`, or the deterministic rota below) | every authority reads quiet — nothing eligible to feed, all leads standing, the day's digest window closed |

**Pacing derivation**: each skill ends its pass reporting `checked`/`acted`, the
blocked-reason set, and the earliest window expiry. That report is the entire pacing
interface — a driver sleeps to the earliest expiry (clamped to whatever its scheduling
primitive allows), or stops when the goal holds. The skills never self-schedule.

## Transports (all equivalent against the same contracts)

| Transport | Surface | Coverage | Opt-in |
|---|---|---|---|
| Single pass | `/ralph:work`, `/ralph:deliver`, `/ralph:tend` invoked directly | attended | the invocation itself |
| Session loop, self-paced | `/loop /ralph:deliver` — the loop owns pacing; the lane's exit report tells it the delay or that the goal holds | attended (dies with the session) | typing `/loop` — explicit, per-session, per-lane |
| Session loop, fixed | `/loop 15m /ralph:deliver` | attended (same bounds) | same |
| Scheduled routine | a BRIDGE-env routine running the lane skill locally with plugins (cloud-only routines cannot load plugins) | unattended | config keys (below) |
| Scheduler script | `tick.sh` under launchd/cron via `install-loop.sh` — the work-lane example of this transport; for deliver/tend, copy the pattern and own it | unattended | config keys (below) |

**Honest caveats (keep these in whatever you build):**

- **Session loops die with their session** — window closed, Esc, or the loop's own cap.
  There is no parity claim with a scheduler; unattended coverage is exactly the last two
  rows.
- **The billing guard lives where a new process is spawned.** Routine prompts and
  scheduler scripts must refuse when `ANTHROPIC_API_KEY` is set unless
  `RALPH_ALLOW_API_BILLING=true` (tick.sh already does). A session transport cannot
  re-decide billing mid-session — an interactive session's billing mode was visible at
  start, which is the risk profile the guard exists for (headless spawns) not applying.
- **One driver per lane per board.** The per-item backstop is the real line (claim
  write + read-back in `board.ts`; quiescence + marker tuples + SHA-pinned merges for
  deliver; metadata-only writes for tend) — but two drivers on one lane buys you
  visible refusals, not throughput. Script transports additionally serialize on
  `$RALPH_HOME/tick.pid` exactly as before.

## Recipes

### Attended: one pass

```text
/ralph:deliver
```

That's it. The invocation is the opt-in; the pass report tells you whether another pass
is worth it and when.

### Attended: session loop

```text
/loop /ralph:deliver
```

Self-paced: the loop reads the pass report — sleeps to the earliest window expiry when
rows are time-bounded, stops when the lane's goal holds. `/loop 15m /ralph:deliver` is
the fixed-interval variant when you'd rather not trust derivation. Per-session,
per-lane, dies with the session — safety-relevant: **keep the loop reading the report's
goal state rather than looping unconditionally.**

### Unattended: BRIDGE-env routine (prompt template)

A scheduled routine that runs the lane skill locally with plugins loaded. Keep every
numbered step — 1 and 2 are the fail-closed opt-in and the billing guard:

```text
You are one scheduled pass of the ralph deliver lane on this machine.

1. Read $RALPH_HOME/config (default ~/.ralph/config — the same resolution
   tick.sh and the skills use). Unless BOTH `autopilot=true` AND
   `autopilot.deliver=true` are present, print "deliver: autopilot not enabled
   (fail closed)" and stop. The global key alone is never sufficient; the
   per-lane key alone is never sufficient.
2. If the environment has ANTHROPIC_API_KEY set and RALPH_ALLOW_API_BILLING is not
   "true", print "deliver: refusing to spawn on API billing" and stop.
3. Invoke /ralph:deliver with no argument. It runs one pass and exits at a surfaced
   state; its report names checked/acted and the earliest retry window.
4. Do not loop. This routine IS the cadence; the next fire is the next pass.
```

(The work lane stays single-key — `autopilot=true` — unchanged. Only deliver/tend take
the extra per-lane key.)

### Unattended: tend as an accumulation-fired routine

Tend's re-entry signal is accumulation, not a clock — a daily or twice-weekly routine is
plenty, and the clean-sweep goal makes extra fires cheap no-ops. Same skeleton as the
deliver routine (steps 1–2 verbatim with `autopilot.tend=true`), then:

```text
3. Invoke /ralph:tend with no argument. It works at most RALPH_TEND_BATCH (default 5)
   queue items and exits at a surfaced state; closures are only ever PROPOSED to
   Human Needed, so this routine needs no approval loop of its own.
4. If the pass reports a clean sweep (checked>0, acted=0, no observations pulled),
   nothing accumulated — the next fire is soon enough. Do not loop.
```

`RALPH_TEND_BATCH` is the per-session budget knob: raise it for a first-ever grooming
pass over a neglected backlog, keep the default for steady state.

### Unattended: scheduler script

`ralph/scripts/tick.sh` + `install-loop.sh` remain the worked example of this
transport for the work lane: flock/pidfile serialization, heartbeat, hard timeout,
per-issue logs, the billing guard, and idle-exit before spawning anything. A deliver or
tend equivalent is the same skeleton with the selector swapped (`deliver-queue` /
`tend-queue`) and the runner invoking the lane skill. ralph deliberately does not ship
those scripts — the moment it does, they stop being yours.

### Unattended: dispatch rota (GH-2184)

`dispatch-rota.sh` (this directory) is the worked example for the **dispatch lane**
— the scheduled half of decision 6 in the 2026-08-26 teams/dispatch/inbox design,
beside `/ralph:hero` as the attended half. Each pass is the DETERMINISTIC form of one
standing authority from `ralph/skills/dispatch/SKILL.md`, possible because every
standing authority carries a structural bound (a cap, a gate, idempotence); the
judgment form of the lane stays `/ralph:dispatch`, which the rota never replaces.
Three passes, named on the argv:

- **fleet** — feed the worker fleet: frontier non-empty + live workers under
  `RALPH_HERDR_FLEET` → fire the `work-fleet` plugin action (the action's own pane
  carries the watcher; the rota's lock is never held for a fleet's lifetime).
- **leads** — lead health: enumerate this repo's `team GH-N` workspaces (the durable
  evidence a team was stood up — a dead lead has no agent to enumerate) and re-run
  `work-team.sh N --lead-only` per epic; respawn is idempotent re-run by that
  script's own contract, and per-epic failures never starve the rest of the pass.
  **Opt-in (GH-2197)**: only a human running `work-team.sh` by hand ever creates a
  `team GH-N` workspace — no scheduled path does — so the pass is a permanent no-op
  until then. It is deliberately absent from the suggested cron lines below; add it
  to the frequent line only on a machine that actually runs teams.
- **digest** — inbox curation: `board inbox --digest` → push a Tier 2 notification
  when `pushWorthy`, then ALWAYS mark (an empty-inbox run still closes the day's
  window; the verdict is computed before the stamp write, so marking can never talk
  the rota out of a push it owed).

**Passes are named, never defaulted**, and that carries the "at most one push a day"
invariant: `pushWorthy` keys on `markedToday`, so a frequent rota that marked on
every fire would close the day's window on its first quiet run and suppress the one
push the day was owed. The digest rides its own daily line:

```text
*/30 8-18 * * *  cd /path/to/repo && bash ralph/examples/dispatch-rota.sh fleet
30 7 * * *       cd /path/to/repo && bash ralph/examples/dispatch-rota.sh digest
```

Arming is the same two-key fail-closed shape as deliver/tend: `autopilot=true` AND
`autopilot.dispatch=true` in `$RALPH_HOME/config`; the billing guard is verbatim
tick.sh (the fleet pass spawns sessions). A BRIDGE-env routine driving
`/ralph:dispatch` instead is the deliver-routine skeleton with the key swapped —
steps 1–2 verbatim with `autopilot.dispatch=true`, then one bare `/ralph:dispatch`
invocation, no loop.

Honest caveats: fleet/leads need herdr + the ralph-herdr plugin and refuse loudly
without them (digest needs only the board); the digest stamp is machine-local, so
two machines running rotas produce two pushes a day (the board stays the only shared
store); and the rota is **never load-bearing** — fleets, leads, and lanes all
function with it dead, so a missed fire costs latency, nothing else. Outcome lines
land in `$RALPH_HOME/dispatch.outcomes.log` under the proof-of-input convention
below.

## Proof-of-input outcome lines

Whatever the transport, every lane pass appends one line to
`$RALPH_HOME/<lane>.outcomes.log` and touches `$RALPH_HOME/<lane>.heartbeat` (the skills
do this at exit):

```text
2026-08-09T03:10:00Z deliver GH-1683 rc=0 checked=2 acted=1
```

A lane always logging `checked=0` is visibly dead, never silently green. When you copy
the scheduler skeleton, also log `skipped=lock` on lock skips — that is the contention
datum that tells you whether one machine's serialization is costing you passes.
(`tick.sh` today prints its skip loudly to its own log rather than emitting this token —
align the two when you copy it; the convention is yours to keep.) `board readiness`
reports the per-lane opt-in keys, heartbeat age, and outcomes log as informational
rows — recommendations, never gates.

## herdr transport

`tick-herdr.sh` (this directory) is the same scheduler-script contract as `tick.sh` with
the spawn swapped: the session runs in a persistent [herdr](https://herdr.dev/) pane that
survives the tick, the wait is bounded at the claim TTL (a wrap-up prompt, never a kill),
and the finished pane keeps the transcript. The optional cockpit — actions, lane panes,
blocked/done notifications — lives in `plugin/ralph-herdr/`; the design record and honest
limits (screen-detected `blocked`, the still-unprobed TTL/lid-close hazard) are in
`thoughts/shared/research/2026-08-09-herdr-runtime-ralph-addon.md`. The transport adds
one opt-in of its own: on top of the shared work-lane `autopilot=true` key,
`tick-herdr.sh` requires `herdr_autopilot=true` in `$RALPH_HOME/config`
(default `~/.ralph/config`; typed,
fail-closed) — a pane that outlives the tick is a different hazard class than a
kill-on-timeout tick, and an existing tick.sh arming must not silently extend to it
while the TTL/lid-close probe is unrun. Unattended deliver/tend drives still take the
two-key fail-closed opt-in above, and the billing guard still lives wherever the
process spawns.
