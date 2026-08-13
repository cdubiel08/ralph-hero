# Agent-pane resume across a herdr restart — is the restored pane a worker or a transcript?

- **Date**: 2026-08-13
- **Status**: probe complete — ran live on this machine (herdr 0.8.0, macOS, isolated `ralph-probe` session), 3 runs
- **Question**: `[session] resume_agents_on_restore` defaults ON and its config comment says it re-launches supported integrations *into their native conversation sessions*. After a server restart, does the restored agent pane hold a **worker** (in-flight work continues) or a **transcript** (a relaunched CLI idling at a prompt)?
- **Why it gates a design**: [[2026-08-11-claim-ttl-pane-persistence-probe]] §3 listed this as one of the two things that flip unattended arming, and it decides whether GH-1809's reconcile may release the board claim of a restart-killed worker. Releasing a claim out from under a genuinely resuming worker would be the double-work hazard the claim exists to prevent.
- **Predecessor**: the 2026-08-11 probe answered everything *except* this — it must not start a real agent, so agent resume stayed explicitly **unverified**.
- **Probe**: `plugin/ralph-herdr/scripts/probe-claim-ttl.sh --with-agent` (experiment D; the flag is the opt-in, and the default run is unchanged and still agent-free)
- **Raw evidence**: three output dirs, `probe-agent-resume{,-run2,-run3}/` — per-step raw JSON, `summary.json`, server logs. The decisive captures are quoted inline below because those dirs are session-scratch.

## 1. Method

Experiment D rides on the existing probe's proven isolation: an isolated named
session with its own headless server and socket, the step-1b gate that *proves*
`--session` routed somewhere other than the operator's server before any
mutating call, and by-name teardown. It adds a second workspace whose root pane
runs a **real `claude` agent** (`herdr agent start … --kind claude`), sends ONE
trivial prompt so there is a conversation for restore to resume, and after the
restart records five things separately:

| reading | what it can prove |
|---|---|
| `shell_pid` before/after | whether the **pane was rebuilt**, whatever now runs in it |
| foreground process list | whether a harness process exists in the restored pane at all |
| `agent list` | whether herdr still **registers** an agent there |
| `pane read` (`recent` + `visible`) | whether the **transcript** came back, and what is on screen |
| a 15s silence window | whether the pane emits anything **unprompted** — the only outside signal that separates a resumed worker from a resumed prompt |

Two billing/hygiene gates guard the flag: it refuses with `ANTHROPIC_API_KEY`
set (lib.sh's rule — that key bills credits, not the subscription), and it
refuses with `CLAUDE_CODE_CHILD_SESSION` / `CLAUDE_CODE_SESSION_ID` set, for the
reason run 1 discovered the hard way (§3, D4).

## 2. Raw observations (3 runs, 2026-08-13)

| # | Observation | Evidence |
|---|---|---|
| D1 | **The pane is rebuilt every time.** `shell_pid` changed across the restart in all three runs: 16323 → 73263, 34131 → 97246, 34963 → 70636 | `summary.json .agent_resume.shell_pid_{before,after}` |
| D2 | **The agent's `claude` process dies at `server stop`**, exactly like the plain-shell marker: `kill -0` on the captured claude pid fails while the server is down | `.agent_resume.process_alive_while_down = "no"` |
| D3 | **`resume_agents_on_restore` fires, and its mechanism is a shell re-launch.** The restored pane's fresh shell is fed a literal command line: `claude --resume <session-id>`. Captured verbatim, twice | `29-agent-pane-read-after.out` (quoted below) |
| D4 | **That resume FAILED in all three runs** — `No conversation found with session ID: …` — leaving a bare `zsh`, no registered agent, no transcript | `.agent_resume.{registered_after_restore,transcript_after_restore} = "no"`, `foreground_after = "zsh"` |
| D5 | **`agent prompt` delivered no keystrokes in the headless probe session.** herdr accepted it (`type: agent_prompted`, `agent_status` → `blocked`) but the `visible` screen held a clean, empty prompt — no typed text, no modal — and `revision` stayed 0 across the agent's whole life | `23-agent-prompt.out`, `24b-agent-visible.out`, `24c-agent-read.out` |
| D6 | **No unprompted output after restore** in any run (15s window, byte-identical pane reads) | `.agent_resume.unprompted_output_after_restore = "no"` |
| D7 | Timings reproduce the 2026-08-11 numbers: server ready ~220ms, scoped stop 655–696ms, restore ready ~220ms | `.timings_ms` |
| D8 | **Running the probe swept the operator's real ledger.** herdr fires the `[[startup]]` hook for EVERY server that starts — the isolated probe server included — so `reconcile.sh` ran against the real `~/.ralph` ledgers while asking a herdr that had never heard of any of those agents. Phase A marked **all five running workers** `lost` in one pass (21:42:09Z), including the session writing this document | `~/.ralph/cdubiel08/ralph-hero/ledger.jsonl` |

The restored agent pane, run 2 (`pane read`, verbatim — this is the whole finding):

```text
claude --resume 13399c49-11a1-404c-b87b-2167dd632afb

 …/T/ralph-claim-ttl-scratch.iPHbax ❯ claude --resume 13399c49-11a1-404c-b87b-2167dd632afb
No conversation found with session ID:
13399c49-11a1-404c-b87b-2167dd632afb

 …/T/ralph-claim-ttl-scratch.iPHbax ❯
```

### Why the resume had nothing to resume — two different causes

- **Run 1**: the probe server inherited `CLAUDE_CODE_CHILD_SESSION` from the
  Claude Code session that launched it, so the pane's claude ran with
  *"Transcript saving is off"*. No transcript, so `--resume` cannot find one.
  This is a property of the launching shell, not of restore, and it would have
  been recorded as a restore finding — so the probe now **refuses** to run with
  that variable set and names the `env -u …` fix.
- **Runs 2–3** (clean env): no conversation ever existed, because D5's prompt
  never reached the TUI. The failure is honest but it is the probe's, not
  restore's.

So a *successful* resume was never observed. §3 says what that does and does
not cost the verdict.

## 3. Verdict

**A restored agent pane is never a worker.**

The direct evidence is the command line itself. Restore does not migrate a
process or re-issue a turn; it types `claude --resume <id>` into a brand-new
shell. That invocation starts an **interactive CLI at a prompt** — it carries no
`-p`, no prompt argument, nothing that could re-issue the `/ralph:work` turn the
dead process was in the middle of. The best case restore can produce is a
conversation someone can pick up. The observed case is worse: a bare shell.

Three consequences the design can rely on:

1. **`shell_pid` is a sound restart detector.** It changed in 3/3 runs, and it
   changes *whatever* restore manages to put in the pane — a relaunched claude,
   a failed relaunch, or nothing. A liveness check that looks for a harness
   process would be fooled by a successful resume (the transcript case);
   `shell_pid` is not. This is why GH-1809's reconcile keys on it.
2. **Releasing a restart-killed worker's claim is correct, and needs no extra
   "is it idle?" condition.** There is no state in which the restored pane is
   still doing the work.
3. **A restored pane that *looks* healthy can be empty.** `pane list` shows it,
   topology IDs match, and in the observed case there is not even an agent
   registered. Any health check above `pane process-info` is decoration.
4. **Absence is never evidence — D8 is the reason.** The probe's own
   side effect proved that a reconcile pass can be pointed at a server that
   knows nothing about the agents it is judging, and every "it isn't there"
   signal then reads as death: an empty herd, an empty pane list, a
   `pane_not_found`. So GH-1809's claim release rests only on a POSITIVE
   reading — the pane exists AND its shell pid matches what the ledger recorded
   at spawn — and phase A's `lost` verdict, which is an absence, deliberately
   does not release anything. Without D8 this would have shipped keyed on
   `pane_not_found`, and the first probe run after it would have released five
   working agents' claims at once.

**Honest limit**: the claim "even a *successful* resume is only a transcript"
rests on the semantics of the captured `claude --resume` command line, not on a
directly observed successful resume. Both harden the same direction — the
observed failure is strictly worse for liveness than the unobserved success —
so no design decision here is waiting on it. Closing it needs an attended run
where a conversation is created **by hand** in the probe pane (D5 blocks the
scripted path).

### The unattended-arming gate

**Both flip conditions from the 2026-08-11 probe are now satisfied**, so the
gates can be revisited — but see the residual below.

- Condition 1, *restart-aware reconcile*: delivered in GH-1809. Worst-case claim
  stall drops from `RALPH_LOCK_TTL_MIN` (120 min) to one reconcile interval.
- Condition 2, *live agent-resume verification*: this probe. The answer is the
  conservative one the design was already assuming, so it removes an unknown
  rather than granting a capability.

**Residual, and it is the real one**: recovery is now fast, but **nothing
re-arms**. After a restart the claim is released within a reconcile pass and the
issue returns to Backlog — correct and observable, and enough to make an
unattended chain *safe*. It does not make it *productive*: the work does not
resume, it re-queues, and something must be running to pick it up. D5 adds a
second constraint — a headless session cannot be driven by `agent prompt` at
all, so an unattended re-arm cannot simply re-prompt the restored pane; it must
spawn afresh.

Recommendation: **keep both typed autopilot keys fail-closed** (`autopilot` +
`herdr_autopilot`), and keep `work-fleet --refill` opt-in. What changed is the
*reason*. It is no longer "a restart strands a claim for two hours" — that is
fixed and tested. It is "a restart silently empties the fleet, and nothing
refills it." That is a smaller, better-shaped problem than the one the gates
were originally holding, and it is the next issue, not this one.

## 4. Incidental findings (herdr 0.8.0)

1. **`agent prompt` is accepted but inert in a headless session** (D5) —
   `agent_prompted` is returned, `agent_status` moves to `blocked`, and no
   keystrokes arrive. Every scripted agent-driving path in this plugin runs in
   the operator's attended session, where prompting demonstrably works, so this
   bounds *probes and headless automation*, not the cockpit. Not investigated
   further: it is a herdr-side question and this issue did not need the answer.
2. **`pane read` defaults to `recent` (scrollback), not the screen.** A modal
   dialog appears only under `--source visible`. Run 2's "empty prompt" reading
   could not distinguish "nothing typed" from "a dialog covering it" until run 3
   captured `visible` — worth knowing for any TUI assertion.
3. **`agent list` omits `agent_session` until the agent has a conversation**,
   while herdr nonetheless holds a session id it will later pass to `--resume`
   (the id in the restored pane's command line was never reported by
   `agent list`). Do not treat that field's absence as "no session".

## 5. Follow-ups

- File the **re-arm after restart** gap as its own issue (§3 residual): a
  restart empties the fleet, reconcile releases the claims, nothing re-spawns.
  That is what stands between here and unattended arming.
- File **D8** as its own issue: `reconcile.sh` runs from the `[[startup]]` hook
  of ANY server and sweeps every ledger under `~/.ralph` regardless of which
  server it is talking to. GH-1809 makes it harmless for board writes, but
  phase A still writes false `exit reason=lost` records for live agents (they
  are re-discovered on the next real pass, so the ledger self-heals — it is
  noise, not corruption). The fix belongs with the hook's scoping, not with
  the claim recovery.
- Closing D5 / observing a successful resume needs an attended run with a
  hand-typed conversation; low value, since the verdict does not turn on it.
