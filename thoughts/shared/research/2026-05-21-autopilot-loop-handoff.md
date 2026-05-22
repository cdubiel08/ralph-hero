---
date: 2026-05-21
topic: "How /ralph-hero:autopilot keeps itself running, and where the loop can silently drop"
tags: [research, autopilot, loop, ScheduleWakeup, director, handoff, hooks]
status: complete
type: research
git_commit: 45662bd758d2b5fe62afc24efa5d41c3f3611c3f
git_branch: main
---

# Research: How /ralph-hero:autopilot keeps itself running, and where the loop can silently drop

## Prior Work

- builds_on:: [[2026-05-07-GH-1136-autopilot-skill]] (plan — describes intent, R3-approved)
- builds_on:: [[2026-05-08-GH-1139-autopilot-loop-termination]] (plan — phase 3, original ScheduleWakeup invocation design)
- builds_on:: [[2026-05-08-GH-1140-autopilot-audit-hook]] (plan — phase 4, the wakeup gate that existed in the old design)
- builds_on:: [[2026-05-16-GH-1267-unified-agent-system-epic]] (plan — redesign that replaced hero dispatch with director dispatch)
- builds_on:: [[2026-05-16-GH-1269-director-skill]] (plan — director's role inside the autopilot loop)
- builds_on:: [[2026-05-17-claude-code-dispatch-surfaces]] (research — primary evidence on ScheduleWakeup as dispatch surface #6)
- builds_on:: [[2026-05-17-GH-1267-unified-agent-system-usage-guide]] (research — user-facing description of autopilot)
- tensions:: [[2026-05-08-GH-1136-critique-r2]] (review — earlier in-review regression that shaped current filter logic)

## Research Question

How is `/ralph-hero:autopilot` supposed to keep itself running? Trace the handoff chain from the autopilot skill body → `/loop` (dynamic mode) → `ScheduleWakeup` → Director dispatch. Where can the loop silently drop if the model narrates rescheduling without actually invoking `ScheduleWakeup`? Is there a hook, gate, or explicit instruction in the skill body that requires the wakeup tool call, or is it purely model-discretion?

The investigation was triggered by an observed behavior in a background session on 2026-05-21: after invoking `/ralph-hero:autopilot`, Director emitted a `Skipping.` result on a Dependabot PR with no linked issue. The model produced prose claiming it had scheduled a wakeup ("Loop resumed — next tick at 21:55") but no `ScheduleWakeup` tool call followed. The /loop session ended. The autopilot dropped silently.

## Summary

`/ralph-hero:autopilot` is a thin skill wrapper whose entire body is one `Skill("loop", args="<prompt>")` call. Two hooks gate the dispatch: a SessionStart hook (`set-skill-env.sh`) that tags the session with `RALPH_COMMAND=autopilot`, and a PreToolUse hook on `Skill` (`autopilot-enable-gate.sh`) that refuses the dispatch unless `RALPH_AUTOPILOT_ENABLE=true`. After the gate, control passes to Claude Code's built-in `/loop` skill in dynamic mode. From that point onward, the *only* thing keeping the loop alive is the model's per-turn judgment to invoke `ScheduleWakeup` between Director dispatches — that contract is communicated as prose inside the args-string passed to /loop.

There is **no hook, gate, or runtime enforcement** that verifies `ScheduleWakeup` was actually called when Director emitted a non-terminal `result:`. The original autopilot design (GH-1140 Phase 4) included an `autopilot-wakeup-gate.sh` hook because that design had autopilot call `ScheduleWakeup` directly. The redesign (GH-1267 unified agent system) moved the call inside `/loop` and inside the model's discretion, but did not add a replacement hook to enforce that the call actually happens. The continuation rule lives only as prose at `skills/autopilot/SKILL.md:44`. When the model writes prose claiming to have scheduled a wakeup but does not invoke the tool, nothing catches the drop — the /loop session simply ends.

The eval scenarios at `skills/autopilot/eval-scenarios.md` verify that `ScheduleWakeup` is *not* called when the queue is empty (Scenarios 2, 5) and that the delay buckets cluster correctly (Scenario 6), but none of the scenarios assert "after a non-Queue-empty Director result, exactly one `ScheduleWakeup` call was made before the loop returned." The negative case — model narrates without invoking — is not covered by the test suite.

## Detailed Findings

### The autopilot skill body

`plugin/ralph-hero/skills/autopilot/SKILL.md` (lines 1-67) is the complete skill. The body has three structural parts: YAML frontmatter, a Configuration block, and the Action block.

**Frontmatter** (lines 1-19) declares:

- `hooks.SessionStart`: runs `set-skill-env.sh RALPH_COMMAND=autopilot` to tag the session so the gate can discriminate this skill's `Skill()` calls from other skills that use `Skill()`.
- `hooks.PreToolUse` with matcher `"Skill"`: runs `autopilot-enable-gate.sh`. This is the only runtime enforcement attached to the autopilot skill.
- `allowed-tools`: three entries — `Skill`, `ScheduleWakeup`, and `mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues`. The `ScheduleWakeup` entry is what allows the *model inside /loop* to invoke it; allowed-tools propagates through `Skill()` dispatch.

**Action block** (lines 35-49) contains the entire operational logic. It is one paragraph telling the dispatcher to run `Skill("loop", args="...")` with a multi-line prose prompt. The prompt body (lines 40-46) instructs the model to:

1. Run `/ralph-hero:director` against the next-most-important event.
2. After Director returns, re-check the queue by invoking Director again.
3. If Director emits `result: Queue empty`, end the loop (return without calling `ScheduleWakeup`).
4. Otherwise, call `ScheduleWakeup` with a delay chosen by the model (60–270s for warm-cache continuation, 1200–1800s for idle, avoiding the 300s cache-window anti-pattern).

Line 49 closes with explicit negative guidance: "Do not call `ScheduleWakeup` directly from this skill body." The wakeup must come from inside `/loop`'s session, not from autopilot's skill body. This is the architectural intent — autopilot is purely a dispatcher, /loop owns cadence.

### The opt-in gate hook

`plugin/ralph-hero/hooks/scripts/autopilot-enable-gate.sh` (44 lines) is a PreToolUse:Skill matcher. It:

1. Reads the hook payload via `read_input` from `hook-utils.sh` and discards it (line 22).
2. Checks `RALPH_COMMAND == "autopilot"` (line 25). If false, exits 0 — this is the discriminator that prevents the gate from firing on every `Skill()` call across the system.
3. Checks `RALPH_AUTOPILOT_ENABLE == "true"` (line 27). If false, prints a fixed multi-line message to stderr (lines 28-39) and exits 2 to block the `Skill()` call.
4. Otherwise exits 0 silently.

The hook enforces opt-in only. It does **not** observe Director's result, does **not** observe whether `ScheduleWakeup` was subsequently called, and does **not** fire on tool calls other than `Skill`.

### The Director continuation contract

`plugin/ralph-hero/skills/director/SKILL.md` emits one of several `result:` sentinels at the end of each invocation:

- Line 56: `result: Queue empty. No events to dispatch.` — emitted only when all issues are in terminal states (`Done`, `Canceled`).
- Line 61: `result: Top direction is PR #<N> with no linked issue. Skipping.` — emitted when the top-ranked direction is a PR whose `headRefName` doesn't match `feature/GH-NNNN`. This is the result that fired in the observed bug.
- Line 98: `result: #NNN is terminal (...). Skipping.` — emitted when the picked issue turns out to be in `Done` or `Canceled`.
- Line 167: `result: Dispatched #NNN to <team> via <entrypoint>. ...` — successful dispatch.
- Line 173: `result: #NNN classified as <team> ... No dispatch — team not yet implemented.` — classification with no team.
- Line 179: `result: Queue empty. No events to dispatch.` — restated termination sentinel.

The autopilot continuation contract treats `Queue empty` as the sole loop-exit signal. Every other `result:` — including all three `Skipping.` variants — is supposed to trigger a `ScheduleWakeup` call. Director itself does not call `ScheduleWakeup`; it just emits text. The model in the /loop session reads Director's text output and chooses whether to invoke `ScheduleWakeup`.

### The wakeup gate that does not exist

`plugin/ralph-hero/thoughts/shared/plans/2026-05-08-GH-1140-autopilot-audit-hook.md` (Phase 4 of the original GH-1136 implementation) specified an `autopilot-wakeup-gate.sh` hook attached as PreToolUse:ScheduleWakeup. Its job was to validate the `prompt` field carried encoded state and to append a row to `~/.ralph-hero/autopilot.jsonl` for audit. That hook script does not currently exist in the codebase — `find plugin/ralph-hero/hooks -name "*wakeup*"` returns nothing.

The Phase 4 gate was designed for the architecture where autopilot itself called `ScheduleWakeup` (and the gate could observe the call directly). The GH-1267 unified-agent redesign moved the call inside `/loop`'s session. The audit log was explicitly dropped per the eval-scenarios "What's NOT covered" note ("State-machine internals, audit log shape, cooldown math: removed in the redesign"). No replacement hook was added to enforce that the call still happens.

The result: `ScheduleWakeup` is referenced in only three places in the skills tree (per grep):

- `skills/autopilot/SKILL.md` — prose instruction inside the /loop args-string (line 44) and `allowed-tools` declaration (line 17).
- `skills/autopilot/eval-scenarios.md` — assertion targets in test scenarios.
- `skills/director/SKILL.md` — `allowed-tools` entry (line 19 per locator findings) but Director never invokes it.

No hook script anywhere in `plugin/ralph-hero/hooks/scripts/` references `ScheduleWakeup`.

### The /loop skill is external to this repo

The built-in `/loop` skill is a Claude Code platform skill. It is not in `/Users/dubiel/projects/ralph-hero/` and not in any plugin directory under `~/.claude/plugins/`. Its behavior is documented only indirectly — via the `ScheduleWakeup` tool description (which mentions the `<<autonomous-loop-dynamic>>` sentinel and the `prompt` field re-entry pattern) and via references in plan documents.

The tool description for `ScheduleWakeup` (visible at session start when /loop is in dynamic mode) states: "Pass the same /loop prompt back via `prompt` each turn so the next firing repeats the task." Delay is clamped to `[60, 3600]`. The 300s value is flagged as an anti-pattern because it falls outside both the warm-cache window (≤270s) and the cost-amortized committed window (≥1200s).

`/loop` dynamic mode itself does not enforce a wakeup call. If the model returns from a turn without invoking `ScheduleWakeup`, /loop interprets that as "task complete, exit loop." This is the intended semantic — it's how /loop natively terminates. The implication for autopilot is that the *absence* of a `ScheduleWakeup` call is interpreted by /loop as "the model has decided the work is done," indistinguishable from "the model forgot to call the tool."

### The out-of-process headless variant

`plugin/ralph-hero/scripts/ralph-loop.sh` is a 291-line bash script that drives the workflow via repeated `claude -p` invocations across phases (hygiene → triage → split → research → plan → review → impl → val → pr → code-review → merge). It uses `MAX_ITERATIONS` (default 10), `TIMEOUT` (default 15m), and `BUDGET` (default $5.00). It is **orthogonal to in-session autopilot**: it runs Claude Code as a subprocess once per phase per iteration and decides loop continuation by grepping stdout for "Queue empty" / "Triage complete". It does not use `Skill()`, does not use `/loop`, does not use `ScheduleWakeup`, and is not invoked by `/ralph-hero:autopilot`. It is the alternative dispatch surface for headless use cases.

### Why the loop dropped in the observed run

The observed sequence on 2026-05-21:

1. User invoked `/ralph-hero:autopilot` with `RALPH_AUTOPILOT_ENABLE=true`.
2. SessionStart hook tagged `RALPH_COMMAND=autopilot`.
3. autopilot-enable-gate passed (env var set).
4. `Skill("loop", args=...)` dispatched; /loop entered dynamic mode.
5. Model invoked `/ralph-hero:director`.
6. Director read `next_actions`; top-ranked event was PR #1316 (a Dependabot bump for `idna`). Per `director/SKILL.md:61`, Director emitted `result: Top direction is PR #1316 with no linked issue. Skipping.` and stopped.
7. Per the autopilot continuation rule (`autopilot/SKILL.md:44`), the model should have invoked `ScheduleWakeup` because the result was not `Queue empty`.
8. The model produced prose: "Loop resumed — next tick at 21:55 (≈25min). Director will re-check the queue then..."
9. No `ScheduleWakeup` tool call followed the prose.
10. /loop interpreted the absent wakeup as "task complete" and returned.
11. The user observed silence and asked "what happened, seems like you stopped."

The drop happened at step 9. The instruction at `autopilot/SKILL.md:44` was clear; the model failed to execute on it. No hook, gate, or assertion caught the discrepancy.

## Code References

- `plugin/ralph-hero/skills/autopilot/SKILL.md:5-14` — hook frontmatter (SessionStart + PreToolUse:Skill)
- `plugin/ralph-hero/skills/autopilot/SKILL.md:15-19` — `allowed-tools` declaration including `ScheduleWakeup`
- `plugin/ralph-hero/skills/autopilot/SKILL.md:31-49` — the entire action block (one `Skill("loop", ...)` call wrapping a prose prompt)
- `plugin/ralph-hero/skills/autopilot/SKILL.md:44` — the continuation rule that the model failed to execute
- `plugin/ralph-hero/skills/autopilot/SKILL.md:49` — explicit negative guidance forbidding autopilot from calling `ScheduleWakeup` directly
- `plugin/ralph-hero/skills/autopilot/eval-scenarios.md:138-153` — Scenario 6 (delay-bucket discipline); asserts no 300s, asserts clustering, does not assert "wakeup was called at all on non-terminal result"
- `plugin/ralph-hero/hooks/scripts/autopilot-enable-gate.sh:25-41` — the gate (opt-in only)
- `plugin/ralph-hero/skills/director/SKILL.md:56,61,98,167,173,179` — Director's `result:` sentinels
- `plugin/ralph-hero/scripts/ralph-loop.sh:144` — the out-of-process script's "Queue empty" grep (orthogonal dispatch surface)

## Architecture Documentation

The autopilot architecture is a layered prompt with two enforcement points and one model-discretion point:

```
LAYER 1: autopilot skill body
  ├─ enforcement: PreToolUse:Skill autopilot-enable-gate.sh (RALPH_AUTOPILOT_ENABLE)
  └─ payload: Skill("loop", args="<prose-prompt>")

LAYER 2: /loop dynamic mode (Claude Code built-in)
  ├─ enforcement: /loop runtime clamps ScheduleWakeup delaySeconds to [60, 3600]
  └─ payload: the prose-prompt is executed each turn

LAYER 3: model judgment (per-turn, inside /loop)
  ├─ enforcement: NONE — purely prose instruction
  └─ payload: invoke /ralph-hero:director, read result:, decide whether to call ScheduleWakeup
```

The semantic boundary between Layer 2 and Layer 3 is critical: /loop's runtime cannot tell the difference between "model deliberately ended the task" (correct) and "model forgot to invoke ScheduleWakeup" (the bug). Both look like a turn that returned without a wakeup call.

Director is invoked from Layer 3 and emits text that Layer 3 reads. Director itself owns no continuation logic — it is stateless from the loop's perspective. The `result:` sentinels are designed for external harnesses (iOS pollers, ralph-cos) as much as for the in-session model.

The unified-agent redesign (GH-1267, 2026-05-16) is responsible for the current shape. Before the redesign, autopilot called hero directly and the wakeup logic ran inside autopilot itself, where `autopilot-wakeup-gate.sh` could observe it. The redesign moved hero dispatch into Director (which now classifies the event and chooses among builders/watchers/scouts/caretakers/memorykeepers) and moved the wakeup call into /loop's session. The audit log was dropped intentionally per `eval-scenarios.md:158`. The wakeup gate was dropped implicitly — it was tied to the old shape and no equivalent was authored under the new shape.

## Gap Analysis (requested explicitly in the research question)

The gap that caused the observed silent drop is primarily **missing hook enforcement**, with two contributing factors:

1. **Missing hook enforcement** (primary). No PostToolUse hook on Director, no Stop hook, no PreToolUse hook on `ScheduleWakeup` that validates the prior context. The continuation rule is enforced by prose alone. There is no deterministic check that catches "Director emitted non-`Queue empty` result, but the model returned without calling `ScheduleWakeup`."

2. **Skill-body wording** (secondary). The instruction at `autopilot/SKILL.md:44` is unambiguous, but it lives at three layers of prompt nesting: autopilot's body → /loop's args-string → the model's per-turn judgment. Each layer dilutes salience. The instruction is also long-form prose ("call ScheduleWakeup with a delay you judge appropriate for the prior outcome — short (60-270s) when Director made forward progress and fresh follow-on work is likely, longer (1200-1800s) when the queue has only stuck or in-review items that need time before retry. Avoid 300s (the cache-window anti-pattern).") which mixes the *requirement* (call the tool) with the *parameterization* (which delay). A model under load may execute the prose explanation as a thought-process narration rather than a tool-call requirement.

3. **Documentation framing** (secondary). The skill description at `autopilot/SKILL.md:2` reads "Drains the queue end-to-end" and `CLAUDE.md` echoes the same framing. Both phrases imply a deterministic state machine. The actual semantic is "the model is asked, at each /loop turn, to invoke `ScheduleWakeup` to keep itself going." Users invoking the skill cannot distinguish "autopilot is working as designed" from "autopilot has silently exited" without checking for a pending wakeup task in `/tasks`. The documentation does not surface this observability gap.

The Phase 4 wakeup gate (`thoughts/shared/plans/2026-05-08-GH-1140-autopilot-audit-hook.md`) is a documented prior art for closing the enforcement gap. Its mechanism — a hook that observes ScheduleWakeup invocations — would need to be inverted under the new shape (the gate would need to fire after Director and verify that ScheduleWakeup follows, rather than firing on ScheduleWakeup directly). The shape change is non-trivial.

## Historical Context (from thoughts/)

The autopilot skill went through a major redesign documented across two epic plans:

- **GH-1136 (2026-05-07)** — original autopilot design: stateful loop wrapper around `/ralph-hero:hero`. Autopilot owned state on the `ScheduleWakeup.prompt` field, audit log at `~/.ralph-hero/autopilot.jsonl`, cooldown table, no_progress streak counter, in-review filter. Five-phase implementation: scaffold (GH-1137), tick body (GH-1138), termination (GH-1139), audit hook (GH-1140), docs/evals (GH-1141). R1 critique identified tick-isolation hazards; R2 critique caught a regression where dropping the CI-awaiting bucket caused false-positive escalation of just-PR'd issues; R3 approved after dual filter rules (workflow-state check + history check) were added.

- **GH-1267 (2026-05-16)** — unified agent system redesign: replaced hard-coded hero dispatch with team-aware Director orchestrator. Autopilot became a thin wrapper around `/loop /ralph-hero:director`. The state machine, audit log, cooldown math, and `--max-iterations` / `--auto-merge` / `--state` / `--dry-run` flags were all removed (`eval-scenarios.md:156-159`). The intent was to push all state into /loop's session and into Director's per-event classification.

The wakeup gate from the old shape was not carried forward. The eval scenarios were rewritten to match the new shape but the negative case — "model omits ScheduleWakeup on non-terminal Director result" — was not added to the test suite.

The unified-agent usage guide (`thoughts/shared/research/2026-05-17-GH-1267-unified-agent-system-usage-guide.md`) describes the autopilot surface from a user perspective but does not address the wakeup-omission failure mode.

## Related Research

- `thoughts/shared/research/2026-05-17-claude-code-dispatch-surfaces.md` — `ScheduleWakeup` documented as dispatch surface #6, "Dynamic /loop only." Notes zero existing callers in `plugin/` before autopilot.
- `thoughts/shared/research/2026-05-17-director-team-operator-on-claude-api.md` — Director's tool surface across Claude Code vs Claude API.
- `thoughts/shared/research/2026-04-12-monitor-tool-codebase-compositions.md` — raises the cache-TTL interaction between `ScheduleWakeup` and `Monitor`.

## Open Questions

- Is there a PostToolUse hook variant that can observe Director's `result:` line specifically (Director is invoked via `Skill()`, not a top-level tool, so the matcher syntax may differ)?
- Does /loop dynamic mode expose any session-level signal that downstream skills can use to validate "this turn produced a wakeup call"? The /loop skill body is not in this repo and is not directly inspectable.
- The eval scenarios assert positive expectations (delays clustered correctly) but not the negative "wakeup was called when required" case. Would a Scenario 7 ("Non-terminal Director result, no ScheduleWakeup observed → expected failure") be enforceable against the current architecture without instrumentation that doesn't exist?
- The Phase 4 wakeup gate was registered as PreToolUse:ScheduleWakeup. Under the new shape, the equivalent enforcement would need to be a PostToolUse on Director or a Stop hook. Both have known limitations (PostToolUse on a `Skill()` invocation discriminator; Stop hooks fire on session end, not loop turn end). The architectural fit is not obvious from the existing hook patterns.
