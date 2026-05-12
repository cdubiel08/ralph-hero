---
type: eval-scenarios
skill: autopilot
date: 2026-05-10
status: defined
---

# Autopilot Eval Scenarios

Scenarios used to grade `/ralph-hero:autopilot` after the redesign as a thin wrapper around `/loop /ralph-hero:hero`. The skill itself owns very little behavior — opt-in gating (via hook) and the dispatch prompt to `/loop`. Most queue-management and wakeup logic lives in `/loop` (dynamic mode, model self-paces) and `/ralph-hero:hero` (per-issue state machine including escalation). These scenarios verify the wrapper's contract, not `/loop` or hero internals.

> **Architecture note**: autopilot dispatches `/loop` with a hero-driver prompt. `/loop` dynamic mode self-paces via `ScheduleWakeup` — the model picks delays based on the prior outcome. Hero owns escalation; when it moves an issue to `Human Needed`, the next iteration's queue filter excludes that issue and the loop continues with the next candidate. Termination is naturally "filtered queue is empty → don't `ScheduleWakeup` → loop ends."

---

## Scenario 1: Opt-in unset → blocked deterministically

### Input

- **Env**: `RALPH_AUTOPILOT_ENABLE` unset (or any value other than `"true"`)
- **Invocation**: `/ralph-hero:autopilot`

### Expected

1. SessionStart hook sets `RALPH_COMMAND=autopilot`.
2. Skill body attempts `Skill("loop", args="...")`.
3. PreToolUse:Skill `autopilot-enable-gate.sh` fires, sees `RALPH_AUTOPILOT_ENABLE != "true"`, exits 2 with the deterministic message.
4. The `Skill` call is blocked. No `/loop` invocation. No hero dispatch.

### Assertions

- [ ] Stderr contains `"Autopilot is opt-in"` and `"export RALPH_AUTOPILOT_ENABLE=true"`
- [ ] No `Skill("loop", ...)` invocation observed
- [ ] No `Skill("ralph-hero:hero", ...)` invocation
- [ ] Message is byte-for-byte the hook's stderr — no LLM paraphrase

---

## Scenario 2: Opt-in set, queue empty → /loop ends after one iteration

### Input

A test project with **zero** issues outside `Done` / `Canceled` / `Human Needed`.

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`
- **Invocation**: `/ralph-hero:autopilot`

### Expected

1. Hook passes silently (env var is `"true"`).
2. Skill dispatches `Skill("loop", args="...")` with the hero-driver prompt.
3. `/loop` runs the prompt: model calls `list_issues({})`, applies the filter, gets 0 candidates.
4. Model decides: queue empty → return WITHOUT calling `ScheduleWakeup`. `/loop` ends.
5. No hero dispatch.

### Assertions

- [ ] Hook stderr is empty (silent on success)
- [ ] One `Skill("loop", ...)` call
- [ ] Zero `Skill("ralph-hero:hero", ...)` calls
- [ ] Zero `ScheduleWakeup` calls

---

## Scenario 3: Single XS issue, interactive review mode → drains to in-review and stops

### Input

One XS issue in `Ready for Plan`. Two non-actionable issues (already `Done`).

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`, `RALPH_REVIEW_MODE` unset (defaults `interactive`)
- **Invocation**: `/ralph-hero:autopilot`

### Expected

1. Hook passes.
2. `/loop` iteration 1: model picks the XS issue, dispatches hero. Hero lands a PR. Issue → `In Review`. Model calls `ScheduleWakeup` (delay in 60-270s warm range since fresh work likely).
3. `/loop` iteration 2: model re-checks queue. The `In Review` issue is still in the filter (not `Done`/`Canceled`/`Human Needed`), so it's eligible. Model dispatches hero again. Hero in interactive mode no-ops (PR awaiting human merge). Model decides: same issue can't progress without a human, queue has nothing else → end loop.

### Assertions

- [ ] One `pr_landed`-equivalent state transition (`Ready for Plan` → `In Review`)
- [ ] One open PR exists on the issue
- [ ] `/loop` ends naturally; no infinite loop on the in-review issue
- [ ] No `Human Needed` escalation
- [ ] No autopilot-emitted `ScheduleWakeup(delaySeconds=300)` (cache-window anti-pattern)

> **Note**: with `RALPH_REVIEW_MODE=auto`, hero would drive the in-review issue to `Done` instead of looping back; see Scenario 5.

---

## Scenario 4: Hero escalates one issue → loop continues with next

### Input

Two issues. First is straightforward XS in `Ready for Plan`. Second triggers hero's escalation path (e.g., conflicting acceptance criteria) and ends in `Human Needed`.

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`
- **Invocation**: `/ralph-hero:autopilot`

### Expected

1. `/loop` iteration 1: pick first issue, hero lands PR → `In Review`. Schedule next iteration.
2. `/loop` iteration 2: pick second issue, hero escalates → `Human Needed`. Model sees the issue is now filtered out of the queue. Schedule next iteration to check what's left.
3. `/loop` iteration 3: queue is empty (issue 1 in-review still eligible but hero no-ops; OR issue 1 done if auto mode). Eventually queue drains. Loop ends.

### Assertions

- [ ] Escalating one issue does NOT terminate the loop — autopilot/loop continues
- [ ] Second issue's final state is `Human Needed`
- [ ] First issue still in `In Review` (interactive) or `Done` (auto)
- [ ] No autopilot-emitted Human Needed transitions (only hero may move issues to Human Needed; the worktree-collision case is now hero/impl's job via `impl-worktree-gate.sh`)

---

## Scenario 5: Three XS issues, auto mode → drains to Done

### Input

Three XS issues in actionable states. CI configured to pass.

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`, `RALPH_REVIEW_MODE=auto`
- **Invocation**: `/ralph-hero:autopilot`

### Expected

1. `/loop` iterates: each iteration picks an XS issue, hero lands PR + runs code review + merges → `Done`.
2. After all three are `Done`, queue filter yields 0 candidates. Model omits `ScheduleWakeup`. Loop ends.

### Assertions

- [ ] All three issues end in `Done`
- [ ] Three PRs merged
- [ ] No `Human Needed` escalations
- [ ] Loop ends cleanly without manual cancellation

---

## Scenario 6: Cache-window discipline (delay-300 anti-pattern)

### Input

Any state where `/loop` is choosing a delay. Observe `ScheduleWakeup` calls.

### Expected

The model is instructed (via the autopilot dispatch prompt) to avoid `delaySeconds=300`. `/loop`'s runtime also clamps and warns. Confirm no observed `ScheduleWakeup(delaySeconds=300)`.

### Assertions

- [ ] Across all autopilot-driven `ScheduleWakeup` calls in any prior scenario, no value of `300` is observed
- [ ] Delays cluster around `60-270` (warm cache continuation) or `1200-1800` (idle)

---

## What's NOT covered (and why)

- **State-machine internals, audit log shape, cooldown math**: removed in the redesign. Autopilot doesn't maintain its own state. Anything that used to live in `~/.ralph-hero/autopilot.jsonl` either now lives in `/loop`'s session state or is unrecorded. If tooling needs per-tick forensics, that's a separate concern from autopilot.
- **`--max-iterations`, `--auto-merge`, `--state`, `--dry-run`**: all removed. Cap behavior is `/loop`'s; review mode comes from `RALPH_REVIEW_MODE`; cross-tick state is `/loop`'s; dry-run is just "don't invoke autopilot."
- **Worktree-collision safety**: hero's responsibility via `impl-worktree-gate.sh`. Autopilot does not duplicate.
