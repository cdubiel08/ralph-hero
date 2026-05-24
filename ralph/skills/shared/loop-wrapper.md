# loop-wrapper.md — Shared `--loop` substrate for ralph slim plugin skills

Reference fragment. SKILL.md bodies copy the snippets below; they do not source this file.

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
| plan:review | `Plan reviewed for #NNN` | `Queue empty.` | 60-270s on progress; 1200-1800s idle | drain Plan in Review queue |
| impl:auto | `Phase N/M complete.` / `Implementation complete for #NNN` | `IMPL BLOCKED …` / `Queue empty.` | 60-270s on progress; 1200s on no-op | drain unlocked impl phases |
| impl:pr | `PR CREATED / …` | `Queue empty.` | 60-270s on progress; 1200-1800s idle | drain ready-for-PR queue |
| review:default | `FINISHED / …` / `FINISH BLOCKED — …` | `Queue empty.` | 60-270s on progress; 1200-1800s idle | drain In Review queue |
| review:val | `VALIDATION PASS / FIX / FAIL` | `Queue empty.` | 60-270s on progress; 1200-1800s idle | drain validation queue |
| review:code | `CODE REVIEW PASSED / ESCALATED` | `Queue empty.` | 60-270s on progress; 1200-1800s idle | drain code-review queue |
| review:merge | `MERGED / …` | `Queue empty.` | 60-270s on progress; 1200-1800s idle | drain mergeable queue |
| caretake:triage | `TRIAGED <verdict>` | `Queue empty.` | 60-270s on progress; 1200-1800s idle | drain Backlog |
| caretake:hygiene | `HYGIENE COMPLETE <N>` / `HYGIENE BLOCKED <reason>` | (none — heartbeat; re-fire always) | default interval 1h; 60-270s if changes made | periodic scan |
| caretake:unblock | `UNBLOCK REQUEST POSTED` | `Queue empty.` | 60-270s on progress; 1200-1800s idle | drain Human Needed queue |
| caretake:trends | (markdown stdout is the deliverable) | (none — heartbeat; re-fire always) | default interval 6h; schedule accordingly | periodic snapshot |
| caretake:debug | `DEBUG FILED <N>` / `DEBUG SKIPPED <reason>` | `Queue empty.` | 60-270s on progress; 1200-1800s idle | drain Langfuse errors |
| caretake:split | `SPLIT <N>` / `SPLIT SKIPPED <reason>` | `Queue empty.` | 60-270s on progress; 1200-1800s idle | drain M/L/XL queue |
| caretake:all | (fan-out, no aggregated sentinel) | (none — heartbeat; re-fire always) | default interval 1h; schedule accordingly | periodic fan-out heartbeat |
| caretake:default-event | per dispatched mode | `Queue empty.` | 60-270s on progress; 1200-1800s idle | drain trigger:* labels |
| catch-up:report | `Status update posted successfully.` | (none — heartbeat; re-fire always) | default interval 1d; schedule accordingly | periodic status post |
| hero:default | `result: Hero complete — …` / `result: Hero paused at …` | `result: Queue empty.` | 60-270s on progress; 1200-1800s idle | drain top-ranked issues |
| hero:watch | `result: Watch complete — …` | (none — heartbeat; re-fire always) | default interval 15m; schedule accordingly | polling heartbeat |

**Heartbeat vs. drain continuation rule**: heartbeat modes (caretake:hygiene, caretake:trends, caretake:all, catch-up:report, hero:watch) do NOT list `Queue empty.` as a terminal sentinel — they re-fire on a clock regardless of whether any work was found. Drain modes DO list `Queue empty.` as the signal to end the loop.

---

## Continuation-prompt template

Paste this template into the `Skill("loop", args="…")` call in each SKILL.md's Step 0.
Replace `{INNER_COMMAND}`, `{PROGRESS_SENTINELS}`, `{TERMINAL_SENTINELS}`, and `{DELAY_BUCKETS}`
from the manifest row for the skill:mode being wrapped.

```
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

```
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
