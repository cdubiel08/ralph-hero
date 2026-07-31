# loop-wrapper.md — Shared `--loop` substrate for ralph slim plugin skills

Reference fragment. All seven `--loop`-capable verb SKILL.md bodies reference this file by pointer for the arg-parsing snippet, the continuation manifest, and the refusal message; none inlines a private copy.

---

## Arg-parsing snippet

Copy into Step 0 of each loop-suitable SKILL.md body. Detects `--loop [optional duration]`
anywhere in `$ARGUMENTS`, sets three variables, and leaves the rest of the args in `STRIPPED_ARGS`.

```bash
LOOP_RAW=""
LOOP_INTERVAL=""
STRIPPED_ARGS="$ARGUMENTS"
if [[ "$ARGUMENTS" =~ (^|[[:space:]])--loop([[:space:]]+([0-9]+[smhd][0-9smhd]*))?([[:space:]]|$) ]]; then
  LOOP_RAW="1"
  LOOP_INTERVAL="${BASH_REMATCH[3]}"
  STRIPPED_ARGS="$(echo "$ARGUMENTS" | sed -E 's/(^|[[:space:]])--loop([[:space:]]+[0-9]+[smhd][0-9smhd]*)?([[:space:]]|$)/\1/g' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
fi
```

Usage after the snippet:
- `[[ -n "${LOOP_RAW:-}" ]]` — true when `--loop` was present.
- `LOOP_INTERVAL` — the duration token (e.g. `5m`, `1h`); empty string for dynamic mode.
- `STRIPPED_ARGS` — `$ARGUMENTS` with `--loop [duration]` removed; pass this to the wrapped invocation.

---

## Continuation-rules manifest

One row per loop-suitable `skill:mode`. Heartbeat modes re-fire on a clock; drain modes stop on `Queue empty.`

| skill:mode | progress sentinels | terminal sentinels | delay buckets | notes |
|---|---|---|---|---|
| research:auto | `Research complete for #NNN` | `Queue empty.` | 60-270s on progress; 1200-1800s idle | drain Research Needed queue |
| plan:auto | `Plan complete for #NNN` | `Queue empty.` | 60-270s on progress; 1200-1800s idle | drain Ready for Plan queue |
| plan:review | `Plan reviewed for #NNN` / `PLAN AWAITING DECISION` | `Queue empty.` | 60-270s on progress; 1200-1800s idle | drain Plan in Review queue; AWAITING DECISION is progress (held plan), NOT terminal |
| impl:auto | `Phase N/M complete.` / `Implementation complete for #NNN` | `IMPL BLOCKED …` / `Queue empty.` | 60-270s on progress; 1200s on no-op | drain unlocked impl phases |
| impl:pr | `PR CREATED / …` | `Queue empty.` | 60-270s on progress; 1200-1800s idle | drain ready-for-PR queue |
| review:default | `FINISHED / …` / `FINISH BLOCKED — …` | `Queue empty.` | 60-270s on progress; 1200-1800s idle | drain In Review queue |
| review:val | `VALIDATION PASS / FIX / FAIL` | `Queue empty.` | 60-270s on progress; 1200-1800s idle | drain validation queue |
| review:code | `CODE REVIEW PASSED / ESCALATED` | `Queue empty.` | 60-270s on progress; 1200-1800s idle | drain code-review queue |
| review:merge | `MERGED / …` | `Queue empty.` | 60-270s on progress; 1200-1800s idle | drain mergeable queue |
| caretake:triage | `TRIAGED <verdict>` | `Queue empty.` | 60-270s on progress; 1200-1800s idle | drain Backlog |
| caretake:hygiene | `HYGIENE COMPLETE <N>` / `HYGIENE BLOCKED <reason>` | (none — heartbeat; re-fire always) | default interval 1h; 60-270s if changes made | periodic scan |
| caretake:watch | `WATCH-<KIND> ADVANCED <N>` | (none — heartbeat; re-fire always) | default interval 1h | sweeps pr/upstream/issue kinds; bare invocation runs all three serially |
| caretake:unblock | `UNBLOCK REQUEST POSTED` | `Queue empty.` | 60-270s on progress; 1200-1800s idle | drain Human Needed queue |
| caretake:all | (fan-out, no aggregated sentinel) | (none — heartbeat; re-fire always) | default interval 1h; schedule accordingly | periodic fan-out heartbeat |
| caretake:default-event | per dispatched mode | `Queue empty.` | 60-270s on progress; 1200-1800s idle | drain trigger:* labels (`--issue NNN`-scoped; the bare no-arg fan-out uses `caretake:all`) |
| catch-up:report | `Status update posted successfully.` | (none — heartbeat; re-fire always) | default interval 1d; schedule accordingly | periodic status post |
| hero:auto | `result: Dispatched #NNN to <team> via <entrypoint>` AND `result: Queue empty.` (both re-fire) | (none — never terminates; cancel via `/tasks`) | 60-270s on dispatch; **3600s flat** when the queue is idle / `Queue empty` | **NEVER-TERMINATING adaptive watcher** (not a drain). `--mode auto` wraps the internal `--tick` step; BOTH its result lines re-fire the loop. `result: Queue empty.` is an *idle backoff* signal (sleep at the 1h ceiling, then re-check), NOT a stop. Tight cadence during bursts, 1h floor when idle; runs until the user deletes the pending wakeup via `/tasks`. Re-fire is hook-enforced by `autopilot-stop-gate.sh` (keyed to `RALPH_COMMAND=hero`). |
| hero:watch | `result: Watch complete — …` | (none — heartbeat; re-fire always) | default interval 15m; schedule accordingly | polling heartbeat |

**Heartbeat vs. drain continuation rule**: heartbeat / never-terminate modes (caretake:hygiene, caretake:watch, caretake:all, catch-up:report, hero:watch, **hero:auto**) do NOT list `Queue empty.` as a terminal sentinel — they re-fire regardless of whether any work was found. All but hero:auto re-fire on a fixed clock; **hero:auto re-fires on an adaptive cadence** (tight during bursts, 3600s flat when idle). Drain modes DO list `Queue empty.` as the signal to end the loop.

---

## Continuation-prompt template

Paste this template into the `Skill("loop", args="…")` call in each SKILL.md's Step 0.
Replace `{INNER_COMMAND}`, `{PROGRESS_SENTINELS}`, `{TERMINAL_SENTINELS}`, and `{DELAY_BUCKETS}`
from the manifest row for the skill:mode being wrapped.

```js
Skill("loop", args="${LOOP_INTERVAL:+${LOOP_INTERVAL} }{INNER_COMMAND}

Continuation rules (LOAD-BEARING):
  Progress sentinels  — re-fire: {PROGRESS_SENTINELS}
  Terminal sentinels  — end loop, do NOT call ScheduleWakeup: {TERMINAL_SENTINELS}

Pick delays:
{DELAY_BUCKETS}
  NEVER 300s (cache-window anti-pattern — 5 min lands exactly at the prompt-cache
  expiry boundary; a new cache miss doubles token cost on every tick).

Trust the inner command's decisions. It handles queue selection, locking, and all
state transitions. Do not second-guess its result line or attempt to re-run work
it declared complete. Cancel the loop via /tasks → delete pending wakeup.")
```

**Worked example (impl:auto):**

```js
Skill("loop", args="Run /ralph:impl --mode auto ${STRIPPED_ARGS}

Continuation rules (LOAD-BEARING):
  Progress sentinels  — re-fire: Phase N/M complete. / Implementation complete for #NNN
  Terminal sentinels  — end loop, do NOT call ScheduleWakeup: IMPL BLOCKED … / Queue empty.

Pick delays:
  60-270s when impl made forward progress (stays in prompt cache)
  1200s when the queue has no unlocked phases (idle)
  NEVER 300s (cache-window anti-pattern — 5 min lands exactly at the prompt-cache
  expiry boundary; a new cache miss doubles token cost on every tick).

Trust the inner command's decisions. It handles queue selection, locking, and all
state transitions. Do not second-guess its result line or attempt to re-run work
it declared complete. Cancel the loop via /tasks → delete pending wakeup.")
```

---

## Refusal message

Copy into the unsuitable-mode branch of any SKILL.md that receives `--loop` on an
interactive or single-shot surface.

```bash
printf '%s\n' "--loop is not supported for this mode. Looping is meaningful only for autonomous queue-drainers; this surface is interactive. See ralph/CLAUDE.md § Loop suitability."
```

---

## Unsuitable surfaces

Single source (GH-1607) for every `--loop`-unsuitable skill:mode — interactive, single-shot, or single-artifact surfaces that emit the refusal message above rather than a manifest row. `ralph/CLAUDE.md § Loop suitability` points here instead of duplicating this list.

| Skill / Mode | Reason |
|---|---|
| `form` all modes | interactive picker |
| `plan` default | interactive phased plan creation |
| `plan --mode iterate` | single-plan surgical edit; interactive |
| `plan --mode epic` | single-epic decomposition |
| `impl` default | interactive; pauses between phases |
| `impl --mode address` | single PR feedback cycle |
| `research` default | interactive question intake |
| `catch-up` default | interactive orientation |
| `setup` all modes | one-shot bootstrap |
| `hero` default | one-shot orchestrator; refuses `--loop`. Use `--auto` → `--mode auto` for the autonomous drain |
| `hero --mode pr-drain` | single-PR action; loop would re-process same PR |
| `caretake --mode reflect` | single artifact per session |
| `caretake --mode unblock --question` | interactive answer collection |
