# Claim-TTL vs pane-persistence probe — what a herdr server restart actually kills

- **Date**: 2026-08-11
- **Status**: probe complete — ran live on this machine (herdr 0.8.0, macOS, isolated `ralph-probe` session)
- **Question**: when the herdr server restarts, what survives — panes? the processes inside them? in-flight `pane wait-output` clients? — and what does that mean for the claim TTL and for unattended arming (`work-fleet --refill` default-on, tick-herdr autopilot)?
- **Predecessor**: [[2026-08-09-herdr-runtime-ralph-addon]] §5 flagged this as the outstanding step-2 spike ("lid-close/TTL probe has not run yet"); §4 flagged `wait` semantics under restart as "untested by us"
- **Probe script**: `plugin/ralph-herdr/scripts/probe-claim-ttl.sh` (re-runnable, idempotent, trap-cleaned)
- **Raw evidence**: probe output dir `/tmp/ralph-claim-ttl-probe-run2/` (per-step raw JSON, server logs, `summary.json`; run 1 at `...-run1/` caught two CLI-shape bugs, see §4)

## 1. Method

Everything ran inside an **isolated named session** (`ralph-probe`) with its own
headless server and socket — the user's default session was never touched
(verified before and after: `default` running, socket unchanged). No coding
agents were started; the pane occupant was a plain `/bin/sh` heartbeat loop.
Claim/ledger artifacts went to a **temp ledger** via `RALPH_HERDR_LEDGER`,
never `~/.ralph`.

Invocation model (discovered by probing, recorded here because the docs don't
spell it out):

- **Headless named server**: `herdr --session ralph-probe server`, backgrounded.
  The session appears in `herdr session list` with its own directory and socket
  (`~/.config/herdr/sessions/ralph-probe/herdr.sock`).
- **Scoped clients**: the same global flag routes every subcommand —
  `herdr --session ralph-probe pane list` — equivalently
  `HERDR_SOCKET_PATH=<that socket> herdr pane list`. Both verified.
- **Scoped stop**: `herdr --session ralph-probe server stop` stops only that
  session's server; `session list` then shows `ralph-probe stopped`,
  `default running`. Verified live before scripting anything.
- **"Session restore"** is not a verb: restarting the named server
  (`herdr --session ralph-probe server` again) reloads the session's persisted
  state from its session directory. That restart IS the restore path.

Sequence: start server → `workspace create` (w1, root pane w1:p1, cwd = temp
scratch) → `pane run` a heartbeat marker (`marker.sh`: writes its PID, appends
epoch seconds to `marker.beat` every 1s) → append a C7-flavored `spawn` record
via the real `ledger.sh` (`ralph_ledger_append`) + write a fake ClaimV2-shaped
`claim.json` (issue 9999, holder `probe-holder`, `ttl_min: 120`) → arm a
background `pane wait-output w1:p1 --match PROBE_NEVER_MATCHES --timeout 60000`
→ 2s later, scoped `server stop` → observe while down → restart → observe →
resolve the waiter → timings → trap cleanup (session stop + delete, scratch
removed, default session re-verified).

## 2. Raw observations (run 2, 2026-08-11T14:08Z)

| # | Observation | Evidence |
|---|---|---|
| 1 | Workspace/pane **topology survives** restart with the **same IDs** (`w1`, `w1:p1`) and the same cwd | `09-workspace-list-after.out`, `10-pane-list-after.out` |
| 2 | The **process inside the pane dies at `server stop`** — instantly, not at restore. Marker pid 83046 failed `kill -0` immediately after the stop confirmed (~115ms); heartbeat file stopped growing at the stop instant (3 → 3 lines over the 3s down-window) | `summary.json .marker`, `evidence-marker-beat.tail` |
| 3 | The restored pane holds a **fresh login shell** (shell_pid 82529 → 87367, foreground `-zsh` at prompt). Nothing re-runs the previous command | `04-` vs `11-process-info.out` |
| 4 | **Pane screen content is lost** too: pre-stop read shows `MARKER_START pid=83046`; post-restore read shows an empty fresh prompt (`experimental.pane_history` defaults to `false`) | `05-` vs `12-pane-read.out` |
| 5 | The in-flight **`pane wait-output --timeout 60000` errors cleanly the moment the server stops**: rc=1, `{"error":{"code":"server_unavailable","message":"server is shutting down"}}` after 2,080ms of its 60s budget. No hang, no run-to-timeout, **no resume** against the restarted server | `06-waiter.{out,meta}` |
| 6 | **Claim + ledger files are untouched** by the restart (as expected — they are plain files, server-independent). `ledger.jsonl` still one valid spawn record; `claim.json` intact, TTL notionally still ticking | `evidence-ledger.jsonl`, `evidence-claim.json` |
| 7 | **Timings**: cold server start → socket-ready 224ms; scoped stop 115ms; restart → restored-snapshot-ready **225ms**. Restore is effectively instant | `summary.json .timings_ms` |
| 8 | Scoped stop verified surgical: `default` session running with its own socket throughout, and after cleanup | `08-`, `13-session-list`, `post-cleanup-session-list.txt` |

### What was attempted and could NOT be tested

- **Agent-pane resume** (`[session] resume_agents_on_restore`, default on):
  requires starting a real claude/codex agent, which this probe must not do
  (billing). The config comment says it re-launches *supported integrations
  into their native conversation sessions* — a re-launch with history, not a
  continuation of in-flight work. Observation 3 shows plain processes get no
  resurrection at all; treat agent resume as **unverified**.
- **Literal lid-close**: the probe restarts the server process (the harsher,
  more conservative proxy covering crash/update/logout/reboot). A sleep/wake
  where the server process itself survives suspension was not separately
  staged; nothing in this probe contradicts processes surviving mere sleep.

## 3. Verdict

**The design's feared hazard is inverted.** §3.1's countermeasure (a) guards
against a pane *outliving* its claim (double-work). The probe shows a server
restart produces the opposite: the claim outlives the pane's *work* every
time. After any restart:

- pane restored, idle, fresh shell (looks alive in `pane list`);
- the `/ralph:work` process that held the claim is **dead**;
- the claim file/board state still shows the holder, TTL still ticking;
- any watcher/tick blocked in `wait-output` got a clean `server_unavailable`
  error and is no longer watching.

So the failure mode of unattended operation is a **stalled claim**: worker
dead in ~100ms, recovery gated on `RALPH_LOCK_TTL_MIN` (default 120 minutes)
— per issue in flight — with a restored-but-idle pane masquerading as a live
session to any topology-level health check.

Three specific confirmations the design can now rely on:

1. **`wait-output` fails fast and clean** — never hangs, never silently spans
   a restart. tick-herdr's existing "transport error ≠ timeout → leave claim
   to TTL, touch nothing" branch is exactly right, and a waiter loss is
   *detectable* (rc=1 + `server_unavailable`) rather than a wedge.
2. **Topology IDs are stable across restart** (same `w1:p1`), so ledger
   records keyed by pane_id stay resolvable after restore — but pane
   existence proves nothing about work liveness. Liveness checks must look at
   `pane process-info` (foreground processes), never `pane list`.
3. **Restore is ~225ms** — fast enough that a startup reconcile pass adds no
   meaningful latency.

### Go/no-go for unattended arming: **NO-GO** (unchanged gates), with a defined path to go

- **`work-fleet --refill` stays opt-in, off by default.** An armed run's
  watcher chain and its spawned sessions all die with the server; after
  restore nothing re-arms, the dead sessions' claims stall at TTL scale, and
  "unattended" means nobody is watching precisely when that happens. All
  three existing bounds (explicit `--refill`, `RALPH_HERDR_REFILL_TTL_MIN`
  arming decay, spawn budget) stay.
- **tick-herdr keeps both typed keys** (`autopilot` + `herdr_autopilot`).
  The pane-persistence premise of the transport is real but *topological
  only*; an unattended tick chain across a restart strands one claim per
  in-flight issue for up to the TTL.
- **Attended use is on solid ground** (the partial): scoped per-session
  servers, surgical stop, instant restore, fail-fast waiters — cockpit,
  `work-next`, and non-refill `work-fleet` need no new gates.
- **What flips it to go** (either is sufficient to revisit, both to flip):
  1. a **restart-aware reconcile at watcher/server startup** — the existing
     `reconcile.sh` surface extended to detect "open spawn record + restored
     pane with no matching foreground process" and release/refresh that claim
     immediately, cutting worst-case stall from `RALPH_LOCK_TTL_MIN` to
     seconds;
  2. a **live agent-resume verification** — one deliberate (attended, billed)
     run showing `resume_agents_on_restore` brings a claude pane back into
     its conversation such that prompting it resumes the issue; until then
     assume agent panes restore as *recoverable transcripts*, not workers.

## 4. Incidental findings (herdr 0.8.0 CLI)

Recorded because they cost the probe a run and will bite other scripts:

1. **Positional-first parsing for `pane read` / `pane wait-output`**: the
   printed usage is `pane read [OPTIONS] <PANE_ID>`, but value-carrying
   options before the positional are rejected (`pane read --lines 5 w1:p1` →
   `unknown option: 5`, rc=2; `--lines=5` form then rejects the pane id).
   `pane read w1:p1 --lines 5` works. Same for `wait-output`. Meanwhile
   `pane process-info --pane <id>` parses fine. Run-1 artifacts
   (`/tmp/ralph-claim-ttl-probe-run1/`) hold the raw failures.
2. **`herdr --session <name>` is a full client scope**: every subcommand
   accepts the global flag and routes to that session's socket — this is how
   a script talks to an isolated session without ever setting env. A bare
   `server stop` (unscoped) targets the *default* socket; scripts must never
   emit one.
3. **`session delete` requires stopped**; `session stop <name>` +
   `session delete <name>` is the correct by-name teardown and is idempotent
   enough for trap handlers.

## 5. Follow-ups

- File the restart-aware reconcile extension (§3 path-to-go item 1) as a
  board issue when this branch lands; it is the cheap half of the flip.
- The agent-resume verification (item 2) needs a deliberate attended session
  — pair it with the first real cockpit dogfooding run.
- README (`plugin/ralph-herdr/README.md` fleet-refill section) and
  `ralph/examples/tick-herdr.sh` header now cite this probe; gates unchanged.
