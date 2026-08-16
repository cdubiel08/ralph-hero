# Live restart probe — does reconcile phase F re-arm a real fleet?

- **Date**: 2026-08-15
- **Status**: probe complete — ran live on this machine (herdr 0.8.0, macOS, isolated named sessions), 5 restarts across 2 sessions, one with a real `claude` agent
- **Issue**: GH-1900. Predecessors: [[2026-08-13-agent-pane-resume-probe]], [[2026-08-11-claim-ttl-pane-persistence-probe]]
- **Questions**: (1) does `session.snapshot` answer by the time the `[[startup]]` hook runs, or does the pass abort before phase F? (2) do restart-rebuilt panes re-register their agents in `agent list`, making `RALPH_HERDR_REFILL_EXCLUDE` load-bearing rather than inert?
- **Why it gates**: these are the last two facts holding the typed autopilot keys (`autopilot` + `herdr_autopilot`) and `work-fleet --refill` default-on. Both failure modes make re-arming silently not happen — an evidence gate, not a safety one.

## Verdict

**Both assumptions phase F makes are correct. Neither failure mode occurred.**

1. **The snapshot answers.** In 4 of 4 restarts the startup hook ran reconcile to completion, exit 0, with a successful snapshot read. Phase F is reached. **But it wins by ~30ms of margin, not by construction** — see §2, and the code change that follows from it.
2. **Rebuilt panes stay registered.** After a restart that demonstrably replaced the pane's process, `agent list` still answered for the agent, immediately and 12s later. `RALPH_HERDR_REFILL_EXCLUDE` is load-bearing exactly as documented, and for the documented reason.

A third result fell out, and it is the one that most changes practice: **phase F's decisions were, until this issue, effectively unreadable in production** (§4).

## 1. Method, and why not the live cockpit

The obvious experiment — restart the operator's cockpit — was rejected. At the
time of the probe `herdr agent list` held 11 agents, four of them in-flight
ralph drivers (GH-1844, GH-1804, GH-1750, and the session running this probe).
Restarting would have killed all four, and the observer with them: the session
that must read the result is one of the processes the restart destroys.

Instead, every run used an **isolated named session** (`herdr --session <name>`,
own socket under `~/.config/herdr/sessions/<name>/`), which is a genuinely real
restart of a genuinely real server — the two questions are properties of the
server and of herdr's restore path, not of which fleet happens to be loaded.

One safety gap had to be closed first. Predecessor finding **D8**: herdr fires
the `[[startup]]` hook for *every* server that starts, so on 2026-08-13 the
probe's own server ran reconcile against the operator's real `~/.ralph` ledgers
and marked all five running workers `lost` in one pass. `probe-claim-ttl.sh` set
`RALPH_HERDR_LEDGER` (its own write target) but never `RALPH_HERDR_LEDGER_ROOT`,
which is what actually bounds the hook's walk. This probe exports the root
before either server launches, so the hook has nothing of the operator's to
find. GH-1863 and #1905 have since added ownership gates that should refuse the
sweep anyway — and appear to have done so, see §5 — but a probe running beside
four live drivers may not rest its safety on a gate holding.

**Post-condition, verified**: 11 live agents before and after every run, and the
real ledger's last entries are still the original spawns, with no `lost` events.

## 2. Q1 — the snapshot answers, on a thin margin

Four restarts of a 4-workspace session, timing measured from the moment the
server process was launched (T0):

| restart | API answers an external client | hook starts | hook duration | exit | outcome |
|---|---|---|---|---|---|
| cold start | T0+122ms | — | 117ms | 0 | `reconcile complete` |
| 1 | T0+78ms | T0+45ms | 138ms | 0 | `reconcile complete` |
| 2 | T0+74ms | T0+48ms | 128ms | 0 | `reconcile complete` |
| 3 | T0+78ms | T0+49ms | 129ms | 0 | `reconcile complete` |

Not one pass logged `herdr snapshot failed — not reconciling`. Phase F is
reached on every restart.

**The margin is the finding, though.** The hook *starts* at ~T+47ms, while the
API only answers an external client at ~T+76ms — herdr launches the startup hook
**into the readiness window**. The snapshot read succeeded only because sourcing
reconcile.sh's libraries costs more than the ~30ms of slack. That is a race won
by accident of startup cost, and it was measured on an **idle 4-pane session**.
The cockpit this has to survive restores ten workspaces and eleven agents, where
restore is heavier and the margin is unmeasured.

Losing that race is uniquely expensive here, which is why margin is not good
enough. Every other unknown in reconcile fails closed and is re-asked by the
next pass. Phase F has no next pass: refill is edge-triggered from a session
exiting, a restart destroys the listeners that would emit that edge, and nothing
else schedules a reconcile. An aborted startup pass means the fleet silently
stays un-rearmed until its arming expires.

**Change made** (`reconcile.sh`): a bounded retry — up to
`RALPH_HERDR_SNAPSHOT_WAIT_MS` (3000) at 100ms — around the existing snapshot
read. It is a *wait*, not a re-run of the pass: the covered failure is a server
that is not answering **yet**, and re-running whole phases could act twice. The
abort itself is unchanged; a genuinely sick server is still refused, one second
later, and the refusal now names how long it waited. Critically the retry
**reuses its own read** rather than probing first — a throwaway readiness call
would make every healthy pass cost two snapshots instead of one, and
`reconcile-cost.test.sh` pins that count deliberately.

## 3. Q2 — rebuilt panes keep their `agent list` registration

The predecessor could not settle this: its agent never had a transcript to
resume (D4/D5), so `registered_after_restore` read `no` for a reason that was
the probe's, not restore's. Seeding the pane's agent with a **positional
prompt** (`herdr agent start … -- "reply with exactly: OK"`) instead of relying
on `agent prompt` — the call that delivered no keystrokes in a headless session
— produced a real conversation, and with it the first **successful** resume
anyone has observed here.

| reading | before restart | after restart |
|---|---|---|
| `agent list` name/status | `w9999-q2probe` / idle | `w9999-q2probe` / idle — **present at t+0s**, i.e. as soon as the API answered |
| `agent_session.value` | `be665535-…` | `be665535-…` (same id, back by t+12s) |
| pane screen | the prompt and `⏺ OK` | same transcript restored |
| OS process | `claude "reply with exactly: OK"` | **gone**; replaced by pid 7750 `claude --resume be665535-…`, started at the restart |

The process table is the decisive column: the original agent process does not
survive, and the pane is re-driven by a freshly-launched `claude --resume`. So
**the pane was rebuilt and herdr still answers `agent list` for it.**

That is precisely the illusion phase F's exclusion exists to defeat. Without
`RALPH_HERDR_REFILL_EXCLUDE`, the capacity check would count these
restart-killed workers as live and spawn nothing. The exclusion is load-bearing,
and the reason recorded in the code is the true reason — not a coincidence.

**It also strengthens the predecessor's verdict rather than qualifying it.** A
restored pane is still not a worker *even when the resume succeeds*: what comes
back is an interactive CLI at a prompt holding the transcript, idle. The 2026-08-13
verdict was reached under a failed resume and could fairly have been called
untested at the case that matters; it is now tested at that case, and it holds.

## 4. What the probe found by accident — phase F was unreadable

`reconcile.sh` logged only to stdout. Run by hand that is a terminal; run as the
`[[startup]]` hook — its only automatic invocation, and the one phase F exists
for — herdr captures the output into **`herdr plugin log list`**, an in-memory
ring buffer on the live server.

A ring buffer is not a record. The live server's buffer holds 1600+ entries,
essentially all of them routine `watch-event.sh` fires from pane status changes;
a restart's single startup entry is evicted within minutes of the restart it
describes. Measured: **zero `reconcile:` lines** recoverable from the live
server, which has been up since 2026-08-09. So every decision a restart pass
made — including whether phase F re-armed, or whether the pass aborted before
reaching it — was written and then discarded.

This is why GH-1900 could not simply be answered by reading a log after a
restart, and it would have made a live cockpit restart nearly worthless as an
experiment.

**Changes made**: `log()` now appends to a durable file
(`$(ledger_root)/logs/reconcile.log`, override `RALPH_HERDR_RECONCILE_LOG`),
failing **open** — an unwritable log costs observability, never work, and must
never do to a pass what a sick server does. And the pass now announces itself
*before* the first read that can abort it, because "the hook never fired" and
"the hook fired and found an unready server" are opposite diagnoses with
opposite remedies, and without that line both render as an empty log.

`probe-claim-ttl.sh` additionally copies the probe session's server log out
before teardown deletes it with the session.

## 5. Was D8 fixed?

Indirect evidence says yes. In the isolated runs the hook fired against a
scratch ledger root containing one open record for a pane that did not exist in
that session — the exact shape that produced D8's five false `lost` marks — and
the ledger was **not written**. Under GH-1863's pane-proved ownership that is
the correct refusal.

Stated as the limit it is: this probe **bounded the hazard rather than
re-testing it**, because the isolation went in first. It is consistent with the
gates working; it is not a controlled test of them. A deliberate D8 re-test
against a scratch root is cheap and worth filing separately.

## 6. What this does and does not settle for the autopilot keys

Settled, with live evidence: phase F is reached after a restart, and its
capacity math rests on a true premise.

Not settled by this probe, and honestly the reason to keep a human in the loop
for one more cycle:

- Everything here was measured on an **isolated 4-pane session**, never on the
  11-agent cockpit. The readiness margin in §2 is the specific number that could
  invert at that scale — which the code change now covers, but which has not
  been observed at scale.
- **No spawn was ever exercised.** Arming a real fleet in the probe session would
  have spawned real drivers onto real board issues, which is out of scope for a
  probe. Phase F's spawn path remains covered by the 24 replay rows in
  `fleet.test.sh` §7 and by nothing live.
- The in-flight-marker subtraction question the issue raised third — whether
  newly spawned refill agents appear in `agent list` fast enough to be subtracted
  rather than aging out over the full 10 minutes — **was not measured**, for the
  same reason: it requires a real spawn.

**Recommendation**: lift nothing yet on this evidence alone. What has changed is
that a live cockpit restart is now *worth performing* — with the durable
reconcile log in place, one ordinary restart at a quiet moment produces a
readable record of exactly what phase F did at real scale, which is the missing
observation. Before this, that restart would have produced no record at all.
